import Foundation
import Testing
@testable import Backend

// Motor de flujos, corridas y API /api/flujos (docs/plan-creador-flujos.md §7). Siempre con el claude falso y con
// HQ_PROGRAMADOR=0 (sin bucles en segundo plano: los tests llaman a `barrer` a mano).

@Suite("Flujos: motor, corridas y API", .serialized)
struct FlujosTests {
    /// Flujo de 3 pasos: A (Sofía, con aprobación) → la persona → B (Armando, sin aprobación, recibe de la persona y de A).
    static let pasos3: [[String: Any]] = [
        ["id": "diseno", "nombre": "Diseño", "quien": "sofia", "consigna": "Diseñá la clase", "recibe": "El tema",
         "entrega": "Ficha y guion", "aprobacion": true],
        ["id": "grabacion", "nombre": "Grabación", "quien": "persona", "entrega": "El archivo de la grabación"],
        ["id": "edicion", "nombre": "Edición", "quien": "armando", "recibeDe": ["grabacion", "diseno"],
         "entrega": "Video final", "aprobacion": false],
    ]

    func fix() async throws -> Fix {
        try await Fix.crear(deps: ["Dirección"], agentes: [("sofia", "direccion", "Directora académica"), ("armando", "direccion", "Editor")],
                            env: ["HQ_PROGRAMADOR": "0"])
    }

    @discardableResult
    func definir(_ f: Fix, _ pasos: [[String: Any]] = pasos3, nombre: String = "Clase") async throws -> String {
        let r = await f.post("/api/flujos", ["nombre": nombre, "pasos": pasos])
        try #require(r.status == 200, "\(r.obj)")
        return str(dict(r.obj["flujo"])["id"])
    }

    func correr(_ f: Fix, _ flujo: String, nombre: String = "Clase 7", contexto: String? = nil) async throws -> Int {
        var d: [String: Any] = ["nombre": nombre]
        if let contexto { d["contexto"] = contexto }
        let r = await f.post("/api/flujos/\(flujo)/correr", d)
        try #require(r.status == 200, "\(r.obj)")
        return Int(dict(r.obj["corrida"])["id"] as? Int ?? 0)
    }

    func corrida(_ f: Fix, _ id: Int) async -> [String: Any] { dict((await f.get("/api/flujos/corridas/\(id)")).obj["corrida"]) }
    func pasos(_ f: Fix, _ id: Int) async -> [[String: Any]] { lista((await f.get("/api/flujos/corridas/\(id)")).obj["pasos"]) }
    func intentos(_ f: Fix, _ id: Int, _ paso: Int) async -> [[String: Any]] {
        let p = await pasos(f, id)
        return paso < p.count ? lista(p[paso]["intentos"]) : []
    }

    func esperaEstado(_ f: Fix, _ id: Int, _ estado: String) async -> Bool {
        await esperarAsync { str(await corrida(f, id)["estado"]) == estado }
    }

    func post(_ f: Fix, _ id: Int, _ accion: String, _ body: Any? = nil) async -> Resp {
        await f.post("/api/flujos/corridas/\(id)/\(accion)", body)
    }

    func entregaVigente(_ f: Fix, _ id: Int, _ paso: Int) async -> Int {
        let i = await intentos(f, id, paso)
        return Int(dict(i.last?["entrega"])["id"] as? Int ?? 0)
    }

    // MARK: el recorrido completo

