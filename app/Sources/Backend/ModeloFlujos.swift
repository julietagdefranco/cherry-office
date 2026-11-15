import Foundation

// Modelo de flujos, reglas, límites, conectores y permisos de `oficina.json` (ver docs/plan-creador-flujos.md §1).
// Todas las claves son opcionales: una oficina vieja abre igual.

private func aDiccionario<T: Encodable>(_ v: T) -> [String: Any] {
    guard let d = try? OficinaStore.encoder.encode(v),
          let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [:] }
    return o
}

// MARK: - tipos

/// Un paso de un flujo. `quien` es un id de agente o `"persona"`.
public struct PasoFlujo: Codable, Sendable, Equatable {
    public var id: String
    public var nombre: String
    public var quien: String
    public var consigna: String?
    public var recibe: String?
    /// nil = el paso inmediato anterior. Si viene, ids de pasos ANTERIORES del mismo flujo.
    public var recibeDe: [String]?
    public var entrega: String
    public var aprobacion: Bool
    /// Bloqueo si el paso espera más que esto (días).
    public var plazoDias: Int?
    /// El paso arranca X días después de terminado el anterior.
    public var esperaDias: Int?

    public init(id: String, nombre: String, quien: String, consigna: String? = nil, recibe: String? = nil,
                recibeDe: [String]? = nil, entrega: String, aprobacion: Bool = false, plazoDias: Int? = nil, esperaDias: Int? = nil) {
        self.id = id; self.nombre = nombre; self.quien = quien; self.consigna = consigna; self.recibe = recibe
        self.recibeDe = recibeDe; self.entrega = entrega; self.aprobacion = aprobacion
        self.plazoDias = plazoDias; self.esperaDias = esperaDias
    }

    enum CodingKeys: String, CodingKey { case id, nombre, quien, consigna, recibe, recibeDe, entrega, aprobacion, plazoDias, esperaDias }

    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        nombre = try c.decode(String.self, forKey: .nombre)
        quien = try c.decode(String.self, forKey: .quien)
        consigna = try c.decodeIfPresent(String.self, forKey: .consigna)
        recibe = try c.decodeIfPresent(String.self, forKey: .recibe)
        recibeDe = try c.decodeIfPresent([String].self, forKey: .recibeDe)
        entrega = try c.decode(String.self, forKey: .entrega)
        aprobacion = try c.decodeIfPresent(Bool.self, forKey: .aprobacion) ?? false
        plazoDias = try c.decodeIfPresent(Int.self, forKey: .plazoDias)
        esperaDias = try c.decodeIfPresent(Int.self, forKey: .esperaDias)
    }

    public var json: [String: Any] { aDiccionario(self) }
}

public struct FlujoDef: Codable, Sendable, Equatable {
    public var id: String
    public var nombre: String
    public var descripcion: String?
    public var pasos: [PasoFlujo]
    public var activo: Bool
    public var creado: String?
    public var origen: String?

    public init(id: String, nombre: String, descripcion: String? = nil, pasos: [PasoFlujo], activo: Bool = true,
                creado: String? = nil, origen: String? = nil) {
        self.id = id; self.nombre = nombre; self.descripcion = descripcion; self.pasos = pasos
        self.activo = activo; self.creado = creado; self.origen = origen
    }

    enum CodingKeys: String, CodingKey { case id, nombre, descripcion, pasos, activo, creado, origen }

    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        nombre = try c.decode(String.self, forKey: .nombre)
        descripcion = try c.decodeIfPresent(String.self, forKey: .descripcion)
        pasos = try c.decodeIfPresent([PasoFlujo].self, forKey: .pasos) ?? []
        activo = try c.decodeIfPresent(Bool.self, forKey: .activo) ?? true
        creado = try c.decodeIfPresent(String.self, forKey: .creado)
        origen = try c.decodeIfPresent(String.self, forKey: .origen)
    }

    public var json: [String: Any] { aDiccionario(self) }
}

public struct Regla: Codable, Sendable, Equatable {
    public var id: String
    public var texto: String
    public var origen: String?
    public init(id: String, texto: String, origen: String? = nil) { self.id = id; self.texto = texto; self.origen = origen }
    public var json: [String: Any] { aDiccionario(self) }
}

