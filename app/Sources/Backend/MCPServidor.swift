import Foundation
import Network

/// HTTP/1.1 mínimo para el servidor MCP: un pedido por conexión, `Content-Length`, sin chunked ni keep-alive.
enum HTTPMinimo {
    struct Pedido: Sendable {
        var metodo: String
        var ruta: String
        var cabeceras: [String: String]   // nombres en minúsculas
        var cuerpo: Data
    }
    enum Lectura: Sendable { case incompleto, pedido(Pedido), invalido(Int) }

    static let maxCabeceras = 16 * 1024
    static let maxCuerpo = 1_000_000

    /// Intenta armar un pedido con los bytes recibidos hasta ahora.
    static func leer(_ d: Data) -> Lectura {
        let fin = Data("\r\n\r\n".utf8)
        guard let r = d.range(of: fin) else { return d.count > maxCabeceras ? .invalido(431) : .incompleto }
        if r.lowerBound > maxCabeceras { return .invalido(431) }
        let cab = String(decoding: d[d.startIndex..<r.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let primera = cab[0].split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard primera.count == 3, primera[2].hasPrefix("HTTP/1.") else { return .invalido(400) }
        var h: [String: String] = [:]
        for l in cab.dropFirst() {
            guard let i = l.firstIndex(of: ":") else { return .invalido(400) }
            h[l[..<i].lowercased().trimmingCharacters(in: .whitespaces)] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
        }
        if h["transfer-encoding"] != nil { return .invalido(501) }
        let n = h["content-length"].flatMap { Int($0) } ?? 0
        if n < 0 || (h["content-length"] != nil && Int(h["content-length"]!) == nil) { return .invalido(400) }
        if n > maxCuerpo { return .invalido(413) }
        let ini = r.upperBound
        guard d.endIndex - ini >= n else { return .incompleto }
        return .pedido(Pedido(metodo: primera[0].uppercased(), ruta: primera[1], cabeceras: h, cuerpo: Data(d[ini..<(ini + n)])))
    }

    static func respuesta(_ status: Int, tipo: String? = nil, cabeceras: [String: String] = [:], cuerpo: Data = Data()) -> Data {
        let textos = [200: "OK", 202: "Accepted", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
                      405: "Method Not Allowed", 413: "Payload Too Large", 431: "Request Header Fields Too Large",
                      501: "Not Implemented"]
        var s = "HTTP/1.1 \(status) \(textos[status] ?? "Error")\r\nContent-Length: \(cuerpo.count)\r\nConnection: close\r\n"
        if let tipo { s += "Content-Type: \(tipo)\r\n" }
        for (k, v) in cabeceras { s += "\(k): \(v)\r\n" }
        return Data((s + "\r\n").utf8) + cuerpo
    }
}

/// Servidor MCP de la oficina (Fase 4): HTTP en `127.0.0.1`, puerto efímero, solo `POST /mcp`, respuestas JSON.
/// Lo consumen los `claude` de los chats con `--mcp-config` y un token Bearer por corrida (`MCPTokens`).
public final class MCPServidor: @unchecked Sendable {
    let tokens = MCPTokens()
    let consultas: ConsultasMCP
    private let log: HQLog
    private let cola = DispatchQueue(label: "hq.mcp")
    private let lock = NSLock()
    private var listener: NWListener?
    private var puertoActual: Int?
    private var fallo = false

    /// `timeoutConsulta`: segundos por consulta (120 por defecto; `HQ_CONSULTA_TIMEOUT` en el entorno lo cambia).
    init(store: Store, runner: ClaudeRunner, log: HQLog, timeoutConsulta: TimeInterval? = nil,
         env: [String: String] = ProcessInfo.processInfo.environment) {
        self.log = log
        let t = timeoutConsulta ?? env["HQ_CONSULTA_TIMEOUT"].flatMap(TimeInterval.init) ?? 120
        consultas = ConsultasMCP(store: store, runner: runner, log: log, tokens: tokens, timeout: t)
        arrancar()
    }

    private func arrancar() {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        guard let l = try? NWListener(using: params) else { marcarFallo("no pude crear el listener"); return }
        l.stateUpdateHandler = { [weak self, weak l] estado in
            guard let self else { return }
            switch estado {
            case .ready:
                if let p = l?.port?.rawValue { self.lock.lock(); self.puertoActual = Int(p); self.lock.unlock(); self.log.info("mcp escuchando en 127.0.0.1:\(p)") }
            case .failed(let e): self.marcarFallo("\(e)")
            default: break
            }
        }
        l.newConnectionHandler = { [weak self] c in self?.atender(c) }
        lock.lock(); listener = l; lock.unlock()
        l.start(queue: cola)
    }

    private func marcarFallo(_ m: String) {
        lock.lock(); fallo = true; lock.unlock()
        log.error("mcp: \(m)")
    }

    private func estado() -> (Int?, Bool) { lock.lock(); defer { lock.unlock() }; return (puertoActual, fallo) }

    /// Puerto en el que escucha, esperando a que el listener esté listo (nil si no pudo arrancar).
    func esperarPuerto(hasta segundos: TimeInterval = 3) async -> Int? {
        let limite = Date().addingTimeInterval(segundos)
        while Date() < limite {
            let (p, f) = estado()
            if let p { return p }
            if f { return nil }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return nil
    }

    /// `http://127.0.0.1:PUERTO/mcp`, o nil si el servidor no arrancó (el chat sigue sin consultas).
    func url() async -> String? { await esperarPuerto().map { "http://127.0.0.1:\($0)/mcp" } }

    func cerrar() {
        lock.lock(); let l = listener; listener = nil; puertoActual = nil; fallo = true; lock.unlock()
        l?.cancel()
    }

    // MARK: conexiones

    private func atender(_ c: NWConnection) {
        c.start(queue: cola)
        let vencimiento = DispatchWorkItem { c.cancel() }
        cola.asyncAfter(deadline: .now() + 30, execute: vencimiento)
        recibir(c, Data(), vencimiento)
    }

    private func recibir(_ c: NWConnection, _ acumulado: Data, _ vencimiento: DispatchWorkItem) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] dato, _, fin, error in
            guard let self else { c.cancel(); return }
            var buf = acumulado
            if let dato { buf.append(dato) }
            switch HTTPMinimo.leer(buf) {
            case .incompleto:
                if fin || error != nil { vencimiento.cancel(); c.cancel() } else { self.recibir(c, buf, vencimiento) }
            case .invalido(let st):
                vencimiento.cancel()
                self.responder(c, HTTPMinimo.respuesta(st))
            case .pedido(let p):
                vencimiento.cancel()
                Task {
                    let r = await self.manejar(p)
                    self.responder(c, r)
                }
            }
        }
    }

