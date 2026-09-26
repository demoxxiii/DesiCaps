import Foundation

/// Runs whisper.cpp (Metal GPU when available, CPU fallback) and returns the same JSON shape
/// as `whisper-cli -ojf`, so the shared JS turns tokens into words exactly like the other apps.
final class WhisperRunner {
    private static var abortFlag = false
    static func abort() { abortFlag = true }

    private final class ProgressBox {
        let fn: (Int) -> Void
        init(_ fn: @escaping (Int) -> Void) { self.fn = fn }
    }

    private static func preset(_ name: String) -> whisper_alignment_heads_preset {
        switch name {
        case "base": return WHISPER_AHEADS_BASE
        case "small": return WHISPER_AHEADS_SMALL
        case "medium": return WHISPER_AHEADS_MEDIUM
        case "large-v3": return WHISPER_AHEADS_LARGE_V3
        case "large-v3-turbo": return WHISPER_AHEADS_LARGE_V3_TURBO
        default: return WHISPER_AHEADS_NONE
        }
    }

    /// Loads the model: GPU + DTW, then CPU + DTW, then CPU without DTW.
    private static func load(_ path: String, dtw: String) -> OpaquePointer? {
        let pre = preset(dtw)
        for (gpu, useDtw) in [(true, true), (false, true), (false, false)] {
            var cp = whisper_context_default_params()
            cp.use_gpu = gpu
            cp.flash_attn = false
            if useDtw && pre != WHISPER_AHEADS_NONE {
                cp.dtw_token_timestamps = true
                cp.dtw_aheads_preset = pre
            }
            if let ctx = whisper_init_from_file_with_params(path, cp) { return ctx }
        }
        return nil
    }

    static func transcribe(modelPath: String, dtw: String, samples: [Float], language: String,
                           prompt: String?, progress: @escaping (Int) -> Void) throws -> Data {
        abortFlag = false
        guard let ctx = load(modelPath, dtw: dtw) else {
            throw NSError(domain: "DesiCaps", code: 10,
                          userInfo: [NSLocalizedDescriptionKey: "Could not load the speech model. Try deleting and re-downloading it."])
        }
        defer { whisper_free(ctx) }

        var p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
        let cores = ProcessInfo.processInfo.activeProcessorCount
        p.n_threads = Int32(max(2, min(6, cores - 2)))
        p.translate = false
        p.no_context = true
        p.token_timestamps = true
        p.suppress_nst = true
        p.print_progress = false
        p.print_realtime = false
        p.print_timestamps = false
        p.print_special = false

        let box = ProgressBox(progress)
        let boxPtr = Unmanaged.passRetained(box).toOpaque()
        defer { Unmanaged<ProgressBox>.fromOpaque(boxPtr).release() }
        p.progress_callback = { _, _, pct, user in
            guard let user = user else { return }
            Unmanaged<ProgressBox>.fromOpaque(user).takeUnretainedValue().fn(Int(pct))
        }
        p.progress_callback_user_data = boxPtr
        p.abort_callback = { _ in WhisperRunner.abortFlag }
        p.abort_callback_user_data = nil

        let langC = strdup(language)
        defer { free(langC) }
        p.language = UnsafePointer(langC)
        var promptC: UnsafeMutablePointer<CChar>? = nil
        if let pr = prompt, !pr.isEmpty { promptC = strdup(pr) }
        defer { if let pc = promptC { free(pc) } }
        if let pc = promptC { p.initial_prompt = UnsafePointer(pc) }

        let rc = samples.withUnsafeBufferPointer { buf in
            whisper_full(ctx, p, buf.baseAddress, Int32(buf.count))
        }
        if abortFlag { throw CancellationError() }
        if rc != 0 {
            throw NSError(domain: "DesiCaps", code: 11, userInfo: [NSLocalizedDescriptionKey: "Transcription failed (\(rc))."])
        }
        return buildJSON(ctx)
    }

    private static func buildJSON(_ ctx: OpaquePointer) -> Data {
        let eot = whisper_token_eot(ctx)
        var segs: [[String: Any]] = []
        let nseg = whisper_full_n_segments(ctx)
        for i in 0..<nseg {
            var toks: [[String: Any]] = []
            var pending: [UInt8] = []
            let nt = whisper_full_n_tokens(ctx, i)
            for j in 0..<nt {
                let td = whisper_full_get_token_data(ctx, i, j)
                if td.id >= eot { continue }  // timestamps & special tokens
                if let cs = whisper_full_get_token_text(ctx, i, j) {
                    pending.append(contentsOf: Array(UnsafeBufferPointer(start: UnsafeRawPointer(cs).assumingMemoryBound(to: UInt8.self), count: strlen(cs))))
                }
                let ok = validPrefix(pending)
                if ok == 0 { continue }  // wait for the rest of a multi-byte character
                let text = String(decoding: pending[0..<ok], as: UTF8.self)
                pending.removeFirst(ok)
                toks.append([
                    "text": text,
                    "offsets": ["from": Int(td.t0) * 10, "to": Int(td.t1) * 10],
                    "t_dtw": Int(td.t_dtw),
                    "p": Double(td.p),
                ])
            }
            segs.append([
                "offsets": ["from": Int(whisper_full_get_segment_t0(ctx, i)) * 10, "to": Int(whisper_full_get_segment_t1(ctx, i)) * 10],
                "tokens": toks,
            ])
        }
        return (try? JSONSerialization.data(withJSONObject: ["transcription": segs])) ?? Data("{\"transcription\":[]}".utf8)
    }

    /// Length of the longest prefix of `b` made of complete UTF-8 characters (stray bytes count as consumed).
    private static func validPrefix(_ b: [UInt8]) -> Int {
        var i = 0, ok = 0
        while i < b.count {
            let c = b[i]
            let len = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 0
            if len == 0 { i += 1; ok = i; continue }
            if i + len > b.count { break }
            var good = true
            for k in 1..<len where (b[i + k] >> 6) != 0x2 { good = false; break }
            if !good { i += 1; ok = i; continue }
            i += len; ok = i
        }
        return ok
    }
}
