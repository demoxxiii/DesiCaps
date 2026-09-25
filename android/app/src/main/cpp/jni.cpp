// DesiCaps Android <-> whisper.cpp bridge.
// Returns the same JSON shape as `whisper-cli -ojf` (transcription[].tokens[] with offsets + t_dtw)
// so the JS side can reuse the desktop word-building logic.
#include <jni.h>
#include <string>
#include <vector>
#include <cstring>
#include <thread>
#include <atomic>
#include "whisper.h"

#ifdef __ANDROID__
#include <android/log.h>
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "DesiCapsWhisper", __VA_ARGS__)
#else
#define LOGI(...) do { fprintf(stderr, __VA_ARGS__); fprintf(stderr, "\n"); } while (0)
#endif

static std::atomic<bool> g_abort(false);

struct ProgressCtx {
    JNIEnv *env;
    jobject listener;
    jmethodID method;
};

static void progress_cb(struct whisper_context *, struct whisper_state *, int progress, void *user) {
    auto *p = (ProgressCtx *) user;
    if (p && p->listener && p->method) p->env->CallVoidMethod(p->listener, p->method, (jint) progress);
}

static bool abort_cb(void *) { return g_abort.load(); }

static whisper_alignment_heads_preset preset_from(const std::string &s) {
    if (s == "base") return WHISPER_AHEADS_BASE;
    if (s == "small") return WHISPER_AHEADS_SMALL;
    if (s == "medium") return WHISPER_AHEADS_MEDIUM;
    if (s == "large-v3") return WHISPER_AHEADS_LARGE_V3;
    if (s == "large-v3-turbo") return WHISPER_AHEADS_LARGE_V3_TURBO;
    return WHISPER_AHEADS_NONE;
}

// length of the longest prefix of s that is complete UTF-8
static size_t valid_utf8_prefix(const std::string &s) {
    size_t i = 0, n = s.size(), ok = 0;
    while (i < n) {
        unsigned char c = (unsigned char) s[i];
        size_t len = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 0;
        if (len == 0) { i++; ok = i; continue; }          // stray byte: skip it
        if (i + len > n) break;                             // incomplete sequence at the end
        bool good = true;
        for (size_t k = 1; k < len; k++) if ((((unsigned char) s[i + k]) >> 6) != 0x2) { good = false; break; }
        if (!good) { i++; ok = i; continue; }
        i += len; ok = i;
    }
    return ok;
}

static void json_escape(std::string &out, const std::string &s) {
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); out += b; }
                else out += (char) c;
        }
    }
}

// keep only well-formed UTF-8 (drops stray bytes that can't be completed)
static std::string clean_utf8(const std::string &s) {
    std::string out;
    size_t i = 0, n = s.size();
    while (i < n) {
        unsigned char c = (unsigned char) s[i];
        size_t len = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 0;
        bool good = len > 0 && i + len <= n;
        for (size_t k = 1; good && k < len; k++) if ((((unsigned char) s[i + k]) >> 6) != 0x2) good = false;
        if (good) { out.append(s, i, len); i += len; } else i++;
    }
    return out;
}

