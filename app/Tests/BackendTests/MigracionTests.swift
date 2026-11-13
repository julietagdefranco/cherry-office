import Foundation
import Testing
@testable import Backend

@Suite("Migracion")
struct MigracionTests {
    /// Carpeta legacy temporal (como ~/Próspera HQ/oficina del server Python).
    func legacy(_ sb: Sandbox, sesiones: [String: String]? = nil) throws -> String {
        let d = sb.root + "/legacy/oficina"
        try FileManager.default.createDirectory(atPath: d + "/.datos", withIntermediateDirectories: true)
        if let s = sesiones { try json(s).write(to: URL(fileURLWithPath: d + "/.sesiones.json")) }
        return d
    }

    /// Crea un hq.db viejo de Python con el esquema sesiones(sid,agente,activa,creada) y mensajes(sid,r,t,e,ts).
    func baseVieja(_ path: String, sesiones: [(String, String, Int, Double)], mensajes: [(String, String, String, Int, Double)]) throws {
        let db = try SQLiteDB(path: path)
        try db.exec("""
        CREATE TABLE sesiones (sid TEXT PRIMARY KEY, agente TEXT NOT NULL, activa INTEGER NOT NULL DEFAULT 0, creada REAL NOT NULL, extra TEXT);
        CREATE TABLE mensajes (id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, r TEXT NOT NULL, t TEXT NOT NULL, e INTEGER NOT NULL DEFAULT 0, ts REAL NOT NULL);
        """)
        for s in sesiones { try db.run("INSERT INTO sesiones(sid,agente,activa,creada) VALUES(?,?,?,?)", [.text(s.0), .text(s.1), .int(Int64(s.2)), .double(s.3)]) }
        for m in mensajes { try db.run("INSERT INTO mensajes(sid,r,t,e,ts) VALUES(?,?,?,?,?)", [.text(m.0), .text(m.1), .text(m.2), .int(Int64(m.3)), .double(m.4)]) }
        db.close()
    }

    func transcript(_ sb: Sandbox, sid: String, lineas: [String], carpeta: String? = nil) throws {
        let dir = sb.home + "/.claude/projects/" + (carpeta ?? Transcripts.codificar(sb.proyecto))
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try (lineas.joined(separator: "\n") + "\n").write(toFile: dir + "/\(sid).jsonl", atomically: true, encoding: .utf8)
    }

    func storeYConfig(_ sb: Sandbox, legacyDir: String?) throws -> (Store, Config, HQLog) {
        var c = sb.config()
        c.legacyDirs = legacyDir.map { [$0] } ?? [sb.root + "/no-existe"]
        return (try Store(path: sb.datos + "/hq.db"), c, HQLog(dir: nil))
    }

    // MARK: .sesiones.json

