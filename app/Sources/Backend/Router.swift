import Foundation

/// Contrato A <-> B: la app (WKURLSchemeHandler) delega aquí todo `/api/*`.
public protocol APIHandler: Sendable {
    func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)
}

/// Enrutador de una sección de la API que vive en otro archivo (p. ej. `/api/reuniones*`).
/// Devuelve nil si no atiende ese pedido (el Router responde 404).
public protocol SubRouter: Sendable {
    func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)?
}

final class SubRouterBox: @unchecked Sendable {
    private let lock = NSLock()
    private var valor: SubRouter?
    private var valorBiblioteca: SubRouter?
    private var valorExplorador: SubRouter?
    private var valorTareas: SubRouter?
    private var valorEntregas: SubRouter?
    private var valorPaquete: SubRouter?
    private var valorExtras: [SubRouter] = []
    /// Routers extra: se prueban ANTES que cualquier otro prefijo (flujos, creador, gobierno, parte).
    var extras: [SubRouter] { lock.lock(); defer { lock.unlock() }; return valorExtras }
    func registrarExtra(_ r: SubRouter) { lock.lock(); valorExtras.append(r); lock.unlock() }
    var reuniones: SubRouter? {
        get { lock.lock(); defer { lock.unlock() }; return valor }
        set { lock.lock(); valor = newValue; lock.unlock() }
    }
    var explorador: SubRouter? {
        get { lock.lock(); defer { lock.unlock() }; return valorExplorador }
        set { lock.lock(); valorExplorador = newValue; lock.unlock() }
    }
    var biblioteca: SubRouter? {
        get { lock.lock(); defer { lock.unlock() }; return valorBiblioteca }
        set { lock.lock(); valorBiblioteca = newValue; lock.unlock() }
    }
    var tareas: SubRouter? {
        get { lock.lock(); defer { lock.unlock() }; return valorTareas }
        set { lock.lock(); valorTareas = newValue; lock.unlock() }
    }
    var entregas: SubRouter? {
        get { lock.lock(); defer { lock.unlock() }; return valorEntregas }
        set { lock.lock(); valorEntregas = newValue; lock.unlock() }
    }
    /// `/api/oficina/exportar` y `/api/oficinas/importar` (Paquete.swift).
    var paquete: SubRouter? {
        get { lock.lock(); defer { lock.unlock() }; return valorPaquete }
        set { lock.lock(); valorPaquete = newValue; lock.unlock() }
    }
}

/// `/api/*`: estado, oficinas, departamentos, agentes, chat e historial. Mismas validaciones y textos que `oficina/server.py`.
public final class Router: APIHandler {
    static let maxBody = 200_000
    static let maxMensaje = 100_000
    typealias Resp = (Int, [String: Any])

    private let config: Config
    private let store: Store
    private let runner: ClaudeRunner
    private let log: HQLog
    private let oficinas: Oficinas
    private let listo: @Sendable () async -> Void
    private let auth: AuthCache
    /// Servidor MCP propio (consultas entre agentes, Fase 4). nil = los chats corren sin consultas.
    private let mcp: MCPServidor?
    let subrouters = SubRouterBox()

    private let servicios: ServiciosHQ?

    init(config: Config, store: Store, runner: ClaudeRunner, log: HQLog, oficinas: Oficinas, mcp: MCPServidor? = nil,
         servicios: ServiciosHQ? = nil, listo: @escaping @Sendable () async -> Void) {
        self.servicios = servicios
        self.config = config; self.store = store; self.runner = runner; self.log = log; self.oficinas = oficinas
        self.mcp = mcp
        self.listo = listo
        auth = AuthCache(runner: runner)
    }