    @Test("A con aprobación: espera; versión vieja no avanza; con cambios y revisando la vigente avanza; la persona; B; termina")
    func recorrido() async throws {
        let f = try await fix()
        let flujo = try await definir(f)
        let c = try await correr(f, flujo, contexto: "Tema: fracciones")

        // el paso A corre y su entrega deja la corrida esperando aprobación
        #expect(await esperaEstado(f, c, "esperando_aprobacion"))
        let a1 = await entregaVigente(f, c, 0)
        #expect(a1 > 0)
        let e1 = dict((await f.get("/api/entregas/\(a1)")).obj["entrega"])
        #expect(str(e1["origen"]) == "flujo" && str(e1["agente"]) == "sofia" && str(e1["ref"]) == "flujo:\(c):0:1")
        #expect(str(e1["titulo"]) == "Clase 7 · Diseño")
        let paso0 = try #require(await intentos(f, c, 0).first)
        #expect(str(paso0["estado"]) == "esperando_aprobacion" && (paso0["costo"] as? Double ?? 0) > 0)
        // la consigna llevó el flujo, el paso y el contexto, y termina con la carpeta de entrega
        let consigna = try #require(f.sb.prompts.first)
        #expect(consigna.contains("Paso 1 de 3: Diseño") && consigna.contains("Diseñá la clase") && consigna.contains("Tema: fracciones"))
        #expect(consigna.hasSuffix("Dejá lo que entregues en archivos/entregables/flujo-\(c)-0-1/."))
        // la entrega aparece al filtrar las corridas por entrega
        let porEntrega = lista((await f.get("/api/flujos/corridas", ["entrega": String(a1)])).obj["corridas"])
        #expect(porEntrega.map { str($0["nombre"]) } == ["Clase 7"])

        // pido cambios: nace una versión nueva y la anterior pasa a «cambios»
        #expect((await f.post("/api/entregas/\(a1)/cambios", ["texto": "Hacelo más corto"])).status == 202)
        #expect(await esperarAsync { await entregaVigente(f, c, 0) != a1 })
        let a2 = await entregaVigente(f, c, 0)
        #expect(str(await corrida(f, c)["estado"]) == "esperando_aprobacion")
        // revisar la versión vieja: 409, y no avanza
        #expect((await f.post("/api/entregas/\(a1)/revisada")).status == 409)
        #expect(str(await corrida(f, c)["estado"]) == "esperando_aprobacion")
        // revisar la vigente avanza hasta la persona
        #expect((await f.post("/api/entregas/\(a2)/revisada")).status == 200)
        #expect(await esperaEstado(f, c, "esperando_persona"))
        #expect(str(await intentos(f, c, 0)[0]["estado"]) == "listo")

        // el aviso «te necesita» aparece en /api/avisos y se marca como visto
        let av = lista((await f.get("/api/avisos")).obj["avisos"]).first { str($0["id"]) == "flujo:\(c)" }
        #expect(av != nil && str(av?["tipo"]) == "flujo" && str(av?["texto"]) == "«Clase 7» te necesita: Grabación")
        // y en /api/actividad la corrida abierta
        let act = lista((await f.get("/api/actividad")).obj["corridas"])
        #expect(act.count == 1 && str(act[0]["pasoNombre"]) == "Grabación" && str(act[0]["quien"]) == "persona" && str(act[0]["anterior"]) == "sofia")
        #expect((await f.post("/api/avisos/visto", ["id": "flujo:\(c)"])).obj["vistos"] as? Int == 1)
        #expect(!lista((await f.get("/api/avisos")).obj["avisos"]).contains { str($0["id"]) == "flujo:\(c)" })

        // «hecho» con un archivo y una nota: la persona entrega, la entrega queda revisada y pasa a B
        let b64 = Data("video".utf8).base64EncodedString()
        let h = await post(f, c, "hecho", ["nota": "Grabé con el celular", "archivos": [["nombre": "toma1.txt", "base64": b64]]])
        #expect(h.status == 200, "\(h.obj)")
        #expect(f.leer("archivos/entregables/persona/\(c)-1/toma1.txt") == "video")
        #expect(await esperaEstado(f, c, "terminada"))
        let ip = try #require(await intentos(f, c, 1).first)
        let ep = dict((await f.get("/api/entregas/\(Int(dict(ip["entrega"])["id"] as? Int ?? 0))")).obj["entrega"])
        #expect(str(ep["origen"]) == "persona" && str(ep["agente"]) == "" && str(ep["estado"]) == "revisada")
        #expect(ep["archivos"] as? [String] == ["archivos/entregables/persona/\(c)-1/toma1.txt"])
        // recibeDe se ve en la consigna de B: lo de la persona y lo de A, no «el anterior» solamente
        let deB = try #require(f.sb.prompts.last)
        #expect(deB.contains("Paso 3 de 3: Edición") && deB.contains("Grabé con el celular") && deB.contains("archivos/entregables/persona/\(c)-1/toma1.txt"))
        #expect(deB.contains("hola sofia"))
        #expect(deB.range(of: "Paso «Grabación»")!.lowerBound < deB.range(of: "Paso «Diseño»")!.lowerBound, "respeta el orden de recibeDe")
        // la corrida terminó y dejó un aviso guardado
        let av2 = lista((await f.get("/api/avisos")).obj["avisos"]).first { str($0["tipo"]) == "flujo" }
        #expect(str(av2?["texto"]) == "«Clase 7» terminó" && str(av2?["ref"]) == String(c))
        #expect(lista((await f.get("/api/actividad")).obj["corridas"]).isEmpty)
        // el detalle trae pasos con intentos y entregas
        let det = await pasos(f, c)
        #expect(det.count == 3 && str(dict(det[0]["def"])["nombre"]) == "Diseño" && lista(det[0]["intentos"]).count == 1)
        #expect(dict(lista(det[2]["intentos"])[0]["entrega"])["titulo"] as? String == "Clase 7 · Edición")
        // las terminadas salen en su filtro y no en las abiertas
        #expect(lista((await f.get("/api/flujos/corridas")).obj["corridas"]).isEmpty)
        #expect(lista((await f.get("/api/flujos/corridas", ["estado": "terminadas"])).obj["corridas"]).count == 1)
        #expect(lista((await f.get("/api/flujos/corridas", ["estado": "todas", "flujo": "otro"])).obj["corridas"]).isEmpty)
        // costo con origen «flujo»
        #expect((dict((await f.get("/api/costos")).obj["origenes"])["flujo"] as? Double ?? 0) > 0)
    }