public struct LimitesAgente: Codable, Sendable, Equatable {
    /// Lo único que el agente hace.
    public var solo: [String]?
    /// Lo que solo puede proponer (lo decide el usuario).
    public var proponer: [String]?
    public init(solo: [String]? = nil, proponer: [String]? = nil) { self.solo = solo; self.proponer = proponer }
    public var json: [String: Any] { aDiccionario(self) }
    /// Sin ningún ítem.
    public var vacio: Bool { (solo ?? []).isEmpty && (proponer ?? []).isEmpty }
}

/// Un servidor MCP asignado a un agente, con nombres completos de herramientas (p. ej. `mcp__claude_ai_Google_Calendar__list_events`).
public struct ConectorAsignado: Codable, Sendable, Equatable {
    public var servidor: String
    public var leer: [String]
    public var actuar: [String]
    public init(servidor: String, leer: [String] = [], actuar: [String] = []) {
        self.servidor = servidor; self.leer = leer; self.actuar = actuar
    }

    enum CodingKeys: String, CodingKey { case servidor, leer, actuar }

    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        servidor = try c.decode(String.self, forKey: .servidor)
        leer = try c.decodeIfPresent([String].self, forKey: .leer) ?? []
        actuar = try c.decodeIfPresent([String].self, forKey: .actuar) ?? []
    }

    public var json: [String: Any] { aDiccionario(self) }
}

public extension AgenteDef {
    /// Tiene el permiso «coordinador».
    var esCoordinador: Bool { permisos?.contains(ValidarAgenteExtra.permisoCoordinador) ?? false }
}

// MARK: - lectura del diccionario de la API

enum LecturaAPI {
    static func texto(_ v: Any?, _ campo: String, max: Int, obligatorio: Bool = false) throws -> String? {
        try Validar.texto(v, campo, max: max, obligatorio: obligatorio)
    }

    static func entero(_ v: Any?, _ campo: String) throws -> Int? {
        guard let v, !(v is NSNull) else { return nil }
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == Double(n.intValue) else {
            throw ErrorAPI(400, "«\(campo)» tiene que ser un número entero.")
        }
        return n.intValue
    }

    static func bool(_ v: Any?, _ campo: String) throws -> Bool? {
        guard let v, !(v is NSNull) else { return nil }
        guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw ErrorAPI(400, "«\(campo)» tiene que ser verdadero o falso.") }
        return n.boolValue
    }

    static func lista(_ v: Any?, _ campo: String) throws -> [String]? {
        guard let v, !(v is NSNull) else { return nil }
        guard let a = v as? [Any] else { throw ErrorAPI(400, "«\(campo)» tiene que ser una lista de textos.") }
        var out: [String] = []
        for x in a {
            guard let s = x as? String else { throw ErrorAPI(400, "«\(campo)» tiene que ser una lista de textos.") }
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { out.append(t) }
        }
        return out
    }
}

extension PasoFlujo {
    /// `numero` (1-based) arma el id por defecto (`p1`, `p2`…); `idsUsados` evita choques con ids explícitos.
    static func desde(_ d: [String: Any], numero: Int, idsUsados: Set<String>) throws -> PasoFlujo {
        let idPedido = try LecturaAPI.texto(d["id"], "id del paso", max: 41)
        if let idPedido, !Slug.valido(idPedido) { throw ErrorAPI(400, "El id del paso «\(idPedido)» tiene que ser minúsculas, números y guiones.") }
        let id = idPedido ?? Slug.unico("p\(numero)", usados: idsUsados, respaldo: "p\(numero)")
        let nombre = try LecturaAPI.texto(d["nombre"], "nombre del paso", max: ValidarFlujos.maxNombre, obligatorio: true)!
        let quien = try LecturaAPI.texto(d["quien"], "quien", max: 41, obligatorio: true)!
        let entrega = try LecturaAPI.texto(d["entrega"], "entrega", max: ValidarFlujos.maxCorto, obligatorio: true)!
        return PasoFlujo(id: id, nombre: nombre, quien: quien,
                         consigna: try LecturaAPI.texto(d["consigna"], "consigna", max: ValidarFlujos.maxConsigna),
                         recibe: try LecturaAPI.texto(d["recibe"], "recibe", max: ValidarFlujos.maxCorto),
                         recibeDe: try LecturaAPI.lista(d["recibeDe"], "recibeDe"),
                         entrega: entrega,
                         aprobacion: try LecturaAPI.bool(d["aprobacion"], "aprobacion") ?? false,
                         plazoDias: try LecturaAPI.entero(d["plazoDias"], "plazoDias"),
                         esperaDias: try LecturaAPI.entero(d["esperaDias"], "esperaDias"))
    }
}

