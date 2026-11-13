import Foundation

/// Permisos por agente y construcción del comando exacto de `claude`.
public enum Permisos {
    /// Rutas absolutas donde `agente` puede escribir (comodín "*" + las propias), `{id}` expandido.
    public static func rutasEscritura(_ cfg: Config, agente: String) -> [String] {
        let rel = (cfg.escritura["*"] ?? []) + (cfg.escritura[agente] ?? [])
        var out: [String] = []
        for r in rel {
            let r2 = r.replacingOccurrences(of: "{id}", with: agente)
            let abs = r2.hasPrefix("/") || r2 == "~" || r2.hasPrefix("~/")
            let p = Config.ruta(abs ? r2 : (cfg.proyecto as NSString).appendingPathComponent(r2), home: cfg.home)
            if !out.contains(p) { out.append(p) }
        }
        return out
    }

    /// `Edit(//abs/path)`: la doble barra marca una ruta absoluta para Claude Code.
    public static func regla(_ herramienta: String, ruta: String) -> String {
        var r = Substring(ruta)
        while r.hasPrefix("/") { r = r.dropFirst() }
        return "\(herramienta)(//\(r))"
    }

    /// Lista de `--tools` del agente (base + Edit,Write si tiene rutas de escritura).
    public static func herramientas(_ cfg: Config, agente: String) -> String {
        var h = cfg.herramientasAgente[agente].flatMap { $0.isEmpty ? nil : $0 } ?? cfg.herramientas
        if !rutasEscritura(cfg, agente: agente).isEmpty { h += ",Edit,Write" }
        return h
    }

    /// Argumentos (sin el binario). `--` evita que el mensaje se lea como opción. `flag`: --session-id | --resume.
    public static func argumentos(_ cfg: Config, agente: String, mensaje: String, sid: String, flag: String) -> [String] {
        var a = ["-p", "--agent", agente, flag, sid] + ClaudeRunner.formatoSalida + ["--tools", herramientas(cfg, agente: agente)]
        for d in cfg.dirsExtra { a += ["--add-dir", d] }
        let escribibles = rutasEscritura(cfg, agente: agente)
        if !escribibles.isEmpty {
            a.append("--allowedTools")
            for p in escribibles { for h in ["Edit", "Write"] { a.append(regla(h, ruta: p)) } }
        }
        return a + ["--", mensaje]
    }

    // MARK: oficinas

    /// Dónde corre un agente de oficina y qué puede escribir (rutas absolutas).
    public static func contexto(_ a: OficinaActiva, agente: AgenteDef, dirsExtra: [String] = []) -> ContextoOficina {
        var rutas = [a.ruta("conocimiento/agentes/\(agente.id).md")]
        for r in agente.escritura ?? [] where Validar.rutaEscrituraValida(r) { rutas.append(a.ruta(r)) }
        if let e = entregables(a, agente: agente.id) { rutas.append(e) }
        return ContextoOficina(carpeta: a.carpeta, escritura: rutas, dirsExtra: dirsExtra + dirsVinculos(a.oficina, agente: agente))
    }

    /// Patrón de escritura de `archivos/entregables/<id>/` (todo lo que cuelga de esa carpeta). Crea la carpeta del agente.
    /// Solo existe en oficinas con la estructura de biblioteca (`archivos/entregables/`, que crean `Plantillas.crearEstructura`
    /// y `completarEstructura` al crear o abrir la oficina); en una carpeta sin ella devuelve nil.
    public static func entregables(_ a: OficinaActiva, agente id: String) -> String? {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: a.ruta("archivos/entregables"), isDirectory: &isDir), isDir.boolValue else { return nil }
        let d = a.ruta("archivos/entregables/\(id)")
        try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        return d + "/**"
    }

    /// Carpetas vinculadas a las que `agente` tiene acceso (según el alcance), para `--add-dir`. Solo las que existen.
    public static func dirsVinculos(_ o: Oficina, agente: AgenteDef) -> [String] {
        var out: [String] = []
        for v in o.vinculos ?? [] where v.alcance.incluye(agente) {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: v.ruta, isDirectory: &isDir), isDir.boolValue, !out.contains(v.ruta) { out.append(v.ruta) }
        }
        return out
    }

    /// Herramientas MCP del servidor propio (`hq`, Fase 4): consultar a un colega y ver quiénes son.
    public static let herramientasMCP = ["mcp__hq__consultar", "mcp__hq__colegas"]
    /// Variable de entorno que lleva el token del servidor MCP (así no aparece en los argumentos del proceso).
    public static let variableTokenMCP = "HQ_MCP_TOKEN"

    /// `--mcp-config` (JSON inline) del servidor `hq`: `Authorization: Bearer ${HQ_MCP_TOKEN}`, que claude expande
    /// con el entorno del proceso (confirmado en docs/aprendizajes.md).
    public static func configMCP(url: String) -> String {
        let o: [String: Any] = ["mcpServers": ["hq": ["type": "http", "url": url,
                                                      "headers": ["Authorization": "Bearer ${\(variableTokenMCP)}"]]]]
        let d = (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
        return String(decoding: d, as: UTF8.self)
    }

    /// Herramientas de un agente de oficina: base + Edit,Write (siempre hay una ruta propia) + las MCP si hay servidor.
    public static func herramientas(_ cfg: Config, oficina: ContextoOficina, agente: String) -> String {
        var h = cfg.herramientasAgente[agente].flatMap { $0.isEmpty ? nil : $0 } ?? cfg.herramientas
        if !oficina.escritura.isEmpty { h += ",Edit,Write" }
        if oficina.mcpUrl != nil { h += "," + herramientasMCP.joined(separator: ",") }
        return h
    }

    /// Como `argumentos` pero para un agente de oficina: escritura solo en `oficina.escritura`.
    public static func argumentos(_ cfg: Config, oficina: ContextoOficina, agente: String, mensaje: String,
                                  sid: String, flag: String) -> [String] {
        var a = ["-p", "--agent", agente, flag, sid] + ClaudeRunner.formatoSalida + ["--tools",
                 herramientas(cfg, oficina: oficina, agente: agente)]
        if let url = oficina.mcpUrl { a += ["--mcp-config", configMCP(url: url)] }
        for d in oficina.dirsExtra { a += ["--add-dir", d] }
        if !oficina.escritura.isEmpty || oficina.mcpUrl != nil {
            a.append("--allowedTools")
            for p in oficina.escritura { for h in ["Edit", "Write"] { a.append(regla(h, ruta: p)) } }
            if oficina.mcpUrl != nil { a += herramientasMCP }
        }
        return a + ["--", mensaje]
    }
}

/// Carpeta de trabajo (cwd) y permisos de escritura de un agente dentro de su oficina.
public struct ContextoOficina: Sendable, Equatable {
    public var carpeta: String
    public var escritura: [String]
    public var dirsExtra: [String]
    /// URL del servidor MCP de la oficina (Fase 4); nil = el chat corre sin consultas a colegas.
    public var mcpUrl: String?
    public init(carpeta: String, escritura: [String], dirsExtra: [String] = [], mcpUrl: String? = nil) {
        self.carpeta = carpeta; self.escritura = escritura; self.dirsExtra = dirsExtra; self.mcpUrl = mcpUrl
    }
}
