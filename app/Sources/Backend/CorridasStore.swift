import Foundation

// Corridas de flujos y sus pasos (docs/plan-creador-flujos.md §2). Mismo patrón que Entregas.swift.
// `definicion` es el JSON del flujo tal como estaba al arrancar la corrida (no cambia aunque se edite el flujo).

public struct Corrida: Sendable, Equatable {
    public static let estados = ["en_curso", "esperando_aprobacion", "esperando_persona", "trabada", "terminada", "cancelada"]
    public static let abiertas = ["en_curso", "esperando_aprobacion", "esperando_persona", "trabada"]

    public var id: Int64
    public var oficina: String
    public var flujo: String
    public var nombre: String
    public var contexto: String
    /// JSON del flujo al arrancar.
    public var definicion: String
    public var paso: Int
    public var estado: String
    public var creada: Double
    public var actualizada: Double
    public var terminada: Double?
    public var vista: Bool

    private var objetoDef: [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(definicion.utf8))) as? [String: Any] ?? [:]
    }

    /// Nombre y responsable del paso actual, y responsable del anterior. Una sola lectura de la definición y sin armar el JSON
    /// completo: lo usan `/api/actividad` y los avisos, que se piden seguido y para todas las corridas abiertas.
    var resumenPaso: (nombre: String, quien: String, anterior: String) {
        let pasos = objetoDef["pasos"] as? [[String: Any]] ?? []
        let actual = paso >= 0 && paso < pasos.count ? pasos[paso] : [:]
        let anterior = paso > 0 && paso - 1 < pasos.count ? pasos[paso - 1] : [:]
        return ((actual["nombre"] as? String) ?? "", (actual["quien"] as? String) ?? "", (anterior["quien"] as? String) ?? "")
    }

    public var json: [String: Any] {
        let def = objetoDef
        let pasos = def["pasos"] as? [[String: Any]] ?? []
        let actual = paso >= 0 && paso < pasos.count ? pasos[paso] : [:]
        let nombreFlujo = (def["nombre"] as? String) ?? ""
        var o: [String: Any] = ["id": id, "flujo": flujo, "nombre": nombre, "contexto": contexto, "definicion": definicion,
                                "paso": paso, "estado": estado, "creada": ReunionesRouter.iso(creada),
                                "actualizada": ReunionesRouter.iso(actualizada), "vista": vista,
                                "flujoNombre": nombreFlujo.isEmpty ? flujo : nombreFlujo, "total": pasos.count,
                                "pasoNombre": (actual["nombre"] as? String) ?? "", "quien": (actual["quien"] as? String) ?? ""]
        o["terminada"] = terminada.map { ReunionesRouter.iso($0) as Any } ?? NSNull()
        return o
    }
}

public struct PasoCorrida: Sendable, Equatable {
    public static let estados = ["pendiente", "corriendo", "esperando_aprobacion", "esperando_persona", "listo", "error", "saltado", "cancelado"]

    public var id: Int64
    public var corrida: Int64
    public var paso: Int
    public var intento: Int
    public var quien: String
    public var estado: String
    public var ejecucion: Int64?
    public var entrega: Int64?
    public var inicio: Double
    /// No lanzar antes de esta fecha (esperaDias).
    public var despues: Double?
    public var fin: Double?
    public var costo: Double?
    public var nota: String?

    public var json: [String: Any] {
        var o: [String: Any] = ["id": id, "corrida": corrida, "paso": paso, "intento": intento, "quien": quien, "estado": estado,
                                "inicio": ReunionesRouter.iso(inicio)]
        o["ejecucion"] = ejecucion.map { $0 as Any } ?? NSNull()
        o["entrega"] = entrega.map { $0 as Any } ?? NSNull()
        o["despues"] = despues.map { ReunionesRouter.iso($0) as Any } ?? NSNull()
        o["fin"] = fin.map { ReunionesRouter.iso($0) as Any } ?? NSNull()
        o["costo"] = costo.map { $0 as Any } ?? NSNull()
        o["nota"] = nota.map { $0 as Any } ?? NSNull()
        return o
    }
}

