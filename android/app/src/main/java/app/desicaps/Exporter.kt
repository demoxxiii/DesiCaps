package app.desicaps

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import com.google.common.collect.ImmutableList
import java.io.File

/**
 * Burns captions into the video on the phone's hardware encoder.
 * The web UI renders every distinct caption "state" once as a PNG (with the same engine as the preview);
 * this overlay picks the right one for each video frame.
 */
class Exporter(private val ctx: Context) {

    class Frame(val file: File, val x: Float, val y: Float)

    private class CaptionOverlay(
        w: Int, h: Int,
        private val times: LongArray,   // start time (us) of each plan entry, ascending
        private val ids: IntArray,      // frame id for that entry, -1 = no caption
        private val frames: Map<Int, Frame>
    ) : BitmapOverlay() {
        private val slots = arrayOf(
            Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888),
            Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        )
        private val empty = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        private var slot = 0
        private var curId = Int.MIN_VALUE
        private var cur: Bitmap = empty

        override fun getBitmap(presentationTimeUs: Long): Bitmap {
            var lo = 0
            var hi = times.size - 1
            var idx = -1
            while (lo <= hi) {
                val mid = (lo + hi) ushr 1
                if (times[mid] <= presentationTimeUs) { idx = mid; lo = mid + 1 } else hi = mid - 1
            }
            val id = if (idx < 0) -1 else ids[idx]
            if (id == curId) return cur
            curId = id
            val f = frames[id]
            if (id < 0 || f == null) { cur = empty; return cur }
            val src = BitmapFactory.decodeFile(f.file.absolutePath)
            slot = 1 - slot
            val b = slots[slot]
            b.eraseColor(0)
            if (src != null) {
                Canvas(b).drawBitmap(src, f.x, f.y, null)
                src.recycle()
            }
            cur = b
            return cur
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var transformer: Transformer? = null

    fun cancel() {
        main.post { try { transformer?.cancel() } catch (_: Exception) {} ; transformer = null }
    }

    /**
     * Runs on the main thread. Calls back onProgress(0..1), then onDone(uriString) or onError(message).
     */
    fun start(
        input: File, outW: Int, outH: Int, fps: Float,
        times: LongArray, ids: IntArray, frames: Map<Int, Frame>, name: String,
        onProgress: (Float) -> Unit, onDone: (String) -> Unit, onError: (String) -> Unit
    ) {
        main.post {
            try {
                val out = File(ctx.cacheDir, "export.mp4")
                out.delete()
                val overlay = CaptionOverlay(outW, outH, times, ids, frames)
                val videoEffects = listOf<Effect>(
                    Presentation.createForWidthAndHeight(outW, outH, Presentation.LAYOUT_SCALE_TO_FIT),
                    OverlayEffect(ImmutableList.of<TextureOverlay>(overlay))
                )
                val item = EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(input)))
                    .setEffects(Effects(listOf<AudioProcessor>(), videoEffects))
                    .build()
                val composition = Composition.Builder(EditedMediaItemSequence(listOf(item)))
                    .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
                    .build()
                val bitrate = (outW.toLong() * outH * fps.coerceIn(24f, 60f) * 0.2f).toLong()
                    .coerceIn(4_000_000L, 20_000_000L).toInt()
                val encoders = DefaultEncoderFactory.Builder(ctx)
                    .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(bitrate).build())
                    .build()
                val tr = Transformer.Builder(ctx)
                    .setVideoMimeType(MimeTypes.VIDEO_H264)
                    .setAudioMimeType(MimeTypes.AUDIO_AAC)
                    .setEncoderFactory(encoders)
                    .addListener(object : Transformer.Listener {
                        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                            transformer = null
                            Thread {
                                try { onDone(saveToGallery(out, name)) }
                                catch (e: Exception) { onError("Saved video could not be copied to your gallery: ${e.message}") }
                            }.start()
                        }

                        override fun onError(
                            composition: Composition, exportResult: ExportResult, exportException: ExportException
                        ) {
                            transformer = null
                            onError(exportException.message ?: "Export failed (${exportException.errorCodeName})")
                        }
                    })
                    .build()
                transformer = tr
                tr.start(composition, out.absolutePath)
                val holder = ProgressHolder()
                val poll = object : Runnable {
                    override fun run() {
                        val t = transformer ?: return
                        if (t.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) onProgress(holder.progress / 100f)
                        main.postDelayed(this, 400)
                    }
                }
                main.postDelayed(poll, 400)
            } catch (e: Exception) {
                transformer = null
                onError(e.message ?: e.toString())
            }
        }
    }

    private fun saveToGallery(file: File, name: String): String {
        val resolver = ctx.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/DesiCaps")
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values)
            ?: throw IllegalStateException("gallery refused the file")
        resolver.openOutputStream(uri)!!.use { os -> file.inputStream().use { it.copyTo(os, 1 shl 20) } }
        values.clear()
        values.put(MediaStore.Video.Media.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        file.delete()
        return uri.toString()
    }
}
