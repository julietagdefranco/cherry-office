import Foundation

// Programador de tareas (Fase 5): cada 30 s mira las tareas de la oficina activa y corre las que tocan, cada una como un
// chat del agente (carril, permisos y costo normales) en una sesión nueva. El estado vive en SQLite (`ejecuciones`).
// Misma lógica y mismas tablas que tools/hq_tareas.py (modo desarrollo).

// MARK: - ejecución (una corrida de una tarea)

public struct Ejecucion: Sendable, Equatable {
    public var id: Int64
    public var oficina: String
    public var tarea: String
    public var agente: String
    /// Horario programado que se cumple (epoch). En una corrida manual es el instante de inicio.
    public var programada: Double
    public var inicio: Double
    public var fin: Double?
    /// corriendo | ok | error
    public var estado: String
    /// Sesión de chat donde quedó el pedido y la respuesta (se abre desde la pestaña de conversación del agente).
    public var sid: String
    /// Respuesta del agente, recortada.
    public var resultado: String
    public var error: String?
    public var costo: Double?
    /// «Probar ahora»: no cuenta como la corrida programada de ese día.
    public var manual: Bool

    public var json: [String: Any] {
        var o: [String: Any] = ["id": id, "tarea": tarea, "agente": agente, "programada": ReunionesRouter.iso(programada),
                                "inicio": ReunionesRouter.iso(inicio), "estado": estado, "sid": sid, "resultado": resultado,
                                "manual": manual]
        o["fin"] = fin.map { ReunionesRouter.iso($0) as Any } ?? NSNull()
        o["error"] = error.map { $0 as Any } ?? NSNull()
        o["costo"] = costo.map { $0 as Any } ?? NSNull()
        return o
    }
}

// MARK: - SQLite (tabla `ejecuciones`, con clave de oficina)

extension Store {
    static let maxResultado = 2000

    /// Crea la tabla si falta y pasa a `error` las ejecuciones que quedaron «corriendo» (la app se cerró en el medio).
    func prepararEjecuciones() throws {
        try db.exec("""
        CREATE TABLE IF NOT EXISTS ejecuciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            oficina TEXT NOT NULL,
            tarea TEXT NOT NULL,
            agente TEXT NOT NULL,
            programada REAL NOT NULL,
            inicio REAL NOT NULL,
            fin REAL,
            estado TEXT NOT NULL,
            sid TEXT NOT NULL DEFAULT '',
            resultado TEXT NOT NULL DEFAULT '',
            error TEXT,
            costo REAL,
            manual INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS ejecuciones_tarea ON ejecuciones(oficina, tarea, id);
        """)
        try db.run("UPDATE ejecuciones SET estado='error', error=?, fin=? WHERE estado='corriendo'",
                   [.text("Interrumpida: la app se cerró mientras corría."), .double(Date().timeIntervalSince1970)])
    }

    func nuevaEjecucion(oficina: String, tarea: String, agente: String, programada: Double, inicio: Double,
                        sid: String, manual: Bool) throws -> Int64 {
        try db.run("""
            INSERT INTO ejecuciones(oficina,tarea,agente,programada,inicio,estado,sid,manual) VALUES(?,?,?,?,?,'corriendo',?,?)
            """, [.text(oficina), .text(tarea), .text(agente), .double(programada), .double(inicio), .text(sid), .int(manual ? 1 : 0)])
        return try db.query("SELECT last_insert_rowid()") { $0.int(0) }.first ?? 0
    }

    func terminarEjecucion(_ id: Int64, estado: String, resultado: String, error: String?, costo: Double?) throws {
        try db.run("UPDATE ejecuciones SET estado=?, fin=?, resultado=?, error=?, costo=? WHERE id=?",
                   [.text(estado), .double(Date().timeIntervalSince1970), .text(String(resultado.prefix(Store.maxResultado))),
                    error.map { .text($0) } ?? .null, costo.map { .double($0) } ?? .null, .int(id)])
    }

