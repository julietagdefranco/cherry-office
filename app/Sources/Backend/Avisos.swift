import Foundation

/// «Te necesita» (#2). Dos clases de avisos:
/// - guardados: una respuesta lista, un error, una tarea programada que terminó. Se marcan como vistos.
/// - calculados al leer: una reunión que espera tu intervención, propuestas de la biblioteca sin resolver. Desaparecen
///   solos cuando se resuelve lo que los causa (no hay que marcarlos).
public struct Aviso: Sendable, Equatable {
    public var id: String          // "a<n>" guardado | "reunion:<id>" | "flujo:<corrida>" | "propuestas"
    public var tipo: String        // respuesta | error | tarea | reunion | flujo | propuestas
    public var agente: String
    public var texto: String
    public var ref: String
    public var creado: Double

    public var json: [String: Any] {
        ["id": id, "tipo": tipo, "agente": agente, "texto": texto, "ref": ref, "creado": creado]
    }
}

extension Store {
    func prepararAvisos() throws {
        try db.exec("""
        CREATE TABLE IF NOT EXISTS avisos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            oficina TEXT NOT NULL,
            tipo TEXT NOT NULL,
            agente TEXT NOT NULL DEFAULT '',
            texto TEXT NOT NULL,
            ref TEXT NOT NULL DEFAULT '',
            creado REAL NOT NULL,
            visto INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS avisos_oficina ON avisos(oficina, visto);
        """)
    }

    /// Crea un aviso. Si ya hay uno sin ver del mismo tipo y agente, lo reemplaza (no se apilan «te respondió»).
    @discardableResult
    public func avisoCrear(oficina: String, tipo: String, agente: String = "", texto: String, ref: String = "") -> Aviso? {
        try? prepararAvisos()
        let ahora = Date().timeIntervalSince1970
        _ = try? db.run("UPDATE avisos SET visto=1 WHERE oficina=? AND tipo=? AND agente=? AND visto=0 AND agente<>''",
                        [.text(oficina), .text(tipo), .text(agente)])
        guard (try? db.run("INSERT INTO avisos(oficina,tipo,agente,texto,ref,creado) VALUES(?,?,?,?,?,?)",
                           [.text(oficina), .text(tipo), .text(agente), .text(texto), .text(ref), .double(ahora)])) != nil,
              let id = (try? db.query("SELECT last_insert_rowid()") { $0.int(0) })?.first else { return nil }
        return Aviso(id: "a\(id)", tipo: tipo, agente: agente, texto: texto, ref: ref, creado: ahora)
    }

    /// Marca como vistos: un aviso guardado (`id` "a<n>"), una reunión que espera (`id` "reunion:<id>"),
    /// todos los de un agente, o todos los de la oficina.
    @discardableResult
    public func avisosVistos(oficina: String, id: String? = nil, agente: String? = nil) -> Int {
        try? prepararAvisos()
        if let id, id.hasPrefix("flujo:") {
            guard let n = Int64(id.dropFirst("flujo:".count)) else { return 0 }
            return corridaVista(oficina: oficina, id: n) ? 1 : 0
        }
        if let id, id.hasPrefix("reunion:") {
            try? prepararVistaReuniones()
            return (try? db.run("UPDATE reuniones SET vista=1 WHERE oficina=? AND id=? AND estado='esperando'",
                                [.text(oficina), .text(String(id.dropFirst("reunion:".count)))])) ?? 0
        }
        if let id {
            guard id.hasPrefix("a"), let n = Int64(id.dropFirst()) else { return 0 }
            return (try? db.run("UPDATE avisos SET visto=1 WHERE oficina=? AND id=?", [.text(oficina), .int(n)])) ?? 0
        }
        if let agente {
            return (try? db.run("UPDATE avisos SET visto=1 WHERE oficina=? AND agente=? AND visto=0", [.text(oficina), .text(agente)])) ?? 0
        }
        return (try? db.run("UPDATE avisos SET visto=1 WHERE oficina=? AND visto=0", [.text(oficina)])) ?? 0
    }

    /// Pendientes de la oficina, del más viejo al más nuevo: guardados sin ver + calculados.
    public func avisosPendientes(oficina: String) -> [Aviso] {
        try? prepararAvisos()
        var out = (try? db.query("SELECT id,tipo,agente,texto,ref,creado FROM avisos WHERE oficina=? AND visto=0 ORDER BY id",
                                 [.text(oficina)]) {
            Aviso(id: "a\($0.int(0))", tipo: $0.text(1), agente: $0.text(2), texto: $0.text(3), ref: $0.text(4), creado: $0.double(5))
        }) ?? []
        // reuniones que esperan al usuario y que todavía no abrió (la tabla existe si las reuniones están instaladas)
        try? prepararVistaReuniones()
        let reus = (try? db.query("SELECT id,tema,creada FROM reuniones WHERE oficina=? AND estado='esperando' AND vista IS NULL ORDER BY creada",
                                  [.text(oficina)]) { ($0.text(0), $0.text(1), $0.double(2)) }) ?? []
        for (id, tema, creada) in reus {
            out.append(Aviso(id: "reunion:\(id)", tipo: "reunion", agente: "", texto: "La reunión «\(tema)» te espera",
                             ref: id, creado: creada))
        }
        // corridas de flujos que esperan a la persona y todavía no vio
        for c in corridasEsperandoPersona(oficina: oficina) {
            let paso = c.resumenPaso.nombre
            out.append(Aviso(id: "flujo:\(c.id)", tipo: "flujo", agente: "", texto: "«\(c.nombre)» te necesita: \(paso)",
                             ref: String(c.id), creado: c.actualizada))
        }
        if let (n, desde) = (try? db.query("SELECT COUNT(*), MIN(creada) FROM propuestas WHERE oficina=? AND estado='pendiente'",
                                           [.text(oficina)]) { ($0.int(0), $0.double(1)) })?.first, n > 0 {
            out.append(Aviso(id: "propuestas", tipo: "propuestas", agente: "",
                             texto: n == 1 ? "Hay 1 propuesta de la biblioteca para revisar" : "Hay \(n) propuestas de la biblioteca para revisar",
                             ref: "", creado: desde))
        }
        return out.sorted { $0.creado < $1.creado }
    }
}

/// Avisa a la app nativa cuando se crea un aviso guardado (notificación de macOS). Lo setea la app al arrancar.
public final class CanalAvisos: @unchecked Sendable {
    private let lock = NSLock()
    private var fn: (@Sendable (Aviso, String) -> Void)?
    public init() {}
    /// `alCrear(aviso, nombreDelAgente)`.
    public func alCrear(_ f: @escaping @Sendable (Aviso, String) -> Void) { lock.lock(); fn = f; lock.unlock() }
    func emitir(_ a: Aviso, nombre: String) { lock.lock(); let f = fn; lock.unlock(); f?(a, nombre) }
}

enum TextoAviso {
    static func respuesta(_ texto: String) -> String {
        let t = texto.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return t.count > 90 ? String(t.prefix(89)) + "…" : t
    }
}
