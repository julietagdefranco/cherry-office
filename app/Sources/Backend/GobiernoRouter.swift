import Foundation

/// Rutas de reglas, conectores y acciones (plan §API). Stub: la ola 2 lo completa; hoy no atiende nada.
struct GobiernoRouter: SubRouter {
    let servicios: ServiciosHQ
    init(servicios: ServiciosHQ) { self.servicios = servicios }

    func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)? { nil }
}
