import Foundation
import Testing
@testable import Backend

extension Etapa2 {
@Suite("Avisos (te necesita)")
struct AvisosTests {
    func avisos(_ f: Fix) async -> [[String: Any]] { lista(await f.get("/api/avisos").obj["avisos"]) }

    @Test("una respuesta deja un aviso; otra del mismo agente lo reemplaza; verlo por agente lo limpia; también viene en /api/actividad")
    func respuesta() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil), ("pato", "direccion", nil)])
        let canal = Caja()
        f.b.avisos.alCrear { a, nombre in canal.agregar("\(a.tipo):\(nombre)") }
        _ = await chat(f.b, agent: "marce", message: "hola", session: U.a)
        _ = await chat(f.b, agent: "marce", message: "hola de nuevo", session: U.a)
        _ = await chat(f.b, agent: "pato", message: "hola", session: U.b)
        var av = await avisos(f)
        #expect(av.map { str($0["agente"]) } == ["marce", "pato"])
        #expect(av.allSatisfy { str($0["tipo"]) == "respuesta" })
        #expect(str(av[0]["texto"]) == "hola marce")
        #expect(str(av[0]["ref"]) == U.a)
        #expect(canal.lineas == ["respuesta:Marce", "respuesta:Marce", "respuesta:Pato"])
        #expect(lista(await f.get("/api/actividad").obj["avisos"]).count == 2)

        #expect((await f.post("/api/avisos/visto", ["agente": "marce"])).obj["vistos"] as? Int == 1)
        av = await avisos(f)
        #expect(av.map { str($0["agente"]) } == ["pato"])
        #expect((await f.post("/api/avisos/visto", ["id": str(av[0]["id"])])).obj["vistos"] as? Int == 1)
        #expect(await avisos(f).isEmpty)
    }

    @Test("un error del chat deja un aviso de tipo error")
    func error() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil)])
        _ = await chat(f.b, agent: "marce", message: "ISERR", session: U.a)
        let av = await avisos(f)
        #expect(av.count == 1)
        #expect(str(av.first?["tipo"] as Any?) == "error")
        #expect(str(av.first?["texto"] as Any?).hasPrefix("No pudo responder") == true)
    }

    @Test("una reunión que espera aparece como aviso calculado y desaparece al cerrarla")
    func reunion() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil), ("pato", "direccion", nil)])
        let r = await f.post("/api/reuniones", ["tema": "lanzamiento", "agentes": ["marce", "pato"]])
        let id = str(r.obj["id"])
        let ok = await esperarAsync(hasta: 15) { await avisos(f).contains { str($0["id"]) == "reunion:\(id)" } }
        #expect(ok)
        // los turnos de la reunión no dejan avisos de respuesta
        #expect(!(await avisos(f)).contains { str($0["tipo"]) == "respuesta" })
        _ = await f.post("/api/reuniones/\(id)/cerrar")
        let fuera = await esperarAsync(hasta: 15) { !(await avisos(f)).contains { str($0["tipo"]) == "reunion" } }
        #expect(fuera)
    }

    @Test("abrir la reunión que espera apaga su aviso (marcarla vista) hasta que vuelva a esperar")
    func reunionVista() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil), ("pato", "direccion", nil)])
        let r = await f.post("/api/reuniones", ["tema": "lanzamiento", "agentes": ["marce", "pato"]])
        let id = str(r.obj["id"])
        let ok = await esperarAsync(hasta: 15) { await avisos(f).contains { str($0["id"]) == "reunion:\(id)" } }
        #expect(ok)
        let v = await f.post("/api/avisos/visto", ["id": "reunion:\(id)"])
        #expect(v.obj["vistos"] as? Int == 1)
        #expect(!(await avisos(f)).contains { str($0["tipo"]) == "reunion" })
        // terminar otra ronda la deja esperando de nuevo: vuelve a avisar
        _ = await f.post("/api/reuniones/\(id)/ronda")
        let vuelve = await esperarAsync(hasta: 15) { await avisos(f).contains { str($0["id"]) == "reunion:\(id)" } }
        #expect(vuelve)
    }

    @Test("sin oficina: /api/avisos 409 y /api/actividad trae avisos vacíos")
    func sinOficina() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        #expect((await llamar(b, "GET", "/api/avisos")).status == 409)
        #expect(lista((await llamar(b, "GET", "/api/actividad")).obj["avisos"]).isEmpty)
    }
}
}
