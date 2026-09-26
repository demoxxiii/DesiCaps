package app.desicaps

import android.util.Log
import java.io.BufferedInputStream
import java.io.File
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import kotlin.concurrent.thread

/**
 * Tiny HTTP server on 127.0.0.1 that streams the imported video to the WebView's <video> element.
 * Some phones' WebViews don't play (or seek) media delivered through request interception,
 * but every WebView plays a normal HTTP URL with Range support.
 */
class LocalServer(private val root: File) {
    private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    val port: Int get() = server.localPort

    init {
        thread(name = "desicaps-http", isDaemon = true) {
            while (!server.isClosed) {
                try {
                    val s = server.accept()
                    thread(isDaemon = true) { handle(s) }
                } catch (e: Exception) {
                    if (!server.isClosed) Log.w("DesiCaps", "http accept", e)
                }
            }
        }
    }

    fun url(name: String) = "http://127.0.0.1:$port/media/$name"

    fun close() = try { server.close() } catch (_: Exception) {}

    private fun mime(n: String) = when (n.substringAfterLast('.', "").lowercase()) {
        "mp4", "m4v" -> "video/mp4"; "mov" -> "video/quicktime"; "webm" -> "video/webm"
        "mkv" -> "video/x-matroska"; "3gp" -> "video/3gpp"; else -> "application/octet-stream"
    }

    private fun handle(s: Socket) {
        s.use { sock ->
            try {
                sock.soTimeout = 30_000
                val input = BufferedInputStream(sock.getInputStream())
                val lines = ArrayList<String>()
                val sb = StringBuilder()
                while (true) {  // read request head
                    val c = input.read()
                    if (c < 0) return
                    if (c == '\n'.code) {
                        val line = sb.toString().trimEnd('\r')
                        sb.setLength(0)
                        if (line.isEmpty()) break
                        lines.add(line)
                        if (lines.size > 100) return
                    } else sb.append(c.toChar())
                }
                if (lines.isEmpty()) return
                val parts = lines[0].split(" ")
                val method = parts.getOrElse(0) { "GET" }
                val path = URLDecoder.decode(parts.getOrElse(1) { "/" }.substringBefore('?'), "UTF-8")
                val range = lines.drop(1).firstOrNull { it.startsWith("range:", true) }?.substringAfter(':')?.trim()
                val out = sock.getOutputStream()
                val name = path.removePrefix("/media/").substringAfterLast('/')
                val f = File(root, name)
                if (!path.startsWith("/media/") || name.isEmpty() || !f.isFile) {
                    out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                    return
                }
                val len = f.length()
                var start = 0L
                var end = len - 1
                var partial = false
                if (range != null && range.startsWith("bytes=")) {
                    val r = range.removePrefix("bytes=").split(",")[0].split("-")
                    val a = r.getOrElse(0) { "" }
                    val b = r.getOrElse(1) { "" }
                    if (a.isEmpty() && b.isNotEmpty()) { start = (len - (b.toLongOrNull() ?: 0)).coerceAtLeast(0); }
                    else { start = a.toLongOrNull() ?: 0; if (b.isNotEmpty()) end = b.toLongOrNull() ?: end }
                    end = end.coerceAtMost(len - 1)
                    partial = true
                    if (start > end) {
                        out.write("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */$len\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                        return
                    }
                }
                val count = end - start + 1
                val head = StringBuilder()
                    .append(if (partial) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
                    .append("Content-Type: ${mime(name)}\r\n")
                    .append("Accept-Ranges: bytes\r\n")
                    .append("Content-Length: $count\r\n")
                    .append("Access-Control-Allow-Origin: *\r\n")
                    .append("Cache-Control: no-cache\r\n")
                    .append(if (partial) "Content-Range: bytes $start-$end/$len\r\n" else "")
                    .append("Connection: close\r\n\r\n")
                out.write(head.toString().toByteArray())
                if (method != "HEAD") send(f, start, count, out)
                out.flush()
            } catch (_: Exception) {
                // client went away (normal while seeking)
            }
        }
    }

    private fun send(f: File, start: Long, count: Long, out: OutputStream) {
        RandomAccessFile(f, "r").use { raf ->
            raf.seek(start)
            val buf = ByteArray(1 shl 16)
            var left = count
            while (left > 0) {
                val n = raf.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                if (n <= 0) break
                out.write(buf, 0, n)
                left -= n
            }
        }
    }
}
