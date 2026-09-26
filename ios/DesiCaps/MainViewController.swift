import AVKit
import PhotosUI
import UIKit
import UniformTypeIdentifiers
import WebKit

/// Hosts the shared DesiCaps web UI (same as Android) and does the native work:
/// picking videos, speech-to-text (whisper.cpp + Metal), preview copies and export.
final class MainViewController: UIViewController, WKScriptMessageHandler, PHPickerViewControllerDelegate {

    private var web: WKWebView!
    private var server: HTTPServer!
    private let models = ModelStore()
    private let work = DispatchQueue(label: "desicaps.work", qos: .userInitiated)
    private let frameQueue = DispatchQueue(label: "desicaps.frames")
    private var cancelled = false
    private var exportFrames: [Int: MediaTools.Frame] = [:]
    private var framesDir: URL { FileManager.default.temporaryDirectory.appendingPathComponent("frames") }
    private var exportTask: Task<Void, Never>?

    static var mediaDir: URL {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("media")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    static var exportsDir: URL {
        let d = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("DesiCaps Exports")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.055, green: 0.055, blue: 0.07, alpha: 1)

        let www = Bundle.main.resourceURL!.appendingPathComponent("www")
        server = HTTPServer(www: www, media: MainViewController.mediaDir)
        do { try server.start() } catch { NSLog("DesiCaps: server failed \(error)") }

        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let ucc = WKUserContentController()
        ucc.add(self, name: "bridge")
        ucc.addUserScript(WKUserScript(source: "window.__IOS_STATE = \(stateJSON());",
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController = ucc

        web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        web.backgroundColor = view.backgroundColor
        web.scrollView.backgroundColor = view.backgroundColor
        web.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) { web.isInspectable = true }
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        // keep the page inside the safe area (clear of the notch / Dynamic Island and home bar)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        models.onProgress = { [weak self] id, got, total in
            self?.emit(["type": "downloadProgress", "id": id, "got": got, "total": total])
        }
        models.onDone = { [weak self] id, err in
            guard let self = self else { return }
            if let err = err {
                let msg = (err as NSError).code == NSURLErrorCancelled ? "cancelled" : err.localizedDescription
                self.emit(["type": "downloadError", "id": id, "message": msg])
            } else {
                self.emit(["type": "downloadDone", "id": id])
            }
            self.keepAwake(false)
        }

        web.load(URLRequest(url: URL(string: server.origin + "/index.html")!))
    }

    // MARK: - state / events for the page

