import Foundation
import Testing
@testable import Backend

@Suite("Pendientes que se ejecutan: lógica pura")
struct PendientesAccionesPurasTests {
    @Test("id de encargo: ida y vuelta; ids que no son encargos dan nil")
    func idEncargo() {
        let id = Programador.idEncargo(U.a, 3)
        #expect(id == "encargo:\(U.a):3")
        #expect(Programador.deEncargo(id)! == (U.a, 3))
        #expect(Programador.deEncargo("informe-diario") == nil)
        #expect(Programador.deEncargo("encargo:x") == nil)
    }

    @Test("tildar marca la primera línea exacta y deja el resto igual")
    func tildar() throws {
        let sb = Sandbox()
        let dir = sb.proyecto + "/conocimiento/agentes"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let l = "- [ ] 2026-11-13 · reunión «plan»: Armar el calendario"
        try "# Marce\n\n## Pendientes de reuniones\n\(l)\n- [ ] otra cosa\n".write(toFile: dir + "/marce.md", atomically: true, encoding: .utf8)
        #expect(try PendientesReunion.tildar(carpeta: sb.proyecto, agente: "marce", linea: l))
        #expect(leerTexto(dir + "/marce.md") == "# Marce\n\n## Pendientes de reuniones\n- [x] 2026-11-13 · reunión «plan»: Armar el calendario\n- [ ] otra cosa\n")
        #expect(try !PendientesReunion.tildar(carpeta: sb.proyecto, agente: "marce", linea: l))
        #expect(try !PendientesReunion.tildar(carpeta: sb.proyecto, agente: "nadie", linea: l))
    }

    @Test("origen de tarea: uuid en minúsculas y posición en rango")
    func origen() {
        #expect(ValidarTareas.origenValido(OrigenTarea(reunion: U.a, pendiente: 0)))
        #expect(!ValidarTareas.origenValido(OrigenTarea(reunion: "x", pendiente: 0)))
        #expect(!ValidarTareas.origenValido(OrigenTarea(reunion: U.a, pendiente: -1)))
        #expect(!ValidarTareas.origenValido(OrigenTarea(reunion: U.a, pendiente: 200)))
    }
}

extension Etapa2 {
@Suite("Pendientes que se ejecutan (API)")
struct PendientesAccionesTests {
    /// Reunión con marce y pato, cerrada: la síntesis falsa deja un pendiente para Marce («Armar el calendario»).
    func reunionCerrada(_ f: Fix) async throws -> String {
        let r = await f.post("/api/reuniones", ["tema": "lanzamiento", "agentes": ["marce", "pato"]])
        let id = str(r.obj["id"])
        let lista = await esperarAsync(hasta: 15) { str((await f.get("/api/reuniones/\(id)")).obj["estado"]) == "esperando" }
        try #require(lista)
        let c = await f.post("/api/reuniones/\(id)/cerrar")
        try #require(c.status == 200, "cerrar: \(c.obj)")
        return id
    }

    func estado(_ f: Fix, _ id: String) async -> [[String: Any]] { lista((await f.get("/api/reuniones/\(id)")).obj["pendientesEstado"]) }

