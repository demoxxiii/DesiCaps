package app.desicaps

import android.annotation.SuppressLint
import android.content.Intent
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.core.view.WindowInsetsCompat
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.io.RandomAccessFile
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : ComponentActivity() {

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
    }

    private lateinit var web: WebView
    private val worker = Executors.newSingleThreadExecutor()
    private val downloader = Executors.newSingleThreadExecutor()
    private val cancelFlag = AtomicBoolean(false)
    private val cancelDownload = AtomicBoolean(false)
    private val exporter by lazy { Exporter(this) }
    private var frames = HashMap<Int, Exporter.Frame>()
    private var framesDir: File? = null
    private var pendingShare: Uri? = null
    private var pageReady = false
    private val server by lazy { LocalServer(File(cacheDir, "media").apply { mkdirs() }) }

    private val picker = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) emit(JSONObject().put("type", "pickCancelled")) else importVideo(uri)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        // Android 15+ draws apps edge-to-edge: keep the page clear of the status bar, notch,
        // navigation bar and keyboard by padding the container with the system insets.
        val root = android.widget.FrameLayout(this)
        root.setBackgroundColor(0xFF0E0E12.toInt())
        root.addView(web, android.widget.FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            textZoom = 100
            // the preview video streams from a local 127.0.0.1 server (see LocalServer)
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        WebView.setWebContentsDebuggingEnabled(true)
        web.setBackgroundColor(0xFF0E0E12.toInt())
        web.addJavascriptInterface(Bridge(), "Android")
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.i("DesiCapsJS", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                if (req.url.host != HOST) return null
                return serve(req.url.path ?: "/", req.requestHeaders)
            }

            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                if (req.url.host == HOST) return false
                openUrl(req.url.toString())
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pendingShare?.let { pendingShare = null; importVideo(it) }
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("window.onAndroidBack ? window.onAndroidBack() : false") { r ->
                    if (r != "true") finish()
                }
            }
        })
        handleIntent(intent)
        web.loadUrl("$ORIGIN/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val uri: Uri? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        if (uri == null) return
        if (pageReady) importVideo(uri) else pendingShare = uri
    }

    override fun onDestroy() {
        server.close()
        web.destroy()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ web assets + local video
    private fun mimeOf(path: String) = when (path.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html"; "js" -> "text/javascript"; "css" -> "text/css"; "json" -> "application/json"
        "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "webp" -> "image/webp"; "svg" -> "image/svg+xml"
        "ttf" -> "font/ttf"; "woff2" -> "font/woff2"; "mp4", "m4v" -> "video/mp4"; "mov" -> "video/quicktime"
        "webm" -> "video/webm"; "mkv" -> "video/x-matroska"; "3gp" -> "video/3gpp"
        else -> "application/octet-stream"
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", mapOf(), ByteArrayInputStream(ByteArray(0)))

    private fun serve(path: String, headers: Map<String, String>): WebResourceResponse {
        if (path.startsWith("/media/")) {
            val f = File(File(cacheDir, "media"), path.removePrefix("/media/").substringAfterLast('/'))
            return if (f.exists()) serveFile(f, headers) else notFound()
        }
        val asset = "www" + (if (path == "/" || path.isEmpty()) "/index.html" else path)
        return try {
            val s = assets.open(asset)
            val mime = mimeOf(asset)
            WebResourceResponse(mime, if (mime.startsWith("text") || mime.endsWith("json")) "utf-8" else null,
                200, "OK", mapOf("Cache-Control" to "no-cache", "Access-Control-Allow-Origin" to "*"), s)
        } catch (e: Exception) { notFound() }
    }

    /** Serves a file with HTTP Range support so <video> can seek. */
    private fun serveFile(f: File, headers: Map<String, String>): WebResourceResponse {
        val len = f.length()
        val range = headers.entries.firstOrNull { it.key.equals("Range", true) }?.value
        val mime = mimeOf(f.name)
        if (range != null && range.startsWith("bytes=")) {
            val (a, b) = range.removePrefix("bytes=").split(",")[0].split("-").let { it[0] to it.getOrElse(1) { "" } }
            var start = a.toLongOrNull() ?: 0L
            var end = b.toLongOrNull() ?: (len - 1)
            if (a.isEmpty() && b.isNotEmpty()) { start = len - (b.toLongOrNull() ?: 0L); end = len - 1 }
            end = end.coerceAtMost(len - 1)
            if (start > end || start >= len) {
                return WebResourceResponse(mime, null, 416, "Range Not Satisfiable",
                    mapOf("Content-Range" to "bytes */$len"), ByteArrayInputStream(ByteArray(0)))
            }
            val count = end - start + 1
            val raf = RandomAccessFile(f, "r")
            raf.seek(start)
            val stream = object : InputStream() {
                var left = count
                override fun read(): Int {
                    if (left <= 0) return -1
                    val r = raf.read(); if (r >= 0) left--; return r
                }
                override fun read(b: ByteArray, off: Int, n: Int): Int {
                    if (left <= 0) return -1
                    val r = raf.read(b, off, minOf(n.toLong(), left).toInt()); if (r > 0) left -= r; return r
                }
                override fun close() = raf.close()
            }
            return WebResourceResponse(mime, null, 206, "Partial Content", mapOf(
                "Content-Range" to "bytes $start-$end/$len", "Accept-Ranges" to "bytes",
                "Content-Length" to count.toString(), "Cache-Control" to "no-cache"), stream)
        }
        return WebResourceResponse(mime, null, 200, "OK", mapOf(
            "Accept-Ranges" to "bytes", "Content-Length" to len.toString(), "Cache-Control" to "no-cache"),
            FileInputStream(f))
    }

    // ------------------------------------------------------------------ messages to the page
    private fun emit(o: JSONObject) {
        val js = "window.__native && window.__native(${JSONObject.quote(o.toString())})"
        runOnUiThread { web.evaluateJavascript(js, null) }
    }

    private fun emitError(type: String, e: Throwable) {
        Log.e("DesiCaps", type, e)
        emit(JSONObject().put("type", type).put("message", e.message ?: e.toString()))
    }

    private fun keepAwake(on: Boolean) = runOnUiThread {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun openUrl(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) {}
    }

    // ------------------------------------------------------------------ video import
    private fun displayName(uri: Uri): String {
        return try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            } ?: "video.mp4"
        } catch (e: Exception) { "video.mp4" }
    }

    private fun importVideo(uri: Uri) {
        emit(JSONObject().put("type", "importing"))
        worker.execute {
            try {
                val name = displayName(uri)
                var ext = name.substringAfterLast('.', "mp4").lowercase()
                if (ext.length > 4 || ext.isEmpty()) ext = "mp4"
                val dir = File(cacheDir, "media").apply { mkdirs() }
                dir.listFiles()?.forEach { it.delete() }
                val stamp = System.currentTimeMillis()
                val f = File(dir, "video_$stamp.$ext")
                contentResolver.openInputStream(uri)!!.use { i -> f.outputStream().use { o -> i.copyTo(o, 1 shl 20) } }
                val info = probe(f)
                info.put("type", "picked").put("name", name.substringBeforeLast('.'))
                    .put("file", f.name).put("url", server.url(f.name))
                emit(info)
            } catch (e: Exception) { emitError("pickError", e) }
        }
    }

    private fun probe(f: File): JSONObject {
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(f.absolutePath)
            val w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            val h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            val rot = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            val dur = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            var fps = 30f
            var codec = ""
            var hdr = false
            try {
                val ex = MediaExtractor(); ex.setDataSource(f.absolutePath)
                for (i in 0 until ex.trackCount) {
                    val tf = ex.getTrackFormat(i)
                    val mime = tf.getString(MediaFormat.KEY_MIME) ?: ""
                    if (!mime.startsWith("video/")) continue
                    codec = mime
                    if (tf.containsKey(MediaFormat.KEY_FRAME_RATE)) {
                        fps = try { tf.getInteger(MediaFormat.KEY_FRAME_RATE).toFloat() } catch (e: Exception) { tf.getFloat(MediaFormat.KEY_FRAME_RATE) }
                    }
                    if (tf.containsKey(MediaFormat.KEY_COLOR_TRANSFER)) {
                        val t = tf.getInteger(MediaFormat.KEY_COLOR_TRANSFER)
                        hdr = t == MediaFormat.COLOR_TRANSFER_ST2084 || t == MediaFormat.COLOR_TRANSFER_HLG
                    }
                }
                ex.release()
            } catch (_: Exception) {}
            val swap = rot == 90 || rot == 270
            return JSONObject().put("width", if (swap) h else w).put("height", if (swap) w else h)
                .put("duration", dur / 1000.0).put("fps", fps.toDouble()).put("codec", codec).put("hdr", hdr)
        } finally { r.release() }
    }

    // ------------------------------------------------------------------ JS bridge
    inner class Bridge {
        @JavascriptInterface fun version(): String =
            packageManager.getPackageInfo(packageName, 0).versionName ?: "0"

        @JavascriptInterface fun cpu(): String = WhisperLib.variant + " · " + WhisperLib.goodThreadCount() + " threads"

        @JavascriptInterface fun pickVideo() = runOnUiThread {
            picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.VideoOnly))
        }

        @JavascriptInterface fun makePreview(file: String, w: Int, h: Int) {
            val dir = File(cacheDir, "media")
            val src = File(dir, file)
            val out = File(dir, "preview_" + file.substringBeforeLast('.') + ".mp4")
            if (out.exists() && out.length() > 10_000) {
                emit(JSONObject().put("type", "preview").put("file", file).put("url", server.url(out.name))); return
            }
            val tmp = File(dir, "tmp_" + out.name)
            exporter.preview(src, w, h, tmp,
                onDone = { tmp.renameTo(out); emit(JSONObject().put("type", "preview").put("file", file).put("url", server.url(out.name))) },
                onError = { msg -> emit(JSONObject().put("type", "previewError").put("file", file).put("message", msg)) })
        }

        @JavascriptInterface fun mediaUrl(file: String): String = server.url(file)

        @JavascriptInterface fun hasVideo(file: String): Boolean = File(File(cacheDir, "media"), file).exists()

        @JavascriptInterface fun engines(): String = Models.status(this@MainActivity)

        @JavascriptInterface fun openUrl(url: String) = this@MainActivity.openUrl(url)

        @JavascriptInterface fun downloadModel(id: String) {
            val e = Models.byId(id)
            cancelDownload.set(false)
            downloader.execute {
                try {
                    keepAwake(true)
                    Models.download(this@MainActivity, e, { cancelDownload.get() }) { got, total ->
                        emit(JSONObject().put("type", "downloadProgress").put("id", id)
                            .put("got", got).put("total", total))
                    }
                    emit(JSONObject().put("type", "downloadDone").put("id", id))
                } catch (ex: Exception) {
                    emit(JSONObject().put("type", "downloadError").put("id", id).put("message", ex.message ?: ex.toString()))
                } finally { keepAwake(false) }
            }
        }

        @JavascriptInterface fun cancelDownload() = cancelDownload.set(true)

        @JavascriptInterface fun deleteModel(id: String) {
            val e = Models.byId(id)
            if (e.asset == null) Models.file(this@MainActivity, e).delete()
        }

        @JavascriptInterface fun cancel() {
            cancelFlag.set(true)
            try { WhisperLib.abort() } catch (_: Throwable) {}
            exporter.cancel()
        }

        @JavascriptInterface fun transcribe(file: String, engineId: String, prompt: String) {
            cancelFlag.set(false)
            worker.execute {
                var ctx = 0L
                try {
                    keepAwake(true)
                    val e = Models.byId(engineId)
                    val video = File(File(cacheDir, "media"), file)
                    fun prog(f: Float, msg: String) =
                        emit(JSONObject().put("type", "transcribeProgress").put("progress", f.toDouble()).put("message", msg))
                    prog(0.01f, "Preparing model")
                    val model = Models.ensure(this@MainActivity, e)
                    prog(0.03f, "Reading audio")
                    val pcm = AudioDecoder.decode(video.absolutePath, { cancelFlag.get() }) { prog(0.03f + 0.07f * it, "Reading audio") }
                    val seconds = pcm.size / 16000.0
                    if (seconds < 0.3) throw IllegalStateException("No speech found (the sound track is empty).")
                    prog(0.1f, "Loading model")
                    ctx = WhisperLib.init(model.absolutePath, e.dtw)
                    if (ctx == 0L) throw IllegalStateException("Could not load the speech model. Try deleting and re-downloading it.")
                    val t0 = System.currentTimeMillis()
                    val listener = object : WhisperLib.ProgressListener {
                        override fun onProgress(progress: Int) = prog(0.12f + 0.86f * progress.coerceIn(0, 100) / 100f, "Listening")
                    }
                    val bytes = WhisperLib.transcribe(ctx, pcm, e.lang, WhisperLib.goodThreadCount(),
                        prompt.ifBlank { null }, listener)
                    if (cancelFlag.get()) throw InterruptedException("cancelled")
                    if (bytes == null) throw IllegalStateException("Transcription failed.")
                    val json = String(bytes, Charsets.UTF_8)
                    Log.i("DesiCaps", "transcribed ${"%.1f".format(seconds)}s audio in ${System.currentTimeMillis() - t0} ms")
                    emit(JSONObject().put("type", "transcribed").put("result", JSONObject(json))
                        .put("seconds", seconds).put("ms", System.currentTimeMillis() - t0))
                } catch (ex: InterruptedException) {
                    emit(JSONObject().put("type", "cancelled"))
                } catch (ex: Throwable) {
                    emitError("transcribeError", ex)
                } finally {
                    if (ctx != 0L) WhisperLib.free(ctx)
                    keepAwake(false)
                }
            }
        }

        // ---- export: beginExport -> putFrame* -> finishExport
        @JavascriptInterface fun beginExport() {
            cancelFlag.set(false)
            val d = File(cacheDir, "frames")
            d.deleteRecursively(); d.mkdirs()
            framesDir = d
            frames = HashMap()
        }

        @JavascriptInterface fun putFrame(id: Int, x: Double, y: Double, dataUrl: String): Boolean {
            return try {
                val b64 = dataUrl.substringAfter("base64,")
                val f = File(framesDir, "$id.png")
                f.writeBytes(Base64.decode(b64, Base64.DEFAULT))
                frames[id] = Exporter.Frame(f, x.toFloat(), y.toFloat())
                true
            } catch (e: Exception) { Log.e("DesiCaps", "frame", e); false }
        }

        @JavascriptInterface fun finishExport(file: String, planJson: String) {
            try {
                if (cancelFlag.get()) { emit(JSONObject().put("type", "cancelled")); return }
                val plan = JSONObject(planJson)
                val t = plan.getJSONArray("times")
                val ids = plan.getJSONArray("ids")
                val times = LongArray(t.length()) { t.getLong(it) }
                val idArr = IntArray(ids.length()) { ids.getInt(it) }
                val name = plan.optString("name", "DesiCaps").replace(Regex("[^\\w\\- ]"), "").ifBlank { "DesiCaps" } +
                        "_captions_" + System.currentTimeMillis() / 1000 + ".mp4"
                keepAwake(true)
                exporter.start(File(File(cacheDir, "media"), file), plan.getInt("width"), plan.getInt("height"),
                    plan.optDouble("fps", 30.0).toFloat(), times, idArr, frames, name,
                    onProgress = { emit(JSONObject().put("type", "exportProgress").put("progress", it.toDouble())) },
                    onDone = { uri -> keepAwake(false); emit(JSONObject().put("type", "exported").put("uri", uri)) },
                    onError = { msg -> keepAwake(false); emit(JSONObject().put("type", "exportError").put("message", msg)) })
            } catch (e: Exception) { keepAwake(false); emitError("exportError", e) }
        }

        @JavascriptInterface fun share(uri: String) = runOnUiThread {
            val i = Intent(Intent.ACTION_SEND).setType("video/mp4").putExtra(Intent.EXTRA_STREAM, Uri.parse(uri))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            startActivity(Intent.createChooser(i, "Share video"))
        }

        @JavascriptInterface fun openVideo(uri: String) = runOnUiThread {
            try {
                startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(uri), "video/mp4")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
            } catch (_: Exception) {}
        }

        @JavascriptInterface fun shareText(text: String) = runOnUiThread {
            startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, text), "Share"))
        }
    }
}
