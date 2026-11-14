import Foundation

/// Todo lo que comparten el motor de flujos, el coordinador, las acciones, el Creador y los routers extra.
final class ServiciosHQ: @unchecked Sendable {
    let config: Config
    let store: Store
    let runner: ClaudeRunner
    let oficinas: Oficinas
    let programador: Programador
    let motor: MotorFlujos
    let mcp: MCPServidor?
    let log: HQLog
    let env: [String: String]

    init(config: Config, store: Store, runner: ClaudeRunner, oficinas: Oficinas, programador: Programador, motor: MotorFlujos,
         mcp: MCPServidor?, log: HQLog, env: [String: String]) {
        self.config = config; self.store = store; self.runner = runner; self.oficinas = oficinas
        self.programador = programador; self.motor = motor; self.mcp = mcp; self.log = log; self.env = env
    }
}

/// Lista de herramientas MCP (`mcp__hq__...`) de un agente: las propias de `hq` + las de coordinador + las de acciones.
enum HerramientasMCPAgente {
    static func lista(_ o: Oficina, _ a: AgenteDef) -> [String] {
        var out: [String] = []
        for h in Permisos.herramientasMCP + Coordinador.herramientasMCP(o, a) + Acciones.herramientasMCP(o, a) where !out.contains(h) {
            out.append(h)
        }
        return out
    }
}

/// Junta varios juegos de herramientas: las definiciones se concatenan y llamar devuelve el primer resultado que no sea nil.
struct HerramientasCompuestas: MCPHerramientas {
    let partes: [MCPHerramientas]

    var definiciones: [[String: Any]] { partes.flatMap { $0.definiciones } }

    func llamar(_ nombre: String, argumentos: [String: Any]) async -> MCPResultado? {
        for p in partes { if let r = await p.llamar(nombre, argumentos: argumentos) { return r } }
        return nil
    }
}

/// Sin herramientas (p. ej. un token de perfil creador cuando el Creador todavía no existe).
struct HerramientasVacias: MCPHerramientas {
    var definiciones: [[String: Any]] { [] }
    func llamar(_ nombre: String, argumentos: [String: Any]) async -> MCPResultado? { nil }
}
