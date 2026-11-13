import Foundation
import Testing
@testable import Backend

/// Stream-json: parseo de eventos, corte de líneas, registro de actividad, /api/actividad y /api/costos.
@Suite("Actividad en vivo y costo")
struct ActividadUnitTests {
    @Test("parsear: init, thinking, tool_use con objetivo corto, text y result con costo; hooks y rate limits se ignoran")
    func parsear() {
        #expect(EventoClaude.parsear(#"{"type":"system","subtype":"hook_started","hook_name":"x"}"#) == [])
        #expect(EventoClaude.parsear(#"{"type":"rate_limit_event"}"#) == [])
        #expect(EventoClaude.parsear("no es json") == [])
        #expect(EventoClaude.parsear(#"{"type":"system","subtype":"init","session_id":"abc"}"#) == [.inicio(sesion: "abc")])
        let mezcla = #"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""},{"type":"tool_use","name":"Read","input":{"file_path":"/a/b/informe.md"}},{"type":"text","text":"x"}]}}"#
        #expect(EventoClaude.parsear(mezcla) == [.pensando, .herramienta(nombre: "Read", objetivo: "informe.md"), .texto])
        #expect(EventoClaude.parsear(#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebFetch","input":{"url":"https://ejemplo.com/x?y=1"}}]}}"#)
                == [.herramienta(nombre: "WebFetch", objetivo: "ejemplo.com")])
        #expect(EventoClaude.parsear(#"{"type":"result","is_error":false,"result":"ok","total_cost_usd":0.0187}"#)
                == [.resultado(costo: 0.0187, error: false)])
        #expect(EventoClaude.parsear(#"{"type":"result","is_error":true,"result":"x"}"#) == [.resultado(costo: nil, error: true)])
    }

    @Test("objetivo: nunca más de 60 caracteres")
    func objetivoCorto() {
        let largo = String(repeating: "a", count: 200)
        #expect((EventoClaude.objetivo("Grep", ["pattern": largo]) ?? "").count == 60)
    }

    @Test("cortador: arma líneas aunque el pipe las parta en pedazos, y entrega el resto al terminar")
    func cortador() {
        let caja = Caja()
        let c = CortadorLineas { caja.agregar($0) }
        c.agregar(Data("{\"a\":1}\n{\"b\"".utf8))
        c.agregar(Data(":2}\n\n{\"c\":3".utf8))
        #expect(caja.lineas == [#"{"a":1}"#, #"{"b":2}"#])
        c.terminar()
        #expect(caja.lineas == [#"{"a":1}"#, #"{"b":2}"#, #"{"c":3"#])
    }

    @Test("registro: estado por herramienta, la corrida más reciente gana, terminar limpia y la tarea se recorta")
    func registro() {
        let r = ActividadRegistro(reloj: { Date(timeIntervalSince1970: 1000) })
        #expect(ActividadRegistro.estado(herramienta: "Edit") == "escribiendo")
        #expect(ActividadRegistro.estado(herramienta: "Glob") == "leyendo")
        #expect(ActividadRegistro.estado(herramienta: "WebSearch") == "buscando")
        #expect(ActividadRegistro.estado(herramienta: "mcp__hq__consultar") == "consultando")
        #expect(ActividadRegistro.estado(herramienta: "Bash") == "trabajando")

        let t1 = r.empezar(oficina: "/o", agente: "marce", origen: "chat", tarea: String(repeating: "x", count: 100))
        #expect(r.vista(oficina: "/o")["marce"]?.estado == "pensando")
        #expect(r.vista(oficina: "/o")["marce"]?.tarea?.count == 48)
        r.aplicar(oficina: "/o", agente: "marce", token: t1, .herramienta(nombre: "Write", objetivo: "plan.md"))
        #expect(r.vista(oficina: "/o")["marce"]?.estado == "escribiendo")
        #expect(r.vista(oficina: "/o")["marce"]?.objetivo == "plan.md")
        #expect(r.vista(oficina: "/otra").isEmpty)

        let t2 = r.empezar(oficina: "/o", agente: "marce", origen: "consulta")
        #expect(r.vista(oficina: "/o")["marce"]?.origen == "consulta")
        r.terminar(oficina: "/o", agente: "marce", token: t2)
        #expect(r.vista(oficina: "/o")["marce"]?.origen == "chat")
        r.tarea(oficina: "/o", agente: "marce", token: t1, texto: "Armando el plan")
        #expect(r.vista(oficina: "/o")["marce"]?.tarea == "Armando el plan")
        r.terminar(oficina: "/o", agente: "marce", token: t1)
        #expect(r.vista(oficina: "/o").isEmpty)
    }

    @Test("caja de costo: suma varias corridas y reenvía los eventos")
    func cajaCosto() {
        let caja = CajaCosto(), visto = Caja()
        let obs = caja.observador { e in if case .texto = e { visto.agregar("texto") } }
        obs(.resultado(costo: 0.1, error: false)); obs(.texto); obs(.resultado(costo: 0.05, error: false)); obs(.resultado(costo: nil, error: true))
        #expect(abs((caja.valor ?? 0) - 0.15) < 1e-9)
        #expect(visto.lineas == ["texto"])
    }
}

