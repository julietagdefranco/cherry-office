import Foundation

/// Rutas de reglas, conectores y acciones (plan §API):
///   GET  /api/reglas · PUT /api/reglas                        → {reglas}
///   GET  /api/conectores · POST /api/conectores/actualizar    → {detectado, detectando, servidores}
///   GET  /api/acciones?entrega= | ?estado=                    → {accion} | {acciones}
///   POST /api/entregas/:id/ejecutar | /descartar-accion       → {ejecucion} | {accion}
struct GobiernoRouter: SubRouter {
    let servicios: ServiciosHQ
    let catalogo: CatalogoConectores
    static let maxBody = 200_000

    init(servicios: ServiciosHQ, catalogo: CatalogoConectores = .compartido) {
        self.servicios = servicios; self.catalogo = catalogo
    }

    func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)? {
        let partes = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        guard partes.count >= 2, partes[0] == "api", !partes.contains("") else { return nil }
        let (code, obj): (Int, [String: Any])
        switch (partes[1], partes.count) {
        case ("reglas", 2): (code, obj) = await reglas(method, body)
        case ("conectores", 2): (code, obj) = await conectores(method)
        case ("conectores", 3) where partes[2] == "actualizar": (code, obj) = await actualizar(method)
        case ("acciones", 2): (code, obj) = await acciones(method, query)
        case ("entregas", 4) where partes[3] == "ejecutar" || partes[3] == "descartar-accion":
            guard let id = Int64(partes[2]), id > 0 else { return (404, Router.codificar(["error": "no"])) }
            (code, obj) = await entregaAccion(method, id, partes[3])
        default: return nil
        }
        return (code, Router.codificar(obj))
    }

    private func envolver(_ f: () async throws -> (Int, [String: Any])) async -> (Int, [String: Any]) {
        do { return try await f() }
        catch let e as ErrorAPI { return (e.status, ["error": e.mensaje]) }
        catch { return (500, ["error": "error interno"]) }
    }

    private func objeto(_ body: Data?) throws -> [String: Any] {
        guard let body, !body.isEmpty else { throw ErrorAPI(400, "pedido inválido") }
        if body.count > Self.maxBody { throw ErrorAPI(413, "pedido demasiado grande") }
        guard let d = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { throw ErrorAPI(400, "pedido inválido") }
        return d
    }

    // MARK: reglas

    private func reglas(_ method: String, _ body: Data?) async -> (Int, [String: Any]) {
        await envolver {
            switch method {
            case "GET":
                let a = try await servicios.oficinas.requerirActiva()
                return (200, ["reglas": (a.oficina.reglas ?? []).map(\.json)])
            case "PUT":
                let d = try objeto(body)
                guard let crudas = d["reglas"] as? [Any] else { throw ErrorAPI(400, "«reglas» tiene que ser una lista.") }
                guard crudas.count <= ValidarReglas.maxReglas else { throw ErrorAPI(400, "Máximo \(ValidarReglas.maxReglas) reglas.") }
                let nuevas = try Self.armar(crudas)
                let (_, a) = try await servicios.oficinas.modificar { o in o.reglas = nuevas.isEmpty ? nil : nuevas }
                return (200, ["reglas": (a.oficina.reglas ?? []).map(\.json)])
            default:
                return (405, ["error": "método no permitido"])
            }
        }
    }

    /// Reglas desde el JSON: primero las que traen id (para que un id automático no choque con uno pedido más abajo), después las demás.
    static func armar(_ crudas: [Any]) throws -> [Regla] {
        var dicts: [[String: Any]] = []
        for x in crudas {
            guard let d = x as? [String: Any] else { throw ErrorAPI(400, "Cada regla tiene que ser un objeto con «texto».") }
            dicts.append(d)
        }
        var resultado = [Regla?](repeating: nil, count: dicts.count)
        var usados = Set<String>()
        for (i, d) in dicts.enumerated() where (d["id"] as? String).map({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }) ?? false {
            let r = try Regla.desde(d, idsUsados: usados)
            usados.insert(r.id); resultado[i] = r
        }
        for (i, d) in dicts.enumerated() where resultado[i] == nil {
            let r = try Regla.desde(d, idsUsados: usados)
            usados.insert(r.id); resultado[i] = r
        }
        return resultado.compactMap { $0 }
    }

    // MARK: conectores

    private func vistaConectores(error: String? = nil) -> [String: Any] {
        let lista = catalogo.servidores() ?? []
        var o: [String: Any] = [
            "detectado": catalogo.detectado().map { Programacion.iso($0) as Any } ?? NSNull(),
            "detectando": catalogo.detectando,
            "servidores": lista.map { s -> [String: Any] in
                ["nombre": s.nombre, "prefijo": s.prefijo, "estado": s.estado, "disponible": s.disponible,
                 "herramientas": s.herramientas.map { h -> [String: Any] in
                    let c = Conectores.corto(h)
                    return ["nombre": h, "corto": c, "tipo": Conectores.clasificar(c)]
                 }]
            }]
        if let error { o["error"] = error }
        return o
    }

    private func conectores(_ method: String) async -> (Int, [String: Any]) {
        guard method == "GET" else { return (405, ["error": "método no permitido"]) }
        // la primera vez que alguien mira, se detecta una vez en segundo plano (nunca al arrancar el backend)
        if catalogo.pedirDeteccionInicial() {
            let s = servicios, c = catalogo
            Task.detached {
                _ = try? await Conectores.detectar(s, catalogo: c)
                c.terminarDeteccion()
            }
        }
        return (200, vistaConectores())
    }

    private func actualizar(_ method: String) async -> (Int, [String: Any]) {
        guard method == "POST" else { return (405, ["error": "método no permitido"]) }
        guard catalogo.empezarDeteccion() else { return (200, vistaConectores()) }
        var fallo: String?
        do { try await Conectores.detectar(servicios, catalogo: catalogo) }
        catch let e as ClaudeError { fallo = e.mensaje }
        catch { fallo = "No pude detectar los conectores." }
        catalogo.terminarDeteccion()
        return (200, vistaConectores(error: fallo))
    }

    // MARK: acciones

    private func acciones(_ method: String, _ q: [String: String]) async -> (Int, [String: Any]) {
        guard method == "GET" else { return (405, ["error": "método no permitido"]) }
        return await envolver {
            let a = try await servicios.oficinas.requerirActiva()
            if let e = q["entrega"], !e.isEmpty {
                guard let id = Int64(e), id > 0 else { throw ErrorAPI(400, "«entrega» tiene que ser un número.") }
                let ac = await servicios.store.accionPorEntrega(oficina: a.carpeta, entrega: id)
                return (200, ["accion": ac.map { $0.json as Any } ?? NSNull()])
            }
            var estados: [String]?
            if let e = q["estado"], !e.isEmpty, e != "todas" {
                let l = e.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                guard !l.isEmpty, l.allSatisfy({ AccionPropuesta.estados.contains($0) }) else {
                    throw ErrorAPI(400, "«estado» tiene que ser \(AccionPropuesta.estados.joined(separator: ", ")).")
                }
                estados = l
            }
            return (200, ["acciones": await servicios.store.acciones(oficina: a.carpeta, estados: estados).map(\.json)])
        }
    }

    // MARK: ejecutar y descartar

    private func entregaAccion(_ method: String, _ id: Int64, _ que: String) async -> (Int, [String: Any]) {
        guard method == "POST" else { return (405, ["error": "método no permitido"]) }
        return await envolver {
            let a = try await servicios.oficinas.requerirActiva()
            guard let e = await servicios.store.entrega(oficina: a.carpeta, id: id) else { throw ErrorAPI(404, "No existe esa entrega.") }
            if que == "ejecutar" {
                let ej = try await Acciones.ejecutar(servicios, act: a, entrega: e)
                return (202, ["ejecucion": ej.json])
            }
            guard let ac = await servicios.store.accionPorEntrega(oficina: a.carpeta, entrega: id) else {
                throw ErrorAPI(404, "Esa entrega no tiene una acción.")
            }
            guard ac.estado == "pendiente" else { throw ErrorAPI(409, "Esa acción ya no está pendiente.") }
            await servicios.store.accionActualizar(id: ac.id, estado: "descartada")
            await servicios.store.entregaMarcar(oficina: a.carpeta, id: id, estado: "revisada")
            guard let n = await servicios.store.accion(oficina: a.carpeta, id: ac.id) else { throw ErrorAPI(500, "No pude guardar.") }
            return (200, ["accion": n.json])
        }
    }
}
