import Foundation

/// Importa la oficina de Próspera HQ (5 departamentos y 8 agentes) a `~/Oficinas/Próspera HQ/`.
/// Misma lógica que `tools/importar_prospera.py`. Copia, nunca mueve ni borra los datos originales.
public enum ImportarProspera {
    public static let nombre = "Próspera HQ"
    public static let marca = ".importada-prospera"

    struct AgenteBase {
        var id: String, nombre: String, rol: String, dep: String
        var colorPelo: String, colorTorso: String, colorPiernas: String
        var chips: [String]
    }

    /// Departamentos de `DEPS` en oficina/index.html (la sala de reuniones no es un departamento).
    static let departamentos: [Departamento] = [
        Departamento(id: "dir", nombre: "Dirección", color: "#ee6da6"),
        Departamento(id: "redes", nombre: "Redes y estrategia digital", color: "#a88bd6"),
        Departamento(id: "ads", nombre: "Ads", color: "#f0a35b"),
        Departamento(id: "clases", nombre: "Clases de PRÓSPERAS", color: "#e6c22e"),
        Departamento(id: "video", nombre: "Edición de video", color: "#4aa0dc"),
    ]

    /// Arreglo `AGENTES` de oficina/index.html (mismo orden), con los colores del minifig actual.
    static let agentes: [AgenteBase] = [
        AgenteBase(id: "betty", nombre: "Betty", rol: "PM y directora del equipo", dep: "dir",
                   colorPelo: "#141414", colorTorso: "#c9263a", colorPiernas: "#5a3b2b",
                   chips: ["¿Qué me toca hoy?", "Ordenemos mis pendientes", "¿Cómo viene el lanzamiento?"]),
        AgenteBase(id: "don-armando", nombre: "Don Armando", rol: "Editor de videos de PRÓSPERAS", dep: "video",
                   colorPelo: "#3a2214", colorTorso: "#1d2133", colorPiernas: "#0b0c10",
                   chips: ["¿Qué necesitás para editar una clase?", "¿Cómo es tu flujo de trabajo?"]),
        AgenteBase(id: "mario", nombre: "Mario", rol: "Editor de reels", dep: "video",
                   colorPelo: "#141414", colorTorso: "#5d6b3a", colorPiernas: "#5d6b3a",
                   chips: ["¿Qué necesitás para editar un reel?", "¿Cómo trabajás con Redes?"]),
        AgenteBase(id: "marce", nombre: "Marce", rol: "Directora creativa de redes", dep: "redes",
                   colorPelo: "#0e0e12", colorTorso: "#1a1a1f", colorPiernas: "#0e0b0e",
                   chips: ["¿Qué tendría que publicar esta semana?", "Armemos la estrategia del lanzamiento"]),
        AgenteBase(id: "catalina", nombre: "Doña Catalina", rol: "Social Media Manager", dep: "redes",
                   colorPelo: "#c98a30", colorTorso: "#c9a97a", colorPiernas: "#cdb08a",
                   chips: ["Armame un calendario de publicaciones", "¿Qué piezas están pendientes?"]),
        AgenteBase(id: "patricia", nombre: "Patricia", rol: "Community Manager", dep: "redes",
                   colorPelo: "#dcae52", colorTorso: "#f4f4f6", colorPiernas: "#efefef",
                   chips: ["Redactá una respuesta para una consulta", "¿Qué preguntas se repiten?"]),
        AgenteBase(id: "sofia", nombre: "Doña Sofía", rol: "Creadora de las clases de PRÓSPERAS", dep: "clases",
                   colorPelo: "#b5562a", colorTorso: "#d6342c", colorPiernas: "#1a1a1f",
                   chips: ["¿Qué clases quedan por hacer?", "Proponeme el tema de diciembre"]),
        AgenteBase(id: "nicolas", nombre: "Nicolás Mora", rol: "Ads (Meta Ads)", dep: "ads",
                   colorPelo: "#2b2430", colorTorso: "#1c1c24", colorPiernas: "#6b6a42",
                   chips: ["¿Cómo analizamos los anuncios del taller?", "¿Qué datos necesitás de mí?"]),
    ]

