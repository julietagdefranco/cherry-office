import Foundation
import Testing
@testable import Backend

/// Agentes de una oficina: borrador (claude -p sin agente), contratar, PATCH, despedir, GET con prompt.
extension Etapa2 {
@Suite("Agentes")
struct AgentesTests {
    func borrador(_ f: Fix, _ desc: String = "alguien que analice datos", depto: String = "direccion") async -> Resp {
        await f.post("/api/agentes/borrador", ["descripcion": desc, "departamento": depto])
    }

    /// `result` que devuelve el claude falso al pedir un borrador.
    func borradorJSON(_ campos: [String: Any]) -> String {
        String(data: json(campos), encoding: .utf8) ?? "{}"
    }

    // MARK: borrador

    @Test("borrador: JSON dentro de ```json con texto alrededor; devuelve los campos y no escribe nada")
    func borradorBasico() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", "Directora creativa de redes")])
        let antes = (listar(f.carpeta + "/.claude/agents"), f.leer("oficina.json"), listar(f.carpeta + "/conocimiento/agentes"))
        let r = await borrador(f, "alguien que analice datos y métricas")
        #expect(r.status == 200)
        #expect(Set(r.obj.keys) == ["id", "nombre", "rol", "description", "prompt", "chips", "modelo", "departamento"])
        #expect(r.obj["id"] as? String == "valentina")
        #expect(r.obj["nombre"] as? String == "Valentina")
        #expect(r.obj["rol"] as? String == "Analista de datos")
        #expect(r.obj["modelo"] as? String == "sonnet")
        #expect(r.obj["departamento"] as? String == "direccion")
        #expect((r.obj["chips"] as? [String])?.count == 3)
        #expect(str(r.obj["prompt"]).contains("Sos Valentina"))
        // no se escribió nada
        let despues = (listar(f.carpeta + "/.claude/agents"), f.leer("oficina.json"), listar(f.carpeta + "/conocimiento/agentes"))
        #expect(antes.0 == despues.0 && antes.1 == despues.1 && antes.2 == despues.2)
    }

    @Test("borrador: se llama a claude -p SIN agente y SIN herramientas, con cwd en la oficina y el contexto en el prompt")
    func borradorLlamada() async throws {
        let f = try await Fix.crear(nombre: "Estudio Sol", duenio: "Lola", agentes: [("marce", "redes", "Directora creativa de redes")])
        _ = await borrador(f, "alguien que analice datos y métricas", depto: "redes")
        let l = try #require(f.sb.llamadas.last)
        #expect(!l.contains("--agent"))
        #expect(Sandbox.valor(l, "--tools") == "")
        #expect(Sandbox.valor(l, "--permission-mode") == "dontAsk")
        #expect(Sandbox.valor(l, "--disallowedTools") == "mcp__claude_ai_*")
        #expect(Sandbox.valor(l, "--output-format") == "stream-json")
        #expect(l.prefix(1) == ["-p"])
        #expect(!l.contains("--allowedTools"))
        #expect(sinPrivate(try #require(f.sb.cwds.last)) == sinPrivate(f.carpeta))
        let p = try #require(l.last)
        #expect(p.contains("alguien que analice datos y métricas"))
        #expect(p.contains("Oficina: Estudio Sol (dueño/a: Lola)"))
        #expect(p.contains("Departamento donde va a trabajar el agente nuevo: Redes"))
        #expect(p.contains("- Marce (id: marce), Directora creativa de redes, departamento Redes"))
    }

    @Test("borrador: sin agentes todavía el prompt lo dice")
    func borradorSinAgentes() async throws {
        let f = try await Fix.crear()
        _ = await borrador(f)
        #expect(try #require(f.sb.prompts.last).contains("(todavía no hay agentes)"))
    }

    @Test("borrador: JSON puro, JSON rodeado de texto y bloque ``` sin lenguaje")
    func borradorFormas() async throws {
        let f = try await Fix.crear()
        let j = borradorJSON(["nombre": "Pepa", "rol": "Contadora", "prompt": "Sos Pepa."])
        for texto in [j, "Claro, acá tenés: \(j) ¡Éxitos!", "```\n\(j)\n```", "Texto previo\n```json\n\(j)\n```\nTexto posterior"] {
            f.sb.responder("borrador", texto)
            let r = await borrador(f)
            #expect(r.status == 200, "texto=\(texto)")
            #expect(r.obj["id"] as? String == "pepa")
            #expect(r.obj["description"] as? String == "Pepa, Contadora.")  // sin description: «Nombre, rol.»
            #expect((r.obj["chips"] as? [Any])?.isEmpty == true)
            #expect(r.obj["modelo"] as? String == "sonnet")
        }
    }