    // MARK: trabas

    @Test("un agente inexistente la deja trabada (sin asignar); contratarlo y reintentar la destraba")
    func agenteInexistente() async throws {
        let f = try await fix()
        let flujo = try await definir(f, [["id": "uno", "nombre": "Uno", "quien": "fantasma", "entrega": "algo"]])
        let l = lista((await f.get("/api/flujos")).obj["flujos"])
        #expect(l.count == 1 && l[0]["sinAsignar"] as? [String] == ["uno"])
        let c = try await correr(f, flujo)
        #expect(str(await corrida(f, c)["estado"]) == "trabada")
        let p = try #require(await intentos(f, c, 0).first)
        #expect(str(p["estado"]) == "error" && str(p["nota"]).contains("fantasma"))
        #expect(await pasos(f, c)[0]["sinAsignar"] as? Bool == true)
        #expect(f.sb.llamadas.isEmpty)

        // reintentar con la corrida trabada y el agente todavía ausente: vuelve a trabarse, con un intento más
        #expect((await post(f, c, "reintentar")).status == 200)
        let dos = await intentos(f, c, 0)
        #expect(str(await corrida(f, c)["estado"]) == "trabada" && dos.count == 2)

        await contratar(f.b, id: "fantasma", depto: "direccion")
        #expect((await post(f, c, "reintentar")).status == 200)
        #expect(await esperaEstado(f, c, "terminada"))
        let i = await intentos(f, c, 0)
        #expect(i.count == 3 && str(i[2]["estado"]) == "listo" && str(i[2]["quien"]) == "fantasma")
        // ya no está trabada: reintentar de nuevo es 409
        #expect((await post(f, c, "reintentar")).status == 409)
    }

    @Test("el modo error del claude falso deja el paso en error y la corrida trabada; reintentar con el agente sano la termina")
    func modoError() async throws {
        let f = try await fix()
        let flujo = try await definir(f, [["id": "uno", "nombre": "Uno", "quien": "sofia", "entrega": "algo"]])
        f.sb.modo("sofia", "error")
        let c = try await correr(f, flujo)
        #expect(await esperaEstado(f, c, "trabada"))
        let p = try #require(await intentos(f, c, 0).first)
        #expect(str(p["estado"]) == "error" && str(p["nota"]).contains("fallo raro"))
        #expect(await esperarAsync { lista((await f.get("/api/avisos")).obj["avisos"]).contains { str($0["tipo"]) == "error" } })
        f.sb.modo("sofia", nil)
        #expect((await post(f, c, "reintentar")).status == 200)
        #expect(await esperaEstado(f, c, "terminada"))
    }