    /// Rutas absolutas de la instalación de Juli -> rutas relativas a la oficina.
    static let reemplazos: [(String, String)] = [
        (#"/Users/[^/\s`]+/Pr(?:ó|o\u0301)spera/_betty/estado-actual\.md"#, "conocimiento/oficina.md"),
        (#"/Users/[^/\s`]+/\.claude/betty/contexto-maestro\.md"#, "conocimiento/contexto-maestro.md"),
        (#"/Users/[^/\s`]+/Pr(?:ó|o\u0301)spera/_equipo/"#, "conocimiento/"),
    ]

    /// Lo que queda de `/Users/<x>/Próspera/...` (Reels, Meta ads, Guiones, intro) apunta a la carpeta real de Próspera.
    static let rutaProyecto = #"/Users/[^/\s`]+/Pr(?:ó|o\u0301)spera(?![\w.-])"#
    /// Agentes que referencian esos archivos: son los que reciben la carpeta vinculada (--add-dir).
    static let agentesProyecto = ["mario", "don-armando", "nicolas", "sofia"]

    /// Rutas del autor -> relativas a la oficina. Con `proyecto` (carpeta real de Próspera), el resto de las rutas absolutas
    /// apunta a esa carpeta (coincide con la carpeta vinculada).
    public static func adaptarRutas(_ texto: String, proyecto: String? = nil) -> String {
        var t = texto
        var lista = reemplazos
        if let proyecto { lista.append((rutaProyecto, proyecto)) }
        for (patron, nuevo) in lista {
            guard let re = try? NSRegularExpression(pattern: patron) else { continue }
            t = re.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t),
                                            withTemplate: NSRegularExpression.escapedTemplate(for: nuevo))
        }
        return t
    }
}

public struct ResultadoImportacion: Sendable {
    public var activa: OficinaActiva
    public var yaExistia: Bool
    public var agentes: [String]
    public var faltantes: [String]
    public var copiados: [String]
}

extension Oficinas {
    /// Carpetas candidatas con los `<id>.md` de los agentes y raíz del repo (con `contexto/`) para el fallback.
    func origenesProspera(origen: String?) throws -> (agentes: [String], repo: String?) {
        let fm = FileManager.default
        if let o = origen?.trimmingCharacters(in: .whitespaces), !o.isEmpty {
            let dir = Config.ruta(o, home: config.home)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue else { throw ErrorAPI(404, "No encuentro la carpeta de origen.") }
            let ag = (dir as NSString).appendingPathComponent("agentes")
            return ([ag, dir], fm.fileExists(atPath: (dir as NSString).appendingPathComponent("contexto")) ? dir : nil)
        }
        var cands: [String] = []
        var repo: String?
        for l in config.legacyDirs {
            let base = (l as NSString).deletingLastPathComponent
            cands.append((base as NSString).appendingPathComponent("agentes"))
            if repo == nil, fm.fileExists(atPath: (base as NSString).appendingPathComponent("contexto")) { repo = base }
        }
        cands.append((config.home as NSString).appendingPathComponent(".claude/agents"))
        return (cands, repo)
    }