    private func responder(_ c: NWConnection, _ d: Data) {
        c.send(content: d, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in c.cancel() })
    }

    /// Un pedido HTTP completo -> la respuesta HTTP (lógica sin red, salvo la consulta a `claude`).
    func manejar(_ p: HTTPMinimo.Pedido) async -> Data {
        // contra DNS rebinding: solo se atiende con Host de loopback
        let host = (p.cabeceras["host"] ?? "").lowercased()
        let sinPuerto = host.hasPrefix("[") ? String(host.prefix(while: { $0 != "]" })) + "]" : String(host.split(separator: ":").first ?? "")
        guard ["127.0.0.1", "localhost", "[::1]"].contains(sinPuerto) else { return HTTPMinimo.respuesta(403) }
        let ruta = p.ruta.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        guard ruta == "/mcp" else { return HTTPMinimo.respuesta(404) }
        guard p.metodo == "POST" else { return HTTPMinimo.respuesta(405, cabeceras: ["Allow": "POST"]) }
        // identidad: solo el token Bearer (sin cabecera o con un token revocado, 401)
        let auth = p.cabeceras["authorization"] ?? ""
        let prefijo = "bearer "
        guard auth.lowercased().hasPrefix(prefijo) else { return sinAutorizar() }
        let token = auth.dropFirst(prefijo.count).trimmingCharacters(in: .whitespaces)
        guard let id = tokens.identidad(token) else { return sinAutorizar() }
        let h = consultas.herramientas(token: token, identidad: id)
        guard let r = await MCPProtocolo.procesar(p.cuerpo, herramientas: h) else { return HTTPMinimo.respuesta(202) }
        return HTTPMinimo.respuesta(200, tipo: "application/json", cuerpo: r)
    }

    private func sinAutorizar() -> Data {
        HTTPMinimo.respuesta(401, tipo: "application/json", cabeceras: ["WWW-Authenticate": "Bearer"],
                             cuerpo: Data("{\"error\":\"no autorizado\"}".utf8))
    }
}
