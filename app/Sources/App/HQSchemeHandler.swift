import Foundation
import WebKit
import Backend

/// Esquema `hq://app/...`: sirve los estáticos de la oficina desde el bundle y
/// delega `/api/*` en el `APIHandler` del Backend.
@MainActor
final class HQSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "hq"
    static let host = "app"

    private let router: APIHandler
    private let roots: [URL]
    private var stopped = Set<ObjectIdentifier>()
    /// Páginas embebidas (onboarding, spike) que no viven en el bundle.
    var embedded: [String: String] = [:]
    var verbose = ProcessInfo.processInfo.environment["HQ_LOG_REQUESTS"] == "1"

    init(router: APIHandler, roots: [URL]) {
        self.router = router
        self.roots = roots
    }

    // MARK: WKURLSchemeHandler

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let task = urlSchemeTask
        let request = task.request
        guard let url = request.url else { fail(task, code: .badURL); return }
        let method = (request.httpMethod ?? "GET").uppercased()
        let path = url.path.isEmpty ? "/" : url.path

        if path == "/api" || path.hasPrefix("/api/") {
            var query: [String: String] = [:]
            for item in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [] {
                query[item.name] = item.value ?? ""
            }
            let (body, source) = Self.readBody(request)
            if verbose { log("\(method) \(path) body=\(source) len=\(body?.count ?? 0)") }
            let router = self.router
            Task { [weak self] in
                let (status, json) = await router.handle(method: method, path: path, query: query, body: body)
                await MainActor.run {
                    self?.respond(task, url: url, status: status, mime: "application/json; charset=utf-8", data: json)
                }
            }
            return
        }

        guard method == "GET" || method == "HEAD" else {
            respond(task, url: url, status: 405, mime: "text/plain; charset=utf-8", data: Data("Method Not Allowed".utf8))
            return
        }
        if let page = embedded[path] {
            if verbose { log("GET \(path) (embebido)") }
            respond(task, url: url, status: 200, mime: "text/html; charset=utf-8", data: Data(page.utf8))
            return
        }
        guard let file = resolve(path) else {
            if verbose { log("GET \(path) -> 404") }
            respond(task, url: url, status: 404, mime: "text/plain; charset=utf-8", data: Data("Not Found".utf8))
            return
        }
        do {
            let data = try Data(contentsOf: file)
            if verbose { log("GET \(path) -> 200 (\(data.count) bytes)") }
            respond(task, url: url, status: 200, mime: Self.mime(for: file), data: data)
        } catch {
            respond(task, url: url, status: 500, mime: "text/plain; charset=utf-8", data: Data("Error".utf8))
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(urlSchemeTask))
    }

    // MARK: Helpers

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, mime: String, data: Data) {
        let id = ObjectIdentifier(task)
        if stopped.remove(id) != nil { return } // WebKit ya canceló la tarea: tocarla lanza excepción
        let headers = ["Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-store"]
        guard let resp = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.badServerResponse)); return
        }
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }

    private func fail(_ task: WKURLSchemeTask, code: URLError.Code) {
        task.didFailWithError(URLError(code))
    }

    /// Resuelve un path de URL a un archivo dentro de alguno de los roots (sin salirse de ellos).
    private func resolve(_ urlPath: String) -> URL? {
        var rel = urlPath.removingPercentEncoding ?? urlPath
        if rel.hasSuffix("/") { rel += "index.html" }
        while rel.hasPrefix("/") { rel.removeFirst() }
        if rel.isEmpty { rel = "index.html" }
        if rel.split(separator: "/").contains("..") { return nil }
        for root in roots {
            let base = root.standardizedFileURL.resolvingSymlinksInPath()
            let candidate = base.appendingPathComponent(rel).standardizedFileURL
            guard candidate.path.hasPrefix(base.path + "/") else { continue }
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDir), !isDir.boolValue {
                return candidate
            }
        }
        return nil
    }

    /// El body de un POST puede llegar en httpBody o en httpBodyStream; el spike verifica cuál.
    nonisolated static func readBody(_ request: URLRequest) -> (Data?, String) {
        if let b = request.httpBody { return (b, "httpBody") }
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buf = [UInt8](repeating: 0, count: 64 * 1024)
            while stream.hasBytesAvailable {
                let n = stream.read(&buf, maxLength: buf.count)
                if n <= 0 { break }
                data.append(buf, count: n)
            }
            return (data, "httpBodyStream")
        }
        return (nil, "none")
    }

    nonisolated static func mime(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "txt", "md": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }

    private func log(_ s: String) {
        FileHandle.standardError.write(Data("[hq] \(s)\n".utf8))
    }
}
