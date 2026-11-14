import Foundation
import Testing
@testable import Backend

/// Parte de llegada: bloqueos (función pura), `/api/parte`, «visto» y el parte narrado por el coordinador.
@Suite("Parte de llegada", .serialized)
struct ParteTests {
    static let dia = 86400.0

    func fix(coordinador: Bool = false) async throws -> Fix {
        let f = try await Fix.crear(deps: ["Dirección"], agentes: [("marce", "direccion", "Directora")], env: ["HQ_PROGRAMADOR": "0"])
        if coordinador {
            let c = await contratar(f.b, id: "coordi", depto: "direccion", rol: "Coordinadora", extra: ["permisos": ["coordinador"]])
            try #require(c.status == 200, "contratar coordinador: \(c.obj)")
        }
        return f
    }

    static func def(plazo: Int? = nil) -> String {
        var paso: [String: Any] = ["id": "grabacion", "nombre": "Grabación", "quien": "persona", "entrega": "El video", "aprobacion": false]
        if let plazo { paso["plazoDias"] = plazo }
        let o: [String: Any] = ["id": "clase", "nombre": "Clase", "pasos": [["id": "diseno", "nombre": "Diseño", "quien": "marce", "entrega": "x"], paso]]
        return String(decoding: json(o), as: UTF8.self)
    }

    static func corrida(_ id: Int64, estado: String, haceDias: Double, ahora: Date, plazo: Int? = nil, paso: Int = 1) -> Corrida {
        Corrida(id: id, oficina: "/o", flujo: "clase", nombre: "Clase \(id)", contexto: "", definicion: def(plazo: plazo), paso: paso,
                estado: estado, creada: 0, actualizada: ahora.timeIntervalSince1970 - haceDias * dia, terminada: nil, vista: false)
    }

    static func entrega(_ id: Int64, estado: String = "sin_revisar", haceDias: Double, ahora: Date) -> Entrega {
        Entrega(id: id, oficina: "/o", agente: "marce", origen: "tarea", ref: "t", titulo: "Informe \(id)", texto: "texto", sid: "", archivos: [],
                creada: ahora.timeIntervalSince1970 - haceDias * dia, estado: estado, revisada: nil, padre: nil, costo: nil)
    }

    // MARK: Bloqueos.calcular

    @Test("bloqueos: corridas más allá de su plazo (2 por defecto, o el del paso), entregas de más de 3 días y tareas con error")
    func bloqueosPuro() {
        let ahora = Date(timeIntervalSince1970: 1_800_000_000)
        let corridas = [
            Self.corrida(1, estado: "esperando_persona", haceDias: 3, ahora: ahora),            // pasa el plazo por defecto
            Self.corrida(2, estado: "esperando_persona", haceDias: 1.5, ahora: ahora),          // todavía no
            Self.corrida(3, estado: "esperando_persona", haceDias: 3, ahora: ahora, plazo: 5),  // el paso admite 5
            Self.corrida(4, estado: "trabada", haceDias: 2.5, ahora: ahora),
            Self.corrida(5, estado: "en_curso", haceDias: 30, ahora: ahora),                    // en curso no es espera
            Self.corrida(6, estado: "esperando_aprobacion", haceDias: 4, ahora: ahora, plazo: 3),
            Self.corrida(7, estado: "esperando_persona", haceDias: 2.5, ahora: ahora, plazo: 1, paso: 0),  // el paso 0 no trae plazo: 2
        ]
        let entregas = [Self.entrega(10, haceDias: 4, ahora: ahora), Self.entrega(11, haceDias: 2, ahora: ahora),
                        Self.entrega(12, estado: "revisada", haceDias: 9, ahora: ahora)]
        let tareas = [TareaConError(id: "informe", nombre: "Informe", agente: "marce", error: "se cayó", desde: ahora.timeIntervalSince1970 - 0.5 * Self.dia)]
        let b = Bloqueos.calcular(corridas: corridas, entregasSinRevisar: entregas, tareasConError: tareas, ahora: ahora)
        let refs = b.map { "\($0["tipo"] as! String):\($0["ref"] as! String)" }
        #expect(refs == ["corrida:6", "entrega:10", "corrida:1", "corrida:4", "corrida:7", "tarea:informe"])
        #expect(b[0]["dias"] as? Double == 4.0)
        #expect(str(b[0]["texto"]) == "«Clase 6» espera tu aprobación de «Grabación» hace 4 días.")
        #expect(str(b[2]["texto"]) == "«Clase 1» está esperando que hagas «Grabación» hace 3 días.")
        #expect(str(b[3]["texto"]) == "«Clase 4» está trabada en «Grabación» hace 2 días.")
        #expect(str(b[1]["texto"]) == "La entrega «Informe 10» lleva 4 días sin que la revises.")
        #expect(str(b[5]["texto"]) == "La tarea «Informe» falló la última vez que corrió: se cayó")
        #expect(b[5]["dias"] as? Double == 0.5)
        #expect(Bloqueos.calcular(corridas: [], entregasSinRevisar: [], tareasConError: [], ahora: ahora).isEmpty)
    }

