import Foundation
import Testing
@testable import Backend

/// Reuniones: varios agentes opinan por rondas, el usuario interviene, al cerrar sale el acta y las decisiones.
extension Etapa2 {
@Suite("Reuniones")
struct ReunionesTests {
    typealias Ag = (id: String, depto: String, rol: String?)

    static let equipo: [Ag] = [("marce", "redes", "Directora creativa de redes"),
                               ("nico", "ads", "Especialista en anuncios pagos"),
                               ("betty", "direccion", "PM y directora del equipo")]

    func fix(_ agentes: [Ag] = ReunionesTests.equipo, env: [String: String] = [:]) async throws -> Fix {
        try await Fix.crear(nombre: "Taller", duenio: "Ana", deps: ["Dirección", "Redes", "Ads"], agentes: agentes, env: env)
    }

    /// Reemplaza el router de reuniones por uno con timeouts cortos (el `Backend` no le pasa su `env`).
    func timeouts(_ f: Fix, turno: String = "0.8", sintesis: String = "0.8") {
        f.b.registrarReuniones(ReunionesRouter(store: f.b.store, runner: f.b.runner, oficinas: f.b.oficinas, log: f.b.log,
                                               env: ["HQ_REUNION_TURNO_TIMEOUT": turno, "HQ_REUNION_SINTESIS_TIMEOUT": sintesis]))
    }

    func nueva(_ f: Fix, _ tema: String = "plan de lanzamiento", _ agentes: [String] = ["marce", "nico", "betty"],
               _ extra: [String: Any] = [:]) async -> Resp {
        var d: [String: Any] = ["tema": tema, "agentes": agentes]
        for (k, v) in extra { d[k] = v }
        return await f.post("/api/reuniones", d)
    }

    func ver(_ f: Fix, _ id: String) async -> [String: Any] { (await f.get("/api/reuniones/\(id)")).obj }

    /// Espera a que la reunión llegue a uno de esos estados (hasta 15 s) y la devuelve.
    @discardableResult
    func aguardar(_ f: Fix, _ id: String, _ estados: Set<String> = ["esperando", "error", "cerrada"]) async -> [String: Any] {
        var ult: [String: Any] = [:]
        _ = await esperarAsync(hasta: 15) {
            ult = await ver(f, id)
            return estados.contains(str(ult["estado"]))
        }
        return ult
    }

    func turnos(_ r: [String: Any]) -> [[String: Any]] { lista(r["turnos"]) }

    func hoy() -> String {
        let d = DateFormatter(); d.locale = Locale(identifier: "en_US_POSIX"); d.dateFormat = "yyyy-MM-dd"
        return d.string(from: Date())
    }

    /// Prompts de los turnos de agentes (no la síntesis), en orden.
    func llamadasTurno(_ f: Fix) -> [[String]] { f.sb.llamadas(conPrompt: "Estás en una reunión") }

    // MARK: crear

    @Test("crear: validaciones del cuerpo (no lanza claude)")
    func crearValidaciones() async throws {
        let f = try await fix()
        func malo(_ d: [String: Any], _ motivo: String) async {
            let r = await f.post("/api/reuniones", d)
            #expect(r.status == 400, "\(motivo) -> \(r.status) \(r.obj)")
            #expect(r.obj["error"] is String)
        }
        await malo([:], "sin nada")
        await malo(["agentes": ["marce"]], "sin tema")
        await malo(["tema": "  ", "agentes": ["marce"]], "tema vacío")
        await malo(["tema": String(repeating: "t", count: 501), "agentes": ["marce"]], "tema largo")
        await malo(["tema": 5, "agentes": ["marce"]], "tema no texto")
        await malo(["tema": "t"], "sin agentes")
        await malo(["tema": "t", "agentes": [String]()], "agentes vacío")
        await malo(["tema": "t", "agentes": "marce"], "agentes no lista")
        await malo(["tema": "t", "agentes": ["marce", 5]], "agente no texto")
        await malo(["tema": "t", "agentes": ["Mal Id"]], "id inválido")
        await malo(["tema": "t", "agentes": ["fantasma"]], "agente que no está en la oficina")
        await malo(["tema": "t", "agentes": ["marce", "fantasma"]], "uno bueno y uno malo")
        for r in [0, 4, -1, "2", true, false] as [Any] { await malo(["tema": "t", "agentes": ["marce"], "rondas": r], "rondas=\(r)") }
        await malo(["tema": "t", "agentes": ["marce"], "documentos": "x"], "documentos no lista")
        await malo(["tema": "t", "agentes": ["marce"], "documentos": [3]], "documentos no slugs")
        await malo(["tema": "t", "agentes": ["marce"], "documentos": ["no-existe"]], "documento inexistente")
        #expect((await llamar(f.b, "POST", "/api/reuniones")).status == 400)
        #expect((await llamar(f.b, "POST", "/api/reuniones", body: Data("[1]".utf8))).status == 400)
        #expect((await llamar(f.b, "POST", "/api/reuniones", body: Data(repeating: 0x20, count: 200_001))).status == 413)
        #expect(f.sb.llamadas.isEmpty)
        #expect(lista((await f.get("/api/reuniones")).obj["reuniones"]).isEmpty)
        // tema de 500 justos y rondas null: bien
        let ok = await nueva(f, String(repeating: "t", count: 500), ["marce"], ["rondas": NSNull()])
        #expect(ok.status == 200)
        await aguardar(f, str(ok.obj["id"]))
    }

    @Test("crear: máximo 20 participantes")
    func crearMaximoParticipantes() async throws {
        let ags: [Ag] = (0..<21).map { ("a\($0)", "redes", nil) }
        let f = try await fix(ags)
        let r = await nueva(f, "tema", ags.map(\.id))
        #expect(r.status == 400)
        #expect(str(r.obj["error"]).contains("20"))
        #expect(f.sb.llamadas.isEmpty)
        let veinte = await nueva(f, "tema", ags.prefix(20).map(\.id))
        #expect(veinte.status == 200)
        let fin = await aguardar(f, str(veinte.obj["id"]))
        #expect(turnos(fin).count == 20)
    }

