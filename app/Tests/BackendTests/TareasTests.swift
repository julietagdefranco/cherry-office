import Foundation
import Testing
@testable import Backend

// Tareas programadas (Fase 5): lógica pura de horarios, validación del modelo, rutas, ejecución y programador.

private let ba = "America/Argentina/Buenos_Aires"
private let ny = "America/New_York"

/// Instante a partir de un ISO con desplazamiento, p. ej. "2026-11-13T08:00:00-03:00".
private func f(_ s: String) -> Date { Programacion.fecha(s)! }

private func tarea(dias: [Int] = [1, 2, 3, 4, 5], hora: String = "08:00", zona: String? = ba, activa: Bool = true,
                   creada: String? = nil, desde: String? = nil) -> TareaProgramada {
    TareaProgramada(id: "informe", agente: "marce", nombre: "Informe", consigna: "Armá el informe", dias: dias, hora: hora,
                    zona: zona, activa: activa, creada: creada, desde: desde)
}

/// Zona del sistema distinta de las de las tareas, para comprobar que se usa la de la tarea.
private let sistemaUTC = TimeZone(identifier: "UTC")!

@Suite("Tareas: lógica pura de horarios")
struct ProgramacionTests {
    // 2026-11-13 es viernes; el 15 es domingo y el 16 lunes.

    @Test("próxima: horario de su zona, en los días marcados, estrictamente posterior")
    func proxima() {
        let t = tarea()
        #expect(Programacion.proxima(t, desde: f("2026-11-13T07:00:00-03:00"), sistema: sistemaUTC) == f("2026-11-13T08:00:00-03:00"))
        // justo en el horario ya cuenta como pasado
        #expect(Programacion.proxima(t, desde: f("2026-11-13T08:00:00-03:00"), sistema: sistemaUTC) == f("2026-11-16T08:00:00-03:00"))
        // el sábado salta al lunes: el domingo (7) no está marcado
        #expect(Programacion.proxima(t, desde: f("2026-11-14T09:00:00-03:00"), sistema: sistemaUTC) == f("2026-11-16T08:00:00-03:00"))
        // vista desde UTC la misma tarea sigue siendo a las 08:00 de Buenos Aires (11:00Z)
        #expect(Programacion.proxima(t, desde: f("2026-11-13T00:00:00Z"), sistema: sistemaUTC) == f("2026-11-13T11:00:00Z"))
    }

    @Test("días ISO: 1 = lunes … 7 = domingo")
    func diasISO() {
        let domingo = tarea(dias: [7])
        #expect(Programacion.proxima(domingo, desde: f("2026-11-13T07:00:00-03:00")) == f("2026-11-15T08:00:00-03:00"))
        let lunes = tarea(dias: [1])
        #expect(Programacion.proxima(lunes, desde: f("2026-11-13T07:00:00-03:00")) == f("2026-11-16T08:00:00-03:00"))
        let finde = tarea(dias: [6, 7])
        #expect(Programacion.proxima(finde, desde: f("2026-11-13T07:00:00-03:00")) == f("2026-11-14T08:00:00-03:00"))
        #expect(Programacion.proxima(tarea(dias: []), desde: f("2026-11-13T07:00:00-03:00")) == nil)
    }

    @Test("sin zona usa la del sistema")
    func zonaDelSistema() {
        let t = tarea(zona: nil)
        let sis = TimeZone(identifier: ny)!
        #expect(Programacion.proxima(t, desde: f("2026-11-13T00:00:00Z"), sistema: sis) == f("2026-11-13T08:00:00-05:00"))
        #expect(Programacion.proxima(t, desde: f("2026-11-13T00:00:00Z"), sistema: sistemaUTC) == f("2026-11-13T08:00:00Z"))
    }

    @Test("DST (Nueva York): sigue siendo la misma hora de pared al cambiar el horario")
    func dst() {
        let t = tarea(dias: [1, 2, 3, 4, 5, 6, 7], hora: "09:00", zona: ny)
        // primavera: el 8/3/2026 a las 02:00 los relojes saltan a las 03:00 (23 h entre una corrida y la otra)
        let sab = f("2026-03-07T09:00:00-05:00")
        let dom = Programacion.proxima(t, desde: sab, sistema: sistemaUTC)
        #expect(dom == f("2026-03-08T09:00:00-04:00"))
        #expect(dom!.timeIntervalSince(sab) == 23 * 3600)
        // otoño: el 1/11/2026 los relojes vuelven una hora (25 h)
        let sab2 = f("2026-10-31T09:00:00-04:00")
        let dom2 = Programacion.proxima(t, desde: sab2, sistema: sistemaUTC)
        #expect(dom2 == f("2026-11-01T09:00:00-05:00"))
        #expect(dom2!.timeIntervalSince(sab2) == 25 * 3600)
    }