    private func stateJSON() -> String {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: MainViewController.mediaDir.path)) ?? []
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let st: [String: Any] = ["version": v, "cpu": "Metal GPU · \(ProcessInfo.processInfo.activeProcessorCount) cores",
                                 "engines": ModelStore.status(), "files": files]
        let d = (try? JSONSerialization.data(withJSONObject: st)) ?? Data("{}".utf8)
        return String(decoding: d, as: UTF8.self)
    }

    /// Sends an event to mobile.js (after refreshing the shim's cached state).
    private func emit(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
        let payload = String(decoding: d, as: UTF8.self)
        let quoted = String(decoding: (try? JSONSerialization.data(withJSONObject: [payload])) ?? Data("[\"\"]".utf8), as: UTF8.self)
        let js = "window.__iosState && window.__iosState(\(stateJSON())); window.__native && window.__native(\(quoted)[0]);"
        DispatchQueue.main.async { self.web.evaluateJavaScript(js, completionHandler: nil) }
    }

    private func emitError(_ type: String, _ err: Error) {
        if err is CancellationError { emit(["type": "cancelled"]); return }
        emit(["type": type, "message": err.localizedDescription])
    }

    private func keepAwake(_ on: Bool) {
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on }
    }

    // MARK: - bridge

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let cmd = m["cmd"] as? String else { return }
        switch cmd {
        case "pickVideo": pickVideo()
        case "openUrl":
            if let s = m["url"] as? String, let u = URL(string: s) { UIApplication.shared.open(u) }
        case "downloadModel":
            if let id = m["id"] as? String { keepAwake(true); models.download(id) }
        case "cancelDownload": models.cancel()
        case "deleteModel":
            if let id = m["id"] as? String { ModelStore.delete(id); emit(["type": "state"]) }
        case "cancel":
            cancelled = true
            WhisperRunner.abort()
            exportTask?.cancel()
            MediaTools.currentExport?.cancelExport()
        case "transcribe":
            transcribe(file: m["file"] as? String ?? "", engineId: m["engine"] as? String ?? "hinglish",
                       prompt: m["prompt"] as? String ?? "")
        case "makePreview":
            makePreview(file: m["file"] as? String ?? "")
        case "beginExport":
            cancelled = false
            frameQueue.async {
                try? FileManager.default.removeItem(at: self.framesDir)
                try? FileManager.default.createDirectory(at: self.framesDir, withIntermediateDirectories: true)
                self.exportFrames = [:]
            }
        case "putFrame":
            let id = (m["id"] as? NSNumber)?.intValue ?? -1
            let x = (m["x"] as? NSNumber)?.doubleValue ?? 0, y = (m["y"] as? NSNumber)?.doubleValue ?? 0
            let url = m["url"] as? String ?? ""
            frameQueue.async {
                guard let comma = url.firstIndex(of: ","), let data = Data(base64Encoded: String(url[url.index(after: comma)...])) else { return }
                let f = self.framesDir.appendingPathComponent("\(id).png")
                try? data.write(to: f)
                self.exportFrames[id] = MediaTools.Frame(url: f, x: CGFloat(x), y: CGFloat(y))
            }
        case "finishExport":
            let file = m["file"] as? String ?? ""
            let plan = m["plan"] as? String ?? "{}"
            frameQueue.async {   // runs after every queued frame has been written
                DispatchQueue.main.async { self.finishExport(file: file, planJSON: plan) }
            }
        case "share":
            if let s = m["uri"] as? String { share(URL(fileURLWithPath: s)) }
        case "openVideo":
            if let s = m["uri"] as? String { play(URL(fileURLWithPath: s)) }
        case "shareText":
            if let s = m["text"] as? String { presentShare([s]) }
        default: break
        }
    }

    // MARK: - pick

    private func pickVideo() {
        var cfg = PHPickerConfiguration()
        cfg.filter = .videos
        cfg.selectionLimit = 1
        cfg.preferredAssetRepresentationMode = .current   // no slow re-encode of HEVC clips
        let picker = PHPickerViewController(configuration: cfg)
        picker.delegate = self
        present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let item = results.first?.itemProvider else { emit(["type": "pickCancelled"]); return }
        emit(["type": "importing"])
        let type = item.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .movie) == true } ?? UTType.movie.identifier
        let name = (item.suggestedName ?? "video")
        item.loadFileRepresentation(forTypeIdentifier: type) { [weak self] url, err in
            guard let self = self else { return }
            guard let url = url else {
                self.emit(["type": "pickError", "message": err?.localizedDescription ?? "Couldn't read that video"])
                return
            }
            // the temporary file is deleted when this block returns: copy it now
            let dir = MainViewController.mediaDir
            for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] {
                try? FileManager.default.removeItem(at: f)
            }
            var ext = url.pathExtension.lowercased()
            if ext.isEmpty || ext.count > 4 { ext = "mov" }
            let dst = dir.appendingPathComponent("video_\(Int(Date().timeIntervalSince1970)).\(ext)")
            do { try FileManager.default.copyItem(at: url, to: dst) }
            catch { self.emit(["type": "pickError", "message": error.localizedDescription]); return }
            Task { @MainActor in
                do {
                    let p = try await MediaTools.probe(dst)
                    self.emit(["type": "picked", "name": name, "file": dst.lastPathComponent,
                               "url": self.server.mediaURL(dst.lastPathComponent),
                               "width": p.width, "height": p.height, "duration": p.duration, "fps": p.fps,
                               "codec": "", "hdr": false])
                } catch { self.emitError("pickError", error) }
            }
        }
    }

    // MARK: - transcribe

    private func transcribe(file: String, engineId: String, prompt: String) {
        cancelled = false
        keepAwake(true)
        let e = ModelStore.engine(engineId)
        let video = MainViewController.mediaDir.appendingPathComponent(file)
        let progressOut: (Double, String) -> Void = { [weak self] f, msg in
            DispatchQueue.main.async { self?.emit(["type": "transcribeProgress", "progress": f, "message": msg]) }
        }
        let isCancelled: () -> Bool = { [weak self] in self?.cancelled ?? true }
        Task { @MainActor in
            defer { self.keepAwake(false) }
            do {
                guard let model = ModelStore.path(e) else {
                    throw NSError(domain: "DesiCaps", code: 30, userInfo: [NSLocalizedDescriptionKey: "Download the \(e.label) model first."])
                }
                progressOut(0.03, "Reading audio")
                let pcm = try await MediaTools.decodeAudio(video, cancelled: isCancelled) { f in
                    progressOut(0.03 + 0.07 * f, "Reading audio")
                }
                let seconds = Double(pcm.count) / 16000
                if seconds < 0.3 {
                    throw NSError(domain: "DesiCaps", code: 31, userInfo: [NSLocalizedDescriptionKey: "No speech found (the sound track is empty)."])
                }
                progressOut(0.1, "Loading model")
                let t0 = Date()
                let path = model.path, dtw = e.dtw, lang = e.lang, pr: String? = prompt.isEmpty ? nil : prompt
                let json = try await Task.detached(priority: .userInitiated) {
                    try WhisperRunner.transcribe(modelPath: path, dtw: dtw, samples: pcm, language: lang, prompt: pr) { pct in
                        progressOut(0.12 + 0.86 * Double(min(100, max(0, pct))) / 100, "Listening")
                    }
                }.value
                let result = (try? JSONSerialization.jsonObject(with: json)) ?? ["transcription": []]
                self.emit(["type": "transcribed", "result": result, "seconds": seconds,
                           "ms": Int(Date().timeIntervalSince(t0) * 1000)])
            } catch {
                self.emitError("transcribeError", error)
            }
        }
    }

    // MARK: - preview copy

    private func makePreview(file: String) {
        let src = MainViewController.mediaDir.appendingPathComponent(file)
        let name = "preview_" + (file as NSString).deletingPathExtension + ".mp4"
        let out = MainViewController.mediaDir.appendingPathComponent(name)
        Task { @MainActor in
            do {
                if !FileManager.default.fileExists(atPath: out.path) { try await MediaTools.makePreview(src, to: out) }
                self.emit(["type": "preview", "file": file, "url": self.server.mediaURL(name)])
            } catch { self.emit(["type": "previewError", "file": file, "message": error.localizedDescription]) }
        }
    }

    // MARK: - export

    private func finishExport(file: String, planJSON: String) {
        if cancelled { emit(["type": "cancelled"]); return }
        guard let plan = (try? JSONSerialization.jsonObject(with: Data(planJSON.utf8))) as? [String: Any] else {
            emit(["type": "exportError", "message": "Bad export plan"]); return
        }
        let times = ((plan["times"] as? [NSNumber]) ?? []).map { $0.doubleValue / 1_000_000 }
        let ids = ((plan["ids"] as? [NSNumber]) ?? []).map { $0.intValue }
        let w = CGFloat((plan["width"] as? NSNumber)?.doubleValue ?? 1080)
        let h = CGFloat((plan["height"] as? NSNumber)?.doubleValue ?? 1920)
        var base = (plan["name"] as? String ?? "DesiCaps").components(separatedBy: CharacterSet.alphanumerics.union(.init(charactersIn: "-_ ")).inverted).joined()
        if base.isEmpty { base = "DesiCaps" }
        let overlay = MediaTools.Overlay(times: times, ids: ids, frames: exportFrames, planW: w, planH: h)
        let input = MainViewController.mediaDir.appendingPathComponent(file)
        let output = MainViewController.exportsDir.appendingPathComponent("\(base)_captions_\(Int(Date().timeIntervalSince1970)).mp4")
        keepAwake(true)
        exportTask = Task { @MainActor in
            defer { self.keepAwake(false) }
            do {
                try await MediaTools.export(input: input, overlay: overlay, output: output) { [weak self] p in
                    DispatchQueue.main.async { self?.emit(["type": "exportProgress", "progress": p]) }
                }
                var note = ""
                do { try await MediaTools.saveToPhotos(output) } catch { note = error.localizedDescription }
                self.emit(["type": "exported", "uri": output.path, "note": note])
            } catch {
                self.emitError("exportError", error)
            }
        }
    }

    // MARK: - share / play

    private func presentShare(_ items: [Any]) {
        DispatchQueue.main.async {
            let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
            vc.popoverPresentationController?.sourceView = self.view
            vc.popoverPresentationController?.sourceRect = CGRect(x: self.view.bounds.midX, y: self.view.bounds.maxY - 80, width: 1, height: 1)
            self.present(vc, animated: true)
        }
    }

    private func share(_ url: URL) { presentShare([url]) }

    private func play(_ url: URL) {
        DispatchQueue.main.async {
            let vc = AVPlayerViewController()
            vc.player = AVPlayer(url: url)
            self.present(vc, animated: true) { vc.player?.play() }
        }
    }
}