public extension FlujoDef {
    /// Arma y valida un flujo desde el JSON de la API. Sin `id`, lo arma del nombre (único respecto de `idsUsados`).
    static func desde(_ d: [String: Any], idsUsados: Set<String>) throws -> FlujoDef {
        let nombre = try LecturaAPI.texto(d["nombre"], "nombre", max: ValidarFlujos.maxNombre, obligatorio: true)!
        let idPedido = try LecturaAPI.texto(d["id"], "id", max: 41)
        let id: String
        if let idPedido {
            guard Slug.valido(idPedido) else { throw ErrorAPI(400, "El id del flujo tiene que ser minúsculas, números y guiones (hasta 41 caracteres).") }
            guard !idsUsados.contains(idPedido) else { throw ErrorAPI(409, "Ya hay un flujo con ese id.") }
            id = idPedido
        } else {
            id = Slug.unico(Slug.de(nombre), usados: idsUsados, respaldo: "flujo")
        }
        guard let crudos = d["pasos"] as? [Any], !crudos.isEmpty else { throw ErrorAPI(400, "El flujo necesita al menos un paso.") }
        guard crudos.count <= ValidarFlujos.maxPasos else { throw ErrorAPI(400, "Un flujo tiene como máximo \(ValidarFlujos.maxPasos) pasos.") }
        let explicitos = Set(crudos.compactMap { ($0 as? [String: Any])?["id"] as? String })
        var pasos: [PasoFlujo] = []
        for (i, x) in crudos.enumerated() {
            guard let pd = x as? [String: Any] else { throw ErrorAPI(400, "Cada paso del flujo tiene que ser un objeto.") }
            pasos.append(try PasoFlujo.desde(pd, numero: i + 1, idsUsados: explicitos.union(pasos.map(\.id))))
        }
        let f = FlujoDef(id: id, nombre: nombre,
                         descripcion: try LecturaAPI.texto(d["descripcion"], "descripcion", max: ValidarFlujos.maxCorto),
                         pasos: pasos, activo: try LecturaAPI.bool(d["activo"], "activo") ?? true,
                         creado: try LecturaAPI.texto(d["creado"], "creado", max: 40),
                         origen: try LecturaAPI.texto(d["origen"], "origen", max: 600))
        try ValidarFlujos.validar(flujo: f)
        return f
    }
}

public extension Regla {
    static func desde(_ d: [String: Any], idsUsados: Set<String>) throws -> Regla {
        let texto = try LecturaAPI.texto(d["texto"], "texto", max: ValidarReglas.maxTexto, obligatorio: true)!
        let idPedido = try LecturaAPI.texto(d["id"], "id", max: 41)
        let id: String
        if let idPedido {
            guard Slug.valido(idPedido) else { throw ErrorAPI(400, "El id de la regla tiene que ser minúsculas, números y guiones (hasta 41 caracteres).") }
            guard !idsUsados.contains(idPedido) else { throw ErrorAPI(409, "Ya hay una regla con ese id.") }
            id = idPedido
        } else {
            id = Slug.unico(Slug.de(texto), usados: idsUsados, respaldo: "regla")
        }
        return Regla(id: id, texto: texto, origen: try LecturaAPI.texto(d["origen"], "origen", max: ValidarReglas.maxTexto))
    }
}

// MARK: - validación

public enum ValidarFlujos {
    public static let maxFlujos = 30
    public static let maxPasos = 20
    public static let maxNombre = 80
    public static let maxConsigna = 4000
    /// `recibe`, `entrega` y `descripcion`.
    public static let maxCorto = 600

