import Foundation
import Network

/// Minimal HTTP/1.1 file server on 127.0.0.1. Serves the web UI (from the app bundle) and the
/// imported videos (with Range support so <video> can seek). Keeps everything same-origin.
final class HTTPServer {
    private let www: URL
    private let media: URL
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "desicaps.http", qos: .userInitiated, attributes: .concurrent)
    private(set) var port: UInt16 = 0

    init(www: URL, media: URL) {
        self.www = www
        self.media = media
    }

    /// Starts on a fixed port (keeps the page origin + saved state stable) with a random-port fallback.
    func start() throws {
        for p in [UInt16(48321), 48322, 48323, 0] {
            do {
                try startOn(port: p)
                return
            } catch {
                continue
            }
        }
        throw NSError(domain: "DesiCaps", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not start the local server"])
    }

    private func startOn(port p: UInt16) throws {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true
        let l = p == 0 ? try NWListener(using: params) : try NWListener(using: params, on: NWEndpoint.Port(rawValue: p)!)
        let ready = DispatchSemaphore(value: 0)
        var failed = false
        l.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.signal()
            case .failed: failed = true; ready.signal()
            default: break
            }
        }
        l.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
        l.start(queue: queue)
        _ = ready.wait(timeout: .now() + 3)
        guard !failed, let bound = l.port?.rawValue, bound != 0 else {
            l.cancel()
            throw NSError(domain: "DesiCaps", code: 2)
        }
        listener = l
        port = bound
    }

    var origin: String { "http://127.0.0.1:\(port)" }
    func mediaURL(_ name: String) -> String {
        origin + "/media/" + (name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name)
    }

    // MARK: - connections

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        readHead(conn, buffer: Data())
    }

    private func readHead(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, done, err in
            guard let self = self else { conn.cancel(); return }
            var buf = buffer
            if let d = data { buf.append(d) }
            if let r = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buf[..<r.lowerBound], as: UTF8.self)
                self.respond(conn, head: head)
            } else if err != nil || done || buf.count > 65536 {
                conn.cancel()
            } else {
                self.readHead(conn, buffer: buf)
            }
        }
    }

    private func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        case "ttf": return "font/ttf"
        case "woff2": return "font/woff2"
        case "mp4", "m4v": return "video/mp4"
        case "mov": return "video/quicktime"
        default: return "application/octet-stream"
        }
    }

    private func respond(_ conn: NWConnection, head: String) {
        let lines = head.components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").split(separator: " ")
        let method = parts.count > 0 ? String(parts[0]) : "GET"
        var path = parts.count > 1 ? String(parts[1]) : "/"
        path = String(path.split(separator: "?").first ?? "/")
        path = path.removingPercentEncoding ?? path
        var range: String?
        for l in lines.dropFirst() where l.lowercased().hasPrefix("range:") {
            range = String(l.dropFirst(6)).trimmingCharacters(in: .whitespaces)
        }

        let file: URL
        if path.hasPrefix("/media/") {
            let name = (path as NSString).lastPathComponent
            file = media.appendingPathComponent(name)
        } else {
            let rel = path == "/" ? "index.html" : String(path.dropFirst())
            if rel.contains("..") { return send(conn, status: "404 Not Found", headers: [:], body: Data()) }
            file = www.appendingPathComponent(rel)
        }
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
              let size = (attrs[.size] as? NSNumber)?.int64Value,
              (attrs[.type] as? FileAttributeType) == .typeRegular else {
            return send(conn, status: "404 Not Found", headers: [:], body: Data())
        }

        var start: Int64 = 0
        var end: Int64 = size - 1
        var partial = false
        if let r = range, r.hasPrefix("bytes=") {
            let spec = r.dropFirst(6).split(separator: ",").first.map(String.init) ?? ""
            let ab = spec.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
            let a = ab.count > 0 ? ab[0] : "", b = ab.count > 1 ? ab[1] : ""
            if a.isEmpty, let n = Int64(b) { start = max(0, size - n) }
            else {
                start = Int64(a) ?? 0
                if let e = Int64(b) { end = e }
            }
            end = min(end, size - 1)
            partial = true
            if start > end {
                return send(conn, status: "416 Range Not Satisfiable", headers: ["Content-Range": "bytes */\(size)"], body: Data())
            }
        }
        let count = end - start + 1
        var headers = [
            "Content-Type": mime(file.pathExtension),
            "Accept-Ranges": "bytes",
            "Content-Length": "\(count)",
            "Cache-Control": "no-cache",
        ]
        if partial { headers["Content-Range"] = "bytes \(start)-\(end)/\(size)" }
        let status = partial ? "206 Partial Content" : "200 OK"
        conn.send(content: headerData(status: status, headers: headers), completion: .contentProcessed { [weak self] err in
            guard err == nil, method != "HEAD", let self = self, let fh = try? FileHandle(forReadingFrom: file) else {
                conn.cancel(); return
            }
            do { try fh.seek(toOffset: UInt64(start)) } catch { conn.cancel(); return }
            self.stream(conn, fh: fh, left: count)
        })
    }

    private func stream(_ conn: NWConnection, fh: FileHandle, left: Int64) {
        if left <= 0 {
            try? fh.close()
            conn.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in conn.cancel() })
            return
        }
        let n = Int(min(Int64(256 * 1024), left))
        let chunk = fh.readData(ofLength: n)
        if chunk.isEmpty { try? fh.close(); conn.cancel(); return }
        conn.send(content: chunk, completion: .contentProcessed { [weak self] err in
            if err != nil { try? fh.close(); conn.cancel(); return }
            self?.stream(conn, fh: fh, left: left - Int64(chunk.count))
        })
    }

    private func headerData(status: String, headers: [String: String]) -> Data {
        var s = "HTTP/1.1 \(status)\r\n"
        for (k, v) in headers { s += "\(k): \(v)\r\n" }
        s += "Connection: close\r\n\r\n"
        return Data(s.utf8)
    }

    private func send(_ conn: NWConnection, status: String, headers: [String: String], body: Data) {
        var h = headers
        h["Content-Length"] = "\(body.count)"
        var d = headerData(status: status, headers: h)
        d.append(body)
        conn.send(content: d, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in conn.cancel() })
    }
}
