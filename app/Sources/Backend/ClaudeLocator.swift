import Foundation

/// Encuentra el binario de `claude` y arma el entorno para los procesos hijos.
public enum ClaudeLocator {
    /// Orden: CLAUDE_BIN, `explicito` (config), rutas conocidas, app de Claude en Application Support
    /// (la más nueva) y, último recurso, `$SHELL -ilc 'command -v claude'` (con timeout, solo si `usarShell`).
    public static func locate(explicito: String? = nil,
                              env: [String: String] = ProcessInfo.processInfo.environment,
                              home: String = NSHomeDirectory(),
                              usarShell: Bool = true) -> String? {
        let fm = FileManager.default
        func ejecutable(_ p: String) -> Bool { fm.isExecutableFile(atPath: p) }
        if let b = env["CLAUDE_BIN"], !b.isEmpty { return b }
        if let e = explicito, !e.isEmpty { return e }
        let fijas = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude",
                     (home as NSString).appendingPathComponent(".local/bin/claude"),
                     (home as NSString).appendingPathComponent(".claude/local/claude")]
        for p in fijas where ejecutable(p) { return p }
        if let p = appBundled(home: home) { return p }
        if usarShell, let p = desdeShell() { return p }
        return nil
    }

    /// ~/Library/Application Support/Claude/claude-code/<a>/<b>/claude.app/Contents/MacOS/claude, el más nuevo.
    static func appBundled(home: String) -> String? {
        let fm = FileManager.default
        let base = (home as NSString).appendingPathComponent("Library/Application Support/Claude/claude-code")
        var candidatos: [(String, Date)] = []
        for a in (try? fm.contentsOfDirectory(atPath: base)) ?? [] {
            for b in (try? fm.contentsOfDirectory(atPath: "\(base)/\(a)")) ?? [] {
                let p = "\(base)/\(a)/\(b)/claude.app/Contents/MacOS/claude"
                guard fm.isExecutableFile(atPath: p) else { continue }
                let m = (try? fm.attributesOfItem(atPath: p)[.modificationDate] as? Date) ?? .distantPast
                candidatos.append((p, m))
            }
        }
        return candidatos.max(by: { $0.1 < $1.1 })?.0
    }

    static let marcaInicio = "__HQ_CLAUDE_S__", marcaFin = "__HQ_CLAUDE_E__"

    /// Shell de login *interactivo* (`-ilc`): el PATH que agregan nvm, el instalador de claude, etc. suele
    /// estar en `.zshrc`, que un shell solo de login (`-lc`) no lee. El resultado va entre marcadores porque
    /// los rc interactivos imprimen ruido (banners, avisos de job control).
    static func argumentosShell() -> [String] {
        ["-ilc", "printf '\(marcaInicio)%s\(marcaFin)' \"$(command -v claude)\""]
    }

    /// Extrae la ruta de la salida del shell: lo que está entre los marcadores, si es absoluta.
    static func rutaDeSalida(_ s: String) -> String? {
        guard let a = s.range(of: marcaInicio), let b = s.range(of: marcaFin, range: a.upperBound..<s.endIndex) else { return nil }
        let ruta = s[a.upperBound..<b.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
        return ruta.hasPrefix("/") ? ruta : nil
    }

    /// `$SHELL -ilc` (o `/bin/zsh`) con timeout, stdin cerrado.
    static func desdeShell(timeout: TimeInterval = 5,
                           env: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        let p = Process()
        let shell = env["SHELL"].flatMap { FileManager.default.isExecutableFile(atPath: $0) ? $0 : nil } ?? "/bin/zsh"
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = argumentosShell()
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in done.signal() }
        do { try p.run() } catch { return nil }
        let leido = Collector()
        let g = DispatchGroup()
        g.enter()
        DispatchQueue.global().async {
            while true {
                let d = out.fileHandleForReading.availableData
                if d.isEmpty { break }
                leido.append(d)
            }
            g.leave()
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            p.terminate()
            _ = done.wait(timeout: .now() + 2)
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            return nil
        }
        _ = g.wait(timeout: .now() + 2)
        guard let ruta = rutaDeSalida(String(decoding: leido.data, as: UTF8.self)),
              FileManager.default.isExecutableFile(atPath: ruta) else { return nil }
        return ruta
    }

    /// PATH razonable para el hijo: dir de claude, node (nvm/volta/asdf/fnm), homebrew, sistema y el PATH heredado.
    public static func childPath(claude: String?, env: [String: String] = ProcessInfo.processInfo.environment,
                                 home: String = NSHomeDirectory()) -> String {
        let fm = FileManager.default
        var dirs: [String] = []
        if let c = claude { dirs.append((c as NSString).deletingLastPathComponent) }
        dirs += [(home as NSString).appendingPathComponent(".local/bin"),
                 "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
        let nvm = (home as NSString).appendingPathComponent(".nvm/versions/node")
        let versiones = ((try? fm.contentsOfDirectory(atPath: nvm)) ?? []).sorted { $0.compare($1, options: .numeric) == .orderedDescending }
        dirs += versiones.map { "\(nvm)/\($0)/bin" }
        dirs += [(home as NSString).appendingPathComponent(".volta/bin"),
                 (home as NSString).appendingPathComponent(".asdf/shims"),
                 (home as NSString).appendingPathComponent(".fnm/aliases/default/bin"),
                 "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        dirs += (env["PATH"] ?? "").split(separator: ":").map(String.init)
        var visto = Set<String>()
        return dirs.filter { !$0.isEmpty && visto.insert($0).inserted }.joined(separator: ":")
    }

    /// Entorno del proceso hijo: el heredado con PATH ampliado y sin variables que confundan a un claude anidado.
    public static func childEnvironment(claude: String?, env: [String: String] = ProcessInfo.processInfo.environment,
                                        home: String = NSHomeDirectory()) -> [String: String] {
        var e = env
        e["PATH"] = childPath(claude: claude, env: env, home: home)
        if e["HOME"] == nil { e["HOME"] = home }
        for k in e.keys where heredadaDeSesion(k) { e.removeValue(forKey: k) }
        return e
    }

    /// Variables `CLAUDE_CODE_*` que el usuario pone a propósito (proveedor, auth, límites): se conservan.
    static let configDeUsuario: Set<String> = [
        "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
        "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_SUBAGENT_MODEL",
    ]

    /// ¿Es una variable que inyecta una sesión de Claude Code a sus procesos hijos? Si la app (o el server de
    /// desarrollo) se lanzó desde una sesión, el `claude` hijo las hereda y se comporta como sesión anidada:
    /// entre otras cosas no guarda el transcript. Se conservan `CLAUDE_CODE_USE_*` / `CLAUDE_CODE_SKIP_*`
    /// (Bedrock, Vertex…) y `configDeUsuario`.
    static func heredadaDeSesion(_ k: String) -> Bool {
        if ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"].contains(k) || k.hasPrefix("CLAUDE_AGENT_SDK_") { return true }
        guard k.hasPrefix("CLAUDE_CODE_") else { return false }
        if k.hasPrefix("CLAUDE_CODE_USE_") || k.hasPrefix("CLAUDE_CODE_SKIP_") { return false }
        return !configDeUsuario.contains(k)
    }
}

/// Buffer de bytes protegido con lock (lectura de pipes en otros hilos).
final class Collector: @unchecked Sendable {
    private let lock = NSLock()
    private var buf = Data()
    func append(_ d: Data) { lock.lock(); buf.append(d); lock.unlock() }
    var data: Data { lock.lock(); defer { lock.unlock() }; return buf }
}

/// Resuelve (y cachea) la ruta de claude. Si no está, reintenta barato en cada consulta
/// (el usuario puede instalarlo con la app abierta) y el shell de login como máximo cada 30 s.
public final class ClaudePathResolver: @unchecked Sendable {
    private let lock = NSLock()
    private var cache: String?
    private var ultimoShell = Date.distantPast
    private let fijo: String?
    private let explicito: String?
    private let env: [String: String]
    private let home: String

    /// `fijo`: ruta forzada (tests/inyección), sin búsqueda.
    public init(fijo: String? = nil, explicito: String? = nil,
                env: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) {
        self.fijo = fijo; self.explicito = explicito; self.env = env; self.home = home
    }

    public func path() -> String? {
        if let f = fijo { return f }
        lock.lock()
        if let c = cache, FileManager.default.isExecutableFile(atPath: c) || env["CLAUDE_BIN"] != nil {
            lock.unlock(); return c
        }
        let shell = Date().timeIntervalSince(ultimoShell) > 30
        if shell { ultimoShell = Date() }
        lock.unlock()
        let r = ClaudeLocator.locate(explicito: explicito, env: env, home: home, usarShell: shell)
        lock.lock(); cache = r; lock.unlock()
        return r
    }
}
