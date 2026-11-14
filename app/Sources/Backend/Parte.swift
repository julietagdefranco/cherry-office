import Foundation

/// Rutas del parte de llegada (plan §10). Stub: la ola 2 lo completa; hoy no atiende nada.
struct ParteRouter: SubRouter {
    let servicios: ServiciosHQ
    init(servicios: ServiciosHQ) { self.servicios = servicios }

    func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)? { nil }
}
