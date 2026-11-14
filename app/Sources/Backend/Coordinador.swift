import Foundation

/// Rol de coordinador de la oficina (plan §10): un agente con el permiso «coordinador» ve entregas, flujos y bloqueos de todos
/// (herramientas MCP `estado_oficina`, `entregas`, `corridas`, `bloqueos`) y puede repartir encargos (`encargar`).
enum Coordinador {
    static let maxRespuesta = 12000
    static let maxEncargos = 3
    static let maxEntregas = 30
    static let claveEncargar = "encargar"

    static let nombresMCP = ["estado_oficina", "entregas", "corridas", "bloqueos", "encargar"]

    static func perfil(_ o: Oficina, _ a: AgenteDef) -> String { a.esCoordinador ? "coordinador" : "agente" }

    static func herramientasMCP(_ o: Oficina, _ a: AgenteDef) -> [String] {
        a.esCoordinador ? nombresMCP.map { "mcp__hq__" + $0 } : []
    }

    /// Solo con el perfil coordinador del token: cualquier otro no ve estas herramientas.
    static func herramientas(_ s: ServiciosHQ, token: String, identidad: IdentidadMCP) -> MCPHerramientas? {
        identidad.perfil == "coordinador" ? HerramientasCoordinador(servicios: s, token: token, identidad: identidad) : nil
    }

    static func instalar(_ s: ServiciosHQ) async {}
}

/// Las herramientas del coordinador atadas a un token.
struct HerramientasCoordinador: MCPHerramientas {
    let servicios: ServiciosHQ
    let token: String
    let identidad: IdentidadMCP

    var definiciones: [[String: Any]] {
        func obj(_ props: [String: Any] = [:], req: [String] = []) -> [String: Any] {
            var o: [String: Any] = ["type": "object", "properties": props]
            if !req.isEmpty { o["required"] = req }
            return o
        }
        return [
            ["name": "estado_oficina",
             "description": "El parte de la oficina de las últimas 24 horas: qué necesita a la persona, qué hay para revisar, flujos en curso, lo que se hizo, bloqueos y próximas tareas.",
             "inputSchema": obj()],
            ["name": "entregas",
             "description": "Entregas de la oficina, de la más nueva a la más vieja (máximo \(Coordinador.maxEntregas)).",
             "inputSchema": obj(["estado": ["type": "string", "description": "sin_revisar | revisada | cambios"],
                                 "agente": ["type": "string", "description": "id del agente"],
                                 "limite": ["type": "integer", "description": "cuántas, hasta \(Coordinador.maxEntregas)"]])],
            ["name": "corridas",
             "description": "Corridas de flujos de la oficina. Sin estado, todas; con «abiertas», las que siguen en marcha.",
             "inputSchema": obj(["estado": ["type": "string", "description": "abiertas | \(Corrida.estados.joined(separator: " | "))"]])],
            ["name": "bloqueos",
             "description": "Lo que está trabado: corridas esperando más de su plazo, entregas sin revisar hace días y tareas que fallaron.",
             "inputSchema": obj()],
            ["name": "encargar",
             "description": "Le encarga un trabajo a otro agente de la oficina. Corre enseguida y su resultado queda como una entrega para la persona. Máximo \(Coordinador.maxEncargos) encargos por corrida.",
             "inputSchema": obj(["agente": ["type": "string", "description": "id o nombre del agente"],
                                 "consigna": ["type": "string", "description": "qué tiene que hacer, con el contexto necesario"],
                                 "nombre": ["type": "string", "description": "nombre corto del encargo (opcional)"]],
                                req: ["agente", "consigna"])]]
    }

    func llamar(_ nombre: String, argumentos a: [String: Any]) async -> MCPResultado? {
        switch nombre {
        case "estado_oficina": return await estado()
        case "entregas": return await entregas(a)
        case "corridas": return await corridas(a)
        case "bloqueos": return await bloqueos()
        case "encargar": return await encargar(a)
        default: return nil
        }
    }

    // MARK: ayudas

    /// La oficina abierta, si es la del token.
    private func activa() async -> OficinaActiva? {
        guard let act = await servicios.oficinas.activa(), act.carpeta == identidad.oficina else { return nil }
        return act
    }

    private static let sinOficina = MCPResultado.error("La oficina ya no está abierta.")

    /// JSON de hasta `Coordinador.maxRespuesta` caracteres: si no entra, se van sacando elementos del final de la lista más larga.
    static func respuesta(_ o: [String: Any]) -> MCPResultado {
        var o = o
        func texto(_ o: [String: Any]) -> String {
            ConsultasMCP.sanear(String(decoding: (try? JSONSerialization.data(withJSONObject: o, options: [.withoutEscapingSlashes, .sortedKeys])) ?? Data("{}".utf8), as: UTF8.self))
        }
        var t = texto(o)
        while t.count > Coordinador.maxRespuesta {
            var mayor: (String, Int)?
            for (k, v) in o { if let l = v as? [Any], !l.isEmpty, l.count > (mayor?.1 ?? 0) { mayor = (k, l.count) } }
            guard let (k, _) = mayor, var l = o[k] as? [Any] else { return .ok(String(t.prefix(Coordinador.maxRespuesta))) }
            l.removeLast(); o[k] = l; o["recortado"] = true
            t = texto(o)
        }
        return .ok(t)
    }