    /// Crea la oficina «Próspera HQ» (idempotente: si ya existe no se toca nada) y la deja activa.
    public func importarProspera(origen: String? = nil) throws -> ResultadoImportacion {
        let fm = FileManager.default
        let dir = (config.oficinasDir as NSString).appendingPathComponent(ImportarProspera.nombre)
        if OficinaStore.existe(dir) {
            let o = try OficinaStore.leer(carpeta: dir)
            activar(dir, nombre: o.nombre)
            return ResultadoImportacion(activa: OficinaActiva(carpeta: dir, oficina: o), yaExistia: true,
                                        agentes: o.agentes.map(\.id), faltantes: [], copiados: [])
        }
        let (dirsAgentes, repo) = try origenesProspera(origen: origen)

        // agentes: el primer origen que tenga <id>.md
        var textos: [String: String] = [:]
        var faltantes: [String] = []
        for a in ImportarProspera.agentes {
            var hallado: String?
            for d in dirsAgentes {
                let p = (d as NSString).appendingPathComponent(a.id + ".md")
                if let t = try? String(contentsOfFile: p, encoding: .utf8) { hallado = t; break }
            }
            if let h = hallado { textos[a.id] = h } else { faltantes.append(a.id) }
        }
        guard !textos.isEmpty else {
            throw ErrorAPI(404, "No encontré los agentes de Próspera (agentes/*.md). Indicá la carpeta con «origen».")
        }

        // conocimiento que se copia (nunca se mueve)
        try Plantillas.completarEstructura(carpeta: dir)
        var copiados: [String] = []
        func copiar(_ origenArchivo: String, a rel: String) {
            let destino = (dir as NSString).appendingPathComponent(rel)
            guard fm.fileExists(atPath: origenArchivo), !fm.fileExists(atPath: destino) else { return }
            try? Plantillas.crearDir((destino as NSString).deletingLastPathComponent)
            if (try? fm.copyItem(atPath: origenArchivo, toPath: destino)) != nil { copiados.append(rel) }
        }
        let proyecto = config.proyecto
        copiar((proyecto as NSString).appendingPathComponent("_betty/estado-actual.md"), a: "conocimiento/oficina.md")
        let maestroReal = (config.home as NSString).appendingPathComponent(".claude/betty/contexto-maestro.md")
        copiar(maestroReal, a: "conocimiento/contexto-maestro.md")
        if let repo { copiar((repo as NSString).appendingPathComponent("contexto/contexto-maestro.md"), a: "conocimiento/contexto-maestro.md") }
        let equipo = (proyecto as NSString).appendingPathComponent("_equipo")
        if let en = fm.enumerator(atPath: equipo) {
            for case let rel as String in en {
                let partesRuta = rel.split(separator: "/")
                if partesRuta.contains(where: { $0.hasPrefix(".") }) || rel.hasSuffix("PLANTILLA.md") { continue }
                var isDir: ObjCBool = false
                let src = (equipo as NSString).appendingPathComponent(rel)
                if fm.fileExists(atPath: src, isDirectory: &isDir), !isDir.boolValue { copiar(src, a: "conocimiento/" + rel) }
            }
        }
        if let repo { copiar((repo as NSString).appendingPathComponent("contexto/equipo/decisiones.md"), a: "conocimiento/decisiones.md") }

        // agentes: .md con rutas adaptadas + definición
        var defs: [AgenteDef] = []
        let ahora = Oficinas.ahoraISO()
        // La carpeta de Próspera se vincula solo si existe y no es la carpeta personal entera ni algo de la oficina.
        let proyectoAbs = (proyecto as NSString).standardizingPath
        let realProyecto = URL(fileURLWithPath: proyectoAbs).resolvingSymlinksInPath().path
        let realHome = URL(fileURLWithPath: config.home).resolvingSymlinksInPath().path
        let realOficina = URL(fileURLWithPath: dir).resolvingSymlinksInPath().path
        var esDir: ObjCBool = false
        let proyectoOk = !proyecto.isEmpty && fm.fileExists(atPath: proyectoAbs, isDirectory: &esDir) && esDir.boolValue
            && realProyecto != realHome && realProyecto != "/" && !realProyecto.hasPrefix(realOficina + "/")
        let vinculados = proyectoOk ? ImportarProspera.agentesProyecto.filter { textos[$0] != nil } : []
        for a in ImportarProspera.agentes {
            guard let t = textos[a.id] else { continue }
            let adaptado = ImportarProspera.adaptarRutas(t, proyecto: vinculados.contains(a.id) ? proyectoAbs : nil)
            let md = (dir as NSString).appendingPathComponent(".claude/agents/\(a.id).md")
            do { try Data(adaptado.utf8).write(to: URL(fileURLWithPath: md), options: .atomic) }
            catch { throw ErrorAPI(500, "No pude escribir el agente \(a.id).") }
            let modelo = Plantillas.valorFrontmatter(Plantillas.partes(adaptado).frontmatter, "model")
            defs.append(AgenteDef(
                id: a.id, nombre: a.nombre, rol: a.rol, departamento: a.dep, brief: nil,
                modelo: modelo.flatMap { Validar.modelos.contains($0) ? $0 : nil } ?? "sonnet",
                chips: a.chips,
                avatar: Avatar(semilla: a.id, colorPelo: a.colorPelo, colorTorso: a.colorTorso, colorPiernas: a.colorPiernas),
                creado: ahora,
                escritura: a.id == "betty" ? ["conocimiento/oficina.md", "conocimiento/decisiones.md"] : nil))
        }
        let of = Oficina(nombre: ImportarProspera.nombre, duenio: "Juli", departamentos: ImportarProspera.departamentos, agentes: defs,
                         vinculos: vinculados.isEmpty ? nil : [Vinculo(id: "prospera", ruta: proyectoAbs, alcance: .agentes(vinculados))])
        try Validar.oficina(of)
        try Plantillas.crearEstructura(carpeta: dir, oficina: of)
        for d in defs { try? Plantillas.escribirSiFalta(dir, "conocimiento/agentes/\(d.id).md", Plantillas.notasAgenteMD(nombre: d.nombre, rol: d.rol)) }
        try? Data("{}\n".utf8).write(to: URL(fileURLWithPath: (dir as NSString).appendingPathComponent(ImportarProspera.marca)))
        try OficinaStore.escribir(of, carpeta: dir)
        activar(dir, nombre: of.nombre)
        log.info("Próspera HQ importada agentes=\(defs.count) copiados=\(copiados.count)")
        return ResultadoImportacion(activa: OficinaActiva(carpeta: dir, oficina: of), yaExistia: false,
                                    agentes: defs.map(\.id), faltantes: faltantes, copiados: copiados)
    }
}
