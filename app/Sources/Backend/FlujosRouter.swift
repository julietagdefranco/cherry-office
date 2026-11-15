import Foundation

/// Rutas de flujos (docs/plan-creador-flujos.md, tabla de API). Siempre sobre la oficina activa.
///   GET/POST   /api/flujos                                 → {flujos:[… + sinAsignar]} · {flujo}
///   GET/PATCH/DELETE /api/flujos/:id                       → {flujo} · {flujo} · {ok}
///   POST       /api/flujos/:id/correr                      → {corrida}
///   GET        /api/flujos/corridas?estado=&flujo=&entrega=&limite=
///   GET        /api/flujos/corridas/:id                    → {corrida, pasos}
///   POST       /api/flujos/corridas/:id/hecho|reintentar|saltar|cancelar|volver → {corrida}
struct FlujosRouter: SubRouter {
    let servicios: ServiciosHQ
    init(servicios: ServiciosHQ) { self.servicios = servicios }

    static let maxBody = 200_000
    static let maxArchivos = 10
    /// Un archivo de 25 MB en base64 pesa 4/3; el resto es la nota y el armazón.
    static let maxBodyHecho = (MotorFlujos.maxArchivo * 4 / 3 + 1000) * maxArchivos + 100_000
    private static let ocupados: Set<String> = ["corridas"]

    private func buscar(_ o: Oficina, _ id: String) -> FlujoDef? { o.flujos?.first { $0.id == id } }
    private var store: Store { servicios.store }
    private var oficinas: Oficinas { servicios.oficinas }
    private var motor: MotorFlujos { servicios.motor }

