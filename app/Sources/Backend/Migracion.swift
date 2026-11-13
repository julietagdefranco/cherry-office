import Foundation

/// Importa los datos del server Python (una sola vez, idempotente, marcada en `meta`):
/// `.sesiones.json`, `.datos/hq.db` y, best effort, los transcripts de ~/.claude/projects.
/// Nunca mueve ni borra nada de las carpetas de origen.
public enum Migracion {
    static let clave = "migracion_legacy_v1"

    public struct Resultado: Sendable, Equatable {
        public var hecha = false          // se procesó al menos una carpeta de origen
        public var yaHabiaCorrido = false
        public var sesiones = 0
        public var mensajes = 0
        public var desdeTranscripts = 0
    }

    @discardableResult
    public static func ejecutar(store: Store, config: Config, log: HQLog,
                                env: [String: String] = ProcessInfo.processInfo.environment) async -> Resultado {
        var res = Resultado()
        if await store.meta(clave) != nil { res.yaHabiaCorrido = true; return res }
        var dirs = config.legacyDirs
        if let e = env["HQ_LEGACY_DIR"], !e.isEmpty { dirs.insert(Config.ruta(e, home: config.home), at: 0) }
        var visto = Set<String>()
        dirs = dirs.filter { visto.insert($0).inserted }

        var huerfanas: [(sid: String, agente: String)] = []
        for d in dirs {
            let json = (d as NSString).appendingPathComponent(".sesiones.json")
            let dbp = ((d as NSString).appendingPathComponent(".datos") as NSString).appendingPathComponent("hq.db")
            let fm = FileManager.default
            guard fm.fileExists(atPath: json) || fm.fileExists(atPath: dbp) else { continue }
            res.hecha = true
            var lote = LoteImportacion()
            leerSesionesJSON(json, into: &lote)
            leerBaseVieja(dbp, into: &lote)
            do {
                let r = try await store.importar(lote)
                res.sesiones += r.sesiones; res.mensajes += r.mensajes
            } catch {
                log.error("migracion: no pude importar un origen (\(error))")
                continue
            }
            for s in lote.sesiones { huerfanas.append((s.sid, s.agente)) }
        }

        // transcripts: solo para sesiones que quedaron sin mensajes
        var lote2 = LoteImportacion()
        for s in huerfanas {
            if await store.cuentaMensajes(s.sid) != 0 { continue }
            let turnos = Transcripts.turnos(sid: s.sid, proyecto: config.proyecto, home: config.home)
            for t in turnos { lote2.mensajes.append(.init(sid: s.sid, r: t.r, t: t.t, e: false, ts: t.ts)) }
        }
        if !lote2.mensajes.isEmpty, let r = try? await store.importar(lote2) { res.desdeTranscripts = r.mensajes }

        if res.hecha {
            try? await store.setMeta(clave, "\(Date().timeIntervalSince1970)")
            log.info("migracion sesiones=\(res.sesiones) mensajes=\(res.mensajes) transcripts=\(res.desdeTranscripts)")
        }
        return res
    }

    /// `.sesiones.json`: {sid: agente}; todas se consideran activas (ya existen en claude).
    static func leerSesionesJSON(_ path: String, into lote: inout LoteImportacion) {
        guard let d = FileManager.default.contents(atPath: path),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
        let ahora = Date().timeIntervalSince1970
        for (sid, a) in o {
            guard Router.uuidValido(sid), let ag = a as? String, !ag.isEmpty else { continue }
            lote.sesiones.append(.init(sid: sid.lowercased(), agente: ag, activa: true, creada: ahora))
        }
    }

