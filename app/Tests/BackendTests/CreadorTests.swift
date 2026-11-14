import Foundation
import Testing
@testable import Backend

/// El Creador (plan §6 y §11): herramientas `proponer_*`, anti-invento, faltantes, aplicar y el chat de fondo.
/// Todo con el claude falso (CREADOR_LLAMAR); nunca el real.
extension Etapa2 {
@Suite("El Creador", .serialized)
struct CreadorTests {
    /// Lo que dijo la persona en la sesión: de acá salen las citas (`origen`).
    static let texto = "Quiero un departamento de Ventas. Hay una Analista que mira los números. La regla es no inventar datos. "
        + "Cada lunes a las 08:00 arma la agenda. Cada mes revisa las métricas."

    struct Banco {
        let f: Fix
        let h: MCPHerramientas
        let sid: String

        func llamar(_ nombre: String, _ args: [String: Any] = [:]) async -> (texto: String, error: Bool) {
            guard let r = await h.llamar(nombre, argumentos: args) else { return ("(no existe)", true) }
            return (r.texto, r.esError)
        }

        func tarjeta(_ r: (texto: String, error: Bool)) -> [String: Any] { dict(try? JSONSerialization.jsonObject(with: Data(r.texto.utf8))) }

        /// Propone y devuelve (tarjeta, error).
        func proponer(_ tipo: String, _ accion: String = "crear", origen: String, datos: [String: Any] = [:], ref: String? = nil,
                      objetivo: String? = nil) async -> (t: [String: Any], error: Bool, texto: String) {
            var a: [String: Any] = ["accion": accion, "origen": origen, "datos": datos]
            if let ref { a["ref"] = ref }
            if let objetivo { a["objetivo"] = objetivo }
            let r = await llamar("proponer_" + tipo, a)
            return (tarjeta(r), r.error, r.texto)
        }

        func pregunta(_ t: [String: Any]) -> String { str(lista(t["faltantes"]).first?["pregunta"]) }
        func faltantes(_ t: [String: Any]) -> [String] { lista(t["faltantes"]).map { str($0["campo"]) } }
        func tarjetas() async -> [Tarjeta] { await f.b.servicios.store.tarjetas(oficina: f.carpeta) }
    }

    func banco(agentes: [(id: String, depto: String, rol: String?)] = []) async throws -> Banco {
        let f = try await Fix.crear(nombre: "Taller", duenio: "Ana", deps: ["Dirección", "Redes"], agentes: agentes)
        let sid = U.a
        try await f.b.store.asegurarSesion(sid, agente: "creador", oficina: f.carpeta)
        try await f.b.store.agregar(sid: sid, rol: "u", texto: Self.texto)
        let token = f.b.mcp.tokens.emitir(oficina: f.carpeta, agente: "creador", sid: sid, perfil: "creador")
        let h = try #require(Creador.herramientas(f.b.servicios, token: token, identidad: IdentidadMCP(oficina: f.carpeta, agente: "creador", sid: sid, perfil: "creador")))
        return Banco(f: f, h: h, sid: sid)
    }

    func catalogo(_ s: [ServidorConector]?) { if let s { CatalogoConectores.compartido.fijar(s) } else { CatalogoConectores.compartido.limpiar() } }

    let agenteDatos: [String: Any] = ["nombre": "Valeria", "rol": "Analista", "departamento": "redes", "prompt": "Sos Valeria, analista de números."]

    // MARK: herramientas

    @Test("las 10 herramientas, con prefijo mcp__hq__ y su esquema")
    func definiciones() async throws {
        let b = try await banco()
        let defs = b.h.definiciones
        #expect(defs.compactMap { $0["name"] as? String }.map { "mcp__hq__" + $0 } == Creador.nombresMCP)
        #expect(Creador.nombresMCP.count == 10)
        for d in defs { #expect(dict(d["inputSchema"])["type"] as? String == "object") }
        let p = defs.first { str($0["name"]) == "proponer_agente" }
        #expect(dict(p?["inputSchema"])["required"] as? [String] == ["accion", "origen"])
    }

    @Test("un origen inventado da isError y no guarda nada")
    func origenInventado() async throws {
        let b = try await banco()
        let r = await b.proponer("departamento", origen: "Quiero un departamento de Piratas", datos: ["nombre": "Piratas"])
        #expect(r.error)
        #expect(r.texto.contains("Citá textual"))
        #expect(await b.tarjetas().isEmpty)
        // sin origen
        let r2 = await b.llamar("proponer_departamento", ["accion": "crear", "datos": ["nombre": "X"]])
        #expect(r2.error)
        // la cita vale con otras mayúsculas, acentos, comillas y blancos
        let ok = await b.proponer("departamento", origen: "«quiero  un DEPARTAMENTO de ventas»", datos: ["nombre": "Ventas"])
        #expect(!ok.error)
    }

    @Test("un agente sin prompt queda en borrador con su pregunta")
    func agenteSinPrompt() async throws {
        let b = try await banco()
        var d = agenteDatos; d["prompt"] = nil
        let r = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: d)
        #expect(!r.error)
        #expect(str(r.t["estado"]) == "borrador")
        #expect(b.faltantes(r.t) == ["prompt"])
        #expect(!b.pregunta(r.t).isEmpty)
        #expect(str(r.t["id"]) == "t1" && str(r.t["tipo"]) == "agente" && str(r.t["accion"]) == "crear")
        let completo = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: agenteDatos)
        #expect(str(completo.t["estado"]) == "lista" && b.faltantes(completo.t).isEmpty)
    }