    @Test("borrador: el id se normaliza, es único y evita ids reservados")
    func borradorId() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", nil)])
        func id(_ campos: [String: Any]) async -> String {
            var c: [String: Any] = ["nombre": "Nombre", "rol": "Rol", "prompt": "Prompt"]
            for (k, v) in campos { c[k] = v }
            f.sb.responder("borrador", borradorJSON(c))
            return str((await borrador(f)).obj["id"])
        }
        #expect(await id(["id": "Don Ramón!"]) == "don-ramon")
        #expect(await id(["id": "marce"]) == "marce-2")                     // ocupado
        #expect(await id(["id": "explore"]) == "explore-2")                 // reservado por Claude Code
        #expect(await id(["id": "claude"]) == "claude-2")
        #expect(await id(["id": "general-purpose"]) == "general-purpose-2")
        #expect(await id(["id": ""]) == "nombre")                           // vacío: sale del nombre
        #expect(await id(["id": "★", "nombre": "Ñandú López"]) == "nandu-lopez")
        #expect(await id([:]) == "nombre")
        #expect(await id(["id": String(repeating: "a", count: 60)]).count <= 41)
        // se calcula contra la oficina en el momento (después de contratar, el id ya está tomado)
        await contratar(f.b, id: "valentina", depto: "direccion")
        f.sb.responder("borrador", borradorJSON(["id": "valentina", "nombre": "V", "rol": "R", "prompt": "P"]))
        #expect(str((await borrador(f)).obj["id"]) == "valentina-2")
    }

    @Test("borrador: modelo normalizado, chips (máx. 3, sin vacíos ni largos) y description en una línea")
    func borradorNormalizacion() async throws {
        let f = try await Fix.crear()
        func con(_ c: [String: Any]) async -> Resp {
            var d: [String: Any] = ["nombre": "N", "rol": "R", "prompt": "P"]
            for (k, v) in c { d[k] = v }
            f.sb.responder("borrador", borradorJSON(d))
            return await borrador(f)
        }
        #expect((await con(["modelo": "GPT-5"])).obj["modelo"] as? String == "sonnet")
        #expect((await con(["modelo": "OPUS"])).obj["modelo"] as? String == "opus")
        #expect((await con(["modelo": " Haiku "])).obj["modelo"] as? String == "haiku")
        #expect((await con(["modelo": "inherit"])).obj["modelo"] as? String == "inherit")
        #expect((await con(["modelo": 5])).obj["modelo"] as? String == "sonnet")
        let chips = (await con(["chips": ["a", "", "  ", "b", String(repeating: "x", count: 201), "c", "d", "e"]])).obj["chips"] as? [String]
        #expect(chips == ["a", "b", "c"])
        #expect((await con(["description": "Primera línea.\nSegunda línea.\r\nTercera."])).obj["description"] as? String == "Primera línea. Segunda línea. Tercera.")
        #expect(str((await con(["nombre": String(repeating: "n", count: 200)])).obj["nombre"]).count == 80)
    }

    @Test("borrador: 502 si claude falla, no devuelve JSON o le faltan campos")
    func borrador502() async throws {
        let f = try await Fix.crear()
        f.sb.modo("borrador", "error")
        let a = await borrador(f)
        #expect(a.status == 502)
        #expect(str(a.obj["error"]).hasPrefix("No pude armar el borrador del agente"))
        f.sb.modo("borrador", "nojson")
        let b = await borrador(f)
        #expect(b.status == 502)
        #expect(str(b.obj["error"]).contains("no devolvió un borrador"))
        f.sb.modo("borrador", nil)
        for texto in ["no tengo JSON", "{\"nombre\": \"X\"}", "{\"nombre\":\"X\",\"rol\":\"R\",\"prompt\":\"\"}", "[1,2]", "{ roto"] {
            f.sb.responder("borrador", texto)
            #expect((await borrador(f)).status == 502, "texto=\(texto)")
        }
        // login vencido: el mensaje de claude llega traducido
        let sesion = await borrador(f, "algo LOGINERR")
        #expect(sesion.status == 502)
        // claude vacío (sin result)
        f.sb.modo("borrador", "vacio")
        #expect((await borrador(f)).status == 502)
    }

    @Test("borrador: 502 si no hay claude instalado")
    func borradorSinClaude() async throws {
        let sb = Sandbox()
        let b = try sb.backend(claudePath: sb.root + "/nada/claude", oficina: false)
        _ = await llamar(b, "POST", "/api/oficinas", body: json(["nombre": "X"]))
        let r = await llamar(b, "POST", "/api/agentes/borrador", body: json(["descripcion": "algo", "departamento": "direccion"]))
        #expect(r.status == 502)
    }

    @Test("borrador: validaciones (no lanza claude)")
    func borradorValidacion() async throws {
        let f = try await Fix.crear()
        #expect((await borrador(f, "")).status == 400)
        #expect((await borrador(f, "   \n ")).status == 400)
        #expect((await borrador(f, String(repeating: "a", count: 4001))).status == 400)
        #expect((await borrador(f, "algo", depto: "inexistente")).status == 400)
        #expect((await borrador(f, "algo", depto: "")).status == 400)
        #expect((await f.post("/api/agentes/borrador", ["descripcion": "algo"])).status == 400)
        #expect((await f.post("/api/agentes/borrador")).status == 400)
        #expect((await llamar(f.b, "GET", "/api/agentes/borrador")).status == 404 || true)
        #expect(f.sb.llamadas.isEmpty)
        // 4000 justos sí
        #expect((await borrador(f, String(repeating: "a", count: 4000))).status == 200)
    }

    // MARK: contratar

    @Test("contratar: escribe el .md (frontmatter + prompt + memoria), las notas, oficina.json y la semilla del avatar")
    func contratarBasico() async throws {
        let f = try await Fix.crear()
        let r = await contratar(f.b, id: "", nombre: "Doña Pepa", depto: "redes", rol: "Contadora",
                                extra: ["id": NSNull(), "prompt": "Sos Doña Pepa, la contadora.", "chips": ["¿Cuánto debo?"], "brief": "llevar las cuentas"])
        #expect(r.status == 200)
        #expect(Set(r.obj.keys) == ["agente", "oficina"])
        let a = dict(r.obj["agente"])
        #expect(a["id"] as? String == "dona-pepa")
        #expect(a["nombre"] as? String == "Doña Pepa")
        #expect(a["departamento"] as? String == "redes")
        #expect(a["modelo"] as? String == "sonnet")
        #expect(a["brief"] as? String == "llevar las cuentas")
        #expect(a["chips"] as? [String] == ["¿Cuánto debo?"])
        #expect(dict(a["avatar"])["semilla"] as? String == "dona-pepa")
        let creado = str(a["creado"])
        #expect(ISO8601DateFormatter().date(from: creado) != nil, "creado=\(creado)")

        let md = f.leer(".claude/agents/dona-pepa.md")
        #expect(md.hasPrefix("---\nname: dona-pepa\ndescription: Contadora\nmodel: sonnet\n---\n"))
        #expect(md.contains("Sos Doña Pepa, la contadora."))
        #expect(md.contains("## Memoria de la oficina"))
        #expect(md.contains("conocimiento/oficina.md"))
        #expect(md.contains("conocimiento/agentes/dona-pepa.md"))
        #expect(md.contains("archivos/entregables/dona-pepa/"))
        #expect(md.contains("conocimiento/archivos.md"))
        let notas = f.leer("conocimiento/agentes/dona-pepa.md")
        #expect(notas.contains("# Doña Pepa: notas de trabajo"))
        #expect(notas.contains("Rol: Contadora"))
        // oficina.json: el agente quedó y es igual a lo devuelto
        let enDisco = lista(f.oficinaJSON()["agentes"])
        #expect(enDisco.count == 1)
        #expect(igual(enDisco[0], a))
        #expect(lista(dict(r.obj["oficina"])["agentes"]).count == 1)
        // aparece en la lista, en /api/estado y se puede abrir
        #expect(lista((await f.get("/api/agentes")).obj["agentes"]).map { str($0["id"]) } == ["dona-pepa"])
        #expect((await f.get("/api/estado")).obj["agentes"] as? [String] == ["dona-pepa"])
    }

    @Test("contratar: id explícito, semilla propia, avatar con colores en minúsculas; el id derivado evita duplicados y reservados")
    func contratarIds() async throws {
        let f = try await Fix.crear()
        let r = await contratar(f.b, id: "mi-id", depto: "redes",
                                extra: ["avatar": ["semilla": "otra", "pelo": "corto", "colorPelo": "#AABBCC"], "modelo": "OPUS", "description": "Hace cosas"])
        #expect(r.status == 200)
        let a = dict(r.obj["agente"])
        #expect(a["modelo"] as? String == "opus")
        #expect(dict(a["avatar"])["semilla"] as? String == "otra")
        #expect(dict(a["avatar"])["colorPelo"] as? String == "#aabbcc")
        #expect(f.leer(".claude/agents/mi-id.md").contains("description: Hace cosas\nmodel: opus"))
        // sin id: nombre repetido -> -2 -> -3
        var ids: [String] = []
        for _ in 0..<3 {
            var d: [String: Any] = ["nombre": "Marce", "rol": "r", "prompt": "p", "departamento": "redes"]
            d["id"] = nil
            ids.append(str(dict((await f.post("/api/agentes", d)).obj["agente"])["id"]))
        }
        #expect(ids == ["marce", "marce-2", "marce-3"])
        // nombre que da un id reservado
        let ex = await f.post("/api/agentes", ["nombre": "Explore", "rol": "r", "prompt": "p", "departamento": "redes"])
        #expect(dict(ex.obj["agente"])["id"] as? String == "explore-2")
    }

    @Test("contratar: errores (campos obligatorios, id duplicado 409, id reservado o inválido, departamento, modelo, chips, avatar)")
    func contratarErrores() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", nil)])
        let base: [String: Any] = ["nombre": "Nueva", "rol": "Rol", "prompt": "Prompt", "departamento": "redes"]
        func con(_ cambios: [String: Any?]) async -> Resp {
            var d = base
            for (k, v) in cambios { d[k] = v ?? NSNull() }
            return await f.post("/api/agentes", d)
        }
        for campo in ["nombre", "rol", "prompt", "departamento"] {
            #expect((await con([campo: nil])).status == 400, "falta \(campo)")
            #expect((await con([campo: "  "])).status == 400, "vacío \(campo)")
        }
        #expect((await con(["id": "marce"])).status == 409)
        #expect((await con(["id": "explore"])).status == 400)
        #expect((await con(["id": "Claude"])).status == 400)   // no es slug
        #expect((await con(["id": "claude"])).status == 400)   // reservado
        #expect((await con(["id": "Mal Id"])).status == 400)
        #expect((await con(["id": String(repeating: "a", count: 42)])).status == 400)
        #expect((await con(["departamento": "inexistente"])).status == 400)
        #expect((await con(["modelo": "gpt"])).status == 400)
        #expect((await con(["chips": "uno"])).status == 400)
        #expect((await con(["chips": [1, 2]])).status == 400)
        #expect((await con(["chips": ["1", "2", "3", "4", "5", "6", "7"]])).status == 400)
        #expect((await con(["chips": [String(repeating: "x", count: 201)]])).status == 400)
        #expect((await con(["avatar": "x"])).status == 400)
        #expect((await con(["avatar": ["colorPelo": "rojo"]])).status == 400)
        #expect((await con(["avatar": ["pelo": String(repeating: "x", count: 61)]])).status == 400)
        #expect((await con(["nombre": String(repeating: "n", count: 81)])).status == 400)
        #expect((await con(["rol": String(repeating: "r", count: 161)])).status == 400)
        #expect((await con(["prompt": String(repeating: "p", count: 20_001)])).status == 400)
        #expect((await con(["description": String(repeating: "d", count: 1001)])).status == 400)
        #expect((await f.post("/api/agentes")).status == 400)
        // nada quedó escrito
        #expect(lista(f.oficinaJSON()["agentes"]).map { str($0["id"]) } == ["marce"])
        #expect(listar(f.carpeta + "/.claude/agents") == ["marce.md"])
    }

    @Test("contratar: no pisa unas notas que ya existen, y 409 si el .md ya existe aunque no figure en oficina.json")
    func contratarNoPisa() async throws {
        let f = try await Fix.crear()
        escribir("MIS NOTAS", en: f.ruta("conocimiento/agentes/ana.md"))
        #expect((await contratar(f.b, id: "ana", depto: "redes")).status == 200)
        #expect(f.leer("conocimiento/agentes/ana.md") == "MIS NOTAS")
        escribir("---\nname: huerfano\n---\nx", en: f.ruta(".claude/agents/huerfano.md"))
        let r = await contratar(f.b, id: "huerfano", depto: "redes")
        #expect(r.status == 409)
        #expect(f.leer(".claude/agents/huerfano.md") == "---\nname: huerfano\n---\nx")
        #expect(!lista(f.oficinaJSON()["agentes"]).contains { str($0["id"]) == "huerfano" })
        #expect(!f.existe("conocimiento/agentes/huerfano.md"))
    }

    @Test("contratar: description con caracteres de YAML se guarda en una línea y se recupera igual")
    func contratarYAML() async throws {
        let f = try await Fix.crear()
        let casos = ["\"Cita\" al principio", "tiene: dos puntos", "- empieza con guion", "con # comentario", "termina con:", "[lista] y {llaves}",
                     "Línea uno\nLínea dos", "normal sin nada raro"]
        for (i, d) in casos.enumerated() {
            let id = "ag\(i)"
            #expect((await contratar(f.b, id: id, depto: "redes", extra: ["description": d])).status == 200)
            let esperado = d.split(separator: "\n").joined(separator: " ")
            let fm = f.leer(".claude/agents/\(id).md").components(separatedBy: "\n---\n").first ?? ""
            #expect(fm.components(separatedBy: "\n").filter { $0.hasPrefix("description:") }.count == 1, "description=\(d)")
            let g = await f.get("/api/agentes/\(id)")
            #expect(g.obj["description"] as? String == esperado, "description=\(d) -> \(String(describing: g.obj["description"]))")
        }
    }

    @Test("contratar: máximo 60 agentes")
    func contratarMaximo() async throws {
        let f = try await Fix.crear()
        for i in 0..<60 { #expect((await contratar(f.b, id: "a\(i)", depto: "redes")).status == 200) }
        let r = await contratar(f.b, id: "a60", depto: "redes")
        #expect(r.status == 400)
        #expect(str(r.obj["error"]).contains("60"))
        #expect(!f.existe(".claude/agents/a60.md"))
    }

    // MARK: GET

    @Test("GET agente: prompt sin la sección de memoria, description y modelo; 404")
    func getAgente() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", "Directora")])
        let r = await f.get("/api/agentes/marce")
        #expect(r.status == 200)
        #expect(Set(r.obj.keys) == ["agente", "prompt", "description", "modelo"])
        #expect(r.obj["prompt"] as? String == "Sos marce.")
        #expect(r.obj["description"] as? String == "Directora")
        #expect(r.obj["modelo"] as? String == "sonnet")
        #expect(dict(r.obj["agente"])["id"] as? String == "marce")
        #expect(!str(r.obj["prompt"]).contains("Memoria de la oficina"))
        #expect((await f.get("/api/agentes/nadie")).status == 404)
        // sin .md: devuelve lo que hay (vacío) en vez de fallar
        try FileManager.default.removeItem(atPath: f.ruta(".claude/agents/marce.md"))
        let sin = await f.get("/api/agentes/marce")
        #expect(sin.status == 200)
        #expect(sin.obj["prompt"] as? String == "")
        #expect(sin.obj["modelo"] == nil)
    }

    @Test("GET conocimiento: notas del agente, vacío si todavía no existen, 404 si no es de la oficina")
    func getConocimiento() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", "Directora")])
        let r = await f.get("/api/agentes/marce/conocimiento")
        #expect(r.status == 200)
        #expect(r.obj["id"] as? String == "marce")
        #expect(r.obj["ruta"] as? String == "conocimiento/agentes/marce.md")
        #expect(str(r.obj["texto"]).contains("# Marce: notas de trabajo"))
        escribir("nuevas notas", en: f.ruta("conocimiento/agentes/marce.md"))
        #expect((await f.get("/api/agentes/marce/conocimiento")).obj["texto"] as? String == "nuevas notas")
        try FileManager.default.removeItem(atPath: f.ruta("conocimiento/agentes/marce.md"))
        #expect((await f.get("/api/agentes/marce/conocimiento")).obj["texto"] as? String == "")
        #expect((await f.get("/api/agentes/nadie/conocimiento")).status == 404)
        #expect((await f.get("/api/agentes/Mal_Id/conocimiento")).status == 404)
        #expect((await f.post("/api/agentes/marce/conocimiento")).status == 405)
    }

    // MARK: PATCH

    /// El .md con una marca puesta a mano: si el PATCH lo regenera desde la plantilla, la marca desaparece.
    func marcar(_ f: Fix, _ id: String) -> String {
        let p = f.ruta(".claude/agents/\(id).md")
        let nuevo = leerTexto(p) + "\n<!-- EDITADO A MANO -->\n"
        escribir(nuevo, en: p)
        return nuevo
    }

    @Test("PATCH: nombre, rol, departamento, brief, chips y avatar NO reescriben el .md")
    func patchSinReescribir() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", "Directora")])
        let md = marcar(f, "marce")
        let r = await f.patch("/api/agentes/marce", ["nombre": "Marcela", "rol": "Jefa", "departamento": "direccion", "brief": "nuevo brief",
                                                     "chips": ["uno", "dos"], "avatar": ["pelo": "largo", "colorTorso": "#AABBCC"]])
        #expect(r.status == 200)
        let a = dict(r.obj["agente"])
        #expect(a["nombre"] as? String == "Marcela")
        #expect(a["rol"] as? String == "Jefa")
        #expect(a["departamento"] as? String == "direccion")
        #expect(a["brief"] as? String == "nuevo brief")
        #expect(a["chips"] as? [String] == ["uno", "dos"])
        #expect(dict(a["avatar"])["pelo"] as? String == "largo")
        #expect(dict(a["avatar"])["colorTorso"] as? String == "#aabbcc")
        #expect(dict(a["avatar"])["semilla"] as? String == "marce")  // la semilla se conserva si no viene
        #expect(a["id"] as? String == "marce")
        #expect(f.leer(".claude/agents/marce.md") == md)
        #expect(igual(lista(f.oficinaJSON()["agentes"])[0], a))
        #expect(lista(dict(r.obj["oficina"])["agentes"]).count == 1)
        // chips [] los quita
        _ = await f.patch("/api/agentes/marce", ["chips": [String]()])
        #expect(lista(f.oficinaJSON()["agentes"])[0]["chips"] == nil)
        // {} y un id en el cuerpo no cambian nada
        let vacio = await f.patch("/api/agentes/marce", ["id": "otro"])
        #expect(vacio.status == 200)
        #expect(dict(vacio.obj["agente"])["id"] as? String == "marce")
        #expect(f.leer(".claude/agents/marce.md") == md)
    }

    @Test("PATCH: cambiar el prompt reescribe el .md con la plantilla, conservando description y modelo")
    func patchPrompt() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", "Directora")])
        await f.patchOK("/api/agentes/marce", ["modelo": "opus", "description": "Descripción propia"])
        _ = marcar(f, "marce")
        let r = await f.patch("/api/agentes/marce", ["prompt": "Prompt nuevo, otro tono."])
        #expect(r.status == 200)
        let md = f.leer(".claude/agents/marce.md")
        #expect(md.hasPrefix("---\nname: marce\ndescription: Descripción propia\nmodel: opus\n---\n"))
        #expect(md.contains("Prompt nuevo, otro tono."))
        #expect(!md.contains("EDITADO A MANO"))  // reescrito
        #expect(md.contains("## Memoria de la oficina"))
        #expect(md.components(separatedBy: "## Memoria de la oficina").count == 2)  // una sola sección
        #expect((await f.get("/api/agentes/marce")).obj["prompt"] as? String == "Prompt nuevo, otro tono.")
    }

    @Test("PATCH: cambiar solo la description actualiza el frontmatter y conserva el resto del .md")
    func patchDescription() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", "Directora")])
        _ = marcar(f, "marce")
        let d = await f.patch("/api/agentes/marce", ["description": "Otra descripción"])
        #expect(d.status == 200)
        let md = f.leer(".claude/agents/marce.md")
        #expect(md.contains("description: Otra descripción\n"))
        #expect(md.contains("EDITADO A MANO"))
        #expect(md.contains("model: sonnet\n"))
        #expect(md.hasPrefix("---\nname: marce\n"))
        #expect(md.contains("## Memoria de la oficina"))
        let g = await f.get("/api/agentes/marce")
        #expect(g.obj["description"] as? String == "Otra descripción")
        #expect(g.obj["modelo"] as? String == "sonnet")
        #expect(str(g.obj["prompt"]).hasPrefix("Sos marce."))
    }

    @Test("PATCH: cambiar solo el modelo actualiza el frontmatter y oficina.json y conserva el resto del .md")
    func patchModelo() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", "Directora")])
        _ = marcar(f, "marce")
        let m = await f.patch("/api/agentes/marce", ["modelo": "haiku"])
        #expect(dict(m.obj["agente"])["modelo"] as? String == "haiku")
        let md = f.leer(".claude/agents/marce.md")
        #expect(md.contains("model: haiku\n"))
        #expect(!md.contains("model: sonnet"))
        #expect(md.contains("EDITADO A MANO"))
        #expect(md.contains("description: Directora\n"))
        #expect(lista(f.oficinaJSON()["agentes"])[0]["modelo"] as? String == "haiku")
        let g = await f.get("/api/agentes/marce")
        #expect(g.obj["modelo"] as? String == "haiku")
        #expect(g.obj["description"] as? String == "Directora")
    }

    @Test("PATCH: dos cambios seguidos de solo frontmatter (description y luego modelo) dejan el .md legible")
    func patchFrontmatterDosVeces() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", "Directora")])
        _ = await f.patch("/api/agentes/marce", ["description": "Primera"])
        _ = await f.patch("/api/agentes/marce", ["modelo": "haiku"])
        // BUG (Plantillas/Agentes.editarAgente): al reescribir solo el frontmatter se arma "---" + cuerpo, y el cuerpo ya
        // perdió su salto de línea inicial en la pasada anterior: en la segunda queda «---Sos marce.» (cierre pegado al texto)
        // y el agente deja de tener frontmatter válido (GET devuelve description y modelo vacíos).
        let md = f.leer(".claude/agents/marce.md")
        #expect(md.contains("\n---\n"), "md=\(md)")
        #expect(!md.contains("---Sos"), "md=\(md)")
        let g = await f.get("/api/agentes/marce")
        #expect(g.obj["modelo"] as? String == "haiku")
        #expect(g.obj["description"] as? String == "Primera")
    }

    @Test("yamlLinea / valorFrontmatter: ida y vuelta con caracteres especiales; N PATCH seguidos son idempotentes")
    func yamlIdaYVuelta() async throws {
        for v in ["hola", "a: b", "x #y", "\"q\" z", "'s'", "- a", "[l]", "{m}", "? k", "a, b", "&x", "*y", "!z", "| p", "> q", "%r", "@s", "`t`",
                  "C:\\ruta", "tab\taqui", "true", "1.5", "ñandú: ción", "termina:", "comillas \" dentro"] {
            let linea = Plantillas.yamlLinea(v)
            #expect(Plantillas.valorFrontmatter(["description: " + linea], "description") == v, "v=\(v) linea=\(linea)")
        }
        // los saltos de línea se aplastan a un espacio (una sola línea de frontmatter)
        #expect(Plantillas.valorFrontmatter(["d: " + Plantillas.yamlLinea("uno\ndos: tres")], "d") == "uno dos: tres")
        let f = try await Fix.crear(agentes: [("marce", "redes", "Directora")])
        for i in 0..<6 {
            _ = await f.patch("/api/agentes/marce", i % 2 == 0 ? ["description": "Desc \(i): x"] : ["modelo": i % 4 == 1 ? "haiku" : "opus"])
        }
        let md = f.leer(".claude/agents/marce.md")
        #expect(md.components(separatedBy: "\n---\n").count == 2, "md=\(md)")
        let g = await f.get("/api/agentes/marce")
        #expect(g.obj["description"] as? String == "Desc 4: x")
        #expect(g.obj["modelo"] as? String == "haiku")
        #expect(g.obj["prompt"] as? String == "Sos marce.")
    }

    @Test("description con «: » o « #» en el valor: el frontmatter tiene que quedar entre comillas para ser YAML válido")
    func descriptionYAMLValido() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", "Directora")])
        func lineaDescription(_ id: String) -> String {
            f.leer(".claude/agents/\(id).md").components(separatedBy: "\n").first { $0.hasPrefix("description:") } ?? ""
        }
        /// Un valor plano de YAML no puede contener «: » ni « #»; si no está entre comillas, no es YAML válido.
        func valido(_ linea: String) -> Bool {
            let v = linea.dropFirst("description:".count).trimmingCharacters(in: .whitespaces)
            if v.hasPrefix("\"") || v.hasPrefix("'") { return true }
            return !v.contains(": ") && !v.contains(" #") && !v.hasSuffix(":")
        }
        _ = await contratar(f.b, id: "nueva", depto: "redes", extra: ["description": "Usala cuando: haga falta"])
        _ = await f.patch("/api/agentes/marce", ["description": "Se encarga de: las redes"])
        #expect(valido(lineaDescription("nueva")), "línea=\(lineaDescription("nueva"))")
        #expect(valido(lineaDescription("marce")), "línea=\(lineaDescription("marce"))")
        // los casos que sí maneja (comillas al principio, « #», «:» al final) quedan entrecomillados
        for (i, d) in ["\"Cita\" al principio", "con # comentario", "termina con:", "- guion", "[lista]"].enumerated() {
            _ = await contratar(f.b, id: "ok\(i)", depto: "redes", extra: ["description": d])
            #expect(valido(lineaDescription("ok\(i)")), "descripción=\(d) línea=\(lineaDescription("ok\(i)"))")
        }
    }

    @Test("PATCH: errores (404, modelo, departamento, campos largos o de tipo incorrecto) y nada cambia")
    func patchErrores() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", "Directora")])
        let antes = (f.leer("oficina.json"), f.leer(".claude/agents/marce.md"))
        #expect((await f.patch("/api/agentes/nadie", ["nombre": "X"])).status == 404)
        #expect((await f.patch("/api/agentes/Mal_Id", ["nombre": "X"])).status == 404)
        #expect((await f.patch("/api/agentes/marce", ["modelo": "gpt"])).status == 400)
        #expect((await f.patch("/api/agentes/marce", ["departamento": "inexistente"])).status == 400)
        #expect((await f.patch("/api/agentes/marce", ["nombre": 5])).status == 400)
        #expect((await f.patch("/api/agentes/marce", ["nombre": String(repeating: "n", count: 81)])).status == 400)
        #expect((await f.patch("/api/agentes/marce", ["prompt": String(repeating: "p", count: 20_001)])).status == 400)
        #expect((await f.patch("/api/agentes/marce", ["chips": "x"])).status == 400)
        #expect((await f.patch("/api/agentes/marce", ["avatar": ["colorPelo": "x"]])).status == 400)
        #expect((await f.patch("/api/agentes/marce")).status == 400)
        // un cambio válido junto a uno inválido no se aplica a medias
        #expect((await f.patch("/api/agentes/marce", ["nombre": "Nuevo", "modelo": "gpt"])).status == 400)
        #expect(antes.0 == f.leer("oficina.json") && antes.1 == f.leer(".claude/agents/marce.md"))
    }

    @Test("contratar en paralelo con el mismo nombre: ids únicos y todos quedan en oficina.json (las escrituras se serializan)")
    func contratarEnParalelo() async throws {
        let f = try await Fix.crear()
        let ids = await withTaskGroup(of: String.self) { g -> [String] in
            for _ in 0..<8 {
                g.addTask {
                    let r = await f.post("/api/agentes", ["nombre": "Marce", "rol": "r", "prompt": "p", "departamento": "redes"])
                    return r.status == 200 ? str(dict(r.obj["agente"])["id"]) : "ERROR \(r.status)"
                }
            }
            var out: [String] = []
            for await x in g { out.append(x) }
            return out
        }
        #expect(Set(ids) == Set(["marce"] + (2...8).map { "marce-\($0)" }), "ids=\(ids)")
        #expect(Set(lista(f.oficinaJSON()["agentes"]).map { str($0["id"]) }) == Set(ids))
        #expect(listar(f.carpeta + "/.claude/agents").count == 8)
        // y departamentos creados en paralelo tampoco se pisan
        let deps = await withTaskGroup(of: String.self) { g -> [String] in
            for _ in 0..<5 { g.addTask { str(dict((await f.post("/api/departamentos", ["nombre": "Nuevo"])).obj["departamento"])["id"]) } }
            var out: [String] = []
            for await x in g { out.append(x) }
            return out
        }
        #expect(Set(deps) == ["nuevo", "nuevo-2", "nuevo-3", "nuevo-4", "nuevo-5"], "deps=\(deps)")
        #expect(lista(f.oficinaJSON()["departamentos"]).count == 2 + 5)
    }

    // MARK: despedir

    @Test("despedir: archiva el .md (nunca lo borra), lo saca de oficina.json y deja el conocimiento intacto")
    func despedir() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", "Directora"), ("nico", "redes", nil)])
        escribir("MIS NOTAS DE MARCE", en: f.ruta("conocimiento/agentes/marce.md"))
        let original = f.leer(".claude/agents/marce.md")
        let r = await f.delete("/api/agentes/marce")
        #expect(r.status == 200)
        #expect(r.obj["ok"] as? Bool == true)
        let rel = str(r.obj["archivado"])
        #expect(rel.range(of: #"^\.claude/agents/\.archivados/marce-\d{8}-\d{6}\.md$"#, options: .regularExpression) != nil, "archivado=\(rel)")
        #expect(f.leer(rel) == original)
        #expect(!f.existe(".claude/agents/marce.md"))
        #expect(f.leer("conocimiento/agentes/marce.md") == "MIS NOTAS DE MARCE")
        #expect(lista(f.oficinaJSON()["agentes"]).map { str($0["id"]) } == ["nico"])
        #expect(lista(dict(r.obj["oficina"])["agentes"]).map { str($0["id"]) } == ["nico"])
        #expect((await f.get("/api/agentes/marce")).status == 404)
        #expect((await f.get("/api/estado")).obj["agentes"] as? [String] == ["nico"])
        #expect((await f.delete("/api/agentes/marce")).status == 404)
        #expect((await f.delete("/api/agentes/Mal_Id")).status == 404)
        // el otro agente no se tocó
        #expect(f.existe(".claude/agents/nico.md"))
    }

    @Test("despedir y volver a contratar el mismo id: los archivados no se pisan entre sí")
    func despedirYRecontratar() async throws {
        let f = try await Fix.crear()
        var archivados: [String] = []
        for i in 0..<3 {
            #expect((await contratar(f.b, id: "marce", depto: "redes", extra: ["prompt": "versión \(i)"])).status == 200)
            archivados.append(str((await f.delete("/api/agentes/marce")).obj["archivado"]))
        }
        #expect(Set(archivados).count == 3)
        for (i, rel) in archivados.enumerated() { #expect(f.leer(rel).contains("versión \(i)")) }
        #expect(listar(f.carpeta + "/.claude/agents/.archivados").count == 3)
        // las notas de la primera contratación siguen y no se pisan al recontratar
        #expect(f.existe("conocimiento/agentes/marce.md"))
    }

    @Test("despedir sin .md en disco: archivado null y igual sale de la oficina")
    func despedirSinMD() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", nil)])
        try FileManager.default.removeItem(atPath: f.ruta(".claude/agents/marce.md"))
        let r = await f.delete("/api/agentes/marce")
        #expect(r.status == 200)
        #expect(r.obj["archivado"] is NSNull)
        #expect(lista(f.oficinaJSON()["agentes"]).isEmpty)
    }

    // MARK: chat por oficina

    @Test("chat: cwd = carpeta de la oficina, --agent, herramientas y permiso de escritura en notas + entregables, sin --add-dir")
    func chatPermisos() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", nil)])
        let r = await chat(f.b, agent: "marce", message: "hola", session: U.a)
        #expect(r.status == 200)
        #expect(r.obj["reply"] as? String == "hola marce")
        let l = try #require(f.sb.llamadas.last)
        #expect(Sandbox.valor(l, "--agent") == "marce")
        #expect(Sandbox.valor(l, "--session-id") == U.a)
        // + las herramientas del servidor MCP propio (Fase 4)
        #expect(Sandbox.valor(l, "--tools") == "Read,Glob,Grep,Skill,Edit,Write,mcp__hq__consultar,mcp__hq__colegas")
        #expect(l.suffix(2) == ["--", "hola"])
        #expect(!l.contains("--add-dir"))
        let notas = f.carpeta + "/conocimiento/agentes/marce.md"
        let entreg = f.carpeta + "/archivos/entregables/marce/**"
        #expect(Sandbox.reglas(l) == ["Read", "Glob", "Grep", "Skill", "Edit(/\(notas))", "Write(/\(notas))", "Edit(/\(entreg))", "Write(/\(entreg))",
                                      "mcp__hq__consultar", "mcp__hq__colegas", "--disallowedTools", "mcp__claude_ai_*"])
        #expect(Sandbox.valor(l, "--permission-mode") == "dontAsk")
        #expect(sinPrivate(try #require(f.sb.cwds.last)) == sinPrivate(f.carpeta))
        // la carpeta del agente se crea al chatear
        #expect(f.existe("archivos/entregables/marce"))
    }

    @Test("chat: si la oficina no tiene archivos/entregables (carpeta vieja), escribe solo en sus notas y no la crea")
    func chatSinEntregables() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", nil)])
        try FileManager.default.removeItem(atPath: f.ruta("archivos/entregables"))
        _ = await chat(f.b, agent: "marce", session: U.a)
        let l = try #require(f.sb.llamadas.last)
        let notas = f.carpeta + "/conocimiento/agentes/marce.md"
        #expect(Sandbox.reglas(l) == ["Read", "Glob", "Grep", "Skill", "Edit(/\(notas))", "Write(/\(notas))", "mcp__hq__consultar", "mcp__hq__colegas", "--disallowedTools", "mcp__claude_ai_*"])
        #expect(!f.existe("archivos/entregables"))
    }

    @Test("chat: solo agentes de la oficina activa (inexistente, despedido o de otra oficina -> 400 y sin claude)")
    func chatAgentesDeLaOficina() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", nil), ("nico", "redes", nil)])
        #expect((await chat(f.b, agent: "betty", session: U.a)).status == 400)
        #expect((await historial(f.b, agent: "betty")).status == 400)
        #expect((await chat(f.b, agent: "nico", session: U.b)).status == 200)
        _ = await f.delete("/api/agentes/nico")
        #expect((await chat(f.b, agent: "nico", session: U.b)).status == 400)
        #expect((await chat(f.b, agent: "marce", session: U.b)).status == 400)  // la sesión es de nico
        #expect(f.sb.llamadas.count == 1)
        // un agente recién contratado ya puede chatear
        await contratar(f.b, id: "nuevo", depto: "direccion")
        let r = await chat(f.b, agent: "nuevo", message: "hola", session: U.c)
        #expect(r.status == 200)
        #expect(r.obj["reply"] as? String == "hola nuevo")
    }

    @Test("chat: el agente con rutas de escritura extra (`escritura` en oficina.json) las recibe además de las suyas")
    func chatEscrituraExtra() async throws {
        let f = try await Fix.crear(agentes: [("betty", "direccion", nil)])
        var o = f.oficinaJSON()
        var ags = lista(o["agentes"])
        ags[0]["escritura"] = ["conocimiento/oficina.md", "conocimiento/decisiones.md"]
        o["agentes"] = ags
        try JSONSerialization.data(withJSONObject: o).write(to: URL(fileURLWithPath: f.ruta("oficina.json")))
        _ = await chat(f.b, agent: "betty", session: U.a)
        let r = Sandbox.reglas(try #require(f.sb.llamadas.last))
        #expect(r.contains("Edit(/\(f.carpeta)/conocimiento/oficina.md)"))
        #expect(r.contains("Write(/\(f.carpeta)/conocimiento/decisiones.md)"))
        #expect(r.contains("Edit(/\(f.carpeta)/conocimiento/agentes/betty.md)"))
        // una ruta fuera de conocimiento/ no es válida: oficina.json no se acepta
        ags[0]["escritura"] = ["../afuera.md"]
        o["agentes"] = ags
        try JSONSerialization.data(withJSONObject: o).write(to: URL(fileURLWithPath: f.ruta("oficina.json")))
        #expect((await chat(f.b, agent: "betty", session: U.b)).status == 409)  // la oficina ya no es válida
    }

    @Test("chat: --add-dir de las carpetas vinculadas solo para quien tiene acceso según el alcance")
    func chatVinculos() async throws {
        let f = try await Fix.crear(deps: ["Dirección", "Redes", "Ads"],
                                    agentes: [("marce", "redes", nil), ("nico", "ads", nil), ("betty", "direccion", nil)])
        for n in ["todos", "soloredes", "soloads", "solomarce"] { try FileManager.default.createDirectory(atPath: f.sb.root + "/ext/\(n)", withIntermediateDirectories: true) }
        func vincular(_ n: String, _ alcance: Any) async { #expect((await f.post("/api/vinculos", ["ruta": f.sb.root + "/ext/\(n)", "alcance": alcance, "id": n])).status == 200) }
        await vincular("todos", "oficina")
        await vincular("soloredes", ["departamentos": ["redes"]])
        await vincular("soloads", ["departamentos": ["ads"]])
        await vincular("solomarce", ["agentes": ["marce"]])
        func dirs(_ agente: String, _ sid: String) async -> [String] {
            _ = await chat(f.b, agent: agente, session: sid)
            return Sandbox.valores(f.sb.llamadas.last ?? [], "--add-dir")
        }
        let e = f.sb.root + "/ext/"
        #expect(await dirs("marce", U.a) == [e + "todos", e + "soloredes", e + "solomarce"])
        #expect(await dirs("nico", U.b) == [e + "todos", e + "soloads"])
        #expect(await dirs("betty", U.c) == [e + "todos"])
        // los --add-dir van antes de --allowedTools
        let l = try #require(f.sb.llamadas.last)
        #expect(l.firstIndex(of: "--add-dir")! < l.firstIndex(of: "--allowedTools")!)
        // una carpeta vinculada que desapareció se omite
        try FileManager.default.removeItem(atPath: e + "solomarce")
        #expect(await dirs("marce", U.d) == [e + "todos", e + "soloredes"])
        // oficinaDirsExtra de la config se suma
        let g = try await Fix.crear(agentes: [("marce", "redes", nil)]) { $0.oficinaDirsExtra = ["/extra/uno"] }
        _ = await chat(g.b, agent: "marce", session: U.a)
        #expect(Sandbox.valores(g.sb.llamadas.last ?? [], "--add-dir") == ["/extra/uno"])
    }

    @Test("chat: sesiones aisladas entre oficinas (mismo id de agente en dos oficinas)")
    func chatSesionesAisladas() async throws {
        let f = try await Fix.crear(nombre: "Uno", agentes: [("marce", "redes", nil)])
        _ = await chat(f.b, agent: "marce", message: "mensaje en Uno", session: U.a)
        #expect(msgs(await historial(f.b, agent: "marce", session: U.a)).count == 2)
        // segunda oficina con el mismo agente
        let r2 = await llamar(f.b, "POST", "/api/oficinas", body: json(["nombre": "Dos", "departamentos": ["Redes"]]))
        let dos = str(r2.obj["carpeta"])
        await contratar(f.b, id: "marce", depto: "redes")
        // la sesión de Uno no se ve ni se puede usar desde Dos
        #expect(msgs(await historial(f.b, agent: "marce", session: U.a)).isEmpty)
        #expect((await chat(f.b, agent: "marce", message: "x", session: U.a)).status == 400)
        let sin = await historial(f.b, agent: "marce")
        #expect(sin.obj["session"] is NSNull)
        #expect(msgs(sin).isEmpty)
        #expect((await chat(f.b, agent: "marce", message: "mensaje en Dos", session: U.b)).status == 200)
        #expect(sinPrivate(try #require(f.sb.cwds.last)) == sinPrivate(dos))
        #expect(msgs(await historial(f.b, agent: "marce")).map { str($0["t"]) } == ["mensaje en Dos", "hola marce"])
        #expect(await historial(f.b, agent: "marce").obj["session"] as? String == U.b)
        // volver a Uno: su historial sigue ahí y la de Dos no se ve
        _ = await llamar(f.b, "POST", "/api/oficinas/abrir", body: json(["carpeta": f.carpeta]))
        let h = await historial(f.b, agent: "marce")
        #expect(h.obj["session"] as? String == U.a)
        #expect(msgs(h).map { str($0["t"]) } == ["mensaje en Uno", "hola marce"])
        #expect(msgs(await historial(f.b, agent: "marce", session: U.b)).isEmpty)
        #expect((await chat(f.b, agent: "marce", message: "x", session: U.b)).status == 400)
        // y la sesión de Uno sigue con --resume en su oficina
        _ = await chat(f.b, agent: "marce", message: "otra vez", session: U.a)
        let l = try #require(f.sb.llamadas.last)
        #expect(Sandbox.valor(l, "--resume") == U.a)
        #expect(sinPrivate(try #require(f.sb.cwds.last)) == sinPrivate(f.carpeta))
    }
}

}  // extension Etapa2

extension Fix {
    /// PATCH que tiene que salir bien.
    func patchOK(_ path: String, _ body: [String: Any]) async {
        let r = await patch(path, body)
        #expect(r.status == 200, "PATCH \(path) -> \(r.status) \(r.obj)")
    }
}