extension Store {
    func prepararCorridas() throws {
        try db.exec("""
        CREATE TABLE IF NOT EXISTS corridas (
          id INTEGER PRIMARY KEY AUTOINCREMENT, oficina TEXT NOT NULL, flujo TEXT NOT NULL,
          nombre TEXT NOT NULL, contexto TEXT NOT NULL DEFAULT '',
          definicion TEXT NOT NULL,
          paso INTEGER NOT NULL DEFAULT 0,
          estado TEXT NOT NULL,
          creada REAL NOT NULL, actualizada REAL NOT NULL, terminada REAL, vista INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS corridas_oficina ON corridas(oficina, estado);

        CREATE TABLE IF NOT EXISTS corrida_pasos (
          id INTEGER PRIMARY KEY AUTOINCREMENT, corrida INTEGER NOT NULL, paso INTEGER NOT NULL,
          intento INTEGER NOT NULL DEFAULT 1, quien TEXT NOT NULL,
          estado TEXT NOT NULL,
          ejecucion INTEGER, entrega INTEGER,
          inicio REAL NOT NULL, despues REAL,
          fin REAL, costo REAL, nota TEXT);
        CREATE INDEX IF NOT EXISTS corrida_pasos_c ON corrida_pasos(corrida, paso, intento);
        CREATE INDEX IF NOT EXISTS corrida_pasos_entrega ON corrida_pasos(entrega);
        """)
    }

    private static let columnasCorrida = "id,oficina,flujo,nombre,contexto,definicion,paso,estado,creada,actualizada,terminada,vista"
    private static let columnasPaso = "id,corrida,paso,intento,quien,estado,ejecucion,entrega,inicio,despues,fin,costo,nota"

    private static func corrida(_ r: SQLRow) -> Corrida {
        Corrida(id: r.int(0), oficina: r.text(1), flujo: r.text(2), nombre: r.text(3), contexto: r.text(4), definicion: r.text(5),
                paso: Int(r.int(6)), estado: r.text(7), creada: r.double(8), actualizada: r.double(9),
                terminada: r.isNull(10) ? nil : r.double(10), vista: r.int(11) != 0)
    }

    /// `o` = desde qué columna empieza el paso (cuando viene en un JOIN).
    private static func pasoCorrida(_ r: SQLRow, _ o: Int32 = 0) -> PasoCorrida {
        PasoCorrida(id: r.int(o), corrida: r.int(o + 1), paso: Int(r.int(o + 2)), intento: Int(r.int(o + 3)), quien: r.text(o + 4),
                    estado: r.text(o + 5), ejecucion: r.isNull(o + 6) ? nil : r.int(o + 6), entrega: r.isNull(o + 7) ? nil : r.int(o + 7),
                    inicio: r.double(o + 8), despues: r.isNull(o + 9) ? nil : r.double(o + 9),
                    fin: r.isNull(o + 10) ? nil : r.double(o + 10), costo: r.isNull(o + 11) ? nil : r.double(o + 11),
                    nota: r.isNull(o + 12) ? nil : r.text(o + 12))
    }

    // MARK: corridas

    @discardableResult
    public func corridaCrear(oficina: String, flujo: String, nombre: String, contexto: String, definicion: String,
                             estado: String = "en_curso") -> Corrida? {
        try? prepararCorridas()
        let ahora = Date().timeIntervalSince1970
        guard (try? db.run("""
            INSERT INTO corridas(oficina,flujo,nombre,contexto,definicion,paso,estado,creada,actualizada) VALUES(?,?,?,?,?,0,?,?,?)
            """, [.text(oficina), .text(flujo), .text(nombre), .text(contexto), .text(definicion), .text(estado),
                  .double(ahora), .double(ahora)])) != nil,
              let id = (try? db.query("SELECT last_insert_rowid()") { $0.int(0) })?.first else { return nil }
        return corrida(oficina: oficina, id: id)
    }

    public func corrida(oficina: String, id: Int64) -> Corrida? {
        try? prepararCorridas()
        return (try? db.query("SELECT \(Store.columnasCorrida) FROM corridas WHERE oficina=? AND id=?",
                              [.text(oficina), .int(id)], Store.corrida))?.first
    }

