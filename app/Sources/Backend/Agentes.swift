import Foundation

/// Datos para contratar un agente (ya validados).
public struct NuevoAgente: Sendable {
    public var id: String?
    public var nombre: String
    public var rol: String
    public var description: String
    public var prompt: String
    public var departamento: String
    public var chips: [String]
    public var modelo: String
    public var brief: String?
    public var avatar: Avatar?
    var escritura: [String]?
    public var limites: LimitesAgente?
    public var conectores: [ConectorAsignado]?
    public var permisos: [String]?

    /// Valida el JSON del `POST /api/agentes`. Lanza 400 con un mensaje claro.
    static func desde(_ d: [String: Any]) throws -> NuevoAgente {
        let id = try Validar.texto(d["id"], "id", max: 41, obligatorio: false)
        if let id, !Slug.valido(id) { throw ErrorAPI(400, "El id tiene que ser minúsculas, números y guiones (hasta 41 caracteres).") }
        let nombre = try Validar.texto(d["nombre"], "nombre", max: 80)!
        let rol = try Validar.texto(d["rol"], "rol", max: 160)!
        let prompt = try Validar.texto(d["prompt"], "prompt", max: 20_000)!
        let desc = try Validar.texto(d["description"], "description", max: 1000, obligatorio: false) ?? rol
        let dep = try Validar.texto(d["departamento"], "departamento", max: 41)!
        let modelo = try modeloValido(d["modelo"])
        let brief = try Validar.texto(d["brief"], "brief", max: 4000, obligatorio: false)
        return NuevoAgente(id: id, nombre: nombre, rol: rol, description: desc, prompt: prompt, departamento: dep,
                           chips: try chipsValidos(d["chips"]), modelo: modelo, brief: brief,
                           avatar: try avatarValido(d["avatar"]), escritura: nil,
                           limites: try limitesValidos(d["limites"]), conectores: try conectoresValidos(d["conectores"]),
                           permisos: try permisosValidos(d["permisos"]))
    }

    /// `{solo: [...], proponer: [...]}`. nil si la clave no viene (o es null); un objeto sin ítems da `LimitesAgente()` vacío.
    static func limitesValidos(_ v: Any?) throws -> LimitesAgente? {
        guard let v, !(v is NSNull) else { return nil }
        guard let d = v as? [String: Any] else { throw ErrorAPI(400, "«limites» tiene que ser un objeto con «solo» y «proponer».") }
        let l = LimitesAgente(solo: try LecturaAPI.lista(d["solo"], "limites.solo"), proponer: try LecturaAPI.lista(d["proponer"], "limites.proponer"))
        try ValidarAgenteExtra.limites(l)
        return l
    }

    /// `[{servidor, leer: [...], actuar: [...]}]`. nil si la clave no viene; `[]` si viene vacía.
    static func conectoresValidos(_ v: Any?) throws -> [ConectorAsignado]? {
        guard let v, !(v is NSNull) else { return nil }
        guard let a = v as? [Any] else { throw ErrorAPI(400, "«conectores» tiene que ser una lista.") }
        var out: [ConectorAsignado] = []
        for x in a {
            guard let d = x as? [String: Any] else { throw ErrorAPI(400, "Cada conector tiene que ser un objeto con «servidor», «leer» y «actuar».") }
            let s = try Validar.texto(d["servidor"], "servidor", max: ValidarAgenteExtra.maxLargoServidor)!
            out.append(ConectorAsignado(servidor: s, leer: try LecturaAPI.lista(d["leer"], "leer") ?? [],
                                        actuar: try LecturaAPI.lista(d["actuar"], "actuar") ?? []))
        }
        try ValidarAgenteExtra.conectores(out)
        return out
    }

    /// `["coordinador"]`. nil si la clave no viene; `[]` si viene vacía.
    static func permisosValidos(_ v: Any?) throws -> [String]? {
        guard let v, !(v is NSNull) else { return nil }
        guard let p = try LecturaAPI.lista(v, "permisos") else { return nil }
        try ValidarAgenteExtra.permisos(p)
        return p
    }

