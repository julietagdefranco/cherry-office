import Foundation
import Testing
@testable import Backend

/// Modelo de oficina.json: flujos, reglas, misión, límites, conectores y permisos (docs/plan-creador-flujos.md §1).
extension Etapa2 {
@Suite("Modelo de flujos")
struct ModeloTests {
    // MARK: ayudas

    func paso(_ id: String, quien: String = "sofia", recibeDe: [String]? = nil) -> PasoFlujo {
        PasoFlujo(id: id, nombre: "Paso \(id)", quien: quien, recibeDe: recibeDe, entrega: "Algo")
    }

    func oficina(flujos: [FlujoDef]? = nil, reglas: [Regla]? = nil, agentes: [AgenteDef]? = nil) -> Oficina {
        Oficina(nombre: "Taller", duenio: "Ana", departamentos: [Departamento(id: "dir", nombre: "Dirección", color: "#aabbcc")],
                agentes: agentes ?? [AgenteDef(id: "sofia", nombre: "Sofía", rol: "Directora", departamento: "dir")],
                flujos: flujos, reglas: reglas)
    }

    func flujo(_ pasos: [PasoFlujo], id: String = "clase") -> FlujoDef { FlujoDef(id: id, nombre: "Clase", pasos: pasos) }

    func status(_ o: Oficina) -> Int? {
        do { try Validar.oficina(o); return nil } catch let e as ErrorAPI { return e.status } catch { return -1 }
    }

    func agenteCon(_ mod: (inout AgenteDef) -> Void) -> Oficina {
        var a = AgenteDef(id: "sofia", nombre: "Sofía", rol: "Directora", departamento: "dir")
        mod(&a)
        return oficina(agentes: [a])
    }

    // MARK: compatibilidad e ida y vuelta