    /// De la que se movió hace menos a la que hace más. Filtros opcionales.
    public func corridas(oficina: String, estados: [String]? = nil, flujo: String? = nil, limite: Int = 100) -> [Corrida] {
        try? prepararCorridas()
        var sql = "SELECT \(Store.columnasCorrida) FROM corridas WHERE oficina=?"
        var p: [SQLValue] = [.text(oficina)]
        if let estados {
            if estados.isEmpty { return [] }
            sql += " AND estado IN (\(estados.map { _ in "?" }.joined(separator: ",")))"
            p += estados.map { .text($0) }
        }
        if let flujo { sql += " AND flujo=?"; p.append(.text(flujo)) }
        sql += " ORDER BY actualizada DESC, id DESC LIMIT ?"
        p.append(.int(Int64(max(1, min(limite, 500)))))
        return (try? db.query(sql, p, Store.corrida)) ?? []
    }

    /// Siempre toca `actualizada`. Pasar a `esperando_persona` marca la corrida como no vista.
    @discardableResult
    public func corridaActualizar(oficina: String, id: Int64, paso: Int? = nil, estado: String? = nil, terminada: Double? = nil) -> Corrida? {
        try? prepararCorridas()
        var sets = ["actualizada=?"]
        var p: [SQLValue] = [.double(Date().timeIntervalSince1970)]
        if let paso { sets.append("paso=?"); p.append(.int(Int64(paso))) }
        if let estado {
            sets.append("estado=?"); p.append(.text(estado))
            if estado == "esperando_persona" { sets.append("vista=0") }
        }
        if let terminada { sets.append("terminada=?"); p.append(.double(terminada)) }
        p += [.text(oficina), .int(id)]
        _ = try? db.run("UPDATE corridas SET \(sets.joined(separator: ",")) WHERE oficina=? AND id=?", p)
        return corrida(oficina: oficina, id: id)
    }

    /// Marca la corrida como vista. Devuelve si existía.
    @discardableResult
    public func corridaVista(oficina: String, id: Int64) -> Bool {
        try? prepararCorridas()
        guard corrida(oficina: oficina, id: id) != nil else { return false }
        _ = try? db.run("UPDATE corridas SET vista=1 WHERE oficina=? AND id=?", [.text(oficina), .int(id)])
        return true
    }

    /// Las que esperan a la persona y todavía no vio.
    public func corridasEsperandoPersona(oficina: String) -> [Corrida] {
        try? prepararCorridas()
        return (try? db.query("""
            SELECT \(Store.columnasCorrida) FROM corridas WHERE oficina=? AND estado='esperando_persona' AND vista=0
            ORDER BY actualizada DESC, id DESC
            """, [.text(oficina)], Store.corrida)) ?? []
    }

    // MARK: pasos

    @discardableResult
    public func pasoCrear(corrida: Int64, paso: Int, intento: Int, quien: String, estado: String,
                          despues: Double? = nil, nota: String? = nil) -> PasoCorrida? {
        try? prepararCorridas()
        guard (try? db.run("""
            INSERT INTO corrida_pasos(corrida,paso,intento,quien,estado,inicio,despues,nota) VALUES(?,?,?,?,?,?,?,?)
            """, [.int(corrida), .int(Int64(paso)), .int(Int64(intento)), .text(quien), .text(estado),
                  .double(Date().timeIntervalSince1970), despues.map { .double($0) } ?? .null, nota.map { .text($0) } ?? .null])) != nil,
              let id = (try? db.query("SELECT last_insert_rowid()") { $0.int(0) })?.first else { return nil }
        return pasoPorId(id)
    }

    private func pasoPorId(_ id: Int64) -> PasoCorrida? {
        (try? db.query("SELECT \(Store.columnasPaso) FROM corrida_pasos WHERE id=?", [.int(id)]) { Store.pasoCorrida($0) })?.first
    }

