import Foundation

/// Un pedido de permiso de un agente que espera la respuesta de la persona (claude `--permission-prompt-tool`).
public struct PedidoPermiso: Sendable, Equatable {
    public var id: String
    public var oficina: String
    public var agente: String
    public var sid: String
    /// Herramienta de claude que pide permiso (`Bash`, `Edit`, `Write`...).
    public var herramienta: String
    /// Qué quiere hacer: el comando o la ruta del archivo (recortado).
    public var detalle: String
    /// Descripción corta que manda claude con el comando (Bash), si vino.
    public var descripcion: String?
    /// Reglas de `--allowedTools` que se guardan con «Siempre» (vacío = solo se puede permitir una vez).
    public var reglas: [String]
    public var ts: Double

    public var json: [String: Any] {
        var d: [String: Any] = ["id": id, "agente": agente, "herramienta": herramienta, "detalle": detalle, "reglas": reglas, "ts": ts]
        if let x = descripcion { d["descripcion"] = x }
        return d
    }
}

/// Qué respondió la persona.
public enum DecisionPermiso: String, Sendable {
    case unaVez = "una_vez"
    case siempre
    case rechazar
}

/// Pedidos de permiso en vivo (en memoria). La herramienta MCP `pedir_permiso` crea un pedido y espera; el front los ve en
/// `GET /api/actividad` (`permisos`) y responde con `POST /api/permisos/<id>`. Si nadie responde en `timeout`, o el chat
/// termina antes, el pedido se rechaza. Formato del pedido y de la respuesta verificado en docs/aprendizajes.md.
public final class PermisosVivos: @unchecked Sendable {
    private struct Entrada {
        var pedido: PedidoPermiso
        var token: String
        var cont: CheckedContinuation<DecisionPermiso?, Never>?
        var decision: DecisionPermiso??
    }

    /// Segundos que se espera a la persona (240 por defecto; `HQ_PERMISO_TIMEOUT` en el entorno lo cambia).
    public let timeout: TimeInterval
    private let lock = NSLock()
    private var entradas: [String: Entrada] = [:]
    private var orden: [String] = []
    private var alCambiarFn: (@Sendable () -> Void)?

    static let maxDetalle = 2000
    static let maxPendientes = 20

    public init(timeout: TimeInterval? = nil, env: [String: String] = ProcessInfo.processInfo.environment) {
        self.timeout = timeout ?? env["HQ_PERMISO_TIMEOUT"].flatMap(TimeInterval.init) ?? 240
    }

    /// Se llama cada vez que aparece o se va un pedido (el Backend sube la versión de la actividad).
    func alCambiar(_ f: @escaping @Sendable () -> Void) { lock.lock(); alCambiarFn = f; lock.unlock() }

    private func avisar() { lock.lock(); let f = alCambiarFn; lock.unlock(); f?() }

