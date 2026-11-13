import Foundation

public struct Mensaje: Sendable, Equatable {
    /// "u" (usuario) o "a" (agente)
    public var r: String
    public var t: String
    public var e: Bool
    public init(r: String, t: String, e: Bool = false) { self.r = r; self.t = t; self.e = e }
}

/// Lote para importar (migración): sesiones y mensajes con su timestamp original.
struct LoteImportacion: Sendable {
    struct Sesion: Sendable { var sid: String; var agente: String; var activa: Bool; var creada: Double }
    struct Msg: Sendable { var sid: String; var r: String; var t: String; var e: Bool; var ts: Double }
    var sesiones: [Sesion] = []
    var mensajes: [Msg] = []
}

/// SQLite en `hq.db` (WAL). Acceso serializado por ser actor.
public actor Store {
    /// Interno: otras partes del módulo (reuniones) agregan sus tablas sobre la misma base.
    let db: SQLiteDB

    public init(path: String) throws {
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent,
                                                withIntermediateDirectories: true)
        db = try SQLiteDB(path: path)
        _ = try db.query("PRAGMA journal_mode=WAL") { $0.text(0) }
        try db.exec("PRAGMA synchronous=NORMAL")
        try db.exec("PRAGMA foreign_keys=ON")
        try db.exec("""
        CREATE TABLE IF NOT EXISTS sesiones (
            id TEXT PRIMARY KEY,
            agente TEXT NOT NULL,
            creada REAL NOT NULL,
            activa INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS mensajes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sid TEXT NOT NULL REFERENCES sesiones(id),
            rol TEXT NOT NULL,
            texto TEXT NOT NULL,
            error INTEGER NOT NULL DEFAULT 0,
            ts REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mensajes_sid ON mensajes(sid, id);
        CREATE INDEX IF NOT EXISTS sesiones_agente ON sesiones(agente);
        CREATE TABLE IF NOT EXISTS meta (
            clave TEXT PRIMARY KEY,
            valor TEXT NOT NULL
        );
        """)
        try Store.migrarEsquema(db)
    }

    /// Migraciones de esquema sin perder datos. v2: `sesiones.oficina` (carpeta de la oficina; '' = chats
    /// anteriores a las oficinas, que se reclaman al importar Próspera).
    private static func migrarEsquema(_ db: SQLiteDB) throws {
        let cols = try db.query("PRAGMA table_info(sesiones)") { $0.text(1) }
        if !cols.contains("oficina") {
            try db.exec("ALTER TABLE sesiones ADD COLUMN oficina TEXT NOT NULL DEFAULT ''")
        }
        try db.exec("CREATE INDEX IF NOT EXISTS sesiones_oficina ON sesiones(oficina, agente)")
        // v3: costo estimado de cada corrida de claude (`total_cost_usd`), de cualquier origen.
        try db.exec("""
        CREATE TABLE IF NOT EXISTS costos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            oficina TEXT NOT NULL,
            agente TEXT NOT NULL DEFAULT '',
            origen TEXT NOT NULL,
            ref TEXT NOT NULL DEFAULT '',
            costo REAL NOT NULL,
            ts REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS costos_oficina ON costos(oficina, ts);
        """)
    }

    // MARK: costos

    /// Guarda el costo estimado de una corrida. `agente` '' = sin agente (síntesis, fichas, resúmenes).
    /// `origen`: chat | reunion | sintesis | biblioteca | tarea | consulta | resumen. `ref`: sesión, reunión, tarea…
    public func registrarCosto(oficina: String, agente: String = "", origen: String, ref: String = "", costo: Double?) {
        guard let costo, costo > 0, costo.isFinite else { return }
        _ = try? db.run("INSERT INTO costos(oficina,agente,origen,ref,costo,ts) VALUES(?,?,?,?,?,?)",
                        [.text(oficina), .text(agente), .text(origen), .text(ref), .double(costo),
                         .double(Date().timeIntervalSince1970)])
    }

    /// Totales de una oficina desde `desde` (epoch): total, por agente, por origen y por referencia de reunión.
    public func costos(oficina: String, desde: Double = 0) -> [String: Any] {
        let p: [SQLValue] = [.text(oficina), .double(desde)]
        let total = (try? db.query("SELECT COALESCE(SUM(costo),0) FROM costos WHERE oficina=? AND ts>=?", p) { $0.double(0) })?.first ?? 0
        func agrupar(_ col: String, _ extra: String = "") -> [String: Double] {
            let filas = (try? db.query("SELECT \(col), SUM(costo) FROM costos WHERE oficina=? AND ts>=? \(extra) GROUP BY \(col)", p) {
                ($0.text(0), $0.double(1)) }) ?? []
            return Dictionary(filas.filter { !$0.0.isEmpty }, uniquingKeysWith: +)
        }
        return ["total": total, "agentes": agrupar("agente"), "origenes": agrupar("origen"),
                "reuniones": agrupar("ref", "AND origen IN ('reunion','sintesis')")]
    }

    public func close() { db.close() }

    // MARK: sesiones

    public func agenteDe(_ sid: String) -> String? {
        (try? db.query("SELECT agente FROM sesiones WHERE id=?", [.text(sid)]) { $0.text(0) })?.first
    }

    public func estaActiva(_ sid: String) -> Bool {
        ((try? db.query("SELECT activa FROM sesiones WHERE id=?", [.text(sid)]) { $0.int(0) })?.first ?? 0) != 0
    }

    /// Oficina dueña de la sesión ('' = anterior a las oficinas), o nil si la sesión no existe.
    public func oficinaDe(_ sid: String) -> String? {
        (try? db.query("SELECT oficina FROM sesiones WHERE id=?", [.text(sid)]) { $0.text(0) })?.first
    }

    public func asegurarSesion(_ sid: String, agente: String, oficina: String = "") throws {
        try db.run("INSERT OR IGNORE INTO sesiones(id,agente,creada,activa,oficina) VALUES(?,?,?,0,?)",
                   [.text(sid), .text(agente), .double(Date().timeIntervalSince1970), .text(oficina)])
    }

    /// Pasa a `oficina` las sesiones anteriores a las oficinas (oficina ''). Devuelve cuántas.
    @discardableResult
    public func reclamarLegacy(oficina: String) throws -> Int {
        try db.run("UPDATE sesiones SET oficina=? WHERE oficina=''", [.text(oficina)])
    }

    public func marcarActiva(_ sid: String) throws {
        try db.run("UPDATE sesiones SET activa=1 WHERE id=?", [.text(sid)])
    }

    /// Sesión más reciente del agente que tenga mensajes, o nil.
    public func ultimaSesion(_ agente: String, oficina: String = "") -> String? {
        (try? db.query("""
            SELECT s.id FROM sesiones s WHERE s.agente=? AND s.oficina=? AND EXISTS (SELECT 1 FROM mensajes m WHERE m.sid=s.id)
            ORDER BY (SELECT MAX(id) FROM mensajes m WHERE m.sid=s.id) DESC LIMIT 1
            """, [.text(agente), .text(oficina)]) { $0.text(0) })?.first
    }

    // MARK: mensajes

    public func agregar(sid: String, rol: String, texto: String, error: Bool = false) throws {
        try db.run("INSERT INTO mensajes(sid,rol,texto,error,ts) VALUES(?,?,?,?,?)",
                   [.text(sid), .text(rol), .text(texto), .int(error ? 1 : 0), .double(Date().timeIntervalSince1970)])
    }

    public func mensajes(_ sid: String, limite: Int = 500) -> [Mensaje] {
        (try? db.query("""
            SELECT rol,texto,error FROM (SELECT id,rol,texto,error FROM mensajes WHERE sid=? ORDER BY id DESC LIMIT ?) ORDER BY id
            """, [.text(sid), .int(Int64(limite))]) { Mensaje(r: $0.text(0), t: $0.text(1), e: $0.int(2) != 0) }) ?? []
    }

    public func cuentaMensajes(_ sid: String) -> Int {
        Int((try? db.query("SELECT COUNT(*) FROM mensajes WHERE sid=?", [.text(sid)]) { $0.int(0) })?.first ?? 0)
    }

    // MARK: meta

    public func meta(_ clave: String) -> String? {
        (try? db.query("SELECT valor FROM meta WHERE clave=?", [.text(clave)]) { $0.text(0) })?.first
    }

    public func setMeta(_ clave: String, _ valor: String) throws {
        try db.run("INSERT INTO meta(clave,valor) VALUES(?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor",
                   [.text(clave), .text(valor)])
    }

    // MARK: importación (migración)

    /// Importa en una transacción. Sesiones: INSERT OR IGNORE. Mensajes: solo de sesiones que no tenían
    /// ninguno antes del lote (así reimportar no duplica). Devuelve (sesiones nuevas, mensajes importados).
    @discardableResult
    func importar(_ lote: LoteImportacion) throws -> (sesiones: Int, mensajes: Int) {
        var ns = 0, nm = 0
        try db.exec("BEGIN IMMEDIATE")
        do {
            let conMensajes = Set(try db.query("SELECT DISTINCT sid FROM mensajes") { $0.text(0) })
            for s in lote.sesiones {
                ns += try db.run("INSERT OR IGNORE INTO sesiones(id,agente,creada,activa) VALUES(?,?,?,?)",
                                 [.text(s.sid), .text(s.agente), .double(s.creada), .int(s.activa ? 1 : 0)])
            }
            for m in lote.mensajes where !conMensajes.contains(m.sid) {
                guard agenteDe(m.sid) != nil else { continue }
                nm += try db.run("INSERT INTO mensajes(sid,rol,texto,error,ts) VALUES(?,?,?,?,?)",
                                 [.text(m.sid), .text(m.r), .text(m.t), .int(m.e ? 1 : 0), .double(m.ts)])
            }
            try db.exec("COMMIT")
        } catch {
            try? db.exec("ROLLBACK")
            throw error
        }
        return (ns, nm)
    }
}
