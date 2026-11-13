import Foundation

/// `/api/tareas*`: tareas programadas de la oficina activa (se guardan en `oficina.json`; las corridas, en SQLite).
/// Mismas rutas, validaciones y textos que tools/hq_tareas.py.
public struct TareasRouter: SubRouter {
    static let maxBody = 200_000

    private let oficinas: Oficinas
    private let store: Store
    private let programador: Programador
    private let sistema: TimeZone
    private let reloj: @Sendable () -> Date

    public init(oficinas: Oficinas, store: Store, programador: Programador, sistema: TimeZone = .current,
                reloj: @escaping @Sendable () -> Date = { Date() }) {
        self.oficinas = oficinas; self.store = store; self.programador = programador; self.sistema = sistema; self.reloj = reloj
    }

    static func esRuta(_ p: String) -> Bool { p == "/api/tareas" || p.hasPrefix("/api/tareas/") }

    public func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)? {
        guard TareasRouter.esRuta(path) else { return nil }
        let (code, obj) = await despachar(method: method, path: path, body: body)
        return (code, Router.codificar(obj))
    }

    private func despachar(method: String, path: String, body: Data?) async -> (Int, [String: Any]) {
        let no: (Int, [String: Any]) = (405, ["error": "método no permitido"])
        let partes = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        guard partes.count >= 2, partes.count <= 4, !partes.contains("") else { return (404, ["error": "no"]) }
        do {
            await programador.preparar()
            switch partes.count {
            case 2:
                switch method {
                case "GET": return try await listar()
                case "POST": return try await crear(body)
                default: return no
                }
            case 3:
                let id = partes[2]
                guard Slug.valido(id) else { return (404, ["error": "no"]) }
                switch method {
                case "GET": return try await ver(id)
                case "PATCH": return try await editar(id, body)
                case "DELETE": return try await borrar(id)
                default: return no
                }
            default:
                let id = partes[2]
                guard Slug.valido(id) else { return (404, ["error": "no"]) }
                switch partes[3] {
                case "correr": return method == "POST" ? try await correr(id) : no
                case "ejecuciones": return method == "GET" ? try await ejecuciones(id) : no
                default: return (404, ["error": "no"])
                }
            }
        } catch let e as ErrorAPI {
            return (e.status, ["error": e.mensaje])
        } catch {
            return (500, ["error": "error interno"])
        }
    }

    // MARK: vistas

    private func vista(_ t: TareaProgramada, _ a: OficinaActiva, ahora: Date) async -> [String: Any] {
        var o = t.json(sistema: sistema)
        let ult = await store.ultimaEjecucion(oficina: a.carpeta, tarea: t.id)
        let sigue = t.activa && a.oficina.agente(t.agente) != nil
        o["proxima"] = (sigue ? Programacion.proxima(t, desde: ahora, sistema: sistema) : nil).map { Programacion.iso($0) as Any } ?? NSNull()
        o["ultima"] = ult.map { $0.json as Any } ?? NSNull()
        o["corriendo"] = await programador.estaCorriendo(oficina: a.carpeta, tarea: t.id)
        return o
    }

    private func buscar(_ id: String, _ a: OficinaActiva) throws -> TareaProgramada {
        guard let t = a.oficina.tareas?.first(where: { $0.id == id }) else { throw ErrorAPI(404, "No existe esa tarea.") }
        return t
    }

    private func listar() async throws -> (Int, [String: Any]) {
        let a = try await oficinas.requerirActiva()
        let ahora = reloj()
        var out: [[String: Any]] = []
        for t in a.oficina.tareas ?? [] { out.append(await vista(t, a, ahora: ahora)) }
        return (200, ["tareas": out])
    }

    private func ver(_ id: String) async throws -> (Int, [String: Any]) {
        let a = try await oficinas.requerirActiva()
        return (200, ["tarea": await vista(try buscar(id, a), a, ahora: reloj())])
    }

    // MARK: cuerpo

    private func objeto(_ body: Data?) throws -> [String: Any] {
        guard let body, !body.isEmpty else { throw ErrorAPI(400, "pedido inválido") }
        if body.count > TareasRouter.maxBody { throw ErrorAPI(413, "pedido demasiado grande") }
        guard let d = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { throw ErrorAPI(400, "pedido inválido") }
        return d
    }

    private static func dias(_ v: Any?) throws -> [Int] {
        guard let a = v as? [Any], !a.isEmpty else { throw ErrorAPI(400, "Elegí al menos un día (números del 1, lunes, al 7, domingo).") }
        var out: [Int] = []
        for x in a {
            // (JSONSerialization hace NSNumber de los booleanos: `x is Bool` también da true para 1 y 0)
            guard let n = x as? Int, CFGetTypeID(x as CFTypeRef) != CFBooleanGetTypeID(), (1...7).contains(n), !out.contains(n) else {
                throw ErrorAPI(400, "Los días tienen que ser números del 1 (lunes) al 7 (domingo), sin repetir.")
            }
            out.append(n)
        }
        return out.sorted()
    }

    private static func hora(_ v: Any?) throws -> String {
        let h = try Validar.texto(v, "hora", max: 5)!
        guard ValidarTareas.hora(h) != nil else { throw ErrorAPI(400, "La hora tiene que ser HH:MM (por ejemplo 08:00).") }
        return h
    }

    private static func zona(_ v: Any?) throws -> String? {
        guard let z = try Validar.texto(v, "zona", max: 64, obligatorio: false) else { return nil }
        guard ValidarTareas.zonaValida(z) else { throw ErrorAPI(400, "No conozco esa zona horaria (usá, por ejemplo, America/Argentina/Buenos_Aires).") }
        return z
    }

    private static func activa(_ v: Any?) throws -> Bool? {
        guard let v, !(v is NSNull) else { return nil }
        guard CFGetTypeID(v as CFTypeRef) == CFBooleanGetTypeID(), let b = v as? Bool else { throw ErrorAPI(400, "«activa» tiene que ser verdadero o falso.") }
        return b
    }

    // MARK: altas, cambios y bajas

    private func crear(_ body: Data?) async throws -> (Int, [String: Any]) {
        let d = try objeto(body)
        let agente = try Validar.texto(d["agente"], "agente", max: 41)!
        let nombre = try Validar.texto(d["nombre"], "nombre", max: ValidarTareas.maxNombre)!
        let consigna = try Validar.texto(d["consigna"], "consigna", max: ValidarTareas.maxConsigna)!
        let dias = try TareasRouter.dias(d["dias"]), hora = try TareasRouter.hora(d["hora"])
        let zona = try TareasRouter.zona(d["zona"]) ?? sistema.identifier
        let activa = try TareasRouter.activa(d["activa"]) ?? true
        let pedidoId = try Validar.texto(d["id"], "id", max: 41, obligatorio: false)
        if let pedidoId, !Slug.valido(pedidoId) { throw ErrorAPI(400, "Id de tarea inválido (usá minúsculas, números y guiones).") }
        let ahora = Programacion.iso(reloj())
        let (t, a) = try await oficinas.modificar { o -> TareaProgramada in
            guard o.agente(agente) != nil else { throw ErrorAPI(404, "No existe ese agente.") }
            var ts = o.tareas ?? []
            guard ts.count < ValidarTareas.maxTareas else { throw ErrorAPI(400, "Máximo \(ValidarTareas.maxTareas) tareas programadas.") }
            let usados = Set(ts.map(\.id))
            if let p = pedidoId, usados.contains(p) { throw ErrorAPI(409, "Ya hay una tarea con ese id.") }
            let id = pedidoId ?? Slug.unico(nombre, usados: usados, respaldo: "tarea")
            let t = TareaProgramada(id: id, agente: agente, nombre: nombre, consigna: consigna, dias: dias, hora: hora, zona: zona,
                                    activa: activa, creada: ahora, desde: ahora)
            ts.append(t)
            o.tareas = ts
            return t
        }
        return (200, ["tarea": await vista(t, a, ahora: reloj())])
    }

    private func editar(_ id: String, _ body: Data?) async throws -> (Int, [String: Any]) {
        let d = try objeto(body)
        let nombre = try Validar.texto(d["nombre"], "nombre", max: ValidarTareas.maxNombre, obligatorio: false)
        let consigna = try Validar.texto(d["consigna"], "consigna", max: ValidarTareas.maxConsigna, obligatorio: false)
        let dias = d["dias"] == nil ? nil : try TareasRouter.dias(d["dias"])
        let hora = d["hora"] == nil ? nil : try TareasRouter.hora(d["hora"])
        let zona = try TareasRouter.zona(d["zona"])
        let activa = try TareasRouter.activa(d["activa"])
        let ahora = Programacion.iso(reloj())
        let (t, a) = try await oficinas.modificar { o -> TareaProgramada in
            guard let i = o.tareas?.firstIndex(where: { $0.id == id }) else { throw ErrorAPI(404, "No existe esa tarea.") }
            var t = o.tareas![i]
            var cambioHorario = false
            if let nombre { t.nombre = nombre }
            if let consigna { t.consigna = consigna }
            if let dias, dias != t.dias { t.dias = dias; cambioHorario = true }
            if let hora, hora != t.hora { t.hora = hora; cambioHorario = true }
            if let zona, zona != t.zona { t.zona = zona; cambioHorario = true }
            if let activa {
                if activa, !t.activa {
                    guard o.agente(t.agente) != nil else { throw ErrorAPI(409, "El agente de esta tarea ya no está en la oficina.") }
                    cambioHorario = true
                }
                t.activa = activa
            }
            // una tarea movida o reactivada no se pone al día con el horario que ya pasó hoy
            if cambioHorario { t.desde = ahora }
            o.tareas![i] = t
            return t
        }
        return (200, ["tarea": await vista(t, a, ahora: reloj())])
    }

    private func borrar(_ id: String) async throws -> (Int, [String: Any]) {
        let a = try await oficinas.requerirActiva()
        _ = try buscar(id, a)
        guard !(await programador.estaCorriendo(oficina: a.carpeta, tarea: id)) else {
            throw ErrorAPI(409, "La tarea está corriendo ahora. Esperá a que termine para borrarla.")
        }
        _ = try await oficinas.modificar { o in
            guard o.tareas?.contains(where: { $0.id == id }) == true else { throw ErrorAPI(404, "No existe esa tarea.") }
            o.tareas!.removeAll { $0.id == id }
            if o.tareas!.isEmpty { o.tareas = nil }
        }
        try? await store.borrarEjecuciones(oficina: a.carpeta, tarea: id)
        return (200, ["ok": true])
    }

    // MARK: corridas

    private func correr(_ id: String) async throws -> (Int, [String: Any]) {
        let a = try await oficinas.requerirActiva()
        let t = try buscar(id, a)
        guard let def = a.oficina.agente(t.agente) else { throw ErrorAPI(409, "El agente de esta tarea ya no está en la oficina.") }
        let ej = try await programador.correrAhora(a, t, def)
        return (202, ["ejecucion": ej.json])
    }

    private func ejecuciones(_ id: String) async throws -> (Int, [String: Any]) {
        let a = try await oficinas.requerirActiva()
        _ = try buscar(id, a)
        return (200, ["ejecuciones": await store.ejecuciones(oficina: a.carpeta, tarea: id, limite: 20).map(\.json)])
    }
}