    @Test(".sesiones.json: importa sesiones activas, en minúsculas; descarta inválidas")
    func sesionesJson() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb, sesiones: [
            "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA": "betty", U.b: "marce",
            "no-uuid": "betty", U.c: "", U.d: "sofia",
        ])
        let (s, c, l) = try storeYConfig(sb, legacyDir: d)
        let r = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        #expect(r.hecha && !r.yaHabiaCorrido)
        #expect(r.sesiones == 3 && r.mensajes == 0)
        #expect(await s.agenteDe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") == "betty")
        #expect(await s.estaActiva(U.b))
        #expect(await s.agenteDe(U.c) == nil)
        #expect(await s.agenteDe("no-uuid") == nil)
        #expect(await s.meta(Migracion.clave) != nil)
    }

    @Test(".sesiones.json corrupto o con tipos raros no rompe la migración")
    func sesionesJsonCorrupto() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb)
        try "{ esto no es json".write(toFile: d + "/.sesiones.json", atomically: true, encoding: .utf8)
        let (s, c, l) = try storeYConfig(sb, legacyDir: d)
        let r = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        #expect(r.hecha && r.sesiones == 0)
        // valores no-string
        try json([U.a: 5, U.b: ["x"], U.c: "betty"] as [String: Any]).write(to: URL(fileURLWithPath: d + "/.sesiones.json"))
        let sb2 = Sandbox(); defer { withExtendedLifetime(sb2) {} }
        let (s2, c2, l2) = try storeYConfig(sb2, legacyDir: d)
        let r2 = await Migracion.ejecutar(store: s2, config: c2, log: l2, env: [:])
        #expect(r2.sesiones == 1)
        #expect(await s2.agenteDe(U.c) == "betty")
    }

    // MARK: hq.db viejo

    @Test("hq.db viejo: sesiones y mensajes con flag de error, en orden")
    func baseVieja() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb)
        try baseVieja(d + "/.datos/hq.db",
                      sesiones: [(U.a, "betty", 1, 10), (U.b, "marce", 0, 20), ("basura", "betty", 1, 1), (U.c, "", 1, 1)],
                      mensajes: [(U.a, "u", "hola", 0, 11), (U.a, "a", "fallo", 1, 12), (U.a, "u", "chau", 0, 13), (U.b, "u", "x", 0, 21)])
        let (s, c, l) = try storeYConfig(sb, legacyDir: d)
        let r = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        #expect(r.hecha)
        #expect(r.sesiones == 2 && r.mensajes == 4)
        #expect(await s.estaActiva(U.a))
        #expect(await s.estaActiva(U.b) == false)
        #expect(await s.mensajes(U.a) == [Mensaje(r: "u", t: "hola"), Mensaje(r: "a", t: "fallo", e: true), Mensaje(r: "u", t: "chau")])
        #expect(await s.agenteDe(U.c) == nil)
        #expect(await s.agenteDe("basura") == nil)
    }

    @Test("hq.db viejo + .sesiones.json: se combinan sin duplicar sesiones")
    func ambosOrigenes() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb, sesiones: [U.a: "betty", U.b: "marce"])
        try baseVieja(d + "/.datos/hq.db", sesiones: [(U.a, "betty", 1, 10), (U.c, "sofia", 1, 30)],
                      mensajes: [(U.a, "u", "hola", 0, 11)])
        let (s, c, l) = try storeYConfig(sb, legacyDir: d)
        let r = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        #expect(r.sesiones == 3 && r.mensajes == 1)
    }

    @Test("hq.db viejo ilegible (no es SQLite) se ignora")
    func baseCorrupta() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb, sesiones: [U.a: "betty"])
        try "no soy sqlite".write(toFile: d + "/.datos/hq.db", atomically: true, encoding: .utf8)
        let (s, c, l) = try storeYConfig(sb, legacyDir: d)
        let r = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        #expect(r.sesiones == 1 && r.mensajes == 0)
    }

    // MARK: transcripts

    @Test("transcript .jsonl sintético: un turno por mensaje de usuario, última respuesta del asistente, ignora ruido")
    func transcriptSintetico() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb, sesiones: [U.a: "betty"])
        try transcript(sb, sid: U.a, lineas: [
            #"{"type":"summary","summary":"x"}"#,
            #"{"type":"user","timestamp":"2025-03-01T10:00:00.000Z","message":{"role":"user","content":"Hola Betty"}}"#,
            #"{"type":"assistant","timestamp":"2025-03-01T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Pensando..."},{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}"#,
            #"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"datos"}]}}"#,
            #"{"type":"assistant","timestamp":"2025-03-01T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Respuesta final 1"}]}}"#,
            #"{"type":"user","isSidechain":true,"message":{"role":"user","content":"subagente"}}"#,
            #"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"sub-respuesta"}]}}"#,
            #"{"type":"user","isMeta":true,"message":{"role":"user","content":"meta"}}"#,
            #"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#,
            #"{"type":"user","message":{"role":"user","content":"<system-reminder>x</system-reminder>"}}"#,
            "esta línea está rota {",
            #"{"type":"user","timestamp":"2025-03-01T11:00:00Z","message":{"role":"user","content":[{"type":"text","text":"Segunda pregunta"}]}}"#,
            #"{"type":"assistant","timestamp":"2025-03-01T11:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"Respuesta final 2"}]}}"#,
            #"{"type":"user","timestamp":"2025-03-01T12:00:00Z","message":{"role":"user","content":"Sin respuesta todavía"}}"#,
        ])
        let (s, c, l) = try storeYConfig(sb, legacyDir: d)
        let r = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        #expect(r.hecha)
        #expect(r.sesiones == 1 && r.mensajes == 0)
        #expect(r.desdeTranscripts == 5)
        #expect(await s.mensajes(U.a) == [
            Mensaje(r: "u", t: "Hola Betty"), Mensaje(r: "a", t: "Respuesta final 1"),
            Mensaje(r: "u", t: "Segunda pregunta"), Mensaje(r: "a", t: "Respuesta final 2"),
            Mensaje(r: "u", t: "Sin respuesta todavía"),
        ])
    }

    @Test("transcript: se prefiere la carpeta codificada; si no, cualquier carpeta de projects que lo tenga")
    func transcriptFallback() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb, sesiones: [U.a: "betty"])
        try transcript(sb, sid: U.a, lineas: [
            #"{"type":"user","message":{"role":"user","content":"en otra carpeta"}}"#,
            #"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}"#,
        ], carpeta: "-otra-codificacion")
        let (s, c, l) = try storeYConfig(sb, legacyDir: d)
        let r = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        #expect(r.desdeTranscripts == 2)
        #expect(await s.mensajes(U.a).map(\.t) == ["en otra carpeta", "ok"])
    }

    @Test("transcript no se usa si la sesión ya trajo mensajes de hq.db")
    func transcriptSoloParaHuerfanas() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb)
        try baseVieja(d + "/.datos/hq.db", sesiones: [(U.a, "betty", 1, 1), (U.b, "marce", 1, 1)],
                      mensajes: [(U.a, "u", "de la base", 0, 1)])
        for sid in [U.a, U.b] {
            try transcript(sb, sid: sid, lineas: [
                #"{"type":"user","message":{"role":"user","content":"del transcript"}}"#,
                #"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"resp"}]}}"#,
            ])
        }
        let (s, c, l) = try storeYConfig(sb, legacyDir: d)
        let r = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        #expect(r.desdeTranscripts == 2)
        #expect(await s.mensajes(U.a).map(\.t) == ["de la base"])
        #expect(await s.mensajes(U.b).map(\.t) == ["del transcript", "resp"])
    }

    @Test("transcript inexistente o vacío: la sesión se importa sin mensajes y no falla")
    func transcriptAusente() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb, sesiones: [U.a: "betty", U.b: "marce"])
        try transcript(sb, sid: U.b, lineas: [])
        let (s, c, l) = try storeYConfig(sb, legacyDir: d)
        let r = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        #expect(r.sesiones == 2 && r.desdeTranscripts == 0)
        #expect(await s.cuentaMensajes(U.a) == 0)
    }

    @Test("codificar: todo lo que no es [A-Za-z0-9] pasa a '-'")
    func codificar() {
        #expect(Transcripts.codificar("/Users/a b/Próspera") == "-Users-a-b-Pr-spera")
        #expect(Transcripts.codificar("/x/y_z.w") == "-x-y-z-w")
    }

    // MARK: idempotencia y seguridad

    @Test("idempotente: la segunda corrida no hace nada aunque haya datos nuevos en el origen")
    func idempotencia() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb, sesiones: [U.a: "betty"])
        let (s, c, l) = try storeYConfig(sb, legacyDir: d)
        let r1 = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        #expect(r1.hecha && r1.sesiones == 1)
        try json([U.a: "betty", U.b: "marce"]).write(to: URL(fileURLWithPath: d + "/.sesiones.json"))
        let r2 = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        #expect(r2.yaHabiaCorrido && !r2.hecha && r2.sesiones == 0)
        #expect(await s.agenteDe(U.b) == nil)
    }

    @Test("idempotente entre reinicios: una nueva instancia del Store (misma base) no reimporta ni duplica")
    func idempotenciaEntreInstancias() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb)
        try baseVieja(d + "/.datos/hq.db", sesiones: [(U.a, "betty", 1, 1)], mensajes: [(U.a, "u", "uno", 0, 1)])
        var (s, c, l) = try storeYConfig(sb, legacyDir: d)
        _ = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        await s.close()
        s = try Store(path: sb.datos + "/hq.db")
        let r = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        #expect(r.yaHabiaCorrido)
        #expect(await s.cuentaMensajes(U.a) == 1)
    }

    @Test("sin ninguna carpeta de origen: hecha=false y NO marca la migración (puede correr luego)")
    func sinOrigen() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let (s, c, l) = try storeYConfig(sb, legacyDir: nil)
        let r = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        #expect(!r.hecha && !r.yaHabiaCorrido)
        #expect(await s.meta(Migracion.clave) == nil)
        // ahora aparece el origen: se importa
        let d = try legacy(sb, sesiones: [U.a: "betty"])
        var c2 = c; c2.legacyDirs = [d]
        let r2 = await Migracion.ejecutar(store: s, config: c2, log: l, env: [:])
        #expect(r2.hecha && r2.sesiones == 1)
    }

    @Test("HQ_LEGACY_DIR del entorno tiene prioridad y las carpetas repetidas se procesan una vez")
    func envLegacyYDuplicados() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb, sesiones: [U.a: "betty"])
        var c = sb.config()
        c.legacyDirs = [d, d]
        let s = try Store(path: sb.datos + "/hq.db")
        let r = await Migracion.ejecutar(store: s, config: c, log: HQLog(dir: nil), env: ["HQ_LEGACY_DIR": d])
        #expect(r.sesiones == 1)
    }

    @Test("no modifica ni borra los archivos de origen")
    func origenIntacto() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb, sesiones: [U.a: "betty"])
        try baseVieja(d + "/.datos/hq.db", sesiones: [(U.b, "marce", 1, 1)], mensajes: [(U.b, "u", "x", 0, 1)])
        try transcript(sb, sid: U.a, lineas: [#"{"type":"user","message":{"role":"user","content":"t"}}"#])
        let archivos = [d + "/.sesiones.json", d + "/.datos/hq.db",
                        sb.home + "/.claude/projects/" + Transcripts.codificar(sb.proyecto) + "/\(U.a).jsonl"]
        let antes = archivos.map { FileManager.default.contents(atPath: $0) }
        #expect(antes.allSatisfy { $0 != nil })
        let (s, c, l) = try storeYConfig(sb, legacyDir: d)
        _ = await Migracion.ejecutar(store: s, config: c, log: l, env: [:])
        await s.close()
        #expect(archivos.map { FileManager.default.contents(atPath: $0) } == antes)
        // y no aparecen archivos nuevos (-wal/-shm) en la carpeta de origen
        let nombres = Set((try? FileManager.default.contentsOfDirectory(atPath: d + "/.datos")) ?? [])
        #expect(nombres == ["hq.db"])
    }

    @Test("a través de Backend: migra al arrancar y el router espera la migración antes de responder")
    func viaBackend() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let d = try legacy(sb)
        try baseVieja(d + "/.datos/hq.db", sesiones: [(U.a, "betty", 1, 1)],
                      mensajes: [(U.a, "u", "viejo", 0, 1), (U.a, "a", "respuesta vieja", 0, 2)])
        let b = try sb.backend(env: ["HQ_LEGACY_DIR": d])
        let h0 = await historial(b)   // sin esperar la migración a mano: el router la espera
        // cambio de contrato (oficinas): los chats viejos quedan sin oficina hasta que se reclaman (al importar Próspera)
        #expect(h0.obj["session"] is NSNull)
        _ = try await b.store.reclamarLegacy(oficina: sb.proyecto)
        let h = await historial(b)
        #expect(h.obj["session"] as? String == U.a)
        #expect(igual(msgs(h), [["r": "u", "t": "viejo"], ["r": "a", "t": "respuesta vieja"]] as [[String: Any]]))
        let m = await b.esperarMigracion()
        #expect(m.hecha && m.mensajes == 2)
        // el chat sobre una sesión migrada y activa usa --resume
        _ = await chat(b, message: "sigo", session: U.a)
        #expect(sb.llamadas.last?.contains("--resume") == true)
        // la HOME real no se tocó: la base quedó en el dir temporal
        #expect(FileManager.default.fileExists(atPath: sb.datos + "/hq.db"))
    }
}