extern "C" {

JNIEXPORT jlong JNICALL
Java_app_desicaps_WhisperLib_init(JNIEnv *env, jclass, jstring jpath, jstring jpreset) {
    const char *path = env->GetStringUTFChars(jpath, nullptr);
    const char *pre = env->GetStringUTFChars(jpreset, nullptr);
    whisper_context_params cp = whisper_context_default_params();
    cp.use_gpu = false;
    cp.flash_attn = false;               // DTW needs flash-attention off
    whisper_alignment_heads_preset ap = preset_from(pre);
    if (ap != WHISPER_AHEADS_NONE) {
        cp.dtw_token_timestamps = true;
        cp.dtw_aheads_preset = ap;
    }
    whisper_context *ctx = whisper_init_from_file_with_params(path, cp);
    if (!ctx && ap != WHISPER_AHEADS_NONE) {   // retry without DTW
        cp.dtw_token_timestamps = false;
        cp.dtw_aheads_preset = WHISPER_AHEADS_NONE;
        ctx = whisper_init_from_file_with_params(path, cp);
    }
    LOGI("init %s preset=%s -> %p", path, pre, (void *) ctx);
    env->ReleaseStringUTFChars(jpath, path);
    env->ReleaseStringUTFChars(jpreset, pre);
    return (jlong) ctx;
}

JNIEXPORT void JNICALL
Java_app_desicaps_WhisperLib_free(JNIEnv *, jclass, jlong ptr) {
    if (ptr) whisper_free((whisper_context *) ptr);
}

JNIEXPORT void JNICALL
Java_app_desicaps_WhisperLib_abort(JNIEnv *, jclass) { g_abort = true; }

JNIEXPORT jstring JNICALL
Java_app_desicaps_WhisperLib_systemInfo(JNIEnv *env, jclass) {
    return env->NewStringUTF(whisper_print_system_info());
}

// returns UTF-8 JSON bytes, or null on failure
JNIEXPORT jbyteArray JNICALL
Java_app_desicaps_WhisperLib_transcribe(JNIEnv *env, jclass, jlong ptr, jfloatArray jsamples,
                                            jstring jlang, jint threads, jstring jprompt, jobject listener) {
    auto *ctx = (whisper_context *) ptr;
    if (!ctx) return nullptr;
    g_abort = false;

    jsize n = env->GetArrayLength(jsamples);
    std::vector<float> pcm((size_t) n);
    env->GetFloatArrayRegion(jsamples, 0, n, pcm.data());

    const char *lang = env->GetStringUTFChars(jlang, nullptr);
    std::string lang_s(lang);
    env->ReleaseStringUTFChars(jlang, lang);
    std::string prompt_s;
    if (jprompt) {
        const char *pr = env->GetStringUTFChars(jprompt, nullptr);
        prompt_s = pr;
        env->ReleaseStringUTFChars(jprompt, pr);
    }

    ProgressCtx pc{env, listener, nullptr};
    if (listener) {
        jclass cls = env->GetObjectClass(listener);
        pc.method = env->GetMethodID(cls, "onProgress", "(I)V");
    }

    whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    p.n_threads = threads > 0 ? threads : 4;
    p.language = lang_s.c_str();
    p.translate = false;
    p.no_context = true;
    p.token_timestamps = true;
    p.suppress_nst = true;
    p.print_progress = false;
    p.print_realtime = false;
    p.print_timestamps = false;
    p.print_special = false;
    p.progress_callback = progress_cb;
    p.progress_callback_user_data = &pc;
    p.abort_callback = abort_cb;
    p.abort_callback_user_data = nullptr;
    if (!prompt_s.empty()) p.initial_prompt = prompt_s.c_str();

    int rc = whisper_full(ctx, p, pcm.data(), (int) pcm.size());
    if (rc != 0) {
        LOGI("whisper_full failed rc=%d", rc);
        return nullptr;
    }

    const whisper_token eot = whisper_token_eot(ctx);
    std::string js = "{\"transcription\":[";
    int nseg = whisper_full_n_segments(ctx);
    for (int i = 0; i < nseg; i++) {
        if (i) js += ",";
        long long s0 = whisper_full_get_segment_t0(ctx, i) * 10, s1 = whisper_full_get_segment_t1(ctx, i) * 10;
        js += "{\"offsets\":{\"from\":" + std::to_string(s0) + ",\"to\":" + std::to_string(s1) + "},\"tokens\":[";
        int nt = whisper_full_n_tokens(ctx, i);
        std::string pending;
        bool first = true;
        for (int j = 0; j < nt; j++) {
            whisper_token_data td = whisper_full_get_token_data(ctx, i, j);
            if (td.id >= eot) continue;                 // timestamps & special tokens
            const char *tx = whisper_full_get_token_text(ctx, i, j);
            std::string s = pending + (tx ? tx : "");
            size_t ok = valid_utf8_prefix(s);
            std::string text = s.substr(0, ok);
            pending = s.substr(ok);
            if (text.empty()) continue;                  // wait for the rest of the character
            if (!first) js += ",";
            first = false;
            js += "{\"text\":\"";
            json_escape(js, clean_utf8(text));
            js += "\",\"offsets\":{\"from\":" + std::to_string((long long) td.t0 * 10) +
                  ",\"to\":" + std::to_string((long long) td.t1 * 10) + "},\"t_dtw\":" +
                  std::to_string((long long) td.t_dtw) + ",\"p\":" + std::to_string(td.p) + "}";
        }
        js += "]}";
    }
    js += "]}";

    jbyteArray out = env->NewByteArray((jsize) js.size());
    env->SetByteArrayRegion(out, 0, (jsize) js.size(), (const jbyte *) js.data());
    return out;
}

} // extern "C"
