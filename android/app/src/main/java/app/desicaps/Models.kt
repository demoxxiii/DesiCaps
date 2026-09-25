package app.desicaps

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Speech models. "hinglish" ships inside the app; the rest are optional downloads. */
object Models {
    class Engine(
        val id: String, val label: String, val note: String, val file: String, val lang: String,
        val dtw: String, val sizeMb: Int, val url: String?, val asset: String?
    )

    private const val REPO = "https://github.com/demoxxiii/DesiCaps/releases/download/models-v1/"
    private const val HF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"

    val engines = listOf(
        Engine("hinglish", "Hinglish · Fast", "Built in. Writes Hindi speech in Roman letters.",
            "ggml-hinglish-swift-q8_0.bin", "en", "base", 80, null, "models/ggml-hinglish-swift-q8_0.bin"),
        Engine("hinglish-best", "Hinglish · Best", "Same as the PC app. Most accurate, but slow on most phones.",
            "ggml-hinglish-apex-q5_0.bin", "en", "large-v3-turbo", 574, REPO + "ggml-hinglish-apex-q5_0.bin", null),
        Engine("devanagari", "Hindi · देवनागरी", "Writes Hindi in Devanagari script.",
            "ggml-small-q5_1.bin", "hi", "small", 190, HF + "ggml-small-q5_1.bin", null),
        Engine("english", "English", "For English-only videos.",
            "ggml-small-q5_1.bin", "en", "small", 190, HF + "ggml-small-q5_1.bin", null)
    )

    fun byId(id: String) = engines.firstOrNull { it.id == id } ?: engines[0]

    private fun dir(ctx: Context) = File(ctx.filesDir, "models").apply { mkdirs() }

    fun file(ctx: Context, e: Engine) = File(dir(ctx), e.file)

    fun ready(ctx: Context, e: Engine) = e.asset != null || file(ctx, e).let { it.exists() && it.length() > 1_000_000 }

    fun status(ctx: Context): String {
        val o = JSONObject()
        for (e in engines) {
            o.put(e.id, JSONObject().apply {
                put("label", e.label); put("note", e.note); put("sizeMb", e.sizeMb)
                put("ready", ready(ctx, e)); put("builtIn", e.asset != null)
            })
        }
        return o.toString()
    }

    /** Path to a usable model file, copying the built-in one out of the APK on first use. */
    fun ensure(ctx: Context, e: Engine): File {
        val f = file(ctx, e)
        if (f.exists() && f.length() > 1_000_000) return f
        val asset = e.asset ?: throw IllegalStateException("Download the ${e.label} model first.")
        val tmp = File(f.path + ".part")
        ctx.assets.open(asset).use { i -> tmp.outputStream().use { o -> i.copyTo(o, 1 shl 20) } }
        tmp.renameTo(f)
        return f
    }

    fun download(ctx: Context, e: Engine, cancelled: () -> Boolean, progress: (Long, Long) -> Unit) {
        val url0 = e.url ?: return
        val f = file(ctx, e)
        val tmp = File(f.path + ".part")
        var url = URL(url0)
        var conn: HttpURLConnection
        var hops = 0
        while (true) {  // follow redirects (GitHub/HF -> CDN), including https->https host changes
            conn = url.openConnection() as HttpURLConnection
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 20_000
            conn.readTimeout = 60_000
            conn.setRequestProperty("User-Agent", "DesiCaps-Android")
            val code = conn.responseCode
            if (code in 300..399 && hops++ < 8) {
                url = URL(url, conn.getHeaderField("Location"))
                conn.disconnect()
                continue
            }
            if (code != 200) throw IllegalStateException("Download failed (HTTP $code)")
            break
        }
        val total = conn.contentLengthLong
        var got = 0L
        var last = 0L
        conn.inputStream.use { i ->
            tmp.outputStream().use { o ->
                val buf = ByteArray(1 shl 16)
                while (true) {
                    if (cancelled()) throw InterruptedException("cancelled")
                    val n = i.read(buf)
                    if (n < 0) break
                    o.write(buf, 0, n)
                    got += n
                    if (got - last > 2_000_000) { last = got; progress(got, total) }
                }
            }
        }
        if (total > 0 && got != total) throw IllegalStateException("Download was interrupted")
        tmp.renameTo(f)
        // the other entry that shares this file is now ready too
        progress(got, got)
    }
}
