import Foundation
import Testing
@testable import Backend

@Suite("Entregas: lógica pura")
struct EntregasPurasTests {
    @Test("un Write/Edit/NotebookEdit emite también .archivo con la ruta completa; Read no")
    func parsearArchivo() {
        let w = #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/of/archivos/entregables/x.md","content":"..."}}]}}"#
        #expect(EventoClaude.parsear(w) == [.herramienta(nombre: "Write", objetivo: "x.md"), .archivo(ruta: "/of/archivos/entregables/x.md")])
        let nb = #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"NotebookEdit","input":{"notebook_path":"/of/a.ipynb"}}]}}"#
        #expect(EventoClaude.parsear(nb).last == .archivo(ruta: "/of/a.ipynb"))
        let r = #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/of/a.md"}}]}}"#
        #expect(EventoClaude.parsear(r) == [.herramienta(nombre: "Read", objetivo: "a.md")])
    }

    @Test("CajaArchivos junta rutas sin repetir y reenvía los eventos")
    func caja() {
        let c = CajaArchivos()
        let visto = Caja()
        let obs = c.observador { e in if case .archivo = e { visto.agregar("a") } }
        obs(.archivo(ruta: "/x/a.md")); obs(.archivo(ruta: "/x/a.md")); obs(.archivo(ruta: "/x/b.md")); obs(.texto)
        #expect(c.valor == ["/x/a.md", "/x/b.md"])
        #expect(visto.lineas.count == 3)
    }

    @Test("relativos: solo lo de adentro de la oficina, sin notas internas ni rutas con ..")
    func relativos() {
        let of = "/tmp/of-entregas"
        let r = ArchivosEntrega.relativos([
            "\(of)/archivos/entregables/informe.md", "\(of)/archivos/entregables/informe.md", "/otra/cosa.md",
            "\(of)/.claude/agents/marce.md", "\(of)/conocimiento/agentes/marce.md", "\(of)/conocimiento/estado-actual.md",
            "archivos/relativo.md", "\(of)/../fuera.md",
        ], carpeta: of)
        #expect(r == ["archivos/entregables/informe.md", "conocimiento/estado-actual.md", "archivos/relativo.md"])
        #expect(ArchivosEntrega.enEntregables(r) == ["archivos/entregables/informe.md"])
    }

    @Test("resumen y título recortan y aplanan saltos de línea")
    func textos() {
        #expect(TextoEntrega.resumen("hola\nmundo") == "hola mundo")
        #expect(TextoEntrega.resumen(String(repeating: "a", count: 400)).count == 280)
        #expect(TextoEntrega.titulo(String(repeating: "b", count: 100)).count == 70)
    }
}

extension Etapa2 {
@Suite("Entregas (API)")
struct EntregasTests {
    func entregas(_ f: Fix, _ q: [String: String] = [:]) async -> [[String: Any]] { lista(await f.get("/api/entregas", q).obj["entregas"]) }