    /// Base vieja de Python: sesiones(sid,agente,activa,creada,...) y mensajes(sid,r,t,e,ts). Solo lectura.
    static func leerBaseVieja(_ path: String, into lote: inout LoteImportacion) {
        guard FileManager.default.fileExists(atPath: path), let db = try? SQLiteDB(path: path, readOnly: true) else { return }
        defer { db.close() }
        if let ss = try? db.query("SELECT sid,agente,activa,creada FROM sesiones", [], { r in
            LoteImportacion.Sesion(sid: r.text(0).lowercased(), agente: r.text(1), activa: r.int(2) != 0, creada: r.double(3))
        }) {
            let ya = Set(lote.sesiones.map(\.sid))
            lote.sesiones += ss.filter { Router.uuidValido($0.sid) && !$0.agente.isEmpty && !ya.contains($0.sid) }
        }
        if let ms = try? db.query("SELECT sid,r,t,e,ts FROM mensajes ORDER BY id", [], { r in
            LoteImportacion.Msg(sid: r.text(0).lowercased(), r: r.text(1), t: r.text(2), e: r.int(3) != 0, ts: r.double(4))
        }) {
            lote.mensajes += ms
        }
    }
}

/// Lee transcripts de Claude Code (~/.claude/projects/<cwd codificado>/<sid>.jsonl). Formato interno: todo es best effort.
enum Transcripts {
    struct Turno { var r: String; var t: String; var ts: Double }

    /// Claude codifica la carpeta reemplazando todo lo que no es [A-Za-z0-9] por "-".
    static func codificar(_ cwd: String) -> String {
        String(cwd.unicodeScalars.map { u in
            (u.value < 128 && CharacterSet.alphanumerics.contains(u)) ? Character(u) : "-"
        })
    }

    static func archivo(sid: String, proyecto: String, home: String) -> String? {
        let fm = FileManager.default
        let base = (home as NSString).appendingPathComponent(".claude/projects")
        let directo = "\(base)/\(codificar(proyecto))/\(sid).jsonl"
        if fm.fileExists(atPath: directo) { return directo }
        // fallback: cualquier carpeta de proyectos que lo tenga (otra codificación)
        for d in (try? fm.contentsOfDirectory(atPath: base)) ?? [] {
            let p = "\(base)/\(d)/\(sid).jsonl"
            if fm.fileExists(atPath: p) { return p }
        }
        return nil
    }

    /// Un turno por cada mensaje de texto del usuario; la respuesta es el último texto del asistente antes del
    /// siguiente mensaje del usuario (lo mismo que devolvía `result`). Ignora sidechains, meta y tool_result.
    static func turnos(sid: String, proyecto: String, home: String) -> [Turno] {
        guard let p = archivo(sid: sid, proyecto: proyecto, home: home),
              let data = FileManager.default.contents(atPath: p) else { return [] }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso2 = ISO8601DateFormatter()
        var out: [Turno] = []
        var ultimoAsistente: Turno?
        func cerrar() { if let a = ultimoAsistente { out.append(a); ultimoAsistente = nil } }

        for linea in data.split(separator: UInt8(ascii: "\n")) {
            guard let o = (try? JSONSerialization.jsonObject(with: linea)) as? [String: Any],
                  let tipo = o["type"] as? String, tipo == "user" || tipo == "assistant",
                  (o["isSidechain"] as? Bool) != true, (o["isMeta"] as? Bool) != true,
                  let msg = o["message"] as? [String: Any] else { continue }
            let ts = (o["timestamp"] as? String).flatMap { iso.date(from: $0) ?? iso2.date(from: $0) }?
                .timeIntervalSince1970 ?? 0
            var texto = ""
            if let s = msg["content"] as? String { texto = s }
            else if let bloques = msg["content"] as? [[String: Any]] {
                texto = bloques.compactMap { ($0["type"] as? String) == "text" ? $0["text"] as? String : nil }
                    .joined(separator: "\n")
            }
            texto = texto.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !texto.isEmpty else { continue }
            if tipo == "user" {
                if texto.hasPrefix("<command-") || texto.hasPrefix("<local-command") || texto.hasPrefix("<system-reminder") { continue }
                cerrar()
                out.append(Turno(r: "u", t: texto, ts: ts))
            } else {
                ultimoAsistente = Turno(r: "a", t: texto, ts: ts)
            }
        }
        cerrar()
        return out
    }
}
