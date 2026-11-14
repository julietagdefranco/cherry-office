import Foundation

/// El Creador de oficinas (plan §11). Stubs: la ola 2 los completa sin cambiar las firmas.
enum Creador {
    static let idAgente = "creador"
    static let nombresMCP: [String] = []
    static func herramientas(_ s: ServiciosHQ, token: String, identidad: IdentidadMCP) -> MCPHerramientas? { nil }
}

/// Versión del borrador del Creador por oficina: sube con cada cambio y el front la sondea (`/api/actividad`).
final class VersionCreador: @unchecked Sendable {
    static let compartida = VersionCreador()
    private let lock = NSLock()
    private var versiones: [String: Int] = [:]

    init() {}

    func valor(_ oficina: String) -> Int { lock.lock(); defer { lock.unlock() }; return versiones[oficina] ?? 0 }

    @discardableResult
    func subir(_ oficina: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        let n = (versiones[oficina] ?? 0) + 1
        versiones[oficina] = n
        return n
    }
}
