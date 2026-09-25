package app.desicaps

import android.util.Log
import java.io.File

/** JNI binding to whisper.cpp. Loads the fastest native build this phone's CPU supports. */
object WhisperLib {
    interface ProgressListener {
        fun onProgress(progress: Int)
    }

    val variant: String

    init {
        val info = try { File("/proc/cpuinfo").readText() } catch (e: Exception) { "" }
        val fast = info.contains("fphp") && info.contains("asimddp")
        var v = if (fast) "whisperjni_v82" else "whisperjni_v8"
        try {
            System.loadLibrary(v)
        } catch (e: UnsatisfiedLinkError) {
            Log.w("DesiCaps", "could not load $v, falling back", e)
            v = "whisperjni_v8"
            System.loadLibrary(v)
        }
        variant = v
        Log.i("DesiCaps", "whisper native lib: $v")
    }

    @JvmStatic external fun init(modelPath: String, dtwPreset: String): Long
    @JvmStatic external fun free(ctx: Long)
    @JvmStatic external fun abort()
    @JvmStatic external fun systemInfo(): String
    @JvmStatic external fun transcribe(
        ctx: Long, samples: FloatArray, lang: String, threads: Int, prompt: String?, listener: ProgressListener?
    ): ByteArray?

    /** Number of "big" cores (ignores the slow efficiency cores), clamped to 2..6. */
    fun goodThreadCount(): Int {
        return try {
            val freqs = (0 until Runtime.getRuntime().availableProcessors()).mapNotNull {
                try { File("/sys/devices/system/cpu/cpu$it/cpufreq/cpuinfo_max_freq").readText().trim().toLong() }
                catch (e: Exception) { null }
            }
            if (freqs.isEmpty()) return 4
            val min = freqs.minOrNull() ?: 0L
            val big = freqs.count { it > min }
            (if (big >= 2) big else freqs.size).coerceIn(2, 6)
        } catch (e: Exception) { 4 }
    }
}