final class Caja: @unchecked Sendable {
    private let lock = NSLock()
    private var l: [String] = []
    func agregar(_ s: String) { lock.lock(); l.append(s); lock.unlock() }
    var lineas: [String] { lock.lock(); defer { lock.unlock() }; return l }
}

extension Etapa2 {
@Suite("Actividad en vivo (API)")
struct ActividadAPITests {
    @Test("chat en vivo: /api/actividad muestra herramienta, archivo y tarea (sin contenido) y se limpia al terminar; el costo queda en /api/costos")
    func chatEnVivo() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", "Directora")])
        async let r = chat(f.b, agent: "marce", message: "STREAM PAUSA armame el plan de diciembre", session: U.a)
        let viendo = await esperarAsync {
            let a = await f.get("/api/actividad")
            return dict(dict(a.obj["agentes"])["marce"])["estado"] as? String == "leyendo"
        }
        #expect(viendo)
        let a = await f.get("/api/actividad")
        let m = dict(dict(a.obj["agentes"])["marce"])
        #expect(m["herramienta"] as? String == "Read")
        #expect(m["objetivo"] as? String == "oficina.md")
        #expect(m["origen"] as? String == "chat")
        #expect(str(m["tarea"]).hasPrefix("STREAM PAUSA armame"))
        let crudo = String(decoding: try JSONSerialization.data(withJSONObject: a.obj), as: UTF8.self)
        #expect(!crudo.contains("secreto"), "la actividad no debe exponer contenido de herramientas")
        f.sb.abrirPuerta()
        let resp = await r
        #expect(resp.status == 200)
        #expect(resp.obj["reply"] as? String == "stream marce")
        #expect(dict(await f.get("/api/actividad").obj["agentes"]).isEmpty)

        let listo = await esperarAsync { (await f.get("/api/costos").obj["total"] as? Double ?? 0) > 0 }
        #expect(listo)
        let c = await f.get("/api/costos")
        #expect(abs((c.obj["total"] as? Double ?? 0) - 0.25) < 1e-9)
        #expect(abs((dict(c.obj["agentes"])["marce"] as? Double ?? 0) - 0.25) < 1e-9)
        #expect(abs((dict(c.obj["origenes"])["chat"] as? Double ?? 0) - 0.25) < 1e-9)
    }

    @Test("cartel: un pedido largo se resume con haiku y el resumen reemplaza al mensaje recortado; uno corto no se resume")
    func resumen() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil)])
        async let r = chat(f.b, agent: "marce", message: "STREAM PAUSA necesito que me armes el plan completo de reels para diciembre", session: U.c)
        let ok = await esperarAsync {
            str(dict(dict(await f.get("/api/actividad").obj["agentes"])["marce"])["tarea"]) == "Armando el plan de diciembre"
        }
        let diag = await f.get("/api/actividad").obj
        #expect(ok, "actividad: \(diag) llamadas: \(f.sb.llamadas.map { $0.prefix(6) })")
        f.sb.abrirPuerta()
        _ = await r
        let haiku = f.sb.llamadas.filter { Sandbox.valor($0, "--model") == "haiku" }
        #expect(haiku.count == 1)
        #expect(haiku.first.map { Sandbox.valor($0, "--tools") } == "")
        #expect(haiku.first?.contains("--agent") == false, "\(haiku.first?.map { String($0.prefix(30)) } ?? [])")
        let c = await esperarAsync { (dict(await f.get("/api/costos").obj["origenes"])["resumen"] as? Double ?? 0) > 0 }
        #expect(c)
        let antes = f.sb.llamadas.count
        _ = await chat(f.b, agent: "marce", message: "hola", session: U.d)
        #expect(f.sb.llamadas.count == antes + 1, "un mensaje corto no lanza el resumen")
    }

    @Test("limpiar resumen: primera línea, sin comillas ni punto, recortado")
    func limpiarResumen() {
        #expect(ResumenTarea.limpiar("«Armando el plan.»\notra") == "Armando el plan")
        #expect(ResumenTarea.limpiar("   ") == nil)
        #expect((ResumenTarea.limpiar(String(repeating: "x", count: 90)) ?? "").count == 48)
        #expect(!ResumenTarea.hace(falta: "hola"))
    }

    @Test("todas las corridas usan stream-json --verbose")
    func formato() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil)])
        _ = await chat(f.b, agent: "marce", message: "hola", session: U.b)
        let l = try #require(f.sb.llamadas.last)
        #expect(Sandbox.valor(l, "--output-format") == "stream-json")
        #expect(l.contains("--verbose"))
    }

    @Test("sin oficina activa, /api/actividad responde vacío (no 409)")
    func sinOficina() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let r = await llamar(b, "GET", "/api/actividad")
        #expect(r.status == 200)
        #expect(dict(r.obj["agentes"]).isEmpty)
    }
}
}