    private static let columnasEjecucion = "id,oficina,tarea,agente,programada,inicio,fin,estado,sid,resultado,error,costo,manual"

    private static func ejecucion(_ r: SQLRow) -> Ejecucion {
        Ejecucion(id: r.int(0), oficina: r.text(1), tarea: r.text(2), agente: r.text(3), programada: r.double(4), inicio: r.double(5),
                  fin: r.isNull(6) ? nil : r.double(6), estado: r.text(7), sid: r.text(8), resultado: r.text(9),
                  error: r.isNull(10) ? nil : r.text(10), costo: r.isNull(11) ? nil : r.double(11), manual: r.int(12) != 0)
    }

    func ejecucion(_ id: Int64) -> Ejecucion? {
        (try? db.query("SELECT \(Store.columnasEjecucion) FROM ejecuciones WHERE id=?", [.int(id)], Store.ejecucion))?.first
    }

    /// Últimas `limite` ejecuciones de una tarea, de la más nueva a la más vieja.
    func ejecuciones(oficina: String, tarea: String, limite: Int = 20) -> [Ejecucion] {
        (try? db.query("SELECT \(Store.columnasEjecucion) FROM ejecuciones WHERE oficina=? AND tarea=? ORDER BY id DESC LIMIT ?",
                       [.text(oficina), .text(tarea), .int(Int64(limite))], Store.ejecucion)) ?? []
    }

    func ultimaEjecucion(oficina: String, tarea: String) -> Ejecucion? { ejecuciones(oficina: oficina, tarea: tarea, limite: 1).first }

    /// Última corrida programada (no manual) de la tarea, en cualquier estado: con ella no se repite la misma programada.
    func ultimaProgramada(oficina: String, tarea: String) -> Double? {
        (try? db.query("SELECT MAX(programada) FROM ejecuciones WHERE oficina=? AND tarea=? AND manual=0",
                       [.text(oficina), .text(tarea)]) { $0.isNull(0) ? nil : $0.double(0) })?.first ?? nil
    }

    func borrarEjecuciones(oficina: String, tarea: String) throws {
        try db.run("DELETE FROM ejecuciones WHERE oficina=? AND tarea=?", [.text(oficina), .text(tarea)])
    }
}

// MARK: - programador

