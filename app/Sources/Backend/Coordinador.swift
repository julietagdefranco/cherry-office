import Foundation

/// Rol de coordinador de la oficina (plan §10). Stubs: la ola 2 los completa sin cambiar las firmas.
enum Coordinador {
    static func perfil(_ o: Oficina, _ a: AgenteDef) -> String { "agente" }
    static func herramientasMCP(_ o: Oficina, _ a: AgenteDef) -> [String] { [] }
    static func herramientas(_ s: ServiciosHQ, token: String, identidad: IdentidadMCP) -> MCPHerramientas? { nil }
    static func instalar(_ s: ServiciosHQ) async {}
}