    /// Un flujo suelto: topes, ids slug únicos, `quien` bien formado y `recibeDe` solo hacia pasos anteriores.
    /// Que el agente de un paso no exista NO es error: la oficina tiene que seguir abriendo después de despedir a alguien.
    public static func validar(flujo f: FlujoDef) throws {
        guard Slug.valido(f.id) else { throw ErrorAPI(400, "Flujo con id inválido: \(f.id).") }
        let n = f.nombre.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty, n.count <= maxNombre else { throw ErrorAPI(400, "El flujo \(f.id) necesita un nombre (hasta \(maxNombre) caracteres).") }
        if (f.descripcion?.count ?? 0) > maxCorto { throw ErrorAPI(400, "La descripción del flujo \(f.id) es demasiado larga (máximo \(maxCorto) caracteres).") }
        guard (1...maxPasos).contains(f.pasos.count) else { throw ErrorAPI(400, "El flujo \(f.id) tiene que tener entre 1 y \(maxPasos) pasos.") }
        var anteriores = Set<String>()
        for p in f.pasos {
            let donde = "paso \(p.id) del flujo \(f.id)"
            guard Slug.valido(p.id) else { throw ErrorAPI(400, "Paso con id inválido en el flujo \(f.id): \(p.id).") }
            guard !anteriores.contains(p.id) else { throw ErrorAPI(400, "Paso repetido en el flujo \(f.id): \(p.id).") }
            let pn = p.nombre.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !pn.isEmpty, pn.count <= maxNombre else { throw ErrorAPI(400, "El \(donde) necesita un nombre (hasta \(maxNombre) caracteres).") }
            guard p.quien == "persona" || Slug.valido(p.quien) else { throw ErrorAPI(400, "El \(donde) tiene un «quien» inválido: \(p.quien).") }
            if (p.consigna?.count ?? 0) > maxConsigna { throw ErrorAPI(400, "La consigna del \(donde) es demasiado larga (máximo \(maxConsigna) caracteres).") }
            if (p.recibe?.count ?? 0) > maxCorto { throw ErrorAPI(400, "«recibe» del \(donde) es demasiado largo (máximo \(maxCorto) caracteres).") }
            if p.entrega.count > maxCorto { throw ErrorAPI(400, "«entrega» del \(donde) es demasiado largo (máximo \(maxCorto) caracteres).") }
            if let d = p.plazoDias, !(1...60).contains(d) { throw ErrorAPI(400, "«plazoDias» del \(donde) tiene que estar entre 1 y 60.") }
            if let d = p.esperaDias, !(1...90).contains(d) { throw ErrorAPI(400, "«esperaDias» del \(donde) tiene que estar entre 1 y 90.") }
            for r in p.recibeDe ?? [] where !anteriores.contains(r) {
                throw ErrorAPI(400, "El \(donde) recibe de «\(r)», que no es un paso anterior.")
            }
            anteriores.insert(p.id)
        }
    }

    public static func validar(_ o: Oficina) throws {
        let fs = o.flujos ?? []
        guard fs.count <= maxFlujos else { throw ErrorAPI(400, "Máximo \(maxFlujos) flujos.") }
        var ids = Set<String>()
        for f in fs {
            guard ids.insert(f.id).inserted else { throw ErrorAPI(400, "Flujo repetido: \(f.id).") }
            try validar(flujo: f)
        }
    }
}

public enum ValidarReglas {
    public static let maxReglas = 40
    public static let maxTexto = 600

    public static func validar(_ o: Oficina) throws {
        let rs = o.reglas ?? []
        guard rs.count <= maxReglas else { throw ErrorAPI(400, "Máximo \(maxReglas) reglas.") }
        var ids = Set<String>()
        for r in rs {
            guard Slug.valido(r.id), ids.insert(r.id).inserted else { throw ErrorAPI(400, "Regla con id inválido o repetido: \(r.id).") }
            let t = r.texto.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty, t.count <= maxTexto else { throw ErrorAPI(400, "El texto de la regla \(r.id) tiene que tener entre 1 y \(maxTexto) caracteres.") }
            if (r.origen?.count ?? 0) > maxTexto { throw ErrorAPI(400, "El origen de la regla \(r.id) es demasiado largo.") }
        }
    }
}