    @Test("barrer reconcilia un paso que sigue «corriendo» aunque la ejecución ya terminó en error")
    func barrerReconcilia() async throws {
        let f = try await fix()
        let flujo = try await definir(f, [["id": "uno", "nombre": "Uno", "quien": "sofia", "entrega": "algo"]])
        f.sb.modo("sofia", "puerta")
        let c = try await correr(f, flujo)
        #expect(str(try #require(await intentos(f, c, 0).first)["estado"]) == "corriendo")
        // la ejecución se da por muerta (como si la app se hubiera cerrado) mientras el paso sigue «corriendo»
        let ej = try #require(await intentos(f, c, 0).first?["ejecucion"] as? Int)
        try await f.b.store.terminarEjecucion(Int64(ej), estado: "error", resultado: "", error: "Interrumpida", costo: nil)
        await f.b.motor.barrer()
        #expect(str(await corrida(f, c)["estado"]) == "trabada")
        #expect(str(try #require(await intentos(f, c, 0).first)["estado"]) == "error")
        f.sb.abrirPuerta()
    }

    // MARK: espera, volver y acciones

    @Test("un paso con esperaDias arranca cuando barrer corre con la fecha adelantada")
    func esperaDias() async throws {
        let f = try await fix()
        let flujo = try await definir(f, [
            ["id": "a", "nombre": "A", "quien": "sofia", "entrega": "algo"],
            ["id": "b", "nombre": "Medición", "quien": "armando", "entrega": "números", "esperaDias": 7],
        ])
        let c = try await correr(f, flujo)
        #expect(await esperarAsync { (await intentos(f, c, 1)).first.map { str($0["estado"]) } == "pendiente" })
        #expect(str(await corrida(f, c)["estado"]) == "en_curso")
        await f.b.motor.barrer(ahora: Date().addingTimeInterval(6 * 86400))
        #expect(str(try #require(await intentos(f, c, 1).first)["estado"]) == "pendiente")
        #expect(f.sb.llamadas.count == 1)
        await f.b.motor.barrer(ahora: Date().addingTimeInterval(8 * 86400))
        #expect(await esperaEstado(f, c, "terminada"))
        #expect(f.sb.llamadas.count == 2)
    }

    @Test("volver reabre un paso anterior con un intento nuevo y la nota va en la consigna")
    func volver() async throws {
        let f = try await fix()
        let flujo = try await definir(f, [
            ["id": "a", "nombre": "A", "quien": "sofia", "entrega": "algo"],
            ["id": "p", "nombre": "Grabación", "quien": "persona", "entrega": "video"],
        ])
        let c = try await correr(f, flujo)
        #expect(await esperaEstado(f, c, "esperando_persona"))
        #expect((await post(f, c, "volver", ["paso": 1])).status == 200, "igual al actual: se reabre")
        #expect((await post(f, c, "volver", ["paso": 2])).status == 409)
        #expect((await post(f, c, "volver", ["paso": -1])).status == 400)
        #expect((await post(f, c, "volver", [:])).status == 400)
        let r = await post(f, c, "volver", ["paso": 0, "nota": "Hacelo más corto"])
        #expect(r.status == 200, "\(r.obj)")
        #expect(dict(r.obj["corrida"])["paso"] as? Int == 0)
        #expect(await esperaEstado(f, c, "esperando_persona"))
        let i = await intentos(f, c, 0)
        #expect(i.count == 2 && str(i[1]["estado"]) == "listo" && str(i[1]["nota"]) == "Hacelo más corto")
        #expect(f.sb.prompts.last?.contains("Hacelo más corto") == true)
        #expect(f.sb.prompts.last?.contains("Dejá lo que entregues en archivos/entregables/flujo-\(c)-0-2/.") == true)
        // el paso de la persona quedó con dos intentos (el reabierto y el nuevo)
        #expect((await intentos(f, c, 1)).count >= 2)
    }

