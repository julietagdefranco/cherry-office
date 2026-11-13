import Foundation

/// Error de la API con su código HTTP y un mensaje en español para el usuario.
public struct ErrorAPI: Error, Sendable, Equatable {
    public var status: Int
    public var mensaje: String
    public init(_ status: Int, _ mensaje: String) { self.status = status; self.mensaje = mensaje }
    public static let sinOficina = ErrorAPI(409, "No hay una oficina abierta")
}

// MARK: - modelo (oficina.json, version 1)

public struct Avatar: Codable, Sendable, Equatable {
    public var semilla: String?
    public var pelo: String?
    public var colorPelo: String?
    public var cara: String?
    public var torso: String?
    public var colorTorso: String?
    public var colorPiernas: String?
    public init(semilla: String? = nil, pelo: String? = nil, colorPelo: String? = nil, cara: String? = nil,
                torso: String? = nil, colorTorso: String? = nil, colorPiernas: String? = nil) {
        self.semilla = semilla; self.pelo = pelo; self.colorPelo = colorPelo; self.cara = cara
        self.torso = torso; self.colorTorso = colorTorso; self.colorPiernas = colorPiernas
    }
}

public struct Departamento: Codable, Sendable, Equatable {
    public var id: String
    public var nombre: String
    public var color: String
    public init(id: String, nombre: String, color: String) { self.id = id; self.nombre = nombre; self.color = color }
}

public struct AgenteDef: Codable, Sendable, Equatable {
    public var id: String
    public var nombre: String
    public var rol: String
    public var departamento: String
    public var brief: String?
    public var modelo: String?
    public var chips: [String]?
    public var avatar: Avatar?
    public var creado: String?
    /// Rutas extra (relativas a la oficina, dentro de `conocimiento/`) donde este agente puede escribir,
    /// además de `conocimiento/agentes/<id>.md`. Solo las pone el importador (p. ej. Betty en Próspera).
    public var escritura: [String]?
    public init(id: String, nombre: String, rol: String, departamento: String, brief: String? = nil,
                modelo: String? = nil, chips: [String]? = nil, avatar: Avatar? = nil, creado: String? = nil,
                escritura: [String]? = nil) {
        self.id = id; self.nombre = nombre; self.rol = rol; self.departamento = departamento; self.brief = brief
        self.modelo = modelo; self.chips = chips; self.avatar = avatar; self.creado = creado; self.escritura = escritura
    }
}

/// Quién puede leer una carpeta vinculada: toda la oficina, ciertos departamentos o ciertos agentes.
public enum AlcanceVinculo: Codable, Sendable, Equatable {
    case oficina
    case departamentos([String])
    case agentes([String])

    public init(from d: Decoder) throws {
        let c = try d.singleValueContainer()
        if let s = try? c.decode(String.self) {
            guard s == "oficina" else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "alcance") }
            self = .oficina
            return
        }
        let o = try c.decode([String: [String]].self)
        if let a = o["departamentos"] { self = .departamentos(a) }
        else if let a = o["agentes"] { self = .agentes(a) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "alcance") }
    }

    public func encode(to e: Encoder) throws {
        var c = e.singleValueContainer()
        switch self {
        case .oficina: try c.encode("oficina")
        case .departamentos(let a): try c.encode(["departamentos": a])
        case .agentes(let a): try c.encode(["agentes": a])
        }
    }

    /// `agente` (de la oficina `o`) tiene acceso a la carpeta.
    public func incluye(_ agente: AgenteDef) -> Bool {
        switch self {
        case .oficina: return true
        case .departamentos(let a): return a.contains(agente.departamento)
        case .agentes(let a): return a.contains(agente.id)
        }
    }

    public var json: Any {
        switch self {
        case .oficina: return "oficina"
        case .departamentos(let a): return ["departamentos": a]
        case .agentes(let a): return ["agentes": a]
        }
    }
}

