import Foundation
import Network

/// Servidor de desarrollo (`swift run oficina-dev`): sirve la interfaz (`oficina/`) y `/api/*` con el mismo `Backend` que
/// la app, en `http://localhost:PUERTO`. Reemplaza al modo dev Python: una sola implementación del backend.
/// Defensas (las mismas que tenía `oficina/server.py`): solo escucha en 127.0.0.1, `Host` de loopback (contra DNS
/// rebinding), `Origin` propio y `Content-Type: application/json` en las escrituras, estáticos en lista blanca.
public final class ServidorDev: @unchecked Sendable {
    /// Límite del cuerpo: la biblioteca sube archivos en base64 dentro del JSON (25 MB → ~34 MB).
    static let maxCuerpo = 40 * 1024 * 1024
    static let estaticos: Set<String> = ["index.html", "logo-prospera.svg"]

    private let router: APIHandler
    private let raizUI: URL
    private let raizVendor: URL
    public let puerto: UInt16
    private let cola = DispatchQueue(label: "hq.dev", attributes: .concurrent)
    private var listener: NWListener?

    /// `raizUI`: la carpeta `oficina/` (index.html, ui/, ldraw/). `raizVendor`: `app/Resources/vendor` (three.js, fuentes).
    public init(router: APIHandler, raizUI: URL, raizVendor: URL, puerto: UInt16) {
        self.router = router; self.raizUI = raizUI.standardizedFileURL; self.raizVendor = raizVendor.standardizedFileURL
        self.puerto = puerto
    }

    /// Empieza a escuchar en 127.0.0.1:puerto. Lanza si el puerto está ocupado.
    public func arrancar() throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: puerto)!)
        params.allowLocalEndpointReuse = true
        let l = try NWListener(using: params)
        l.newConnectionHandler = { [weak self] c in self?.atender(c) }
        l.stateUpdateHandler = { estado in
            if case .failed(let e) = estado { FileHandle.standardError.write(Data("oficina-dev: \(e)\n".utf8)); exit(1) }
        }
        listener = l
        l.start(queue: cola)
    }

    public func cerrar() { listener?.cancel(); listener = nil }

    // MARK: conexiones (un pedido por conexión, como el servidor MCP)

    private func atender(_ c: NWConnection) {
        c.start(queue: cola)
        let vencimiento = DispatchWorkItem { c.cancel() }
        cola.asyncAfter(deadline: .now() + 120, execute: vencimiento)
        recibir(c, Data(), vencimiento)
    }

    private func recibir(_ c: NWConnection, _ acumulado: Data, _ vencimiento: DispatchWorkItem) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] dato, _, fin, error in
            guard let self else { c.cancel(); return }
            var buf = acumulado
            if let dato { buf.append(dato) }
            switch HTTPMinimo.leer(buf, maxCuerpo: ServidorDev.maxCuerpo) {
            case .incompleto:
                if fin || error != nil { vencimiento.cancel(); c.cancel() } else { self.recibir(c, buf, vencimiento) }
            case .invalido(let st):
                vencimiento.cancel()
                self.responder(c, ServidorDev.json(st, ["error": "pedido inválido"]))
            case .pedido(let p):
                Task {
                    let r = await self.manejar(p)
                    vencimiento.cancel()
                    self.responder(c, r)
                }
            }
        }
    }

    private func responder(_ c: NWConnection, _ d: Data) {
        c.send(content: d, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in c.cancel() })
    }

    // MARK: lógica (sin red: se testea directo)

    static func json(_ status: Int, _ obj: Any) -> Data {
        HTTPMinimo.respuesta(status, tipo: "application/json; charset=utf-8", cabeceras: comunes, cuerpo: Router.codificar(obj))
    }
    static let comunes = ["Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"]

    var hosts: Set<String> { ["localhost:\(puerto)", "127.0.0.1:\(puerto)"] }
    var origenes: Set<String> { Set(hosts.map { "http://" + $0 }) }

    /// Un pedido HTTP completo → la respuesta HTTP.
    func manejar(_ p: HTTPMinimo.Pedido) async -> Data {
        guard hosts.contains((p.cabeceras["host"] ?? "").lowercased()) else { return Self.json(403, ["error": "host no permitido"]) }
        let partes = p.ruta.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let ruta = (partes.first.map(String.init) ?? "/").removingPercentEncoding ?? ""
        let query = Self.query(partes.count > 1 ? String(partes[1]) : "")
        if ruta == "/api" || ruta.hasPrefix("/api/") {
            if p.metodo != "GET" {
                guard let o = p.cabeceras["origin"], origenes.contains(o) else { return Self.json(403, ["error": "origen no permitido"]) }
                let ct = p.cabeceras["content-type"] ?? ""
                if !ct.contains("application/json") && !(p.cuerpo.isEmpty && p.metodo == "DELETE") {
                    return Self.json(415, ["error": "se espera JSON"])
                }
            }
            let (st, js) = await router.handle(method: p.metodo, path: ruta, query: query, body: p.cuerpo.isEmpty ? nil : p.cuerpo)
            return HTTPMinimo.respuesta(st, tipo: "application/json; charset=utf-8", cabeceras: Self.comunes, cuerpo: js)
        }
        guard p.metodo == "GET" || p.metodo == "HEAD" else { return Self.json(405, ["error": "método no permitido"]) }
        guard let f = archivo(ruta), let d = try? Data(contentsOf: f) else { return Self.json(404, ["error": "no"]) }
        return HTTPMinimo.respuesta(200, tipo: Self.mime(f), cabeceras: Self.comunes, cuerpo: p.metodo == "HEAD" ? Data() : d)
    }

    /// Archivo a servir para una ruta, solo de la lista blanca (index, logo, ui/, ldraw/, vendor/). nil = 404.
    func archivo(_ ruta: String) -> URL? {
        var rel = ruta == "/" ? "index.html" : String(ruta.dropFirst())
        guard ruta.hasPrefix("/"), !rel.contains("\0"), !rel.contains("\\"), !rel.split(separator: "/").contains("..") else { return nil }
        let base: URL
        if Self.estaticos.contains(rel) || rel.hasPrefix("ui/") || rel.hasPrefix("ldraw/") { base = raizUI }
        else if rel.hasPrefix("vendor/") { base = raizVendor; rel = String(rel.dropFirst("vendor/".count)) }
        else { return nil }
        // realpath(3) en las dos (resolvingSymlinksInPath quita o no «/private» según exista el archivo)
        guard let f = Self.real(base.appendingPathComponent(rel).path), let b = Self.real(base.path) else { return nil }
        var dir: ObjCBool = false
        guard f.hasPrefix(b + "/"), FileManager.default.fileExists(atPath: f, isDirectory: &dir), !dir.boolValue else { return nil }
        return URL(fileURLWithPath: f)
    }

    static func real(_ p: String) -> String? {
        guard let c = realpath(p, nil) else { return nil }
        defer { free(c) }
        return String(cString: c)
    }

    static func query(_ s: String) -> [String: String] {
        var q: [String: String] = [:]
        for par in s.split(separator: "&") {
            let kv = par.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            func dec(_ x: Substring) -> String { String(x).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String(x) }
            if let k = kv.first { q[dec(k)] = kv.count > 1 ? dec(kv[1]) : "" }
        }
        return q
    }

    static func mime(_ f: URL) -> String {
        switch f.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "mpd", "ldr", "dat", "txt", "md": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