    @Test("DST: una hora que no existe ese día corre una sola vez, corrida hacia adelante")
    func dstHoraInexistente() {
        let t = tarea(dias: [1, 2, 3, 4, 5, 6, 7], hora: "02:30", zona: ny)
        let p = Programacion.proxima(t, desde: f("2026-03-08T00:00:00-05:00"), sistema: sistemaUTC)
        #expect(p == f("2026-03-08T03:30:00-04:00"))
        #expect(Programacion.proxima(t, desde: p!, sistema: sistemaUTC) == f("2026-03-09T02:30:00-04:00"))
    }

    @Test("debeCorrer: en su horario, una vez, y solo en días marcados")
    func debeCorrer() {
        let t = tarea()
        let vie8 = f("2026-11-13T08:00:00-03:00")
        // todavía no es la hora (y la de ayer quedó a más de 12 h)
        #expect(Programacion.debeCorrer(t, ahora: f("2026-11-13T07:59:00-03:00"), ultimaProgramada: nil, sistema: sistemaUTC) == nil)
        // en el horario
        #expect(Programacion.debeCorrer(t, ahora: f("2026-11-13T08:00:10-03:00"), ultimaProgramada: nil, sistema: sistemaUTC) == vie8)
        // nunca dos veces la misma programada
        #expect(Programacion.debeCorrer(t, ahora: f("2026-11-13T08:00:40-03:00"), ultimaProgramada: vie8, sistema: sistemaUTC) == nil)
        #expect(Programacion.debeCorrer(t, ahora: f("2026-11-13T15:00:00-03:00"), ultimaProgramada: vie8, sistema: sistemaUTC) == nil)
        // fin de semana: no hay horario marcado y la del viernes ya pasó hace más de 12 h
        #expect(Programacion.debeCorrer(t, ahora: f("2026-11-14T09:00:00-03:00"), ultimaProgramada: vie8, sistema: sistemaUTC) == nil)
        #expect(Programacion.debeCorrer(t, ahora: f("2026-11-15T09:00:00-03:00"), ultimaProgramada: nil, sistema: sistemaUTC) == nil)
        // inactiva
        #expect(Programacion.debeCorrer(tarea(activa: false), ahora: f("2026-11-13T08:00:10-03:00"), ultimaProgramada: nil, sistema: sistemaUTC) == nil)
    }