    @Test("un chat que solo responde no deja entrega; uno que escribe en archivos/entregables sí, con sus archivos de adentro")
    func chatConArchivos() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil)])
        let canal = Caja()
        f.b.avisos.alCrear { a, nombre in canal.agregar("\(a.tipo):\(nombre)") }
        _ = await chat(f.b, agent: "marce", message: "hola", session: U.a)
        #expect(await entregas(f).isEmpty)
        let r = await chat(f.b, agent: "marce", message: "Armá el informe ENTREGA:archivos/entregables/informe.md", session: U.b)
        #expect(r.status == 200)
        #expect(!str(r.obj["entrega"]).isEmpty)
        let es = await entregas(f)
        try #require(es.count == 1)
        #expect(str(es[0]["origen"]) == "chat")
        #expect(str(es[0]["agente"]) == "marce")
        #expect(str(es[0]["sid"]) == U.b)
        #expect(es[0]["archivos"] as? [String] == ["archivos/entregables/informe.md"])
        #expect(str(es[0]["estado"]) == "sin_revisar")
        let titulo = str(es[0]["titulo"])
        #expect(titulo.hasPrefix("Armá el informe"))
        #expect(canal.lineas.contains("entrega:Marce"))
        // un chat que escribe fuera de archivos/entregables no cuenta
        _ = await chat(f.b, agent: "marce", message: "ENTREGA:archivos/borrador.md", session: U.c)
        #expect(await entregas(f).count == 1)
    }

    @Test("revisada / sin-revisar: el contador baja y sube, también en /api/actividad; detalle con texto; 404 y 400")
    func estados() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil)])
        _ = await chat(f.b, agent: "marce", message: "ENTREGA:archivos/entregables/a.md", session: U.a)
        _ = await chat(f.b, agent: "marce", message: "ENTREGA:archivos/entregables/b.md", session: U.b)
        #expect((await f.get("/api/entregas")).obj["sinRevisar"] as? Int == 2)
        #expect((await f.get("/api/actividad")).obj["entregasSinRevisar"] as? Int == 2)
        let es = await entregas(f)
        let id = es[0]["id"] as? Int ?? 0
        let det = await f.get("/api/entregas/\(id)")
        let texto = str((det.obj["entrega"] as? [String: Any])?["texto"])
        #expect(texto.hasPrefix("Listo, dejé"))
        let rev = await f.post("/api/entregas/\(id)/revisada")
        #expect(rev.obj["sinRevisar"] as? Int == 1)
        let estado = str((rev.obj["entrega"] as? [String: Any])?["estado"])
        #expect(estado == "revisada")
        #expect(await entregas(f, ["estado": "sin_revisar"]).count == 1)
        #expect(await entregas(f, ["estado": "revisada"]).count == 1)
        #expect((await f.post("/api/entregas/\(id)/sin-revisar")).obj["sinRevisar"] as? Int == 2)
        #expect((await f.get("/api/entregas/9999")).status == 404)
        #expect((await f.get("/api/entregas/abc")).status == 404)
        #expect((await f.get("/api/entregas", ["estado": "raro"])).status == 400)
        #expect((await f.get("/api/entregas/\(id)/revisada")).status == 405)
        #expect(await entregas(f, ["agente": "otro"]).isEmpty)
        #expect(await entregas(f, ["origen": "chat"]).count == 2)
    }

    @Test("el acta de una reunión cerrada queda como entrega sin agente")
    func acta() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil), ("pato", "direccion", nil)])
        let r = await f.post("/api/reuniones", ["tema": "lanzamiento", "agentes": ["marce", "pato"]])
        let id = str(r.obj["id"])
        let lista1 = await esperarAsync(hasta: 15) { str((await f.get("/api/reuniones/\(id)")).obj["estado"]) == "esperando" }
        #expect(lista1)
        _ = await f.post("/api/reuniones/\(id)/cerrar")
        let ok = await esperarAsync(hasta: 15) { !(await entregas(f, ["origen": "reunion"])).isEmpty }
        #expect(ok)
        let e = await entregas(f, ["origen": "reunion"]).first ?? [:]
        #expect(str(e["agente"]) == "")
        #expect(str(e["ref"]) == id)
        #expect(str(e["titulo"]) == "Acta: lanzamiento")
        let primero = (e["archivos"] as? [String])?.first ?? ""
        #expect(primero.hasPrefix("reuniones/"))
    }

    @Test("pedir cambios: retoma la conversación, crea la versión nueva (padre) y la anterior queda reemplazada")
    func cambios() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil)])
        _ = await chat(f.b, agent: "marce", message: "Informe ENTREGA:archivos/entregables/informe.md", session: U.a)
        let vieja = await entregas(f).first?["id"] as? Int ?? 0
        #expect((await f.post("/api/entregas/\(vieja)/cambios", ["texto": ""])).status == 400)
        #expect((await llamar(f.b, "POST", "/api/entregas/\(vieja)/cambios")).status == 400)
        let r = await f.post("/api/entregas/\(vieja)/cambios", ["texto": "Hacelo más corto"])
        #expect(r.status == 202, "\(r.obj)")
        let ok = await esperarAsync(hasta: 15) { await entregas(f).count == 2 }
        #expect(ok)
        let es = await entregas(f)
        #expect(str(es[0]["origen"]) == "cambios")
        #expect(es[0]["padre"] as? Int == vieja)
        #expect(str(es[0]["sid"]) == U.a)
        #expect(str(es[0]["estado"]) == "sin_revisar")
        #expect(es[0]["archivos"] as? [String] == ["archivos/entregables/informe.md"])
        #expect(str(es[1]["estado"]) == "cambios")
        #expect((await f.get("/api/entregas")).obj["sinRevisar"] as? Int == 1)
        // retomó la misma conversación, con el pedido
        let ult = f.sb.llamadas.last { $0.contains("--agent") } ?? []
        #expect(ult.contains("--resume") && ult.contains(U.a))
        #expect((ult.last ?? "").contains("Hacelo más corto"))
        // la reemplazada no se puede volver a cambiar ni marcar sin revisar
        #expect((await f.post("/api/entregas/\(vieja)/cambios", ["texto": "otra"])).status == 409)
        #expect((await f.post("/api/entregas/\(vieja)/sin-revisar")).status == 409)
        let det = await f.get("/api/entregas/\(vieja)")
        #expect((det.obj["entrega"] as? [String: Any])?["enCambios"] as? Bool == false)
    }

    @Test("pedir cambios a un acta (sin conversación) da 409")
    func cambiosActa() async throws {
        let f = try await Fix.crear(agentes: [("marce", "direccion", nil), ("pato", "direccion", nil)])
        let r = await f.post("/api/reuniones", ["tema": "lanzamiento", "agentes": ["marce", "pato"]])
        let id = str(r.obj["id"])
        _ = await esperarAsync(hasta: 15) { str((await f.get("/api/reuniones/\(id)")).obj["estado"]) == "esperando" }
        _ = await f.post("/api/reuniones/\(id)/cerrar")
        let acta = await entregas(f, ["origen": "reunion"]).first?["id"] as? Int ?? 0
        #expect((await f.post("/api/entregas/\(acta)/cambios", ["texto": "x"])).status == 409)
    }

    @Test("sin oficina: /api/entregas 409 y /api/actividad trae el contador en 0")
    func sinOficina() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        #expect((await llamar(b, "GET", "/api/entregas")).status == 409)
        #expect((await llamar(b, "GET", "/api/actividad")).obj["entregasSinRevisar"] as? Int == 0)
    }
}
}