    /// Crea el pedido y espera la decisión. nil = nadie respondió a tiempo, el chat terminó o hay demasiados pendientes.
    func pedir(token: String, identidad: IdentidadMCP, herramienta: String, input: [String: Any]) async -> DecisionPermiso? {
        let id = UUID().uuidString.lowercased()
        let p = PedidoPermiso(id: id, oficina: identidad.oficina, agente: identidad.agente, sid: identidad.sid,
                              herramienta: herramienta, detalle: Self.detalle(herramienta, input),
                              descripcion: (input["description"] as? String).map { String(ConsultasMCP.sanear($0).prefix(300)) },
                              reglas: Self.reglasSugeridas(herramienta, input), ts: Date().timeIntervalSince1970)
        guard registrar(p, token: token) else { return nil }
        avisar()
        let t = timeout
        let vence = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, t) * 1_000_000_000))
            if !Task.isCancelled { self?.terminar(id, nil) }
        }
        let d: DecisionPermiso? = await withCheckedContinuation { c in
            lock.lock()
            if var e = entradas[id] {
                if let ya = e.decision { lock.unlock(); terminarEntrada(id); c.resume(returning: ya); return }
                e.cont = c; entradas[id] = e; lock.unlock()
            } else { lock.unlock(); c.resume(returning: nil) }
        }
        vence.cancel()
        return d
    }

    private func registrar(_ p: PedidoPermiso, token: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard entradas.count < Self.maxPendientes else { return false }
        entradas[p.id] = Entrada(pedido: p, token: token)
        orden.append(p.id)
        return true
    }

    /// Resuelve un pedido (y lo saca de la lista). Si todavía no se estaba esperando, guarda la decisión.
    private func terminar(_ id: String, _ d: DecisionPermiso?) {
        lock.lock()
        guard var e = entradas[id] else { lock.unlock(); return }
        if let c = e.cont {
            entradas[id] = nil; orden.removeAll { $0 == id }
            lock.unlock()
            c.resume(returning: d)
            avisar()
        } else {
            e.decision = .some(d); entradas[id] = e
            lock.unlock()
        }
    }

    private func terminarEntrada(_ id: String) {
        lock.lock(); entradas[id] = nil; orden.removeAll { $0 == id }; lock.unlock()
        avisar()
    }

    /// La persona respondió. Devuelve el pedido, o nil si no existe (ya vencido o de otra oficina).
    func responder(oficina: String, id: String, decision: DecisionPermiso) -> PedidoPermiso? {
        guard let p = pedido(oficina: oficina, id: id) else { return nil }
        terminar(id, decision)
        return p
    }

    /// Un pedido pendiente de `oficina`.
    func pedido(oficina: String, id: String) -> PedidoPermiso? {
        lock.lock(); defer { lock.unlock() }
        guard let e = entradas[id], e.pedido.oficina == oficina, e.decision == nil else { return nil }
        return e.pedido
    }

    /// Pendientes de una oficina, en orden de llegada.
    func pendientes(oficina: String) -> [PedidoPermiso] {
        lock.lock(); defer { lock.unlock() }
        return orden.compactMap { entradas[$0] }.filter { $0.pedido.oficina == oficina && $0.decision == nil }.map(\.pedido)
    }

    /// El chat de ese token terminó: sus pedidos se rechazan.
    func cancelar(token: String) {
        lock.lock(); let ids = entradas.filter { $0.value.token == token }.map(\.key); lock.unlock()
        for id in ids { terminar(id, nil) }
    }

    // MARK: lógica pura

    /// Qué se muestra: el comando (Bash) o la ruta (las que escriben); si no, el input como JSON. Recortado y saneado.
    static func detalle(_ herramienta: String, _ input: [String: Any]) -> String {
        let t: String
        if let c = input["command"] as? String { t = c }
        else if let p = input["file_path"] as? String ?? input["notebook_path"] as? String { t = p }
        else if let u = input["url"] as? String { t = u }
        else {
            let d = (try? JSONSerialization.data(withJSONObject: input, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
            t = String(decoding: d, as: UTF8.self)
        }
        return String(ConsultasMCP.sanear(t).prefix(maxDetalle))
    }

    /// Programas en los que el permiso «siempre» incluye el subcomando (`git pull`, `npm install`).
    static let conSubcomando: Set<String> = ["git", "npm", "npx", "pnpm", "yarn", "bun", "swift", "cargo", "go", "docker",
                                             "brew", "pip", "pip3", "uv", "gh", "kubectl", "make"]

    /// Reglas que guarda «Siempre». Bash: `Bash(<programa> [subcomando]:*)`, salvo comandos compuestos (`&&`, `|`, `;`,
    /// redirecciones, sustituciones), que solo se permiten una vez. Edit/Write: la carpeta del archivo
    /// (`Edit(//<carpeta>/**)` y `Write(//<carpeta>/**)`), solo con rutas absolutas de tipo Unix. El resto: ninguna.
    static func reglasSugeridas(_ herramienta: String, _ input: [String: Any]) -> [String] {
        switch herramienta {
        case "Bash":
            guard let c = input["command"] as? String else { return [] }
            let cmd = c.trimmingCharacters(in: .whitespacesAndNewlines)
            let raros = ["&&", "||", ";", "|", "`", "$(", ">", "<", "\n", "&", "*", "?", "(", ")", "\\", "\"", "'"]
            guard !cmd.isEmpty, !raros.contains(where: { cmd.contains($0) }) else { return [] }
            let palabras = cmd.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            guard let prog = palabras.first, !prog.contains("=") else { return [] }
            var pref = prog
            if conSubcomando.contains(prog), palabras.count > 1, !palabras[1].hasPrefix("-") { pref += " " + palabras[1] }
            return ["Bash(\(pref):*)"]
        case "Edit", "Write", "MultiEdit", "NotebookEdit":
            guard let p = input["file_path"] as? String ?? input["notebook_path"] as? String,
                  p.hasPrefix("/"), !p.contains(".."), !p.contains("\0"), !p.contains("\n") else { return [] }
            let dir = (p as NSString).deletingLastPathComponent
            guard dir != "/", !dir.isEmpty else { return [] }
            let d = dir.hasSuffix("/") ? String(dir.dropLast()) : dir
            return ["Edit(/\(d)/**)", "Write(/\(d)/**)"]
        default:
            return []
        }
    }

    /// Respuesta de la herramienta para claude (texto JSON).
    static func respuesta(_ d: DecisionPermiso?, input: [String: Any]) -> String {
        let o: [String: Any]
        switch d {
        case .unaVez?, .siempre?: o = ["behavior": "allow", "updatedInput": input]
        case .rechazar?: o = ["behavior": "deny", "message": "La persona no dio permiso para esto. No lo intentes de otra forma: seguí sin eso o preguntale."]
        case nil: o = ["behavior": "deny", "message": "Nadie respondió el pedido de permiso a tiempo. No lo intentes de otra forma: seguí sin eso o avisá qué necesitás."]
        }
        let data = (try? JSONSerialization.data(withJSONObject: o, options: [.withoutEscapingSlashes])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}