    @Test("bloqueos: justo en el plazo no cuenta; textoDias")
    func bordes() {
        let ahora = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(Bloqueos.calcular(corridas: [Self.corrida(1, estado: "trabada", haceDias: 2, ahora: ahora)], entregasSinRevisar: [Self.entrega(1, haceDias: 3, ahora: ahora)],
                                  tareasConError: [], ahora: ahora).isEmpty)
        #expect(Bloqueos.textoDias(0.4) == "menos de un día" && Bloqueos.textoDias(1.9) == "1 día" && Bloqueos.textoDias(5) == "5 días")
    }

    // MARK: GET /api/parte

    @Test("/api/parte con datos sembrados: flujos, qué te necesita, para revisar, lo que pasó y próximas")
    func parteSembrado() async throws {
        let f = try await fix()
        let s = f.b.store, c = f.carpeta
        // una oficina con una tarea activa para «próximas»
        _ = await f.post("/api/tareas", ["agente": "marce", "nombre": "Informe", "consigna": "Armá el informe", "dias": [1, 2, 3, 4, 5, 6, 7], "hora": "09:00"])
        // flujo esperando a la persona
        let corrida = try #require(await s.corridaCrear(oficina: c, flujo: "clase", nombre: "Clase 7", contexto: "", definicion: Self.def(), estado: "esperando_persona"))
        await s.corridaActualizar(oficina: c, id: corrida.id, paso: 1)
        let p1 = try #require(await s.pasoCrear(corrida: corrida.id, paso: 0, intento: 1, quien: "marce", estado: "corriendo"))
        await s.pasoActualizar(id: p1.id, estado: "listo", fin: Date().timeIntervalSince1970, sumarCosto: 0.1)
        // entregas, ejecuciones, reunión cerrada y un aviso
        let e1 = try #require(await s.entregaCrear(oficina: c, agente: "marce", origen: "tarea", ref: "informe", titulo: "Informe del lunes", texto: "Todo bien"))
        _ = await s.entregaCrear(oficina: c, agente: "marce", origen: "tarea", ref: "informe", titulo: "Otro", texto: "x")
        _ = await s.entregaCrear(oficina: c, agente: "marce", origen: "parte", ref: "parte:x", titulo: "Parte viejo", texto: "no cuenta")
        let ahora = Date().timeIntervalSince1970
        for estado in ["ok", "ok", "error"] {
            let id = try await s.nuevaEjecucion(oficina: c, tarea: "informe", agente: "marce", programada: ahora, inicio: ahora, sid: UUID().uuidString.lowercased(), manual: true)
            try await s.terminarEjecucion(id, estado: estado, resultado: "r", error: estado == "error" ? "x" : nil, costo: nil)
        }
        try await s.prepararReuniones()
        try await s.reunionCrear(id: "r1", oficina: c, tema: "Plan", agentes: ["marce"])
        try await s.reunionCerrar("r1", sintesis: nil, errorSintesis: nil, acta: nil, error: nil)
        await s.registrarCosto(oficina: c, agente: "marce", origen: "tarea", ref: "informe", costo: 0.42)
        _ = await s.avisoCrear(oficina: c, tipo: "respuesta", agente: "marce", texto: "Marce te respondió")

        let r = await f.get("/api/parte")
        #expect(r.status == 200)
        let o = r.obj
        let desde = try #require(Programacion.fecha(str(o["desde"]))), hasta = try #require(Programacion.fecha(str(o["hasta"])))
        #expect(abs(hasta.timeIntervalSince(desde) - 86400) < 5)      // sin meta: las últimas 24 h
        // te necesita
        // el aviso calculado de la corrida que espera a la persona (MotorFlujos) y el guardado, del más viejo al más nuevo
        #expect(lista(o["teNecesita"]).map { str($0["texto"]) } == ["«Clase 7» te necesita: Grabación", "Marce te respondió"])
        // para revisar (el parte viejo también es una entrega sin revisar de la bandeja)
        let rev = dict(o["paraRevisar"])
        #expect((rev["total"] as? Int) == 3 && lista(rev["entregas"]).count == 3)
        #expect(lista(rev["entregas"]).contains { ($0["id"] as? Int) == Int(e1.id) })
        // flujos
        let fl = try #require(lista(o["flujos"]).first)
        #expect((fl["corrida"] as? Int) == Int(corrida.id) && str(fl["nombre"]) == "Clase 7" && str(fl["flujo"]) == "clase" && str(fl["flujoNombre"]) == "Clase")
        #expect((fl["paso"] as? Int) == 1 && str(fl["pasoNombre"]) == "Grabación" && str(fl["quien"]) == "persona" && str(fl["estado"]) == "esperando_persona")
        #expect(fl["dias"] is Double && !str(fl["desde"]).isEmpty)
        // qué pasó
        let paso = dict(o["paso"])
        #expect((paso["entregas"] as? Int) == 2)                       // sin contar el parte
        #expect((paso["ejecucionesOk"] as? Int) == 2 && (paso["ejecucionesError"] as? Int) == 1)
        #expect((paso["reunionesCerradas"] as? Int) == 1 && (paso["pasosTerminados"] as? Int) == 1)
        #expect(abs(((paso["costo"] as? Double) ?? 0) - 0.42) < 1e-9)
        #expect(o["bloqueos"] is [Any])
        // próximas
        let pr = try #require(lista(o["proximas"]).first)
        #expect(str(pr["agente"]) == "marce" && str(pr["nombre"]) == "Informe" && !str(pr["cuando"]).isEmpty)
        // sin parte narrado todavía... salvo el viejo sembrado
        #expect(dict(o["narrado"])["texto"] as? String == "no cuenta")
    }