    static func modeloValido(_ v: Any?) throws -> String {
        guard let v, !(v is NSNull) else { return "sonnet" }
        guard let s = (v as? String)?.trimmingCharacters(in: .whitespaces).lowercased(), Validar.modelos.contains(s) else {
            throw ErrorAPI(400, "Modelo inválido (sonnet, opus, haiku o inherit).")
        }
        return s
    }

    static func chipsValidos(_ v: Any?) throws -> [String] {
        guard let v, !(v is NSNull) else { return [] }
        guard let a = v as? [Any] else { throw ErrorAPI(400, "«chips» tiene que ser una lista de textos.") }
        var out: [String] = []
        for x in a {
            guard let s = x as? String else { throw ErrorAPI(400, "«chips» tiene que ser una lista de textos.") }
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { continue }
            guard t.count <= 200 else { throw ErrorAPI(400, "Un chip es demasiado largo (máximo 200 caracteres).") }
            out.append(t)
        }
        guard out.count <= 6 else { throw ErrorAPI(400, "Máximo 6 chips.") }
        return out
    }

    static func avatarValido(_ v: Any?) throws -> Avatar? {
        guard let v, !(v is NSNull) else { return nil }
        guard let d = v as? [String: Any] else { throw ErrorAPI(400, "«avatar» tiene que ser un objeto.") }
        func s(_ k: String) throws -> String? {
            guard let x = d[k], !(x is NSNull) else { return nil }
            guard let t = x as? String, t.count <= 60 else { throw ErrorAPI(400, "Avatar: «\(k)» inválido.") }
            return t.isEmpty ? nil : t
        }
        var a = Avatar(semilla: try s("semilla"), pelo: try s("pelo"), colorPelo: try s("colorPelo"), cara: try s("cara"),
                       torso: try s("torso"), colorTorso: try s("colorTorso"), colorPiernas: try s("colorPiernas"))
        for c in [a.colorPelo, a.colorTorso, a.colorPiernas] { if let c, !Validar.colorHex(c) { throw ErrorAPI(400, "Avatar: los colores tienen que ser tipo #141414.") } }
        a.colorPelo = a.colorPelo?.lowercased(); a.colorTorso = a.colorTorso?.lowercased(); a.colorPiernas = a.colorPiernas?.lowercased()
        return a
    }
}

/// Borrador propuesto por Claude (no se escribe nada hasta confirmarlo).
public struct BorradorAgente: Sendable, Equatable {
    public var id: String
    public var nombre: String
    public var rol: String
    public var description: String
    public var prompt: String
    public var chips: [String]
    public var modelo: String

    public var json: [String: Any] {
        ["id": id, "nombre": nombre, "rol": rol, "description": description, "prompt": prompt, "chips": chips, "modelo": modelo]
    }
}

