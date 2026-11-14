import Foundation

// Acciones hacia afuera que un agente propone y la persona aprueba (docs/plan-creador-flujos.md §2).
// Mismo patrón que Entregas.swift. `detalle` es un objeto JSON guardado como texto.

public struct AccionPropuesta: Sendable, Equatable {
    public static let estados = ["pendiente", "ejecutando", "hecha", "error", "descartada"]

    public var id: Int64
    public var oficina: String
    public var agente: String
    public var sid: String
    public var entrega: Int64?
    public var herramienta: String
    public var resumen: String
    /// Objeto JSON como texto.
    public var detalle: String
    public var estado: String
    public var resultado: String?
    public var ejecucion: Int64?
    public var creada: Double
    public var actualizada: Double

    public var json: [String: Any] {
        var o: [String: Any] = ["id": id, "agente": agente, "sid": sid, "herramienta": herramienta, "resumen": resumen,
                                "detalle": (try? JSONSerialization.jsonObject(with: Data(detalle.utf8))) as? [String: Any] ?? [:],
                                "estado": estado, "creada": ReunionesRouter.iso(creada), "actualizada": ReunionesRouter.iso(actualizada)]
        o["entrega"] = entrega.map { $0 as Any } ?? NSNull()
        o["resultado"] = resultado.map { $0 as Any } ?? NSNull()
        o["ejecucion"] = ejecucion.map { $0 as Any } ?? NSNull()
        return o
    }
}

extension Store {
    func prepararAcciones() throws {
        try db.exec("""
        CREATE TABLE IF NOT EXISTS acciones (
          id INTEGER PRIMARY KEY AUTOINCREMENT, oficina TEXT NOT NULL, agente TEXT NOT NULL, sid TEXT NOT NULL,
          entrega INTEGER, herramienta TEXT NOT NULL, resumen TEXT NOT NULL, detalle TEXT NOT NULL DEFAULT '{}',
          estado TEXT NOT NULL,
          resultado TEXT, ejecucion INTEGER, creada REAL NOT NULL, actualizada REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS acciones_entrega ON acciones(entrega);
        """)
    }

    private static let columnasAccion = "id,oficina,agente,sid,entrega,herramienta,resumen,detalle,estado,resultado,ejecucion,creada,actualizada"

    private static func accion(_ r: SQLRow) -> AccionPropuesta {
        AccionPropuesta(id: r.int(0), oficina: r.text(1), agente: r.text(2), sid: r.text(3), entrega: r.isNull(4) ? nil : r.int(4),
                        herramienta: r.text(5), resumen: r.text(6), detalle: r.text(7), estado: r.text(8),
                        resultado: r.isNull(9) ? nil : r.text(9), ejecucion: r.isNull(10) ? nil : r.int(10),
                        creada: r.double(11), actualizada: r.double(12))
    }

    @discardableResult
    public func accionCrear(oficina: String, agente: String, sid: String, herramienta: String, resumen: String, detalle: String,
                            entrega: Int64? = nil) -> AccionPropuesta? {
        try? prepararAcciones()
        let ahora = Date().timeIntervalSince1970
        guard (try? db.run("""
            INSERT INTO acciones(oficina,agente,sid,entrega,herramienta,resumen,detalle,estado,creada,actualizada)
            VALUES(?,?,?,?,?,?,?,'pendiente',?,?)
            """, [.text(oficina), .text(agente), .text(sid), entrega.map { .int($0) } ?? .null, .text(herramienta), .text(resumen),
                  .text(detalle), .double(ahora), .double(ahora)])) != nil,
              let id = (try? db.query("SELECT last_insert_rowid()") { $0.int(0) })?.first else { return nil }
        return (try? db.query("SELECT \(Store.columnasAccion) FROM acciones WHERE id=?", [.int(id)], Store.accion))?.first
    }

    /// Ata la acción a la entrega que la propone.
    public func accionVincular(id: Int64, entrega: Int64) {
        try? prepararAcciones()
        _ = try? db.run("UPDATE acciones SET entrega=?, actualizada=? WHERE id=?",
                        [.int(entrega), .double(Date().timeIntervalSince1970), .int(id)])
    }

    public func accion(oficina: String, id: Int64) -> AccionPropuesta? {
        try? prepararAcciones()
        return (try? db.query("SELECT \(Store.columnasAccion) FROM acciones WHERE oficina=? AND id=?",
                              [.text(oficina), .int(id)], Store.accion))?.first
    }

    public func accionPorEntrega(oficina: String, entrega: Int64) -> AccionPropuesta? {
        try? prepararAcciones()
        return (try? db.query("SELECT \(Store.columnasAccion) FROM acciones WHERE oficina=? AND entrega=? ORDER BY id DESC LIMIT 1",
                              [.text(oficina), .int(entrega)], Store.accion))?.first
    }

    /// De la más nueva a la más vieja.
    public func acciones(oficina: String, estados: [String]? = nil) -> [AccionPropuesta] {
        try? prepararAcciones()
        var sql = "SELECT \(Store.columnasAccion) FROM acciones WHERE oficina=?"
        var p: [SQLValue] = [.text(oficina)]
        if let estados {
            if estados.isEmpty { return [] }
            sql += " AND estado IN (\(estados.map { _ in "?" }.joined(separator: ",")))"
            p += estados.map { .text($0) }
        }
        sql += " ORDER BY id DESC"
        return (try? db.query(sql, p, Store.accion)) ?? []
    }

    public func accionActualizar(id: Int64, estado: String, resultado: String? = nil, ejecucion: Int64? = nil) {
        try? prepararAcciones()
        _ = try? db.run("""
            UPDATE acciones SET estado=?, resultado=COALESCE(?,resultado), ejecucion=COALESCE(?,ejecucion), actualizada=? WHERE id=?
            """, [.text(estado), resultado.map { .text($0) } ?? .null, ejecucion.map { .int($0) } ?? .null,
                  .double(Date().timeIntervalSince1970), .int(id)])
    }
}
