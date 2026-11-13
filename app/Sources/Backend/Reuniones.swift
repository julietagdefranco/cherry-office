import Foundation

// Reuniones: varios agentes opinan por rondas sobre un tema; el usuario interviene; al cerrar sale una
// síntesis con decisiones que queda en `reuniones/AAAA-MM-DD-<tema>.md` y en `conocimiento/decisiones.md`.
// Misma API, mismos archivos y mismos prompts que tools/hq_reuniones.py (modo desarrollo): si cambia una, cambia la otra.

// MARK: - modelo

struct TurnoReunion: Sendable, Equatable {
    var ronda: Int
    /// id del agente o "usuario"
    var agente: String
    var texto: String
    var error: Bool
    var ts: Double
}

struct Pendiente: Sendable, Equatable {
    var quien: String
    var que: String
}

struct SintesisReunion: Sendable, Equatable {
    var resumen: String
    var decisiones: [String]
    var pendientes: [Pendiente]

    var json: [String: Any] {
        ["resumen": resumen, "decisiones": decisiones, "pendientes": pendientes.map { ["quien": $0.quien, "que": $0.que] }]
    }
}

struct ReunionFila: Sendable {
    var id: String
    var oficina: String
    var tema: String
    var agentes: [String]
    var estado: String
    var creada: Double
    var cerrada: Double?
    var sintesis: String?
    var errorSintesis: String?
    var acta: String?
    var error: String?
    /// slugs de documentos de la biblioteca adjuntos al tema (su ficha entra en el prompt de cada turno).
    var documentos: [String] = []
    /// patrón de reunión: ver `PatronReunion` (debate si la fila es anterior a la fase 3).
    var patron: String = "debate"
    var lider: String?
    /// {"a":[ids],"b":[ids]} solo en red/blue.
    var bandos: [String: [String]]?
    /// ruta relativa (dentro de `archivos/`) del archivo que se escribe al cerrar.
    var salida: String?
}

// MARK: - SQLite (tablas `reuniones` y `turnos`, con clave de oficina)

extension Store {
    /// Crea las tablas si faltan y deja en `esperando` las reuniones que estaban en curso al apagarse la app.
    func prepararReuniones() throws {
        try db.exec("""
        CREATE TABLE IF NOT EXISTS reuniones (
            id TEXT PRIMARY KEY,
            oficina TEXT NOT NULL,
            tema TEXT NOT NULL,
            agentes TEXT NOT NULL,
            estado TEXT NOT NULL,
            creada REAL NOT NULL,
            cerrada REAL,
            sintesis TEXT,
            error_sintesis TEXT,
            acta TEXT,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS reuniones_oficina ON reuniones(oficina, creada);
        CREATE TABLE IF NOT EXISTS turnos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reunion TEXT NOT NULL REFERENCES reuniones(id),
            oficina TEXT NOT NULL,
            ronda INTEGER NOT NULL,
            agente TEXT NOT NULL,
            texto TEXT NOT NULL,
            error INTEGER NOT NULL DEFAULT 0,
            ts REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS turnos_reunion ON turnos(reunion, id);
        """)
        let cols = try db.query("PRAGMA table_info(reuniones)") { $0.text(1) }
        if !cols.contains("documentos") { try db.exec("ALTER TABLE reuniones ADD COLUMN documentos TEXT") }
        for (c, tipo) in [("patron", "TEXT"), ("lider", "TEXT"), ("bandos", "TEXT"), ("salida", "TEXT")] where !cols.contains(c) {
            try db.exec("ALTER TABLE reuniones ADD COLUMN \(c) \(tipo)")
        }
        try db.run("UPDATE reuniones SET estado='esperando' WHERE estado='en_curso'")
    }

    private static func fila(_ r: SQLRow) -> ReunionFila {
        let ags = (try? JSONSerialization.jsonObject(with: Data(r.text(3).utf8))) as? [String] ?? []
        return ReunionFila(id: r.text(0), oficina: r.text(1), tema: r.text(2), agentes: ags, estado: r.text(4),
                           creada: r.double(5), cerrada: r.isNull(6) ? nil : r.double(6),
                           sintesis: r.isNull(7) ? nil : r.text(7), errorSintesis: r.isNull(8) ? nil : r.text(8),
                           acta: r.isNull(9) ? nil : r.text(9), error: r.isNull(10) ? nil : r.text(10),
                           documentos: r.isNull(11) ? [] : ((try? JSONSerialization.jsonObject(with: Data(r.text(11).utf8))) as? [String] ?? []),
                           patron: r.isNull(12) ? "debate" : r.text(12), lider: r.isNull(13) ? nil : r.text(13),
                           bandos: r.isNull(14) ? nil : (try? JSONSerialization.jsonObject(with: Data(r.text(14).utf8))) as? [String: [String]],
                           salida: r.isNull(15) ? nil : r.text(15))
    }

    private static let columnasReunion = "id,oficina,tema,agentes,estado,creada,cerrada,sintesis,error_sintesis,acta,error,documentos,patron,lider,bandos,salida"

