import Foundation

/// Errores de una corrida de claude, ya clasificados.
public enum ClaudeError: Error, Sendable, Equatable {
    case noEncontrado
    case sinProyecto(String)
    case timeout
    case noEjecuta(String)
    case login(String)
    case claude(String)
    case cerrando

    public static let mensajeLogin = "Claude Code todavía no tiene la sesión iniciada. Usá «Iniciar sesión» en la app o corré 'claude auth login' en la Terminal."

    /// Texto para mostrar al usuario (español).
    public var mensaje: String {
        switch self {
        case .noEncontrado: return "No encontré Claude Code en esta compu."
        case .sinProyecto(let p): return "No encuentro la carpeta del proyecto (\(p))."
        case .timeout: return "Tardó demasiado en responder."
        case .noEjecuta: return "No pude ejecutar Claude Code en esta compu."
        case .login: return ClaudeError.mensajeLogin
        case .claude(let e): return e
        case .cerrando: return "La app se está cerrando."
        }
    }

    public var status: Int { self == .timeout ? 504 : 500 }

    /// Etiqueta para el log (sin contenido).
    public var tipo: String {
        switch self {
        case .noEncontrado: return "sin_claude"
        case .sinProyecto: return "sin_proyecto"
        case .timeout: return "timeout"
        case .noEjecuta: return "no_ejecuta"
        case .login: return "login"
        case .claude: return "claude"
        case .cerrando: return "cerrando"
        }
    }

    static func clasificar(_ e: String) -> ClaudeError {
        e.lowercased().contains("login") ? .login(e) : .claude(e)
    }
}

struct ProcResult: Sendable {
    var rc: Int32
    var stdout: String
    var stderr: String
    var timedOut: Bool
}

/// Lee un pipe hasta EOF sin bloquear ningún hilo: fd no bloqueante + `DispatchSource` de lectura en una cola propia.
/// Nunca usa `availableData` ni `readDataToEndOfFile` (que pueden lanzar excepciones de Objective-C si el handle se cierra).
/// `terminar()` hace una última lectura sin bloquear (lo que el proceso ya escribió está en el buffer del pipe), cancela y cierra.
final class LectorPipe: @unchecked Sendable {
    private let handle: FileHandle
    private let fd: Int32
    private let col: Collector
    private let cola: DispatchQueue
    private var fuente: DispatchSourceRead?
    private var cerrado = false
    private let cortador: CortadorLineas?

    /// `alLinea`: además de juntar los bytes, entrega cada línea completa apenas llega (stream-json).
    init(_ handle: FileHandle, into col: Collector, alLinea: (@Sendable (String) -> Void)? = nil) {
        self.handle = handle
        self.fd = handle.fileDescriptor
        self.col = col
        self.cortador = alLinea.map { CortadorLineas($0) }
        self.cola = DispatchQueue(label: "hq.pipe.\(handle.fileDescriptor)")
    }

    func empezar() {
        let flags = fcntl(fd, F_GETFL)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        let f = DispatchSource.makeReadSource(fileDescriptor: fd, queue: cola)
        f.setEventHandler { [self] in drenar() }
        f.setCancelHandler { [handle] in try? handle.close() }
        fuente = f
        f.resume()
    }

    /// Lee todo lo disponible. Siempre en `cola`. Cierra al llegar a EOF o a un error.
    private func drenar() {
        guard !cerrado else { return }
        var buf = [UInt8](repeating: 0, count: 65_536)
        while true {
            let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n > 0 { let d = Data(buf[0..<n]); col.append(d); cortador?.agregar(d); continue }
            if n < 0, errno == EINTR { continue }
            if n < 0, errno == EAGAIN || errno == EWOULDBLOCK { return }
            cerrar()  // EOF o error
            return
        }
    }

    private func cerrar() {
        guard !cerrado else { return }
        cerrado = true
        fuente?.cancel()
    }