    @Test("una oficina vieja, sin las claves nuevas, abre bien")
    func oficinaVieja() throws {
        let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("hqmodelo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let viejo = ##"{"version":1,"nombre":"Vieja","duenio":"Ana","departamentos":[{"id":"dir","nombre":"Dirección","color":"#aabbcc"}],"agentes":[{"id":"sofia","nombre":"Sofía","rol":"Directora","departamento":"dir"}]}"##
        try viejo.write(toFile: OficinaStore.ruta(dir), atomically: true, encoding: .utf8)
        let o = try OficinaStore.leer(carpeta: dir)
        #expect(o.flujos == nil && o.reglas == nil)
        #expect(o.departamentos[0].mision == nil)
        #expect(o.agentes[0].limites == nil && o.agentes[0].conectores == nil && o.agentes[0].permisos == nil)
        #expect(!o.agentes[0].esCoordinador)
    }

    func oficinaLlena() -> Oficina {
        let pasos = [
            PasoFlujo(id: "diseno", nombre: "Diseño", quien: "sofia", consigna: "Diseñá la clase", recibe: "El tema",
                      entrega: "Ficha y guion", aprobacion: true, plazoDias: 3),
            PasoFlujo(id: "grabacion", nombre: "Grabación", quien: "persona", recibe: "PPT", entrega: "El archivo"),
            PasoFlujo(id: "edicion", nombre: "Edición", quien: "sofia", recibeDe: ["grabacion", "diseno"], entrega: "Video",
                      aprobacion: true, plazoDias: 5, esperaDias: 7),
        ]
        let a = AgenteDef(id: "sofia", nombre: "Sofía", rol: "Directora", departamento: "dir", brief: "b", modelo: "sonnet",
                          chips: ["x"], avatar: Avatar(semilla: "s"), creado: "2026-01-01T00:00:00Z", escritura: ["conocimiento/x"],
                          limites: LimitesAgente(solo: ["Diseñar fichas"], proponer: ["Cambiar el plan"]),
                          conectores: [ConectorAsignado(servidor: "Google Calendar",
                                                        leer: ["mcp__claude_ai_Google_Calendar__list_events"],
                                                        actuar: ["mcp__claude_ai_Google_Calendar__create_event"])],
                          permisos: ["coordinador"])
        return Oficina(nombre: "Taller", duenio: "Ana",
                       departamentos: [Departamento(id: "dir", nombre: "Dirección", color: "#aabbcc", mision: "Enseñar")],
                       agentes: [a], vinculos: [Vinculo(id: "v", ruta: "/tmp/v")], biblioteca: BibliotecaCfg(maxMB: 5),
                       flujos: [FlujoDef(id: "clase", nombre: "Producción de una clase", descripcion: "d", pasos: pasos, activo: false,
                                         creado: "2026-01-01T00:00:00Z", origen: "texto")],
                       reglas: [Regla(id: "no-inventar", texto: "No inventes datos.", origen: "«No inventar»")])
    }

    @Test("ida y vuelta con todos los campos llenos")
    func idaYVuelta() throws {
        let o = oficinaLlena()
        try Validar.oficina(o)
        let data = try OficinaStore.codificar(o)
        let o2 = try JSONDecoder().decode(Oficina.self, from: data)
        #expect(o2 == o)
        #expect(o2.agentes[0].esCoordinador)
        #expect(o2.flujos?[0].pasos[2].esperaDias == 7)
        #expect(o2.reglas?[0].origen == "«No inventar»")
        #expect(o2.departamentos[0].mision == "Enseñar")
        #expect(o.json["flujos"] != nil && o.json["reglas"] != nil)
    }

    @Test("defaults al decodificar: aprobacion false, activo true, leer y actuar vacíos")
    func defaults() throws {
        let p = try JSONDecoder().decode(PasoFlujo.self, from: Data(#"{"id":"a","nombre":"A","quien":"persona","entrega":"x"}"#.utf8))
        #expect(!p.aprobacion && p.recibeDe == nil)
        let f = try JSONDecoder().decode(FlujoDef.self, from: Data(#"{"id":"f","nombre":"F","pasos":[]}"#.utf8))
        #expect(f.activo)
        let c = try JSONDecoder().decode(ConectorAsignado.self, from: Data(#"{"servidor":"S"}"#.utf8))
        #expect(c.leer == [] && c.actuar == [])
    }

    // MARK: flujos

    @Test("un paso con un agente inexistente valida")
    func agenteInexistente() throws {
        try Validar.oficina(oficina(flujos: [flujo([paso("a", quien: "fantasma")])]))
        try Validar.oficina(oficina(flujos: [flujo([paso("a", quien: "persona")])]))
    }

    @Test("recibeDe hacia un paso posterior (o inexistente) da 400")
    func recibeDePosterior() {
        #expect(status(oficina(flujos: [flujo([paso("a", recibeDe: ["b"]), paso("b")])])) == 400)
        #expect(status(oficina(flujos: [flujo([paso("a", recibeDe: ["a"])])])) == 400)
        #expect(status(oficina(flujos: [flujo([paso("a", recibeDe: ["zzz"])])])) == 400)
        #expect(status(oficina(flujos: [flujo([paso("a"), paso("b", recibeDe: ["a"])])])) == nil)
    }

    @Test("topes de flujos y pasos")
    func topesFlujos() {
        let unos = (0..<31).map { flujo([paso("a")], id: "f\($0)") }
        #expect(status(oficina(flujos: unos)) == 400)
        #expect(status(oficina(flujos: Array(unos.prefix(30)))) == nil)
        #expect(status(oficina(flujos: [flujo([])])) == 400)
        #expect(status(oficina(flujos: [flujo((0..<21).map { paso("p\($0)") })])) == 400)
        #expect(status(oficina(flujos: [flujo((0..<20).map { paso("p\($0)") })])) == nil)
        #expect(status(oficina(flujos: [flujo([paso("a"), paso("a")])])) == 400)
        #expect(status(oficina(flujos: [flujo([paso("a")]), flujo([paso("a")])])) == 400)
        #expect(status(oficina(flujos: [flujo([paso("A_")])])) == 400)
        #expect(status(oficina(flujos: [flujo([paso("a", quien: "Mal Id")])])) == 400)
    }

    @Test("largos y rangos de un paso")
    func largosPaso() {
        func con(_ mod: (inout PasoFlujo) -> Void) -> Int? { var p = paso("a"); mod(&p); return status(oficina(flujos: [flujo([p])])) }
        #expect(con { $0.nombre = String(repeating: "x", count: 81) } == 400)
        #expect(con { $0.consigna = String(repeating: "x", count: 4001) } == 400)
        #expect(con { $0.consigna = String(repeating: "x", count: 4000) } == nil)
        #expect(con { $0.recibe = String(repeating: "x", count: 601) } == 400)
        #expect(con { $0.entrega = String(repeating: "x", count: 601) } == 400)
        #expect(con { $0.plazoDias = 0 } == 400)
        #expect(con { $0.plazoDias = 61 } == 400)
        #expect(con { $0.plazoDias = 60 } == nil)
        #expect(con { $0.esperaDias = 0 } == 400)
        #expect(con { $0.esperaDias = 91 } == 400)
        #expect(con { $0.esperaDias = 90 } == nil)
        var f = flujo([paso("a")]); f.descripcion = String(repeating: "x", count: 601)
        #expect(status(oficina(flujos: [f])) == 400)
    }

    @Test("FlujoDef.desde: ids por defecto, pasos p1 p2, errores 400")
    func flujoDesde() throws {
        let f = try FlujoDef.desde(["nombre": "Producción de una clase",
                                    "pasos": [["nombre": "Uno", "quien": "sofia", "entrega": "A"],
                                              ["nombre": "Dos", "quien": "persona", "entrega": "B", "recibeDe": ["p1"], "aprobacion": true, "plazoDias": 2]]],
                                   idsUsados: [])
        #expect(f.id == "produccion-de-una-clase" && f.activo)
        #expect(f.pasos.map(\.id) == ["p1", "p2"] && f.pasos[1].aprobacion && f.pasos[1].plazoDias == 2)
        let g = try FlujoDef.desde(["nombre": "Producción de una clase", "pasos": [["nombre": "Uno", "quien": "sofia", "entrega": "A"]]],
                                   idsUsados: ["produccion-de-una-clase"])
        #expect(g.id == "produccion-de-una-clase-2")
        let vacio = try FlujoDef.desde(["nombre": "???", "pasos": [["nombre": "Uno", "quien": "sofia", "entrega": "A"]]], idsUsados: [])
        #expect(vacio.id == "flujo")
        func falla(_ d: [String: Any]) -> Int? { do { _ = try FlujoDef.desde(d, idsUsados: []); return nil } catch let e as ErrorAPI { return e.status } catch { return -1 } }
        #expect(falla(["pasos": [["nombre": "U", "quien": "s", "entrega": "A"]]]) == 400)
        #expect(falla(["nombre": "F", "pasos": []]) == 400)
        #expect(falla(["nombre": "F", "pasos": [["nombre": "U", "quien": "s", "entrega": "A", "recibeDe": ["p2"]], ["nombre": "V", "quien": "s", "entrega": "A"]]]) == 400)
        #expect(falla(["nombre": "F", "pasos": [["nombre": "U", "quien": "s", "entrega": "A", "plazoDias": "tres"]]]) == 400)
        #expect(falla(["nombre": "F", "pasos": [["nombre": "U", "quien": "s", "entrega": "A", "aprobacion": "si"]]]) == 400)
    }

    // MARK: reglas

    @Test("41 reglas dan 400; 40 valen")
    func reglasTope() {
        let rs = (0..<41).map { Regla(id: "r\($0)", texto: "t") }
        #expect(status(oficina(reglas: rs)) == 400)
        #expect(status(oficina(reglas: Array(rs.prefix(40)))) == nil)
    }

    @Test("reglas: ids únicos y texto de 1 a 600")
    func reglasCampos() throws {
        #expect(status(oficina(reglas: [Regla(id: "a", texto: "t"), Regla(id: "a", texto: "u")])) == 400)
        #expect(status(oficina(reglas: [Regla(id: "A b", texto: "t")])) == 400)
        #expect(status(oficina(reglas: [Regla(id: "a", texto: "  ")])) == 400)
        #expect(status(oficina(reglas: [Regla(id: "a", texto: String(repeating: "x", count: 601))])) == 400)
        let r = try Regla.desde(["texto": "No inventes datos"], idsUsados: ["no-inventes-datos"])
        #expect(r.id == "no-inventes-datos-2")
        #expect(throws: ErrorAPI.self) { try Regla.desde([:], idsUsados: []) }
    }

    // MARK: campos del agente

    @Test("una herramienta mcp__hq__ da 400; sin prefijo mcp__ también")
    func herramientas() {
        func con(_ h: String, actuar: Bool = false) -> Int? {
            status(agenteCon { $0.conectores = [ConectorAsignado(servidor: "S", leer: actuar ? [] : [h], actuar: actuar ? [h] : [])] })
        }
        #expect(con("mcp__hq__consultar") == 400)
        #expect(con("mcp__hq__consultar", actuar: true) == 400)
        #expect(con("Bash") == 400)
        #expect(con("mcp__x__" + String(repeating: "a", count: 200)) == 400)
        #expect(con("mcp__claude_ai_Google_Calendar__list_events") == nil)
    }

    @Test("topes de conectores, límites y misión")
    func topesAgente() {
        let ok = ConectorAsignado(servidor: "S")
        #expect(status(agenteCon { $0.conectores = Array(repeating: ok, count: 13) }) == 400)
        #expect(status(agenteCon { $0.conectores = Array(repeating: ok, count: 12) }) == nil)
        #expect(status(agenteCon { $0.conectores = [ConectorAsignado(servidor: "")] }) == 400)
        #expect(status(agenteCon { $0.conectores = [ConectorAsignado(servidor: String(repeating: "s", count: 81))] }) == 400)
        let muchas = (0..<81).map { "mcp__s__t\($0)" }
        #expect(status(agenteCon { $0.conectores = [ConectorAsignado(servidor: "S", leer: muchas)] }) == 400)
        #expect(status(agenteCon { $0.limites = LimitesAgente(solo: Array(repeating: "x", count: 13)) }) == 400)
        #expect(status(agenteCon { $0.limites = LimitesAgente(proponer: [String(repeating: "x", count: 301)]) }) == 400)
        #expect(status(agenteCon { $0.limites = LimitesAgente(solo: Array(repeating: "x", count: 12)) }) == nil)
        var o = oficina()
        o.departamentos[0].mision = String(repeating: "x", count: 601)
        #expect(status(o) == 400)
        o.departamentos[0].mision = String(repeating: "x", count: 600)
        #expect(status(o) == nil)
    }

    @Test("un permiso inválido o repetido da 400")
    func permisos() {
        #expect(status(agenteCon { $0.permisos = ["jefe"] }) == 400)
        #expect(status(agenteCon { $0.permisos = ["coordinador", "coordinador"] }) == 400)
        #expect(status(agenteCon { $0.permisos = ["coordinador"] }) == nil)
    }

    @Test("'persona' y 'creador' están reservados")
    func reservados() async throws {
        #expect(Validar.reservados.contains("persona") && Validar.reservados.contains("creador"))
        let f = try await Fix.crear()
        for id in ["persona", "creador"] {
            let r = await contratar(f.b, id: id, depto: "direccion")
            #expect(r.status == 400, "\(id): \(r.obj)")
        }
        // y si el id no viene, el slug del nombre no cae en uno reservado
        let r = await f.post("/api/agentes", ["nombre": "Persona", "rol": "R", "prompt": "Sos.", "departamento": "direccion"])
        #expect(r.status == 200)
        #expect(dict(r.obj["agente"])["id"] as? String == "persona-2")
    }

    // MARK: API

    @Test("POST /api/agentes con limites, conectores y permisos")
    func postAgente() async throws {
        let f = try await Fix.crear()
        let r = await contratar(f.b, id: "sofia", depto: "direccion", extra: [
            "limites": ["solo": ["Diseñar fichas"], "proponer": ["Cambiar el plan"]],
            "conectores": [["servidor": "Google Calendar", "leer": ["mcp__claude_ai_Google_Calendar__list_events"]]],
            "permisos": ["coordinador"]])
        #expect(r.status == 200, "\(r.obj)")
        let a = dict(r.obj["agente"])
        #expect(dict(a["limites"])["solo"] as? [String] == ["Diseñar fichas"])
        #expect(dict(a["limites"])["proponer"] as? [String] == ["Cambiar el plan"])
        let c = lista(a["conectores"])
        #expect(c.count == 1 && c[0]["servidor"] as? String == "Google Calendar")
        #expect(c[0]["leer"] as? [String] == ["mcp__claude_ai_Google_Calendar__list_events"] && c[0]["actuar"] as? [String] == [])
        #expect(a["permisos"] as? [String] == ["coordinador"])
        // quedó en oficina.json
        let en = lista(f.oficinaJSON()["agentes"]).first
        #expect(en?["permisos"] as? [String] == ["coordinador"])
        // sin los campos nuevos no aparecen
        let s = await contratar(f.b, id: "simple", depto: "direccion")
        #expect(dict(s.obj["agente"])["limites"] == nil && dict(s.obj["agente"])["conectores"] == nil && dict(s.obj["agente"])["permisos"] == nil)
        // errores
        let antes = f.leer("oficina.json")
        #expect((await contratar(f.b, id: "x1", depto: "direccion", extra: ["permisos": ["jefe"]])).status == 400)
        #expect((await contratar(f.b, id: "x2", depto: "direccion", extra: ["conectores": [["servidor": "S", "actuar": ["mcp__hq__consultar"]]]])).status == 400)
        #expect((await contratar(f.b, id: "x3", depto: "direccion", extra: ["limites": ["solo": "no es lista"]])).status == 400)
        #expect((await contratar(f.b, id: "x4", depto: "direccion", extra: ["conectores": "no"])).status == 400)
        #expect(f.leer("oficina.json") == antes)
    }

    @Test("PATCH /api/agentes/:id reemplaza, y una lista vacía borra")
    func patchAgente() async throws {
        let f = try await Fix.crear(agentes: [("sofia", "direccion", "Directora")])
        let r = await f.patch("/api/agentes/sofia", [
            "limites": ["solo": ["A", "B"]],
            "conectores": [["servidor": "Gmail", "leer": ["mcp__claude_ai_Gmail__search_threads"], "actuar": ["mcp__claude_ai_Gmail__create_draft"]]],
            "permisos": ["coordinador"]])
        #expect(r.status == 200, "\(r.obj)")
        var a = dict(r.obj["agente"])
        #expect(dict(a["limites"])["solo"] as? [String] == ["A", "B"])
        #expect(lista(a["conectores"]).first?["servidor"] as? String == "Gmail")
        #expect(a["permisos"] as? [String] == ["coordinador"])
        // otro campo no toca los nuevos
        let n = await f.patch("/api/agentes/sofia", ["rol": "Jefa"])
        a = dict(n.obj["agente"])
        #expect(a["permisos"] as? [String] == ["coordinador"] && a["limites"] != nil && a["conectores"] != nil)
        // reemplaza
        let rep = await f.patch("/api/agentes/sofia", ["limites": ["proponer": ["C"]]])
        a = dict(rep.obj["agente"])
        #expect(dict(a["limites"])["solo"] == nil && dict(a["limites"])["proponer"] as? [String] == ["C"])
        // vacío borra
        let b = await f.patch("/api/agentes/sofia", ["limites": [String: Any](), "conectores": [Any](), "permisos": [Any]()])
        #expect(b.status == 200)
        a = dict(b.obj["agente"])
        #expect(a["limites"] == nil && a["conectores"] == nil && a["permisos"] == nil)
        let en = try #require(lista(f.oficinaJSON()["agentes"]).first)
        #expect(en["limites"] == nil && en["conectores"] == nil && en["permisos"] == nil)
        // errores: no cambia nada
        let antes = f.leer("oficina.json")
        #expect((await f.patch("/api/agentes/sofia", ["permisos": ["rey"]])).status == 400)
        #expect((await f.patch("/api/agentes/sofia", ["conectores": [["servidor": "S", "leer": ["mcp__hq__x"]]]])).status == 400)
        #expect((await f.patch("/api/agentes/sofia", ["limites": [1, 2]])).status == 400)
        #expect(f.leer("oficina.json") == antes)
    }

    @Test("misión del departamento: se guarda, un texto vacío la borra, y el tope es 600")
    func misionDepartamento() async throws {
        let f = try await Fix.crear()
        let a = try await f.b.oficinas.editarDepartamento("direccion", nombre: nil, color: nil, mision: "  Dirigir bien  ")
        #expect(a.0.mision == "Dirigir bien")
        #expect(lista(f.oficinaJSON()["departamentos"]).first?["mision"] as? String == "Dirigir bien")
        let b = try await f.b.oficinas.editarDepartamento("direccion", nombre: "Dir", color: nil)
        #expect(b.0.mision == "Dirigir bien" && b.0.nombre == "Dir")
        let c = try await f.b.oficinas.editarDepartamento("direccion", nombre: nil, color: nil, mision: "   ")
        #expect(c.0.mision == nil)
        await #expect(throws: ErrorAPI.self) {
            _ = try await f.b.oficinas.editarDepartamento("direccion", nombre: nil, color: nil, mision: String(repeating: "x", count: 601))
        }
    }

    @Test("después de despedir a un agente nombrado en un flujo, la oficina sigue abriendo")
    func despedirConFlujo() async throws {
        let f = try await Fix.crear(agentes: [("sofia", "direccion", "Directora"), ("armando", "redes", "Editor")])
        var j = f.oficinaJSON()
        j["flujos"] = [["id": "clase", "nombre": "Clase", "pasos": [
            ["id": "a", "nombre": "A", "quien": "sofia", "entrega": "x"],
            ["id": "b", "nombre": "B", "quien": "armando", "entrega": "y"]]]]
        try json(j).write(to: URL(fileURLWithPath: f.ruta("oficina.json")))
        let d = await f.delete("/api/agentes/armando")
        #expect(d.status == 200, "\(d.obj)")
        let abrir = await f.post("/api/oficinas/abrir", ["carpeta": f.carpeta])
        #expect(abrir.status == 200, "\(abrir.obj)")
        let o = try OficinaStore.leer(carpeta: f.carpeta)
        #expect(o.flujos?[0].pasos[1].quien == "armando")
        #expect(o.agente("armando") == nil)
    }
}
}