    func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)? {
        guard path == "/api/flujos" || path.hasPrefix("/api/flujos/") else { return nil }
        let (code, obj) = await despachar(method: method, path: path, query: query, body: body)
        return (code, Router.codificar(obj))
    }

    private func despachar(method: String, path: String, query: [String: String], body: Data?) async -> (Int, [String: Any]) {
        let no: (Int, [String: Any]) = (405, ["error": "método no permitido"])
        let partes = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        guard partes.count >= 2, partes.count <= 5, !partes.contains("") else { return (404, ["error": "no"]) }
        do {
            let act = try await oficinas.requerirActiva()
            if partes.count == 2 {
                switch method {
                case "GET": return (200, ["flujos": (act.oficina.flujos ?? []).map { vista($0, act.oficina) }])
                case "POST": return try await crear(body)
                default: return no
                }
            }
            if partes[2] == "corridas" {
                switch partes.count {
                case 3: return method == "GET" ? try await listarCorridas(act, query) : no
                case 4:
                    guard method == "GET" else { return no }
                    return try await detalle(act, try idCorrida(partes[3]))
                default:
                    guard method == "POST" else { return no }
                    return try await accion(act, try idCorrida(partes[3]), partes[4], body)
                }
            }
            let id = partes[2]
            if partes.count == 3 {
                switch method {
                case "GET":
                    guard let f = buscar(act.oficina, id) else { throw ErrorAPI(404, "No existe ese flujo.") }
                    return (200, ["flujo": vista(f, act.oficina)])
                case "PATCH": return try await editar(id, body)
                case "DELETE": return try await borrar(id)
                default: return no
                }
            }
            if partes.count == 4, partes[3] == "correr" {
                return method == "POST" ? try await correr(act, id, body) : no
            }
            return (404, ["error": "no"])
        } catch let e as ErrorAPI {
            return (e.status, ["error": e.mensaje])
        } catch {
            return (500, ["error": "error interno"])
        }
    }

    // MARK: lectura

    private func idCorrida(_ s: String) throws -> Int64 {
        guard let n = Int64(s), n > 0 else { throw ErrorAPI(404, "No existe esa corrida.") }
        return n
    }

    private func objeto(_ body: Data?, max: Int = FlujosRouter.maxBody) throws -> [String: Any] {
        guard let body, !body.isEmpty, body.count <= max, let d = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
            throw ErrorAPI(400, "pedido inválido")
        }
        return d
    }

    /// Ids de pasos cuyo agente ya no está en la oficina.
    private func sinAsignar(_ pasos: [PasoFlujo], _ o: Oficina) -> [String] {
        pasos.filter { $0.quien != "persona" && o.agente($0.quien) == nil }.map(\.id)
    }

    private func vista(_ f: FlujoDef, _ o: Oficina) -> [String: Any] {
        var j = f.json
        j["sinAsignar"] = sinAsignar(f.pasos, o)
        return j
    }

    private func listarCorridas(_ act: OficinaActiva, _ q: [String: String]) async throws -> (Int, [String: Any]) {
        func filtro(_ k: String) -> String? { q[k].flatMap { $0.isEmpty ? nil : $0 } }
        let estados: [String]?
        switch filtro("estado") ?? "abiertas" {
        case "abiertas": estados = Corrida.abiertas
        case "terminadas": estados = ["terminada", "cancelada"]
        case "todas": estados = nil
        default: throw ErrorAPI(400, "«estado» tiene que ser abiertas, terminadas o todas.")
        }
        let limite = q["limite"].flatMap { Int($0) } ?? 100
        var lista: [Corrida]
        if let e = filtro("entrega") {
            guard let id = Int64(e) else { throw ErrorAPI(400, "«entrega» tiene que ser un número.") }
            lista = []
            if let cid = await corridaDeEntrega(act, id), let c = await store.corrida(oficina: act.carpeta, id: cid),
               estados?.contains(c.estado) ?? true, filtro("flujo").map({ $0 == c.flujo }) ?? true {
                lista = [c]
            }
        } else {
            lista = await store.corridas(oficina: act.carpeta, estados: estados, flujo: filtro("flujo"), limite: limite)
        }
        var out: [[String: Any]] = []
        for c in lista {
            var j = c.json
            let p = await store.pasoVigente(corrida: c.id)
            j["pasoEstado"] = p?.estado ?? NSNull()
            j["entrega"] = p?.entrega.map { $0 as Any } ?? NSNull()
            out.append(j)
        }
        return (200, ["corridas": out])
    }

    /// La corrida de una entrega: la vigente de un paso, o una versión anterior (se sube por `padre` hasta la original).
    private func corridaDeEntrega(_ act: OficinaActiva, _ id: Int64) async -> Int64? {
        var actual: Int64? = id
        var vueltas = 0
        while let n = actual, vueltas < 20 {
            if let p = await store.pasoPorEntrega(n) { return p.corrida }
            guard let e = await store.entrega(oficina: act.carpeta, id: n) else { return nil }
            if let (c, _, _) = Programador.deFlujo(e.ref) { return c }
            actual = e.padre
            vueltas += 1
        }
        return nil
    }

    private func detalle(_ act: OficinaActiva, _ id: Int64) async throws -> (Int, [String: Any]) {
        guard let c = await store.corrida(oficina: act.carpeta, id: id) else { throw ErrorAPI(404, "No existe esa corrida.") }
        let intentos = await store.pasosDe(corrida: id)
        let defPasos = c.def?.pasos ?? []
        var pasos: [[String: Any]] = []
        for (i, pf) in defPasos.enumerated() {
            var lista: [[String: Any]] = []
            for p in intentos where p.paso == i {
                var j = p.json
                if let eid = p.entrega, let e = await store.entrega(oficina: act.carpeta, id: eid) {
                    j["entrega"] = ["id": e.id, "titulo": e.titulo, "estado": e.estado] as [String: Any]
                } else {
                    j["entrega"] = NSNull()
                }
                // la conversación del intento (está desde que arranca: el pedido se guarda antes de correr) y sus consultas a colegas
                if let xid = p.ejecucion, let ej = await store.ejecucion(xid) {
                    j["sid"] = ej.sid
                    j["agente"] = ej.agente
                    j["ejecucionEstado"] = ej.estado
                    if let c = ej.costo { j["costoEjecucion"] = c }
                    let cons = await store.consultasDe(oficina: act.carpeta, sid: ej.sid)
                    if !cons.isEmpty {
                        func nombre(_ id: String) -> String { act.oficina.agente(id)?.nombre ?? id }
                        j["consultas"] = cons.map { f -> [String: Any] in
                            var d: [String: Any] = ["a": f.a, "aNombre": nombre(f.a), "pregunta": String(f.pregunta.prefix(400)), "ts": f.ts]
                            if let r = f.respuesta { d["respuesta"] = String(r.prefix(600)) }
                            if let e = f.error { d["error"] = e }
                            return d
                        }
                    }
                }
                lista.append(j)
            }
            pasos.append(["indice": i, "def": pf.json, "sinAsignar": pf.quien != "persona" && act.oficina.agente(pf.quien) == nil,
                          "intentos": lista])
        }
        return (200, ["corrida": c.json, "pasos": pasos])
    }

    // MARK: definiciones

    private func crear(_ body: Data?) async throws -> (Int, [String: Any]) {
        let d = try objeto(body)
        let (f, _) = try await oficinas.modificar { o -> FlujoDef in
            var usados = Set((o.flujos ?? []).map(\.id)).union(FlujosRouter.ocupados)
            if let id = d["id"] as? String, FlujosRouter.ocupados.contains(id) { usados.insert(id) }
            var f = try FlujoDef.desde(d, idsUsados: usados)
            f.creado = f.creado ?? Programacion.iso(Date())
            var lista = o.flujos ?? []
            lista.append(f)
            o.flujos = lista
            return f
        }
        return (200, ["flujo": f.json])
    }

    private func editar(_ id: String, _ body: Data?) async throws -> (Int, [String: Any]) {
        let d = try objeto(body)
        let (f, act) = try await oficinas.modificar { o -> FlujoDef in
            guard let i = o.flujos?.firstIndex(where: { $0.id == id }) else { throw ErrorAPI(404, "No existe ese flujo.") }
            var mezcla = o.flujos![i].json
            for k in ["nombre", "descripcion", "pasos", "activo", "origen"] where d[k] != nil { mezcla[k] = d[k] }
            mezcla["id"] = id
            let otros = Set(o.flujos!.map(\.id)).subtracting([id])
            let nuevo = try FlujoDef.desde(mezcla, idsUsados: otros)
            o.flujos![i] = nuevo
            return nuevo
        }
        return (200, ["flujo": vista(f, act.oficina)])
    }

    private func borrar(_ id: String) async throws -> (Int, [String: Any]) {
        _ = try await oficinas.modificar { o in
            guard let i = o.flujos?.firstIndex(where: { $0.id == id }) else { throw ErrorAPI(404, "No existe ese flujo.") }
            o.flujos!.remove(at: i)
            if o.flujos!.isEmpty { o.flujos = nil }
        }
        return (200, ["ok": true])
    }

    // MARK: corridas

    private func correr(_ act: OficinaActiva, _ id: String, _ body: Data?) async throws -> (Int, [String: Any]) {
        guard let f = buscar(act.oficina, id) else { throw ErrorAPI(404, "No existe ese flujo.") }
        guard f.activo else { throw ErrorAPI(409, "Ese flujo está pausado.") }
        let d = try objeto(body, max: Adjuntos.maxBody)
        if (body?.count ?? 0) > FlujosRouter.maxBody, d["archivos"] == nil { throw ErrorAPI(400, "pedido inválido") }
        let nombre = try Validar.texto(d["nombre"], "nombre", max: MotorFlujos.maxNombre)!
        let contexto = try Validar.texto(d["contexto"], "contexto", max: MotorFlujos.maxContexto, obligatorio: false) ?? ""
        let archivos = try Adjuntos.leer(d["archivos"])
        let adjuntos = try Adjuntos.guardar(act, origen: "flujos/\(f.id)", archivos)
        let c = try await motor.iniciar(act, flujo: f, nombre: nombre, contexto: contexto, adjuntos: adjuntos)
        return (200, ["corrida": c.json])
    }

    private func accion(_ act: OficinaActiva, _ id: Int64, _ nombre: String, _ body: Data?) async throws -> (Int, [String: Any]) {
        switch nombre {
        case "hecho":
            let d = try body.map { $0.isEmpty ? [:] : try objeto($0, max: FlujosRouter.maxBodyHecho) } ?? [:]
            let nota = try Validar.texto(d["nota"], "nota", max: MotorFlujos.maxNota, obligatorio: false)
            var archivos: [(nombre: String, datos: Data)] = []
            if let crudos = d["archivos"], !(crudos is NSNull) {
                guard let lista = crudos as? [[String: Any]] else { throw ErrorAPI(400, "«archivos» tiene que ser una lista.") }
                guard lista.count <= FlujosRouter.maxArchivos else { throw ErrorAPI(400, "Máximo \(FlujosRouter.maxArchivos) archivos por vez.") }
                for a in lista {
                    let n = try Validar.texto(a["nombre"], "nombre del archivo", max: MotorFlujos.maxNombreArchivo)!
                    guard var b64 = a["base64"] as? String, !b64.isEmpty else { throw ErrorAPI(400, "Falta el contenido de «\(n)» (base64).") }
                    if b64.hasPrefix("data:"), let i = b64.firstIndex(of: ",") { b64 = String(b64[b64.index(after: i)...]) }
                    if b64.utf8.count > MotorFlujos.maxArchivo * 4 / 3 + 8 {
                        throw ErrorAPI(413, "«\(n)» es demasiado grande (el máximo es \(MotorFlujos.maxArchivo / 1_048_576) MB).")
                    }
                    guard let datos = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else {
                        throw ErrorAPI(400, "El contenido de «\(n)» no es base64 válido.")
                    }
                    archivos.append((n, datos))
                }
            }
            return (200, ["corrida": try await motor.hecho(act, corrida: id, nota: nota, archivos: archivos).json])
        case "reintentar": return (200, ["corrida": try await motor.reintentar(act, corrida: id).json])
        case "saltar": return (200, ["corrida": try await motor.saltar(act, corrida: id).json])
        case "cancelar": return (200, ["corrida": try await motor.cancelar(act, corrida: id).json])
        case "volver":
            let d = try objeto(body)
            guard let paso = try LecturaAPI.entero(d["paso"], "paso") else { throw ErrorAPI(400, "Falta «paso».") }
            let nota = try Validar.texto(d["nota"], "nota", max: MotorFlujos.maxNota, obligatorio: false)
            return (200, ["corrida": try await motor.volver(act, corrida: id, paso: paso, nota: nota).json])
        default:
            return (404, ["error": "no"])
        }
    }
}