public enum Borrador {
    /// Meta-prompt (español) que pide el JSON del agente. No usa agente ni herramientas.
    public static func metaPrompt(oficina: Oficina, departamento: Departamento, descripcion: String) -> String {
        let existentes = oficina.agentes.isEmpty ? "(todavía no hay agentes)" :
            oficina.agentes.map { a in
                let dep = oficina.departamento(a.departamento)?.nombre ?? a.departamento
                return "- \(a.nombre) (id: \(a.id)), \(a.rol), departamento \(dep)"
            }.joined(separator: "\n")
        return """
        Sos un diseñador de equipos que redacta la definición de un agente de Claude Code para una oficina de agentes.

        CONTEXTO
        - Oficina: \(oficina.nombre)\(oficina.duenio.isEmpty ? "" : " (dueño/a: \(oficina.duenio))")
        - Departamento donde va a trabajar el agente nuevo: \(departamento.nombre)
        - Agentes que ya existen (no dupliques sus roles; podés mencionarlos como compañeros si tiene sentido):
        \(existentes)

        LO QUE PIDIÓ EL USUARIO PARA EL AGENTE NUEVO
        \(descripcion)

        TU TAREA
        Inventá a la persona que mejor cumple ese pedido y devolvé SOLO un objeto JSON válido, sin texto antes ni después, sin bloque de código, con exactamente estas claves:
        {
          "id": "slug-en-minusculas",
          "nombre": "Nombre de pila o apodo, corto",
          "rol": "Cargo en pocas palabras, por ejemplo Directora creativa de redes",
          "description": "...",
          "prompt": "...",
          "chips": ["...", "...", "..."],
          "modelo": "sonnet"
        }

        REGLAS DE CADA CLAVE
        - id: solo minúsculas sin acentos, números y guiones, hasta 40 caracteres, derivado del nombre (por ejemplo "marce", "don-armando"). No uses ids genéricos como "agente" o "asistente".
        - nombre: un nombre propio humano y fácil de recordar, o el apodo del cargo si el usuario lo pidió.
        - rol: máximo 8 palabras.
        - description: una o dos oraciones, en tercera persona, al estilo de las descripciones de agentes de Claude Code: quién es y CUÁNDO conviene usarlo ("Usalo cuando haga falta..."). Sin saltos de línea.
        - prompt: las instrucciones del agente, en segunda persona ("Sos ..."), en el mismo idioma en que escribió el usuario (español rioplatense por defecto). Estructura: quién es y para quién trabaja; "Tu trabajo" (qué hace y qué entrega); "Cómo respondés" (formato, extensión, tono); "Reglas" (propone y el usuario aprueba; no inventa datos, cifras ni promesas; si falta información pregunta lo mínimo). Entre 150 y 400 palabras. No incluyas rutas de archivos ni una sección de memoria: el sistema la agrega solo.
        - chips: exactamente 3 frases cortas (máximo 60 caracteres) que el usuario podría escribirle al agente para empezar a trabajar.
        - modelo: "sonnet" salvo que el trabajo exija razonamiento muy profundo ("opus") o sea muy simple y repetitivo ("haiku").

        Devolvé únicamente el JSON.
        """
    }

    /// Extrae y valida el borrador del texto de `result` (JSON puro, dentro de ```json o rodeado de texto).
    public static func parsear(_ texto: String, ocupados: Set<String>) -> BorradorAgente? {
        for cand in candidatos(texto) {
            guard let d = cand.data(using: .utf8),
                  let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { continue }
            func s(_ k: String) -> String { ((o[k] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
            let nombre = s("nombre"), rol = s("rol"), prompt = s("prompt")
            guard !nombre.isEmpty, !rol.isEmpty, !prompt.isEmpty else { continue }
            let pedido = Slug.de(s("id")).isEmpty ? s("nombre") : Slug.de(s("id"))
            let ocup = ocupados.union(Validar.reservados)
            let id = Slug.unico(pedido, usados: ocup, respaldo: "agente")
            var desc = s("description").split(whereSeparator: \.isNewline).joined(separator: " ")
            if desc.isEmpty { desc = "\(nombre), \(rol)." }
            let chips = ((o["chips"] as? [Any]) ?? []).compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty && $0.count <= 200 }
            let m = s("modelo").lowercased()
            return BorradorAgente(id: id, nombre: String(nombre.prefix(80)), rol: String(rol.prefix(160)),
                                  description: String(desc.prefix(1000)), prompt: String(prompt.prefix(20_000)),
                                  chips: Array(chips.prefix(3)), modelo: Validar.modelos.contains(m) ? m : "sonnet")
        }
        return nil
    }

    /// Posibles textos JSON dentro de la respuesta: tal cual, bloques ``` y del primer "{" al último "}".
    static func candidatos(_ texto: String) -> [String] {
        let t = texto.trimmingCharacters(in: .whitespacesAndNewlines)
        var out = [t]
        var resto = Substring(t)
        while let a = resto.range(of: "```") {
            let tras = resto[a.upperBound...]
            guard let b = tras.range(of: "```") else { break }
            var bloque = String(tras[..<b.lowerBound])
            if let nl = bloque.firstIndex(of: "\n"), !bloque[..<nl].contains("{") { bloque = String(bloque[bloque.index(after: nl)...]) }
            out.append(bloque.trimmingCharacters(in: .whitespacesAndNewlines))
            resto = tras[b.upperBound...]
        }
        if let i = t.firstIndex(of: "{"), let j = t.lastIndex(of: "}"), i < j { out.append(String(t[i...j])) }
        return out
    }
}

// MARK: - operaciones sobre agentes de la oficina activa

extension Oficinas {
    static func ahoraISO() -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: Date())
    }