    @Test("Hacelo ahora: corre al agente con el pendiente, deja una entrega de tipo encargo y al revisarla tilda la nota")
    func encargar() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil), ("pato", "direccion", nil)])
        let id = try await reunionCerrada(f)
        var est = await estado(f, id)
        try #require(est.count == 1)
        #expect(str(est[0]["agente"]) == "marce")
        #expect(est[0]["encargable"] as? Bool == true)
        #expect(est[0]["encargo"] == nil)
        let nota = f.leer("conocimiento/agentes/marce.md")
        #expect(nota.contains("- [ ] ") && nota.contains("Armar el calendario"))

        let r = await f.post("/api/reuniones/\(id)/pendientes/0/encargar")
        #expect(r.status == 202, "\(r.obj)")
        let ok = await esperarAsync(hasta: 15) {
            let e = await estado(f, id).first?["encargo"] as? [String: Any]
            return str(e?["estado"]) == "ok" && e?["entrega"] != nil
        }
        #expect(ok)
        est = await estado(f, id)
        let enc = est[0]["encargo"] as? [String: Any] ?? [:]
        #expect(str(enc["entregaEstado"]) == "sin_revisar")
        // la consigna lleva el pendiente y el tema
        let consigna = f.sb.llamadas.last { $0.contains("--agent") && $0.contains("marce") }?.last ?? ""
        #expect(consigna.contains("Pendiente de la reunión «lanzamiento»"))
        #expect(consigna.contains("Armar el calendario"))
        // la entrega: origen encargo, ref = id del encargo
        let ents = lista(await f.get("/api/entregas", ["origen": "encargo"]).obj["entregas"])
        try #require(ents.count == 1)
        #expect(str(ents[0]["ref"]) == Programador.idEncargo(id, 0))
        #expect(str(ents[0]["titulo"]) == "Armar el calendario")
        // revisar -> la nota queda tildada
        let eid = ents[0]["id"] as? Int ?? 0
        #expect((await f.post("/api/entregas/\(eid)/revisada")).status == 200)
        let tildada = f.leer("conocimiento/agentes/marce.md")
        #expect(tildada.contains("- [x] ") && !tildada.contains("- [ ] "))
        est = await estado(f, id)
        #expect(str((est[0]["encargo"] as? [String: Any])?["entregaEstado"]) == "revisada")
    }

    @Test("encargar: 404 sin pendiente o reunión, 409 si no está cerrada, si necesita a la persona o si no es de un agente")
    func errores() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil), ("pato", "direccion", nil)])
        let id = try await reunionCerrada(f)
        #expect((await f.post("/api/reuniones/\(id)/pendientes/5/encargar")).status == 404)
        #expect((await f.post("/api/reuniones/\(U.c)/pendientes/0/encargar")).status == 404)
        #expect((await f.post("/api/reuniones/\(id)/pendientes/x/encargar")).status == 404)
        #expect((await f.get("/api/reuniones/\(id)/pendientes/0/encargar")).status == 405)
        // reunión abierta
        let r = await f.post("/api/reuniones", ["tema": "otra", "agentes": ["marce"]])
        let abierta = str(r.obj["id"])
        _ = await esperarAsync(hasta: 15) { str((await f.get("/api/reuniones/\(abierta)")).obj["estado"]) == "esperando" }
        #expect((await f.post("/api/reuniones/\(abierta)/pendientes/0/encargar")).status == 409)
        // pendientes que no se pueden encargar
        try #"{"type":"result","result":"{\"resumen\":\"r\",\"decisiones\":[],\"pendientes\":[{\"quien\":\"Marce\",\"que\":\"Mandar el mail\",\"necesita_usuario\":true},{\"quien\":\"Ana\",\"que\":\"Firmar\"}]}","is_error":false}"#
            .write(toFile: f.sb.binDir + "/resp.acta.json", atomically: true, encoding: .utf8)
        _ = await f.post("/api/reuniones/\(abierta)/cerrar")
        let est = await estado(f, abierta)
        #expect(est.map { $0["encargable"] as? Bool } == [false, false])
        #expect((await f.post("/api/reuniones/\(abierta)/pendientes/0/encargar")).status == 409)
        #expect((await f.post("/api/reuniones/\(abierta)/pendientes/1/encargar")).status == 409)
    }

    @Test("Convertir en tarea: la tarea guarda el origen y aparece en el estado del pendiente; origen inválido 400")
    func convertir() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil), ("pato", "direccion", nil)])
        let id = try await reunionCerrada(f)
        let base: [String: Any] = ["agente": "marce", "nombre": "Calendario semanal", "consigna": "Armar el calendario",
                                   "dias": [1], "hora": "09:00", "zona": "America/Argentina/Buenos_Aires"]
        var d = base; d["origen"] = ["reunion": id, "pendiente": 0]
        let r = await f.post("/api/tareas", d)
        #expect(r.status == 200, "\(r.obj)")
        let og = (r.obj["tarea"] as? [String: Any])?["origen"] as? [String: Any]
        #expect(str(og?["reunion"]) == id && og?["pendiente"] as? Int == 0)
        let tareas = lista(await estado(f, id).first?["tareas"])
        #expect(tareas.map { str($0["id"]) } == ["calendario-semanal"])
        for malo: Any in [["reunion": "x", "pendiente": 0], ["reunion": id, "pendiente": -1], ["reunion": id], "texto", ["reunion": id, "pendiente": true]] {
            var m = base; m["origen"] = malo; m["nombre"] = "Otra"
            #expect((await f.post("/api/tareas", m)).status == 400, "\(malo)")
        }
    }
}
}