    @Test("puesta al día: una vez si pasaron menos de 12 h; más, no")
    func puestaAlDia() {
        let t = tarea()
        let vie8 = f("2026-11-13T08:00:00-03:00")
        let jue8 = f("2026-11-12T08:00:00-03:00")
        // la app estaba cerrada a las 8 y se abre a las 19:59 (11 h 59 min después)
        #expect(Programacion.debeCorrer(t, ahora: f("2026-11-13T19:59:00-03:00"), ultimaProgramada: jue8, sistema: sistemaUTC) == vie8)
        // 12 h exactas o más: se perdió
        #expect(Programacion.debeCorrer(t, ahora: f("2026-11-13T20:00:00-03:00"), ultimaProgramada: jue8, sistema: sistemaUTC) == nil)
        #expect(Programacion.debeCorrer(t, ahora: f("2026-11-13T20:01:00-03:00"), ultimaProgramada: jue8, sistema: sistemaUTC) == nil)
        // cerrada varios días: corre solo la última (una vez), no las atrasadas
        let mie8 = f("2026-11-11T08:00:00-03:00")
        #expect(Programacion.debeCorrer(t, ahora: f("2026-11-13T09:00:00-03:00"), ultimaProgramada: mie8, sistema: sistemaUTC) == vie8)
        // cruzando la medianoche: una tarea de las 23:00 se pone al día a las 05:00 del día siguiente
        let noche = tarea(dias: [1, 2, 3, 4, 5, 6, 7], hora: "23:00")
        #expect(Programacion.debeCorrer(noche, ahora: f("2026-11-14T05:00:00-03:00"), ultimaProgramada: nil, sistema: sistemaUTC)
                == f("2026-11-13T23:00:00-03:00"))
    }

    @Test("una tarea nueva o movida no se pone al día con un horario anterior a su creación")
    func nuevaNoSePoneAlDia() {
        let ahora = f("2026-11-13T10:00:00-03:00")
        #expect(Programacion.debeCorrer(tarea(), ahora: ahora, ultimaProgramada: nil, sistema: sistemaUTC) == f("2026-11-13T08:00:00-03:00"))
        #expect(Programacion.debeCorrer(tarea(creada: "2026-11-13T12:50:00Z"), ahora: ahora, ultimaProgramada: nil, sistema: sistemaUTC) == nil)
        #expect(Programacion.debeCorrer(tarea(creada: "2026-11-01T00:00:00Z", desde: "2026-11-13T12:50:00Z"), ahora: ahora,
                                        ultimaProgramada: nil, sistema: sistemaUTC) == nil)
        #expect(Programacion.debeCorrer(tarea(creada: "2026-11-12T00:00:00Z"), ahora: ahora, ultimaProgramada: nil, sistema: sistemaUTC) != nil)
    }

    @Test("simulación minuto a minuto: una sola corrida por horario (cada 30 s, con DST y todo)")
    func simulacion() {
        for (zona, dia) in [(ba, "2026-11-13"), (ny, "2026-03-08"), (ny, "2026-11-01")] {
            let t = tarea(dias: [1, 2, 3, 4, 5, 6, 7], hora: "09:00", zona: zona)
            let off = TimeZone(identifier: zona)!.secondsFromGMT(for: f("\(dia)T12:00:00Z"))
            var cuando = f("\(dia)T00:00:00Z").addingTimeInterval(-3600 * 12)
            let fin = cuando.addingTimeInterval(3 * 86400)
            var ultima: Date?
            var corridas: [Date] = []
            while cuando < fin {
                if let p = Programacion.debeCorrer(t, ahora: cuando, ultimaProgramada: ultima, sistema: sistemaUTC) { corridas.append(p); ultima = p }
                cuando.addTimeInterval(30)
            }
            #expect(corridas.count == 3 || corridas.count == 4, "\(zona) \(dia): \(corridas.count) corridas (off \(off))")
            #expect(Set(corridas).count == corridas.count)
        }
    }

    @Test("validación del modelo: hora, días, zona, consigna, id, agente y máximo")
    func validacion() throws {
        func of(_ ts: [TareaProgramada]) -> Oficina {
            Oficina(nombre: "O", duenio: "", departamentos: [Departamento(id: "d", nombre: "D", color: "#aaaaaa")],
                    agentes: [AgenteDef(id: "marce", nombre: "Marce", rol: "r", departamento: "d")], tareas: ts)
        }
        try Validar.oficina(of([tarea()]))
        try Validar.oficina(of([]))
        func malo(_ t: TareaProgramada, _ m: String = "") {
            #expect(throws: ErrorAPI.self, "\(m)") { try Validar.oficina(of([t])) }
        }
        var t = tarea(); t.hora = "8:00"; malo(t, "hora corta")
        t.hora = "24:00"; malo(t, "hora 24")
        t.hora = "08:60"; malo(t, "minuto 60")
        t = tarea(dias: []); malo(t, "sin días")
        malo(tarea(dias: [0]), "día 0")
        malo(tarea(dias: [8]), "día 8")
        malo(tarea(dias: [1, 1]), "día repetido")
        malo(tarea(zona: "Marte/Base"), "zona")
        t = tarea(); t.consigna = "  "; malo(t, "consigna vacía")
        t.consigna = String(repeating: "x", count: 4001); malo(t, "consigna larga")
        t = tarea(); t.id = "Mal Id"; malo(t, "id")
        t = tarea(); t.agente = "nadie"; malo(t, "agente inexistente activo")
        // desactivada de un agente que ya no está: es válida (así se conservan al despedir)
        t.activa = false
        try Validar.oficina(of([t]))
        // id repetido y máximo
        #expect(throws: ErrorAPI.self) { try Validar.oficina(of([tarea(), tarea()])) }
        let muchas = (0..<51).map { i -> TareaProgramada in var x = tarea(); x.id = "t\(i)"; return x }
        #expect(throws: ErrorAPI.self) { try Validar.oficina(of(muchas)) }
        try Validar.oficina(of(Array(muchas.prefix(50))))
    }

    @Test("oficina.json sin `tareas` se lee igual y no la escribe; con `tareas` va y vuelve")
    func decodificacion() throws {
        let sinTareas = Data(#"{"version":1,"nombre":"O","duenio":"","departamentos":[],"agentes":[]}"#.utf8)
        let o = try JSONDecoder().decode(Oficina.self, from: sinTareas)
        #expect(o.tareas == nil)
        #expect(o.json["tareas"] == nil)
        let con = Data(#"{"version":1,"nombre":"O","departamentos":[],"agentes":[],"tareas":[{"id":"a","agente":"x","nombre":"N","consigna":"C","dias":[1],"hora":"08:00"}]}"#.utf8)
        let o2 = try JSONDecoder().decode(Oficina.self, from: con)
        #expect(o2.tareas?.first?.activa == true)
        #expect(o2.tareas?.first?.zona == nil)
        #expect(o2.json["tareas"] != nil)
    }
}

/// Recoge las ejecuciones que avisa el gancho `alTerminar`.
private final class Gancho: @unchecked Sendable {
    private let lock = NSLock()
    private var l: [Ejecucion] = []
    func agregar(_ e: Ejecucion) { lock.lock(); l.append(e); lock.unlock() }
    var todas: [Ejecucion] { lock.lock(); defer { lock.unlock() }; return l }
}

private final class Reloj: @unchecked Sendable {
    private let lock = NSLock()
    private var d: Date
    init(_ d: Date) { self.d = d }
    var ahora: Date { lock.lock(); defer { lock.unlock() }; return d }
    func poner(_ n: Date) { lock.lock(); d = n; lock.unlock() }
}

extension Etapa2 {
@Suite("Tareas programadas (API y programador)")
struct TareasAPITests {
    /// Oficina con Marce y Nico; el bucle del programador apagado (los tests llaman a `revisar()` con un reloj propio).
    func fix() async throws -> Fix {
        try await Fix.crear(deps: ["Dirección"], agentes: [("marce", "direccion", "Directora"), ("nico", "direccion", "Ads")],
                            env: ["HQ_PROGRAMADOR": "0"])
    }

    func nueva(_ f: Fix, _ extra: [String: Any] = [:]) async -> Resp {
        var d: [String: Any] = ["agente": "marce", "nombre": "Informe diario", "consigna": "Armá el informe de ayer",
                                "dias": [1, 2, 3, 4, 5], "hora": "08:00", "zona": ba]
        for (k, v) in extra { d[k] = v }
        return await f.post("/api/tareas", d)
    }

    func ejecuciones(_ f: Fix, _ id: String) async -> [[String: Any]] { lista(await f.get("/api/tareas/\(id)/ejecuciones").obj["ejecuciones"]) }

    /// Espera a que la última ejecución de la tarea deje de estar «corriendo» y la devuelve.
    @discardableResult
    func terminada(_ f: Fix, _ id: String, cuantas: Int = 1) async -> [String: Any] {
        _ = await esperarAsync(hasta: 15) {
            let e = await ejecuciones(f, id)
            return e.count >= cuantas && e.first.map { str($0["estado"]) != "corriendo" } == true
        }
        return await ejecuciones(f, id).first ?? [:]
    }

    // MARK: CRUD

    @Test("crear: guarda en oficina.json, devuelve proxima y zona; sin zona toma la del sistema")
    func crear() async throws {
        let f = try await fix()
        let r = await nueva(f)
        #expect(r.status == 200, "\(r.obj)")
        let t = dict(r.obj["tarea"])
        #expect(str(t["id"]) == "informe-diario")
        #expect(t["dias"] as? [Int] == [1, 2, 3, 4, 5])
        #expect(str(t["zona"]) == ba)
        #expect(t["activa"] as? Bool == true)
        #expect(Programacion.fecha(str(t["proxima"])) != nil)
        #expect(t["ultima"] is NSNull)
        #expect(!str(t["creada"]).isEmpty)
        let enDisco = lista(f.oficinaJSON()["tareas"])
        #expect(enDisco.count == 1 && str(enDisco[0]["consigna"]) == "Armá el informe de ayer")

        let sinZona = await f.post("/api/tareas", ["agente": "nico", "nombre": "Otra", "consigna": "x", "dias": [7], "hora": "21:30"])
        #expect(sinZona.status == 200)
        #expect(str(dict(sinZona.obj["tarea"])["zona"]) == TimeZone.current.identifier)

        let l = await f.get("/api/tareas")
        #expect(l.status == 200)
        #expect(lista(l.obj["tareas"]).map { str($0["id"]) } == ["informe-diario", "otra"])
        // mismo nombre: id distinto
        #expect(str(dict((await nueva(f)).obj["tarea"])["id"]) == "informe-diario-2")
    }

    @Test("crear: validaciones (400), agente inexistente (404), id repetido (409), tope de 50")
    func crearValidaciones() async throws {
        let f = try await fix()
        func malo(_ extra: [String: Any], _ estado: Int = 400) async {
            let r = await nueva(f, extra)
            #expect(r.status == estado, "\(extra) -> \(r.status) \(r.obj)")
            #expect(!str(r.obj["error"]).isEmpty)
        }
        await malo(["dias": []])
        await malo(["dias": [0]])
        await malo(["dias": [8]])
        await malo(["dias": [1, 1]])
        await malo(["dias": "lunes"])
        await malo(["dias": [true]])
        await malo(["hora": "8:00"])
        await malo(["hora": "24:00"])
        await malo(["hora": "07:75"])
        await malo(["hora": 800])
        await malo(["zona": "Marte/Base"])
        await malo(["consigna": ""])
        await malo(["consigna": String(repeating: "x", count: 4001)])
        await malo(["nombre": " "])
        await malo(["activa": "si"])
        await malo(["id": "Con Espacios"])
        await malo(["agente": "nadie"], 404)
        #expect((await f.post("/api/tareas", ["agente": "marce"])).status == 400)
        #expect((await llamar(f.b, "POST", "/api/tareas", body: Data("no json".utf8))).status == 400)
        #expect((await llamar(f.b, "POST", "/api/tareas")).status == 400)
        #expect((await nueva(f, ["id": "fija"])).status == 200)
        await malo(["id": "fija"], 409)
        for i in 1..<50 { #expect((await nueva(f, ["nombre": "T\(i)"])).status == 200) }
        #expect(lista(f.oficinaJSON()["tareas"]).count == 50)
        await malo([:])
        #expect(lista(f.oficinaJSON()["tareas"]).count == 50)
    }

    @Test("editar: parcial, valida igual, 404 si no existe; el horario o reactivar fijan «desde»")
    func editar() async throws {
        let f = try await fix()
        _ = await nueva(f)
        let r = await f.patch("/api/tareas/informe-diario", ["nombre": "Informe de la mañana", "hora": "09:15", "dias": [1, 3, 5], "activa": false])
        #expect(r.status == 200, "\(r.obj)")
        let t = dict(r.obj["tarea"])
        #expect(str(t["nombre"]) == "Informe de la mañana" && str(t["hora"]) == "09:15")
        #expect(t["dias"] as? [Int] == [1, 3, 5] && t["activa"] as? Bool == false)
        #expect(t["proxima"] is NSNull, "una tarea en pausa no tiene próxima corrida")
        #expect(str(lista(f.oficinaJSON()["tareas"])[0]["consigna"]) == "Armá el informe de ayer", "lo que no se manda no cambia")
        let react = await f.patch("/api/tareas/informe-diario", ["activa": true, "zona": ny])
        #expect(react.status == 200)
        #expect(Programacion.fecha(str(dict(react.obj["tarea"])["proxima"])) != nil)
        #expect(str(dict(react.obj["tarea"])["zona"]) == ny)
        #expect(lista(f.oficinaJSON()["tareas"])[0]["desde"] != nil)
        #expect((await f.patch("/api/tareas/informe-diario", ["hora": "99:00"])).status == 400)
        #expect((await f.patch("/api/tareas/informe-diario", ["zona": "x/y"])).status == 400)
        #expect((await f.patch("/api/tareas/informe-diario", ["dias": []])).status == 400)
        #expect((await f.patch("/api/tareas/informe-diario", ["consigna": String(repeating: "x", count: 4001)])).status == 400)
        #expect((await f.patch("/api/tareas/no-existe", ["nombre": "x"])).status == 404)
        #expect((await f.patch("/api/tareas/Mal Id", ["nombre": "x"])).status == 404)
        #expect((await llamar(f.b, "PATCH", "/api/tareas/informe-diario")).status == 400)
        #expect((await llamar(f.b, "PUT", "/api/tareas/informe-diario")).status == 405)
    }

    @Test("una tarea que termina deja un aviso «te necesita» de tipo tarea y avisa al canal de notificaciones")
    func avisoAlTerminar() async throws {
        let f = try await fix()
        let canal = Caja()
        f.b.avisos.alCrear { a, nombre in canal.agregar("\(a.tipo):\(nombre)") }
        _ = await nueva(f)
        #expect((await f.post("/api/tareas/informe-diario/correr")).status == 202)
        await terminada(f, "informe-diario")
        let ok = await esperarAsync { lista(await f.get("/api/avisos").obj["avisos"]).contains { str($0["tipo"]) == "tarea" } }
        #expect(ok)
        let av = lista(await f.get("/api/avisos").obj["avisos"]).first { str($0["tipo"]) == "tarea" } ?? [:]
        #expect(str(av["agente"]) == "marce")
        #expect(str(av["texto"]).hasPrefix("«"))
        #expect(canal.lineas.contains { $0.hasPrefix("tarea:") })
    }

    @Test("borrar: saca la tarea y sus ejecuciones; 404 si no existe")
    func borrar() async throws {
        let f = try await fix()
        _ = await nueva(f)
        let c = await f.post("/api/tareas/informe-diario/correr")
        #expect(c.status == 202)
        await terminada(f, "informe-diario")
        let d = await f.delete("/api/tareas/informe-diario")
        #expect(d.status == 200 && d.obj["ok"] as? Bool == true)
        #expect(lista(await f.get("/api/tareas").obj["tareas"]).isEmpty)
        #expect(f.oficinaJSON()["tareas"] == nil)
        #expect((await f.get("/api/tareas/informe-diario/ejecuciones")).status == 404)
        #expect((await f.delete("/api/tareas/informe-diario")).status == 404)
        // si se vuelve a crear con el mismo id no hereda historial
        _ = await nueva(f)
        #expect(await ejecuciones(f, "informe-diario").isEmpty)
    }

    @Test("despedir al agente desactiva sus tareas (no las borra) y no se pueden reactivar")
    func despedir() async throws {
        let f = try await fix()
        _ = await nueva(f)
        _ = await nueva(f, ["agente": "nico", "nombre": "De Nico"])
        #expect((await f.delete("/api/agentes/marce")).status == 200)
        let ts = lista(await f.get("/api/tareas").obj["tareas"])
        #expect(ts.count == 2)
        let marce = try #require(ts.first { str($0["id"]) == "informe-diario" })
        #expect(marce["activa"] as? Bool == false && marce["proxima"] is NSNull)
        #expect(ts.first { str($0["id"]) == "de-nico" }?["activa"] as? Bool == true)
        #expect((await f.patch("/api/tareas/informe-diario", ["activa": true])).status == 409)
        #expect((await f.post("/api/tareas/informe-diario/correr")).status == 409)
        // oficina.json sigue siendo válido y se puede volver a leer
        #expect((await f.get("/api/oficina")).status == 200)
    }

    @Test("sin oficina abierta: 409")
    func sinOficina() async throws {
        let sin = try Sandbox().backend(env: ["HQ_PROGRAMADOR": "0"], oficina: false)
        #expect((await llamar(sin, "GET", "/api/tareas")).status == 409)
        let cuerpo = json(["agente": "a", "nombre": "n", "consigna": "c", "dias": [1], "hora": "08:00"])
        #expect((await llamar(sin, "POST", "/api/tareas", body: cuerpo)).status == 409)
        #expect((await llamar(sin, "POST", "/api/tareas/x/correr")).status == 409)
    }

    // MARK: ejecución

    @Test("probar ahora: 202 con la ejecución; corre al agente con sus permisos en una sesión nueva; queda ok con costo")
    func probarAhora() async throws {
        let f = try await fix()
        _ = await nueva(f, ["consigna": "Armá el informe"])
        let avisos = Gancho()
        await f.b.programador.alTerminar { avisos.agregar($0) }
        let r = await f.post("/api/tareas/informe-diario/correr")
        #expect(r.status == 202, "\(r.obj)")
        let ej = dict(r.obj["ejecucion"])
        #expect(str(ej["estado"]) == "corriendo" && ej["manual"] as? Bool == true)
        #expect(str(ej["agente"]) == "marce" && str(ej["tarea"]) == "informe-diario")
        let sid = str(ej["sid"])
        #expect(Router.uuidValido(sid))

        let fin = await terminada(f, "informe-diario")
        #expect(str(fin["estado"]) == "ok", "\(fin)")
        #expect(str(fin["resultado"]) == "hola marce")
        #expect(abs((fin["costo"] as? Double ?? 0) - 0.01) < 1e-9)
        #expect(!(fin["fin"] is NSNull) && fin["error"] is NSNull)
        #expect(str(fin["sid"]) == sid)

        // el pedido y la respuesta quedaron como un chat más
        let h = await historial(f.b, agent: "marce", session: sid)
        #expect(msgs(h).map { str($0["r"]) } == ["u", "a"])
        #expect(msgs(h).map { str($0["t"]) } == ["Armá el informe", "hola marce"])
        #expect(str((await historial(f.b, agent: "marce")).obj["session"]) == sid, "es la última sesión del agente")
        // con los permisos y la carpeta del agente
        let l = try #require(f.sb.llamadas.last)
        #expect(Sandbox.valor(l, "--agent") == "marce")
        #expect(Sandbox.valor(l, "--session-id") == sid)
        #expect(Sandbox.reglas(l).contains("Edit(/\(f.carpeta)/conocimiento/agentes/marce.md)"))
        #expect(sinPrivate(try #require(f.sb.cwds.last)) == sinPrivate(f.carpeta))
        // costo con origen «tarea» y la tarea como referencia
        let c = await f.get("/api/costos")
        #expect(abs((dict(c.obj["origenes"])["tarea"] as? Double ?? 0) - 0.01) < 1e-9)
        #expect(abs((dict(c.obj["agentes"])["marce"] as? Double ?? 0) - 0.01) < 1e-9)
        // gancho
        #expect(await esperar { avisos.todas.count == 1 })
        #expect(avisos.todas[0].estado == "ok" && avisos.todas[0].tarea == "informe-diario")
        // en la lista aparece como última
        let t = dict(lista(await f.get("/api/tareas").obj["tareas"]).first)
        #expect(str(dict(t["ultima"])["estado"]) == "ok" && t["corriendo"] as? Bool == false)
    }

    @Test("probar ahora: la actividad muestra origen «tarea» con el nombre; no se puede lanzar ni borrar mientras corre (409)")
    func enVivo() async throws {
        let f = try await fix()
        _ = await nueva(f, ["consigna": "STREAM PAUSA informe"])
        let r = await f.post("/api/tareas/informe-diario/correr")
        #expect(r.status == 202)
        let viendo = await esperarAsync {
            let a = await f.get("/api/actividad")
            return dict(dict(a.obj["agentes"])["marce"])["origen"] as? String == "tarea"
        }
        #expect(viendo)
        let m = dict(dict(await f.get("/api/actividad").obj["agentes"])["marce"])
        #expect(str(m["tarea"]) == "Informe diario")
        #expect((await f.post("/api/tareas/informe-diario/correr")).status == 409)
        #expect((await f.delete("/api/tareas/informe-diario")).status == 409)
        #expect(dict(lista(await f.get("/api/tareas").obj["tareas"]).first)["corriendo"] as? Bool == true)
        f.sb.abrirPuerta()
        let fin = await terminada(f, "informe-diario")
        #expect(str(fin["estado"]) == "ok" && str(fin["resultado"]) == "stream marce")
        #expect(abs((fin["costo"] as? Double ?? 0) - 0.25) < 1e-9)
        #expect(dict(await f.get("/api/actividad").obj["agentes"]).isEmpty)
    }

    @Test("una corrida que falla queda en error con el motivo, y el chat guarda el error")
    func falla() async throws {
        let f = try await fix()
        _ = await nueva(f, ["consigna": "ISERR por favor"])
        let avisos = Gancho()
        await f.b.programador.alTerminar { avisos.agregar($0) }
        #expect((await f.post("/api/tareas/informe-diario/correr")).status == 202)
        let fin = await terminada(f, "informe-diario")
        #expect(str(fin["estado"]) == "error", "\(fin)")
        #expect(!str(fin["error"]).isEmpty)
        let m = msgs(await historial(f.b, agent: "marce", session: str(fin["sid"])))
        #expect(m.count == 2 && m[1]["e"] as? Bool == true)
        #expect(await esperar { avisos.todas.count == 1 })
        #expect(avisos.todas[0].estado == "error")
    }

    @Test("el resultado se recorta a 2000 caracteres")
    func recorta() async throws {
        let f = try await fix()
        _ = await nueva(f)
        _ = await f.get("/api/tareas") // prepara la tabla
        let largo = String(repeating: "ñ", count: 5000)
        let id = try await f.b.store.nuevaEjecucion(oficina: f.carpeta, tarea: "informe-diario", agente: "marce", programada: 1, inicio: 1,
                                                    sid: U.a, manual: true)
        try await f.b.store.terminarEjecucion(id, estado: "ok", resultado: largo, error: nil, costo: nil)
        let e = try #require(await f.b.store.ejecucion(id))
        #expect(e.resultado.count == 2000)
    }

    // MARK: programador

    @Test("programador: corre lo que toca, una sola vez por horario, y se pone al día una vez si pasaron menos de 12 h")
    func programador() async throws {
        let f = try await fix()
        let t = dict((await nueva(f, ["dias": [1, 2, 3, 4, 5, 6, 7]])).obj["tarea"])
        let id = str(t["id"])
        let modelo = TareaProgramada(id: id, agente: "marce", nombre: "x", consigna: "x", dias: [1, 2, 3, 4, 5, 6, 7], hora: "08:00", zona: ba)
        let p1 = try #require(Programacion.proxima(modelo, desde: Date().addingTimeInterval(2 * 86400)))
        let reloj = Reloj(p1.addingTimeInterval(-30))
        await f.b.programador.fijarReloj { reloj.ahora }
        let avisos = Gancho()
        await f.b.programador.alTerminar { avisos.agregar($0) }

        await f.b.programador.revisar()
        #expect(await ejecuciones(f, id).isEmpty, "todavía no es la hora")

        reloj.poner(p1.addingTimeInterval(5))
        await f.b.programador.revisar()
        var e = await ejecuciones(f, id)
        #expect(e.count == 1)
        #expect(e[0]["manual"] as? Bool == false)
        #expect(Programacion.fecha(str(e[0]["programada"])) == p1)
        await terminada(f, id)
        await f.b.programador.revisar()
        reloj.poner(p1.addingTimeInterval(35))
        await f.b.programador.revisar()
        #expect(await ejecuciones(f, id).count == 1, "nunca dos veces la misma programada")
        #expect(f.sb.llamadas.count == 1)
        #expect(await esperar { avisos.todas.count == 1 })

        // al día siguiente a la hora: otra corrida
        let p2 = try #require(Programacion.proxima(modelo, desde: p1))
        reloj.poner(p2.addingTimeInterval(10))
        await f.b.programador.revisar()
        await terminada(f, id, cuantas: 2)
        #expect(await ejecuciones(f, id).count == 2)
        // la app estuvo cerrada dos días: a las 11 h del tercero corre una sola vez (la de ese día)
        let p4 = try #require(Programacion.proxima(modelo, desde: p2.addingTimeInterval(2 * 86400)))
        reloj.poner(p4.addingTimeInterval(11 * 3600))
        await f.b.programador.revisar()
        await terminada(f, id, cuantas: 3)
        e = await ejecuciones(f, id)
        #expect(e.count == 3)
        #expect(Programacion.fecha(str(e[0]["programada"])) == p4)
        await f.b.programador.revisar()
        #expect(await ejecuciones(f, id).count == 3)
        // más de 12 h tarde: se perdió
        let p5 = try #require(Programacion.proxima(modelo, desde: p4))
        reloj.poner(p5.addingTimeInterval(13 * 3600))
        await f.b.programador.revisar()
        #expect(await ejecuciones(f, id).count == 3)
    }

    @Test("programador: no corre tareas en pausa, de agentes que no están, ni de una tarea recién creada con la hora ya pasada")
    func programadorOmite() async throws {
        let f = try await fix()
        _ = await nueva(f, ["dias": [1, 2, 3, 4, 5, 6, 7], "activa": false])
        _ = await nueva(f, ["nombre": "De Nico", "agente": "nico", "dias": [1, 2, 3, 4, 5, 6, 7]])
        _ = await f.delete("/api/agentes/nico")
        let nueva1 = dict((await nueva(f, ["nombre": "Nueva", "dias": [1, 2, 3, 4, 5, 6, 7]])).obj["tarea"])
        // siempre hay un horario de hace menos de 12 h: la tarea recién creada (desde = ahora) no lo corre
        let modelo = TareaProgramada(id: "x", agente: "marce", nombre: "x", consigna: "x", dias: [1, 2, 3, 4, 5, 6, 7], hora: "08:00", zona: ba)
        let p = try #require(Programacion.anterior(modelo, hasta: Date()))
        let reloj = Reloj(p.addingTimeInterval(3600))
        // (el reloj está atrás de «desde» a propósito: ningún horario ≥ desde)
        await f.b.programador.fijarReloj { reloj.ahora }
        await f.b.programador.revisar()
        #expect(f.sb.llamadas.isEmpty)
        #expect(await ejecuciones(f, "informe-diario").isEmpty)
        #expect(await ejecuciones(f, "de-nico").isEmpty)
        #expect(await ejecuciones(f, str(nueva1["id"])).isEmpty)
    }

    @Test("reinicio: lo que quedó «corriendo» pasa a «error» (interrumpida)")
    func reinicio() async throws {
        let sb = Sandbox()
        let f = try await Fix.crear(deps: ["Dirección"], agentes: [("marce", "direccion", nil)], sb: sb, env: ["HQ_PROGRAMADOR": "0"])
        _ = await nueva(f)
        _ = await f.get("/api/tareas") // prepara la tabla
        let id = try await f.b.store.nuevaEjecucion(oficina: f.carpeta, tarea: "informe-diario", agente: "marce", programada: 1, inicio: 2,
                                                    sid: U.a, manual: false)
        #expect(await f.b.store.ejecucion(id)?.estado == "corriendo")
        await f.b.shutdown()
        // otro arranque sobre la misma base y la misma oficina activa
        let b2 = try sb.backend(env: ["HQ_PROGRAMADOR": "0"], oficina: false)
        let r = await llamar(b2, "GET", "/api/tareas/informe-diario/ejecuciones")
        #expect(r.status == 200, "\(r.obj)")
        let e = try #require(lista(r.obj["ejecuciones"]).first)
        #expect(str(e["estado"]) == "error")
        #expect(str(e["error"]).contains("Interrumpida"))
        #expect(!(e["fin"] is NSNull))
        await b2.shutdown()
    }

    @Test("el bucle automático arranca solo y corre lo que toca (intervalo corto)")
    func bucleAutomatico() async throws {
        let f = try await Fix.crear(deps: ["Dirección"], agentes: [("marce", "direccion", nil)], env: ["HQ_PROGRAMADOR_INTERVALO": "0.1"])
        let modelo = TareaProgramada(id: "x", agente: "marce", nombre: "x", consigna: "x", dias: [1, 2, 3, 4, 5, 6, 7], hora: "08:00", zona: ba)
        _ = await nueva(f, ["dias": [1, 2, 3, 4, 5, 6, 7]])
        let p = try #require(Programacion.proxima(modelo, desde: Date().addingTimeInterval(86400)))
        await f.b.programador.fijarReloj { p.addingTimeInterval(1) }
        let corrio = await esperarAsync(hasta: 15) { await ejecuciones(f, "informe-diario").count == 1 }
        #expect(corrio)
        await terminada(f, "informe-diario")
        await f.b.shutdown()
    }
}
}