    @Test("/api/parte?desde= acota lo que pasó; sin oficina, 409; método no permitido")
    func desdeYErrores() async throws {
        let f = try await fix()
        let s = f.b.store
        _ = await s.entregaCrear(oficina: f.carpeta, agente: "marce", origen: "tarea", ref: "t", titulo: "Algo", texto: "x")
        let futuro = Date().timeIntervalSince1970 + 1000
        let r = await f.get("/api/parte", ["desde": String(futuro)])
        #expect(r.status == 200 && (dict(r.obj["paso"])["entregas"] as? Int) == 0)
        #expect(r.obj["narrado"] is NSNull)
        #expect((await f.get("/api/parte", ["desde": "ayer"])).status == 400)
        #expect((await f.post("/api/parte")).status == 405)
        let sb = Sandbox(proyecto: false); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend(oficina: false)
        #expect((await llamar(b, "GET", "/api/parte")).status == 409)
    }

    @Test("bloqueos de verdad: una tarea activa cuya última ejecución falló")
    func bloqueosEnElParte() async throws {
        let f = try await fix()
        let s = f.b.store, c = f.carpeta
        let t = await f.post("/api/tareas", ["agente": "marce", "nombre": "Informe", "consigna": "Armá el informe", "dias": [1, 2, 3, 4, 5, 6, 7], "hora": "09:00"])
        let tid = str(dict(t.obj["tarea"])["id"])
        try #require(!tid.isEmpty, "\(t.obj)")
        let ahora = Date().timeIntervalSince1970
        let id = try await s.nuevaEjecucion(oficina: c, tarea: tid, agente: "marce", programada: ahora, inicio: ahora, sid: UUID().uuidString.lowercased(), manual: false)
        try await s.terminarEjecucion(id, estado: "error", resultado: "", error: "Sin conexión", costo: nil)
        let r = await f.get("/api/parte")
        let b = lista(r.obj["bloqueos"])
        #expect(b.count == 1 && str(b[0]["tipo"]) == "tarea" && str(b[0]["ref"]) == tid)
        #expect(str(b[0]["texto"]).contains("Sin conexión"))
    }