    func rutaMD(_ a: OficinaActiva, _ id: String) -> String { a.ruta(".claude/agents/\(id).md") }

    /// Contrata: escribe `.claude/agents/<id>.md` y `conocimiento/agentes/<id>.md` y actualiza oficina.json.
    public func contratar(_ n: NuevoAgente) throws -> (AgenteDef, OficinaActiva) {
        let a = try requerirActiva()
        let o = a.oficina
        guard o.agentes.count < Oficinas.maxAgentes else { throw ErrorAPI(400, "Máximo \(Oficinas.maxAgentes) agentes por oficina.") }
        guard o.departamento(n.departamento) != nil else { throw ErrorAPI(400, "El departamento no existe.") }
        let usados = Set(o.agentes.map(\.id))
        let id: String
        if let pedido = n.id {
            guard !Validar.reservados.contains(pedido) else { throw ErrorAPI(400, "Ese id está reservado por Claude Code. Elegí otro.") }
            guard !usados.contains(pedido) else { throw ErrorAPI(409, "Ya hay un agente con ese id.") }
            id = pedido
        } else {
            id = Slug.unico(n.nombre, usados: usados.union(Validar.reservados), respaldo: "agente")
        }
        let md = rutaMD(a, id)
        guard !FileManager.default.fileExists(atPath: md) else {
            throw ErrorAPI(409, "Ya existe un archivo de agente con ese id en .claude/agents.")
        }
        var avatar = n.avatar ?? Avatar()
        if avatar.semilla == nil { avatar.semilla = id }
        let def = AgenteDef(id: id, nombre: n.nombre, rol: n.rol, departamento: n.departamento, brief: n.brief,
                            modelo: n.modelo, chips: n.chips.isEmpty ? nil : n.chips, avatar: avatar,
                            creado: Oficinas.ahoraISO(), escritura: n.escritura,
                            limites: (n.limites?.vacio ?? true) ? nil : n.limites,
                            conectores: (n.conectores?.isEmpty ?? true) ? nil : n.conectores,
                            permisos: (n.permisos?.isEmpty ?? true) ? nil : n.permisos)
        let notas = a.ruta("conocimiento/agentes/\(id).md")
        let notasNuevas = !FileManager.default.fileExists(atPath: notas)
        do {
            try Plantillas.crearDir(a.ruta(".claude/agents"))
            try Data(Plantillas.agenteMD(id: id, description: n.description, modelo: n.modelo, prompt: n.prompt).utf8)
                .write(to: URL(fileURLWithPath: md), options: .atomic)
            try Plantillas.escribirSiFalta(a.carpeta, "conocimiento/agentes/\(id).md", Plantillas.notasAgenteMD(nombre: n.nombre, rol: n.rol))
            var nueva = o
            nueva.agentes.append(def)
            try OficinaStore.escribir(nueva, carpeta: a.carpeta)
            log.info("agente contratado id=\(id)")
            return (def, OficinaActiva(carpeta: a.carpeta, oficina: nueva))
        } catch {
            try? FileManager.default.removeItem(atPath: md)
            if notasNuevas { try? FileManager.default.removeItem(atPath: notas) }
            if let e = error as? ErrorAPI { throw e }
            throw ErrorAPI(500, "No pude guardar el agente.")
        }
    }

