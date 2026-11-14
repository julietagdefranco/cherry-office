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

    public init() {}

    /// nil = todavía no se detectó.
    public func servidores() -> [ServidorConector]? { lock.lock(); defer { lock.unlock() }; return lista }
    public func detectado() -> Date? { lock.lock(); defer { lock.unlock() }; return cuando }
    public func fijar(_ s: [ServidorConector], en fecha: Date = Date()) {
        lock.lock(); lista = s; cuando = fecha; lock.unlock()
    }
    public func limpiar() { lock.lock(); lista = nil; cuando = nil; lock.unlock() }
}

/// Qué herramientas de conectores ve cada agente (plan §9). Stub: sin permitidas, veda todos los conectores.
enum ConectoresAgente {
    static func herramientas(_ o: Oficina, _ a: AgenteDef, catalogo: [ServidorConector]?,
                             actuar: [String]) -> (permitidas: [String], vedadas: [String]) {
        ([], ["mcp__claude_ai_*"])
    }
}