    @Test("tarjeta:t1 resuelve; una referencia que no existe es un faltante")
    func referencias() async throws {
        let b = try await banco()
        let dep = await b.proponer("departamento", origen: "Quiero un departamento de Ventas", datos: ["nombre": "Ventas"])
        #expect(str(dep.t["id"]) == "t1" && str(dep.t["estado"]) == "lista")
        var d = agenteDatos; d["departamento"] = "tarjeta:t1"
        let ok = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: d)
        #expect(str(ok.t["estado"]) == "lista", "\(ok.texto)")
        d["departamento"] = "tarjeta:t9"
        let mal = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: d)
        #expect(str(mal.t["estado"]) == "borrador" && b.faltantes(mal.t) == ["departamento"])
        d["departamento"] = "no-existe"
        let mal2 = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: d)
        #expect(b.faltantes(mal2.t) == ["departamento"])
        // el tipo tiene que ser el correcto: t2 es un agente, no un departamento
        d["departamento"] = "tarjeta:t2"
        let mal3 = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: d)
        #expect(b.faltantes(mal3.t) == ["departamento"])
        // un departamento descartado ya no vale
        _ = await b.llamar("descartar_tarjeta", ["id": "t1"])
        d["departamento"] = "tarjeta:t1"
        let mal4 = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: d)
        #expect(b.faltantes(mal4.t) == ["departamento"])
        // uno de la oficina sí
        d["departamento"] = "redes"
        #expect(str((await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: d)).t["estado"]) == "lista")
    }

    @Test("un paso sin aprobacion queda en borrador; con todo explícito, lista")
    func flujoAprobacion() async throws {
        let b = try await banco(agentes: [("val", "redes", "Analista")])
        let paso1: [String: Any] = ["nombre": "Armar", "quien": "val", "entrega": "La agenda", "aprobacion": true]
        let sin: [String: Any] = ["nombre": "Grabar", "quien": "persona", "entrega": "El video"]
        let r = await b.proponer("flujo", origen: "Cada lunes a las 08:00 arma la agenda", datos: ["nombre": "Semana", "pasos": [paso1, sin]])
        #expect(!r.error, "\(r.texto)")
        #expect(str(r.t["estado"]) == "borrador")
        #expect(b.faltantes(r.t) == ["pasos[1].aprobacion"])
        var con = sin; con["aprobacion"] = false
        let ok = await b.proponer("flujo", origen: "Cada lunes a las 08:00 arma la agenda", datos: ["nombre": "Semana", "pasos": [paso1, con]], ref: str(r.t["id"]))
        #expect(str(ok.t["estado"]) == "lista" && str(ok.t["id"]) == str(r.t["id"]), "\(ok.texto)")
        // un valor que no es booleano es un error de formato
        var mal = sin; mal["aprobacion"] = "si"
        #expect((await b.proponer("flujo", origen: "Cada lunes a las 08:00 arma la agenda", datos: ["nombre": "X", "pasos": [mal]])).error)
        // quien que no existe: faltante
        var raro = con; raro["quien"] = "fantasma"
        let q = await b.proponer("flujo", origen: "Cada lunes a las 08:00 arma la agenda", datos: ["nombre": "Y", "pasos": [raro]])
        #expect(b.faltantes(q.t) == ["pasos[0].quien"])
        // recibeDe hacia un paso que no es anterior: error de formato
        var adelante = con; adelante["recibeDe"] = ["no-hay"]
        #expect((await b.proponer("flujo", origen: "Cada lunes a las 08:00 arma la agenda", datos: ["nombre": "Z", "pasos": [adelante]])).error)
    }

    @Test("un conector no disponible queda en borrador con «Conectá X en claude.ai»")
    func conectores() async throws {
        let b = try await banco(agentes: [("val", "redes", "Analista")])
        catalogo([ServidorConector(nombre: "Google Calendar", prefijo: "mcp__claude_ai_Google_Calendar", estado: "connected",
                                   herramientas: ["mcp__claude_ai_Google_Calendar__list_events"]),
                  ServidorConector(nombre: "Notion", prefijo: "mcp__claude_ai_Notion", estado: "needs-auth")])
        defer { catalogo(nil) }
        let cal = await b.proponer("conector", origen: "Hay una Analista que mira los números",
                                   datos: ["agente": "val", "servidor": "Google Calendar", "leer": ["mcp__claude_ai_Google_Calendar__list_events"]])
        #expect(str(cal.t["estado"]) == "lista", "\(cal.texto)")
        let notion = await b.proponer("conector", origen: "Hay una Analista que mira los números",
                                      datos: ["agente": "val", "servidor": "Notion", "leer": ["mcp__claude_ai_Notion__search"]])
        #expect(str(notion.t["estado"]) == "borrador")
        #expect(b.pregunta(notion.t).contains("Conectá Notion en claude.ai"))
        let insta = await b.proponer("conector", origen: "Hay una Analista que mira los números",
                                     datos: ["agente": "val", "servidor": "Instagram", "leer": ["mcp__claude_ai_Instagram__feed"]])
        #expect(str(insta.t["estado"]) == "borrador")
        #expect(b.pregunta(insta.t).contains("Conectá Instagram en claude.ai"))
        // una herramienta mal escrita es un error de formato
        let mal = await b.proponer("conector", origen: "Hay una Analista que mira los números",
                                   datos: ["agente": "val", "servidor": "Google Calendar", "leer": ["list_events"]])
        #expect(mal.error)
        // sin catálogo detectado tampoco se puede dar por disponible
        catalogo(nil)
        #expect(str((await b.proponer("conector", origen: "Hay una Analista que mira los números",
                                      datos: ["agente": "val", "servidor": "Google Calendar", "leer": ["mcp__claude_ai_Google_Calendar__list_events"]])).t["estado"]) == "borrador")
    }

    @Test("una tarea semanal queda lista; mensual, en borrador con su pregunta; formato malo, isError")
    func tareas() async throws {
        let b = try await banco(agentes: [("val", "redes", "Analista")])
        let semanal = await b.proponer("tarea", origen: "Cada lunes a las 08:00 arma la agenda",
                                       datos: ["agente": "val", "nombre": "Agenda", "consigna": "Armá la agenda", "dias": [1], "hora": "08:00"])
        #expect(str(semanal.t["estado"]) == "lista", "\(semanal.texto)")
        let mensual = await b.proponer("tarea", origen: "Cada mes revisa las métricas",
                                       datos: ["agente": "val", "nombre": "Métricas", "consigna": "Revisá las métricas", "hora": "09:00",
                                               "periodicidad": "mensual"])
        #expect(str(mensual.t["estado"]) == "borrador")
        #expect(b.faltantes(mensual.t).contains("periodicidad"))
        let horaMala = await b.proponer("tarea", origen: "Cada lunes a las 08:00 arma la agenda",
                                        datos: ["agente": "val", "nombre": "A", "consigna": "B", "dias": [1], "hora": "8"])
        #expect(horaMala.error)
        let diasMalos = await b.proponer("tarea", origen: "Cada lunes a las 08:00 arma la agenda",
                                         datos: ["agente": "val", "nombre": "A", "consigna": "B", "dias": [9], "hora": "08:00"])
        #expect(diasMalos.error)
    }

    @Test("ref actualiza la tarjeta en vez de duplicar; un null borra un campo")
    func refActualiza() async throws {
        let b = try await banco()
        var d = agenteDatos; d["prompt"] = nil
        let a = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: d)
        let b2 = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: ["prompt": "Sos Valeria."], ref: str(a.t["id"]))
        #expect(str(b2.t["id"]) == str(a.t["id"]) && str(b2.t["estado"]) == "lista")
        #expect(dict(b2.t["datos"])["nombre"] as? String == "Valeria")   // lo anterior se conserva
        #expect((await b.tarjetas()).count == 1)
        // otro tipo con ese ref: error
        #expect((await b.proponer("regla", origen: "La regla es no inventar datos", datos: ["texto": "No inventes."], ref: str(a.t["id"]))).error)
        // ref que no existe
        #expect((await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: d, ref: "t99")).error)
        let n = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: ["prompt": NSNull()], ref: str(a.t["id"]))
        #expect(str(n.t["estado"]) == "borrador")
    }

    @Test("marcar_faltante deja la tarjeta en borrador y descartar_tarjeta la saca")
    func marcarYDescartar() async throws {
        let b = try await banco()
        let dep = await b.proponer("departamento", origen: "Quiero un departamento de Ventas", datos: ["nombre": "Ventas"])
        #expect(str(dep.t["estado"]) == "lista")
        let m = b.tarjeta(await b.llamar("marcar_faltante", ["ref": str(dep.t["id"]), "campo": "mision", "pregunta": "¿Para qué existe?"]))
        #expect(str(m["estado"]) == "borrador" && b.faltantes(m) == ["mision"])
        // si se completa el campo, el faltante manual se va
        let c = await b.proponer("departamento", origen: "Quiero un departamento de Ventas", datos: ["mision": "Vender más."], ref: str(dep.t["id"]))
        #expect(str(c.t["estado"]) == "lista")
        #expect((await b.llamar("marcar_faltante", ["ref": "t99", "campo": "x", "pregunta": "y"])).error)

        let d = b.tarjeta(await b.llamar("descartar_tarjeta", ["id": str(dep.t["id"])]))
        #expect(str(d["estado"]) == "descartada")
        let api = await b.f.get("/api/creador/borrador")
        #expect(lista(api.obj["tarjetas"]).isEmpty)
        #expect((await b.llamar("descartar_tarjeta", ["id": "t99"])).error)
    }

    @Test("VersionCreador sube con cada cambio")
    func version() async throws {
        let b = try await banco()
        let v0 = VersionCreador.compartida.valor(b.f.carpeta)
        let r = await b.proponer("departamento", origen: "Quiero un departamento de Ventas", datos: ["nombre": "Ventas"])
        let v1 = VersionCreador.compartida.valor(b.f.carpeta)
        #expect(v1 > v0)
        _ = await b.llamar("descartar_tarjeta", ["id": str(r.t["id"])])
        #expect(VersionCreador.compartida.valor(b.f.carpeta) > v1)
        // un intento que falla no la sube
        let v2 = VersionCreador.compartida.valor(b.f.carpeta)
        _ = await b.proponer("departamento", origen: "inventado", datos: ["nombre": "X"])
        #expect(VersionCreador.compartida.valor(b.f.carpeta) == v2)
        let act = await b.f.get("/api/actividad")
        #expect(act.obj["creadorVersion"] as? Int == v2)
    }

    @Test("el cupo de escrituras por mensaje es de 80")
    func cupo() async throws {
        let b = try await banco()
        for _ in 0..<Creador.maxEscrituras { _ = await b.llamar("descartar_tarjeta", ["id": "t1"]) }
        let r = await b.llamar("descartar_tarjeta", ["id": "t1"])
        #expect(r.error && r.texto.contains("\(Creador.maxEscrituras)"))
        // leer no gasta cupo
        #expect(!(await b.llamar("ver_oficina")).error)
    }

    @Test("modificar y quitar piden un objetivo que exista")
    func objetivos() async throws {
        let b = try await banco(agentes: [("val", "redes", "Analista")])
        #expect((await b.proponer("agente", "modificar", origen: "Hay una Analista que mira los números", datos: ["rol": "Jefa"])).error)
        #expect((await b.proponer("agente", "modificar", origen: "Hay una Analista que mira los números", datos: ["rol": "Jefa"], objetivo: "nadie")).error)
        let ok = await b.proponer("agente", "modificar", origen: "Hay una Analista que mira los números", datos: ["rol": "Jefa"], objetivo: "val")
        #expect(str(ok.t["estado"]) == "lista" && str(ok.t["objetivo"]) == "val", "\(ok.texto)")
    }

    @Test("ver_oficina y listar_conectores")
    func lectura() async throws {
        let b = try await banco(agentes: [("val", "redes", "Analista")])
        _ = await b.proponer("departamento", origen: "Quiero un departamento de Ventas", datos: ["nombre": "Ventas"])
        let v = dict(try? JSONSerialization.jsonObject(with: Data((await b.llamar("ver_oficina")).texto.utf8)))
        #expect(lista(v["agentes"]).map { str($0["id"]) } == ["val"])
        #expect(lista(v["departamentos"]).map { str($0["id"]) } == ["direccion", "redes"])
        #expect(lista(v["tarjetas"]).map { str($0["id"]) } == ["t1"])
        catalogo(nil)
        let sin = dict(try? JSONSerialization.jsonObject(with: Data((await b.llamar("listar_conectores")).texto.utf8)))
        #expect(sin["detectado"] as? Bool == false && !str(sin["nota"]).isEmpty)
        catalogo([ServidorConector(nombre: "Gmail", prefijo: "mcp__claude_ai_Gmail", estado: "connected", herramientas: ["mcp__claude_ai_Gmail__search_threads"])])
        defer { catalogo(nil) }
        let con = dict(try? JSONSerialization.jsonObject(with: Data((await b.llamar("listar_conectores")).texto.utf8)))
        #expect(lista(con["servidores"]).map { str($0["nombre"]) } == ["Gmail"])
    }

    // MARK: aplicar

    @Test("aplicar: departamento + agente con tarjeta:x + regla + flujo con persona + tarea dejan un oficina.json válido")
    func aplicarTodo() async throws {
        let b = try await banco()
        let dep = await b.proponer("departamento", origen: "Quiero un departamento de Ventas", datos: ["nombre": "Ventas", "mision": "Vender."])
        var d = agenteDatos; d["departamento"] = "tarjeta:" + str(dep.t["id"]); d["id"] = "valeria"
        d["limites"] = ["proponer": ["Cambiar precios"]]; d["permisos"] = ["coordinador"]
        let ag = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: d)
        let regla = await b.proponer("regla", origen: "La regla es no inventar datos", datos: ["texto": "No inventes datos."])
        let paso1: [String: Any] = ["nombre": "Armar", "quien": "tarjeta:" + str(ag.t["id"]), "entrega": "La agenda", "aprobacion": true]
        let paso2: [String: Any] = ["nombre": "Revisar", "quien": "persona", "entrega": "El visto bueno", "aprobacion": false]
        let flujo = await b.proponer("flujo", origen: "Cada lunes a las 08:00 arma la agenda", datos: ["nombre": "Agenda semanal", "pasos": [paso1, paso2]])
        let tarea = await b.proponer("tarea", origen: "Cada lunes a las 08:00 arma la agenda",
                                     datos: ["agente": "tarjeta:" + str(ag.t["id"]), "nombre": "Agenda", "consigna": "Armá la agenda", "dias": [1], "hora": "08:00"])
        for t in [dep, ag, regla, flujo, tarea] { #expect(str(t.t["estado"]) == "lista", "\(t.texto)") }

        // en el orden «al revés» a propósito: aplicar los ordena por tipo
        let ids = [str(tarea.t["id"]), str(flujo.t["id"]), str(regla.t["id"]), str(ag.t["id"]), str(dep.t["id"])]
        let r = await b.f.post("/api/creador/aplicar", ["ids": ids])
        #expect(r.status == 200, "\(r.obj)")
        let res = lista(r.obj["resultados"])
        #expect(res.map { str($0["id"]) } == ids)
        #expect(res.allSatisfy { ($0["ok"] as? Bool) == true }, "\(res)")
        #expect(str(res.last?["creadaId"]) == "ventas")
        #expect(str(res[3]["creadaId"]) == "valeria")

        let o = try OficinaStore.leer(carpeta: b.f.carpeta)   // valida
        #expect(o.departamento("ventas")?.mision == "Vender.")
        #expect(o.agente("valeria")?.departamento == "ventas" && o.agente("valeria")?.esCoordinador == true)
        #expect(o.agente("valeria")?.limites?.proponer == ["Cambiar precios"])
        #expect(o.reglas?.map(\.texto) == ["No inventes datos."] && o.reglas?.first?.origen == "La regla es no inventar datos")
        let f = try #require(o.flujos?.first)
        #expect(f.pasos.map(\.quien) == ["valeria", "persona"] && f.pasos.map(\.aprobacion) == [true, false])
        #expect(o.tareas?.first?.agente == "valeria" && o.tareas?.first?.dias == [1] && o.tareas?.first?.hora == "08:00")
        #expect(b.f.existe(".claude/agents/valeria.md"))
        #expect(dict(r.obj["oficina"])["nombre"] as? String == "Taller")

        // las tarjetas quedan creadas, con su creadaId
        let creadas = await b.tarjetas()
        #expect(creadas.allSatisfy { $0.estado == "creada" && $0.creadaId != nil })
        #expect(creadas.first { $0.tipo == "agente" }?.creadaId == "valeria")
        // aplicar de nuevo no duplica nada
        let otra = await b.f.post("/api/creador/aplicar", ["ids": ids])
        #expect(lista(otra.obj["resultados"]).allSatisfy { ($0["ok"] as? Bool) == true })
        #expect(try OficinaStore.leer(carpeta: b.f.carpeta).agentes.count == 1)
    }

    @Test("aplicar: una tarjeta en borrador da 409 con sus faltantes y no aplica nada")
    func aplicarBorrador() async throws {
        let b = try await banco()
        let ok = await b.proponer("departamento", origen: "Quiero un departamento de Ventas", datos: ["nombre": "Ventas"])
        var d = agenteDatos; d["prompt"] = nil
        let mal = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: d)
        let r = await b.f.post("/api/creador/aplicar", ["ids": [str(ok.t["id"]), str(mal.t["id"])]])
        #expect(r.status == 409)
        let faltan = lista(r.obj["borradores"])
        #expect(faltan.map { str($0["id"]) } == [str(mal.t["id"])])
        #expect(lista(faltan.first?["faltantes"]).map { str($0["campo"]) } == ["prompt"])
        #expect(try OficinaStore.leer(carpeta: b.f.carpeta).departamento("ventas") == nil)
        #expect(await b.tarjetas().allSatisfy { $0.estado != "creada" })
        // sin ids: aplica todas las listas; el borrador sigue en 409 solo si se lo nombra
        let sinIds = await b.f.post("/api/creador/aplicar", [String: Any]())
        #expect(sinIds.status == 200)
        #expect(try OficinaStore.leer(carpeta: b.f.carpeta).departamento("ventas") != nil)
        #expect((await b.f.post("/api/creador/aplicar", ["ids": ["t99"]])).status == 404)
    }

    @Test("aplicar: una tarjeta que falla queda en error y las demás siguen; una que depende de ella también falla")
    func aplicarError() async throws {
        let b = try await banco(agentes: [("val", "redes", "Analista")])
        let dep = await b.proponer("departamento", origen: "Quiero un departamento de Ventas", datos: ["nombre": "Ventas"])
        let reg = await b.proponer("regla", origen: "La regla es no inventar datos", datos: ["texto": "No inventes datos."])
        // una tarjeta lista cuyo departamento desaparece antes de aplicar (se fuerza editando la tabla)
        var d = agenteDatos; d["departamento"] = "redes"
        let ag = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: d)
        let tarea = await b.proponer("tarea", origen: "Cada lunes a las 08:00 arma la agenda",
                                     datos: ["agente": "tarjeta:" + str(ag.t["id"]), "nombre": "Agenda", "consigna": "Armá", "dias": [1], "hora": "08:00"])
        var t = try #require(await b.f.b.servicios.store.tarjeta(oficina: b.f.carpeta, id: str(ag.t["id"])))
        var dd = Creador.objeto(t.datos); dd["departamento"] = "ya-no-existe"
        t.datos = Creador.json(dd)
        await b.f.b.servicios.store.tarjetaGuardar(t)
        let r = await b.f.post("/api/creador/aplicar", ["ids": [str(dep.t["id"]), str(reg.t["id"]), str(ag.t["id"]), str(tarea.t["id"])]])
        #expect(r.status == 200)
        let res = lista(r.obj["resultados"])
        #expect(res.map { ($0["ok"] as? Bool) == true } == [true, true, false, false])
        #expect(!str(res[2]["error"]).isEmpty && str(res[3]["error"]).contains(str(ag.t["id"])))
        let tj = await b.tarjetas()
        #expect(tj.first { $0.id == str(ag.t["id"]) }?.estado == "error" && tj.first { $0.id == str(ag.t["id"]) }?.error != nil)
        #expect(tj.first { $0.id == str(dep.t["id"]) }?.estado == "creada")
        let o = try OficinaStore.leer(carpeta: b.f.carpeta)
        #expect(o.departamento("ventas") != nil && o.reglas?.count == 1 && o.agente("valeria") == nil)
    }

    @Test("quitar sin confirmación da error; con confirmarQuitar despide al agente")
    func quitar() async throws {
        let b = try await banco(agentes: [("val", "redes", "Analista"), ("otro", "redes", "Otro")])
        let q = await b.proponer("agente", "quitar", origen: "Hay una Analista que mira los números", objetivo: "val")
        #expect(str(q.t["estado"]) == "lista", "\(q.texto)")
        let sin = await b.f.post("/api/creador/aplicar", ["ids": [str(q.t["id"])]])
        let r0 = try #require(lista(sin.obj["resultados"]).first)
        #expect(r0["ok"] as? Bool == false && str(r0["error"]).contains("confirm"))
        #expect(try OficinaStore.leer(carpeta: b.f.carpeta).agente("val") != nil)
        let con = await b.f.post("/api/creador/aplicar", ["ids": [str(q.t["id"])], "confirmarQuitar": true])
        #expect(lista(con.obj["resultados"]).first?["ok"] as? Bool == true, "\(con.obj)")
        let o = try OficinaStore.leer(carpeta: b.f.carpeta)
        #expect(o.agente("val") == nil && o.agente("otro") != nil)
        #expect(await b.tarjetas().first?.estado == "creada")
    }

    @Test("modificar cambia lo que existe: departamento, agente, regla, flujo y tarea")
    func aplicarModificar() async throws {
        let b = try await banco(agentes: [("val", "redes", "Analista")])
        // algo para modificar
        _ = try await b.f.b.oficinas.modificar { o in
            o.reglas = [Regla(id: "r1", texto: "Vieja.")]
            o.flujos = [FlujoDef(id: "f1", nombre: "Viejo", pasos: [PasoFlujo(id: "p1", nombre: "Uno", quien: "val", entrega: "Algo")])]
            o.tareas = [TareaProgramada(id: "ta", agente: "val", nombre: "Vieja", consigna: "Hacé", dias: [2], hora: "10:00")]
        }
        let o1 = "Quiero un departamento de Ventas"
        let t1 = await b.proponer("departamento", "modificar", origen: o1, datos: ["mision": "Nueva misión."], objetivo: "redes")
        let t2 = await b.proponer("agente", "modificar", origen: "Hay una Analista que mira los números", datos: ["rol": "Jefa de datos"], objetivo: "val")
        let t3 = await b.proponer("regla", "modificar", origen: "La regla es no inventar datos", datos: ["texto": "Nueva."], objetivo: "r1")
        let t4 = await b.proponer("flujo", "modificar", origen: "Cada lunes a las 08:00 arma la agenda",
                                  datos: ["nombre": "Nuevo", "pasos": [["nombre": "Uno", "quien": "val", "entrega": "Algo", "aprobacion": true]]], objetivo: "f1")
        let t5 = await b.proponer("tarea", "modificar", origen: "Cada lunes a las 08:00 arma la agenda", datos: ["hora": "07:30", "dias": [1, 3]], objetivo: "ta")
        for t in [t1, t2, t3, t4, t5] { #expect(str(t.t["estado"]) == "lista", "\(t.texto)") }
        let r = await b.f.post("/api/creador/aplicar", [String: Any]())
        #expect(lista(r.obj["resultados"]).allSatisfy { ($0["ok"] as? Bool) == true }, "\(r.obj)")
        let o = try OficinaStore.leer(carpeta: b.f.carpeta)
        #expect(o.departamento("redes")?.mision == "Nueva misión.")
        #expect(o.agente("val")?.rol == "Jefa de datos")
        #expect(o.reglas?.first?.texto == "Nueva." && o.flujos?.first?.nombre == "Nuevo" && o.flujos?.first?.pasos.first?.aprobacion == true)
        #expect(o.tareas?.first?.hora == "07:30" && o.tareas?.first?.dias == [1, 3])
    }

    @Test("PATCH revalida sin pedir la cita; DELETE descarta; creada no se toca")
    func patchYDelete() async throws {
        let b = try await banco()
        var d = agenteDatos; d["prompt"] = nil
        let a = await b.proponer("agente", origen: "Hay una Analista que mira los números", datos: d)
        let id = str(a.t["id"])
        let p = await b.f.patch("/api/creador/tarjetas/\(id)", ["datos": ["prompt": "Sos Valeria."]])
        #expect(p.status == 200 && str(dict(p.obj["tarjeta"])["estado"]) == "lista", "\(p.obj)")
        #expect(str(dict(dict(p.obj["tarjeta"])["datos"])["prompt"]) == "Sos Valeria.")
        let mal = await b.f.patch("/api/creador/tarjetas/\(id)", ["datos": ["modelo": "gpt"]])
        #expect(mal.status == 400)
        #expect((await b.f.patch("/api/creador/tarjetas/t99", ["datos": [:]])).status == 404)
        #expect((await b.f.patch("/api/creador/tarjetas/\(id)", ["otra": 1])).status == 400)
        let bor = await b.f.get("/api/creador/borrador")
        #expect(bor.status == 200 && lista(bor.obj["tarjetas"]).count == 1 && dict(bor.obj["resumen"])["lista"] as? Int == 1)
        #expect(bor.obj["version"] as? Int == VersionCreador.compartida.valor(b.f.carpeta))
        let del = await b.f.delete("/api/creador/tarjetas/\(id)")
        #expect(del.status == 200 && str(dict(del.obj["tarjeta"])["estado"]) == "descartada")
        #expect(lista((await b.f.get("/api/creador/borrador")).obj["tarjetas"]).isEmpty)
        #expect((await b.f.delete("/api/creador/tarjetas/t99")).status == 404)
        // una creada no se descarta ni se edita
        let dep = await b.proponer("departamento", origen: "Quiero un departamento de Ventas", datos: ["nombre": "Ventas"])
        _ = await b.f.post("/api/creador/aplicar", [String: Any]())
        #expect((await b.f.delete("/api/creador/tarjetas/\(str(dep.t["id"]))")).status == 409)
        #expect((await b.f.patch("/api/creador/tarjetas/\(str(dep.t["id"]))", ["datos": ["nombre": "X"]])).status == 409)
    }

    @Test("el prompt del Creador es genérico y pide proponer, citar y preguntar")
    func prompt() {
        let md = Plantillas.creadorMD(oficina: Oficina(nombre: "Taller", duenio: "Ana"))
        #expect(md.hasPrefix("---\nname: creador\n"))
        #expect(md.contains("model: sonnet"))
        for clave in ["ver_oficina", "marcar_faltante", "tarjeta:<id>", "TEXTUAL", "3 preguntas", "nunca creás"] {
            #expect(md.contains(clave), "falta «\(clave)»")
        }
        #expect(!md.contains("Betty") && !md.contains("Próspera"))
    }

    // MARK: chat de fondo

    @Test("punta a punta: el chat llama a las herramientas, deja dos tarjetas listas y corre con la veda y sin Edit ni Write")
    func puntaAPunta() async throws {
        let f = try await Fix.crear(nombre: "Taller", duenio: "Ana", deps: ["Dirección", "Redes"])
        f.sb.llamadasCreador([
            ["name": "proponer_departamento", "arguments": ["accion": "crear", "origen": "un departamento de ventas", "datos": ["nombre": "Ventas"]]],
            ["name": "proponer_regla", "arguments": ["accion": "crear", "origen": "la regla es no inventar", "datos": ["texto": "No inventes datos."]]]])
        let r = await f.post("/api/creador/chat", ["message": "CREADOR_LLAMAR quiero un departamento de ventas y la regla es no inventar", "session": U.a])
        #expect(r.status == 202 && r.obj["ok"] as? Bool == true && str(r.obj["session"]) == U.a, "\(r.obj)")
        // el chat no es de otro agente: la sesión es del creador y está en las tablas de mensajes
        let fin = await esperarAsync(hasta: 20) {
            let e = await f.get("/api/creador/estado", ["session": U.a])
            return e.obj["corriendo"] as? Bool == false && lista(e.obj["mensajes"]).contains { str($0["rol"]) == "a" }
        }
        #expect(fin)
        let e = await f.get("/api/creador/estado", ["session": U.a])
        let ms = lista(e.obj["mensajes"])
        #expect(ms.map { str($0["rol"]) } == ["u", "a"])
        #expect(str(ms.last?["texto"]).contains("armé las tarjetas") && !str(ms.first?["ts"]).isEmpty)
        #expect(e.obj["version"] as? Int == VersionCreador.compartida.valor(f.carpeta))
        #expect(await f.b.store.agenteDe(U.a) == "creador")

        let bor = await f.get("/api/creador/borrador")
        let ts = lista(bor.obj["tarjetas"])
        #expect(ts.map { str($0["tipo"]) } == ["departamento", "regla"] && ts.allSatisfy { str($0["estado"]) == "lista" }, "\(ts) \(f.sb.salidasCreador)")
        #expect(dict(bor.obj["resumen"])["lista"] as? Int == 2)
        #expect(f.sb.salidasCreador.count == 2 && f.sb.salidasCreador.allSatisfy { dict($0["result"])["isError"] == nil })

        // el comando: agente creador, solo lectura, veda de conectores y herramientas MCP del Creador
        let llamada = try #require(f.sb.llamadas.first { Sandbox.valor($0, "--agent") == "creador" })
        let tools = (Sandbox.valor(llamada, "--tools") ?? "").split(separator: ",").map(String.init)
        #expect(tools.starts(with: ["Read", "Glob", "Grep"]) && !tools.contains("Edit") && !tools.contains("Write"))
        #expect(Set(tools).isSuperset(of: Set(Creador.nombresMCP)))
        let reglas = Sandbox.reglas(llamada)
        #expect(!reglas.contains { $0.hasPrefix("Edit") || $0.hasPrefix("Write") })
        #expect(Set(reglas).isSuperset(of: Set(Creador.nombresMCP)))
        let veda = llamada.firstIndex(of: "--disallowedTools").map { llamada[($0 + 1)...].prefix { $0 != "--" } }.map(Array.init) ?? []
        #expect(veda.contains("mcp__claude_ai_*"))
        #expect(Sandbox.valor(llamada, "--permission-mode") == "dontAsk")
        #expect(f.sb.cwds.contains { sinPrivate($0) == sinPrivate(f.carpeta) })
        // el archivo del agente se regeneró
        #expect(f.leer(".claude/agents/creador.md").contains("name: creador"))
        // el token se revocó al terminar
        #expect(f.b.mcp.tokens.activos == 0)
        // la actividad vuelve a quedar libre
        #expect(f.b.runner.actividad.vista(oficina: f.carpeta)["creador"] == nil)
    }

    @Test("una sesión que ya está corriendo da 409; el pedido se valida")
    func chatValidaciones() async throws {
        let f = try await Fix.crear(nombre: "Taller", duenio: "Ana")
        f.sb.modo("creador", "puerta")
        let r = await f.post("/api/creador/chat", ["message": "hola", "session": U.b])
        #expect(r.status == 202)
        #expect((await f.post("/api/creador/chat", ["message": "otra vez", "session": U.b])).status == 409)
        let e = await f.get("/api/creador/estado", ["session": U.b])
        #expect(e.obj["corriendo"] as? Bool == true)
        f.sb.abrirPuerta()
        #expect(await esperarAsync(hasta: 15) { (await f.get("/api/creador/estado", ["session": U.b])).obj["corriendo"] as? Bool == false })
        // después de terminar se puede seguir en la misma sesión
        #expect((await f.post("/api/creador/chat", ["message": "seguimos", "session": U.b])).status == 202)
        #expect(await esperarAsync(hasta: 15) { (await f.get("/api/creador/estado", ["session": U.b])).obj["corriendo"] as? Bool == false })

        #expect((await f.post("/api/creador/chat", ["message": "hola", "session": "no-es-uuid"])).status == 400)
        #expect((await f.post("/api/creador/chat", ["message": "   ", "session": U.c])).status == 400)
        #expect((await f.post("/api/creador/chat", ["session": U.c])).status == 400)
        #expect((await f.get("/api/creador/estado", ["session": "x"])).status == 400)
        // una sesión de un agente común no sirve
        let g = try await Fix.crear(nombre: "Otra", duenio: "Ana", agentes: [("marce", "direccion", nil)])
        _ = await chat(g.b, agent: "marce", message: "hola", session: U.d)
        #expect((await g.post("/api/creador/chat", ["message": "hola", "session": U.d])).status == 400)
        // sin oficina, 409
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        #expect((await llamar(b, "POST", "/api/creador/chat", body: json(["message": "hola", "session": U.a]))).status == 409)
        #expect((await llamar(b, "GET", "/api/creador/borrador")).status == 409)
    }
}
}
