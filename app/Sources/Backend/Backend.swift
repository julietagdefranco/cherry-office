import Foundation

/// Backend de Próspera HQ: router de `/api/*`, ejecución de `claude`, SQLite y migración.
public final class Backend: Sendable {
    public let config: Config
    public let store: Store
    public let runner: ClaudeRunner
    public let log: HQLog
    /// Oficina activa, recientes y todas las escrituras de `oficina.json` (agentes, departamentos).
    public let oficinas: Oficinas
    private let apiRouter: Router
    private let migracion: Task<Migracion.Resultado, Never>

    public var router: APIHandler { apiRouter }

    /// Registra el enrutador de `/api/reuniones*` (lo hace la parte de reuniones al arrancar).
    public func registrarReuniones(_ r: SubRouter) { apiRouter.subrouters.reuniones = r }

    /// Registra el enrutador de `/api/archivos*`, `/api/vinculos*` y `/api/biblioteca*` (biblioteca de la oficina).
    public func registrarBiblioteca(_ r: SubRouter) { apiRouter.subrouters.biblioteca = r }

    /// Registra el enrutador de `/api/fs/carpetas` y `/api/oficina/archivo*` (explorador de carpetas y de la oficina).
    public func registrarExplorador(_ r: SubRouter) { apiRouter.subrouters.explorador = r }

    /// Configuración real: defaults + config.json + entorno, datos en ~/Library/Application Support/Próspera HQ.
    public static func makeDefault() throws -> Backend {
        var cfg = Config.load()
        if let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String, !v.isEmpty { cfg.version = v }
        return try Backend(config: cfg)
    }

    /// Inyección para tests: `dataDir` pisa `config.datosDir`; `claudePath` fija el binario (sin búsqueda).
    public init(config: Config, dataDir: String? = nil, claudePath: String? = nil,
                env: [String: String] = ProcessInfo.processInfo.environment) throws {
        var cfg = config
        if let d = dataDir { cfg.datosDir = d }
        self.config = cfg
        let log = HQLog(dir: cfg.datosDir)
        self.log = log
        store = try Store(path: (cfg.datosDir as NSString).appendingPathComponent("hq.db"))
        let resolver = ClaudePathResolver(fijo: claudePath, explicito: cfg.claudeBin, env: env, home: cfg.home)
        let runner = ClaudeRunner(config: cfg, resolver: resolver, log: log)
        self.runner = runner
        let store = self.store
        let mig = Task { await Migracion.ejecutar(store: store, config: cfg, log: log, env: env) }
        migracion = mig
        let oficinas = Oficinas(config: cfg, log: log)
        self.oficinas = oficinas
        apiRouter = Router(config: cfg, store: store, runner: runner, log: log, oficinas: oficinas, listo: { _ = await mig.value })
        registrarReuniones(ReunionesRouter(store: store, runner: runner, oficinas: oficinas, log: log, env: env))
        registrarBiblioteca(BibliotecaRouter(store: store, runner: runner, oficinas: oficinas, log: log, env: env))
        registrarExplorador(ExploradorRouter(config: cfg, oficinas: oficinas, log: log))
        log.info("arranque oficinasDir=\(cfg.oficinasDir) claude=\(runner.claudePath ?? "no")")
        // chequeo de arranque, sin bloquear
        Task.detached { _ = await runner.authStatus(timeout: 30) }
    }

    /// Espera a que termine la migración inicial (tests).
    @discardableResult
    public func esperarMigracion() async -> Migracion.Resultado { await migracion.value }

    /// Mata los claude en curso y cierra la base. Llamar al cerrar la ventana o con ⌘Q.
    public func shutdown() async {
        await runner.shutdown()
        await store.close()
        log.info("shutdown")
        log.flush()
    }
}
