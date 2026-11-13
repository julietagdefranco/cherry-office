import Foundation

// Entregas: lo que un agente terminó y la persona tiene que revisar (docs/plan-entregables.md).
// Nacen «sin revisar» y pasan a «revisada» solo cuando la persona toca «Listo» (abrirlas no alcanza).
// Generan entrega: una ejecución de tarea que terminó bien (programada, de prueba o encargo de un pendiente), el acta de
// una reunión y un chat que escribió archivos en `archivos/entregables/`. Misma tabla y textos que tools/hq_entregas.py.

public struct Entrega: Sendable, Equatable {
    public static let estados = ["sin_revisar", "revisada", "cambios"]

    public var id: Int64
    public var oficina: String
    /// '' = sin agente (actas de reunión).
    public var agente: String
    /// tarea | encargo | reunion | chat | cambios
    public var origen: String
    /// Id de la tarea (tarea, encargo), de la reunión, o la sesión (chat, cambios).
    public var ref: String
    public var titulo: String
    /// Respuesta completa del agente (o resumen de la reunión).
    public var texto: String
    /// Sesión de chat donde quedó (para abrirla o pedir cambios). '' = no tiene.
    public var sid: String
    /// Rutas relativas a la carpeta de la oficina.
    public var archivos: [String]
    public var creada: Double
    /// sin_revisar | revisada | cambios
    public var estado: String
    public var revisada: Double?
    /// Entrega anterior cuando esta es la versión con cambios.
    public var padre: Int64?
    public var costo: Double?

    public var resumen: String { TextoEntrega.resumen(texto) }

    /// Fila para listas (sin el texto completo).
    public var json: [String: Any] {
        var o: [String: Any] = ["id": id, "agente": agente, "origen": origen, "ref": ref, "titulo": titulo, "resumen": resumen,
                                "sid": sid, "archivos": archivos, "creada": ReunionesRouter.iso(creada), "estado": estado]
        o["revisada"] = revisada.map { ReunionesRouter.iso($0) as Any } ?? NSNull()
        o["padre"] = padre.map { $0 as Any } ?? NSNull()
        o["costo"] = costo.map { $0 as Any } ?? NSNull()
        return o
    }

    public var jsonCompleto: [String: Any] { var o = json; o["texto"] = texto; return o }
}

enum TextoEntrega {
    static let maxTexto = 100_000

    static func resumen(_ t: String) -> String {
        let s = t.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return s.count > 280 ? String(s.prefix(279)) + "…" : s
    }

    /// Título corto a partir de un pedido de chat.
    static func titulo(_ t: String) -> String {
        let s = t.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return s.count > 70 ? String(s.prefix(69)) + "…" : s
    }
}

/// Qué archivos escritos cuentan para una entrega.
enum ArchivosEntrega {
    static let carpetaEntregables = "archivos/entregables/"
    /// Notas internas que los agentes tocan seguido: no son trabajo para revisar.
    static let ignorados = [".claude/", "conocimiento/agentes/"]

    /// Rutas relativas a `carpeta`, sin repetir, de las que caen dentro de la oficina (las de afuera se descartan).
    static func relativos(_ rutas: [String], carpeta: String) -> [String] {
        let bases = Set([(carpeta as NSString).standardizingPath,
                         URL(fileURLWithPath: carpeta).resolvingSymlinksInPath().path]).map { $0.hasSuffix("/") ? $0 : $0 + "/" }
        var out: [String] = []
        for r in rutas {
            let abs = r.hasPrefix("/") ? r : (carpeta as NSString).appendingPathComponent(r)
            let cands = [(abs as NSString).standardizingPath, URL(fileURLWithPath: abs).resolvingSymlinksInPath().path]
            var rel: String?
            for c in cands { for b in bases where c.hasPrefix(b) { rel = String(c.dropFirst(b.count)); break }; if rel != nil { break } }
            guard let rel, !rel.isEmpty, !rel.split(separator: "/").contains(".."),
                  !ignorados.contains(where: { rel.hasPrefix($0) }), !out.contains(rel) else { continue }
            out.append(rel)
        }
        return out
    }

    static func enEntregables(_ rels: [String]) -> [String] { rels.filter { $0.hasPrefix(carpetaEntregables) } }
}

// MARK: - SQLite

extension Store {
    func prepararEntregas() throws {
        try db.exec("""
        CREATE TABLE IF NOT EXISTS entregas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            oficina TEXT NOT NULL,
            agente TEXT NOT NULL DEFAULT '',
            origen TEXT NOT NULL,
            ref TEXT NOT NULL DEFAULT '',
            titulo TEXT NOT NULL,
            texto TEXT NOT NULL DEFAULT '',
            sid TEXT NOT NULL DEFAULT '',
            archivos TEXT NOT NULL DEFAULT '[]',
            creada REAL NOT NULL,
            estado TEXT NOT NULL DEFAULT 'sin_revisar',
            revisada REAL,
            padre INTEGER,
            costo REAL
        );
        CREATE INDEX IF NOT EXISTS entregas_oficina ON entregas(oficina, estado, id);
        """)
    }