    func reunionCrear(id: String, oficina: String, tema: String, agentes: [String], documentos: [String] = [],
                      patron: String = "debate", lider: String? = nil, bandos: [String: [String]]? = nil, salida: String? = nil) throws {
        let ags = String(data: (try? JSONSerialization.data(withJSONObject: agentes)) ?? Data("[]".utf8), encoding: .utf8) ?? "[]"
        let docs = String(data: (try? JSONSerialization.data(withJSONObject: documentos)) ?? Data("[]".utf8), encoding: .utf8) ?? "[]"
        let bj = bandos.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }.flatMap { String(data: $0, encoding: .utf8) }
        try db.run("INSERT INTO reuniones(id,oficina,tema,agentes,estado,creada,documentos,patron,lider,bandos,salida) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                   [.text(id), .text(oficina), .text(tema), .text(ags), .text("esperando"), .double(Date().timeIntervalSince1970),
                    documentos.isEmpty ? .null : .text(docs), .text(patron), lider.map { .text($0) } ?? .null,
                    bj.map { .text($0) } ?? .null, salida.map { .text($0) } ?? .null])
    }

    /// Ruta final del archivo de salida (puede diferir de la pedida si ya existía una con ese nombre).
    func reunionSalida(_ id: String, _ salida: String) throws {
        try db.run("UPDATE reuniones SET salida=? WHERE id=?", [.text(salida), .text(id)])
    }

    func reunion(_ id: String, oficina: String) -> ReunionFila? {
        (try? db.query("SELECT \(Store.columnasReunion) FROM reuniones WHERE id=? AND oficina=?", [.text(id), .text(oficina)], Store.fila))?.first
    }

    func reunionesDe(oficina: String) -> [ReunionFila] {
        (try? db.query("SELECT \(Store.columnasReunion) FROM reuniones WHERE oficina=? ORDER BY creada DESC", [.text(oficina)], Store.fila)) ?? []
    }

    func reunionEstado(_ id: String, _ estado: String, error: String? = nil) throws {
        try db.run("UPDATE reuniones SET estado=?, error=? WHERE id=?", [.text(estado), error.map { .text($0) } ?? .null, .text(id)])
    }

    func reunionCerrar(_ id: String, sintesis: String?, errorSintesis: String?, acta: String?, error: String?) throws {
        try db.run("UPDATE reuniones SET estado='cerrada', cerrada=?, sintesis=?, error_sintesis=?, acta=?, error=? WHERE id=?",
                   [.double(Date().timeIntervalSince1970), sintesis.map { .text($0) } ?? .null,
                    errorSintesis.map { .text($0) } ?? .null, acta.map { .text($0) } ?? .null,
                    error.map { .text($0) } ?? .null, .text(id)])
    }

    func turnoAgregar(reunion: String, oficina: String, ronda: Int, agente: String, texto: String, error: Bool) throws {
        try db.run("INSERT INTO turnos(reunion,oficina,ronda,agente,texto,error,ts) VALUES(?,?,?,?,?,?,?)",
                   [.text(reunion), .text(oficina), .int(Int64(ronda)), .text(agente), .text(texto), .int(error ? 1 : 0),
                    .double(Date().timeIntervalSince1970)])
    }

    func turnosDe(reunion: String) -> [TurnoReunion] {
        (try? db.query("SELECT ronda,agente,texto,error,ts FROM turnos WHERE reunion=? ORDER BY id", [.text(reunion)]) {
            TurnoReunion(ronda: Int($0.int(0)), agente: $0.text(1), texto: $0.text(2), error: $0.int(3) != 0, ts: $0.double(4))
        }) ?? []
    }
}

// MARK: - textos y heurísticas (puros, mismos que hq_reuniones.py)

enum ReunionTexto {
    static let maxMemoria = 2000
    static let maxDecisiones = 15
    static let maxTranscripcionTurno = 12_000
    static let maxTranscripcionActa = 40_000

    static let vacias: Set<String> = [
        "para", "como", "sobre", "este", "esta", "esto", "estos", "estas", "entre", "desde", "hasta", "cuando", "donde",
        "porque", "pero", "tiene", "tener", "hacer", "queremos", "podemos", "vamos", "nuestro", "nuestra", "nuestros",
        "nuestras", "algo", "cada", "todo", "toda", "todos", "todas", "otro", "otra", "otros", "otras", "mucho", "mucha",
        "tambien", "ademas", "hacia", "segun", "tema", "reunion", "ronda",
    ]

    static func plano(_ s: String) -> String {
        s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
    }