    public struct CambiosAgente: Sendable {
        public var nombre: String?, rol: String?, departamento: String?, avatar: Avatar?
        public var prompt: String?, description: String?, chips: [String]?, modelo: String?, brief: String?
        /// Si la clave viene, reemplaza; una lista vacía (o límites sin ítems) borra.
        public var limites: LimitesAgente?, conectores: [ConectorAsignado]?, permisos: [String]?
        static func desde(_ d: [String: Any]) throws -> CambiosAgente {
            var c = CambiosAgente()
            c.nombre = try Validar.texto(d["nombre"], "nombre", max: 80, obligatorio: false)
            c.rol = try Validar.texto(d["rol"], "rol", max: 160, obligatorio: false)
            c.departamento = try Validar.texto(d["departamento"], "departamento", max: 41, obligatorio: false)
            c.prompt = try Validar.texto(d["prompt"], "prompt", max: 20_000, obligatorio: false)
            c.description = try Validar.texto(d["description"], "description", max: 1000, obligatorio: false)
            c.brief = try Validar.texto(d["brief"], "brief", max: 4000, obligatorio: false)
            if d["modelo"] != nil, !(d["modelo"] is NSNull) { c.modelo = try NuevoAgente.modeloValido(d["modelo"]) }
            if d["chips"] != nil, !(d["chips"] is NSNull) { c.chips = try NuevoAgente.chipsValidos(d["chips"]) }
            c.avatar = try NuevoAgente.avatarValido(d["avatar"])
            c.limites = try NuevoAgente.limitesValidos(d["limites"])
            c.conectores = try NuevoAgente.conectoresValidos(d["conectores"])
            c.permisos = try NuevoAgente.permisosValidos(d["permisos"])
            return c
        }
    }

    /// Edita un agente: oficina.json y, si cambian prompt, description o modelo, su `.md`.
    public func editarAgente(_ id: String, _ c: CambiosAgente) throws -> (AgenteDef, OficinaActiva) {
        let a = try requerirActiva()
        var o = a.oficina
        guard let i = o.agentes.firstIndex(where: { $0.id == id }) else { throw ErrorAPI(404, "No existe ese agente.") }
        if let d = c.departamento { guard o.departamento(d) != nil else { throw ErrorAPI(400, "El departamento no existe.") }; o.agentes[i].departamento = d }
        if let v = c.nombre { o.agentes[i].nombre = v }
        if let v = c.rol { o.agentes[i].rol = v }
        if let v = c.brief { o.agentes[i].brief = v }
        if let v = c.chips { o.agentes[i].chips = v.isEmpty ? nil : v }
        if let v = c.modelo { o.agentes[i].modelo = v }
        if let v = c.limites { o.agentes[i].limites = v.vacio ? nil : v }
        if let v = c.conectores { o.agentes[i].conectores = v.isEmpty ? nil : v }
        if let v = c.permisos { o.agentes[i].permisos = v.isEmpty ? nil : v }
        if var av = c.avatar {
            if av.semilla == nil { av.semilla = o.agentes[i].avatar?.semilla ?? id }
            o.agentes[i].avatar = av
        }
        // .md: se reescribe solo si cambia algo que vive ahí
        if c.prompt != nil || c.description != nil || c.modelo != nil {
            let md = rutaMD(a, id)
            let actual = (try? String(contentsOfFile: md, encoding: .utf8)) ?? ""
            var p = Plantillas.partes(actual)
            let modelo = c.modelo ?? Plantillas.valorFrontmatter(p.frontmatter, "model") ?? o.agentes[i].modelo ?? "sonnet"
            let desc = c.description ?? Plantillas.valorFrontmatter(p.frontmatter, "description") ?? o.agentes[i].rol
            let texto: String
            if let nuevoPrompt = c.prompt {
                texto = Plantillas.agenteMD(id: id, description: desc, modelo: modelo, prompt: nuevoPrompt)
            } else {
                var fm = p.frontmatter
                if fm.isEmpty { fm = ["name: \(id)"] }
                if let d = c.description { fm = Plantillas.fijarFrontmatter(fm, "description", Plantillas.yamlLinea(d)) }
                if let m = c.modelo { fm = Plantillas.fijarFrontmatter(fm, "model", m) }
                p.frontmatter = fm
                texto = "---\n" + fm.joined(separator: "\n") + "\n---\n" + p.cuerpo
            }
            do {
                try Plantillas.crearDir(a.ruta(".claude/agents"))
                try Data(texto.utf8).write(to: URL(fileURLWithPath: md), options: .atomic)
            } catch { throw ErrorAPI(500, "No pude guardar el archivo del agente.") }
        }
        try OficinaStore.escribir(o, carpeta: a.carpeta)
        return (o.agentes[i], OficinaActiva(carpeta: a.carpeta, oficina: o))
    }