    /// Última lectura (sin bloquear) y cierre. Un nieto que siga con el pipe abierto no nos retiene.
    func terminar() {
        cola.sync { drenar(); cerrar(); cortador?.terminar() }
    }
}

/// Un proceso en curso: ejecución bloqueante con timeout (terminate -> kill) y cancelación.
final class RunningProcess: @unchecked Sendable {
    private let lock = NSLock()
    private let process = Process()
    private var started = false
    private var cancelled = false
    private(set) var timedOut = false

    func terminate() {
        lock.lock(); defer { lock.unlock() }
        cancelled = true
        if started, process.isRunning {
            let hijos = Self.descendientes(de: process.processIdentifier)
            process.terminate()
            for h in hijos { kill(h, SIGTERM) }
        }
    }

    func forceKill() {
        lock.lock(); defer { lock.unlock() }
        if started, process.isRunning {
            let hijos = Self.descendientes(de: process.processIdentifier)
            kill(process.processIdentifier, SIGKILL)
            for h in hijos { kill(h, SIGKILL) }
        }
    }

    /// pids descendientes de `pid` (claude lanza herramientas como hijos). Best effort con `ps`.
    static func descendientes(de pid: Int32) -> [Int32] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/ps")
        p.arguments = ["-axo", "pid=,ppid="]
        let o = Pipe()
        p.standardOutput = o
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return [] }
        let data = o.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        var hijosDe: [Int32: [Int32]] = [:]
        for l in String(decoding: data, as: UTF8.self).split(separator: "\n") {
            let c = l.split(separator: " ").compactMap { Int32($0) }
            if c.count == 2 { hijosDe[c[1], default: []].append(c[0]) }
        }
        var out: [Int32] = [], pend = [pid]
        while let x = pend.popLast() { for h in hijosDe[x] ?? [] { out.append(h); pend.append(h) } }
        return out
    }

    var isRunning: Bool { lock.lock(); defer { lock.unlock() }; return started && process.isRunning }

    /// Bloquea hasta que el proceso termina. Lanza si no pudo ejecutarse o se canceló antes de arrancar.
    func run(exe: String, args: [String], cwd: String?, env: [String: String], timeout: TimeInterval,
             grace: TimeInterval = 3, alLinea: (@Sendable (String) -> Void)? = nil,
             onStart: () -> Void, onEnd: () -> Void) throws -> ProcResult {
        let out = Pipe(), err = Pipe()
        process.executableURL = URL(fileURLWithPath: exe)
        process.arguments = args
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        process.environment = env
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = out
        process.standardError = err
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }

        lock.lock()
        if cancelled { lock.unlock(); throw CancellationError() }
        do { try process.run() } catch { lock.unlock(); throw error }
        started = true
        lock.unlock()
        onStart()
        defer { onEnd() }
        try? out.fileHandleForWriting.close()
        try? err.fileHandleForWriting.close()
        let so = Collector(), se = Collector()
        let lectores = [LectorPipe(out.fileHandleForReading, into: so, alLinea: alLinea), LectorPipe(err.fileHandleForReading, into: se)]
        for l in lectores { l.empezar() }
        let item = DispatchWorkItem { [self] in
            lock.lock(); timedOut = true; lock.unlock()
            terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + grace) { [self] in forceKill() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: item)
        done.wait()
        item.cancel()
        for l in lectores { l.terminar() }
        lock.lock(); let to = timedOut; lock.unlock()
        return ProcResult(rc: process.terminationStatus,
                          stdout: String(decoding: so.data, as: UTF8.self),
                          stderr: String(decoding: se.data, as: UTF8.self),
                          timedOut: to)
    }
}

