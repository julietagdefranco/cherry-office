import Foundation
import Testing
@testable import Backend

/// Test de aceptación de la ola 3 (docs/plan-creador-flujos.md, «Cómo se cubre el caso de prueba»).
/// Se simulan las llamadas `proponer_*` del caso de Juli (docs/caso-prospera/texto-original.md, con citas textuales) contra una oficina
/// importada de Próspera; los estados y faltantes tienen que coincidir con docs/caso-prospera/mapeo-esperado.md. Después se aplican
/// las listas y se corre el flujo F1 con el motor hasta el paso de la persona. Todo con el claude falso.
extension Etapa2 {
@Suite("Caso Próspera de punta a punta", .serialized)
struct CasoProsperaTests {
    static let textoOriginal: String = leerTexto(raizRepo + "/docs/caso-prospera/texto-original.md")

    typealias Banco = CreadorTests.Banco

    /// Oficina importada de Próspera, con la sesión del Creador que tiene el texto de Juli como mensaje `u`.
    func armar(texto: String = CasoProsperaTests.textoOriginal) async throws -> Banco {
        let sb = Sandbox()
        let b = try sb.backend(env: ["HQ_PROGRAMADOR": "0"], oficina: false)
        let r = await llamar(b, "POST", "/api/oficinas/importar-prospera", body: json(["origen": raizRepo]))
        try #require(r.status == 200, "importar: \(r.obj)")
        let f = Fix(sb: sb, b: b, carpeta: str(r.obj["carpeta"]))
        let sid = U.a
        try await b.store.asegurarSesion(sid, agente: "creador", oficina: f.carpeta)
        try await b.store.agregar(sid: sid, rol: "u", texto: texto)
        let token = b.mcp.tokens.emitir(oficina: f.carpeta, agente: "creador", sid: sid, perfil: "creador")
        let h = try #require(Creador.herramientas(b.servicios, token: token,
                                                  identidad: IdentidadMCP(oficina: f.carpeta, agente: "creador", sid: sid, perfil: "creador")))
        return Banco(f: f, h: h, sid: sid)
    }

    static let calendar = ServidorConector(
        nombre: "Google Calendar", prefijo: "mcp__claude_ai_Google_Calendar", estado: "connected",
        herramientas: ["mcp__claude_ai_Google_Calendar__list_calendars", "mcp__claude_ai_Google_Calendar__list_events",
                       "mcp__claude_ai_Google_Calendar__create_event"])
    static let notion = ServidorConector(nombre: "Notion", prefijo: "mcp__claude_ai_Notion", estado: "needs-auth")

    /// `proponer` del banco, con los argumentos en el orden que más cómodo queda para leer el caso.
    func prop(_ b: Banco, _ tipo: String, _ accion: String = "crear", origen: String, objetivo: String? = nil, ref: String? = nil,
              datos: [String: Any] = [:]) async -> (t: [String: Any], error: Bool, texto: String) {
        await b.proponer(tipo, accion, origen: origen, datos: datos, ref: ref, objetivo: objetivo)
    }

    func id(_ r: (t: [String: Any], error: Bool, texto: String)) -> String { str(r.t["id"]) }

    func agentesJSON(_ f: Fix, _ ids: [String]) -> [[String: Any]] {
        lista(f.oficinaJSON()["agentes"]).filter { ids.contains(str($0["id"])) }
    }

    // MARK: el caso completo

    @Test("las tarjetas del caso coinciden con el mapeo, aplicarlas deja la oficina válida y F1 llega al paso de la persona")
    func casoCompleto() async throws {
        CatalogoConectores.compartido.fijar([Self.calendar, Self.notion])
        defer { CatalogoConectores.compartido.limpiar() }
        let b = try await armar()
        let f = b.f
        let intactosAntes = agentesJSON(f, ["catalina", "patricia", "mario"])
        let mdAntes = ["catalina", "patricia", "mario"].map { f.leer(".claude/agents/\($0).md") }
        let videoAntes = lista(f.oficinaJSON()["departamentos"]).first { str($0["id"]) == "video" }
        #expect(intactosAntes.count == 3 && videoAntes != nil)

        // --- departamentos
        let d2 = await prop(b, "departamento", "modificar",
            origen: "Su misión es convertir tu conocimiento en experiencias educativas de calidad, especialmente para PRÓSPERAS.",
            objetivo: "clases",
            datos: ["nombre": "Departamento de educación",
                    "mision": "Convertir el conocimiento de Juli en experiencias educativas de calidad, especialmente para PRÓSPERAS."])
        #expect(str(d2.t["estado"]) == "lista", "D2: \(d2.texto)")
        // D1: el texto no le da misión: queda en borrador con la pregunta, no con un valor inventado
        let d1 = await prop(b, "departamento", "modificar", origen: "Dirección y operaciones",
                                  objetivo: "dir", datos: ["nombre": "Dirección y operaciones"])
        #expect(str(d1.t["estado"]) == "lista")
        let d1m = b.tarjeta(await b.llamar("marcar_faltante", ["ref": id(d1), "campo": "mision", "pregunta": "¿Cuál es la misión de Dirección y operaciones?"]))
        #expect(str(d1m["estado"]) == "borrador" && b.faltantes(d1m) == ["mision"])
        #expect(dict(d1m["datos"])["mision"] == nil)

        // --- agentes
        let orA1 = "garantizar que Cherry Glow avance de manera organizada, con prioridades claras y sin depender de que vos recuerdes absolutamente todo."
        let a1 = await prop(b, "agente", "modificar", origen: orA1, objetivo: "betty",
            datos: ["rol": "Chief of Staff",
                    "limites": ["solo": ["Armar la agenda, la planificación, el tablero y el reporte de bloqueos"],
                                "proponer": ["Modificar fechas o prioridades estratégicas", "Crear o mover eventos"]]])
        #expect(str(a1.t["estado"]) == "lista", "A1: \(a1.texto)")
        // falta saber si reparte encargos sola (P7): queda en borrador hasta que Juli conteste
        let a1m = b.tarjeta(await b.llamar("marcar_faltante", ["ref": id(a1), "campo": "permisos",
                                                               "pregunta": "¿La Chief of Staff reparte encargos sola o te los propone?"]))
        #expect(str(a1m["estado"]) == "borrador" && b.faltantes(a1m) == ["permisos"])

        let a2 = await prop(b, "agente", "modificar",
            origen: "diseñar clases que realmente enseñen algo y ayuden a las alumnas a implementar lo aprendido.", objetivo: "sofia",
            datos: ["rol": "Directora académica y diseñadora instruccional",
                    "limites": ["solo": ["Investigar, redactar el plan, la ficha, el guion y los materiales"],
                                "proponer": ["El plan curricular y cada guion"]]])
        #expect(str(a2.t["estado"]) == "lista", "A2: \(a2.texto)")

        // A3: no tiene nombre ni instrucciones en el texto
        let orA3 = "transformar los guiones en presentaciones visuales, atractivas y fáciles de utilizar al grabar."
        let a3 = await prop(b, "agente", origen: orA3,
            datos: ["rol": "Diseñadora de presentaciones educativas", "departamento": "clases"])
        #expect(str(a3.t["estado"]) == "borrador" && b.faltantes(a3.t) == ["nombre", "prompt"], "A3: \(a3.texto)")

        let a8 = await prop(b, "agente", "modificar",
            origen: "evaluar qué está funcionando comercialmente y dónde conviene invertir recursos.", objetivo: "nicolas",
            datos: ["rol": "Analista de performance y crecimiento",
                    "limites": ["proponer": ["Cambiar presupuestos o campañas activas"]]])
        #expect(str(a8.t["estado"]) == "lista", "A8: \(a8.texto)")
        let orA9 = "desarrollar anuncios persuasivos, claros y adaptados a cada producto."
        let a9 = await prop(b, "agente", origen: orA9,
            datos: ["rol": "Directora creativa de anuncios y copywriter ADS", "departamento": "ads"])
        #expect(str(a9.t["estado"]) == "borrador" && b.faltantes(a9.t) == ["nombre", "prompt"], "A9: \(a9.texto)")

        // --- las 6 reglas
        let reglas: [(String, String)] = [
            ("Consultar las fuentes disponibles y no inventar métricas, tareas, testimonios ni resultados.",
             "Trabajá desde información real: consultá las fuentes disponibles y no inventes métricas, tareas, testimonios ni resultados."),
            ("No limitarse a sugerencias cuando el agente tiene herramientas para producir el entregable.",
             "Entregá trabajo terminado: no te limites a sugerencias cuando tenés herramientas para producir el entregable."),
            ("Voz, público, productos, posicionamiento y criterios comerciales.",
             "Respetá la identidad de Cherry Glow: voz, público, productos, posicionamiento y criterios comerciales."),
            ("Cada rol tiene una responsabilidad definida y entrega su trabajo al siguiente.",
             "Evitá duplicaciones: cada rol tiene una responsabilidad definida y le entrega su trabajo al siguiente."),
            ("Toda propuesta debe justificar su objetivo y prioridad.",
             "No crees trabajo innecesario: toda propuesta justifica su objetivo y su prioridad."),
            ("Especialmente lanzamientos, inversión, promesas comerciales y publicación de contenidos.",
             "Juli toma las decisiones finales, en especial lanzamientos, inversión, promesas comerciales y publicación de contenidos."),
        ]
        var rs: [String] = []
        for (origen, texto) in reglas {
            let r = await prop(b, "regla", origen: origen, datos: ["texto": texto])
            #expect(str(r.t["estado"]) == "lista", "regla: \(r.texto)")
            rs.append(id(r))
        }
        // R3: falta dónde está la identidad de la marca (K11, K12)
        let r3m = b.tarjeta(await b.llamar("marcar_faltante", ["ref": rs[2], "campo": "texto",
                                                               "pregunta": "¿Dónde está descrita la identidad de Cherry Glow (voz, público, productos)?"]))
        #expect(str(r3m["estado"]) == "borrador" && b.faltantes(r3m) == ["texto"])

        // --- flujos
        let orF1 = "diseño académico → PPT → grabación de Juli → edición → publicación"
        func pasosF1(aprobacionPPT: Bool?) -> [[String: Any]] {
            var ppt: [String: Any] = ["id": "ppt", "nombre": "PPT", "quien": "tarjeta:" + id(a3), "entrega": "PowerPoint editable y notas de presentación"]
            if let aprobacionPPT { ppt["aprobacion"] = aprobacionPPT }
            return [
                ["id": "diseno", "nombre": "Diseño académico", "quien": "sofia", "recibe": "El tema de la clase y el plan curricular",
                 "entrega": "Ficha de clase, guion completo, ejercicios y materiales", "aprobacion": true],
                ppt,
                ["id": "grabacion", "nombre": "Grabación", "quien": "persona", "recibeDe": ["diseno", "ppt"],
                 "entrega": "El archivo de la grabación", "aprobacion": false],
                ["id": "plan", "nombre": "Plan de edición", "quien": "don-armando", "recibeDe": ["grabacion", "diseno", "ppt"],
                 "entrega": "Plan de edición y lista de correcciones", "aprobacion": true],
                ["id": "render", "nombre": "Edición final", "quien": "don-armando", "recibeDe": ["grabacion", "plan"],
                 "entrega": "Video final y .srt", "aprobacion": true],
                ["id": "publicacion", "nombre": "Publicación", "quien": "persona", "recibeDe": ["render"],
                 "entrega": "Hecho", "aprobacion": false],
            ]
        }
        // P9: la persona todavía no dijo si la PPT necesita su aprobación
        let f1 = await prop(b, "flujo", origen: orF1,
                                  datos: ["id": "clase", "nombre": "Producción de una clase", "pasos": pasosF1(aprobacionPPT: nil)])
        #expect(!f1.error, "F1: \(f1.texto)")
        #expect(str(f1.t["estado"]) == "borrador" && b.faltantes(f1.t) == ["pasos[1].aprobacion"], "F1: \(f1.texto)")

        let orF3 = "diagnóstico → hipótesis → guiones ADS → prueba → resultados"
        func pasosF3(aprobacionPrueba: Bool?) -> [[String: Any]] {
            var prueba: [String: Any] = ["id": "prueba", "nombre": "Prueba", "quien": "persona", "entrega": "Grabación y campaña lanzada"]
            if let aprobacionPrueba { prueba["aprobacion"] = aprobacionPrueba }
            return [
                ["id": "datos", "nombre": "Datos de campañas", "quien": "persona", "entrega": "Exportación o capturas de Meta Ads", "aprobacion": false],
                ["id": "diagnostico", "nombre": "Diagnóstico", "quien": "nicolas", "entrega": "Diagnóstico de campañas", "aprobacion": false],
                ["id": "hipotesis", "nombre": "Hipótesis", "quien": "nicolas", "entrega": "Plan de pruebas con hipótesis medibles", "aprobacion": true],
                ["id": "guiones", "nombre": "Guiones ADS", "quien": "tarjeta:" + id(a9), "entrega": "Guiones, briefs de grabación y variantes", "aprobacion": true],
                prueba,
                ["id": "resultados", "nombre": "Resultados", "quien": "nicolas", "recibeDe": ["prueba", "hipotesis"], "esperaDias": 7,
                 "entrega": "Resultados y próximas acciones", "aprobacion": false],
            ]
        }
        let f3 = await prop(b, "flujo", origen: orF3,
                                  datos: ["id": "anuncios", "nombre": "Optimización de anuncios", "pasos": pasosF3(aprobacionPrueba: nil)])
        #expect(str(f3.t["estado"]) == "borrador" && b.faltantes(f3.t) == ["pasos[4].aprobacion"], "F3: \(f3.texto)")
        #expect(lista(dict(f3.t["datos"])["pasos"]).first.map { str($0["quien"]) } == "persona", "F3 empieza con el paso 0 de la persona")

        // --- tareas
        let semanal = await prop(b, "tarea", origen: "Crear el calendario editorial semanal y mensual.",
            datos: ["agente": "marce", "nombre": "Calendario editorial semanal", "consigna": "Armá el calendario editorial de la semana.",
                    "dias": [1], "hora": "09:00"])
        #expect(str(semanal.t["estado"]) == "lista", "T8: \(semanal.texto)")
        let mensual = await prop(b, "tarea", origen: "Preparar revisiones semanales y mensuales de objetivos.",
            datos: ["agente": "betty", "nombre": "Revisión mensual de objetivos", "consigna": "Preparar la revisión mensual de objetivos.",
                    "hora": "09:00", "periodicidad": "mensual"])
        #expect(str(mensual.t["estado"]) == "borrador" && b.faltantes(mensual.t).contains("periodicidad"), "T4: \(mensual.texto)")

        // --- conectores: Calendar está sembrado como disponible, Notion no
        let orC = "Revisar Google Calendar y Notion para organizar tu agenda diaria y semanal."
        let cal = await prop(b, "conector", origen: orC,
            datos: ["agente": "betty", "servidor": "Google Calendar",
                    "leer": ["mcp__claude_ai_Google_Calendar__list_events"], "actuar": ["mcp__claude_ai_Google_Calendar__create_event"]])
        #expect(str(cal.t["estado"]) == "lista", "C1: \(cal.texto)")
        let notion = await prop(b, "conector", origen: orC,
            datos: ["agente": "betty", "servidor": "Notion", "leer": ["mcp__claude_ai_Notion__notion-search"]])
        #expect(str(notion.t["estado"]) == "borrador" && b.pregunta(notion.t).contains("Conectá Notion en claude.ai"), "C2: \(notion.texto)")

        // --- nada se crea solo: hasta acá la oficina sigue igual
        let antes = try OficinaStore.leer(carpeta: f.carpeta)
        #expect(antes.agentes.count == 8 && antes.reglas == nil && antes.flujos == nil && antes.tareas?.isEmpty != false)
        #expect(antes.agente("betty")?.esCoordinador == false)

        // aplicar con un borrador nombrado: 409 con sus faltantes, y no cambia nada
        let bloqueado = await f.post("/api/creador/aplicar", ["ids": [id(d2), id(a3)]])
        #expect(bloqueado.status == 409 && lista(bloqueado.obj["borradores"]).map { str($0["id"]) } == [id(a3)])
        #expect(try OficinaStore.leer(carpeta: f.carpeta).departamento("clases")?.mision == nil)

        // --- Juli contesta lo que faltaba (se actualiza la misma tarjeta con ref)
        let a1ok = await prop(b, "agente", "modificar", origen: orA1, objetivo: "betty", ref: id(a1), datos: ["permisos": ["coordinador"]])
        #expect(str(a1ok.t["estado"]) == "lista", "A1: \(a1ok.texto)")
        let a3ok = await prop(b, "agente", origen: orA3, ref: id(a3),
            datos: ["id": "lucia", "nombre": "Lucía", "prompt": "Sos Lucía, diseñadora de presentaciones educativas de la oficina. Transformás los guiones aprobados en presentaciones claras."])
        #expect(str(a3ok.t["estado"]) == "lista", "A3: \(a3ok.texto)")
        let a9ok = await prop(b, "agente", origen: orA9, ref: id(a9),
            datos: ["id": "camila", "nombre": "Camila", "prompt": "Sos Camila, directora creativa de anuncios y copywriter ADS de la oficina."])
        #expect(str(a9ok.t["estado"]) == "lista", "A9: \(a9ok.texto)")
        let r3ok = await prop(b, "regla", origen: reglas[2].0, ref: rs[2],
            datos: ["texto": "Respetá la identidad de Cherry Glow (voz, público, productos, posicionamiento y criterios comerciales) que está en el contexto maestro de la oficina."])
        #expect(str(r3ok.t["estado"]) == "lista", "R3: \(r3ok.texto)")
        let f1ok = await prop(b, "flujo", origen: orF1, ref: id(f1), datos: ["pasos": pasosF1(aprobacionPPT: true)])
        #expect(str(f1ok.t["estado"]) == "lista", "F1: \(f1ok.texto)")
        let f3ok = await prop(b, "flujo", origen: orF3, ref: id(f3), datos: ["pasos": pasosF3(aprobacionPrueba: false)])
        #expect(str(f3ok.t["estado"]) == "lista", "F3: \(f3ok.texto)")

        // --- aplicar todas las listas (D1, Notion y la tarea mensual siguen en borrador y no se tocan)
        let ap = await f.post("/api/creador/aplicar", [String: Any]())
        #expect(ap.status == 200, "\(ap.obj)")
        let res = lista(ap.obj["resultados"])
        #expect(res.allSatisfy { ($0["ok"] as? Bool) == true }, "\(res)")
        let tj = await b.tarjetas()
        let sinAplicar = [id(d1), id(notion), id(mensual)]
        #expect(sinAplicar.allSatisfy { i in tj.first { $0.id == i }?.estado == "borrador" })
        #expect(tj.filter { $0.estado == "creada" }.count == tj.count - sinAplicar.count)

        // oficina.json es válido (OficinaStore.leer valida) y tiene lo pedido
        let o = try OficinaStore.leer(carpeta: f.carpeta)
        #expect(o.agente("betty")?.esCoordinador == true && o.agente("betty")?.rol == "Chief of Staff")
        #expect(o.agente("betty")?.limites?.proponer?.count == 2)
        #expect(o.agente("betty")?.conectores?.map(\.servidor) == ["Google Calendar"])
        #expect(o.agente("betty")?.conectores?.first?.actuar == ["mcp__claude_ai_Google_Calendar__create_event"])
        #expect(o.reglas?.count == 6)
        #expect(o.reglas?.allSatisfy { !($0.origen ?? "").isEmpty } == true)
        #expect(o.departamento("clases")?.nombre == "Departamento de educación" && o.departamento("clases")?.mision?.contains("PRÓSPERAS") == true)
        #expect(o.departamento("dir")?.nombre == "Dirección", "D1 sigue en borrador: no se renombró")
        #expect(o.agente("lucia")?.departamento == "clases" && o.agente("camila")?.departamento == "ads")
        let clase = try #require(o.flujos?.first { $0.id == "clase" })
        #expect(clase.pasos.count == 6)
        #expect(clase.pasos.map(\.quien) == ["sofia", "lucia", "persona", "don-armando", "don-armando", "persona"])
        #expect(clase.pasos.map(\.aprobacion) == [true, true, false, true, true, false])
        #expect(clase.pasos[3].recibeDe == ["grabacion", "diseno", "ppt"])
        let anuncios = try #require(o.flujos?.first { $0.id == "anuncios" })
        #expect(anuncios.pasos.count == 6 && anuncios.pasos[0].quien == "persona" && anuncios.pasos[3].quien == "camila")
        #expect(anuncios.pasos[5].esperaDias == 7)
        #expect(o.tareas?.map(\.agente) == ["marce"])
        // los agentes que el texto no menciona y el departamento video siguen intactos, con sus archivos
        #expect(igual(agentesJSON(f, ["catalina", "patricia", "mario"]), intactosAntes))
        #expect(["catalina", "patricia", "mario"].map { f.leer(".claude/agents/\($0).md") } == mdAntes)
        #expect(igual(lista(f.oficinaJSON()["departamentos"]).first { str($0["id"]) == "video" } as Any, videoAntes as Any))
        #expect(o.agentes.count == 10)

        // --- F1 con el motor: arranca, espera la aprobación del diseño y de la PPT, y llega al paso de la persona
        let corrida = await f.post("/api/flujos/clase/correr", ["nombre": "Clase 7", "contexto": "Tema: fracciones en el taller"])
        #expect(corrida.status == 200, "\(corrida.obj)")
        let cid = Int(dict(corrida.obj["corrida"])["id"] as? Int ?? 0)
        func estado() async -> String { str(dict((await f.get("/api/flujos/corridas/\(cid)")).obj["corrida"])["estado"]) }
        func esperaEn(_ p: Int, _ e: String) async -> Bool {
            let c = dict((await f.get("/api/flujos/corridas/\(cid)")).obj["corrida"])
            return c["paso"] as? Int == p && str(c["estado"]) == e
        }
        func paso() async -> Int { dict((await f.get("/api/flujos/corridas/\(cid)")).obj["corrida"])["paso"] as? Int ?? -1 }
        func entregaVigente(_ p: Int) async -> Int {
            let ps = lista((await f.get("/api/flujos/corridas/\(cid)")).obj["pasos"])
            guard p < ps.count else { return 0 }
            return Int(dict(lista(ps[p]["intentos"]).last?["entrega"])["id"] as? Int ?? 0)
        }
        #expect(await esperarAsync(hasta: 15) { await estado() == "esperando_aprobacion" })
        #expect(await paso() == 0)
        #expect((await f.post("/api/entregas/\(await entregaVigente(0))/revisada")).status == 200)
        #expect(await esperarAsync(hasta: 15) { await esperaEn(1, "esperando_aprobacion") })
        // el paso de Lucía (agente que se creó recién) corrió con su archivo y las reglas de la oficina
        #expect(f.sb.llamadas.contains { Sandbox.valor($0, "--agent") == "lucia" })
        let deLucia = try #require(f.sb.llamadas.last { Sandbox.valor($0, "--agent") == "lucia" })
        #expect(Sandbox.valor(deLucia, "--permission-mode") == "dontAsk")
        #expect(deLucia.joined(separator: " ").contains("Juli toma las decisiones finales"), "las reglas de la oficina llegan a los agentes nuevos")
        #expect((await f.post("/api/entregas/\(await entregaVigente(1))/revisada")).status == 200)
        #expect(await esperarAsync(hasta: 15) { await estado() == "esperando_persona" })
        #expect(await paso() == 2)
        let av = lista((await f.get("/api/avisos")).obj["avisos"]).first { str($0["id"]) == "flujo:\(cid)" }
        #expect(str(av?["texto"]) == "«Clase 7» te necesita: Grabación")
        // la grabación sube un archivo: el plan de edición recibe la grabación, el guion y la PPT (recibeDe de pasos anteriores)
        let hecho = await f.post("/api/flujos/corridas/\(cid)/hecho",
                                 ["nota": "Grabada", "archivos": [["nombre": "clase7.txt", "base64": Data("video".utf8).base64EncodedString()]]])
        #expect(hecho.status == 200, "\(hecho.obj)")
        #expect(await esperarAsync(hasta: 15) { await esperaEn(3, "esperando_aprobacion") })
        let plan = try #require(f.sb.llamadas.last { Sandbox.valor($0, "--agent") == "don-armando" })
        let consigna = plan.last ?? ""
        #expect(consigna.contains("Paso 4 de 6: Plan de edición"))
        #expect(consigna.contains("Grabada") && consigna.contains("archivos/entregables/persona/\(cid)-2/clase7.txt"))
        #expect(consigna.contains("hola sofia") && consigna.contains("hola lucia"))
    }

    // MARK: misión en departamentos (API)

    @Test("POST y PATCH de departamentos aceptan «mision» (hasta 600; vacía la borra)")
    func misionPorAPI() async throws {
        let f = try await Fix.crear(deps: ["Dirección"])
        let c = await f.post("/api/departamentos", ["nombre": "Ventas", "mision": "  Vender mejor.  "])
        #expect(c.status == 200 && str(dict(c.obj["departamento"])["mision"]) == "Vender mejor.", "\(c.obj)")
        #expect(lista(f.oficinaJSON()["departamentos"]).first { str($0["id"]) == "ventas" }?["mision"] as? String == "Vender mejor.")
        // sin misión: la clave no está
        let sin = await f.post("/api/departamentos", ["nombre": "Soporte"])
        #expect(sin.status == 200 && dict(sin.obj["departamento"])["mision"] == nil)
        // PATCH cambia, no tocar la deja igual, null y vacía la borran
        let p = await f.patch("/api/departamentos/ventas", ["mision": "Vender más."])
        #expect(p.status == 200 && str(dict(p.obj["departamento"])["mision"]) == "Vender más.")
        let otro = await f.patch("/api/departamentos/ventas", ["color": "#112233"])
        #expect(str(dict(otro.obj["departamento"])["mision"]) == "Vender más." && str(dict(otro.obj["departamento"])["color"]) == "#112233")
        let vacia = await f.patch("/api/departamentos/ventas", ["mision": ""])
        #expect(vacia.status == 200 && dict(vacia.obj["departamento"])["mision"] == nil)
        _ = await f.patch("/api/departamentos/ventas", ["mision": "Otra vez."])
        let nula = await f.patch("/api/departamentos/ventas", ["mision": NSNull()])
        #expect(nula.status == 200 && dict(nula.obj["departamento"])["mision"] == nil)
        // tope de 600 caracteres y tipo
        let justo = String(repeating: "m", count: 600)
        #expect((await f.patch("/api/departamentos/ventas", ["mision": justo])).status == 200)
        #expect((await f.patch("/api/departamentos/ventas", ["mision": justo + "m"])).status == 400)
        #expect((await f.post("/api/departamentos", ["nombre": "Larga", "mision": justo + "m"])).status == 400)
        #expect((await f.patch("/api/departamentos/ventas", ["mision": 5])).status == 400)
        #expect(lista(f.oficinaJSON()["departamentos"]).first { str($0["id"]) == "ventas" }?["mision"] as? String == justo)
    }

    // MARK: cruces de la ola 2

    @Test("/api/actividad sigue rápido con 100 corridas abiertas de flujos largos")
    func actividadConMuchasCorridas() async throws {
        let f = try await Fix.crear(deps: ["Dirección"], env: ["HQ_PROGRAMADOR": "0"])
        // 20 pasos de la persona, con textos largos (el tope de cada campo): el peor caso para la definición guardada
        let largo = String(repeating: "texto ", count: 90)
        let pasos: [[String: Any]] = (1...20).map {
            ["id": "p\($0)", "nombre": "Paso \($0)", "quien": "persona", "consigna": String(repeating: "c", count: 3000),
             "recibe": largo, "entrega": largo, "aprobacion": false]
        }
        let r = await f.post("/api/flujos", ["id": "largo", "nombre": "Largo", "pasos": pasos])
        try #require(r.status == 200, "\(r.obj)")
        for i in 1...100 {
            let c = await f.post("/api/flujos/largo/correr", ["nombre": "Corrida \(i)"])
            try #require(c.status == 200, "\(c.obj)")
        }
        let inicio = Date()
        let veces = 10
        var ultimo: Resp = (0, [:])
        for _ in 0..<veces { ultimo = await f.get("/api/actividad") }
        let promedio = Date().timeIntervalSince(inicio) / Double(veces)
        #expect(ultimo.status == 200 && lista(ultimo.obj["corridas"]).count == 100)
        #expect(lista(ultimo.obj["avisos"]).filter { str($0["tipo"]) == "flujo" }.count == 100)
        #expect(promedio < 0.15, "GET /api/actividad tardó \(promedio) s en promedio con 100 corridas")
    }

    @Test("flujo, acción propuesta y encargo del coordinador a la vez: cada gancho toca solo lo suyo")
    func ganchosCruzados() async throws {
        let crear = "mcp__claude_ai_Google_Calendar__create_event", leer = "mcp__claude_ai_Google_Calendar__list_events"
        CatalogoConectores.compartido.fijar([ServidorConector(nombre: "Google Calendar", prefijo: "mcp__claude_ai_Google_Calendar",
                                                              estado: "connected", herramientas: [leer, crear])])
        defer { CatalogoConectores.compartido.limpiar() }
        let f = try await Fix.crear(deps: ["Dirección"], agentes: [("coordi", "direccion", "Chief of Staff"), ("sofia", "direccion", "Académica"),
                                                                     ("nico", "direccion", "Analista")],
                                    env: ["HQ_PROGRAMADOR": "0"])
        let p = await f.patch("/api/agentes/coordi", ["permisos": ["coordinador"],
                                                       "conectores": [["servidor": "Google Calendar", "leer": [leer], "actuar": [crear]]]])
        try #require(p.status == 200, "\(p.obj)")
        let fl = await f.post("/api/flujos", ["nombre": "Clase", "pasos": [
            ["id": "diseno", "nombre": "Diseño", "quien": "sofia", "entrega": "Ficha", "aprobacion": true],
            ["id": "grabacion", "nombre": "Grabación", "quien": "persona", "entrega": "Archivo"]]])
        try #require(fl.status == 200, "\(fl.obj)")
        let cid = Int(dict((await f.post("/api/flujos/clase/correr", ["nombre": "Clase 7"])).obj["corrida"])["id"] as? Int ?? 0)
        func estado() async -> String { str(dict((await f.get("/api/flujos/corridas/\(cid)")).obj["corrida"])["estado"]) }
        #expect(await esperarAsync(hasta: 15) { await estado() == "esperando_aprobacion" })

        // la acción propuesta por el coordinador y el encargo que repartió
        let token = f.b.mcp.tokens.emitir(oficina: f.carpeta, agente: "coordi", sid: U.a, perfil: "coordinador")
        let ident = IdentidadMCP(oficina: f.carpeta, agente: "coordi", sid: U.a, perfil: "coordinador")
        let h = try #require(f.b.mcp.consultas.herramientas(token: token, identidad: ident))
        let nombres = h.definiciones.compactMap { $0["name"] as? String }
        #expect(nombres.contains("proponer_accion") && nombres.contains("encargar"))
        let acc = try #require(await h.llamar("proponer_accion", argumentos: ["herramienta": crear, "resumen": "Crear la reunión", "detalle": ["titulo": "Reunión"]]))
        #expect(!acc.esError, "\(acc.texto)")
        let enc = try #require(await h.llamar("encargar", argumentos: ["agente": "nico", "consigna": "Preparame el informe"]))
        #expect(!enc.esError, "\(enc.texto)")
        #expect(await esperarAsync(hasta: 15) { await f.b.store.entregas(oficina: f.carpeta, origen: "encargo").count == 1 })
        let todas = lista((await f.get("/api/entregas")).obj["entregas"])
        func entrega(_ origen: String) -> [String: Any]? { todas.first { str($0["origen"]) == origen } }
        let eFlujo = try #require(entrega("flujo")), eProp = try #require(entrega("propuesta")), eEnc = try #require(entrega("encargo"))
        func idDe(_ e: [String: Any]) -> Int { e["id"] as? Int ?? 0 }

        // revisar el encargo y la propuesta no mueve la corrida ni ejecuta la acción
        #expect((await f.post("/api/entregas/\(idDe(eEnc))/revisada")).status == 200)
        #expect((await f.post("/api/entregas/\(idDe(eProp))/revisada")).status == 200)
        #expect(await estado() == "esperando_aprobacion")
        let accion = dict((await f.get("/api/acciones", ["entrega": String(idDe(eProp))])).obj["accion"])
        #expect(str(accion["estado"]) == "pendiente")
        // revisar la entrega del flujo avanza la corrida y no toca la acción
        #expect((await f.post("/api/entregas/\(idDe(eFlujo))/revisada")).status == 200)
        #expect(await esperarAsync(hasta: 15) { await estado() == "esperando_persona" })
        #expect(str(dict((await f.get("/api/acciones", ["entrega": String(idDe(eProp))])).obj["accion"])["estado"]) == "pendiente")
        // aprobar la acción (aunque ya se la hubiera marcado «Listo») la ejecuta con esa sola herramienta y no mueve la corrida
        let ej = await f.post("/api/entregas/\(idDe(eProp))/ejecutar")
        #expect(ej.status == 202, "\(ej.obj)")
        #expect(await esperarAsync(hasta: 15) { str(dict((await f.get("/api/acciones", ["entrega": String(idDe(eProp))])).obj["accion"])["estado"]) == "hecha" })
        #expect(await estado() == "esperando_persona")
        let correAccion = try #require(f.sb.llamadas(conPrompt: "exactamente esto").last)
        #expect(Sandbox.reglas(correAccion).contains(crear))
        // la corrida del paso de flujo, en cambio, no tenía la herramienta de actuar
        let correPaso = try #require(f.sb.llamadas(conPrompt: "Paso 1 de 2").first)
        #expect(!Sandbox.reglas(correPaso).contains(crear))
        // tres cosas distintas, tres orígenes y una sola corrida abierta
        let origenes = Set(lista((await f.get("/api/entregas")).obj["entregas"]).map { str($0["origen"]) })
        #expect(origenes.isSuperset(of: ["flujo", "propuesta", "encargo", "accion"]))
        #expect(lista((await f.get("/api/actividad")).obj["corridas"]).count == 1)
    }

    @Test("GobiernoRouter atiende ejecutar y deja pasar el resto de /api/entregas")
    func ordenDeRouters() async throws {
        let f = try await Fix.crear(deps: ["Dirección"], agentes: [("sofia", "direccion", nil)], env: ["HQ_PROGRAMADOR": "0"])
        let act = try #require(await f.b.oficinas.activa())
        _ = try await f.b.programador.encargarLibre(act, try #require(act.oficina.agente("sofia")), id: "coord:abcd1234", nombre: "Algo", consigna: "Hacé algo")
        #expect(await esperarAsync(hasta: 15) { !lista((await f.get("/api/entregas")).obj["entregas"]).isEmpty })
        let e = try #require(lista((await f.get("/api/entregas")).obj["entregas"]).first)
        let id = e["id"] as? Int ?? 0
        // las rutas de entregas que no son del gobierno siguen andando
        #expect((await f.get("/api/entregas/\(id)")).status == 200)
        #expect((await f.post("/api/entregas/\(id)/revisada")).status == 200)
        #expect((await f.post("/api/entregas/\(id)/sin-revisar")).status == 200)
        #expect((await f.get("/api/entregas", ["estado": "sin_revisar"])).status == 200)
        // y las del gobierno las atiende el gobierno: una entrega sin acción da 404 propio, no el genérico de entregas
        let sin = await f.post("/api/entregas/\(id)/ejecutar")
        #expect(sin.status == 404 && str(sin.obj["error"]).contains("acción"), "\(sin.obj)")
        #expect((await f.post("/api/entregas/\(id)/descartar-accion")).status == 404)
    }
}
}
