import Foundation

/// Acciones hacia afuera con aprobación de la persona (plan §8). Stubs: la ola 2 los completa sin cambiar las firmas.
enum Acciones {
    static func herramientasMCP(_ o: Oficina, _ a: AgenteDef) -> [String] { [] }
    static func herramientas(_ s: ServiciosHQ, token: String, identidad: IdentidadMCP) -> MCPHerramientas? { nil }
    static func instalar(_ s: ServiciosHQ) async {}
}
