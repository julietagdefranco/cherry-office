import Foundation

/// Acciones hacia afuera con aprobación de la persona (plan §8): un agente PROPONE usar una herramienta de actuar de un
/// conector (mandar un mail, crear un evento) y recién cuando la persona la aprueba se ejecuta.
enum Acciones {
    static let herramientaPropuesta = "mcp__hq__proponer_accion"
    /// Propuestas por corrida.
    static let maxPorCorrida = 5
    static let maxResumen = 300
    static let maxDetalle = 8000

    /// Herramientas de actuar que el agente tiene asignadas (nombres completos).
    static func actuar(_ a: AgenteDef) -> [String] {
        var out: [String] = []
        for h in (a.conectores ?? []).flatMap(\.actuar) where !out.contains(h) { out.append(h) }
        return out
    }

    static func herramientasMCP(_ o: Oficina, _ a: AgenteDef) -> [String] {
        actuar(a).isEmpty ? [] : [herramientaPropuesta]
    }

    static func herramientas(_ s: ServiciosHQ, token: String, identidad: IdentidadMCP) -> MCPHerramientas? {
        guard let o = try? OficinaStore.leer(carpeta: identidad.oficina), let a = o.agente(identidad.agente), !actuar(a).isEmpty else { return nil }
        return HerramientasAcciones(servicios: s, token: token, identidad: identidad)
    }

    /// Engancha la ejecución de las acciones aprobadas al programador: al entregar, la acción queda hecha con su resultado;
    /// si la ejecución falla, pasa a error.
    static func instalar(_ s: ServiciosHQ) async {
        let store = s.store
        await s.programador.alEntregar { e, ej in
            guard let id = deAccion(e.ref), e.origen == "accion", await store.accion(oficina: e.oficina, id: id) != nil else { return }
            await store.accionActualizar(id: id, estado: "hecha", resultado: e.texto, ejecucion: ej?.id)
        }
        await s.programador.alTerminar { ej in
            guard let id = deAccion(ej.tarea), let ac = await store.accion(oficina: ej.oficina, id: id) else { return }
            if ej.estado == "ok" {
                if ac.estado == "ejecutando" { await store.accionActualizar(id: id, estado: "hecha", resultado: ej.resultado, ejecucion: ej.id) }
            } else if ac.estado == "ejecutando" || ac.estado == "hecha" {
                await store.accionActualizar(id: id, estado: "error", resultado: ej.error ?? "error", ejecucion: ej.id)
            }
        }
    }

    static func deAccion(_ tarea: String) -> Int64? {
        guard tarea.hasPrefix(Programador.prefijoAccion) else { return nil }
        return Int64(tarea.dropFirst(Programador.prefijoAccion.count))
    }

    /// Acciones que se están aprobando ahora (evita que dos pedidos aprueben la misma).
    private actor Cerrojo {
        var ids = Set<String>()
        func tomar(_ k: String) -> Bool { ids.insert(k).inserted }
        func soltar(_ k: String) { ids.remove(k) }
    }
    private static let cerrojo = Cerrojo()

    /// «Aprobar y ejecutar»: marca la entrega como revisada y la acción como ejecutando, y lanza el encargo con
    /// SOLO esa herramienta de actuar habilitada.
    static func ejecutar(_ s: ServiciosHQ, act: OficinaActiva, entrega: Entrega) async throws -> Ejecucion {
        guard let ac = await s.store.accionPorEntrega(oficina: act.carpeta, entrega: entrega.id) else {
            throw ErrorAPI(404, "Esa entrega no tiene una acción para aprobar.")
        }
        let clave = act.carpeta + "\u{1f}\(ac.id)"
        guard await cerrojo.tomar(clave) else { throw ErrorAPI(409, "Esa acción ya se está ejecutando.") }
        do {
            let ej = try await ejecutarReservada(s, act: act, entrega: entrega, accion: ac.id)
            await cerrojo.soltar(clave)
            return ej
        } catch {
            await cerrojo.soltar(clave)
            throw error
        }
    }

    private static func ejecutarReservada(_ s: ServiciosHQ, act: OficinaActiva, entrega: Entrega, accion id: Int64) async throws -> Ejecucion {
        guard let ac = await s.store.accion(oficina: act.carpeta, id: id), ac.estado == "pendiente" else {
            throw ErrorAPI(409, "Esa acción ya no está pendiente.")
        }
        guard let def = act.oficina.agente(ac.agente) else { throw ErrorAPI(409, "El agente que la propuso ya no está en la oficina.") }
        guard actuar(def).contains(ac.herramienta) else {
            throw ErrorAPI(409, "El agente ya no tiene asignada esa herramienta para actuar.")
        }
        let jefe = act.oficina.duenio.trimmingCharacters(in: .whitespacesAndNewlines)
        let aprueba = jefe.isEmpty ? "La persona" : jefe
        let consigna = """
        \(aprueba) aprobó esta acción. Ejecutá exactamente esto con la herramienta \(ac.herramienta) y estos argumentos, y no hagas nada más:

        Resumen: \(ac.resumen)
        Argumentos (JSON): \(ac.detalle)

        Cuando termine, contá en una o dos frases qué hizo la herramienta.
        """
        await s.store.entregaMarcar(oficina: act.carpeta, id: entrega.id, estado: "revisada")
        await s.store.accionActualizar(id: id, estado: "ejecutando")
        do {
            return try await s.programador.encargarLibre(act, def, id: Programador.prefijoAccion + String(id),
                                                         nombre: "Acción aprobada: " + ac.resumen, consigna: consigna,
                                                         actuar: [ac.herramienta])
        } catch {
            await s.store.accionActualizar(id: id, estado: "pendiente")
            await s.store.entregaMarcar(oficina: act.carpeta, id: entrega.id, estado: "sin_revisar")
            throw error
        }
    }
}