    /// Detalle editable: la definición, `description`, `prompt` (sin la sección de memoria) y `modelo` del `.md`.
    public func detalleAgente(_ id: String) throws -> [String: Any] {
        let a = try requerirActiva()
        guard let def = a.oficina.agente(id) else { throw ErrorAPI(404, "No existe ese agente.") }
        let p = Plantillas.partes((try? String(contentsOfFile: rutaMD(a, id), encoding: .utf8)) ?? "")
        var r: [String: Any] = ["agente": def.json,
                                "prompt": Plantillas.promptDe(cuerpo: p.cuerpo),
                                "description": Plantillas.valorFrontmatter(p.frontmatter, "description") ?? ""]
        if let m = Plantillas.valorFrontmatter(p.frontmatter, "model") { r["modelo"] = m }
        return r
    }

    /// "Despedir": mueve el `.md` a `.claude/agents/.archivados/<id>-<fecha>.md` y lo saca de oficina.json.
    /// `conocimiento/agentes/<id>.md` queda. Devuelve la ruta relativa del archivo archivado (o nil si no había .md).
    public func despedir(_ id: String) throws -> (String?, OficinaActiva) {
        let a = try requerirActiva()
        var o = a.oficina
        guard o.agente(id) != nil else { throw ErrorAPI(404, "No existe ese agente.") }
        let fm = FileManager.default
        let md = rutaMD(a, id)
        var rel: String?
        var destino: String?
        if fm.fileExists(atPath: md) {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyyMMdd-HHmmss"
            let dir = a.ruta(".claude/agents/.archivados")
            var nombre = "\(id)-\(f.string(from: Date()))"
            var n = 2
            while fm.fileExists(atPath: (dir as NSString).appendingPathComponent(nombre + ".md")) { nombre = "\(id)-\(f.string(from: Date()))-\(n)"; n += 1 }
            do {
                try Plantillas.crearDir(dir)
                destino = (dir as NSString).appendingPathComponent(nombre + ".md")
                try fm.moveItem(atPath: md, toPath: destino!)
            } catch { throw ErrorAPI(500, "No pude archivar el agente.") }
            rel = ".claude/agents/.archivados/\(nombre).md"
        }
        o.agentes.removeAll { $0.id == id }
        // sus tareas programadas quedan desactivadas (no se borran)
        if o.tareas != nil { for i in o.tareas!.indices where o.tareas![i].agente == id { o.tareas![i].activa = false } }
        do { try OficinaStore.escribir(o, carpeta: a.carpeta) }
        catch {
            if let d = destino { try? fm.moveItem(atPath: d, toPath: md) }
            throw error
        }
        log.info("agente despedido id=\(id)")
        return (rel, OficinaActiva(carpeta: a.carpeta, oficina: o))
    }

    /// Notas de trabajo del agente (`conocimiento/agentes/<id>.md`); vacío si todavía no existe.
    public func conocimiento(_ id: String) throws -> [String: Any] {
        let a = try requerirActiva()
        guard a.oficina.agente(id) != nil else { throw ErrorAPI(404, "No existe ese agente.") }
        let rel = "conocimiento/agentes/\(id).md"
        let data = FileManager.default.contents(atPath: a.ruta(rel)) ?? Data()
        let texto = String(decoding: data.prefix(200_000), as: UTF8.self)
        return ["id": id, "ruta": rel, "texto": texto]
    }

    /// Prepara el borrador (valida y arma el meta-prompt). No ejecuta nada.
    func prepararBorrador(descripcion: String, departamento: String) throws -> (OficinaActiva, String) {
        let a = try requerirActiva()
        let desc = descripcion.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !desc.isEmpty else { throw ErrorAPI(400, "Contá en palabras qué agente querés.") }
        guard desc.count <= 4000 else { throw ErrorAPI(400, "La descripción es demasiado larga (máximo 4000 caracteres).") }
        guard let dep = a.oficina.departamento(departamento) else { throw ErrorAPI(400, "El departamento no existe.") }
        return (a, Borrador.metaPrompt(oficina: a.oficina, departamento: dep, descripcion: desc))
    }
}