    public static func uuidValido(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard u.count == 36 else { return false }
        for (i, c) in u.enumerated() {
            if [8, 13, 18, 23].contains(i) { if c != UInt8(ascii: "-") { return false } }
            else if !((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) { return false }
        }
        return true
    }

    public func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data) {
        await listo()
        var p = path
        if let i = p.firstIndex(where: { $0 == "?" || $0 == "#" }) { p = String(p[..<i]) }
        for extra in subrouters.extras {
            if let res = await extra.handle(method: method.uppercased(), path: p, query: query, body: body) { return res }
        }
        if p == "/api/reuniones" || p.hasPrefix("/api/reuniones/") {
            if let r = subrouters.reuniones, let res = await r.handle(method: method.uppercased(), path: p, query: query, body: body) {
                return res
            }
            return (404, Router.codificar(["error": "no"]))
        }
        if p == "/api/archivos" || p.hasPrefix("/api/archivos/") || p == "/api/vinculos" || p.hasPrefix("/api/vinculos/")
            || p == "/api/biblioteca" || p.hasPrefix("/api/biblioteca/") {
            if let r = subrouters.biblioteca, let res = await r.handle(method: method.uppercased(), path: p, query: query, body: body) {
                return res
            }
            return (404, Router.codificar(["error": "no"]))
        }
        if TareasRouter.esRuta(p) { // /api/tareas*
            if let r = subrouters.tareas, let res = await r.handle(method: method.uppercased(), path: p, query: query, body: body) { return res }
            return (404, Router.codificar(["error": "no"]))
        }
        if EntregasRouter.esRuta(p) { // /api/entregas*
            if let r = subrouters.entregas, let res = await r.handle(method: method.uppercased(), path: p, query: query, body: body) { return res }
            return (404, Router.codificar(["error": "no"]))
        }
        if PaqueteRouter.esRuta(p) { // /api/oficina/exportar, /api/oficinas/importar
            if let r = subrouters.paquete, let res = await r.handle(method: method.uppercased(), path: p, query: query, body: body) { return res }
            return (404, Router.codificar(["error": "no"]))
        }
        if ExploradorRouter.esRuta(p) { // /api/fs/carpetas, /api/oficina/archivos, /api/oficina/archivo
            if let r = subrouters.explorador, let res = await r.handle(method: method.uppercased(), path: p, query: query, body: body) { return res }
            return (404, Router.codificar(["error": "no"]))
        }
        let (code, obj) = await despachar(method: method.uppercased(), path: p, query: query, body: body)
        return (code, Router.codificar(obj))
    }