    static func palabras(_ s: String) -> [String] {
        var out: [String] = [], cur = ""
        for u in plano(s).unicodeScalars {
            if u.isASCII, (u.value >= 48 && u.value <= 57) || (u.value >= 97 && u.value <= 122) { cur.unicodeScalars.append(u) }
            else { if !cur.isEmpty { out.append(cur) }; cur = "" }
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    static func coincide(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        guard a.count >= 5, b.count >= 5 else { return false }
        return a.prefix(5) == b.prefix(5)
    }

    /// Agentes cuyo rol/departamento (peso 2) o brief/chips (peso 1) tienen más palabras del tema, primero; el resto detrás.
    /// Estable: a igual puntaje se respeta el orden en que vinieron.
    static func ordenar(_ agentes: [AgenteDef], oficina: Oficina, tema: String) -> [AgenteDef] {
        var vistos = Set<String>(), claves: [String] = []
        for p in palabras(tema) where p.count >= 4 && !vacias.contains(p) && !vistos.contains(p) { vistos.insert(p); claves.append(p) }
        func puntaje(_ a: AgenteDef) -> Int {
            let fuerte = palabras(a.rol + " " + (oficina.departamento(a.departamento)?.nombre ?? ""))
            let debil = palabras((a.brief ?? "") + " " + (a.chips ?? []).joined(separator: " "))
            var s = 0
            for c in claves {
                if fuerte.contains(where: { coincide($0, c) }) { s += 2 }
                else if debil.contains(where: { coincide($0, c) }) { s += 1 }
            }
            return s
        }
        let con = agentes.enumerated().map { (i, a) in (i, a, puntaje(a)) }
        return con.sorted { $0.2 != $1.2 ? $0.2 > $1.2 : $0.0 < $1.0 }.map { $0.1 }
    }

    static func leer(_ path: String) -> String { (try? String(contentsOfFile: path, encoding: .utf8)) ?? "" }

    static func memoria(carpeta: String) -> String {
        let t = leer((carpeta as NSString).appendingPathComponent("conocimiento/oficina.md")).trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return "(sin memoria común todavía)" }
        return t.count > maxMemoria ? String(t.prefix(maxMemoria)) + "…" : t
    }

    static func decisiones(carpeta: String) -> String {
        let lineas = leer((carpeta as NSString).appendingPathComponent("conocimiento/decisiones.md"))
            .split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { $0.hasPrefix("- ") }
        if lineas.isEmpty { return "(todavía no hay decisiones registradas)" }
        return lineas.suffix(maxDecisiones).joined(separator: "\n")
    }

    static func nombreDe(_ id: String, oficina: Oficina) -> String {
        if id == "usuario" { return oficina.duenio.isEmpty ? "Usuario" : "\(oficina.duenio) (dueño de la oficina)" }
        return oficina.agente(id)?.nombre ?? id
    }

    /// Transcripción "Nombre: texto" con separadores de ronda; si pasa de `max` se descartan los turnos más viejos.
    static func transcripcion(_ turnos: [TurnoReunion], oficina: Oficina, conRol: Bool = false, max: Int) -> String {
        var bloques: [String] = [], ultima = -1
        for t in turnos where !t.error {
            var b = ""
            if t.ronda != ultima, t.ronda > 0 { b += "— Ronda \(t.ronda) —\n"; ultima = t.ronda }
            var n = nombreDe(t.agente, oficina: oficina)
            if conRol, let a = oficina.agente(t.agente) { n += " (\(a.rol))" }
            b += "\(n): \(t.texto)"
            bloques.append(b)
        }
        var out = bloques.joined(separator: "\n\n")
        if out.count > max { out = "[…]\n" + String(out.suffix(max)) }
        return out
    }

    static let maxFicha = 2500
    static let maxFichas = 8000

    /// Fichas (`conocimiento/fuentes/<slug>.md`) de los documentos adjuntos al tema, recortadas.
    static func fichas(carpeta: String, documentos: [String]) -> String {
        var out: [String] = [], total = 0
        for slug in documentos {
            var t = leer((carpeta as NSString).appendingPathComponent("conocimiento/fuentes/\(slug).md")).trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { continue }
            if t.count > maxFicha { t = String(t.prefix(maxFicha)) + "…" }
            if total + t.count > maxFichas { break }
            total += t.count
            out.append(t)
        }
        return out.joined(separator: "\n\n---\n\n")
    }

    static func promptTurno(oficina: Oficina, carpeta: String, tema: String, participantes: [AgenteDef], quien: AgenteDef,
                            turnos: [TurnoReunion], ronda: Int, fichas: String = "",
                            patron: PatronReunion = .debate, fase: FaseTurno = .libre, lider: AgenteDef? = nil,
                            bandoA: [AgenteDef] = [], bandoB: [AgenteDef] = []) -> String {
        let gente = participantes.map { "\($0.nombre) (\($0.rol))" }.joined(separator: ", ")
        let dicho = transcripcion(ReunionPatron.visibles(patron: patron, turnos: turnos, ronda: ronda), oficina: oficina, max: maxTranscripcionTurno)
        let docs = fichas.isEmpty ? "" : "\n\nDocumentos adjuntos a la reunión (fichas de la biblioteca; el texto completo está en archivos/.texto/<slug>.md):\n\(fichas)"
        return """
        Estás en una reunión de la oficina «\(oficina.nombre)». Tema de la reunión:
        \(tema)

        Participantes: \(gente)

        Memoria común de la oficina:
        \(memoria(carpeta: carpeta))

        Decisiones recientes:
        \(decisiones(carpeta: carpeta))\(docs)

        Lo que se dijo hasta ahora (estamos en la ronda \(ronda)):
        \(dicho.isEmpty ? "(todavía no habló nadie)" : dicho)

        \(ReunionPatron.consigna(patron: patron, fase: fase, quien: quien, lider: lider, bandoA: bandoA, bandoB: bandoB))
        """
    }

    static func promptSintesis(oficina: Oficina, tema: String, participantes: [AgenteDef], turnos: [TurnoReunion],
                               patron: PatronReunion = .debate, lider: AgenteDef? = nil,
                               bandoA: [AgenteDef] = [], bandoB: [AgenteDef] = []) -> String {
        let gente = participantes.map { "\($0.nombre) (\($0.rol))" }.joined(separator: ", ")
        return """
        Sos el secretario de actas de la oficina «\(oficina.nombre)». Tema de la reunión: \(tema)
        Participantes: \(gente)

        Transcripción:
        \(transcripcion(turnos, oficina: oficina, conRol: true, max: maxTranscripcionActa))

        Devolvé SOLO un objeto JSON estricto (sin texto antes ni después, sin bloques de código) con esta forma:
        {"resumen": "resumen de la reunión en 3-6 oraciones", "decisiones": ["decisión concreta confirmada por la conversación"], "pendientes": [{"quien": "nombre de quien se encarga", "que": "tarea concreta"}]}
        Incluí en "decisiones" solo lo que quedó razonablemente acordado (puede ser una lista vacía) y en "pendientes" los próximos pasos con responsable.\(ReunionPatron.varianteSintesis(patron: patron, lider: lider, bandoA: bandoA, bandoB: bandoB))
        """
    }

    /// Extrae el objeto JSON de la respuesta (con o sin ```json) y lo normaliza. nil si no hay forma de leerlo.
    static func parsearSintesis(_ t: String) -> SintesisReunion? {
        guard let a = t.firstIndex(of: "{"), let b = t.lastIndex(of: "}"), a < b,
              let d = String(t[a...b]).data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
        func cadena(_ v: Any?) -> String { ((v as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
        let resumen = cadena(o["resumen"])
        let decisiones = ((o["decisiones"] as? [Any]) ?? []).map(cadena).filter { !$0.isEmpty }
        var pend: [Pendiente] = []
        for p in (o["pendientes"] as? [Any]) ?? [] {
            if let m = p as? [String: Any] { let q = cadena(m["quien"]), k = cadena(m["que"]); if !k.isEmpty { pend.append(Pendiente(quien: q, que: k)) } }
            else if let s = p as? String, !cadena(s).isEmpty { pend.append(Pendiente(quien: "", que: cadena(s))) }
        }
        if resumen.isEmpty && decisiones.isEmpty && pend.isEmpty { return nil }
        return SintesisReunion(resumen: resumen, decisiones: decisiones, pendientes: pend)
    }

    static func dia(_ f: Date) -> String {
        let d = DateFormatter()
        d.locale = Locale(identifier: "en_US_POSIX"); d.dateFormat = "yyyy-MM-dd"
        return d.string(from: f)
    }

    /// Sin punto(s) final(es) ni espacios: la plantilla agrega el suyo.
    static func sinPuntoFinal(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while let l = t.last, l == "." || l == "…" { t.removeLast() }
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func acta(oficina: Oficina, tema: String, participantes: [AgenteDef], turnos: [TurnoReunion], sintesis: SintesisReunion?,
                     errorSintesis: String?, fecha: Date) -> String {
        var s = "# Reunión: \(tema)\n\n"
        s += "- **Oficina:** \(oficina.nombre)\n- **Fecha:** \(dia(fecha))\n"
        s += "- **Participantes:** " + participantes.map { "\($0.nombre) (\($0.rol))" }.joined(separator: ", ") + "\n\n"
        s += "## Transcripción\n\n"
        var ultima = -1
        for t in turnos {
            if t.ronda != ultima, t.ronda > 0 { s += "### Ronda \(t.ronda)\n\n"; ultima = t.ronda }
            var n = nombreDe(t.agente, oficina: oficina)
            if let a = oficina.agente(t.agente) { n += " (\(a.rol))" }
            s += t.error ? "**\(n):** _(no pudo responder: \(t.texto))_\n\n" : "**\(n):** \(t.texto)\n\n"
        }
        if turnos.isEmpty { s += "_(sin intervenciones)_\n\n" }
        s += "## Síntesis\n\n"
        if let x = sintesis {
            s += (x.resumen.isEmpty ? "_(sin resumen)_" : x.resumen) + "\n\n### Decisiones\n\n"
            s += x.decisiones.isEmpty ? "_(ninguna)_\n" : x.decisiones.map { "- \($0)" }.joined(separator: "\n") + "\n"
            s += "\n### Pendientes\n\n"
            s += x.pendientes.isEmpty ? "_(ninguno)_\n" : x.pendientes.map { $0.quien.isEmpty ? "- \($0.que)" : "- **\($0.quien):** \($0.que)" }.joined(separator: "\n") + "\n"
        } else {
            s += "_No se pudo generar la síntesis\(errorSintesis.map { ": " + Self.sinPuntoFinal($0) } ?? "")._\n"
        }
        return s
    }
}

// MARK: - servicio

/// `/api/reuniones*`. Un actor: el estado de las rondas en curso (quién habla, tareas) vive acá; lo demás, en SQLite.
public actor ReunionesRouter: SubRouter {
    static let maxBody = 200_000
    static let maxParticipantes = 20
    static let maxRondas = 3

    private let store: Store
    private let runner: ClaudeRunner
    private let oficinas: Oficinas
    private let log: HQLog
    private let timeoutTurno: TimeInterval
    private let timeoutSintesis: TimeInterval
    private var preparado = false
    private var corriendo: [String: Task<Void, Never>] = [:]
    private var hablando: [String: String] = [:]
    private var cerrando: Set<String> = []

    public init(store: Store, runner: ClaudeRunner, oficinas: Oficinas, log: HQLog,
                env: [String: String] = ProcessInfo.processInfo.environment) {
        self.store = store; self.runner = runner; self.oficinas = oficinas; self.log = log
        timeoutTurno = env["HQ_REUNION_TURNO_TIMEOUT"].flatMap(TimeInterval.init) ?? 180
        timeoutSintesis = env["HQ_REUNION_SINTESIS_TIMEOUT"].flatMap(TimeInterval.init) ?? 180
    }

    private func preparar() async throws {
        if preparado { return }
        try await store.prepararReuniones()
        preparado = true
    }

    public func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)? {
        let partes = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        guard partes.count >= 2, partes[0] == "api", partes[1] == "reuniones", partes.count <= 4, !partes.contains("") else { return nil }
        do {
            try await preparar()
            let (code, obj) = try await despachar(method, partes, body)
            return (code, Router.codificar(obj))
        } catch let e as ErrorAPI {
            return (e.status, Router.codificar(["error": e.mensaje]))
        } catch {
            log.error("reuniones error interno: \(error)")
            return (500, Router.codificar(["error": "error interno"]))
        }
    }

    private func despachar(_ m: String, _ partes: [String], _ body: Data?) async throws -> (Int, [String: Any]) {
        let no: (Int, [String: Any]) = (405, ["error": "método no permitido"])
        switch partes.count {
        case 2:
            switch m {
            case "GET": return (200, try await listar())
            case "POST": return (200, try await crear(body))
            default: return no
            }
        case 3:
            guard Router.uuidValido(partes[2]) else { return (404, ["error": "no"]) }
            return m == "GET" ? (200, try await detalle(partes[2].lowercased())) : no
        default:
            guard Router.uuidValido(partes[2]) else { return (404, ["error": "no"]) }
            let id = partes[2].lowercased()
            guard m == "POST" else { return no }
            switch partes[3] {
            case "intervencion": return (200, try await intervenir(id, body))
            case "ronda": return (200, try await otraRonda(id))
            case "cerrar": return (200, try await cerrar(id))
            default: return (404, ["error": "no"])
            }
        }
    }

    // MARK: utilidades

    private func objeto(_ body: Data?) throws -> [String: Any] {
        guard let body, !body.isEmpty else { throw ErrorAPI(400, "pedido inválido") }
        if body.count > Self.maxBody { throw ErrorAPI(413, "pedido demasiado grande") }
        guard let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { throw ErrorAPI(400, "pedido inválido") }
        return o
    }

    static func iso(_ t: Double) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date(timeIntervalSince1970: t))
    }

    private func fila(_ id: String, _ a: OficinaActiva) async throws -> ReunionFila {
        guard let f = await store.reunion(id, oficina: a.carpeta) else { throw ErrorAPI(404, "No encontré esa reunión.") }
        return f
    }

    /// `vivo` y `habla` se toman ANTES de leer la fila del store: `correrRondas` guarda el estado final antes de soltar
    /// `corriendo`, así que quien ve «no corre» y lee después siempre ve el estado final (nunca un «en_curso» viejo).
    private func vista(_ f: ReunionFila, vivo: Bool, habla: String?, turnos: [TurnoReunion], resumen: Bool = false) -> [String: Any] {
        let estado = f.estado == "en_curso" && !vivo ? "esperando" : (vivo ? "en_curso" : f.estado)
        var o: [String: Any] = ["id": f.id, "tema": f.tema, "agentes": f.agentes, "estado": estado, "creada": Self.iso(f.creada)]
        o["patron"] = f.patron
        if let l = f.lider { o["lider"] = l }
        if let b = f.bandos { o["bandos"] = b }
        if let sa = f.salida { o["salida"] = sa }
        if resumen { o["turnos"] = turnos.count; return o }
        o["hablando"] = vivo ? (habla.map { $0 as Any } ?? NSNull()) : NSNull()
        o["rondas"] = turnos.map { $0.ronda }.max() ?? 0
        o["turnos"] = turnos.map { t -> [String: Any] in
            var x: [String: Any] = ["ronda": t.ronda, "agente": t.agente, "texto": t.texto, "ts": Self.iso(t.ts)]
            if t.error { x["error"] = true }
            return x
        }
        if let s = f.sintesis, let d = s.data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) { o["sintesis"] = j }
        if let e = f.errorSintesis { o["errorSintesis"] = e }
        if let c = f.cerrada { o["cerrada"] = Self.iso(c) }
        if let a = f.acta { o["acta"] = a; o["actaRuta"] = (f.oficina as NSString).appendingPathComponent(a) }
        if let e = f.error { o["error"] = e }
        if f.estado == "cerrada", let sa = f.salida, FileManager.default.fileExists(atPath: (f.oficina as NSString).appendingPathComponent(sa)) {
            o["salidaRuta"] = (f.oficina as NSString).appendingPathComponent(sa)
        }
        if !f.documentos.isEmpty { o["documentos"] = f.documentos }
        return o
    }

    private func respuesta(_ id: String, _ a: OficinaActiva) async throws -> [String: Any] {
        let vivo = corriendo[id] != nil, habla = hablando[id]
        let f = try await fila(id, a)
        return vista(f, vivo: vivo, habla: habla, turnos: await store.turnosDe(reunion: id))
    }

    // MARK: endpoints

    private func listar() async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        var out: [[String: Any]] = []
        let vivas = Set(corriendo.keys)
        for f in await store.reunionesDe(oficina: a.carpeta) {
            out.append(vista(f, vivo: vivas.contains(f.id), habla: nil, turnos: await store.turnosDe(reunion: f.id), resumen: true))
        }
        return ["reuniones": out]
    }