/// Carpeta externa vinculada a la oficina (no se copia: se lee y se ficha en su lugar).
public struct Vinculo: Codable, Sendable, Equatable {
    public var id: String
    public var ruta: String
    public var alcance: AlcanceVinculo
    public init(id: String, ruta: String, alcance: AlcanceVinculo = .oficina) { self.id = id; self.ruta = ruta; self.alcance = alcance }
}

/// Opciones de la biblioteca en `oficina.json` (`biblioteca`). Todo opcional.
public struct BibliotecaCfg: Codable, Sendable, Equatable {
    /// Leer cada archivo nuevo "por rol" sin que el usuario lo pida (default false).
    public var lecturaAutomatica: Bool?
    /// Tamaño máximo de una subida y de un archivo escaneado, en MB (default 25).
    public var maxMB: Int?
    /// Tope de archivos por carpeta vinculada (default 200) y de bytes totales en MB (default 500).
    public var maxArchivos: Int?
    public var maxTotalMB: Int?
    public init(lecturaAutomatica: Bool? = nil, maxMB: Int? = nil, maxArchivos: Int? = nil, maxTotalMB: Int? = nil) {
        self.lecturaAutomatica = lecturaAutomatica; self.maxMB = maxMB; self.maxArchivos = maxArchivos; self.maxTotalMB = maxTotalMB
    }
}

public struct Oficina: Codable, Sendable, Equatable {
    public var version: Int
    public var nombre: String
    public var duenio: String
    public var departamentos: [Departamento]
    public var agentes: [AgenteDef]
    /// Carpetas vinculadas (opcional; ausente = ninguna).
    public var vinculos: [Vinculo]?
    public var biblioteca: BibliotecaCfg?
    /// Tareas programadas por agente (opcional; ausente = ninguna). Ver Tareas.swift.
    public var tareas: [TareaProgramada]?

    public init(version: Int = 1, nombre: String, duenio: String, departamentos: [Departamento] = [], agentes: [AgenteDef] = [],
                vinculos: [Vinculo]? = nil, biblioteca: BibliotecaCfg? = nil, tareas: [TareaProgramada]? = nil) {
        self.version = version; self.nombre = nombre; self.duenio = duenio
        self.departamentos = departamentos; self.agentes = agentes
        self.vinculos = vinculos; self.biblioteca = biblioteca; self.tareas = tareas
    }

    enum CodingKeys: String, CodingKey { case version, nombre, duenio, departamentos, agentes, vinculos, biblioteca, tareas }

    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        nombre = try c.decode(String.self, forKey: .nombre)
        duenio = try c.decodeIfPresent(String.self, forKey: .duenio) ?? ""
        departamentos = try c.decodeIfPresent([Departamento].self, forKey: .departamentos) ?? []
        agentes = try c.decodeIfPresent([AgenteDef].self, forKey: .agentes) ?? []
        vinculos = try c.decodeIfPresent([Vinculo].self, forKey: .vinculos)
        biblioteca = try c.decodeIfPresent(BibliotecaCfg.self, forKey: .biblioteca)
        tareas = try c.decodeIfPresent([TareaProgramada].self, forKey: .tareas)
    }

    public func agente(_ id: String) -> AgenteDef? { agentes.first { $0.id == id } }
    public func departamento(_ id: String) -> Departamento? { departamentos.first { $0.id == id } }

    /// JSON de la oficina como diccionario (para armar respuestas).
    public var json: [String: Any] {
        guard let d = try? OficinaStore.codificar(self),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [:] }
        return o
    }
}

public extension AgenteDef {
    var json: [String: Any] {
        guard let d = try? OficinaStore.encoder.encode(self),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [:] }
        return o
    }
}

public extension Departamento {
    var json: [String: Any] { ["id": id, "nombre": nombre, "color": color] }
}

// MARK: - slugs y validaciones

