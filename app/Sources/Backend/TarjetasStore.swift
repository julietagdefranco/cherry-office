import Foundation

// Tarjetas del Creador (docs/plan-creador-flujos.md §2). Mismo patrón que Entregas.swift.
// `datos` es un objeto JSON y `faltantes` una lista JSON; se guardan como texto y salen parseados en `json`.

public struct Tarjeta: Sendable, Equatable {
    public static let tipos = ["departamento", "agente", "flujo", "regla", "conector", "tarea"]
    public static let estados = ["borrador", "lista", "creada", "descartada", "error"]

    public var id: String
    public var oficina: String
    public var sid: String
    public var tipo: String
    /// crear | modificar | quitar
    public var accion: String
    /// Id existente (modificar / quitar).
    public var objetivo: String?
    /// Objeto JSON como texto.
    public var datos: String
    /// Lista JSON como texto.
    public var faltantes: String
    public var origen: String
    public var estado: String
    public var error: String?
    public var creadaId: String?
    public var creada: Double
    public var actualizada: Double

    public init(id: String, oficina: String, sid: String = "", tipo: String, accion: String, objetivo: String? = nil,
                datos: String = "{}", faltantes: String = "[]", origen: String = "", estado: String = "borrador",
                error: String? = nil, creadaId: String? = nil, creada: Double = 0, actualizada: Double = 0) {
        self.id = id; self.oficina = oficina; self.sid = sid; self.tipo = tipo; self.accion = accion; self.objetivo = objetivo
        self.datos = datos; self.faltantes = faltantes; self.origen = origen; self.estado = estado; self.error = error
        self.creadaId = creadaId; self.creada = creada; self.actualizada = actualizada
    }

    public var json: [String: Any] {
        var o: [String: Any] = ["id": id, "sid": sid, "tipo": tipo, "accion": accion, "origen": origen, "estado": estado,
                                "datos": (try? JSONSerialization.jsonObject(with: Data(datos.utf8))) as? [String: Any] ?? [:],
                                "faltantes": (try? JSONSerialization.jsonObject(with: Data(faltantes.utf8))) as? [Any] ?? [],
                                "creada": ReunionesRouter.iso(creada), "actualizada": ReunionesRouter.iso(actualizada)]
        o["objetivo"] = objetivo.map { $0 as Any } ?? NSNull()
        o["error"] = error.map { $0 as Any } ?? NSNull()
        o["creadaId"] = creadaId.map { $0 as Any } ?? NSNull()
        return o
    }
}

extension Store {
    func prepararTarjetas() throws {
        try db.exec("""
        CREATE TABLE IF NOT EXISTS creador_tarjetas (
          id TEXT NOT NULL, oficina TEXT NOT NULL, sid TEXT NOT NULL DEFAULT '',
          tipo TEXT NOT NULL,
          accion TEXT NOT NULL,
          objetivo TEXT,
          datos TEXT NOT NULL, faltantes TEXT NOT NULL DEFAULT '[]', origen TEXT NOT NULL,
          estado TEXT NOT NULL,
          error TEXT, creada_id TEXT, creada REAL NOT NULL, actualizada REAL NOT NULL,
          PRIMARY KEY (oficina, id));
        CREATE INDEX IF NOT EXISTS creador_oficina ON creador_tarjetas(oficina, estado);
        """)
    }

    private static let columnasTarjeta = "id,oficina,sid,tipo,accion,objetivo,datos,faltantes,origen,estado,error,creada_id,creada,actualizada"

    private static func tarjeta(_ r: SQLRow) -> Tarjeta {
        Tarjeta(id: r.text(0), oficina: r.text(1), sid: r.text(2), tipo: r.text(3), accion: r.text(4),
                objetivo: r.isNull(5) ? nil : r.text(5), datos: r.text(6), faltantes: r.text(7), origen: r.text(8), estado: r.text(9),
                error: r.isNull(10) ? nil : r.text(10), creadaId: r.isNull(11) ? nil : r.text(11), creada: r.double(12),
                actualizada: r.double(13))
    }

    /// Upsert por (oficina, id). Conserva la `creada` original; `actualizada` pasa a ser ahora.
    @discardableResult
    public func tarjetaGuardar(_ t: Tarjeta) -> Bool {
        try? prepararTarjetas()
        let ahora = Date().timeIntervalSince1970
        return (try? db.run("""
            INSERT INTO creador_tarjetas(id,oficina,sid,tipo,accion,objetivo,datos,faltantes,origen,estado,error,creada_id,creada,actualizada)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(oficina,id) DO UPDATE SET sid=excluded.sid, tipo=excluded.tipo, accion=excluded.accion,
              objetivo=excluded.objetivo, datos=excluded.datos, faltantes=excluded.faltantes, origen=excluded.origen,
              estado=excluded.estado, error=excluded.error, creada_id=excluded.creada_id, actualizada=excluded.actualizada
            """, [.text(t.id), .text(t.oficina), .text(t.sid), .text(t.tipo), .text(t.accion), t.objetivo.map { .text($0) } ?? .null,
                  .text(t.datos), .text(t.faltantes), .text(t.origen), .text(t.estado), t.error.map { .text($0) } ?? .null,
                  t.creadaId.map { .text($0) } ?? .null, .double(ahora), .double(ahora)])) != nil
    }

    public func tarjeta(oficina: String, id: String) -> Tarjeta? {
        try? prepararTarjetas()
        return (try? db.query("SELECT \(Store.columnasTarjeta) FROM creador_tarjetas WHERE oficina=? AND id=?",
                              [.text(oficina), .text(id)], Store.tarjeta))?.first
    }

    /// Por fecha de creación (la más vieja primero).
    public func tarjetas(oficina: String, estados: [String]? = nil) -> [Tarjeta] {
        try? prepararTarjetas()
        var sql = "SELECT \(Store.columnasTarjeta) FROM creador_tarjetas WHERE oficina=?"
        var p: [SQLValue] = [.text(oficina)]
        if let estados {
            if estados.isEmpty { return [] }
            sql += " AND estado IN (\(estados.map { _ in "?" }.joined(separator: ",")))"
            p += estados.map { .text($0) }
        }
        sql += " ORDER BY creada, rowid"
        return (try? db.query(sql, p, Store.tarjeta)) ?? []
    }

    @discardableResult
    public func tarjetaEstado(oficina: String, id: String, estado: String, error: String? = nil, creadaId: String? = nil) -> Tarjeta? {
        try? prepararTarjetas()
        _ = try? db.run("""
            UPDATE creador_tarjetas SET estado=?, error=?, creada_id=COALESCE(?,creada_id), actualizada=? WHERE oficina=? AND id=?
            """, [.text(estado), error.map { .text($0) } ?? .null, creadaId.map { .text($0) } ?? .null,
                  .double(Date().timeIntervalSince1970), .text(oficina), .text(id)])
        return tarjeta(oficina: oficina, id: id)
    }

    /// `t1`, `t2`, …: el siguiente número libre en esa oficina.
    public func tarjetaNuevoId(oficina: String) -> String {
        try? prepararTarjetas()
        let ids = (try? db.query("SELECT id FROM creador_tarjetas WHERE oficina=?", [.text(oficina)]) { $0.text(0) }) ?? []
        let usados = ids.compactMap { $0.hasPrefix("t") ? Int($0.dropFirst()) : nil }
        return "t\((usados.max() ?? 0) + 1)"
    }
}