/// `proponer_accion` atada a un token.
struct HerramientasAcciones: MCPHerramientas {
    let servicios: ServiciosHQ
    let token: String
    let identidad: IdentidadMCP

    var definiciones: [[String: Any]] {
        [["name": "proponer_accion",
          "description": "Propone una acción que sale de la oficina (mandar un mail, crear un evento...) con una herramienta de conector que tenés asignada para actuar. NO la ejecuta: la persona la revisa y, si la aprueba, recién ahí se ejecuta. Máximo \(Acciones.maxPorCorrida) propuestas por mensaje.",
          "inputSchema": ["type": "object",
                          "properties": ["herramienta": ["type": "string", "description": "nombre completo de la herramienta (mcp__claude_ai_...)"],
                                         "resumen": ["type": "string", "description": "qué querés hacer, en una frase"],
                                         "detalle": ["type": "object", "description": "los argumentos exactos con los que se llamaría a la herramienta"]],
                          "required": ["herramienta", "resumen"]]]]
    }

    func llamar(_ nombre: String, argumentos: [String: Any]) async -> MCPResultado? {
        guard nombre == "proponer_accion" else { return nil }
        return await proponer(argumentos)
    }

    private func proponer(_ args: [String: Any]) async -> MCPResultado {
        let s = servicios
        guard let o = try? OficinaStore.leer(carpeta: identidad.oficina), let ag = o.agente(identidad.agente) else {
            return .error("No pude leer la oficina.")
        }
        let h = (args["herramienta"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let asignadas = Acciones.actuar(ag)
        guard !h.isEmpty, asignadas.contains(h) else {
            return .error("No tenés esa herramienta asignada para actuar. Las que podés proponer son: \(asignadas.joined(separator: ", ")).")
        }
        var resumen = ConsultasMCP.sanear(args["resumen"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !resumen.isEmpty else { return .error("Falta «resumen»: contá en una frase qué querés hacer.") }
        if resumen.count > Acciones.maxResumen { resumen = String(resumen.prefix(Acciones.maxResumen)) }
        guard let detalle = Self.detalleJSON(args["detalle"]) else {
            return .error("«detalle» tiene que ser un objeto con los argumentos de la herramienta (hasta \(Acciones.maxDetalle) caracteres).")
        }
        if let tokens = s.mcp?.tokens, !tokens.tomar(token, clave: "accion", max: Acciones.maxPorCorrida) {
            return .error("Ya propusiste \(Acciones.maxPorCorrida) acciones en este mensaje y no podés proponer más.")
        }
        let jefe = o.duenio.trimmingCharacters(in: .whitespacesAndNewlines)
        let texto = resumen + "\n\nHerramienta: \(Conectores.corto(h))\n" + Self.legible(detalle)
        guard let e = await RegistroEntregas.registrar(s.store, s.runner.canalAvisos, oficina: identidad.oficina, agente: ag.id, nombre: ag.nombre,
                                                       origen: "propuesta", ref: identidad.sid, titulo: "Propuesta: " + resumen, texto: texto,
                                                       sid: identidad.sid) else {
            return .error("No pude guardar la propuesta.")
        }
        guard let ac = await s.store.accionCrear(oficina: identidad.oficina, agente: ag.id, sid: identidad.sid, herramienta: h, resumen: resumen,
                                           detalle: detalle, entrega: e.id) else {
            return .error("No pude guardar la acción.")
        }
        return .ok("Propuesta #\(ac.id) guardada: \(jefe.isEmpty ? "la persona" : jefe) la revisa y, si la aprueba, se ejecuta. Todavía no se hizo nada.")
    }

    /// Objeto JSON como texto (o `{}` si no vino); nil si no es un objeto o es demasiado grande.
    static func detalleJSON(_ v: Any?) -> String? {
        guard let v, !(v is NSNull) else { return "{}" }
        var obj = v
        if let t = v as? String {
            guard let d = (try? JSONSerialization.jsonObject(with: Data(t.utf8))) as? [String: Any] else { return nil }
            obj = d
        }
        guard obj is [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes]) else { return nil }
        let t = String(decoding: data, as: UTF8.self)
        return t.count <= Acciones.maxDetalle ? t : nil
    }

    /// Una línea `clave: valor` por argumento, para leer en la entrega.
    static func legible(_ detalle: String) -> String {
        guard let d = (try? JSONSerialization.jsonObject(with: Data(detalle.utf8))) as? [String: Any], !d.isEmpty else { return "Sin argumentos." }
        return d.keys.sorted().map { k -> String in
            let v = d[k]!
            if let s = v as? String { return "\(k): \(s)" }
            let t = (try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed, .sortedKeys, .withoutEscapingSlashes]))
                .map { String(decoding: $0, as: UTF8.self) } ?? "\(v)"
            return "\(k): \(t)"
        }.joined(separator: "\n")
    }
}