public enum Slug {
    /// `^[a-z0-9][a-z0-9-]{0,40}$`
    public static func valido(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard !u.isEmpty, u.count <= 41 else { return false }
        func alnum(_ c: UInt8) -> Bool { (c >= 48 && c <= 57) || (c >= 97 && c <= 122) }
        guard alnum(u[0]) else { return false }
        return u.allSatisfy { alnum($0) || $0 == UInt8(ascii: "-") }
    }

    /// Minúsculas, sin acentos, no alfanuméricos -> "-". Puede dar "" si no queda nada.
    public static func de(_ s: String) -> String {
        let base = s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
        var out = "", guion = false
        for u in base.unicodeScalars {
            if u.isASCII, (u.value >= 48 && u.value <= 57) || (u.value >= 97 && u.value <= 122) {
                out.unicodeScalars.append(u); guion = false
            } else if !guion, !out.isEmpty { out.append("-"); guion = true }
        }
        while out.hasSuffix("-") { out.removeLast() }
        if out.count > 41 { out = String(out.prefix(41)); while out.hasSuffix("-") { out.removeLast() } }
        return out
    }

    /// Slug de `s` que no esté en `usados` (agrega -2, -3...). `respaldo` si `s` no da nada.
    public static func unico(_ s: String, usados: Set<String>, respaldo: String) -> String {
        var base = de(s)
        if base.isEmpty { base = respaldo }
        if !usados.contains(base) { return base }
        var n = 2
        while true {
            let suf = "-\(n)"
            let c = String(base.prefix(41 - suf.count)) + suf
            if !usados.contains(c) { return c }
            n += 1
        }
    }
}

public enum Validar {
    static let reservados: Set<String> = ["general-purpose", "explore", "plan", "statusline-setup", "claude-code-guide", "claude"]

    public static func colorHex(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard u.count == 7, u[0] == UInt8(ascii: "#") else { return false }
        return u.dropFirst().allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 70) || ($0 >= 97 && $0 <= 102) }
    }

    public static let modelos: Set<String> = ["sonnet", "opus", "haiku", "inherit"]

    /// Cadena recortada y no vacía de tamaño razonable, o error 400.
    static func texto(_ v: Any?, _ campo: String, max: Int, obligatorio: Bool = true) throws -> String? {
        guard let v, !(v is NSNull) else {
            if obligatorio { throw ErrorAPI(400, "Falta «\(campo)».") }
            return nil
        }
        guard let s = v as? String else { throw ErrorAPI(400, "«\(campo)» tiene que ser texto.") }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty {
            if obligatorio { throw ErrorAPI(400, "Falta «\(campo)».") }
            return nil
        }
        if t.count > max { throw ErrorAPI(400, "«\(campo)» es demasiado largo (máximo \(max) caracteres).") }
        return t
    }

    /// Oficina completa: slugs, unicidad, departamentos existentes, colores.
    public static func oficina(_ o: Oficina) throws {
        guard o.version == 1 else { throw ErrorAPI(400, "oficina.json: versión no soportada (\(o.version)).") }
        if o.nombre.trimmingCharacters(in: .whitespaces).isEmpty { throw ErrorAPI(400, "oficina.json: falta el nombre.") }
        var deps = Set<String>()
        for d in o.departamentos {
            guard Slug.valido(d.id) else { throw ErrorAPI(400, "Departamento con id inválido: \(d.id).") }
            guard deps.insert(d.id).inserted else { throw ErrorAPI(400, "Departamento repetido: \(d.id).") }
            guard !d.nombre.trimmingCharacters(in: .whitespaces).isEmpty else { throw ErrorAPI(400, "Departamento sin nombre: \(d.id).") }
            guard colorHex(d.color) else { throw ErrorAPI(400, "Color inválido en el departamento \(d.id): \(d.color).") }
        }
        var ids = Set<String>()
        for a in o.agentes {
            guard Slug.valido(a.id) else { throw ErrorAPI(400, "Agente con id inválido: \(a.id).") }
            guard ids.insert(a.id).inserted else { throw ErrorAPI(400, "Agente repetido: \(a.id).") }
            guard deps.contains(a.departamento) else { throw ErrorAPI(400, "El agente \(a.id) está en un departamento que no existe (\(a.departamento)).") }
            for r in a.escritura ?? [] where !rutaEscrituraValida(r) { throw ErrorAPI(400, "Ruta de escritura inválida en \(a.id): \(r).") }
        }
        var vins = Set<String>()
        for v in o.vinculos ?? [] {
            guard Slug.valido(v.id), vins.insert(v.id).inserted else { throw ErrorAPI(400, "Carpeta vinculada con id inválido o repetido: \(v.id).") }
            guard v.ruta.hasPrefix("/") else { throw ErrorAPI(400, "La carpeta vinculada \(v.id) tiene que tener una ruta absoluta.") }
        }
        try ValidarTareas.validar(o)
    }

    /// Relativa, dentro de `conocimiento/`, sin `..`.
    static func rutaEscrituraValida(_ r: String) -> Bool {
        r.hasPrefix("conocimiento/") && !r.contains("..") && !r.contains("\0") && !r.hasSuffix("/")
    }
}