/// Validadores de `limites`, `conectores` y `permisos` del agente.
public enum ValidarAgenteExtra {
    public static let permisoCoordinador = "coordinador"
    public static let permisosPermitidos: Set<String> = [permisoCoordinador]
    public static let maxItemsLimites = 12
    public static let maxLargoLimite = 300
    public static let maxServidores = 12
    public static let maxHerramientas = 80
    public static let maxLargoServidor = 80
    public static let maxLargoHerramienta = 200
    public static let maxMision = 600

    public static func limites(_ l: LimitesAgente) throws {
        for (campo, items) in [("solo", l.solo ?? []), ("proponer", l.proponer ?? [])] {
            guard items.count <= maxItemsLimites else { throw ErrorAPI(400, "«limites.\(campo)» admite hasta \(maxItemsLimites) ítems.") }
            for t in items where t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || t.count > maxLargoLimite {
                throw ErrorAPI(400, "Cada ítem de «limites.\(campo)» tiene que tener entre 1 y \(maxLargoLimite) caracteres.")
            }
        }
    }

    public static func conectores(_ cs: [ConectorAsignado]) throws {
        guard cs.count <= maxServidores else { throw ErrorAPI(400, "Máximo \(maxServidores) conectores por agente.") }
        for c in cs {
            let n = c.servidor.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !n.isEmpty, n.count <= maxLargoServidor else {
                throw ErrorAPI(400, "El nombre de un conector tiene que tener entre 1 y \(maxLargoServidor) caracteres.")
            }
            for (campo, hs) in [("leer", c.leer), ("actuar", c.actuar)] {
                guard hs.count <= maxHerramientas else { throw ErrorAPI(400, "«\(c.servidor)»: máximo \(maxHerramientas) herramientas en «\(campo)».") }
                for h in hs {
                    guard h.hasPrefix("mcp__"), !h.hasPrefix("mcp__hq__"), h.count <= maxLargoHerramienta else {
                        throw ErrorAPI(400, "«\(c.servidor)»: «\(h.prefix(60))» no es una herramienta válida (tiene que empezar con mcp__, no con mcp__hq__, y tener hasta \(maxLargoHerramienta) caracteres).")
                    }
                }
            }
        }
    }

    public static func permisos(_ ps: [String]) throws {
        var vistos = Set<String>()
        for p in ps {
            guard permisosPermitidos.contains(p) else { throw ErrorAPI(400, "Permiso inválido: «\(p)» (el único permiso es «coordinador»).") }
            guard vistos.insert(p).inserted else { throw ErrorAPI(400, "Permiso repetido: «\(p)».") }
        }
    }

    public static let maxReglas = 40
    public static let maxLargoRegla = 300

    /// Reglas guardadas con «Siempre»: `Bash(<algo>)`, `Edit(/<ruta absoluta>)` o `Write(/<ruta absoluta>)`, sin saltos de
    /// línea ni caracteres de control. `Bash` solo (sin paréntesis) no vale: sería permitir cualquier comando.
    public static func reglas(_ rs: [String]) throws {
        guard rs.count <= maxReglas else { throw ErrorAPI(400, "Máximo \(maxReglas) permisos guardados por agente.") }
        var vistas = Set<String>()
        for r in rs {
            guard reglaValida(r) else { throw ErrorAPI(400, "Permiso guardado inválido: «\(r.prefix(80))».") }
            guard vistas.insert(r).inserted else { throw ErrorAPI(400, "Permiso guardado repetido: «\(r.prefix(80))».") }
        }
    }

    static func reglaValida(_ r: String) -> Bool {
        guard r.count <= maxLargoRegla, r.hasSuffix(")"),
              !r.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) else { return false }
        for (pref, abs) in [("Bash(", false), ("Edit(", true), ("Write(", true)] where r.hasPrefix(pref) {
            let dentro = r.dropFirst(pref.count).dropLast()
            if dentro.trimmingCharacters(in: .whitespaces).isEmpty { return false }
            if abs && (!dentro.hasPrefix("/") || dentro.contains("..")) { return false }
            return true
        }
        return false
    }

    public static func mision(_ m: String?) throws {
        if (m?.count ?? 0) > maxMision { throw ErrorAPI(400, "La misión es demasiado larga (máximo \(maxMision) caracteres).") }
    }
}