    private static let columnasEntrega = "id,oficina,agente,origen,ref,titulo,texto,sid,archivos,creada,estado,revisada,padre,costo"

    private static func entrega(_ r: SQLRow) -> Entrega {
        let arch = (try? JSONSerialization.jsonObject(with: Data(r.text(8).utf8))) as? [String] ?? []
        return Entrega(id: r.int(0), oficina: r.text(1), agente: r.text(2), origen: r.text(3), ref: r.text(4), titulo: r.text(5),
                       texto: r.text(6), sid: r.text(7), archivos: arch, creada: r.double(9), estado: r.text(10),
                       revisada: r.isNull(11) ? nil : r.double(11), padre: r.isNull(12) ? nil : r.int(12),
                       costo: r.isNull(13) ? nil : r.double(13))
    }

    @discardableResult
    public func entregaCrear(oficina: String, agente: String, origen: String, ref: String, titulo: String, texto: String,
                             sid: String = "", archivos: [String] = [], padre: Int64? = nil, costo: Double? = nil) -> Entrega? {
        try? prepararEntregas()
        let ahora = Date().timeIntervalSince1970
        let t = texto.count > TextoEntrega.maxTexto ? String(texto.prefix(TextoEntrega.maxTexto)) : texto
        let arch = (try? JSONSerialization.data(withJSONObject: archivos)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        let tit = titulo.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (try? db.run("""
            INSERT INTO entregas(oficina,agente,origen,ref,titulo,texto,sid,archivos,creada,padre,costo) VALUES(?,?,?,?,?,?,?,?,?,?,?)
            """, [.text(oficina), .text(agente), .text(origen), .text(ref), .text(tit.isEmpty ? "Entrega" : tit), .text(t), .text(sid),
                  .text(arch), .double(ahora), padre.map { .int($0) } ?? .null, costo.map { .double($0) } ?? .null])) != nil,
              let id = (try? db.query("SELECT last_insert_rowid()") { $0.int(0) })?.first else { return nil }
        return entrega(oficina: oficina, id: id)
    }

    public func entrega(oficina: String, id: Int64) -> Entrega? {
        try? prepararEntregas()
        return (try? db.query("SELECT \(Store.columnasEntrega) FROM entregas WHERE oficina=? AND id=?",
                              [.text(oficina), .int(id)], Store.entrega))?.first
    }

    /// De la más nueva a la más vieja. Filtros opcionales.
    public func entregas(oficina: String, estado: String? = nil, agente: String? = nil, origen: String? = nil, limite: Int = 100) -> [Entrega] {
        try? prepararEntregas()
        var sql = "SELECT \(Store.columnasEntrega) FROM entregas WHERE oficina=?"
        var p: [SQLValue] = [.text(oficina)]
        if let estado { sql += " AND estado=?"; p.append(.text(estado)) }
        if let agente { sql += " AND agente=?"; p.append(.text(agente)) }
        if let origen { sql += " AND origen=?"; p.append(.text(origen)) }
        sql += " ORDER BY id DESC LIMIT ?"
        p.append(.int(Int64(max(1, min(limite, 500)))))
        return (try? db.query(sql, p, Store.entrega)) ?? []
    }

    public func entregasSinRevisar(oficina: String) -> Int {
        try? prepararEntregas()
        return (try? db.query("SELECT COUNT(*) FROM entregas WHERE oficina=? AND estado='sin_revisar'", [.text(oficina)]) { Int($0.int(0)) })?.first ?? 0
    }

    /// Cambia el estado. `revisada` guarda cuándo; volver a `sin_revisar` lo borra.
    @discardableResult
    public func entregaMarcar(oficina: String, id: Int64, estado: String) -> Entrega? {
        guard Entrega.estados.contains(estado) else { return nil }
        try? prepararEntregas()
        let cuando: SQLValue = estado == "revisada" ? .double(Date().timeIntervalSince1970) : .null
        _ = try? db.run("UPDATE entregas SET estado=?, revisada=? WHERE oficina=? AND id=?", [.text(estado), cuando, .text(oficina), .int(id)])
        return entrega(oficina: oficina, id: id)
    }
}

// MARK: - registro (lo usan programador, chat y reuniones)

enum RegistroEntregas {
    /// Crea la entrega y avisa a la app nativa (notificación «te entregó»). Devuelve nil si no se pudo guardar.
    @discardableResult
    static func registrar(_ store: Store, _ canal: CanalAvisos, oficina: String, agente: String, nombre: String, origen: String,
                          ref: String, titulo: String, texto: String, sid: String = "", archivos: [String] = [],
                          padre: Int64? = nil, costo: Double? = nil) async -> Entrega? {
        guard let e = await store.entregaCrear(oficina: oficina, agente: agente, origen: origen, ref: ref, titulo: titulo, texto: texto,
                                               sid: sid, archivos: archivos, padre: padre, costo: costo) else { return nil }
        canal.emitir(Aviso(id: "e\(e.id)", tipo: "entrega", agente: agente, texto: e.titulo, ref: String(e.id), creado: e.creada),
                     nombre: nombre)
        return e
    }
}
