import Foundation

/// Encuentra el binario de `claude` y arma el entorno para los procesos hijos.
public enum ClaudeLocator {
    /// Orden: CLAUDE_BIN, `explicito` (config), rutas conocidas, app de Claude en Application Support
    /// (la más nueva) y, último recurso, `zsh -lc 'command -v claude'` (con timeout, solo si `usarShell`).
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

    /// `/bin/zsh -lc 'command -v claude'` con timeout. Usa el PATH del shell de login (nvm, etc.).
    static func desdeShell(timeout: TimeInterval = 5) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "command -v claude"]
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
        let s = String(decoding: leido.data, as: UTF8.self)
        // un .zshrc puede imprimir ruido: nos quedamos con la última línea que sea ruta absoluta
        let ruta = s.split(separator: "\n").map(String.init).last { $0.hasPrefix("/") }
        guard let ruta, FileManager.default.isExecutableFile(atPath: ruta) else { return nil }
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
        e.removeValue(forKey: "CLAUDECODE")
        return e
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
