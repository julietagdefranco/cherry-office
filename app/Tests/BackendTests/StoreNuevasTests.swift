import Foundation
import Testing
@testable import Backend

@Suite("Store: corridas, pasos, tarjetas y acciones")
struct StoreNuevasTests {
    static let def = #"{"id":"clase","nombre":"Producción de una clase","pasos":[{"id":"diseno","nombre":"Diseño","quien":"sofia"},{"id":"grab","nombre":"Grabación","quien":"persona"}]}"#

    func tienda(_ sb: Sandbox) throws -> Store { try Store(path: sb.datos + "/hq.db") }
    func esperar() async { try? await Task.sleep(nanoseconds: 20_000_000) }

    @Test("corridas: crear, leer, actualizar, filtrar y ordenar")
    func corridas() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try tienda(sb)
        let c = try #require(await s.corridaCrear(oficina: "/o", flujo: "clase", nombre: "Clase 7", contexto: "tema", definicion: Self.def))
        #expect(c.estado == "en_curso" && c.paso == 0 && !c.vista && c.terminada == nil)
        #expect(await s.corrida(oficina: "/o", id: c.id) == c)
        #expect(await s.corrida(oficina: "/otra", id: c.id) == nil)
        let c2 = try #require(await s.corridaCrear(oficina: "/o", flujo: "otro", nombre: "B", contexto: "", definicion: Self.def, estado: "trabada"))
        await esperar()
        let a = try #require(await s.corridaActualizar(oficina: "/o", id: c.id, paso: 1, estado: "esperando_aprobacion"))
        #expect(a.paso == 1 && a.estado == "esperando_aprobacion" && a.actualizada > c.actualizada)
        // ordenadas por actualizada desc
        #expect(await s.corridas(oficina: "/o").map(\.id) == [c.id, c2.id])
        #expect(await s.corridas(oficina: "/o", estados: ["trabada"]).map(\.id) == [c2.id])
        #expect(await s.corridas(oficina: "/o", estados: Corrida.abiertas).count == 2)
        #expect(await s.corridas(oficina: "/o", flujo: "clase").map(\.id) == [c.id])
        #expect(await s.corridas(oficina: "/o", limite: 1).count == 1)
        let t = try #require(await s.corridaActualizar(oficina: "/o", id: c.id, estado: "terminada", terminada: 123))
        #expect(t.terminada == 123)
        #expect(await s.corridas(oficina: "/o", estados: Corrida.abiertas).map(\.id) == [c2.id])
    }

    @Test("corridas: esperando_persona deja vista = 0 hasta corridaVista")
    func vista() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try tienda(sb)
        let c = try #require(await s.corridaCrear(oficina: "/o", flujo: "f", nombre: "n", contexto: "", definicion: Self.def))
        #expect(await s.corridasEsperandoPersona(oficina: "/o").isEmpty)
        await s.corridaActualizar(oficina: "/o", id: c.id, estado: "esperando_persona")
        #expect(await s.corridasEsperandoPersona(oficina: "/o").map(\.id) == [c.id])
        #expect(await s.corridaVista(oficina: "/o", id: c.id))
        #expect(await s.corrida(oficina: "/o", id: c.id)?.vista == true)
        #expect(await s.corridasEsperandoPersona(oficina: "/o").isEmpty)
        #expect(await s.corridaVista(oficina: "/o", id: 999) == false)
        // volver a esperar a la persona la marca otra vez como no vista
        await s.corridaActualizar(oficina: "/o", id: c.id, estado: "en_curso")
        await s.corridaActualizar(oficina: "/o", id: c.id, estado: "esperando_persona")
        #expect(await s.corridasEsperandoPersona(oficina: "/o").count == 1)
    }

    @Test("Corrida.json trae flujoNombre, total, pasoNombre y quien")
    func corridaJSON() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try tienda(sb)
        var c = try #require(await s.corridaCrear(oficina: "/o", flujo: "clase", nombre: "Clase 7", contexto: "", definicion: Self.def))
        var j = c.json
        #expect(j["flujoNombre"] as? String == "Producción de una clase")
        #expect(j["total"] as? Int == 2 && j["pasoNombre"] as? String == "Diseño" && j["quien"] as? String == "sofia")
        #expect(j["terminada"] is NSNull)
        c = try #require(await s.corridaActualizar(oficina: "/o", id: c.id, paso: 1))
        j = c.json
        #expect(j["pasoNombre"] as? String == "Grabación" && j["quien"] as? String == "persona")
        // definición rota: no explota
        let r = try #require(await s.corridaCrear(oficina: "/o", flujo: "x", nombre: "n", contexto: "", definicion: "no json"))
        #expect(r.json["total"] as? Int == 0 && r.json["pasoNombre"] as? String == "")
    }

    @Test("pasos: crear, actualizar, sumarCosto acumula, orden, vigente y búsquedas")
    func pasos() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try tienda(sb)
        let c = try #require(await s.corridaCrear(oficina: "/o", flujo: "f", nombre: "n", contexto: "", definicion: Self.def))
        let p1 = try #require(await s.pasoCrear(corrida: c.id, paso: 0, intento: 1, quien: "sofia", estado: "corriendo"))
        #expect(p1.costo == nil && p1.fin == nil && p1.nota == nil && p1.despues == nil)
        let p0 = try #require(await s.pasoCrear(corrida: c.id, paso: 1, intento: 1, quien: "persona", estado: "pendiente", despues: 50, nota: "espera"))
        #expect(p0.despues == 50 && p0.nota == "espera")
        let p1b = try #require(await s.pasoCrear(corrida: c.id, paso: 0, intento: 2, quien: "sofia", estado: "corriendo"))
        #expect(await s.pasosDe(corrida: c.id).map(\.id) == [p1.id, p1b.id, p0.id])
        #expect(await s.pasoVigente(corrida: c.id)?.id == p1b.id)
        #expect(await s.pasoBuscar(corrida: c.id, paso: 0, intento: 2)?.id == p1b.id)
        #expect(await s.pasoBuscar(corrida: c.id, paso: 5, intento: 1) == nil)

        var a = try #require(await s.pasoActualizar(id: p1.id, sumarCosto: 0.25))
        #expect(a.costo == 0.25)
        a = try #require(await s.pasoActualizar(id: p1.id, sumarCosto: 0.5))
        #expect(a.costo == 0.75 && a.estado == "corriendo")
        a = try #require(await s.pasoActualizar(id: p1.id, estado: "listo", ejecucion: 7, entrega: 9, fin: 100, nota: "ok"))
        #expect(a.estado == "listo" && a.ejecucion == 7 && a.entrega == 9 && a.fin == 100 && a.nota == "ok" && a.costo == 0.75)
        #expect(await s.pasoPorEntrega(9)?.id == p1.id)
        #expect(await s.pasoPorEntrega(10) == nil)
        #expect(a.json["entrega"] as? Int64 == 9 && a.json["despues"] is NSNull)
    }

    @Test("pasosEnEstado y pasosTerminadosDesde")
    func pasosEstado() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try tienda(sb)
        let c = try #require(await s.corridaCrear(oficina: "/o", flujo: "f", nombre: "n", contexto: "", definicion: Self.def))
        let otra = try #require(await s.corridaCrear(oficina: "/x", flujo: "f", nombre: "m", contexto: "", definicion: Self.def))
        let a = try #require(await s.pasoCrear(corrida: c.id, paso: 0, intento: 1, quien: "sofia", estado: "listo"))
        await s.pasoActualizar(id: a.id, fin: 200)
        let b = try #require(await s.pasoCrear(corrida: c.id, paso: 1, intento: 1, quien: "persona", estado: "esperando_persona"))
        let z = try #require(await s.pasoCrear(corrida: otra.id, paso: 0, intento: 1, quien: "sofia", estado: "listo"))
        await s.pasoActualizar(id: z.id, fin: 300)
        let r = await s.pasosEnEstado(oficina: "/o", estados: ["esperando_persona", "corriendo"])
        #expect(r.count == 1 && r[0].0.id == c.id && r[0].1.id == b.id && r[0].1.quien == "persona" && r[0].0.nombre == "n")
        #expect(await s.pasosEnEstado(oficina: "/o", estados: []).isEmpty)
        #expect(await s.pasosTerminadosDesde(oficina: "/o", desde: 100) == 1)
        #expect(await s.pasosTerminadosDesde(oficina: "/o", desde: 250) == 0)
        #expect(await s.pasosTerminadosDesde(oficina: "/x", desde: 250) == 1)
    }

    @Test("tarjetas: upsert conserva creada, estado, filtros y ids por oficina")
    func tarjetas() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try tienda(sb)
        #expect(await s.tarjetaNuevoId(oficina: "/o") == "t1")
        var t = Tarjeta(id: "t1", oficina: "/o", sid: "s", tipo: "agente", accion: "crear", datos: #"{"nombre":"Sofía"}"#,
                        faltantes: #"["rol"]"#, origen: "chat")
        #expect(await s.tarjetaGuardar(t))
        let g1 = try #require(await s.tarjeta(oficina: "/o", id: "t1"))
        #expect(g1.estado == "borrador" && g1.creada > 0 && g1.objetivo == nil && g1.error == nil)
        #expect((g1.json["datos"] as? [String: Any])?["nombre"] as? String == "Sofía")
        #expect(g1.json["faltantes"] as? [String] == ["rol"])
        #expect(await s.tarjetaNuevoId(oficina: "/o") == "t2")
        #expect(await s.tarjetaNuevoId(oficina: "/otra") == "t1")

        await esperar()
        t.faltantes = "[]"; t.estado = "lista"; t.objetivo = "sofia"
        #expect(await s.tarjetaGuardar(t))
        let g2 = try #require(await s.tarjeta(oficina: "/o", id: "t1"))
        #expect(g2.creada == g1.creada && g2.actualizada > g1.actualizada && g2.estado == "lista" && g2.objetivo == "sofia")
        #expect(await s.tarjetas(oficina: "/o").count == 1)

        t.id = "t5"; t.tipo = "flujo"
        _ = await s.tarjetaGuardar(t)
        #expect(await s.tarjetaNuevoId(oficina: "/o") == "t6")
        #expect(await s.tarjetas(oficina: "/o").map(\.id) == ["t1", "t5"])
        #expect(await s.tarjetas(oficina: "/o", estados: ["borrador"]).isEmpty)
        #expect(await s.tarjetas(oficina: "/o", estados: ["lista"]).count == 2)

        let c = try #require(await s.tarjetaEstado(oficina: "/o", id: "t1", estado: "creada", creadaId: "sofia"))
        #expect(c.estado == "creada" && c.creadaId == "sofia" && c.error == nil)
        let e = try #require(await s.tarjetaEstado(oficina: "/o", id: "t1", estado: "error", error: "falló"))
        #expect(e.estado == "error" && e.error == "falló" && e.creadaId == "sofia")
        #expect(await s.tarjetaEstado(oficina: "/o", id: "nada", estado: "error") == nil)
    }

    @Test("acciones: crear, vincular, buscar, filtrar y actualizar")
    func acciones() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try tienda(sb)
        let a = try #require(await s.accionCrear(oficina: "/o", agente: "sofia", sid: "s", herramienta: "mcp__x__crear",
                                                 resumen: "Crear evento", detalle: #"{"titulo":"Hola"}"#))
        #expect(a.estado == "pendiente" && a.entrega == nil && a.resultado == nil)
        #expect((a.json["detalle"] as? [String: Any])?["titulo"] as? String == "Hola")
        let b = try #require(await s.accionCrear(oficina: "/o", agente: "sofia", sid: "s", herramienta: "h", resumen: "r", detalle: "{}", entrega: 4))
        #expect(b.entrega == 4)
        #expect(await s.accionPorEntrega(oficina: "/o", entrega: 4)?.id == b.id)
        #expect(await s.accionPorEntrega(oficina: "/o", entrega: 5) == nil)
        await s.accionVincular(id: a.id, entrega: 5)
        #expect(await s.accionPorEntrega(oficina: "/o", entrega: 5)?.id == a.id)

        await esperar()
        await s.accionActualizar(id: a.id, estado: "ejecutando", ejecucion: 3)
        await s.accionActualizar(id: a.id, estado: "hecha", resultado: "listo")
        let h = try #require(await s.accion(oficina: "/o", id: a.id))
        #expect(h.estado == "hecha" && h.resultado == "listo" && h.ejecucion == 3 && h.actualizada > a.actualizada)
        #expect(await s.accion(oficina: "/otra", id: a.id) == nil)
        #expect(await s.acciones(oficina: "/o").map(\.id) == [b.id, a.id])
        #expect(await s.acciones(oficina: "/o", estados: ["pendiente"]).map(\.id) == [b.id])
        #expect(await s.acciones(oficina: "/o", estados: ["hecha", "error"]).map(\.id) == [a.id])
    }

    @Test("prepararX es idempotente y los datos sobreviven a reabrir")
    func idempotente() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        do {
            let s = try tienda(sb)
            try await s.prepararCorridas(); try await s.prepararCorridas()
            try await s.prepararTarjetas(); try await s.prepararTarjetas()
            try await s.prepararAcciones(); try await s.prepararAcciones()
            _ = await s.corridaCrear(oficina: "/o", flujo: "f", nombre: "n", contexto: "", definicion: Self.def)
            _ = await s.accionCrear(oficina: "/o", agente: "a", sid: "s", herramienta: "h", resumen: "r", detalle: "{}")
            await s.close()
        }
        let s2 = try tienda(sb)
        try await s2.prepararCorridas(); try await s2.prepararAcciones()
        #expect(await s2.corridas(oficina: "/o").count == 1)
        #expect(await s2.acciones(oficina: "/o").count == 1)
    }
}