public actor Programador {
    /// Cada cuánto revisa las tareas (HQ_PROGRAMADOR_INTERVALO en segundos, para pruebas).
    public static let intervaloPorDefecto: TimeInterval = 30

    private let store: Store
    private let runner: ClaudeRunner
    private let oficinas: Oficinas
    private let config: Config
    private let log: HQLog
    private let intervalo: TimeInterval
    private let automatico: Bool
    private let sistema: TimeZone
    private var reloj: @Sendable () -> Date = { Date() }
    private var gancho: @Sendable (Ejecucion) async -> Void = { _ in }
    private var preparado = false
    private var cerrado = false
    private var revisando = false
    private var bucle: Task<Void, Never>?
    /// `oficina \u{1f} tarea` de las que corren (o están por correr) ahora: evita dos corridas de la misma tarea a la vez.
    private var reservadas = Set<String>()
    private var corridas: [Int64: Task<Void, Never>] = [:]

    /// `env["HQ_PROGRAMADOR"] == "0"` deja el bucle apagado (los tests llaman a `revisar()` a mano).
    init(store: Store, runner: ClaudeRunner, oficinas: Oficinas, config: Config, log: HQLog,
         env: [String: String] = ProcessInfo.processInfo.environment, sistema: TimeZone = .current) {
        self.store = store; self.runner = runner; self.oficinas = oficinas; self.config = config; self.log = log
        self.sistema = sistema
        automatico = env["HQ_PROGRAMADOR"] != "0"
        intervalo = env["HQ_PROGRAMADOR_INTERVALO"].flatMap(Double.init).flatMap { $0 > 0 ? $0 : nil } ?? Programador.intervaloPorDefecto
    }

    /// Hook para avisos y notificaciones: se llama cuando una ejecución termina (ok o error), con la fila ya guardada.
    /// Por defecto no hace nada. Se llama también para las corridas de «Probar ahora». No debe bloquear mucho: corre en la
    /// tarea de la ejecución, después de guardarla y de liberar el carril del agente.
    public func alTerminar(_ f: @escaping @Sendable (Ejecucion) async -> Void) { gancho = f }

    /// Reloj inyectable (tests).
    func fijarReloj(_ r: @escaping @Sendable () -> Date) { reloj = r }

    // MARK: ciclo de vida

    /// Arranca el bucle de revisión (lo llama el Backend al iniciar). Idempotente.
    public func iniciar() {
        guard automatico, bucle == nil, !cerrado else { return }
        let t = intervalo
        bucle = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.revisar()
                try? await Task.sleep(nanoseconds: UInt64(t * 1_000_000_000))
            }
        }
    }

    /// Deja de revisar y de aceptar corridas nuevas (las en curso terminan solas; ver `esperar`).
    public func detener() {
        cerrado = true
        bucle?.cancel()
        bucle = nil
    }

    /// Espera (hasta `limite` segundos) a que terminen las corridas en curso, para que guarden su estado antes de cerrar la base.
    public func esperar(limite: TimeInterval = 5) async {
        let tareas = Array(corridas.values)
        guard !tareas.isEmpty else { return }
        await withTaskGroup(of: Void.self) { g in
            g.addTask { for t in tareas { await t.value } }
            g.addTask { try? await Task.sleep(nanoseconds: UInt64(limite * 1_000_000_000)) }
            _ = await g.next()
            g.cancelAll()
        }
    }

    /// Crea la tabla y marca las interrumpidas, una sola vez por proceso y antes de cualquier corrida.
    func preparar() async {
        if preparado { return }
        do { try await store.prepararEjecuciones(); preparado = true }
        catch { log.error("tareas: no pude preparar la tabla de ejecuciones") }
    }

    // MARK: revisión

    static func clave(_ oficina: String, _ tarea: String) -> String { oficina + "\u{1f}" + tarea }

    func estaCorriendo(oficina: String, tarea: String) -> Bool { reservadas.contains(Programador.clave(oficina, tarea)) }

    /// Una vuelta: corre las tareas activas de la oficina activa que tocan según `Programacion.debeCorrer`.
    func revisar() async {
        guard !cerrado, !revisando else { return }
        revisando = true
        defer { revisando = false }
        await preparar()
        guard preparado, let act = await oficinas.activa() else { return }
        let ahora = reloj()
        for t in act.oficina.tareas ?? [] where t.activa {
            guard let def = act.oficina.agente(t.agente), !estaCorriendo(oficina: act.carpeta, tarea: t.id) else { continue }
            let ult = await store.ultimaProgramada(oficina: act.carpeta, tarea: t.id).map { Date(timeIntervalSince1970: $0) }
            guard let p = Programacion.debeCorrer(t, ahora: ahora, ultimaProgramada: ult, sistema: sistema) else { continue }
            if (try? await lanzar(act, t, def, programada: p, manual: false)) != nil {
                log.info("tarea \(t.id) agente=\(def.id) programada=\(Programacion.iso(p))")
            }
        }
    }

    /// «Probar ahora»: crea la ejecución y devuelve enseguida (la corrida sigue en segundo plano).
    func correrAhora(_ act: OficinaActiva, _ t: TareaProgramada, _ def: AgenteDef) async throws -> Ejecucion {
        do { try runner.verificar(carpeta: act.carpeta) } catch let e as ClaudeError { throw ErrorAPI(500, e.mensaje) }
        await preparar()
        return try await lanzar(act, t, def, programada: Date(), manual: true)
    }

    // MARK: corrida

    private func lanzar(_ act: OficinaActiva, _ t: TareaProgramada, _ def: AgenteDef, programada: Date, manual: Bool) async throws -> Ejecucion {
        guard !cerrado else { throw ErrorAPI(409, "La app se está cerrando.") }
        let clave = Programador.clave(act.carpeta, t.id)
        guard reservadas.insert(clave).inserted else { throw ErrorAPI(409, "Esa tarea ya se está corriendo.") }
        let sid = UUID().uuidString.lowercased()
        let inicio = Date().timeIntervalSince1970
        let id: Int64
        do {
            id = try await store.nuevaEjecucion(oficina: act.carpeta, tarea: t.id, agente: def.id, programada: programada.timeIntervalSince1970,
                                                inicio: inicio, sid: sid, manual: manual)
        } catch {
            reservadas.remove(clave)
            throw ErrorAPI(500, "No pude guardar la ejecución.")
        }
        let ej = Ejecucion(id: id, oficina: act.carpeta, tarea: t.id, agente: def.id, programada: programada.timeIntervalSince1970,
                           inicio: inicio, fin: nil, estado: "corriendo", sid: sid, resultado: "", error: nil, costo: nil, manual: manual)
        corridas[id] = Task { [self] in
            await correr(ej, act, t, def)
            termino(id, clave)
        }
        return ej
    }

    private func termino(_ id: Int64, _ clave: String) {
        corridas[id] = nil
        reservadas.remove(clave)
    }

    /// Lo mismo que `Router.chat`: carril del agente, permisos de la oficina, actividad (origen «tarea») y costo (origen «tarea»,
    /// ref = id de la tarea), en una sesión nueva donde quedan el pedido y la respuesta como un chat más.
    private func correr(_ ej: Ejecucion, _ act: OficinaActiva, _ t: TareaProgramada, _ def: AgenteDef) async {
        let store = self.store, runner = self.runner
        let ctx = Permisos.contexto(act, agente: def, dirsExtra: config.oficinaDirsExtra)
        let carpeta = act.carpeta, agente = def.id, sid = ej.sid, consigna = t.consigna, nombre = t.nombre
        let caja = CajaCosto()
        struct Resultado: Sendable { var texto: String; var error: String? }
        let r: Resultado = await runner.conCarril(oficina: carpeta, agente: agente) {
            do {
                try await store.asegurarSesion(sid, agente: agente, oficina: carpeta)
                try await store.agregar(sid: sid, rol: "u", texto: consigna)
                let texto = try await runner.actividad.seguir(oficina: carpeta, agente: agente, origen: "tarea", tarea: nombre,
                                                              extra: caja.observador()) { obs, _ in
                    try await runner.ejecutarChat(agente: agente, mensaje: consigna, sid: sid, activa: false, oficina: ctx, obs: obs)
                }
                try await store.marcarActiva(sid)
                try await store.agregar(sid: sid, rol: "a", texto: texto.isEmpty ? "(sin respuesta)" : texto)
                return Resultado(texto: texto.isEmpty ? "(sin respuesta)" : texto, error: nil)
            } catch let e as ClaudeError {
                try? await store.agregar(sid: sid, rol: "a", texto: "No pude responder: " + e.mensaje, error: true)
                return Resultado(texto: "", error: e.mensaje)
            } catch {
                let m = "No pude guardar la conversación."
                try? await store.agregar(sid: sid, rol: "a", texto: "No pude responder: " + m, error: true)
                return Resultado(texto: "", error: m)
            }
        }
        await store.registrarCosto(oficina: carpeta, agente: agente, origen: "tarea", ref: ej.tarea, costo: caja.valor)
        try? await store.terminarEjecucion(ej.id, estado: r.error == nil ? "ok" : "error", resultado: r.texto, error: r.error, costo: caja.valor)
        log.info("tarea \(ej.tarea) agente=\(agente) estado=\(r.error == nil ? "ok" : "error")")
        if let fin = await store.ejecucion(ej.id) { await gancho(fin) }
    }
}