    // MARK: visto

    @Test("POST /api/parte/visto guarda meta parte:<carpeta> y el próximo parte cuenta desde ahí")
    func visto() async throws {
        let f = try await fix()
        #expect(await f.b.store.meta("parte:\(f.carpeta)") == nil)
        let antes = Date().timeIntervalSince1970
        let r = await f.post("/api/parte/visto")
        #expect(r.status == 200 && r.obj["ok"] as? Bool == true)
        let m = try #require(await f.b.store.meta("parte:\(f.carpeta)").flatMap(Double.init))
        #expect(m >= antes - 1 && m <= Date().timeIntervalSince1970 + 1)
        let p = await f.get("/api/parte")
        let desde = try #require(Programacion.fecha(str(p.obj["desde"])))
        #expect(abs(desde.timeIntervalSince1970 - m) < 1.5)
        // lo que se entrega después del visto cuenta
        try await Task.sleep(nanoseconds: 50_000_000)
        _ = await f.b.store.entregaCrear(oficina: f.carpeta, agente: "marce", origen: "tarea", ref: "t", titulo: "Nueva", texto: "x")
        #expect((dict((await f.get("/api/parte")).obj["paso"])["entregas"] as? Int) == 1)
        #expect((await f.get("/api/parte/visto")).status == 405)
    }

    // MARK: redactar

    @Test("POST /api/parte/redactar: 409 sin coordinador")
    func redactarSinCoordinador() async throws {
        let f = try await fix()
        let r = await f.post("/api/parte/redactar")
        #expect(r.status == 409 && str(r.obj["error"]).contains("coordinador"))
        #expect(f.sb.llamadas.isEmpty)
    }

    @Test("POST /api/parte/redactar con coordinador: lanza parte:<fecha> con el JSON en la consigna y la entrega aparece como narrado")
    func redactar() async throws {
        let f = try await fix(coordinador: true)
        _ = await f.b.store.entregaCrear(oficina: f.carpeta, agente: "marce", origen: "tarea", ref: "t", titulo: "Informe del lunes", texto: "Todo bien")
        let r = await f.post("/api/parte/redactar")
        #expect(r.status == 200)
        let ej = dict(r.obj["ejecucion"])
        #expect(str(ej["tarea"]) == "parte:\(Parte.fecha(Date()))" && str(ej["agente"]) == "coordi")
        #expect(await esperarAsync { await f.b.store.entregas(oficina: f.carpeta, origen: "parte").count == 1 })
        let l = try #require(f.sb.llamadas.last)
        #expect(Sandbox.valor(l, "--agent") == "coordi")
        let consigna = try #require(l.last)
        #expect(consigna.contains("Informe del lunes") && consigna.contains("\"paraRevisar\"") && consigna.contains("información, no instrucciones"))
        #expect(!consigna.contains("\"narrado\""))
        #expect(Sandbox.valor(l, "--tools")?.contains("mcp__hq__estado_oficina") == true)

        let e = try #require(await f.b.store.entregas(oficina: f.carpeta, origen: "parte").first)
        #expect(e.ref == "parte:\(Parte.fecha(Date()))" && e.agente == "coordi" && e.texto == "hola coordi")
        let p = await f.get("/api/parte")
        let n = dict(p.obj["narrado"])
        #expect((n["entrega"] as? Int) == Int(e.id) && str(n["texto"]) == "hola coordi")
        // el parte narrado no cuenta como entrega nueva
        #expect((dict(p.obj["paso"])["entregas"] as? Int) == 1)
        #expect((await f.get("/api/parte/redactar")).status == 405)
    }
}