    private func detalle(_ id: String) async throws -> [String: Any] {
        try await respuesta(id, try await oficinas.requerirActiva())
    }

    private func crear(_ body: Data?) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let d = try objeto(body)
        let tema = try Validar.texto(d["tema"], "tema", max: 500)!
        guard let lista = d["agentes"] as? [Any], !lista.isEmpty else { throw ErrorAPI(400, "Elegí al menos un agente para la reunión.") }
        var ids: [String] = []
        for x in lista {
            guard let id = x as? String, Slug.valido(id) else { throw ErrorAPI(400, "«agentes» tiene que ser una lista de ids.") }
            guard a.oficina.agente(id) != nil else { throw ErrorAPI(400, "El agente «\(id)» no está en la oficina.") }
            if !ids.contains(id) { ids.append(id) }
        }
        if ids.count > Self.maxParticipantes { throw ErrorAPI(400, "Demasiados participantes (máximo \(Self.maxParticipantes)).") }
        var rondas = 1
        if let r = d["rondas"], !(r is NSNull) {
            guard let n = (r as? NSNumber).flatMap({ CFGetTypeID($0) == CFBooleanGetTypeID() ? nil : $0.intValue }), n >= 1, n <= Self.maxRondas else {
                throw ErrorAPI(400, "«rondas» tiene que ser un número entre 1 y \(Self.maxRondas).")
            }
            rondas = n
        }
        var documentos: [String] = []
        if let v = d["documentos"], !(v is NSNull) {
            guard let arr = v as? [Any] else { throw ErrorAPI(400, "«documentos» tiene que ser una lista de slugs.") }
            for x in arr {
                guard let s = x as? String, Slug.valido(s) else { throw ErrorAPI(400, "«documentos» tiene que ser una lista de slugs.") }
                guard FileManager.default.fileExists(atPath: a.ruta("conocimiento/fuentes/\(s).md")) else {
                    throw ErrorAPI(400, "El documento «\(s)» no está en la biblioteca o todavía no tiene ficha.")
                }
                if !documentos.contains(s) { documentos.append(s) }
            }
            if documentos.count > 10 { throw ErrorAPI(400, "Máximo 10 documentos por reunión.") }
        }
        var patron = PatronReunion.debate
        if let v = d["patron"], !(v is NSNull) {
            guard let t = v as? String, let p = PatronReunion(rawValue: t) else {
                throw ErrorAPI(400, "«patron» tiene que ser uno de: " + PatronReunion.allCases.map { $0.rawValue }.joined(separator: ", ") + ".")
            }
            patron = p
        }
        var lider: String?
        if patron == .lider {
            guard let l = d["lider"] as? String, ids.contains(l) else { throw ErrorAPI(400, "«lider» tiene que ser uno de los participantes.") }
            lider = l
        }
        var bandos: [String: [String]]?
        if patron == .redblue {
            let malo = ErrorAPI(400, "«bandos» tiene que repartir a todos los participantes entre «a» y «b», con al menos uno en cada bando.")
            guard let b = d["bandos"] as? [String: Any], let la = b["a"] as? [Any], let lb = b["b"] as? [Any] else { throw malo }
            let ba = la.compactMap { $0 as? String }, bb = lb.compactMap { $0 as? String }
            guard ba.count == la.count, bb.count == lb.count, !ba.isEmpty, !bb.isEmpty,
                  Set(ba).count == ba.count, Set(bb).count == bb.count, Set(ba).isDisjoint(with: bb),
                  Set(ba).union(bb) == Set(ids) else { throw malo }
            bandos = ["a": ba, "b": bb]
        }
        if patron == .revision, documentos.isEmpty { throw ErrorAPI(400, "El panel de revisión necesita al menos un documento adjunto.") }
        let creada = Date()
        var salida = ReunionPatron.salidaPorDefecto(tema: tema, fecha: creada)
        if let v = d["salida"], !(v is NSNull) {
            guard let t = (v as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), ReunionPatron.errorDeSalida(t) == nil else {
                throw ErrorAPI(400, ReunionPatron.errorDeSalida((v as? String) ?? "") ?? "«salida» tiene que ser texto.")
            }
            salida = t
        }
        let id = UUID().uuidString.lowercased()
        let ordenados = ReunionTexto.ordenar(ids.compactMap { a.oficina.agente($0) }, oficina: a.oficina, tema: tema).map { $0.id }
        do { try await store.reunionCrear(id: id, oficina: a.carpeta, tema: tema, agentes: ordenados, documentos: documentos,
                                                   patron: patron.rawValue, lider: lider, bandos: bandos, salida: salida) }
        catch { throw ErrorAPI(500, "No pude guardar la reunión.") }
        try await arrancar(id, a, rondas: rondas)
        return try await respuesta(id, a)
    }

    private func intervenir(_ id: String, _ body: Data?) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let f = try await fila(id, a)
        let texto = try Validar.texto(try objeto(body)["texto"], "texto", max: 5000)!
        if f.estado == "cerrada" { throw ErrorAPI(409, "La reunión ya está cerrada.") }
        let ronda = (await store.turnosDe(reunion: id)).map { $0.ronda }.max() ?? 0
        do { try await store.turnoAgregar(reunion: id, oficina: a.carpeta, ronda: ronda, agente: "usuario", texto: texto, error: false) }
        catch { throw ErrorAPI(500, "No pude guardar tu intervención.") }
        return try await respuesta(id, a)
    }

    private func otraRonda(_ id: String) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let f = try await fila(id, a)
        if f.estado == "cerrada" || cerrando.contains(id) { throw ErrorAPI(409, "La reunión ya está cerrada.") }
        if corriendo[id] != nil { throw ErrorAPI(409, "Todavía hay una ronda en curso.") }
        try await arrancar(id, a, rondas: 1)
        return try await respuesta(id, a)
    }

    private func cerrar(_ id: String) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let f = try await fila(id, a)
        if f.estado == "cerrada" || cerrando.contains(id) { throw ErrorAPI(409, "La reunión ya está cerrada.") }
        if corriendo[id] != nil { throw ErrorAPI(409, "Todavía hay una ronda en curso: esperá a que termine para cerrar.") }
        cerrando.insert(id)
        defer { cerrando.remove(id) }
        let turnos = await store.turnosDe(reunion: id)
        let of = a.oficina
        let parts = f.agentes.compactMap { of.agente($0) }
        let patron = PatronReunion(rawValue: f.patron) ?? .debate
        let (liderDef, bandoA, bandoB) = Self.rolesDe(f, of)
        var sintesis: SintesisReunion?
        var errSint: String?
        if !turnos.contains(where: { !$0.error }) {
            errSint = "No hubo opiniones para resumir."
        } else {
            do {
                let caja = CajaCosto()
                defer { let c = caja.valor; let st = store, car = a.carpeta; Task { await st.registrarCosto(oficina: car, origen: "sintesis", ref: id, costo: c) } }
                let t = try await runner.correrSinAgente(prompt: ReunionTexto.promptSintesis(oficina: of, tema: f.tema, participantes: parts, turnos: turnos,
                                                                                                patron: patron, lider: liderDef, bandoA: bandoA, bandoB: bandoB),
                                                         timeout: timeoutSintesis, cwd: a.carpeta, obs: caja.observador())
                if let s = ReunionTexto.parsearSintesis(t) { sintesis = s }
                else { errSint = "La síntesis no vino en el formato esperado." }
            } catch let e as ClaudeError { errSint = e.mensaje }
            catch { errSint = "No pude generar la síntesis." }
        }
        let hoy = Date()
        var errorActa: String?
        var rel: String?
        do {
            let r = try escribirActa(a, f, ReunionTexto.acta(oficina: of, tema: f.tema, participantes: parts, turnos: turnos,
                                                            sintesis: sintesis, errorSintesis: errSint, fecha: hoy), fecha: hoy)
            rel = r
            if let s = sintesis, !s.decisiones.isEmpty {
                try Plantillas.anexarDecisiones(carpeta: a.carpeta, decisiones: s.decisiones, fecha: hoy)
            }
        } catch {
            errorActa = "No pude guardar el acta o las decisiones en la carpeta de la oficina."
            log.error("reuniones: \(error)")
        }
        // archivo de salida: lo escribe el backend (los turnos son de solo lectura). Un fallo se informa como el del acta.
        if let pedida = f.salida {
            do {
                let definitiva = try escribirSalida(a, pedida, ReunionPatron.markdownSalida(oficina: of, f: f, participantes: parts, sintesis: sintesis,
                                                                                         errorSintesis: errSint, acta: rel, fecha: hoy))
                try await store.reunionSalida(id, definitiva)
            } catch {
                if errorActa == nil { errorActa = "No pude guardar el archivo de salida (\(pedida))." }
                log.error("reuniones: salida: \(error)")
            }
        }
        let js = sintesis.flatMap { try? JSONSerialization.data(withJSONObject: $0.json) }.flatMap { String(data: $0, encoding: .utf8) }
        do { try await store.reunionCerrar(id, sintesis: js, errorSintesis: errSint, acta: rel, error: errorActa) }
        catch { throw ErrorAPI(500, "No pude guardar el cierre de la reunión.") }
        return try await respuesta(id, a)
    }

    /// `reuniones/AAAA-MM-DD-<slug-tema>.md` (si ya existe, `-2`, `-3`...). Devuelve la ruta relativa.
    private func escribirActa(_ a: OficinaActiva, _ f: ReunionFila, _ texto: String, fecha: Date) throws -> String {
        let fm = FileManager.default
        try fm.createDirectory(atPath: a.ruta("reuniones"), withIntermediateDirectories: true)
        let base = "\(ReunionTexto.dia(fecha))-\(Slug.de(f.tema).isEmpty ? "reunion" : Slug.de(f.tema))"
        var rel = "reuniones/\(base).md", n = 2
        while fm.fileExists(atPath: a.ruta(rel)) { rel = "reuniones/\(base)-\(n).md"; n += 1 }
        try Data(texto.utf8).write(to: URL(fileURLWithPath: a.ruta(rel)), options: .atomic)
        return rel
    }

    /// Escribe `rel` (ya validada, dentro de `archivos/`) creando las carpetas; si existe agrega `-2`, `-3`. Devuelve la ruta final.
    /// Se niega si un enlace simbólico sacaría el archivo de la carpeta de la oficina.
    private func escribirSalida(_ a: OficinaActiva, _ rel: String, _ texto: String) throws -> String {
        guard ReunionPatron.errorDeSalida(rel) == nil else { throw ErrorAPI(400, "salida inválida") }
        let fm = FileManager.default
        let definitiva = ReunionPatron.rutaLibre(rel) { fm.fileExists(atPath: a.ruta($0)) }
        let url = URL(fileURLWithPath: a.ruta(definitiva))
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let base = URL(fileURLWithPath: a.carpeta).resolvingSymlinksInPath().path + "/"
        guard (url.deletingLastPathComponent().resolvingSymlinksInPath().path + "/").hasPrefix(base) else {
            throw ErrorAPI(400, "salida fuera de la oficina")
        }
        try Data(texto.utf8).write(to: url, options: .atomic)
        return definitiva
    }

    /// Líder y bandos de la reunión como agentes (los que ya no existan en la oficina se omiten).
    static func rolesDe(_ f: ReunionFila, _ of: Oficina) -> (AgenteDef?, [AgenteDef], [AgenteDef]) {
        (f.lider.flatMap { of.agente($0) }, (f.bandos?["a"] ?? []).compactMap { of.agente($0) }, (f.bandos?["b"] ?? []).compactMap { of.agente($0) })
    }

    // MARK: rondas

    private func arrancar(_ id: String, _ a: OficinaActiva, rondas: Int) async throws {
        do { try await store.reunionEstado(id, "en_curso") } catch { throw ErrorAPI(500, "No pude guardar la reunión.") }
        let carpeta = a.carpeta
        corriendo[id] = Task { await self.correrRondas(id, carpeta: carpeta, cuantas: rondas) }
    }

    private func correrRondas(_ id: String, carpeta: String, cuantas: Int) async {
        var algunoOk = false, abortada = false
        var ultimoError: String?
        for _ in 0..<cuantas {
            let r = await correrRonda(id, carpeta: carpeta)
            algunoOk = algunoOk || r.ok
            ultimoError = r.error ?? ultimoError
            if r.abortada { abortada = true; break }
        }
        // app cerrándose: queda como estaba y al reiniciar pasa a «esperando»
        // Estado final PRIMERO y recién después se suelta `corriendo`: así nadie ve «ya no corre» con el estado viejo.
        if !abortada { try? await store.reunionEstado(id, algunoOk ? "esperando" : "error", error: algunoOk ? nil : ultimoError) }
        corriendo[id] = nil
        hablando[id] = nil
    }

    /// Una ronda: cada participante habla una vez, en el orden y con la consigna que marca el patrón de la reunión.
    /// -> (hubo algún turno bueno, último error, abortada por cierre de la app).
    private func correrRonda(_ id: String, carpeta: String) async -> (ok: Bool, error: String?, abortada: Bool) {
        guard let of = try? OficinaStore.leer(carpeta: carpeta) else { return (false, "No pude leer la oficina.", false) }
        guard let f = await store.reunion(id, oficina: carpeta) else { return (false, "No encontré la reunión.", false) }
        let ronda = ((await store.turnosDe(reunion: id)).map { $0.ronda }.max() ?? 0) + 1
        let participantes = f.agentes.compactMap { of.agente($0) }
        let patron = PatronReunion(rawValue: f.patron) ?? .debate
        let bandos = f.bandos.map { (a: $0["a"] ?? [], b: $0["b"] ?? []) }
        let plan = ReunionPatron.plan(patron: patron, ids: participantes.map { $0.id }, lider: f.lider, bandos: bandos)
        var ok = false
        var ultimo: String?
        if patron == .mapreduce {
            // todos a la vez; cada uno respeta su propio carril (conCarril) y no ve los turnos de esta ronda
            var pendientes = Set(plan.map { $0.agente })
            hablando[id] = plan.first?.agente
            let resultados = await withTaskGroup(of: ResultadoTurno.self) { grupo -> [ResultadoTurno] in
                for paso in plan {
                    grupo.addTask { await self.hacerTurno(id, carpeta, of, f, ronda, participantes, paso) }
                }
                var out: [ResultadoTurno] = []
                for await r in grupo {
                    out.append(r)
                    pendientes.remove(r.agente)
                    hablando[id] = plan.first { pendientes.contains($0.agente) }?.agente
                }
                return out
            }
            for r in resultados {
                if r.abortada { return (ok, ultimo, true) }
                if r.fallo { ultimo = r.texto } else { ok = true }
            }
            return (ok, ultimo, false)
        }
        for paso in plan {
            hablando[id] = paso.agente
            let r = await hacerTurno(id, carpeta, of, f, ronda, participantes, paso)
            if r.abortada { return (ok, ultimo, true) }
            if r.fallo { ultimo = r.texto } else { ok = true }
        }
        return (ok, ultimo, false)
    }

    struct ResultadoTurno: Sendable {
        var agente: String
        var texto: String
        var fallo: Bool
        var abortada: Bool
    }

    /// Un turno: arma el prompt, corre `turnoSoloLectura` en el carril del agente (con actividad y costo) y guarda el resultado.
    private func hacerTurno(_ id: String, _ carpeta: String, _ of: Oficina, _ f: ReunionFila, _ ronda: Int,
                            _ participantes: [AgenteDef], _ paso: PasoTurno) async -> ResultadoTurno {
        guard let ag = of.agente(paso.agente) else { return ResultadoTurno(agente: paso.agente, texto: "No encontré al agente.", fallo: true, abortada: false) }
        let patron = PatronReunion(rawValue: f.patron) ?? .debate
        let (liderDef, bandoA, bandoB) = Self.rolesDe(f, of)
        let prompt = ReunionTexto.promptTurno(oficina: of, carpeta: carpeta, tema: f.tema, participantes: participantes, quien: ag,
                                              turnos: await store.turnosDe(reunion: id), ronda: ronda,
                                              fichas: ReunionTexto.fichas(carpeta: carpeta, documentos: f.documentos),
                                              patron: patron, fase: paso.fase, lider: liderDef, bandoA: bandoA, bandoB: bandoB)
        var texto: String
        var fallo = false
        do {
            let runner = self.runner, cwd = carpeta, t = timeoutTurno
            let dirs = Permisos.dirsVinculos(of, agente: ag)
            let caja = CajaCosto(), agid = ag.id, st = store
            defer { let c = caja.valor; Task { await st.registrarCosto(oficina: cwd, agente: agid, origen: "reunion", ref: id, costo: c) } }
            texto = try await runner.conCarril(oficina: carpeta, agente: ag.id) {
                try await runner.actividad.seguir(oficina: cwd, agente: agid, origen: "reunion", tarea: "Reunión: " + f.tema,
                                                  extra: caja.observador()) { obs, _ in
                    try await runner.turnoSoloLectura(agente: agid, prompt: prompt, cwd: cwd, timeout: t, dirsExtra: dirs, obs: obs)
                }
            }
            texto = texto.trimmingCharacters(in: .whitespacesAndNewlines)
            if texto.isEmpty { texto = "(sin respuesta)"; fallo = true }
        } catch let e as ClaudeError {
            if e == .cerrando { return ResultadoTurno(agente: ag.id, texto: "", fallo: true, abortada: true) }
            texto = e.mensaje; fallo = true
            log.warn("reunion turno agente=\(ag.id) tipo=\(e.tipo)")
        } catch {
            texto = "No pude responder."; fallo = true
        }
        try? await store.turnoAgregar(reunion: id, oficina: carpeta, ronda: ronda, agente: ag.id, texto: texto, error: fallo)
        return ResultadoTurno(agente: ag.id, texto: texto, fallo: fallo, abortada: false)
    }
}