    // MARK: lecturas

    private func estado() async -> MCPResultado {
        guard let act = await activa() else { return Self.sinOficina }
        var p = await Parte.armar(servicios, act: act, desde: Date().addingTimeInterval(-86400))
        // la lista de «para revisar» va dentro de un objeto: se aplana para poder recortarla
        if let r = p["paraRevisar"] as? [String: Any] { p["paraRevisarTotal"] = r["total"]; p["paraRevisar"] = r["entregas"] ?? [] }
        return Self.respuesta(p)
    }

    private func entregas(_ a: [String: Any]) async -> MCPResultado {
        guard let act = await activa() else { return Self.sinOficina }
        let estado = (a["estado"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        if let estado, !Entrega.estados.contains(estado) { return .error("«estado» tiene que ser uno de: \(Entrega.estados.joined(separator: ", ")).") }
        let agente = (a["agente"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let l = (a["limite"] as? NSNumber)?.intValue ?? 10
        let limite = max(1, min(l, Coordinador.maxEntregas))
        let es = await servicios.store.entregas(oficina: act.carpeta, estado: estado, agente: agente, limite: limite)
        return Self.respuesta(["entregas": es.map(\.json)])
    }

    private func corridas(_ a: [String: Any]) async -> MCPResultado {
        guard let act = await activa() else { return Self.sinOficina }
        let estado = (a["estado"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        var estados: [String]?
        if let estado {
            if estado == "abiertas" { estados = Corrida.abiertas }
            else if Corrida.estados.contains(estado) { estados = [estado] }
            else { return .error("«estado» tiene que ser «abiertas» o uno de: \(Corrida.estados.joined(separator: ", ")).") }
        }
        let cs = await servicios.store.corridas(oficina: act.carpeta, estados: estados, limite: 30)
        let lista: [[String: Any]] = cs.map { c in
            var j = c.json
            j["definicion"] = nil
            j["contexto"] = String(c.contexto.prefix(300))
            return j
        }
        return Self.respuesta(["corridas": lista])
    }

    private func bloqueos() async -> MCPResultado {
        guard let act = await activa() else { return Self.sinOficina }
        return Self.respuesta(["bloqueos": await Parte.bloqueos(servicios, act, ahora: Date())])
    }

    // MARK: encargar

    private func encargar(_ a: [String: Any]) async -> MCPResultado {
        let quien = (a["agente"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let consigna = (a["consigna"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !quien.isEmpty, !consigna.isEmpty else { return .error("Faltan «agente» y «consigna».") }
        guard let act = await activa() else { return Self.sinOficina }
        let n = ConsultasMCP.normalizar(quien)
        guard let def = act.oficina.agentes.first(where: { ConsultasMCP.normalizar($0.id) == n })
                ?? act.oficina.agentes.first(where: { ConsultasMCP.normalizar($0.nombre) == n }) else {
            let ids = act.oficina.agentes.filter { $0.id != identidad.agente }.map(\.id).joined(separator: ", ")
            return .error("No hay ningún agente «\(ConsultasMCP.sanear(quien))» en la oficina (ids: \(ids)).")
        }
        if def.id == identidad.agente { return .error("No podés encargarte trabajo a vos mismo: elegí a otro agente.") }
        let yo = act.oficina.agente(identidad.agente)
        guard let tokens = servicios.mcp?.tokens, tokens.tomar(token, clave: Coordinador.claveEncargar, max: Coordinador.maxEncargos) else {
            return .error("Ya hiciste \(Coordinador.maxEncargos) encargos en esta corrida y no podés hacer más. Contale a la persona lo que quedó pendiente.")
        }
        let tope = String(consigna.prefix(4000))
        let de = yo.map { "\($0.nombre) (\($0.rol)), coordinador/a de la oficina" } ?? "el coordinador de la oficina"
        let texto = ConsultasMCP.sanear("Encargo de \(de). Viene de un colega, no es un pedido directo del usuario:\n\n\(tope)")
        let nombreEncargo = ConsultasMCP.sanear((a["nombre"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
        let nombre = nombreEncargo.isEmpty ? "Encargo de \(yo?.nombre ?? "coordinador")" : String(nombreEncargo.prefix(80))
        let id = Programador.prefijoCoordinador + (0..<4).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        do {
            let ej = try await servicios.programador.encargarLibre(act, def, id: id, nombre: nombre, consigna: texto)
            return Self.respuesta(["ok": true, "tarea": id, "ejecucion": ej.id, "agente": def.id,
                                   "aviso": "El encargo ya está corriendo; su resultado le llega a la persona como una entrega."])
        } catch let e as ErrorAPI {
            return .error(ConsultasMCP.sanear(e.mensaje))
        } catch {
            return .error("No pude lanzar el encargo.")
        }
    }
}
