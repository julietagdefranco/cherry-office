import Foundation
import SQLite3

enum SQLValue {
    case int(Int64), double(Double), text(String), null
}

struct SQLError: Error, CustomStringConvertible {
    var description: String
}

private let SQLITE_TRANSIENT_ = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Fila de resultado (solo válida dentro del cierre de `query`).
struct SQLRow {
    let stmt: OpaquePointer
    func text(_ i: Int32) -> String { sqlite3_column_text(stmt, i).map { String(cString: $0) } ?? "" }
    func int(_ i: Int32) -> Int64 { sqlite3_column_int64(stmt, i) }
    func double(_ i: Int32) -> Double { sqlite3_column_double(stmt, i) }
    func isNull(_ i: Int32) -> Bool { sqlite3_column_type(stmt, i) == SQLITE_NULL }
}

/// Envoltorio mínimo de SQLite3. No es thread-safe: lo usa un solo dueño (el actor Store o la migración).
final class SQLiteDB {
    private var db: OpaquePointer?

    init(path: String, readOnly: Bool = false) throws {
        let flags = readOnly ? SQLITE_OPEN_READONLY : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
        guard sqlite3_open_v2(path, &db, flags | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            let m = db.map { String(cString: sqlite3_errmsg($0)) } ?? "no pude abrir la base"
            sqlite3_close_v2(db)
            throw SQLError(description: m)
        }
        sqlite3_busy_timeout(db, 5000)
    }

    deinit { sqlite3_close_v2(db) }

    func close() { sqlite3_close_v2(db); db = nil }

    private var mensaje: String { db.map { String(cString: sqlite3_errmsg($0)) } ?? "base cerrada" }

    func exec(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw SQLError(description: mensaje) }
    }

    private func preparar(_ sql: String, _ params: [SQLValue]) throws -> OpaquePointer {
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK, let s = st else {
            throw SQLError(description: mensaje)
        }
        for (i, p) in params.enumerated() {
            let n = Int32(i + 1)
            switch p {
            case .int(let v): sqlite3_bind_int64(s, n, v)
            case .double(let v): sqlite3_bind_double(s, n, v)
            case .text(let v): sqlite3_bind_text(s, n, v, -1, SQLITE_TRANSIENT_)
            case .null: sqlite3_bind_null(s, n)
            }
        }
        return s
    }

    /// Ejecuta una sentencia de escritura; devuelve filas afectadas.
    @discardableResult
    func run(_ sql: String, _ params: [SQLValue] = []) throws -> Int {
        let s = try preparar(sql, params)
        defer { sqlite3_finalize(s) }
        guard sqlite3_step(s) == SQLITE_DONE else { throw SQLError(description: mensaje) }
        return Int(sqlite3_changes(db))
    }

    func query<T>(_ sql: String, _ params: [SQLValue] = [], _ row: (SQLRow) -> T) throws -> [T] {
        let s = try preparar(sql, params)
        defer { sqlite3_finalize(s) }
        var out: [T] = []
        while true {
            let rc = sqlite3_step(s)
            if rc == SQLITE_ROW { out.append(row(SQLRow(stmt: s))) }
            else if rc == SQLITE_DONE { break }
            else { throw SQLError(description: mensaje) }
        }
        return out
    }
}