    static func codificar(_ obj: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes])) ?? Data("{\"error\":\"error interno\"}".utf8)
    }

    private func despachar(method: String, path p: String, query: [String: String], body: Data?) async -> Resp {
        let no: Resp = (405, ["error": "método no permitido"])
        let partes = p.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        guard p.hasPrefix("/"), partes.count >= 2, partes[0] == "api", !partes.contains("") else { return (404, ["error": "no"]) }
        do {
            switch (partes[1], partes.count) {
            case ("estado", 2):
                return method == "GET" ? (200, await estado()) : no
            case ("historial", 2):
                return method == "GET" ? try await historial(query) : no
            case ("chat", 2):
                return method == "POST" ? try await chat(body) : no
            case ("consultas", 2):
                return method == "GET" ? try await consultas(query) : no
            case ("actividad", 2):
                guard method == "GET" else { return no }
                guard let act = await oficinas.activa() else {
                    return (200, ["agentes": [String: Any](), "version": 0, "avisos": [Any](), "entregasSinRevisar": 0,
                                  "corridas": [Any](), "creadorVersion": 0])
                }
                var r = runner.actividad.json(oficina: act.carpeta)
                r["avisos"] = await store.avisosPendientes(oficina: act.carpeta).map(\.json)
                r["entregasSinRevisar"] = await store.entregasSinRevisar(oficina: act.carpeta)
                r["corridas"] = await servicios?.motor.resumenActividad(oficina: act.carpeta) ?? [[String: Any]]()
                r["creadorVersion"] = VersionCreador.compartida.valor(act.carpeta)
                return (200, r)
            case ("avisos", 2):
                guard method == "GET" else { return no }
                let act = try await oficinas.requerirActiva()
                return (200, ["avisos": await store.avisosPendientes(oficina: act.carpeta).map(\.json)])
            case ("avisos", 3) where partes[2] == "visto":
                guard method == "POST" else { return no }
                let act = try await oficinas.requerirActiva()
                let d = try objeto(body)
                let n = await store.avisosVistos(oficina: act.carpeta, id: d["id"] as? String,
                                                 agente: (d["todos"] as? Bool) == true ? nil : d["agente"] as? String)
                return (200, ["vistos": n])
            case ("costos", 2):
                guard method == "GET" else { return no }
                let act = try await oficinas.requerirActiva()
                let desde = query["desde"].flatMap { Double($0) } ?? 0
                return (200, await store.costos(oficina: act.carpeta, desde: desde))
            case ("perfil", 2):
                switch method {
                case "GET": return (200, ["perfil": await oficinas.perfilActual().json])
                case "PUT":
                    let d = try objeto(body)
                    let nombre = try Validar.texto(d["nombre"], "nombre", max: 80, obligatorio: false) ?? ""
                    let (p, a) = try await oficinas.guardarPerfil(Perfil(nombre: nombre, avatar: try NuevoAgente.avatarValido(d["avatar"])))
                    return (200, ["perfil": p.json, "oficina": a.oficina.json])
                default: return no
                }
            case ("oficinas", 2):
                switch method {
                case "GET": return (200, ["oficinas": await oficinas.listar(), "activa": await oficinas.activa().map { $0.carpeta as Any } ?? NSNull()])
                case "POST": return try await crearOficina(body)
                default: return no
                }
            case ("oficinas", 3) where partes[2] == "abrir":
                return method == "POST" ? try await abrirOficina(body) : no
            case ("oficinas", 3) where partes[2] == "importar-prospera":
                return method == "POST" ? try await importarProspera(body) : no
            case ("oficina", 2):
                switch method {
                case "GET": return (200, Router.sobreOficina(try await oficinas.requerirActiva()))
                case "PATCH":
                    let d = try objeto(body)
                    let a = try await oficinas.editar(nombre: try Validar.texto(d["nombre"], "nombre", max: 80, obligatorio: false),
                                                      duenio: try Validar.texto(d["duenio"], "duenio", max: 80, obligatorio: false))
                    return (200, Router.sobreOficina(a))
                default: return no
                }
            case ("departamentos", 2):
                guard method == "POST" else { return no }
                return try await crearDepartamento(body)
            case ("departamentos", 3):
                let id = partes[2]
                guard Slug.valido(id) else { return (404, ["error": "no"]) }
                switch method {
                case "PATCH":
                    let d = try objeto(body)
                    let (dep, a) = try await oficinas.editarDepartamento(
                        id, nombre: try Validar.texto(d["nombre"], "nombre", max: 60, obligatorio: false),
                        color: try Validar.texto(d["color"], "color", max: 7, obligatorio: false),
                        mision: try Router.misionPatch(d))
                    return (200, ["departamento": dep.json, "oficina": a.oficina.json])
                case "DELETE":
                    let d = try objetoOpcional(body)
                    let mover = (d["moverA"] as? String) ?? query["moverA"]
                    let a = try await oficinas.borrarDepartamento(id, moverA: mover)
                    return (200, ["ok": true, "oficina": a.oficina.json])
                default: return no
                }
            case ("agentes", 2):
                switch method {
                case "GET":
                    let a = try await oficinas.requerirActiva()
                    return (200, ["agentes": a.oficina.agentes.map(\.json)])
                case "POST": return try await contratar(body)
                default: return no
                }
            case ("agentes", 3) where partes[2] == "borrador":
                return method == "POST" ? try await borrador(body) : no
            case ("agentes", 3):
                let id = partes[2]
                guard Slug.valido(id) else { return (404, ["error": "no"]) }
                switch method {
                case "GET": return (200, try await oficinas.detalleAgente(id))
                case "PATCH":
                    let (def, a) = try await oficinas.editarAgente(id, try .desde(try objeto(body)))
                    return (200, ["agente": def.json, "oficina": a.oficina.json])
                case "DELETE":
                    let (rel, a) = try await oficinas.despedir(id)
                    return (200, ["ok": true, "archivado": rel.map { $0 as Any } ?? NSNull(), "oficina": a.oficina.json])
                default: return no
                }
            case ("agentes", 4) where partes[3] == "conocimiento":
                let id = partes[2]
                guard Slug.valido(id) else { return (404, ["error": "no"]) }
                return method == "GET" ? (200, try await oficinas.conocimiento(id)) : no
            default:
                return (404, ["error": "no"])
            }
        } catch let e as ErrorAPI {
            return (e.status, ["error": e.mensaje])
        } catch {
            return (500, ["error": "error interno"])
        }
    }

    // MARK: utilidades

    static func sobreOficina(_ a: OficinaActiva) -> [String: Any] { ["carpeta": a.carpeta, "oficina": a.oficina.json] }

    /// Cuerpo JSON objeto (obligatorio).
    private func objeto(_ body: Data?) throws -> [String: Any] {
        guard let body, !body.isEmpty else { throw ErrorAPI(400, "pedido inválido") }
        if body.count > Router.maxBody { throw ErrorAPI(413, "pedido demasiado grande") }
        guard let d = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { throw ErrorAPI(400, "pedido inválido") }
        return d
    }

    /// Cuerpo opcional: vacío = [:], pero si viene tiene que ser un objeto JSON.
    private func objetoOpcional(_ body: Data?) throws -> [String: Any] {
        guard let body, !body.isEmpty else { return [:] }
        return try objeto(body)
    }

    // MARK: estado

    private func estado() async -> [String: Any] {
        let bin = runner.claudePath
        var a: Any = NSNull()
        if bin != nil, let v = await auth.valor() { a = v }
        let act = await oficinas.activa()
        return ["app": "prospera-hq", "version": config.version, "claude": bin != nil,
                "agentes": (act?.oficina.agentes.map(\.id) ?? []).sorted(), "auth": a,
                "claudePath": bin.map { $0 as Any } ?? NSNull(),
                "oficina": act.map { $0.resumen as Any } ?? NSNull(),
                "perfil": await oficinas.perfilActual().json]
    }

    // MARK: oficinas

    private func crearOficina(_ body: Data?) async throws -> Resp {
        let d = try objeto(body)
        let nombre = try Validar.texto(d["nombre"], "nombre", max: 80)!
        let duenio = try Validar.texto(d["duenio"], "duenio", max: 80, obligatorio: false) ?? ""
        let carpeta = try Validar.texto(d["carpeta"], "carpeta", max: 1024, obligatorio: false)
        var deps: [Oficinas.DepartamentoNuevo]?
        if let v = d["departamentos"], !(v is NSNull) {
            guard let arr = v as? [Any] else { throw ErrorAPI(400, "«departamentos» tiene que ser una lista.") }
            deps = try arr.map { x in
                if let s = x as? String { return Oficinas.DepartamentoNuevo(id: nil, nombre: s, color: nil) }
                guard let o = x as? [String: Any] else { throw ErrorAPI(400, "Cada departamento es un texto o un objeto {nombre, color?}.") }
                return Oficinas.DepartamentoNuevo(id: try Validar.texto(o["id"], "id", max: 41, obligatorio: false),
                                                  nombre: try Validar.texto(o["nombre"], "nombre", max: 60)!,
                                                  color: try Validar.texto(o["color"], "color", max: 7, obligatorio: false))
            }
        }
        let vacia = (d["vacia"] as? Bool) ?? false
        let a = try await oficinas.crear(nombre: nombre, duenio: duenio, carpeta: carpeta, departamentos: deps, vacia: vacia)
        return (200, Router.sobreOficina(a))
    }

    private func abrirOficina(_ body: Data?) async throws -> Resp {
        let d = try objeto(body)
        let carpeta = try Validar.texto(d["carpeta"], "carpeta", max: 1024)!
        let a = try await oficinas.abrir(carpeta: carpeta)
        await reclamarSiProspera(a.carpeta)
        escanearVinculosEnSegundoPlano(a)
        return (200, Router.sobreOficina(a))
    }

    /// Al abrir una oficina se vuelven a escanear sus carpetas vinculadas (archivos nuevos o cambiados), sin bloquear la respuesta.
    private func escanearVinculosEnSegundoPlano(_ a: OficinaActiva) {
        let ids = (a.oficina.vinculos ?? []).map(\.id)
        guard !ids.isEmpty, let r = subrouters.biblioteca else { return }
        Task.detached(priority: .utility) {
            for id in ids {
                _ = await r.handle(method: "POST", path: "/api/vinculos/\(id)/escanear", query: [:], body: Data("{}".utf8))
            }
        }
    }

    private func importarProspera(_ body: Data?) async throws -> Resp {
        let d = try objetoOpcional(body)
        let r = try await oficinas.importarProspera(origen: try Validar.texto(d["origen"], "origen", max: 1024, obligatorio: false))
        await reclamarSiProspera(r.activa.carpeta)
        escanearVinculosEnSegundoPlano(r.activa)
        var o = Router.sobreOficina(r.activa)
        o["yaExistia"] = r.yaExistia; o["agentesImportados"] = r.agentes; o["faltantes"] = r.faltantes; o["copiados"] = r.copiados
        return (200, o)
    }

    /// Los chats anteriores a las oficinas pasan a la oficina importada de Próspera.
    private func reclamarSiProspera(_ carpeta: String) async {
        guard FileManager.default.fileExists(atPath: (carpeta as NSString).appendingPathComponent(ImportarProspera.marca)) else { return }
        if let n = try? await store.reclamarLegacy(oficina: carpeta), n > 0 { log.info("chats anteriores asignados a la oficina importada: \(n)") }
    }

    /// `mision` en un PATCH: si la clave no viene, nil (no se toca); null o texto vacío la borran.
    static func misionPatch(_ d: [String: Any]) throws -> String? {
        guard let v = d["mision"] else { return nil }
        if v is NSNull { return "" }
        guard v is String else { throw ErrorAPI(400, "«mision» tiene que ser texto.") }
        return try Validar.texto(v, "mision", max: ValidarAgenteExtra.maxMision, obligatorio: false) ?? ""
    }

    private func crearDepartamento(_ body: Data?) async throws -> Resp {
        let d = try objeto(body)
        let nuevo = Oficinas.DepartamentoNuevo(id: try Validar.texto(d["id"], "id", max: 41, obligatorio: false),
                                               nombre: try Validar.texto(d["nombre"], "nombre", max: 60)!,
                                               color: try Validar.texto(d["color"], "color", max: 7, obligatorio: false),
                                               mision: try Validar.texto(d["mision"], "mision", max: ValidarAgenteExtra.maxMision, obligatorio: false))
        let (dep, a) = try await oficinas.crearDepartamento(nuevo)
        return (200, ["departamento": dep.json, "oficina": a.oficina.json])
    }

    // MARK: agentes

    private func borrador(_ body: Data?) async throws -> Resp {
        let d = try objeto(body)
        let (a, prompt) = try await oficinas.prepararBorrador(
            descripcion: (d["descripcion"] as? String) ?? "", departamento: (d["departamento"] as? String) ?? "")
        let texto: String
        let caja = CajaCosto()
        do { texto = try await runner.correrSinAgente(prompt: prompt, cwd: a.carpeta, obs: caja.observador()) }
        catch let e as ClaudeError {
            log.error("borrador tipo=\(e.tipo)")
            return (502, ["error": "No pude armar el borrador del agente: \(e.mensaje)"])
        }
        await store.registrarCosto(oficina: a.carpeta, origen: "borrador", costo: caja.valor)
        // los ids ocupados se recalculan por si cambió la oficina mientras Claude pensaba
        let ocupados = Set((await oficinas.activa()?.oficina ?? a.oficina).agentes.map(\.id))
        guard let b = Borrador.parsear(texto, ocupados: ocupados) else {
            log.error("borrador: respuesta sin JSON válido")
            return (502, ["error": "Claude no devolvió un borrador que pueda usar. Probá de nuevo con otra descripción."])
        }
        var j = b.json
        j["departamento"] = (d["departamento"] as? String) ?? ""
        return (200, j)
    }

    private func contratar(_ body: Data?) async throws -> Resp {
        let n = try NuevoAgente.desde(try objeto(body))
        let (def, a) = try await oficinas.contratar(n)
        return (200, ["agente": def.json, "oficina": a.oficina.json])
    }

    // MARK: historial y chat

    /// `GET /api/consultas?session=<sid>`: lo que ese agente le consultó a sus colegas en esa conversación (oficina activa).
    private func consultas(_ q: [String: String]) async throws -> Resp {
        let act = try await oficinas.requerirActiva()
        guard let sidRaw = q["session"], Router.uuidValido(sidRaw) else { return (400, ["error": "pedido inválido"]) }
        let filas = await store.consultasDe(oficina: act.carpeta, sid: sidRaw.lowercased())
        func nombre(_ id: String) -> String { act.oficina.agente(id)?.nombre ?? id }
        return (200, ["consultas": filas.map { f -> [String: Any] in
            var d: [String: Any] = ["id": f.id, "de": f.de, "deNombre": nombre(f.de), "a": f.a, "aNombre": nombre(f.a),
                                    "pregunta": f.pregunta, "ts": f.ts, "pos": f.pos]
            if let r = f.respuesta { d["respuesta"] = r }
            if let e = f.error { d["error"] = e }
            if let c = f.costo { d["costo"] = c }
            return d
        }])
    }

    private func historial(_ q: [String: String]) async throws -> Resp {
        let invalido: Resp = (400, ["error": "pedido inválido"])
        let act = try await oficinas.requerirActiva()
        guard let agente = q["agent"], act.oficina.agente(agente) != nil else { return invalido }
        func lista(_ m: [Mensaje]) -> [[String: Any]] {
            m.map { x in var d: [String: Any] = ["r": x.r, "t": x.t]; if x.e { d["e"] = true }; return d }
        }
        guard let sidRaw = q["session"] else {
            let ult = await store.ultimaSesion(agente, oficina: act.carpeta)
            let msgs = ult == nil ? [] : await store.mensajes(ult!)
            return (200, ["session": ult.map { $0 as Any } ?? NSNull(), "msgs": lista(msgs)])
        }
        guard Router.uuidValido(sidRaw) else { return invalido }
        let sid = sidRaw.lowercased()
        if let dueno = await store.agenteDe(sid), dueno != agente { return (200, ["msgs": [Any]()]) }
        if let of = await store.oficinaDe(sid), of != act.carpeta { return (200, ["msgs": [Any]()]) }
        return (200, ["msgs": lista(await store.mensajes(sid))])
    }

    private func chat(_ body: Data?) async throws -> Resp {
        let invalido: Resp = (400, ["error": "pedido inválido"])
        let act = try await oficinas.requerirActiva()
        guard let body else { return invalido }
        // con archivos adjuntos el cuerpo puede ser grande (base64); sin ellos, el tope de siempre
        if body.count > Adjuntos.maxBody { return (413, ["error": "pedido demasiado grande"]) }
        let cuerpo = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        if body.count > Router.maxBody, cuerpo?["archivos"] == nil { return (413, ["error": "pedido demasiado grande"]) }
        guard let d = cuerpo, let agente = d["agent"] as? String, let m = d["message"] as? String, let sidRaw = d["session"] as? String
        else { return invalido }
        let adjuntos: [(nombre: String, datos: Data)]
        do { adjuntos = try Adjuntos.leer(d["archivos"]) } catch let e as ErrorAPI { return (e.status, ["error": e.mensaje]) }
        let escrito = m.trimmingCharacters(in: .whitespacesAndNewlines)
        // solo archivos, sin texto: se los pasa igual
        let msg = escrito.isEmpty && !adjuntos.isEmpty ? "Te paso estos archivos." : escrito
        guard let def = act.oficina.agente(agente), !msg.isEmpty, msg.count <= Router.maxMensaje, Router.uuidValido(sidRaw) else { return invalido }
        let sid = sidRaw.lowercased()

        do { try runner.verificar(carpeta: act.carpeta) } catch let e as ClaudeError {
            log.error("chat agente=\(agente) tipo=\(e.tipo)")
            return (500, ["error": e.mensaje])
        } catch { return (500, ["error": "error interno"]) }

        if let dueno = await store.agenteDe(sid), dueno != agente { return invalido }
        if let of = await store.oficinaDe(sid), of != act.carpeta { return invalido }
        // los adjuntos se guardan en la oficina y el agente recibe sus rutas al final del mensaje
        let mensaje: String
        do { mensaje = msg + Adjuntos.texto(try Adjuntos.guardar(act, origen: "chat/\(agente)", adjuntos)) }
        catch let e as ErrorAPI { return (e.status, ["error": e.mensaje]) }
        let t0 = Date()
        let store = self.store, runner = self.runner
        var ctx = Permisos.contexto(act, agente: def, dirsExtra: config.oficinaDirsExtra)
        let carpeta = act.carpeta
        let caja = CajaCosto()
        let escritos = CajaArchivos()
        defer { let c = caja.valor; Task { await store.registrarCosto(oficina: carpeta, agente: agente, origen: "chat", ref: sid, costo: c) } }
        // Consultas a colegas: el token vive lo que dura este chat (se revoca al terminar). Si el servidor MCP no
        // arrancó, el chat sale igual, sin la herramienta.
        let mcpUrl = await mcp?.url()
        ctx.mcpUrl = mcpUrl
        let ctxFinal = ctx
        let mcp = self.mcp
        let resultado: (Int, [String: String]) = await runner.conCarril(oficina: carpeta, agente: agente) {
            var envExtra: [String: String] = [:]
            if mcpUrl != nil, let mcp {
                envExtra[Permisos.variableTokenMCP] = mcp.tokens.emitir(oficina: carpeta, agente: agente, sid: sid, perfil: ctxFinal.perfilMCP)
            }
            defer { if let t = envExtra[Permisos.variableTokenMCP] { mcp?.tokens.revocar(t) } }
            do {
                try await store.asegurarSesion(sid, agente: agente, oficina: carpeta)
                try await store.agregar(sid: sid, rol: "u", texto: mensaje)
                let activa = await store.estaActiva(sid)
                let texto = try await runner.actividad.seguir(oficina: carpeta, agente: agente, origen: "chat", tarea: msg,
                                                              extra: caja.observador(escritos.observador())) { obs, token in
                    let resumen = runner.resumirTarea(msg, oficina: carpeta, agente: agente, token: token, store: store)
                    defer { resumen?.cancel() }
                    return try await runner.ejecutarChat(agente: agente, mensaje: mensaje, sid: sid, activa: activa, oficina: ctxFinal, obs: obs,
                                                         envExtra: envExtra)
                }
                try await store.marcarActiva(sid)
                try await store.agregar(sid: sid, rol: "a", texto: texto.isEmpty ? "(sin respuesta)" : texto)
                if let av = await store.avisoCrear(oficina: carpeta, tipo: "respuesta", agente: agente,
                                                   texto: TextoAviso.respuesta(texto.isEmpty ? "(sin respuesta)" : texto), ref: sid) {
                    runner.canalAvisos.emitir(av, nombre: def.nombre)
                }
                // un chat que dejó archivos en archivos/entregables/ cuenta como entrega para revisar
                let entregables = ArchivosEntrega.enEntregables(ArchivosEntrega.relativos(escritos.valor, carpeta: carpeta))
                var r: [String: String] = ["reply": texto]
                if !entregables.isEmpty, let e = await RegistroEntregas.registrar(
                    store, runner.canalAvisos, oficina: carpeta, agente: agente, nombre: def.nombre, origen: "chat", ref: sid,
                    titulo: TextoEntrega.titulo(msg), texto: texto, sid: sid, archivos: entregables, costo: caja.valor) {
                    r["entrega"] = String(e.id)
                }
                return (200, r)
            } catch let e as ClaudeError {
                try? await store.agregar(sid: sid, rol: "a", texto: "No pude responder: " + e.mensaje, error: true)
                if let av = await store.avisoCrear(oficina: carpeta, tipo: "error", agente: agente,
                                                   texto: "No pudo responder: " + e.mensaje, ref: sid) {
                    runner.canalAvisos.emitir(av, nombre: def.nombre)
                }
                return (e.status, ["error": e.mensaje])
            } catch {
                let t = "No pude guardar la conversación."
                try? await store.agregar(sid: sid, rol: "a", texto: "No pude responder: " + t, error: true)
                return (500, ["error": t])
            }
        }
        let seg = String(format: "%.1f", Date().timeIntervalSince(t0))
        log.info("chat agente=\(agente) sid=\(sid.prefix(8)) estado=\(resultado.0) seg=\(seg)")
        return (resultado.0, resultado.1)
    }
}

/// `claude auth status` cacheado unos segundos (la UI de onboarding consulta /api/estado seguido).
actor AuthCache {
    private let runner: ClaudeRunner
    private var valorCache: Bool?
    private var cuando = Date.distantPast
    private var enCurso: Task<Bool?, Never>?
    private let ttl: TimeInterval = 5

    init(runner: ClaudeRunner) { self.runner = runner }

    func valor() async -> Bool? {
        if Date().timeIntervalSince(cuando) < ttl { return valorCache }
        if let t = enCurso { return await t.value }
        let r = runner
        let t = Task<Bool?, Never> { await r.authStatus(timeout: 8) }
        enCurso = t
        let v = await t.value
        enCurso = nil
        valorCache = v
        cuando = Date()
        return v
    }
}