    /// Solo toca lo que viene. `sumarCosto` acumula sobre lo que ya hay (NULL cuenta como 0).
    @discardableResult
    public func pasoActualizar(id: Int64, estado: String? = nil, ejecucion: Int64? = nil, entrega: Int64? = nil, fin: Double? = nil,
                               sumarCosto: Double? = nil, nota: String? = nil) -> PasoCorrida? {
        try? prepararCorridas()
        var sets: [String] = []
        var p: [SQLValue] = []
        if let estado { sets.append("estado=?"); p.append(.text(estado)) }
        if let ejecucion { sets.append("ejecucion=?"); p.append(.int(ejecucion)) }
        if let entrega { sets.append("entrega=?"); p.append(.int(entrega)) }
        if let fin { sets.append("fin=?"); p.append(.double(fin)) }
        if let sumarCosto { sets.append("costo=COALESCE(costo,0)+?"); p.append(.double(sumarCosto)) }
        if let nota { sets.append("nota=?"); p.append(.text(nota)) }
        if !sets.isEmpty {
            p.append(.int(id))
            _ = try? db.run("UPDATE corrida_pasos SET \(sets.joined(separator: ",")) WHERE id=?", p)
        }
        return pasoPorId(id)
    }

    /// Por paso y después por intento.
    public func pasosDe(corrida: Int64) -> [PasoCorrida] {
        try? prepararCorridas()
        return (try? db.query("SELECT \(Store.columnasPaso) FROM corrida_pasos WHERE corrida=? ORDER BY paso, intento, id",
                              [.int(corrida)]) { Store.pasoCorrida($0) }) ?? []
    }

    /// El de mayor id.
    public func pasoVigente(corrida: Int64) -> PasoCorrida? {
        try? prepararCorridas()
        return (try? db.query("SELECT \(Store.columnasPaso) FROM corrida_pasos WHERE corrida=? ORDER BY id DESC LIMIT 1",
                              [.int(corrida)]) { Store.pasoCorrida($0) })?.first
    }

    public func pasoBuscar(corrida: Int64, paso: Int, intento: Int) -> PasoCorrida? {
        try? prepararCorridas()
        return (try? db.query("SELECT \(Store.columnasPaso) FROM corrida_pasos WHERE corrida=? AND paso=? AND intento=? ORDER BY id DESC LIMIT 1",
                              [.int(corrida), .int(Int64(paso)), .int(Int64(intento))]) { Store.pasoCorrida($0) })?.first
    }

    /// El paso cuya entrega vigente es esa.
    public func pasoPorEntrega(_ entrega: Int64) -> PasoCorrida? {
        try? prepararCorridas()
        return (try? db.query("SELECT \(Store.columnasPaso) FROM corrida_pasos WHERE entrega=? ORDER BY id DESC LIMIT 1",
                              [.int(entrega)]) { Store.pasoCorrida($0) })?.first
    }

    /// Pasos en esos estados de las corridas de la oficina, junto con su corrida.
    public func pasosEnEstado(oficina: String, estados: [String]) -> [(Corrida, PasoCorrida)] {
        try? prepararCorridas()
        guard !estados.isEmpty else { return [] }
        let cc = Store.columnasCorrida.split(separator: ",").map { "c.\($0)" }.joined(separator: ",")
        let pc = Store.columnasPaso.split(separator: ",").map { "p.\($0)" }.joined(separator: ",")
        let sql = """
            SELECT \(cc),\(pc) FROM corrida_pasos p JOIN corridas c ON c.id=p.corrida
            WHERE c.oficina=? AND p.estado IN (\(estados.map { _ in "?" }.joined(separator: ","))) ORDER BY p.id
            """
        let p: [SQLValue] = [.text(oficina)] + estados.map { .text($0) }
        return (try? db.query(sql, p) { r in (Store.corrida(r), Store.pasoCorrida(r, 12)) }) ?? []
    }

    /// Cuántos pasos terminaron bien (estado listo) desde esa fecha.
    public func pasosTerminadosDesde(oficina: String, desde: Double) -> Int {
        try? prepararCorridas()
        return (try? db.query("""
            SELECT COUNT(*) FROM corrida_pasos p JOIN corridas c ON c.id=p.corrida
            WHERE c.oficina=? AND p.estado='listo' AND p.fin>=?
            """, [.text(oficina), .double(desde)]) { Int($0.int(0)) })?.first ?? 0
    }
}
