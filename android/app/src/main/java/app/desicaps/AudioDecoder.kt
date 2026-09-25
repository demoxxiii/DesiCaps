package app.desicaps

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.nio.ByteOrder

/** Decodes a video's sound track to 16 kHz mono float PCM (what Whisper wants). */
object AudioDecoder {
    private const val OUT_RATE = 16000

    private class FloatBuf {
        var data = FloatArray(OUT_RATE * 60)
        var size = 0
        fun add(v: Float) {
            if (size == data.size) data = data.copyOf(data.size * 2)
            data[size++] = v
        }
        fun toArray(): FloatArray = data.copyOf(size)
    }

    /** Streaming linear resampler, fed mono samples at the source rate. */
    private class Resampler(private val out: FloatBuf) {
        var step = 1.0
        private var pos = 0.0       // source position of the next output sample
        private var g = -1L         // index of the last source sample seen
        private var prev = 0f
        fun setRate(srcRate: Int) { step = srcRate.toDouble() / OUT_RATE }
        fun push(x: Float) {
            g++
            while (pos <= g) {
                val frac = (pos - (g - 1)).toFloat().coerceIn(0f, 1f)
                out.add(prev + (x - prev) * frac)
                pos += step
            }
            prev = x
        }
    }

    fun decode(path: String, cancelled: () -> Boolean, onProgress: (Float) -> Unit): FloatArray {
        val ex = MediaExtractor()
        ex.setDataSource(path)
        var track = -1
        for (i in 0 until ex.trackCount) {
            val mime = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: ""
            if (mime.startsWith("audio/")) { track = i; break }
        }
        if (track < 0) { ex.release(); throw IllegalStateException("This video has no sound track.") }
        ex.selectTrack(track)
        val fmt = ex.getTrackFormat(track)
        val durUs = if (fmt.containsKey(MediaFormat.KEY_DURATION)) fmt.getLong(MediaFormat.KEY_DURATION) else 0L
        val codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME)!!)
        codec.configure(fmt, null, null, 0)
        codec.start()

        var channels = if (fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else 1
        var encoding = AudioFormat.ENCODING_PCM_16BIT
        val out = FloatBuf()
        val rs = Resampler(out)
        rs.setRate(if (fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 44100)

        val info = MediaCodec.BufferInfo()
        var inDone = false
        var outDone = false
        var lastReport = 0L
        try {
            while (!outDone) {
                if (cancelled()) throw InterruptedException("cancelled")
                if (!inDone) {
                    val ii = codec.dequeueInputBuffer(10_000)
                    if (ii >= 0) {
                        val buf = codec.getInputBuffer(ii)!!
                        val n = ex.readSampleData(buf, 0)
                        if (n < 0) {
                            codec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inDone = true
                        } else {
                            val t = ex.sampleTime
                            codec.queueInputBuffer(ii, 0, n, t, 0)
                            ex.advance()
                            if (durUs > 0 && t - lastReport > 500_000) {
                                lastReport = t
                                onProgress((t.toFloat() / durUs).coerceIn(0f, 1f))
                            }
                        }
                    }
                }
                val oi = codec.dequeueOutputBuffer(info, 10_000)
                if (oi >= 0) {
                    if (info.size > 0) {
                        val ob = codec.getOutputBuffer(oi)!!
                        ob.position(info.offset)
                        ob.limit(info.offset + info.size)
                        ob.order(ByteOrder.nativeOrder())
                        val ch = channels.coerceAtLeast(1)
                        if (encoding == AudioFormat.ENCODING_PCM_FLOAT) {
                            val fb = ob.asFloatBuffer()
                            val frames = fb.remaining() / ch
                            for (f in 0 until frames) {
                                var s = 0f
                                for (c in 0 until ch) s += fb.get()
                                rs.push(s / ch)
                            }
                        } else {
                            val sb = ob.asShortBuffer()
                            val frames = sb.remaining() / ch
                            for (f in 0 until frames) {
                                var s = 0f
                                for (c in 0 until ch) s += sb.get() / 32768f
                                rs.push(s / ch)
                            }
                        }
                    }
                    codec.releaseOutputBuffer(oi, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outDone = true
                } else if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    val of = codec.outputFormat
                    if (of.containsKey(MediaFormat.KEY_SAMPLE_RATE)) rs.setRate(of.getInteger(MediaFormat.KEY_SAMPLE_RATE))
                    if (of.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                    if (of.containsKey(MediaFormat.KEY_PCM_ENCODING)) encoding = of.getInteger(MediaFormat.KEY_PCM_ENCODING)
                }
            }
        } finally {
            try { codec.stop() } catch (_: Exception) {}
            codec.release()
            ex.release()
        }
        onProgress(1f)
        return out.toArray()
    }
}
