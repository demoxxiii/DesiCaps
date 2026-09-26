import Foundation

/// Speech models: "hinglish" ships inside the app, the others are optional downloads.
final class ModelStore: NSObject, URLSessionDownloadDelegate {
    struct Engine {
        let id, label, note, file, lang, dtw: String
        let sizeMb: Int
        let url: String?
        let bundled: Bool
    }

    static let repo = "https://github.com/demoxxiii/DesiCaps/releases/download/models-v1/"
    static let hf = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"
    static let engines: [Engine] = [
        Engine(id: "hinglish", label: "Hinglish · Fast", note: "Built in. Writes Hindi speech in Roman letters.",
               file: "ggml-hinglish-swift-q8_0.bin", lang: "en", dtw: "base", sizeMb: 80, url: nil, bundled: true),
        Engine(id: "hinglish-best", label: "Hinglish · Best", note: "Same as the PC app. Most accurate; fast on recent iPhones.",
               file: "ggml-hinglish-apex-q5_0.bin", lang: "en", dtw: "large-v3-turbo", sizeMb: 574,
               url: repo + "ggml-hinglish-apex-q5_0.bin", bundled: false),
        Engine(id: "devanagari", label: "Hindi · देवनागरी", note: "Writes Hindi in Devanagari script.",
               file: "ggml-small-q5_1.bin", lang: "hi", dtw: "small", sizeMb: 190, url: hf + "ggml-small-q5_1.bin", bundled: false),
        Engine(id: "english", label: "English", note: "For English-only videos.",
               file: "ggml-small-q5_1.bin", lang: "en", dtw: "small", sizeMb: 190, url: hf + "ggml-small-q5_1.bin", bundled: false),
    ]

    static func engine(_ id: String) -> Engine { engines.first { $0.id == id } ?? engines[0] }

    static var dir: URL {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("models")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    static func path(_ e: Engine) -> URL? {
        if e.bundled {
            for rel in ["models/" + e.file, e.file] {
                if let u = Bundle.main.resourceURL?.appendingPathComponent(rel),
                   FileManager.default.fileExists(atPath: u.path) { return u }
            }
            return nil
        }
        let f = dir.appendingPathComponent(e.file)
        let size = (try? FileManager.default.attributesOfItem(atPath: f.path)[.size] as? NSNumber)?.int64Value ?? 0
        return size > 1_000_000 ? f : nil
    }

    static func status() -> [String: Any] {
        var o: [String: Any] = [:]
        for e in engines {
            o[e.id] = ["label": e.label, "note": e.note, "sizeMb": e.sizeMb, "ready": path(e) != nil, "builtIn": e.bundled]
        }
        return o
    }

    static func delete(_ id: String) {
        let e = engine(id)
        if !e.bundled { try? FileManager.default.removeItem(at: dir.appendingPathComponent(e.file)) }
    }

    // MARK: - downloads

    private var session: URLSession!
    private var task: URLSessionDownloadTask?
    private var current: Engine?
    var onProgress: ((String, Int64, Int64) -> Void)?
    var onDone: ((String, Error?) -> Void)?

    override init() {
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    func download(_ id: String) {
        let e = ModelStore.engine(id)
        guard let s = e.url, let url = URL(string: s) else { return }
        task?.cancel()
        current = e
        task = session.downloadTask(with: url)
        task?.resume()
    }

    func cancel() { task?.cancel() }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let e = current else { return }
        onProgress?(e.id, totalBytesWritten, max(totalBytesExpectedToWrite, 0))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let e = current else { return }
        let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 200
        if code != 200 {
            onDone?(e.id, NSError(domain: "DesiCaps", code: code, userInfo: [NSLocalizedDescriptionKey: "Download failed (HTTP \(code))"]))
            current = nil
            return
        }
        let dst = ModelStore.dir.appendingPathComponent(e.file)
        try? FileManager.default.removeItem(at: dst)
        do {
            try FileManager.default.moveItem(at: location, to: dst)
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            var d = dst; try? d.setResourceValues(values)
            onDone?(e.id, nil)
        } catch { onDone?(e.id, error) }
        current = nil
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error = error, let e = current else { return }
        current = nil
        onDone?(e.id, error)
    }
}
