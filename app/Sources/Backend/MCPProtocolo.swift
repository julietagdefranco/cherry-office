import Foundation

/// Resultado de una herramienta MCP: texto y si es un error de la herramienta (`isError`).
struct MCPResultado: Sendable, Equatable {
    var texto: String
    var esError: Bool
    static func ok(_ t: String) -> MCPResultado { MCPResultado(texto: t, esError: false) }
    static func error(_ t: String) -> MCPResultado { MCPResultado(texto: t, esError: true) }
}

/// Las herramientas que ofrece el servidor (ya atadas a quien llama).
protocol MCPHerramientas: Sendable {
    /// Definiciones para `tools/list`.
    var definiciones: [[String: Any]] { get }
    /// nil = no existe esa herramienta.
    func llamar(_ nombre: String, argumentos: [String: Any]) async -> MCPResultado?
}

/// JSON-RPC 2.0 de MCP (lógica pura, sin red): `initialize`, `ping`, `tools/list`, `tools/call`.
/// Formato verificado con el claude real en docs/aprendizajes.md (Fase 4).
enum MCPProtocolo {
    /// Versiones del protocolo que sabemos atender, de la más nueva a la más vieja.
    static let versiones = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

    /// Procesa un mensaje JSON-RPC. nil = notificación (o respuesta ajena): el transporte contesta 202 sin cuerpo.
    static func procesar(_ cuerpo: Data, herramientas: MCPHerramientas) async -> Data? {
        guard let crudo = try? JSONSerialization.jsonObject(with: cuerpo) else { return error(nil, -32700, "JSON inválido") }
        guard let m = crudo as? [String: Any] else { return error(nil, -32600, "Pedido inválido") }
        guard let metodo = m["method"] as? String else { return nil }   // respuestas del cliente: se ignoran
        guard let id = m["id"], !(id is NSNull) else { return nil }     // notificación (p. ej. notifications/initialized)
        let params = m["params"] as? [String: Any] ?? [:]
        switch metodo {
        case "initialize":
            let pedida = params["protocolVersion"] as? String ?? ""
            return resultado(id, ["protocolVersion": versiones.contains(pedida) ? pedida : versiones[0],
                                  "capabilities": ["tools": [String: Any]()],
                                  "serverInfo": ["name": "hq", "version": "1"]])
        case "ping":
            return resultado(id, [String: Any]())
        case "tools/list":
            return resultado(id, ["tools": herramientas.definiciones])
        case "tools/call":
            guard let nombre = params["name"] as? String else { return error(id, -32602, "Falta el nombre de la herramienta") }
            let args = params["arguments"] as? [String: Any] ?? [:]
            guard let r = await herramientas.llamar(nombre, argumentos: args) else {
                return error(id, -32602, "Herramienta desconocida: \(nombre)")
            }
            var res: [String: Any] = ["content": [["type": "text", "text": r.texto]]]
            if r.esError { res["isError"] = true }
            return resultado(id, res)
        default:
            return error(id, -32601, "Método no soportado: \(metodo)")
        }
    }

    private static func resultado(_ id: Any, _ r: Any) -> Data {
        codificar(["jsonrpc": "2.0", "id": id, "result": r])
    }

    private static func error(_ id: Any?, _ codigo: Int, _ mensaje: String) -> Data {
        codificar(["jsonrpc": "2.0", "id": id ?? NSNull(), "error": ["code": codigo, "message": mensaje]])
    }

    private static func codificar(_ o: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: o, options: [.withoutEscapingSlashes])) ?? Data("{}".utf8)
    }
}

/// Quién llama: la oficina, el agente y la conversación a la que pertenece el token.
struct IdentidadMCP: Sendable, Equatable {
    var oficina: String
    var agente: String
    var sid: String
}

/// Tokens por corrida: token (32 bytes aleatorios, hex) -> identidad y consultas que le quedan.
/// Se emiten al empezar un chat y se revocan al terminar.
final class MCPTokens: @unchecked Sendable {
    static let consultasPorMensaje = 3
    private struct Entrada { var identidad: IdentidadMCP; var restantes: Int }
    private let lock = NSLock()
    private var tokens: [String: Entrada] = [:]

    func emitir(oficina: String, agente: String, sid: String, consultas: Int = MCPTokens.consultasPorMensaje) -> String {
        var g = SystemRandomNumberGenerator()
        let t = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &g)) }.joined()
        lock.lock(); defer { lock.unlock() }
        tokens[t] = Entrada(identidad: IdentidadMCP(oficina: oficina, agente: agente, sid: sid), restantes: consultas)
        return t
    }

    func revocar(_ token: String) { lock.lock(); tokens[token] = nil; lock.unlock() }

    func identidad(_ token: String) -> IdentidadMCP? { lock.lock(); defer { lock.unlock() }; return tokens[token]?.identidad }

    /// Gasta una consulta del token. false si ya no le quedan (o si el token ya no existe).
    func tomarConsulta(_ token: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard var e = tokens[token], e.restantes > 0 else { return false }
        e.restantes -= 1; tokens[token] = e
        return true
    }

    var activos: Int { lock.lock(); defer { lock.unlock() }; return tokens.count }
}
