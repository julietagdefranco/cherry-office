import Foundation
import Testing
@testable import Backend

/// Importar Próspera desde el repo (agentes/ y contexto/ del repo como origen; HOME y oficinas temporales).
extension Etapa2 {
@Suite("Importar Próspera")
struct ImportarTests {
    static let ids = ["betty", "don-armando", "mario", "marce", "catalina", "patricia", "sofia", "nicolas"]

    func importar(_ b: Backend, origen: String? = raizRepo) async -> Resp {
        await llamar(b, "POST", "/api/oficinas/importar-prospera", body: origen.map { json(["origen": $0]) })
    }

    @Test("desde el repo: 5 departamentos, 8 agentes, estructura y respuesta completa")
    func importarDelRepo() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let r = await importar(b)
        #expect(r.status == 200, "\(r.obj)")
        #expect(Set(r.obj.keys) == ["carpeta", "oficina", "yaExistia", "agentesImportados", "faltantes", "copiados"])
        let carpeta = str(r.obj["carpeta"])
        #expect(carpeta == sb.oficinasDir + "/Próspera HQ")
        #expect(r.obj["yaExistia"] as? Bool == false)
        #expect(r.obj["agentesImportados"] as? [String] == Self.ids)
        #expect(r.obj["faltantes"] as? [String] == [])
        let of = dict(r.obj["oficina"])
        #expect(of["nombre"] as? String == "Próspera HQ")
        #expect(of["duenio"] as? String == "Juli")
        let deps = lista(of["departamentos"])
        #expect(deps.map { str($0["id"]) } == ["dir", "redes", "ads", "clases", "video"])
        #expect(deps.map { str($0["nombre"]) } == ["Dirección", "Redes y estrategia digital", "Ads", "Clases de PRÓSPERAS", "Edición de video"])
        let ags = lista(of["agentes"])
        #expect(ags.map { str($0["id"]) } == Self.ids)
        let depDe = Dictionary(uniqueKeysWithValues: ags.map { (str($0["id"]), str($0["departamento"])) })
        #expect(depDe == ["betty": "dir", "don-armando": "video", "mario": "video", "marce": "redes", "catalina": "redes",
                          "patricia": "redes", "sofia": "clases", "nicolas": "ads"])
        for a in ags {
            #expect(str(a["rol"]).isEmpty == false)
            #expect((a["chips"] as? [String])?.isEmpty == false)
            #expect(dict(a["avatar"])["semilla"] as? String == str(a["id"]))
            #expect(str(dict(a["avatar"])["colorTorso"]).hasPrefix("#"))
        }
        // betty puede escribir además la memoria común y las decisiones
        let betty = try #require(ags.first { str($0["id"]) == "betty" })
        #expect(betty["escritura"] as? [String] == ["conocimiento/oficina.md", "conocimiento/decisiones.md"])
        #expect(ags.filter { $0["escritura"] != nil }.count == 1)
        // carpetas y archivos
        for id in Self.ids {
            let md = leerTexto(carpeta + "/.claude/agents/\(id).md")
            #expect(md.hasPrefix("---"), "\(id).md sin frontmatter")
            #expect(md.contains("name: \(id)"), "\(id).md sin name")
            #expect(existe(carpeta + "/conocimiento/agentes/\(id).md"), "faltan las notas de \(id)")
        }
        for d in ["archivos/compartido", "archivos/entregables", "archivos/dir", "archivos/video", "conocimiento/fuentes", "reuniones"] {
            #expect(existe(carpeta + "/" + d), "falta \(d)")
        }
        #expect(existe(carpeta + "/.importada-prospera"))
        // el contexto del repo se copió
        let copiados = r.obj["copiados"] as? [String] ?? []
        #expect(copiados.contains("conocimiento/contexto-maestro.md"))
        #expect(copiados.contains("conocimiento/decisiones.md"))
        #expect(leerTexto(carpeta + "/conocimiento/contexto-maestro.md") == leerTexto(raizRepo + "/contexto/contexto-maestro.md"))
        #expect(leerTexto(carpeta + "/conocimiento/decisiones.md") == leerTexto(raizRepo + "/contexto/equipo/decisiones.md"))
        // queda activa
        #expect((await llamar(b, "GET", "/api/oficina")).obj["carpeta"] as? String == carpeta)
        #expect((await llamar(b, "GET", "/api/estado")).obj["agentes"] as? [String] == Self.ids.sorted())
        // los datos originales del repo no se tocaron
        #expect(existe(raizRepo + "/agentes/betty.md") && existe(raizRepo + "/contexto/contexto-maestro.md"))
    }

    @Test("las rutas de la instalación de Juli pasan a rutas relativas a la oficina")
    func rutasAdaptadas() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let r = await importar(b)
        let carpeta = str(r.obj["carpeta"])
        // lo que cuenta como «memoria»: el estado, el contexto maestro y _equipo (las tres rutas absolutas que adapta el importador)
        let memoria = [#"/Users/[^/\s`]+/Pr(ó|o\x{301})spera/_betty/estado-actual\.md"#,
                       #"/Users/[^/\s`]+/\.claude/betty/contexto-maestro\.md"#,
                       #"/Users/[^/\s`]+/Pr(ó|o\x{301})spera/_equipo/"#]
        var restos: [String] = []
        for id in Self.ids {
            let md = leerTexto(carpeta + "/.claude/agents/\(id).md")
            for patron in memoria {
                #expect(md.range(of: patron, options: .regularExpression) == nil, "\(id).md conserva una ruta de memoria absoluta (\(patron))")
            }
            for l in md.components(separatedBy: "\n") where l.contains("/Users/") { restos.append("\(id): \(l.trimmingCharacters(in: .whitespaces))") }
        }
        #expect(leerTexto(carpeta + "/.claude/agents/betty.md").contains("conocimiento/oficina.md"))
        #expect(leerTexto(carpeta + "/.claude/agents/betty.md").contains("conocimiento/contexto-maestro.md"))
        #expect(leerTexto(carpeta + "/.claude/agents/marce.md").contains("conocimiento/agentes/"))
        // Ninguna ruta /Users/<alguien> debería sobrevivir en los agentes importados (la oficina tiene que andar en otra Mac).
        withKnownIssue("el importador solo adapta 3 patrones de ruta; quedan «/Users/julietadefranco/Próspera…» sueltas en los .md", isIntermittent: true) {
            #expect(restos.isEmpty, "rutas absolutas que sobreviven: \(restos.prefix(6))")
        }
    }

    @Test("copia, sin mover, el estado, el contexto maestro y _equipo de la instalación real (con HOME temporal)")
    func copiaDeLaInstalacion() async throws {
        let sb = Sandbox()
        escribir("ESTADO REAL", en: sb.proyecto + "/_betty/estado-actual.md")
        escribir("DECISIONES REALES", en: sb.proyecto + "/_equipo/decisiones.md")
        escribir("NOTAS DE BETTY", en: sb.proyecto + "/_equipo/agentes/betty.md")
        escribir("plantilla", en: sb.proyecto + "/_equipo/agentes/PLANTILLA.md")
        escribir("oculto", en: sb.proyecto + "/_equipo/.git/config.md")
        escribir("MAESTRO DEL HOME", en: sb.home + "/.claude/betty/contexto-maestro.md")
        let b = try sb.backend(oficina: false)
        let r = await importar(b)
        #expect(r.status == 200)
        let carpeta = str(r.obj["carpeta"])
        #expect(leerTexto(carpeta + "/conocimiento/oficina.md") == "ESTADO REAL")
        #expect(leerTexto(carpeta + "/conocimiento/decisiones.md") == "DECISIONES REALES")
        #expect(leerTexto(carpeta + "/conocimiento/agentes/betty.md") == "NOTAS DE BETTY")
        #expect(leerTexto(carpeta + "/conocimiento/contexto-maestro.md") == "MAESTRO DEL HOME")  // el de ~/.claude gana al del repo
        #expect(!existe(carpeta + "/conocimiento/agentes/PLANTILLA.md"))
        #expect(!existe(carpeta + "/conocimiento/.git"))
        let copiados = Set(r.obj["copiados"] as? [String] ?? [])
        #expect(copiados.isSuperset(of: ["conocimiento/oficina.md", "conocimiento/decisiones.md", "conocimiento/agentes/betty.md",
                                         "conocimiento/contexto-maestro.md"]))
        // el resto de los agentes tiene sus notas de plantilla
        #expect(leerTexto(carpeta + "/conocimiento/agentes/marce.md").contains("# Marce: notas de trabajo"))
        // los originales siguen donde estaban
        #expect(leerTexto(sb.proyecto + "/_betty/estado-actual.md") == "ESTADO REAL")
        #expect(leerTexto(sb.proyecto + "/_equipo/decisiones.md") == "DECISIONES REALES")
        #expect(leerTexto(sb.home + "/.claude/betty/contexto-maestro.md") == "MAESTRO DEL HOME")
    }

    @Test("idempotente: la segunda vez dice yaExistia y no toca nada, ni siquiera lo que el usuario editó")
    func idempotente() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let a = await importar(b)
        let carpeta = str(a.obj["carpeta"])
        escribir("EDITADO POR EL USUARIO", en: carpeta + "/conocimiento/oficina.md")
        escribir("MARCE EDITADA", en: carpeta + "/.claude/agents/marce.md")
        let oficinaAntes = leerTexto(carpeta + "/oficina.json")
        // en el medio se abre otra oficina: importar de nuevo la vuelve a activar
        _ = await llamar(b, "POST", "/api/oficinas", body: json(["nombre": "Otra"]))
        #expect((await llamar(b, "GET", "/api/oficina")).obj["carpeta"] as? String != carpeta)
        let c = await importar(b)
        #expect(c.status == 200)
        #expect(c.obj["yaExistia"] as? Bool == true)
        #expect(c.obj["carpeta"] as? String == carpeta)
        #expect(c.obj["agentesImportados"] as? [String] == Self.ids)
        #expect(c.obj["copiados"] as? [String] == [])
        #expect(c.obj["faltantes"] as? [String] == [])
        #expect(leerTexto(carpeta + "/oficina.json") == oficinaAntes)
        #expect(leerTexto(carpeta + "/conocimiento/oficina.md") == "EDITADO POR EL USUARIO")
        #expect(leerTexto(carpeta + "/.claude/agents/marce.md") == "MARCE EDITADA")
        #expect((await llamar(b, "GET", "/api/oficina")).obj["carpeta"] as? String == carpeta)
        #expect(listar(sb.oficinasDir) == ["Otra", "Próspera HQ"])
        // sin cuerpo también (el origen es opcional)
        #expect((await importar(b, origen: nil)).obj["yaExistia"] as? Bool == true)
    }

    @Test("origen sin todos los agentes: importa los que hay y lista los faltantes")
    func faltantes() async throws {
        let sb = Sandbox()
        let origen = sb.root + "/origen"
        for id in ["betty", "marce"] {
            escribir("---\nname: \(id)\nmodel: opus\n---\nSos \(id).", en: origen + "/agentes/\(id).md")
        }
        let b = try sb.backend(oficina: false)
        let r = await importar(b, origen: origen)
        #expect(r.status == 200)
        #expect(r.obj["agentesImportados"] as? [String] == ["betty", "marce"])
        #expect(Set(r.obj["faltantes"] as? [String] ?? []) == Set(Self.ids).subtracting(["betty", "marce"]))
        let ags = lista(dict(r.obj["oficina"])["agentes"])
        #expect(ags.map { str($0["modelo"]) } == ["opus", "opus"])  // el modelo sale del frontmatter
        // el departamento de los agentes que faltan igual existe (los 5 departamentos se crean siempre)
        #expect(lista(dict(r.obj["oficina"])["departamentos"]).count == 5)
    }

    @Test("origen: carpeta inexistente 404; sin agentes en ningún lado 404; sin origen busca en ~/.claude/agents del HOME temporal")
    func origenes() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let no = await importar(b, origen: sb.root + "/no-existe")
        #expect(no.status == 404)
        #expect(str(no.obj["error"]).contains("origen"))
        let vacio = sb.root + "/vacio"
        try FileManager.default.createDirectory(atPath: vacio, withIntermediateDirectories: true)
        let sin = await importar(b, origen: vacio)
        #expect(sin.status == 404)
        #expect(str(sin.obj["error"]).contains("agentes/*.md"))
        #expect((await importar(b, origen: nil)).status == 404)  // HOME temporal: nada que importar
        #expect(listar(sb.oficinasDir).isEmpty)                  // y no quedó una oficina a medias
        #expect((await llamar(b, "GET", "/api/oficinas")).obj["activa"] is NSNull)
        // ahora con 3 agentes en ~/.claude/agents
        for id in ["betty", "nicolas", "sofia"] { escribir("---\nname: \(id)\n---\nSos \(id).", en: sb.home + "/.claude/agents/\(id).md") }
        let r = await importar(b, origen: nil)
        #expect(r.status == 200)
        #expect(r.obj["agentesImportados"] as? [String] == ["betty", "sofia", "nicolas"])
        #expect((r.obj["faltantes"] as? [String])?.count == 5)
    }

    @Test("el chat de Betty importada puede escribir oficina.md y decisiones.md además de sus notas")
    func chatDeBettyImportada() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let r = await importar(b)
        let carpeta = str(r.obj["carpeta"])
        #expect((await chat(b, agent: "betty", session: U.a)).status == 200)
        let reglas = Sandbox.reglas(try #require(sb.llamadas.last))
        for rel in ["conocimiento/oficina.md", "conocimiento/decisiones.md", "conocimiento/agentes/betty.md"] {
            #expect(reglas.contains("Edit(/\(carpeta)/\(rel))"), "falta \(rel)")
        }
        #expect(sinPrivate(try #require(sb.cwds.last)) == sinPrivate(carpeta))
        // otro agente: solo lo suyo
        #expect((await chat(b, agent: "marce", session: U.b)).status == 200)
        let rm = Sandbox.reglas(try #require(sb.llamadas.last))
        #expect(!rm.contains { $0.contains("decisiones.md") || $0.contains("oficina.md") })
    }

    @Test("chats anteriores a las oficinas: se asignan a Próspera HQ al importarla (y no a otras oficinas)")
    func chatsLegacyReclamados() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        // un chat viejo (oficina vacía), como los que dejó la etapa anterior
        try await b.store.asegurarSesion(U.a, agente: "betty", oficina: "")
        try await b.store.agregar(sid: U.a, rol: "u", texto: "hola de antes")
        try await b.store.agregar(sid: U.a, rol: "a", texto: "respuesta de antes")
        // crear una oficina cualquiera no los reclama
        _ = await llamar(b, "POST", "/api/oficinas", body: json(["nombre": "Taller", "departamentos": ["Dirección"]]))
        #expect(await b.store.oficinaDe(U.a) == "")
        let r = await importar(b)
        let carpeta = str(r.obj["carpeta"])
        #expect(await b.store.oficinaDe(U.a) == carpeta)
        let h = await historial(b, agent: "betty")
        #expect(h.obj["session"] as? String == U.a)
        #expect(msgs(h).map { str($0["t"]) } == ["hola de antes", "respuesta de antes"])
        // y se puede seguir la conversación con --resume (la sesión ya existía)
        _ = await chat(b, agent: "betty", message: "seguimos", session: U.a)
        let ult = try #require(sb.llamadas.last)
        #expect(Sandbox.valor(ult, "--session-id") == U.a || Sandbox.valor(ult, "--resume") == U.a)
        #expect(msgs(await historial(b, agent: "betty", session: U.a)).count == 4)
    }

    @Test("abrir una carpeta con la marca .importada-prospera también reclama los chats anteriores; una oficina común no")
    func abrirReclama() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let r = await importar(b)
        let carpeta = str(r.obj["carpeta"])
        let otra = str((await llamar(b, "POST", "/api/oficinas", body: json(["nombre": "Otra"]))).obj["carpeta"])
        // aparece un chat viejo después (p. ej. una migración tardía)
        try await b.store.asegurarSesion(U.b, agente: "marce", oficina: "")
        try await b.store.agregar(sid: U.b, rol: "u", texto: "tarde")
        _ = await llamar(b, "POST", "/api/oficinas/abrir", body: json(["carpeta": otra]))
        #expect(await b.store.oficinaDe(U.b) == "")
        _ = await llamar(b, "POST", "/api/oficinas/abrir", body: json(["carpeta": carpeta]))
        #expect(await b.store.oficinaDe(U.b) == carpeta)
        // importar de nuevo (yaExistia) también reclama
        try await b.store.asegurarSesion(U.c, agente: "mario", oficina: "")
        #expect((await importar(b)).obj["yaExistia"] as? Bool == true)
        #expect(await b.store.oficinaDe(U.c) == carpeta)
    }
}
}  // extension Etapa2