    @Test("crear: respuesta con id UUID, estado en_curso, agentes sin repetir y la reunión arranca sola en segundo plano")
    func crearRespuesta() async throws {
        let f = try await fix()
        f.sb.modo("marce", "puerta")
        let r = await nueva(f, "plan", ["marce", "marce"])
        #expect(r.status == 200)
        #expect(Set(r.obj.keys) == ["id", "tema", "agentes", "estado", "creada", "hablando", "rondas", "turnos"])
        let id = str(r.obj["id"])
        #expect(Router.uuidValido(id) && id == id.lowercased())
        #expect(r.obj["tema"] as? String == "plan")
        #expect(r.obj["agentes"] as? [String] == ["marce"])
        #expect(r.obj["estado"] as? String == "en_curso")
        #expect(r.obj["rondas"] as? Int == 0)
        #expect(lista(r.obj["turnos"]).isEmpty)
        #expect(ISO8601DateFormatter().date(from: str(r.obj["creada"])) != nil || str(r.obj["creada"]).hasSuffix("Z"))
        #expect(await esperarAsync { f.sb.eventos.contains("S marce") })
        let g = await ver(f, id)
        #expect(g["hablando"] as? String == "marce")
        #expect(g["estado"] as? String == "en_curso")
        f.sb.abrirPuerta()
        let fin = await aguardar(f, id)
        #expect(fin["estado"] as? String == "esperando")
        #expect(fin["hablando"] is NSNull)
        #expect(turnos(fin).map { str($0["agente"]) } == ["marce"])
    }

    // MARK: orden

    @Test("orden: primero quien más se relaciona con el tema (rol y departamento pesan más que brief y chips); a igual puntaje, el orden de llegada")
    func ordenHeuristico() async throws {
        let f = try await fix()
        let a = await nueva(f, "campaña de anuncios pagos", ["marce", "betty", "nico"])
        #expect(a.obj["agentes"] as? [String] == ["nico", "marce", "betty"])
        let b = await nueva(f, "estrategia en redes sociales", ["betty", "nico", "marce"])
        #expect(b.obj["agentes"] as? [String] == ["marce", "betty", "nico"])   // «redes» está en el rol y en el departamento de Marce
        let c = await nueva(f, "algo sin relación aquí", ["nico", "betty", "marce"])
        #expect(c.obj["agentes"] as? [String] == ["nico", "betty", "marce"])   // sin coincidencias: el orden original
        let d = await nueva(f, "Anuncios", ["betty", "marce", "nico"])         // mayúsculas y plural exacto
        #expect(d.obj["agentes"] as? [String] == ["nico", "betty", "marce"])
        for x in [a, b, c, d] { await aguardar(f, str(x.obj["id"])) }
    }

    @Test("orden: brief y chips pesan 1, rol y departamento pesan 2; se guarda y se usa en todas las rondas")
    func ordenPesos() async throws {
        let f = try await Fix.crear(deps: ["Dirección", "Redes"], agentes: [])
        await contratar(f.b, id: "ana", depto: "redes", rol: "Asistente", extra: ["brief": "arma el presupuesto trimestral"])
        await contratar(f.b, id: "luz", depto: "direccion", rol: "Otra cosa")
        await contratar(f.b, id: "ivo", depto: "direccion", rol: "Contador de presupuesto")
        await contratar(f.b, id: "zoe", depto: "direccion", rol: "Sin relación", extra: ["chips": ["¿Cómo va el presupuesto?"]])
        let r = await nueva(f, "presupuesto", ["luz", "ana", "zoe", "ivo"], ["rondas": 2])
        #expect(r.obj["agentes"] as? [String] == ["ivo", "ana", "zoe", "luz"])   // ivo (rol, 2); ana y zoe (brief/chips, 1) en orden de llegada; luz (0)
        let id = str(r.obj["id"])
        let fin = await aguardar(f, id)
        #expect(turnos(fin).map { str($0["agente"]) } == ["ivo", "ana", "zoe", "luz", "ivo", "ana", "zoe", "luz"])
        #expect(fin["agentes"] as? [String] == ["ivo", "ana", "zoe", "luz"])
    }

    // MARK: turnos