/// Procesos vivos (para `shutdown`).
final class ProcessRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var vivos: [ObjectIdentifier: RunningProcess] = [:]
    private(set) var cerrado = false
    func add(_ p: RunningProcess) { lock.lock(); vivos[ObjectIdentifier(p)] = p; lock.unlock() }
    func remove(_ p: RunningProcess) { lock.lock(); vivos[ObjectIdentifier(p)] = nil; lock.unlock() }
    func cerrar() -> [RunningProcess] { lock.lock(); cerrado = true; let v = Array(vivos.values); lock.unlock(); return v }
    var estaCerrado: Bool { lock.lock(); defer { lock.unlock() }; return cerrado }
    var cantidad: Int { lock.lock(); defer { lock.unlock() }; return vivos.count }
}

/// Carriles por clave (creados al pedirlos): una oficina puede tener cualquier cantidad de agentes.
final class LaneRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var lanes: [String: AgentLane] = [:]
    func lane(_ clave: String) -> AgentLane {
        lock.lock(); defer { lock.unlock() }
        if let l = lanes[clave] { return l }
        let l = AgentLane()
        lanes[clave] = l
        return l
    }
}

/// Un carril por agente: serializa las llamadas de ese agente (agentes distintos corren en paralelo).
/// Los actores son reentrantes en cada `await`, por eso hay una cola de espera explícita.
actor AgentLane {
    private var ocupado = false
    private var esperando: [CheckedContinuation<Void, Never>] = []

    func adquirir() async {
        if !ocupado { ocupado = true; return }
        await withCheckedContinuation { esperando.append($0) }
    }

    func liberar() {
        if esperando.isEmpty { ocupado = false } else { esperando.removeFirst().resume() }
    }
}

/// Límite global de procesos claude a la vez (semáforo asíncrono: los que esperan no ocupan hilos).
actor LimiteProcesos {
    let maximo: Int
    private var enUso = 0
    private var esperando: [CheckedContinuation<Void, Never>] = []

    init(maximo: Int) { self.maximo = max(1, maximo) }

    func adquirir() async {
        if enUso < maximo { enUso += 1; return }
        await withCheckedContinuation { esperando.append($0) }  // el cupo se hereda de quien libera
    }

    func liberar() {
        if esperando.isEmpty { enUso -= 1 } else { esperando.removeFirst().resume() }
    }
}

public final class ClaudeRunner: Sendable {
    public let config: Config
    private let resolver: ClaudePathResolver
    private let log: HQLog
    private let lanes = LaneRegistry()
    private let registry = ProcessRegistry()
    private let limite: LimiteProcesos
    /// Qué hace cada agente ahora (lo alimentan los eventos de stream-json de cada corrida).
    public let actividad = ActividadRegistro()
    /// Avisos guardados recién creados -> la app nativa (notificación). Ver Avisos.swift.
    public let canalAvisos = CanalAvisos()
    /// Tope por defecto de procesos claude simultáneos (`HQ_MAX_CLAUDE` lo cambia).
    public static let maxClaudePorDefecto = 8
    /// Gracia entre terminate y kill (segundos).
    let grace: TimeInterval