    @Test("acciones fuera de lugar responden 409 o 404; hecho valida los nombres de archivo")
    func accionesInvalidas() async throws {
        let f = try await fix()
        let flujo = try await definir(f, [
            ["id": "a", "nombre": "A", "quien": "persona", "entrega": "algo"],
            ["id": "b", "nombre": "B", "quien": "persona", "entrega": "otro"],
        ])
        let c = try await correr(f, flujo)
        #expect(await esperaEstado(f, c, "esperando_persona"))
        #expect((await post(f, c, "reintentar")).status == 409)
        #expect((await post(f, 9999, "hecho")).status == 404)
        #expect((await f.get("/api/flujos/corridas/9999")).status == 404)
        let b64 = Data("x".utf8).base64EncodedString()
        for mal in ["../x.txt", "a/b.txt", "..", String(repeating: "n", count: 121)] {
            let r = await post(f, c, "hecho", ["archivos": [["nombre": mal, "base64": b64]]])
            #expect(r.status == 400, "\(mal.prefix(10)): \(r.obj)")
        }
        #expect((await post(f, c, "hecho", ["archivos": [["nombre": "ok.txt", "base64": "%%%no"]]])).status == 400)
        #expect(await esperaEstado(f, c, "esperando_persona"))
        // hecho sin nada avanza; la siguiente espera a la persona; saltar la da por hecha; la corrida termina
        #expect((await post(f, c, "hecho")).status == 200)
        let tras = await corrida(f, c)
        #expect(str(tras["estado"]) == "esperando_persona" && tras["paso"] as? Int == 1)
        let saltada = await post(f, c, "saltar")
        #expect(saltada.status == 200 && str(dict(saltada.obj["corrida"])["estado"]) == "terminada")
        #expect(str(try #require(await intentos(f, c, 1).first)["estado"]) == "saltado")
        // una corrida terminada no admite nada más
        for a in ["hecho", "saltar", "cancelar", "reintentar"] { #expect((await post(f, c, a)).status == 409, "\(a)") }
        #expect((await post(f, c, "volver", ["paso": 0])).status == 409)

        // cancelar
        let c2 = try await correr(f, flujo, nombre: "Otra")
        #expect(await esperaEstado(f, c2, "esperando_persona"))
        let can = await post(f, c2, "cancelar")
        #expect(can.status == 200 && str(dict(can.obj["corrida"])["estado"]) == "cancelada")
        #expect(str(try #require(await intentos(f, c2, 0).first)["estado"]) == "cancelado")
        #expect((await post(f, c2, "cancelar")).status == 409)
        #expect(lista((await f.get("/api/flujos/corridas", ["estado": "terminadas"])).obj["corridas"]).count == 2)
    }

    // MARK: API de definiciones

    @Test("CRUD de flujos: crea, edita, borra; 'corridas' no sirve de id; sin oficina 409; validaciones")
    func crud() async throws {
        let f = try await fix()
        let r = await f.post("/api/flujos", ["nombre": "Corridas", "pasos": [["nombre": "Uno", "quien": "sofia", "entrega": "x"]]])
        #expect(r.status == 200)
        let id = str(dict(r.obj["flujo"])["id"])
        #expect(id != "corridas" && !id.isEmpty)
        #expect(str(dict(r.obj["flujo"])["creado"]) != "")
        #expect((await f.post("/api/flujos", ["nombre": "Sin pasos", "pasos": []])).status == 400)
        #expect((await f.post("/api/flujos", ["pasos": [["nombre": "Uno", "quien": "sofia", "entrega": "x"]]])).status == 400)

        let p = await f.patch("/api/flujos/\(id)", ["nombre": "Nuevo nombre", "activo": false])
        #expect(p.status == 200 && str(dict(p.obj["flujo"])["nombre"]) == "Nuevo nombre" && dict(p.obj["flujo"])["activo"] as? Bool == false)
        #expect(lista(dict(p.obj["flujo"])["pasos"]).count == 1)
        #expect((await f.patch("/api/flujos/\(id)", ["pasos": []])).status == 400)
        #expect((await f.patch("/api/flujos/nada", ["nombre": "x"])).status == 404)
        // pausado: no se corre
        #expect((await f.post("/api/flujos/\(id)/correr", ["nombre": "x"])).status == 409)
        #expect((await f.patch("/api/flujos/\(id)", ["activo": true])).status == 200)
        #expect((await f.post("/api/flujos/\(id)/correr", [:])).status == 400)
        #expect((await f.post("/api/flujos/\(id)/correr", ["nombre": String(repeating: "n", count: 81)])).status == 400)
        #expect((await f.post("/api/flujos/\(id)/correr", ["nombre": "ok", "contexto": String(repeating: "c", count: 4001)])).status == 400)
        #expect((await f.post("/api/flujos/nada/correr", ["nombre": "x"])).status == 404)

        #expect((await f.delete("/api/flujos/\(id)")).status == 200)
        #expect(lista((await f.get("/api/flujos")).obj["flujos"]).isEmpty)
        #expect((await f.delete("/api/flujos/\(id)")).status == 404)
        #expect((await llamar(f.b, "PUT", "/api/flujos")).status == 405)

        let sin = try Sandbox().backend(env: ["HQ_PROGRAMADOR": "0"], oficina: false)
        #expect((await llamar(sin, "GET", "/api/flujos")).status == 409)
        #expect((await llamar(sin, "GET", "/api/flujos/corridas")).status == 409)
    }

    @Test("borrar el flujo no mata las corridas vivas: siguen con su copia de la definición")
    func borrarConCorridasVivas() async throws {
        let f = try await fix()
        let flujo = try await definir(f, [
            ["id": "a", "nombre": "A", "quien": "persona", "entrega": "algo"],
            ["id": "b", "nombre": "B", "quien": "persona", "entrega": "otro"],
        ])
        let c = try await correr(f, flujo)
        #expect((await f.delete("/api/flujos/\(flujo)")).status == 200)
        #expect((await post(f, c, "hecho")).status == 200)
        #expect(str(await corrida(f, c)["pasoNombre"]) == "B")
    }

    // MARK: consigna

    @Test("consigna: recorta cada entrega a 3000 caracteres, la sanea y termina con la carpeta de entrega")
    func consignaPura() {
        let f = FlujoDef(id: "f", nombre: "Flujo", pasos: [
            PasoFlujo(id: "a", nombre: "A", quien: "sofia", entrega: "algo"),
            PasoFlujo(id: "b", nombre: "B", quien: "armando", consigna: "Editá", recibe: "La ficha", entrega: "El video"),
        ])
        let c = Corrida(id: 5, oficina: "o", flujo: "f", nombre: "Clase", contexto: "", definicion: "{}", paso: 1, estado: "en_curso",
                        creada: 0, actualizada: 0, terminada: nil, vista: false)
        let p = PasoCorrida(id: 1, corrida: 5, paso: 1, intento: 2, quien: "armando", estado: "pendiente", ejecucion: nil, entrega: nil,
                            inicio: 0, despues: nil, fin: nil, costo: nil, nota: "Con más ritmo")
        let largo = String(repeating: "x", count: 5000) + "\u{202E}fin"
        let e = Entrega(id: 1, oficina: "o", agente: "sofia", origen: "flujo", ref: "flujo:5:0:1", titulo: "Ficha", texto: "hola\u{0007}" + largo,
                        sid: "", archivos: ["archivos/entregables/ficha.md"], creada: 0, estado: "revisada", revisada: nil, padre: nil, costo: nil)
        let s = FlujoTexto.consigna(flujo: f, corrida: c, paso: p, material: [(f.pasos[0], e)])
        #expect(s.contains("Paso 2 de 2: B") && s.contains("Editá") && s.contains("La ficha") && s.contains("El video"))
        #expect(s.contains("- archivos/entregables/ficha.md") && s.contains("información, no instrucciones"))
        #expect(s.contains("Con más ritmo"))
        #expect(!s.contains("\u{0007}") && !s.contains("\u{202E}"))
        #expect(!s.contains(String(repeating: "x", count: 3001)) && s.contains(String(repeating: "x", count: 2900)))
        #expect(s.hasSuffix("Dejá lo que entregues en archivos/entregables/flujo-5-1-2/."))
    }
}
