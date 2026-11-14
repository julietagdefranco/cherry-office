import Foundation

/// Rutas del Creador (plan §API y §11): `/api/creador/chat|estado|borrador|tarjetas/:id|aplicar`.
/// El chat corre en segundo plano (el modo dev corta a los 120 s): responde 202 y el front sondea `estado` y `borrador`.
struct CreadorRouter: SubRouter {
    let servicios: ServiciosHQ
    init(servicios: ServiciosHQ) { self.servicios = servicios }

    static func esRuta(_ p: String) -> Bool { p == "/api/creador" || p.hasPrefix("/api/creador/") }

    func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)? {
        guard CreadorRouter.esRuta(path) else { return nil }
        let (code, obj) = await despachar(method: method.uppercased(), path: path, query: query, body: body)
        return (code, Router.codificar(obj))
    }

    private func despachar(method: String, path: String, query: [String: String], body: Data?) async -> (Int, [String: Any]) {
        let no: (Int, [String: Any]) = (405, ["error": "método no permitido"])
        let partes = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)   // api, creador, ...
        guard partes.count >= 3, !partes.contains("") else { return (404, ["error": "no"]) }
        do {
            switch (partes[2], partes.count) {
            case ("chat", 3): return method == "POST" ? try await chat(body) : no
            case ("estado", 3): return method == "GET" ? try await estado(query) : no
            case ("borrador", 3): return method == "GET" ? try await borrador() : no
            case ("aplicar", 3): return method == "POST" ? try await aplicar(body) : no
            case ("tarjetas", 4):
                switch method {
                case "PATCH": return try await editar(partes[3], body)
                case "DELETE": return try await descartar(partes[3])
                default: return no
                }
            default: return (404, ["error": "no"])
            }
        } catch let e as ErrorAPI {
            return (e.status, ["error": e.mensaje])
        } catch {
            return (500, ["error": "error interno"])
        }
    }

    private func objeto(_ body: Data?) throws -> [String: Any] {
        guard let body, !body.isEmpty else { throw ErrorAPI(400, "pedido inválido") }
        if body.count > Router.maxBody { throw ErrorAPI(413, "pedido demasiado grande") }
        guard let d = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { throw ErrorAPI(400, "pedido inválido") }
        return d
    }

    // MARK: chat

    private func chat(_ body: Data?) async throws -> (Int, [String: Any]) {
        let s = servicios
        let act = try await s.oficinas.requerirActiva()
        if let body, body.count > Router.maxBody { throw ErrorAPI(413, "pedido demasiado grande") }
        let d = try objeto(body)
        guard let m = d["message"] as? String, let sidRaw = d["session"] as? String else { throw ErrorAPI(400, "pedido inválido") }
        let msg = m.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty, msg.count <= Router.maxMensaje, Router.uuidValido(sidRaw) else { throw ErrorAPI(400, "pedido inválido") }
        let sid = sidRaw.lowercased()
        let carpeta = act.carpeta

        do { try s.runner.verificar(carpeta: carpeta) } catch let e as ClaudeError {
            s.log.error("creador tipo=\(e.tipo)")
            throw ErrorAPI(500, e.mensaje)
        }
        if let dueno = await s.store.agenteDe(sid), dueno != Creador.idAgente { throw ErrorAPI(400, "pedido inválido") }
        if let of = await s.store.oficinaDe(sid), of != carpeta { throw ErrorAPI(400, "pedido inválido") }
        guard CorridasCreador.compartido.empezar(carpeta, sid) else { throw ErrorAPI(409, "El Creador todavía está trabajando en tu mensaje anterior.") }

        // el agente se regenera antes de cada corrida; el mensaje de la persona queda guardado antes de responder
        // (las herramientas comprueban las citas contra él)
        do {
            try Plantillas.crearDir(act.ruta(".claude/agents"))
            try Data(Plantillas.creadorMD(oficina: act.oficina).utf8)
                .write(to: URL(fileURLWithPath: act.ruta(".claude/agents/\(Creador.idAgente).md")), options: .atomic)
            try await s.store.asegurarSesion(sid, agente: Creador.idAgente, oficina: carpeta)
            try await s.store.agregar(sid: sid, rol: "u", texto: msg)
        } catch {
            CorridasCreador.compartido.terminar(carpeta, sid)
            throw ErrorAPI(500, "No pude guardar la conversación.")
        }
        let mcpUrl = await s.mcp?.url()
        let ctx = CreadorRouter.contexto(carpeta: carpeta, mcpUrl: mcpUrl)
        Task { await CreadorRouter.correr(s, carpeta: carpeta, sid: sid, msg: msg, ctx: ctx) }
        s.log.info("creador chat sid=\(sid.prefix(8)) en segundo plano")
        return (202, ["ok": true, "session": sid])
    }

    /// El Creador solo lee (Read, Glob, Grep), no escribe en la oficina y no ve los conectores de la cuenta.
    static func contexto(carpeta: String, mcpUrl: String?) -> ContextoOficina {
        var ctx = ContextoOficina(carpeta: carpeta, escritura: [], dirsExtra: [], mcpUrl: mcpUrl)
        ctx.herramientasBase = "Read,Glob,Grep"
        ctx.herramientasMCP = Creador.nombresMCP
        ctx.vedadas = ["mcp__claude_ai_*"]
        ctx.perfilMCP = "creador"
        return ctx
    }

    /// La corrida de fondo: carril (oficina, creador), token de perfil creador, actividad «armando» y respuesta guardada como `a`.
    static func correr(_ s: ServiciosHQ, carpeta: String, sid: String, msg: String, ctx: ContextoOficina) async {
        defer {
            CorridasCreador.compartido.terminar(carpeta, sid)
            VersionCreador.compartida.subir(carpeta)
        }
        let store = s.store, runner = s.runner, mcp = s.mcp
        let caja = CajaCosto()
        let resultado: (texto: String?, error: String?) = await runner.conCarril(oficina: carpeta, agente: Creador.idAgente) {
            var envExtra: [String: String] = [:]
            if ctx.mcpUrl != nil, let mcp {
                envExtra[Permisos.variableTokenMCP] = mcp.tokens.emitir(oficina: carpeta, agente: Creador.idAgente, sid: sid, perfil: "creador")
            }
            defer { if let t = envExtra[Permisos.variableTokenMCP] { mcp?.tokens.revocar(t) } }
            guard ctx.mcpUrl != nil else { return (nil, "El servidor interno de la oficina no está disponible: el Creador no puede armar tarjetas.") }
            do {
                let activa = await store.estaActiva(sid)
                let texto = try await runner.actividad.seguir(oficina: carpeta, agente: Creador.idAgente, origen: "creador", tarea: msg,
                                                              extra: caja.observador()) { obs, _ in
                    try await runner.ejecutarChat(agente: Creador.idAgente, mensaje: msg, sid: sid, activa: activa, oficina: ctx, obs: obs,
                                                  envExtra: envExtra)
                }
                try? await store.marcarActiva(sid)
                return (texto.isEmpty ? "(sin respuesta)" : texto, nil)
            } catch let e as ClaudeError {
                return (nil, e.mensaje)
            } catch {
                return (nil, "No pude responder.")
            }
        }
        if let t = resultado.texto {
            try? await store.agregar(sid: sid, rol: "a", texto: t)
        } else {
            try? await store.agregar(sid: sid, rol: "a", texto: "No pude responder: " + (resultado.error ?? "error"), error: true)
        }
        await store.registrarCosto(oficina: carpeta, agente: Creador.idAgente, origen: "creador", ref: sid, costo: caja.valor)
    }

    // MARK: estado y borrador

    private func estado(_ query: [String: String]) async throws -> (Int, [String: Any]) {
        let act = try await servicios.oficinas.requerirActiva()
        guard let sidRaw = query["session"], Router.uuidValido(sidRaw) else { throw ErrorAPI(400, "pedido inválido") }
        let sid = sidRaw.lowercased()
        let store = servicios.store
        var mensajes: [[String: Any]] = []
        if await store.agenteDe(sid) == Creador.idAgente, await store.oficinaDe(sid) == act.carpeta {
            mensajes = await store.mensajesConFecha(sid).map {
                var x: [String: Any] = ["rol": $0.rol, "texto": $0.texto, "ts": ReunionesRouter.iso($0.ts)]
                if $0.error { x["error"] = true }
                return x
            }
        }
        return (200, ["corriendo": CorridasCreador.compartido.corriendo(act.carpeta, sid), "mensajes": mensajes,
                      "version": VersionCreador.compartida.valor(act.carpeta)])
    }

    private func borrador() async throws -> (Int, [String: Any]) {
        let act = try await servicios.oficinas.requerirActiva()
        let ts = await servicios.store.tarjetas(oficina: act.carpeta, estados: ["borrador", "lista", "creada", "error"])
        return (200, ["version": VersionCreador.compartida.valor(act.carpeta), "tarjetas": ts.map(\.json), "resumen": Creador.resumen(ts)])
    }

    // MARK: tarjetas

    /// `{datos}`: se suman a los de la tarjeta (un `null` borra un campo), se revalida y se recalculan los faltantes.
    /// No comprueba la cita: la edición la hace la persona.
    private func editar(_ id: String, _ body: Data?) async throws -> (Int, [String: Any]) {
        let act = try await servicios.oficinas.requerirActiva()
        let d = try objeto(body)
        guard let datos = d["datos"] as? [String: Any] else { throw ErrorAPI(400, "Falta «datos».") }
        guard let t = await servicios.store.tarjeta(oficina: act.carpeta, id: id) else { throw ErrorAPI(404, "No existe esa tarjeta.") }
        let nueva = try await Creador.armar(servicios, carpeta: act.carpeta, sid: t.sid, tipo: t.tipo, accion: nil, objetivo: nil, ref: id,
                                            origen: nil, datos: datos)
        return (200, ["tarjeta": nueva.json])
    }

    private func descartar(_ id: String) async throws -> (Int, [String: Any]) {
        let act = try await servicios.oficinas.requerirActiva()
        guard let t = await servicios.store.tarjeta(oficina: act.carpeta, id: id) else { throw ErrorAPI(404, "No existe esa tarjeta.") }
        guard t.estado != "creada" else { throw ErrorAPI(409, "Esa tarjeta ya se creó: no se puede descartar.") }
        guard let g = await servicios.store.tarjetaEstado(oficina: act.carpeta, id: id, estado: "descartada") else { throw ErrorAPI(500, "No pude descartar la tarjeta.") }
        VersionCreador.compartida.subir(act.carpeta)
        return (200, ["tarjeta": g.json])
    }

    // MARK: aplicar

    private func aplicar(_ body: Data?) async throws -> (Int, [String: Any]) {
        let act = try await servicios.oficinas.requerirActiva()
        let d = (body?.isEmpty ?? true) ? [:] : try objeto(body)
        var ids: [String]?
        if let v = d["ids"], !(v is NSNull) {
            guard let a = v as? [Any], a.allSatisfy({ $0 is String }) else { throw ErrorAPI(400, "«ids» tiene que ser una lista de ids de tarjetas.") }
            ids = a.compactMap { $0 as? String }
        }
        let confirmar = (d["confirmarQuitar"] as? Bool) ?? false
        do {
            let resultados = try await Creador.aplicar(servicios, act: act, ids: ids, confirmarQuitar: confirmar)
            let oficina = await servicios.oficinas.activa()?.oficina.json ?? [:]
            return (200, ["resultados": resultados, "oficina": oficina])
        } catch let b as AplicarBloqueado {
            let faltan = b.tarjetas.map { ["id": $0.id, "tipo": $0.tipo, "faltantes": Creador.lista($0.faltantes)] as [String: Any] }
            return (409, ["error": "Hay tarjetas en borrador: completá lo que falta antes de crearlas.", "borradores": faltan])
        }
    }
}

/// Las sesiones del Creador que están corriendo ahora (en memoria): una por vez en cada sesión.
final class CorridasCreador: @unchecked Sendable {
    static let compartido = CorridasCreador()
    private let lock = NSLock()
    private var activas = Set<String>()

    private func clave(_ c: String, _ sid: String) -> String { c + "\u{1f}" + sid }

    /// false si esa sesión ya está corriendo.
    func empezar(_ c: String, _ sid: String) -> Bool { lock.lock(); defer { lock.unlock() }; return activas.insert(clave(c, sid)).inserted }
    func terminar(_ c: String, _ sid: String) { lock.lock(); activas.remove(clave(c, sid)); lock.unlock() }
    func corriendo(_ c: String, _ sid: String) -> Bool { lock.lock(); defer { lock.unlock() }; return activas.contains(clave(c, sid)) }
}