    public init(config: Config, resolver: ClaudePathResolver, log: HQLog, grace: TimeInterval = 3,
                maxConcurrentes: Int? = nil, env: [String: String] = ProcessInfo.processInfo.environment) {
        let envMax = env["HQ_MAX_CLAUDE"].flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }.flatMap { $0 >= 1 ? $0 : nil }
        limite = LimiteProcesos(maximo: maxConcurrentes ?? envMax ?? Self.maxClaudePorDefecto)
        self.config = config
        self.resolver = resolver
        self.log = log
        self.grace = grace
    }

    public var claudePath: String? { resolver.path() }

    /// Comprobaciones previas (claude y carpeta del proyecto, o `carpeta` de la oficina) sin tocar nada.
    public func verificar(carpeta: String? = nil) throws {
        guard claudePath != nil else { throw ClaudeError.noEncontrado }
        let c = carpeta ?? config.proyecto
        var isDir: ObjCBool = false
        if !FileManager.default.fileExists(atPath: c, isDirectory: &isDir) || !isDir.boolValue {
            throw ClaudeError.sinProyecto(c)
        }
    }

    // MARK: corridas sin chat (borradores, reuniones)

    /// Un `claude -p` SIN agente y SIN herramientas (`--tools ""`): para borradores y síntesis. Devuelve el
    /// texto de `result`. `cwd` = carpeta de la oficina. Lanza `ClaudeError` (timeout, login, etc.).
    /// `modelo`: `--model` (p. ej. "haiku" para resúmenes baratos); nil = el de la cuenta.
    public func correrSinAgente(prompt: String, timeout: TimeInterval? = nil, cwd: String? = nil,
                                modelo: String? = nil, obs: Observador? = nil) async throws -> String {
        try verificar(carpeta: cwd)
        var args = ["-p"] + Self.formatoSalida + ["--tools", ""] + Self.sinConectores
        if let modelo { args += ["--model", modelo] }
        return try await resultado(args + ["--", prompt], timeout: timeout ?? config.timeout, cwd: cwd, obs: obs)
    }

    /// Para corridas sin agente: `dontAsk` (no hereda el `defaultMode` del usuario) y sin conectores de claude.ai (plan §3).
    static let sinConectores = ["--permission-mode", "dontAsk", "--disallowedTools", "mcp__claude_ai_*"]

    /// `--output-format stream-json --verbose`: un evento JSON por línea (actividad en vivo) y el `result` al final.
    public static let formatoSalida = ["--output-format", "stream-json", "--verbose"]

    /// Convierte un observador de eventos en un lector de líneas para `lanzar`.
    static func lector(_ obs: Observador?) -> (@Sendable (String) -> Void)? {
        guard let obs else { return nil }
        return { linea in for e in EventoClaude.parsear(linea) { obs(e) } }
    }

    /// Un turno de `agente` en una sesión nueva (UUID propio), solo con `Read,Glob,Grep` (nada de Edit/Write) y un
    /// prompt arbitrario. Para reuniones: los agentes opinan pero no escriben. Sin carril: usar `conCarril(oficina:agente:)`.
    /// `dirsExtra`: carpetas vinculadas a las que el agente tiene acceso (`Permisos.dirsVinculos`).
    public func turnoSoloLectura(agente: String, prompt: String, cwd: String, timeout: TimeInterval? = nil,
                                 dirsExtra: [String] = [], obs: Observador? = nil,
                                 instrucciones: String? = nil) async throws -> String {
        try verificar(carpeta: cwd)
        var a = ["-p", "--agent", agente, "--session-id", UUID().uuidString.lowercased()] + Self.formatoSalida
            + ["--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk"]
        for d in config.oficinaDirsExtra + dirsExtra { a += ["--add-dir", d] }
        a += ["--allowedTools", "Read", "Glob", "Grep", "--disallowedTools", "mcp__claude_ai_*"]
        if let i = instrucciones, !i.isEmpty { a += ["--append-system-prompt", i] }
        return try await resultado(a + ["--", prompt], timeout: timeout ?? config.timeout, cwd: cwd, obs: obs)
    }

    func resultado(_ args: [String], timeout: TimeInterval, cwd: String?, obs: Observador? = nil,
                   envExtra: [String: String] = [:]) async throws -> String {
        let res = try await lanzar(args: args, timeout: timeout, cwd: cwd, envExtra: envExtra, alLinea: Self.lector(obs))
        if res.timedOut { throw ClaudeError.timeout }
        if registry.estaCerrado { throw ClaudeError.cerrando }
        let c = Corrida(res: res, json: Self.parsearJSON(res.stdout))
        if let e = c.error { throw ClaudeError.clasificar(e) }
        if let r = c.json?["result"] as? String, !r.isEmpty { return r }
        return c.json == nil ? res.stdout.trimmingCharacters(in: .whitespacesAndNewlines) : ""
    }

    /// Ejecuta `body` con el carril del agente tomado.
    public func conCarril<T: Sendable>(_ agente: String, _ body: @Sendable () async throws -> T) async rethrows -> T {
        let lane = lanes.lane(agente)
        await lane.adquirir()
        do {
            let r = try await body()
            await lane.liberar()
            return r
        } catch {
            await lane.liberar()
            throw error
        }
    }

    /// Carril de un agente dentro de una oficina (la clave incluye la carpeta, así dos oficinas con el mismo id no se bloquean).
    public func conCarril<T: Sendable>(oficina: String, agente: String, _ body: @Sendable () async throws -> T) async rethrows -> T {
        try await conCarril(oficina + "\u{1f}" + agente, body)
    }

    /// Un mensaje a un agente (serializado por agente). Devuelve el texto de la respuesta.
    public func enviar(agente: String, mensaje: String, sid: String, activa: Bool) async throws -> String {
        try await conCarril(agente) {
            try await self.ejecutarChat(agente: agente, mensaje: mensaje, sid: sid, activa: activa)
        }
    }

    /// Igual que `enviar` pero sin tomar el carril (el llamador ya lo tiene, ver `conCarril`).
    /// Con `oficina` el agente corre dentro de esa carpeta y con sus permisos de escritura (ver `Permisos.argumentos(oficina:)`).
    /// `obs` recibe los eventos en vivo (herramientas, costo). `envExtra`: variables extra para el proceso.
    public func ejecutarChat(agente: String, mensaje: String, sid: String, activa: Bool,
                             oficina: ContextoOficina? = nil, obs: Observador? = nil,
                             envExtra: [String: String] = [:]) async throws -> String {
        try verificar(carpeta: oficina?.carpeta)
        let flag = activa ? "--resume" : "--session-id"
        var r = try await correr(agente: agente, mensaje: mensaje, sid: sid, flag: flag, oficina: oficina, obs: obs, envExtra: envExtra)
        // si la conversación ya existe (o no existe), probamos la otra forma
        if let e = r.error, e.contains("already in use") {
            r = try await correr(agente: agente, mensaje: mensaje, sid: sid, flag: "--resume", oficina: oficina, obs: obs, envExtra: envExtra)
        } else if let e = r.error, flag == "--resume", e.contains("No conversation") || e.lowercased().contains("not found") {
            r = try await correr(agente: agente, mensaje: mensaje, sid: sid, flag: "--session-id", oficina: oficina, obs: obs, envExtra: envExtra)
        }
        if let e = r.error { throw ClaudeError.clasificar(e) }
        if let res = r.json?["result"] as? String, !res.isEmpty { return res }
        return r.json == nil ? r.res.stdout.trimmingCharacters(in: .whitespacesAndNewlines) : ""
    }

    struct Corrida {
        var res: ProcResult
        var json: [String: Any]?
        /// Texto de error, o nil si fue bien.
        var error: String? {
            if let j = json, (j["is_error"] as? Bool) == true {
                let r = (j["result"] as? String) ?? ""
                return r.isEmpty ? "Error desconocido" : r
            }
            if res.rc != 0 {
                let t = res.stdout.isEmpty ? res.stderr : res.stdout
                return t.isEmpty ? "Error desconocido" : String(t.suffix(600))
            }
            return nil
        }
    }

    private func correr(agente: String, mensaje: String, sid: String, flag: String,
                        oficina: ContextoOficina? = nil, obs: Observador? = nil,
                        envExtra: [String: String] = [:]) async throws -> Corrida {
        let args = oficina.map { Permisos.argumentos(config, oficina: $0, agente: agente, mensaje: mensaje, sid: sid, flag: flag) }
            ?? Permisos.argumentos(config, agente: agente, mensaje: mensaje, sid: sid, flag: flag)
        let entorno = envExtra.merging(oficina.map(Permisos.entorno) ?? [:]) { a, _ in a }
        let res = try await lanzar(args: args, timeout: config.timeout, cwd: oficina?.carpeta, envExtra: entorno, alLinea: Self.lector(obs))
        if res.timedOut { throw ClaudeError.timeout }
        if registry.estaCerrado { throw ClaudeError.cerrando }
        return Corrida(res: res, json: Self.parsearJSON(res.stdout))
    }

    /// stdout completo como objeto JSON; si hay ruido antes, la última línea que lo sea.
    static func parsearJSON(_ s: String) -> [String: Any]? {
        func obj(_ t: String) -> [String: Any]? {
            guard let d = t.data(using: .utf8) else { return nil }
            return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
        }
        if let o = obj(s) { return o }
        for l in s.split(separator: "\n").reversed() { if let o = obj(String(l)) { return o } }
        return nil
    }

    /// `claude auth status`. true = sesión iniciada, false = no, nil = no se pudo saber (sin claude / timeout).
    public func authStatus(timeout: TimeInterval = 30) async -> Bool? {
        guard claudePath != nil else { return nil }
        do {
            let r = try await lanzar(args: ["auth", "status"], timeout: timeout)
            if r.timedOut { log.warn("claude auth status: tiempo agotado"); return nil }
            log.info("auth_status rc=\(r.rc)")
            return r.rc == 0
        } catch {
            log.error("claude no se pudo ejecutar (auth status)")
            return nil
        }
    }

    /// Lanza claude con `args` y espera. Mapea fallos de arranque a `.noEjecuta`.
    /// `envExtra` se suma al entorno del hijo (p. ej. el token del servidor MCP); `alLinea` recibe stdout línea a línea.
    func lanzar(args: [String], timeout: TimeInterval, cwd cwdPedido: String? = nil, envExtra: [String: String] = [:],
                alLinea: (@Sendable (String) -> Void)? = nil) async throws -> ProcResult {
        guard let exe = claudePath else { throw ClaudeError.noEncontrado }
        if registry.estaCerrado { throw ClaudeError.cerrando }
        var isDir: ObjCBool = false
        let base = cwdPedido ?? config.proyecto
        let cwd = FileManager.default.fileExists(atPath: base, isDirectory: &isDir) && isDir.boolValue ? base : nil
        let env = ClaudeLocator.childEnvironment(claude: exe, home: config.home).merging(envExtra) { _, b in b }
        let rp = RunningProcess()
        let reg = registry
        let grace = self.grace
        let limite = self.limite
        return try await withTaskCancellationHandler {
            await limite.adquirir()
            let resultado: Result<ProcResult, Error>
            if reg.estaCerrado {
                resultado = .failure(ClaudeError.cerrando)
            } else {
                do {
                    resultado = .success(try await withCheckedThrowingContinuation { (cont: CheckedContinuation<ProcResult, Error>) in
                        DispatchQueue.global().async {
                            do {
                                let r = try rp.run(exe: exe, args: args, cwd: cwd, env: env, timeout: timeout, grace: grace,
                                                   alLinea: alLinea, onStart: { reg.add(rp) }, onEnd: { reg.remove(rp) })
                                cont.resume(returning: r)
                            } catch is CancellationError {
                                cont.resume(throwing: CancellationError())
                            } catch {
                                cont.resume(throwing: ClaudeError.noEjecuta(String(describing: type(of: error))))
                            }
                        }
                    })
                } catch { resultado = .failure(error) }
            }
            await limite.liberar()
            return try resultado.get()
        } onCancel: {
            rp.terminate()
        }
    }

    /// Mata los claude en curso: terminate y, si no responden en `grace`, kill.
    public func shutdown() async {
        let vivos = registry.cerrar()
        guard !vivos.isEmpty else { return }
        for p in vivos { p.terminate() }
        let limite = Date().addingTimeInterval(grace)
        while Date() < limite, vivos.contains(where: { $0.isRunning }) {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        for p in vivos where p.isRunning { p.forceKill() }
        log.info("shutdown: \(vivos.count) proceso(s) terminados")
    }

    /// Procesos claude vivos ahora (tests).
    public var procesosVivos: Int { registry.cantidad }
}