    @Test("turnos: secuenciales, un turno por participante y ronda, claude solo con Read,Glob,Grep y cwd en la oficina")
    func turnosSecuenciales() async throws {
        let f = try await fix()
        let r = await nueva(f, "plan de lanzamiento", ["marce", "nico", "betty"], ["rondas": 2])
        let id = str(r.obj["id"])
        let fin = await aguardar(f, id)
        #expect(fin["estado"] as? String == "esperando")
        #expect(fin["hablando"] is NSNull)
        #expect(fin["rondas"] as? Int == 2)
        let ts = turnos(fin)
        #expect(ts.map { str($0["agente"]) } == ["marce", "nico", "betty", "marce", "nico", "betty"])
        #expect(ts.map { $0["ronda"] as? Int } == [1, 1, 1, 2, 2, 2])
        #expect(ts.allSatisfy { $0["error"] == nil })
        #expect(ts.map { str($0["texto"]) } == ["marce", "nico", "betty", "marce", "nico", "betty"].map { "Opinión de \($0) sobre el tema." })
        for t in ts { #expect(!str(t["ts"]).isEmpty && t["ts"] is String) }
        // nunca dos claude a la vez: S/E alternados y en orden
        let esperado = ["marce", "nico", "betty", "marce", "nico", "betty"].flatMap { ["S \($0)", "E \($0)"] }
        #expect(f.sb.eventos == esperado)
        // argumentos de cada turno
        let ll = llamadasTurno(f)
        #expect(ll.count == 6)
        var sids = Set<String>()
        for (l, ag) in zip(ll, ["marce", "nico", "betty", "marce", "nico", "betty"]) {
            #expect(Sandbox.valor(l, "--agent") == ag)
            #expect(Sandbox.valor(l, "--tools") == "Read,Glob,Grep")
            #expect(!l.contains("--allowedTools") && !l.contains("Edit") && !l.contains("Write"))
            #expect(Sandbox.valor(l, "--output-format") == "stream-json")
            #expect(l.contains("--session-id") && !l.contains("--resume"))
            #expect(!l.contains("--add-dir"))
            sids.insert(Sandbox.valor(l, "--session-id") ?? "")
        }
        #expect(sids.count == 6)                           // sesión nueva en cada turno
        #expect(sids.allSatisfy { Router.uuidValido($0) })
        #expect(f.sb.cwds.allSatisfy { sinPrivate($0) == sinPrivate(f.carpeta) })
        // los turnos no tocan el historial del chat 1 a 1
        #expect(msgs(await historial(f.b, agent: "marce")).isEmpty)
    }

    @Test("prompt del turno: tema, participantes, memoria común, decisiones, transcripción por ronda y consigna")
    func promptTurno() async throws {
        let f = try await fix()
        escribir("# Taller\nMEMORIA_X: vendemos talleres", en: f.ruta("conocimiento/oficina.md"))
        escribir("# Decisiones\n\n- 2026-01-01: DECISION_UNO\nlínea que no es decisión\n- 2026-01-02: DECISION_DOS\n", en: f.ruta("conocimiento/decisiones.md"))
        let r = await nueva(f, "plan de lanzamiento", ["marce", "nico", "betty"], ["rondas": 2])
        await aguardar(f, str(r.obj["id"]))
        let p = f.sb.prompts.filter { $0.contains("Estás en una reunión") }
        #expect(p.count == 6)
        let p1 = p[0]
        #expect(p1.contains("Estás en una reunión de la oficina «Taller». Tema de la reunión:\nplan de lanzamiento"))
        #expect(p1.contains("Participantes: Marce (Directora creativa de redes), Nico (Especialista en anuncios pagos), Betty (PM y directora del equipo)"))
        #expect(p1.contains("Memoria común de la oficina:\n# Taller\nMEMORIA_X: vendemos talleres"))
        #expect(p1.contains("Decisiones recientes:\n- 2026-01-01: DECISION_UNO\n- 2026-01-02: DECISION_DOS"))
        #expect(!p1.contains("línea que no es decisión"))
        #expect(p1.contains("(estamos en la ronda 1):\n(todavía no habló nadie)"))
        #expect(p1.contains("Sos Marce, Directora creativa de redes. Opiná desde tu rol en 120-180 palabras"))
        #expect(p[1].contains("Sos Nico, Especialista en anuncios pagos."))
        // el segundo ya ve al primero, con el separador de ronda
        #expect(p[1].contains("— Ronda 1 —\nMarce: Opinión de marce sobre el tema."))
        #expect(!p[1].contains("(todavía no habló nadie)"))
        #expect(p[2].contains("Nico: Opinión de nico sobre el tema."))
        // la ronda 2 ve toda la ronda 1 y, a medida que avanza, la 2
        #expect(p[3].contains("(estamos en la ronda 2)"))
        #expect(p[3].contains("Betty: Opinión de betty sobre el tema."))
        #expect(!p[3].contains("— Ronda 2 —"))
        #expect(p[4].contains("— Ronda 2 —\nMarce: Opinión de marce sobre el tema."))
        // nadie ve su propio turno futuro
        #expect(!p[0].contains("Opinión de"))
    }

    @Test("prompt del turno: la memoria común se recorta a 2000 caracteres y solo entran las últimas 15 decisiones")
    func promptRecortes() async throws {
        let f = try await fix([("marce", "redes", nil)])
        escribir(String(repeating: "m", count: 5000) + "FINAL_DE_MEMORIA", en: f.ruta("conocimiento/oficina.md"))
        escribir((1...20).map { String(format: "- 2026-01-%02d: DEC_%02d", $0, $0) }.joined(separator: "\n") + "\n", en: f.ruta("conocimiento/decisiones.md"))
        await aguardar(f, str((await nueva(f, "algo", ["marce"])).obj["id"]))
        let p = try #require(f.sb.prompts.first { $0.contains("Estás en una reunión") })
        #expect(p.contains(String(repeating: "m", count: 2000) + "…"))
        #expect(!p.contains(String(repeating: "m", count: 2001)))
        #expect(!p.contains("FINAL_DE_MEMORIA"))
        #expect(p.contains("DEC_20") && p.contains("DEC_06"))
        #expect(!p.contains("DEC_05") && !p.contains("DEC_01"))
        // sin memoria ni decisiones
        escribir("", en: f.ruta("conocimiento/oficina.md"))
        try FileManager.default.removeItem(atPath: f.ruta("conocimiento/decisiones.md"))
        await aguardar(f, str((await nueva(f, "otra cosa", ["marce"])).obj["id"]))
        let q = try #require(f.sb.prompts.last { $0.contains("Estás en una reunión") })
        #expect(q.contains("(sin memoria común todavía)"))
        #expect(q.contains("(todavía no hay decisiones registradas)"))
    }

    @Test("hablando: en curso muestra quién habla; no se puede pedir otra ronda ni cerrar mientras tanto")
    func hablandoYConflictos() async throws {
        let f = try await fix()
        f.sb.modo("nico", "puerta")
        let r = await nueva(f, "campaña de anuncios pagos", ["marce", "nico", "betty"])
        let id = str(r.obj["id"])
        #expect(r.obj["agentes"] as? [String] == ["nico", "marce", "betty"])
        #expect(await esperarAsync { f.sb.eventos.contains("S nico") })
        let g = await ver(f, id)
        #expect(g["estado"] as? String == "en_curso")
        #expect(g["hablando"] as? String == "nico")
        #expect(turnos(g).isEmpty)
        let l = lista((await f.get("/api/reuniones")).obj["reuniones"])
        #expect(l.first?["estado"] as? String == "en_curso")
        let ronda = await f.post("/api/reuniones/\(id)/ronda")
        #expect(ronda.status == 409)
        #expect(str(ronda.obj["error"]).contains("ronda en curso"))
        let cerrar = await f.post("/api/reuniones/\(id)/cerrar")
        #expect(cerrar.status == 409)
        #expect(str(cerrar.obj["error"]).contains("ronda en curso"))
        #expect(f.sb.llamadas(conPrompt: "secretario de actas").isEmpty)
        f.sb.abrirPuerta()
        let fin = await aguardar(f, id)
        #expect(fin["estado"] as? String == "esperando")
        #expect(turnos(fin).map { str($0["agente"]) } == ["nico", "marce", "betty"])
    }

    // MARK: intervenir

    @Test("intervención en medio de la ronda: queda como turno «usuario» y la leen los turnos que siguen")
    func intervencionEnMedio() async throws {
        let f = try await fix()
        f.sb.modo("nico", "puerta")
        let id = str((await nueva(f, "campaña de anuncios pagos", ["marce", "nico", "betty"])).obj["id"])
        #expect(await esperarAsync { f.sb.eventos.contains("S nico") })
        let r = await f.post("/api/reuniones/\(id)/intervencion", ["texto": "  quiero ver números concretos  "])
        #expect(r.status == 200)
        let t = turnos(r.obj)
        #expect(t.count == 1)
        #expect(t[0]["agente"] as? String == "usuario")
        #expect(t[0]["texto"] as? String == "quiero ver números concretos")
        #expect(t[0]["ronda"] as? Int == 0)       // antes de que hable nadie: ronda 0
        #expect(r.obj["estado"] as? String == "en_curso")
        f.sb.abrirPuerta()
        let fin = await aguardar(f, id)
        #expect(turnos(fin).map { str($0["agente"]) } == ["usuario", "nico", "marce", "betty"])
        let p = f.sb.prompts.filter { $0.contains("Estás en una reunión") }
        #expect(!p[0].contains("quiero ver números"))                      // nico ya estaba hablando
        #expect(p[1].contains("Ana (dueño de la oficina): quiero ver números concretos"))
        #expect(p[2].contains("Ana (dueño de la oficina): quiero ver números concretos"))
    }

    @Test("intervención entre rondas: lleva la última ronda vista, y la siguiente ronda la lee")
    func intervencionEntreRondas() async throws {
        let f = try await fix([("marce", "redes", nil)])
        let id = str((await nueva(f, "tema", ["marce"])).obj["id"])
        await aguardar(f, id)
        let r = await f.post("/api/reuniones/\(id)/intervencion", ["texto": "ahora más corto"])
        #expect(turnos(r.obj).last?["ronda"] as? Int == 1)
        #expect(turnos(r.obj).last?["agente"] as? String == "usuario")
        #expect((await f.post("/api/reuniones/\(id)/ronda")).status == 200)
        let fin = await aguardar(f, id)
        #expect(turnos(fin).map { str($0["agente"]) } == ["marce", "usuario", "marce"])
        #expect(turnos(fin).map { $0["ronda"] as? Int } == [1, 1, 2])
        let ult = try #require(f.sb.prompts.last { $0.contains("Estás en una reunión") })
        #expect(ult.contains("Ana (dueño de la oficina): ahora más corto"))
        // la transcripción del turno no incluye los turnos fallidos ni repite la ronda
        #expect(ult.contains("— Ronda 1 —\nMarce: Opinión de marce sobre el tema.\n\nAna (dueño de la oficina): ahora más corto"))
    }

    @Test("intervención: validaciones y errores (404, 409 si está cerrada)")
    func intervencionErrores() async throws {
        let f = try await fix([("marce", "redes", nil)])
        let id = str((await nueva(f, "tema", ["marce"])).obj["id"])
        await aguardar(f, id)
        func inter(_ b: Any?) async -> Resp { await f.post("/api/reuniones/\(id)/intervencion", b) }
        #expect((await inter(nil)).status == 400)
        #expect((await inter([:])).status == 400)
        #expect((await inter(["texto": "  "])).status == 400)
        #expect((await inter(["texto": 3])).status == 400)
        #expect((await inter(["texto": String(repeating: "t", count: 5001)])).status == 400)
        #expect((await inter(["texto": String(repeating: "t", count: 5000)])).status == 200)
        #expect((await f.post("/api/reuniones/\(U.a)/intervencion", ["texto": "x"])).status == 404)
        #expect((await f.post("/api/reuniones/no-es-uuid/intervencion", ["texto": "x"])).status == 404)
        #expect((await f.post("/api/reuniones/\(id)/otra-cosa")).status == 404)
        #expect((await llamar(f.b, "GET", "/api/reuniones/\(id)/cerrar")).status == 405)
        #expect((await llamar(f.b, "DELETE", "/api/reuniones/\(id)")).status == 405)
        #expect((await f.post("/api/reuniones/\(id)/cerrar")).status == 200)
        let c = await inter(["texto": "tarde"])
        #expect(c.status == 409)
        #expect((await f.post("/api/reuniones/\(id)/ronda")).status == 409)
        #expect(turnos(await ver(f, id)).filter { str($0["agente"]) == "usuario" }.count == 1)
    }

    // MARK: otra ronda

    @Test("otra ronda: arranca en segundo plano, suma turnos y no se puede pisar con otra")
    func otraRonda() async throws {
        let f = try await fix([("marce", "redes", nil), ("nico", "ads", nil)])
        let id = str((await nueva(f, "algo", ["marce", "nico"])).obj["id"])
        let uno = await aguardar(f, id)
        #expect(turnos(uno).count == 2)
        f.sb.modo("marce", "puerta")
        let r = await f.post("/api/reuniones/\(id)/ronda")
        #expect(r.status == 200)
        #expect(r.obj["estado"] as? String == "en_curso")
        #expect(await esperarAsync { f.sb.eventos.filter { $0 == "S marce" }.count == 2 })
        #expect((await ver(f, id))["hablando"] as? String == "marce")
        #expect((await f.post("/api/reuniones/\(id)/ronda")).status == 409)
        f.sb.abrirPuerta()
        let dos = await aguardar(f, id)
        #expect(dos["estado"] as? String == "esperando")
        #expect(turnos(dos).map { $0["ronda"] as? Int } == [1, 1, 2, 2])
        #expect(dos["rondas"] as? Int == 2)
        #expect((await f.post("/api/reuniones/\(U.b)/ronda")).status == 404)
    }

    // MARK: turnos que fallan

    @Test("un turno que falla queda registrado con error:true y la ronda sigue con los demás")
    func turnoFallidoSigue() async throws {
        let f = try await fix()
        f.sb.modo("marce", "error")
        let id = str((await nueva(f, "plan", ["marce", "nico", "betty"])).obj["id"])
        let fin = await aguardar(f, id)
        #expect(fin["estado"] as? String == "esperando")   // alguno respondió
        let ts = turnos(fin)
        #expect(ts.map { str($0["agente"]) } == ["marce", "nico", "betty"])
        #expect(ts[0]["error"] as? Bool == true)
        #expect(!str(ts[0]["texto"]).isEmpty)
        #expect(ts[1]["error"] == nil && ts[2]["error"] == nil)
        // el turno fallido no entra en la transcripción de los que siguen
        let p = f.sb.prompts.filter { $0.contains("Estás en una reunión") }
        #expect(!p[1].contains(str(ts[0]["texto"])))
        #expect(p[1].contains("(todavía no habló nadie)"))
        // ni en la síntesis, pero sí queda en el acta
        let c = await f.post("/api/reuniones/\(id)/cerrar")
        #expect(c.status == 200)
        let sint = try #require(f.sb.prompts.last { $0.contains("secretario de actas") })
        #expect(!sint.contains(str(ts[0]["texto"])))
        #expect(sint.contains("Nico (Especialista en anuncios pagos): Opinión de nico"))
        #expect(f.leer(str(c.obj["acta"])).contains("**Marce (Directora creativa de redes):** _(no pudo responder: \(str(ts[0]["texto"])))_"))
    }

    @Test("turno sin respuesta -> «(sin respuesta)» con error; si nadie responde la reunión queda en «error» y se puede reintentar o cerrar")
    func nadieResponde() async throws {
        let f = try await fix([("marce", "redes", nil), ("nico", "ads", nil)])
        f.sb.modo("marce", "vacio")
        f.sb.modo("nico", "error")
        let id = str((await nueva(f, "plan", ["marce", "nico"])).obj["id"])
        // (no se espera «esperando»: entre que la ronda termina y se guarda el estado final, el GET informa «esperando»)
        let fin = await aguardar(f, id, ["error", "cerrada"])
        #expect(fin["estado"] as? String == "error")
        #expect(!str(fin["error"]).isEmpty)
        let ts = turnos(fin)
        #expect(ts.count == 2 && ts.allSatisfy { $0["error"] as? Bool == true })
        #expect(ts[0]["texto"] as? String == "(sin respuesta)")
        // se puede pedir otra ronda (ahora sí responden)
        f.sb.modo("marce", nil); f.sb.modo("nico", nil)
        #expect((await f.post("/api/reuniones/\(id)/ronda")).status == 200)
        let dos = await aguardar(f, id)
        #expect(dos["estado"] as? String == "esperando")
        #expect(dos["error"] == nil)
        #expect(turnos(dos).count == 4)
    }

    @Test("cerrar sin ninguna opinión válida: acta sin síntesis (no llama al secretario) y no toca decisiones.md")
    func cerrarSinOpiniones() async throws {
        let f = try await fix([("marce", "redes", nil)])
        f.sb.modo("marce", "error")
        let id = str((await nueva(f, "plan", ["marce"])).obj["id"])
        await aguardar(f, id)
        let decisiones = f.leer("conocimiento/decisiones.md")
        let c = await f.post("/api/reuniones/\(id)/cerrar")
        #expect(c.status == 200)
        #expect(c.obj["estado"] as? String == "cerrada")
        #expect(c.obj["sintesis"] == nil)
        #expect(c.obj["errorSintesis"] as? String == "No hubo opiniones para resumir.")
        #expect(f.sb.llamadas(conPrompt: "secretario de actas").isEmpty)
        let acta = f.leer(str(c.obj["acta"]))
        #expect(acta.contains("_No se pudo generar la síntesis: No hubo opiniones para resumir."))
        // detalle cosmético: el motivo ya termina en punto y la plantilla agrega otro («resumir.._»)
        #expect(!acta.contains(".._"), "acta=\(acta)")
        #expect(f.leer("conocimiento/decisiones.md") == decisiones)
    }

    @Test("turno que pasa el timeout (HQ_REUNION_TURNO_TIMEOUT): error «Tardó demasiado» y sin procesos huérfanos")
    func turnoTimeout() async throws {
        let f = try await fix([("marce", "redes", nil), ("nico", "ads", nil)])
        timeouts(f, turno: "0.7")
        f.sb.modo("marce", "lento")
        let id = str((await nueva(f, "plan", ["marce", "nico"])).obj["id"])
        let fin = await aguardar(f, id)
        #expect(fin["estado"] as? String == "esperando")
        let ts = turnos(fin)
        #expect(ts[0]["error"] as? Bool == true)
        #expect(ts[0]["texto"] as? String == "Tardó demasiado en responder.")
        #expect(ts[1]["texto"] as? String == "Opinión de nico sobre el tema.")
        if let pid = f.sb.childPid { #expect(await esperar(hasta: 5) { !vivo(pid) }, "quedó el hijo del claude vivo") }
    }

    // MARK: cerrar

    @Test("cerrar: síntesis, acta en reuniones/ con la fecha y el tema, y decisiones anexadas a decisiones.md")
    func cerrarActaYDecisiones() async throws {
        let f = try await fix()
        let previas = f.leer("conocimiento/decisiones.md")
        let id = str((await nueva(f, "Plan de Lanzamiento: ¡Diciembre!", ["marce", "nico"])).obj["id"])
        await aguardar(f, id)
        let c = await f.post("/api/reuniones/\(id)/cerrar")
        #expect(c.status == 200)
        #expect(c.obj["estado"] as? String == "cerrada")
        #expect(str(c.obj["cerrada"]).hasSuffix("Z"))
        #expect(c.obj["hablando"] is NSNull)
        let s = dict(c.obj["sintesis"])
        #expect(s["resumen"] as? String == "Se acordó avanzar con el plan.")
        #expect(s["decisiones"] as? [String] == ["Lanzar en diciembre", "Priorizar los reels"])
        #expect(lista(s["pendientes"]).map { str($0["quien"]) + "|" + str($0["que"]) } == ["Marce|Armar el calendario"])
        #expect(c.obj["errorSintesis"] == nil)
        // acta
        let rel = str(c.obj["acta"])
        #expect(rel == "reuniones/\(hoy())-plan-de-lanzamiento-diciembre.md")
        #expect(c.obj["actaRuta"] as? String == f.carpeta + "/" + rel)
        let acta = f.leer(rel)
        #expect(acta.hasPrefix("# Reunión: Plan de Lanzamiento: ¡Diciembre!\n"))
        #expect(acta.contains("- **Oficina:** Taller"))
        #expect(acta.contains("- **Fecha:** \(hoy())"))
        #expect(acta.contains("- **Participantes:** Marce (Directora creativa de redes), Nico (Especialista en anuncios pagos)") ||
                acta.contains("- **Participantes:** Nico (Especialista en anuncios pagos), Marce (Directora creativa de redes)"))
        #expect(acta.contains("## Transcripción"))
        #expect(acta.contains("### Ronda 1"))
        #expect(acta.contains("**Marce (Directora creativa de redes):** Opinión de marce sobre el tema."))
        #expect(acta.contains("## Síntesis\n\nSe acordó avanzar con el plan."))
        #expect(acta.contains("### Decisiones\n\n- Lanzar en diciembre\n- Priorizar los reels"))
        #expect(acta.contains("### Pendientes\n\n- **Marce:** Armar el calendario"))
        // decisiones.md: lo anterior intacto y las nuevas al final con la fecha
        let dec = f.leer("conocimiento/decisiones.md")
        #expect(dec.hasPrefix(previas))
        #expect(dec.hasSuffix("- \(hoy()): Lanzar en diciembre\n- \(hoy()): Priorizar los reels\n"))
        // una sola llamada de síntesis: sin agente, sin herramientas, cwd en la oficina
        let ll = f.sb.llamadas(conPrompt: "secretario de actas")
        #expect(ll.count == 1)
        let l = try #require(ll.first)
        #expect(!l.contains("--agent"))
        #expect(Sandbox.valor(l, "--tools") == "")
        let p = try #require(l.last)
        #expect(p.contains("Sos el secretario de actas de la oficina «Taller». Tema de la reunión: Plan de Lanzamiento: ¡Diciembre!"))
        #expect(p.contains("— Ronda 1 —"))
        #expect(p.contains("Marce (Directora creativa de redes): Opinión de marce"))
        #expect(sinPrivate(try #require(f.sb.cwds[f.sb.llamadas.firstIndex(where: { $0.last == p })!])) == sinPrivate(f.carpeta))
        // GET y lista muestran la reunión cerrada con todo
        let g = await ver(f, id)
        #expect(g["estado"] as? String == "cerrada")
        #expect(igual(dict(g["sintesis"]), s))
        #expect(g["acta"] as? String == rel)
        #expect(lista((await f.get("/api/reuniones")).obj["reuniones"]).first?["estado"] as? String == "cerrada")
    }

    @Test("cerrar: dos veces 409; actas del mismo día y tema con -2; tema sin letras -> «reunion»")
    func cerrarNombresDeActa() async throws {
        let f = try await fix([("marce", "redes", nil)])
        var actas: [String] = []
        for tema in ["Mismo tema", "Mismo tema", "¿¿??"] {
            let id = str((await nueva(f, tema, ["marce"])).obj["id"])
            await aguardar(f, id)
            let c = await f.post("/api/reuniones/\(id)/cerrar")
            actas.append(str(c.obj["acta"]))
            if actas.count == 1 {
                #expect((await f.post("/api/reuniones/\(id)/cerrar")).status == 409)
                #expect((await f.post("/api/reuniones/\(id)/cerrar")).obj["error"] as? String == "La reunión ya está cerrada.")
            }
        }
        #expect(actas == ["reuniones/\(hoy())-mismo-tema.md", "reuniones/\(hoy())-mismo-tema-2.md", "reuniones/\(hoy())-reunion.md"])
        #expect(actas.allSatisfy { f.existe($0) })
        #expect(f.sb.llamadas(conPrompt: "secretario de actas").count == 3)   // el 409 no volvió a llamar
    }

    @Test("síntesis en bloque ```json con texto alrededor, pendientes como texto y decisiones de varias líneas")
    func sintesisFlexible() async throws {
        let f = try await fix([("marce", "redes", nil)])
        f.sb.responder("acta", "Acá está el acta:\n```json\n{\"resumen\": \"  Resumen  \", \"decisiones\": [\"Una\\ncon salto\", \"  \", 5, \"Dos\"], \"pendientes\": [\"Hacer algo\", {\"quien\": \"Ana\", \"que\": \"Llamar\"}, {\"quien\": \"Beto\", \"que\": \"\"}]}\n```\nListo.")
        let id = str((await nueva(f, "tema", ["marce"])).obj["id"])
        await aguardar(f, id)
        let c = await f.post("/api/reuniones/\(id)/cerrar")
        let s = dict(c.obj["sintesis"])
        #expect(s["resumen"] as? String == "Resumen")
        #expect(s["decisiones"] as? [String] == ["Una\ncon salto", "Dos"])
        #expect(lista(s["pendientes"]).map { str($0["quien"]) + "|" + str($0["que"]) } == ["|Hacer algo", "Ana|Llamar"])
        let dec = f.leer("conocimiento/decisiones.md")
        #expect(dec.contains("- \(hoy()): Una con salto\n- \(hoy()): Dos\n"))
        let acta = f.leer(str(c.obj["acta"]))
        #expect(acta.contains("- **Ana:** Llamar") && acta.contains("- Hacer algo"))
    }

    @Test("síntesis que falla (claude con error, texto sin JSON, JSON vacío, timeout): la reunión se cierra igual, sin síntesis y sin decisiones")
    func sintesisFallida() async throws {
        let f = try await fix([("marce", "redes", nil)])
        let decisiones = f.leer("conocimiento/decisiones.md")
        func cerrarCon(_ preparar: () -> Void) async throws -> [String: Any] {
            f.sb.modo("acta", nil)
            try? FileManager.default.removeItem(atPath: f.sb.binDir + "/resp.acta.json")
            preparar()
            let id = str((await nueva(f, "tema", ["marce"])).obj["id"])
            await aguardar(f, id)
            let c = await f.post("/api/reuniones/\(id)/cerrar")
            #expect(c.status == 200)
            #expect(c.obj["estado"] as? String == "cerrada")
            #expect(c.obj["sintesis"] == nil)
            let acta = f.leer(str(c.obj["acta"]))
            #expect(acta.contains("## Síntesis\n\n_No se pudo generar la síntesis: "), "acta=\(acta)")
            #expect(f.leer("conocimiento/decisiones.md") == decisiones)
            let g = await ver(f, id)
            #expect(g["sintesis"] == nil)
            #expect(g["errorSintesis"] as? String == c.obj["errorSintesis"] as? String)
            return c.obj
        }
        let e1 = try await cerrarCon { f.sb.modo("acta", "error") }
        #expect(!str(e1["errorSintesis"]).isEmpty)
        let e2 = try await cerrarCon { f.sb.modo("acta", "nojson") }
        #expect(e2["errorSintesis"] as? String == "La síntesis no vino en el formato esperado.")
        let e3 = try await cerrarCon { f.sb.responder("acta", "{\"resumen\": \"\", \"decisiones\": [], \"pendientes\": []}") }
        #expect(e3["errorSintesis"] as? String == "La síntesis no vino en el formato esperado.")
        let e4 = try await cerrarCon { f.sb.responder("acta", "no tengo nada para decir") }
        #expect(e4["errorSintesis"] as? String == "La síntesis no vino en el formato esperado.")
        let e5 = try await cerrarCon { f.sb.modo("acta", "vacio") }
        #expect(!str(e5["errorSintesis"]).isEmpty)
    }

    @Test("síntesis que pasa el timeout (HQ_REUNION_SINTESIS_TIMEOUT): errorSintesis «Tardó demasiado» y el acta igual se escribe")
    func sintesisTimeout() async throws {
        let f = try await fix([("marce", "redes", nil)])
        timeouts(f, turno: "10", sintesis: "0.7")
        f.sb.modo("acta", "lento")
        let id = str((await nueva(f, "tema", ["marce"])).obj["id"])
        await aguardar(f, id)
        let c = await f.post("/api/reuniones/\(id)/cerrar")
        #expect(c.status == 200)
        #expect(c.obj["errorSintesis"] as? String == "Tardó demasiado en responder.")
        #expect(f.existe(str(c.obj["acta"])))
        if let pid = f.sb.childPid { #expect(await esperar(hasta: 5) { !vivo(pid) }) }
    }

    @Test("si se despide a un participante entre rondas, la reunión sigue con los que quedan y el acta lista solo a los presentes")
    func participanteDespedido() async throws {
        let f = try await fix([("marce", "redes", nil), ("nico", "ads", nil)])
        let id = str((await nueva(f, "algo", ["marce", "nico"])).obj["id"])
        await aguardar(f, id)
        #expect((await f.delete("/api/agentes/nico")).status == 200)
        #expect((await f.post("/api/reuniones/\(id)/ronda")).status == 200)
        let fin = await aguardar(f, id)
        #expect(turnos(fin).map { str($0["agente"]) } == ["marce", "nico", "marce"])   // nico solo habló en la ronda 1
        let c = await f.post("/api/reuniones/\(id)/cerrar")
        #expect(c.status == 200)
        #expect(f.leer(str(c.obj["acta"])).contains("- **Participantes:** Marce (Rol de marce)\n"))
    }

    // MARK: reinicio

    @Test("reinicio de la app en medio de una ronda: la reunión pasa a «esperando» con los turnos que alcanzó y se puede seguir")
    func reinicioEnMedio() async throws {
        let f = try await fix()
        f.sb.modo("nico", "puerta")
        let id = str((await nueva(f, "campaña de anuncios pagos", ["marce", "nico", "betty"])).obj["id"])
        #expect(await esperarAsync { f.sb.eventos.contains("S nico") })
        #expect((await ver(f, id))["estado"] as? String == "en_curso")
        await f.b.shutdown()
        // nuevo Backend sobre los mismos datos: la oficina activa se recupera de config.json
        let b2 = try f.sb.backend(oficina: false)
        let f2 = Fix(sb: f.sb, b: b2, carpeta: f.carpeta)
        let g = await ver(f2, id)
        #expect(g["estado"] as? String == "esperando")
        #expect(g["hablando"] is NSNull)
        #expect(turnos(g).isEmpty)       // la ronda interrumpida no llegó a registrar turnos
        #expect(lista((await f2.get("/api/reuniones")).obj["reuniones"]).first?["estado"] as? String == "esperando")
        // y se puede pedir otra ronda y cerrar
        f.sb.abrirPuerta()
        #expect((await f2.post("/api/reuniones/\(id)/ronda")).status == 200)
        let fin = await aguardar(f2, id)
        #expect(fin["estado"] as? String == "esperando")
        #expect(turnos(fin).map { str($0["agente"]) } == ["nico", "marce", "betty"])
        #expect((await f2.post("/api/reuniones/\(id)/cerrar")).status == 200)
    }

    // MARK: aislamiento entre oficinas y listado

    @Test("listado: más nuevas primero, con la cantidad de turnos; otra oficina no las ve (404) y al volver reaparecen")
    func listadoYOficinas() async throws {
        let f = try await fix([("marce", "redes", nil), ("nico", "ads", nil)])
        let a = str((await nueva(f, "primera", ["marce"])).obj["id"])
        await aguardar(f, a)
        try await Task.sleep(nanoseconds: 20_000_000)
        let b = str((await nueva(f, "segunda", ["marce", "nico"])).obj["id"])
        await aguardar(f, b)
        let l = lista((await f.get("/api/reuniones")).obj["reuniones"])
        #expect(l.map { str($0["id"]) } == [b, a])
        #expect(l.map { $0["turnos"] as? Int } == [2, 1])
        #expect(Set(l[0].keys) == ["id", "tema", "agentes", "estado", "creada", "turnos"])
        // otra oficina
        _ = await llamar(f.b, "POST", "/api/oficinas", body: json(["nombre": "Otra"]))
        #expect(lista((await f.get("/api/reuniones")).obj["reuniones"]).isEmpty)
        #expect((await f.get("/api/reuniones/\(a)")).status == 404)
        #expect((await f.post("/api/reuniones/\(a)/intervencion", ["texto": "x"])).status == 404)
        #expect((await f.post("/api/reuniones/\(a)/ronda")).status == 404)
        #expect((await f.post("/api/reuniones/\(a)/cerrar")).status == 404)
        #expect((await nueva(f, "x", ["marce"])).status == 400)   // marce no está en la otra oficina
        _ = await llamar(f.b, "POST", "/api/oficinas/abrir", body: json(["carpeta": f.carpeta]))
        #expect(lista((await f.get("/api/reuniones")).obj["reuniones"]).count == 2)
        #expect((await f.get("/api/reuniones/\(a)")).status == 200)
    }

    // MARK: carril y permisos

    @Test("los turnos usan el carril del agente: esperan a que termine su chat 1 a 1 (nunca dos claude del mismo agente a la vez)")
    func carrilCompartidoConElChat() async throws {
        let f = try await fix([("marce", "redes", nil)])
        let chatTarea = Task { await chat(f.b, agent: "marce", message: "DORMIR", session: U.a) }
        #expect(await esperarAsync { f.sb.eventos.contains("S marce") })
        let id = str((await nueva(f, "tema", ["marce"])).obj["id"])
        let fin = await aguardar(f, id)
        _ = await chatTarea.value
        #expect(fin["estado"] as? String == "esperando")
        #expect(f.sb.eventos == ["S marce", "E marce", "S marce", "E marce"])
    }

    @Test("turnos de reunión: --add-dir de las carpetas vinculadas solo para quien tiene acceso")
    func turnosConVinculos() async throws {
        let f = try await fix()
        for n in ["todos", "solomarce"] { try FileManager.default.createDirectory(atPath: f.sb.root + "/ext/\(n)", withIntermediateDirectories: true) }
        #expect((await f.post("/api/vinculos", ["ruta": f.sb.root + "/ext/todos", "id": "todos"])).status == 200)
        #expect((await f.post("/api/vinculos", ["ruta": f.sb.root + "/ext/solomarce", "id": "solomarce", "alcance": ["agentes": ["marce"]]])).status == 200)
        await aguardar(f, str((await nueva(f)).obj["id"]))
        let por: [String: [String]] = Dictionary(uniqueKeysWithValues: llamadasTurno(f).map { (Sandbox.valor($0, "--agent") ?? "", Sandbox.valores($0, "--add-dir")) })
        let e = f.sb.root + "/ext/"
        #expect(por["marce"] == [e + "todos", e + "solomarce"])
        #expect(por["nico"] == [e + "todos"])
        #expect(por["betty"] == [e + "todos"])
    }

    // MARK: documentos adjuntos

    @Test("documentos adjuntos: su ficha entra en el prompt de todos los turnos y la reunión devuelve la lista")
    func documentosAdjuntos() async throws {
        let f = try await fix([("marce", "redes", nil), ("nico", "ads", nil)])
        escribir("# Lista de precios\nFICHA_PRECIOS: el taller cuesta 100", en: f.ruta("conocimiento/fuentes/precios.md"))
        escribir("# Guion\nFICHA_GUION: abrir con un gancho", en: f.ruta("conocimiento/fuentes/guion.md"))
        let r = await nueva(f, "tema", ["marce", "nico"], ["documentos": ["precios", "guion", "precios"]])
        #expect(r.status == 200)
        #expect(r.obj["documentos"] as? [String] == ["precios", "guion"])
        let id = str(r.obj["id"])
        let fin = await aguardar(f, id)
        #expect(fin["documentos"] as? [String] == ["precios", "guion"])
        let p = f.sb.prompts.filter { $0.contains("Estás en una reunión") }
        #expect(p.count == 2)
        for x in p {
            #expect(x.contains("Documentos adjuntos a la reunión"))
            #expect(x.contains("FICHA_PRECIOS: el taller cuesta 100"))
            #expect(x.contains("FICHA_GUION: abrir con un gancho"))
            #expect(x.contains("archivos/.texto/<slug>.md"))
        }
        // sin documentos no hay sección
        let sin = await nueva(f, "otro", ["marce"])
        #expect(sin.obj["documentos"] == nil)
        await aguardar(f, str(sin.obj["id"]))
        #expect(!(f.sb.prompts.last { $0.contains("Estás en una reunión") } ?? "").contains("Documentos adjuntos"))
    }

    @Test("documentos adjuntos: cada ficha se recorta a 2500 caracteres y el total a 8000; máximo 10")
    func documentosRecortes() async throws {
        let f = try await fix([("marce", "redes", nil)])
        for i in 1...4 { escribir("DOC\(i)_INICIO " + String(repeating: "x", count: 4000) + " DOC\(i)_FIN", en: f.ruta("conocimiento/fuentes/doc\(i).md")) }
        let r = await nueva(f, "tema", ["marce"], ["documentos": ["doc1", "doc2", "doc3", "doc4"]])
        #expect(r.status == 200)
        await aguardar(f, str(r.obj["id"]))
        let p = try #require(f.sb.prompts.first { $0.contains("Estás en una reunión") })
        for i in 1...3 { #expect(p.contains("DOC\(i)_INICIO")) }
        #expect(!p.contains("DOC1_FIN") && !p.contains("DOC2_FIN"))   // recortadas a 2500
        #expect(!p.contains("DOC4_INICIO"))                          // el cuarto ya no entra en los 8000
        // más de 10
        for i in 5...12 { escribir("ficha \(i)", en: f.ruta("conocimiento/fuentes/doc\(i).md")) }
        let once = await nueva(f, "tema", ["marce"], ["documentos": (1...11).map { "doc\($0)" }])
        #expect(once.status == 400)
        #expect(str(once.obj["error"]).contains("10"))
        let diez = await nueva(f, "tema", ["marce"], ["documentos": (1...10).map { "doc\($0)" }])
        #expect(diez.status == 200)
        await aguardar(f, str(diez.obj["id"]))
    }
}
}  // extension Etapa2
