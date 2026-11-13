import Foundation

/// Configuración del backend. Defaults del contrato; `config.json` opcional pisa campos.
/// Las claves del JSON son las de `oficina/config.ejemplo.json` (proyecto, dirs_extra, agentes,
/// herramientas, herramientas_agente, escritura, timeout, claude_bin, datos_dir) más `legacy_dirs`.
public struct Config: Sendable {
    public static let agentesPorDefecto = ["betty", "don-armando", "marce", "catalina", "patricia", "sofia", "mario", "nicolas"]
    public static let herramientasBase = "Read,Glob,Grep,Skill"
    public static let escrituraPorDefecto: [String: [String]] = [
        "*": ["_equipo/agentes/{id}.md"],
        "betty": ["_betty/estado-actual.md", "_equipo/decisiones.md"],
    ]

    public var proyecto: String
    public var dirsExtra: [String]
    public var agentes: [String]
    public var herramientas: String
    public var herramientasAgente: [String: String]
    public var escritura: [String: [String]]
    public var timeout: TimeInterval
    /// Binario de claude forzado (config/tests). CLAUDE_BIN del entorno tiene prioridad en el locator.
    public var claudeBin: String?
    /// Carpeta de datos (hq.db, hq.log, config.json).
    public var datosDir: String
    /// Carpetas candidatas con datos del server Python (`.sesiones.json`, `.datos/hq.db`).
    public var legacyDirs: [String]
    public var home: String
    public var version: String
    /// Carpeta donde se crean las oficinas nuevas (default ~/Oficinas; HQ_OFICINAS_DIR en tests).
    public var oficinasDir: String
    /// `--add-dir` extra para los agentes de una oficina (default ninguno; clave `oficina_dirs_extra`).
    public var oficinaDirsExtra: [String]

    public init(home: String = NSHomeDirectory()) {
        self.home = home
        proyecto = Config.ruta("~/Próspera", home: home)
        dirsExtra = [Config.ruta("~/.claude/betty", home: home)]
        agentes = Config.agentesPorDefecto
        herramientas = Config.herramientasBase
        herramientasAgente = [:]
        escritura = Config.escrituraPorDefecto
        timeout = 600
        claudeBin = nil
        datosDir = (home as NSString).appendingPathComponent("Library/Application Support/Próspera HQ")
        legacyDirs = [(home as NSString).appendingPathComponent("Próspera HQ/oficina")]
        version = "1.0.0"
        oficinasDir = Config.ruta("~/Oficinas", home: home)
        oficinaDirsExtra = []
    }

    // MARK: carga

    /// Defaults + config.json + variables de entorno (HQ_PROYECTO, HQ_DIR_EXTRA, HQ_AGENTES,
    /// HQ_TIMEOUT, HQ_DATA_DIR, HQ_LEGACY_DIR, HQ_CONFIG, HQ_OFICINAS_DIR).
    public static func load(home: String = NSHomeDirectory(),
                            env: [String: String] = ProcessInfo.processInfo.environment) -> Config {
        var c = Config(home: home)
        if let d = env["HQ_DATA_DIR"], !d.isEmpty { c.datosDir = ruta(d, home: home) }
        let path = env["HQ_CONFIG"].flatMap { $0.isEmpty ? nil : ruta($0, home: home) }
            ?? (c.datosDir as NSString).appendingPathComponent("config.json")
        if let data = FileManager.default.contents(atPath: path) {
            c.aplicar(json: data, home: home)
        }
        if let v = env["HQ_PROYECTO"], !v.isEmpty { c.proyecto = ruta(v, home: home) }
        if let v = env["HQ_DIR_EXTRA"] {
            c.dirsExtra = v.split(separator: ":").map { ruta(String($0), home: home) }
        }
        if let v = env["HQ_AGENTES"]?.trimmingCharacters(in: .whitespaces), !v.isEmpty {
            c.agentes = v == "auto" ? descubrirAgentes(home: home)
                : v.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        if let v = env["HQ_OFICINAS_DIR"], !v.isEmpty { c.oficinasDir = ruta(v, home: home) }
        if let v = env["HQ_TIMEOUT"], let t = Double(v), t > 0 { c.timeout = t }
        if let v = env["HQ_DATA_DIR"], !v.isEmpty { c.datosDir = ruta(v, home: home) }
        if let v = env["HQ_LEGACY_DIR"], !v.isEmpty { c.legacyDirs.insert(ruta(v, home: home), at: 0) }
        c.agentes = c.agentes.filter { esIdValido($0) }
        return c
    }

    /// Pisa campos con un JSON (tolerante: claves desconocidas, `_comentarios` y null se ignoran).
    public mutating func aplicar(json data: Data, home: String) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let v = obj["proyecto"] as? String, !v.isEmpty { proyecto = Config.ruta(v, home: home) }
        if let v = obj["dirs_extra"] {
            if let s = v as? String { dirsExtra = [Config.ruta(s, home: home)] }
            else if let a = v as? [String] { dirsExtra = a.map { Config.ruta($0, home: home) } }
        }
        if let v = obj["agentes"] {
            if let s = v as? String, s == "auto" { agentes = Config.descubrirAgentes(home: home) }
            else if let a = v as? [String] { agentes = a.filter { Config.esIdValido($0) } }
        }
        if let v = obj["herramientas"] as? String, !v.isEmpty { herramientas = v }
        if let v = obj["herramientas_agente"] as? [String: String] { herramientasAgente = v }
        if let v = obj["escritura"] as? [String: [String]] { escritura = v }
        if let v = (obj["timeout"] as? NSNumber)?.doubleValue ?? (obj["timeout"] as? String).flatMap(Double.init), v > 0 {
            timeout = v
        }
        if let v = obj["claude_bin"] as? String, !v.isEmpty { claudeBin = Config.ruta(v, home: home) }
        if let v = obj["datos_dir"] as? String, !v.isEmpty { datosDir = Config.ruta(v, home: home) }
        if let v = obj["oficinas_dir"] as? String, !v.isEmpty { oficinasDir = Config.ruta(v, home: home) }
        if let a = obj["oficina_dirs_extra"] as? [String] { oficinaDirsExtra = a.map { Config.ruta($0, home: home) } }
        if let a = obj["legacy_dirs"] as? [String] { legacyDirs = a.map { Config.ruta($0, home: home) } + legacyDirs }
    }

    // MARK: utilidades

    public static func ruta(_ p: String, home: String) -> String {
        var s = p
        if s == "~" { s = home } else if s.hasPrefix("~/") { s = (home as NSString).appendingPathComponent(String(s.dropFirst(2))) }
        if !s.hasPrefix("/") { s = FileManager.default.currentDirectoryPath + "/" + s }
        return URL(fileURLWithPath: s).standardized.path
    }

    public static func esIdValido(_ s: String) -> Bool {
        guard let f = s.unicodeScalars.first, s.count <= 64 else { return false }
        func alnum(_ u: Unicode.Scalar) -> Bool { (u.value < 128) && (CharacterSet.alphanumerics.contains(u)) }
        guard alnum(f) else { return false }
        return s.unicodeScalars.allSatisfy { alnum($0) || $0 == "_" || $0 == "-" }
    }

    /// Ids de ~/.claude/agents/*.md (modo "auto").
    public static func descubrirAgentes(home: String) -> [String] {
        let dir = (home as NSString).appendingPathComponent(".claude/agents")
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        return files.filter { $0.hasSuffix(".md") }.map { String($0.dropLast(3)) }.sorted().filter { esIdValido($0) }
    }
}
