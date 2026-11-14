import Foundation

/// Un servidor MCP de claude.ai detectado (plan §9). `herramientas` son los nombres completos (`mcp__claude_ai_...`).
public struct ServidorConector: Sendable, Equatable {
    public var nombre: String
    public var prefijo: String
    public var estado: String
    public var herramientas: [String]
    public var disponible: Bool { estado == "connected" }
    public init(nombre: String, prefijo: String, estado: String, herramientas: [String] = []) {
        self.nombre = nombre; self.prefijo = prefijo; self.estado = estado; self.herramientas = herramientas
    }
}

/// Última detección de conectores, en memoria y compartida por toda la app.
public final class CatalogoConectores: @unchecked Sendable {
    public static let compartido = CatalogoConectores()
    private let lock = NSLock()
    private var lista: [ServidorConector]?
    private var cuando: Date?
    private var enCurso = false
    private var intentado = false

    public init() {}

    /// Hay una detección corriendo ahora.
    public var detectando: Bool { lock.lock(); defer { lock.unlock() }; return enCurso }

    /// Reserva la detección: false si ya hay una corriendo.
    func empezarDeteccion() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if enCurso { return false }
        enCurso = true; intentado = true
        return true
    }

    func terminarDeteccion() { lock.lock(); enCurso = false; lock.unlock() }

    /// true una sola vez, y solo si nunca se detectó: para lanzar la detección perezosa de `GET /api/conectores`.
    func pedirDeteccionInicial() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if lista != nil || enCurso || intentado { return false }
        enCurso = true; intentado = true
        return true
    }

    /// nil = todavía no se detectó.
    public func servidores() -> [ServidorConector]? { lock.lock(); defer { lock.unlock() }; return lista }
    public func detectado() -> Date? { lock.lock(); defer { lock.unlock() }; return cuando }
    public func fijar(_ s: [ServidorConector], en fecha: Date = Date()) {
        lock.lock(); lista = s; cuando = fecha; lock.unlock()
    }
    public func limpiar() { lock.lock(); lista = nil; cuando = nil; enCurso = false; intentado = false; lock.unlock() }
}

/// Detección y clasificación de los conectores de claude.ai (plan §9).
enum Conectores {
    static let prefijoClaudeAi = "mcp__claude_ai_"
    static let timeoutDeteccion: TimeInterval = 90
    private static let prefijosLeer = ["list", "get", "search", "read", "find", "fetch", "download", "query", "lookup", "suggest"]

    /// Nombre de una herramienta sin el servidor: `mcp__claude_ai_Gmail__send_message` -> `send_message`.
    static func corto(_ nombre: String) -> String {
        guard let r = nombre.range(of: "__", options: .backwards) else { return nombre }
        return String(nombre[r.upperBound...])
    }

    /// `leer` si el nombre corto empieza con list, get, search, read, find, fetch, download, query, lookup o suggest
    /// (también en camelCase); `actuar` si no. Ante la duda, actuar.
    static func clasificar(_ corto: String) -> String {
        let c = corto.lowercased()
        return prefijosLeer.contains { c.hasPrefix($0) } ? "leer" : "actuar"
    }

    /// Prefijo de las herramientas de un servidor: `mcp__claude_ai_` + el nombre con lo que no sea letra, número, `_` o `-` cambiado por `_`.
    static func prefijo(de nombre: String) -> String {
        var s = ""
        for u in nombre.unicodeScalars {
            let ok = u.isASCII && ((u.value >= 48 && u.value <= 57) || (u.value >= 65 && u.value <= 90) || (u.value >= 97 && u.value <= 122)
                                   || u == "_" || u == "-")
            s.unicodeScalars.append(ok ? u : "_")
        }
        return prefijoClaudeAi + s
    }

    /// Los servidores de claude.ai del evento `system/init` de una línea de stream-json. nil si la línea no es ese evento.
    static func parsearInit(_ linea: String) -> [ServidorConector]? {
        guard let d = (try? JSONSerialization.jsonObject(with: Data(linea.utf8))) as? [String: Any],
              d["type"] as? String == "system", d["subtype"] as? String == "init" else { return nil }
        let herramientas = (d["tools"] as? [Any])?.compactMap { $0 as? String } ?? []
        var out: [ServidorConector] = []
        for s in (d["mcp_servers"] as? [[String: Any]]) ?? [] where s["source"] as? String == "claudeai" {
            guard var nombre = s["name"] as? String else { continue }
            if nombre.hasPrefix("claude.ai ") { nombre = String(nombre.dropFirst("claude.ai ".count)) }
            nombre = nombre.trimmingCharacters(in: .whitespaces)
            let pref = prefijo(de: nombre)
            let estado = s["status"] as? String ?? "unknown"
            out.append(ServidorConector(nombre: nombre, prefijo: pref, estado: estado,
                                        herramientas: herramientas.filter { $0.hasPrefix(pref + "__") }))
        }
        return out
    }

    /// Arranca un `claude` barato (haiku, sin herramientas propias) solo para leer el `system/init` y guarda el resultado
    /// en el catálogo. Lanza `ClaudeError`; si el init no vino, no toca el catálogo.
    @discardableResult
    static func detectar(_ s: ServiciosHQ, catalogo: CatalogoConectores = .compartido) async throws -> [ServidorConector] {
        let args = ["-p", "--model", "haiku", "--tools", "", "--permission-mode", "dontAsk"] + ClaudeRunner.formatoSalida
            + ["--", "Respondé solo: ok"]
        let res = try await s.runner.lanzar(args: args, timeout: timeoutDeteccion, cwd: nil,
                                            envExtra: ["MCP_CONNECTION_NONBLOCKING": "false"])
        if res.timedOut { throw ClaudeError.timeout }
        var detectados: [ServidorConector]?
        for l in res.stdout.split(whereSeparator: \.isNewline) {
            if let x = parsearInit(String(l)) { detectados = x; break }
        }
        guard let detectados else { throw ClaudeError.claude("No pude leer la lista de conectores de claude.ai.") }
        catalogo.fijar(detectados)
        return detectados
    }
}

/// Qué herramientas de conectores ve cada agente (plan §9).
enum ConectoresAgente {
    static func herramientas(_ o: Oficina, _ a: AgenteDef, catalogo: [ServidorConector]?,
                             actuar: [String]) -> (permitidas: [String], vedadas: [String]) {
        let asignados = a.conectores ?? []
        let actuarAsignadas = Set(asignados.flatMap(\.actuar))
        var permitidas: [String] = []
        for h in asignados.flatMap(\.leer) + actuar.filter({ actuarAsignadas.contains($0) }) where !permitidas.contains(h) {
            permitidas.append(h)
        }
        if permitidas.isEmpty { return ([], ["mcp__claude_ai_*"]) }
        guard let catalogo else { return (permitidas, []) }
        let nombres = Set(asignados.map { normalizar($0.servidor) })
        var vedadas: [String] = []
        for srv in catalogo {
            let asignado = nombres.contains(normalizar(srv.nombre)) || permitidas.contains { $0.hasPrefix(srv.prefijo + "__") }
            if !asignado {
                vedadas.append(srv.prefijo)
            } else {
                for h in srv.herramientas where !permitidas.contains(h) { vedadas.append(h) }
            }
        }
        return (permitidas, vedadas)
    }

    private static func normalizar(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespaces).lowercased()
        if t.hasPrefix("claude.ai ") { t = String(t.dropFirst("claude.ai ".count)) }
        return t
    }
}
