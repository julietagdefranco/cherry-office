import Foundation

/// Qué está haciendo cada agente ahora mismo (en memoria; no se persiste). Lo alimentan los eventos de
/// stream-json de cada corrida y lo lee el front por `GET /api/actividad`.
/// Clase con lock (no actor) para que los eventos se apliquen en el orden en que llegan del pipe.
public final class ActividadRegistro: @unchecked Sendable {
    public struct Estado: Sendable, Equatable {
        public var estado: String          // pensando | leyendo | escribiendo | buscando | consultando | trabajando
        public var herramienta: String?
        public var objetivo: String?
        public var tarea: String?          // resumen corto del pedido (Haiku) o el pedido recortado
        public var origen: String          // chat | reunion | biblioteca | tarea | consulta
        public var desde: Date
    }

    private let lock = NSLock()
    /// clave (oficina \u{1f} agente) -> corridas en curso (un agente puede tener una consulta mientras chatea).
    private var corridas: [String: [String: Estado]] = [:]
    private var orden: [String: [String]] = [:]
    private(set) var version = 0
    private let reloj: @Sendable () -> Date

    public init(reloj: @escaping @Sendable () -> Date = { Date() }) { self.reloj = reloj }

    static func clave(_ oficina: String, _ agente: String) -> String { oficina + "\u{1f}" + agente }

    /// Estado visible según la herramienta (lógica pura).
    public static func estado(herramienta n: String) -> String {
        switch n {
        case "Read", "Glob", "Grep", "LS", "NotebookRead": return "leyendo"
        case "Edit", "Write", "MultiEdit", "NotebookEdit": return "escribiendo"
        case "WebSearch", "WebFetch": return "buscando"
        default: return n.hasPrefix("mcp__hq__consultar") ? "consultando" : "trabajando"
        }
    }

    /// Recorta un pedido para mostrarlo mientras llega el resumen.
    public static func recortar(_ s: String, max: Int = 48) -> String {
        let t = s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return t.count > max ? String(t.prefix(max - 1)) + "…" : t
    }

    /// Empieza una corrida. Devuelve un token para `terminar`.
    @discardableResult
    public func empezar(oficina: String, agente: String, origen: String, tarea: String? = nil) -> String {
        let token = UUID().uuidString
        let k = Self.clave(oficina, agente)
        lock.lock(); defer { lock.unlock() }
        corridas[k, default: [:]][token] = Estado(estado: "pensando", herramienta: nil, objetivo: nil,
                                                  tarea: tarea.map { Self.recortar($0) }, origen: origen, desde: reloj())
        orden[k, default: []].append(token)
        version += 1
        return token
    }

    public func terminar(oficina: String, agente: String, token: String) {
        let k = Self.clave(oficina, agente)
        lock.lock(); defer { lock.unlock() }
        corridas[k]?[token] = nil
        orden[k]?.removeAll { $0 == token }
        if corridas[k]?.isEmpty ?? false { corridas[k] = nil; orden[k] = nil }
        version += 1
    }

    /// Reemplaza el texto de la tarea (cuando llega el resumen de Haiku).
    public func tarea(oficina: String, agente: String, token: String, texto: String) {
        let k = Self.clave(oficina, agente)
        lock.lock(); defer { lock.unlock() }
        guard corridas[k]?[token] != nil else { return }
        corridas[k]?[token]?.tarea = texto
        version += 1
    }

    public func aplicar(oficina: String, agente: String, token: String, _ e: EventoClaude) {
        let k = Self.clave(oficina, agente)
        lock.lock(); defer { lock.unlock() }
        guard var est = corridas[k]?[token] else { return }
        switch e {
        case .pensando, .texto:
            est.estado = "pensando"; est.herramienta = nil; est.objetivo = nil
        case .herramienta(let n, let obj):
            est.estado = Self.estado(herramienta: n); est.herramienta = n; est.objetivo = obj
        case .inicio, .resultado, .archivo:
            return
        }
        corridas[k]?[token] = est
        version += 1
    }

    /// Observador que alimenta este registro.
    public func observador(oficina: String, agente: String, token: String) -> Observador {
        { [weak self] e in self?.aplicar(oficina: oficina, agente: agente, token: token, e) }
    }

    /// Estado actual de cada agente de una oficina (la corrida más reciente gana).
    public func vista(oficina: String) -> [String: Estado] {
        lock.lock(); defer { lock.unlock() }
        var out: [String: Estado] = [:]
        let pref = oficina + "\u{1f}"
        for (k, tokens) in orden where k.hasPrefix(pref) {
            if let t = tokens.last, let e = corridas[k]?[t] { out[String(k.dropFirst(pref.count))] = e }
        }
        return out
    }

    public func json(oficina: String) -> [String: Any] {
        let ahora = reloj()
        var ags: [String: Any] = [:]
        for (id, e) in vista(oficina: oficina) {
            var d: [String: Any] = ["estado": e.estado, "origen": e.origen, "seg": Int(ahora.timeIntervalSince(e.desde))]
            if let h = e.herramienta { d["herramienta"] = h }
            if let o = e.objetivo { d["objetivo"] = o }
            if let t = e.tarea { d["tarea"] = t }
            ags[id] = d
        }
        lock.lock(); let v = version; lock.unlock()
        return ["agentes": ags, "version": v]
    }

    /// Envuelve una corrida: empieza, pasa el observador (más `extra`), y termina pase lo que pase.
    public func seguir<T: Sendable>(oficina: String, agente: String, origen: String, tarea: String? = nil,
                                    extra: Observador? = nil,
                                    _ body: (@escaping Observador, String) async throws -> T) async rethrows -> T {
        let token = empezar(oficina: oficina, agente: agente, origen: origen, tarea: tarea)
        defer { terminar(oficina: oficina, agente: agente, token: token) }
        let mio = observador(oficina: oficina, agente: agente, token: token)
        let obs: Observador
        if let ex = extra {
            obs = { (e: EventoClaude) in mio(e); ex(e) }
        } else {
            obs = mio
        }
        return try await body(obs, token)
    }
}