// MARK: - lectura y escritura de oficina.json

public enum OficinaStore {
    public static let archivo = "oficina.json"

    static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return e
    }

    static func codificar(_ o: Oficina) throws -> Data { try encoder.encode(o) }

    public static func ruta(_ carpeta: String) -> String { (carpeta as NSString).appendingPathComponent(archivo) }

    public static func existe(_ carpeta: String) -> Bool { FileManager.default.fileExists(atPath: ruta(carpeta)) }

    public static func leer(carpeta: String) throws -> Oficina {
        guard let data = FileManager.default.contents(atPath: ruta(carpeta)) else {
            throw ErrorAPI(404, "No hay una oficina en esa carpeta (falta oficina.json).")
        }
        let o: Oficina
        do { o = try JSONDecoder().decode(Oficina.self, from: data) }
        catch { throw ErrorAPI(400, "oficina.json no se puede leer: tiene un formato inválido.") }
        try Validar.oficina(o)
        return o
    }

    /// Valida y escribe de forma atómica (archivo temporal en la misma carpeta + rename).
    public static func escribir(_ o: Oficina, carpeta: String) throws {
        try Validar.oficina(o)
        let data = try codificar(o)
        try escribirAtomico(data, en: ruta(carpeta))
    }

    static func escribirAtomico(_ data: Data, en path: String) throws {
        let tmp = path + ".tmp-" + UUID().uuidString.prefix(8)
        do {
            try data.write(to: URL(fileURLWithPath: tmp))
            if rename(tmp, path) != 0 { throw ErrorAPI(500, "No pude guardar el archivo.") }
        } catch {
            try? FileManager.default.removeItem(atPath: tmp)
            if let e = error as? ErrorAPI { throw e }
            throw ErrorAPI(500, "No pude guardar el archivo.")
        }
    }
}

// MARK: - oficina activa

/// Oficina abierta: carpeta absoluta + contenido de oficina.json (leído en el momento).
public struct OficinaActiva: Sendable {
    public let carpeta: String
    public let oficina: Oficina
    /// Ruta absoluta de una ruta relativa a la oficina.
    public func ruta(_ rel: String) -> String { (carpeta as NSString).appendingPathComponent(rel) }
    /// `{carpeta, nombre}` del contrato de /api/estado.
    public var resumen: [String: Any] { ["carpeta": carpeta, "nombre": oficina.nombre] }
}

struct Reciente: Sendable, Equatable { var carpeta: String; var nombre: String; var abierta: Double }

/// Gestiona la oficina activa, los recientes (`config.json` de la app) y todas las escrituras de
/// `oficina.json`. Es un actor: lee-modifica-escribe sin intercalaciones.
public actor Oficinas {
    static let paleta = ["#ee6da6", "#a88bd6", "#f0a35b", "#e6c22e", "#4aa0dc", "#5fbf8a", "#d9684f", "#7f8fa6"]
    static let departamentosSugeridos = ["Dirección", "Comunicación", "Operaciones"]
    static let maxDepartamentos = 12
    static let maxAgentes = 60

    let config: Config
    let log: HQLog
    let estadoPath: String
    private var activaCarpeta: String?
    private var recientes: [Reciente] = []

    public init(config: Config, log: HQLog) {
        self.config = config
        self.log = log
        estadoPath = (config.datosDir as NSString).appendingPathComponent("config.json")
        if let d = FileManager.default.contents(atPath: estadoPath),
           let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
            activaCarpeta = (o["oficina_activa"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            for r in (o["oficinas_recientes"] as? [[String: Any]]) ?? [] {
                if let c = r["carpeta"] as? String, let n = r["nombre"] as? String {
                    recientes.append(Reciente(carpeta: c, nombre: n, abierta: (r["abierta"] as? Double) ?? 0))
                }
            }
        }
    }

    // MARK: consulta

    /// Oficina activa leída del disco, o nil (ninguna abierta, o su carpeta/oficina.json ya no es válida).
    public func activa() -> OficinaActiva? {
        guard let c = activaCarpeta, let o = try? OficinaStore.leer(carpeta: c) else { return nil }
        return OficinaActiva(carpeta: c, oficina: o)
    }

    /// Igual que `activa()` pero lanza 409 «No hay una oficina abierta».
    public func requerirActiva() throws -> OficinaActiva {
        guard let a = activa() else { throw ErrorAPI.sinOficina }
        return a
    }

    /// Recientes cuya carpeta todavía tiene una oficina válida (nombre leído del disco).
    public func listar() -> [[String: Any]] {
        var out: [[String: Any]] = []
        for r in recientes.sorted(by: { $0.abierta > $1.abierta }) {
            guard let o = try? OficinaStore.leer(carpeta: r.carpeta) else { continue }
            out.append(["carpeta": r.carpeta, "nombre": o.nombre, "activa": r.carpeta == activaCarpeta])
        }
        return out
    }

    // MARK: crear y abrir

    public struct DepartamentoNuevo: Sendable { public var id: String?; public var nombre: String; public var color: String? }

    public func crear(nombre: String, duenio: String, carpeta: String? = nil,
                      departamentos: [DepartamentoNuevo]? = nil) throws -> OficinaActiva {
        let n = nombre.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty, n.count <= 80 else { throw ErrorAPI(400, "Poné un nombre para la oficina (hasta 80 caracteres).") }
        let d = duenio.trimmingCharacters(in: .whitespacesAndNewlines)
        guard d.count <= 80 else { throw ErrorAPI(400, "El nombre del dueño es demasiado largo.") }

        var deps: [Departamento] = []
        let pedidos = (departamentos?.isEmpty == false) ? departamentos! :
            Oficinas.departamentosSugeridos.map { DepartamentoNuevo(id: nil, nombre: $0, color: nil) }
        guard pedidos.count <= Oficinas.maxDepartamentos else { throw ErrorAPI(400, "Máximo \(Oficinas.maxDepartamentos) departamentos.") }
        for (i, p) in pedidos.enumerated() {
            deps.append(try Oficinas.armarDepartamento(p, indice: i, usados: Set(deps.map(\.id))))
        }

        let dir: String
        if let carpeta, !carpeta.trimmingCharacters(in: .whitespaces).isEmpty {
            let c = carpeta.trimmingCharacters(in: .whitespaces)
            guard c.hasPrefix("/") || c == "~" || c.hasPrefix("~/") else { throw ErrorAPI(400, "La carpeta tiene que ser una ruta absoluta.") }
            dir = Config.ruta(c, home: config.home)
            if OficinaStore.existe(dir) { throw ErrorAPI(409, "Ya hay una oficina en esa carpeta. Abrila en lugar de crearla.") }
        } else {
            dir = Oficinas.carpetaLibre(base: config.oficinasDir, nombre: n)
        }
        let of = Oficina(nombre: n, duenio: d, departamentos: deps, agentes: [])
        try Validar.oficina(of)
        do { try Plantillas.crearEstructura(carpeta: dir, oficina: of) }
        catch let e as ErrorAPI { throw e }
        catch { throw ErrorAPI(500, "No pude crear la carpeta de la oficina.") }
        try OficinaStore.escribir(of, carpeta: dir)
        activar(dir, nombre: n)
        log.info("oficina creada nombre=\(n.count)c departamentos=\(deps.count)")
        return OficinaActiva(carpeta: dir, oficina: of)
    }

    /// Valida `oficina.json` de la carpeta y la deja activa.
    public func abrir(carpeta: String) throws -> OficinaActiva {
        let c = carpeta.trimmingCharacters(in: .whitespaces)
        guard c.hasPrefix("/") || c == "~" || c.hasPrefix("~/") else { throw ErrorAPI(400, "La carpeta tiene que ser una ruta absoluta.") }
        let dir = Config.ruta(c, home: config.home)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue else {
            throw ErrorAPI(404, "No encuentro esa carpeta.")
        }
        let o = try OficinaStore.leer(carpeta: dir)
        try? Plantillas.completarEstructura(carpeta: dir)
        Plantillas.actualizarMemoria(carpeta: dir, ids: o.agentes.map(\.id))
        activar(dir, nombre: o.nombre)
        return OficinaActiva(carpeta: dir, oficina: o)
    }

    /// Deja `dir` como activa y la sube a recientes (máximo 10). Guarda config.json.
    func activar(_ dir: String, nombre: String) {
        activaCarpeta = dir
        recientes.removeAll { $0.carpeta == dir }
        recientes.insert(Reciente(carpeta: dir, nombre: nombre, abierta: Date().timeIntervalSince1970), at: 0)
        if recientes.count > 10 { recientes = Array(recientes.prefix(10)) }
        guardarEstado()
    }

    private func guardarEstado() {
        var obj: [String: Any] = [:]
        let fm = FileManager.default
        if let d = fm.contents(atPath: estadoPath) {
            guard let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
                log.warn("config.json ilegible: no guardo la oficina activa")
                return
            }
            obj = o
        }
        obj["oficina_activa"] = activaCarpeta ?? NSNull()
        obj["oficinas_recientes"] = recientes.map { ["carpeta": $0.carpeta, "nombre": $0.nombre, "abierta": $0.abierta] as [String: Any] }
        do {
            try fm.createDirectory(atPath: config.datosDir, withIntermediateDirectories: true)
            let d = try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            try OficinaStore.escribirAtomico(d, en: estadoPath)
        } catch { log.error("no pude guardar config.json") }
    }

    static func carpetaLibre(base: String, nombre: String) -> String {
        var limpio = nombre.unicodeScalars.map { u -> Character in
            (u == "/" || u == ":" || u == "\\" || u.value < 32) ? "-" : Character(u)
        }.map(String.init).joined().trimmingCharacters(in: .whitespacesAndNewlines)
        while limpio.hasPrefix(".") { limpio.removeFirst() }
        if limpio.isEmpty { limpio = "Oficina" }
        let fm = FileManager.default
        var cand = (base as NSString).appendingPathComponent(limpio)
        var n = 2
        while fm.fileExists(atPath: cand) {
            cand = (base as NSString).appendingPathComponent("\(limpio) \(n)")
            n += 1
        }
        return cand
    }

    static func armarDepartamento(_ p: DepartamentoNuevo, indice: Int, usados: Set<String>) throws -> Departamento {
        let n = p.nombre.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty, n.count <= 60 else { throw ErrorAPI(400, "El nombre del departamento es obligatorio (hasta 60 caracteres).") }
        let color = p.color ?? paleta[indice % paleta.count]
        guard Validar.colorHex(color) else { throw ErrorAPI(400, "El color tiene que ser tipo #a88bdc.") }
        let id: String
        if let pid = p.id {
            guard Slug.valido(pid) else { throw ErrorAPI(400, "Id de departamento inválido (usá minúsculas, números y guiones).") }
            guard !usados.contains(pid) else { throw ErrorAPI(409, "Ya hay un departamento con ese id.") }
            id = pid
        } else {
            id = Slug.unico(n, usados: usados, respaldo: "depto")
        }
        return Departamento(id: id, nombre: n, color: color.lowercased())
    }

    // MARK: oficina y departamentos

    /// Lee la oficina activa, aplica `cambio` y la escribe (validada, atómica).
    func modificar<T>(_ cambio: (inout Oficina) throws -> T) throws -> (T, OficinaActiva) {
        let a = try requerirActiva()
        var o = a.oficina
        let r = try cambio(&o)
        try OficinaStore.escribir(o, carpeta: a.carpeta)
        if o.nombre != a.oficina.nombre { activar(a.carpeta, nombre: o.nombre) }
        return (r, OficinaActiva(carpeta: a.carpeta, oficina: o))
    }

    public func editar(nombre: String?, duenio: String?) throws -> OficinaActiva {
        let n = try nombre.map { v -> String in
            let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty, t.count <= 80 else { throw ErrorAPI(400, "El nombre de la oficina es obligatorio (hasta 80 caracteres).") }
            return t
        }
        let d = try duenio.map { v -> String in
            let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
            guard t.count <= 80 else { throw ErrorAPI(400, "El nombre del dueño es demasiado largo.") }
            return t
        }
        return try modificar { o in
            if let n { o.nombre = n }
            if let d { o.duenio = d }
        }.1
    }

    public func crearDepartamento(_ p: DepartamentoNuevo) throws -> (Departamento, OficinaActiva) {
        try modificar { o in
            guard o.departamentos.count < Oficinas.maxDepartamentos else { throw ErrorAPI(400, "Máximo \(Oficinas.maxDepartamentos) departamentos.") }
            let d = try Oficinas.armarDepartamento(p, indice: o.departamentos.count, usados: Set(o.departamentos.map(\.id)))
            o.departamentos.append(d)
            return d
        }
    }

    public func editarDepartamento(_ id: String, nombre: String?, color: String?) throws -> (Departamento, OficinaActiva) {
        try modificar { o in
            guard let i = o.departamentos.firstIndex(where: { $0.id == id }) else { throw ErrorAPI(404, "No existe ese departamento.") }
            if let nombre {
                let n = nombre.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !n.isEmpty, n.count <= 60 else { throw ErrorAPI(400, "El nombre del departamento es obligatorio (hasta 60 caracteres).") }
                o.departamentos[i].nombre = n
            }
            if let color {
                guard Validar.colorHex(color) else { throw ErrorAPI(400, "El color tiene que ser tipo #a88bdc.") }
                o.departamentos[i].color = color.lowercased()
            }
            return o.departamentos[i]
        }
    }

    /// Borra el departamento. Con agentes adentro exige `moverA` (otro departamento existente).
    public func borrarDepartamento(_ id: String, moverA: String?) throws -> OficinaActiva {
        try modificar { o in
            guard o.departamentos.contains(where: { $0.id == id }) else { throw ErrorAPI(404, "No existe ese departamento.") }
            guard o.departamentos.count > 1 else { throw ErrorAPI(409, "La oficina necesita al menos un departamento.") }
            let adentro = o.agentes.indices.filter { o.agentes[$0].departamento == id }
            if !adentro.isEmpty {
                guard let m = moverA, !m.isEmpty else {
                    throw ErrorAPI(409, "El departamento tiene \(adentro.count) agente(s). Elegí a qué departamento moverlos (moverA).")
                }
                guard m != id, o.departamentos.contains(where: { $0.id == m }) else {
                    throw ErrorAPI(400, "El departamento de destino (moverA) no existe o es el mismo.")
                }
                for i in adentro { o.agentes[i].departamento = m }
            }
            o.departamentos.removeAll { $0.id == id }
        }.1
    }
}
