import Foundation
import Testing
@testable import Backend

@Suite("ClaudeRunner")
struct RunnerTests {
    /// Posición del valor que sigue a `flag` en los argumentos.
    func valor(_ args: [String], tras flag: String) -> String? {
        args.firstIndex(of: flag).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
    }

    @Test("primer mensaje usa --session-id y los siguientes --resume")
    func sessionIdLuegoResume() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        #expect((await chat(b, message: "uno")).status == 200)
        #expect((await chat(b, message: "dos")).status == 200)
        #expect((await chat(b, message: "tres")).status == 200)
        let ll = sb.llamadas
        #expect(ll.count == 3)
        #expect(valor(ll[0], tras: "--session-id") == U.a)
        #expect(!ll[0].contains("--resume"))
        for i in 1...2 {
            #expect(valor(ll[i], tras: "--resume") == U.a)
            #expect(!ll[i].contains("--session-id"))
        }
        #expect(ll.map { $0.last } == ["uno", "dos", "tres"])
    }

    @Test("sesiones distintas del mismo agente arrancan cada una con --session-id")
    func sesionesIndependientes() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        _ = await chat(b, message: "a", session: U.a)
        _ = await chat(b, message: "b", session: U.b)
        #expect(sb.llamadas.allSatisfy { $0.contains("--session-id") })
    }

    @Test("la sesión activa sobrevive a una nueva instancia (--resume tras reiniciar la app)")
    func resumeTrasReinicio() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        do {
            let b = try sb.backend()
            _ = await chat(b, message: "uno")
            await b.shutdown()
        }
        let b2 = try sb.backend()
        _ = await chat(b2, message: "dos")
        #expect(valor(sb.llamadas[1], tras: "--resume") == U.a)
    }

    @Test("'already in use' con --session-id reintenta con --resume y responde bien")
    func reintentoYaEnUso() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        let r = await chat(b, message: "USADA")
        #expect(r.status == 200)
        #expect(r.obj["reply"] as? String == "hola betty")
        let ll = sb.llamadas
        #expect(ll.count == 2)
        #expect(ll[0].contains("--session-id") && !ll[0].contains("--resume"))
        #expect(ll[1].contains("--resume") && !ll[1].contains("--session-id"))
        // un solo par de mensajes guardado, sin error
        let h = msgs(await historial(b, session: U.a))
        #expect(h.count == 2)
        #expect(h.allSatisfy { $0["e"] == nil })
    }

    @Test("'No conversation' / 'not found' con --resume reintenta con --session-id", arguments: ["NOCONV", "NOTFOUND"])
    func reintentoSinConversacion(clave: String) async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        #expect((await chat(b, message: "primero")).status == 200)   // marca la sesión activa
        let r = await chat(b, message: clave)
        #expect(r.status == 200)
        let ll = sb.llamadas
        #expect(ll.count == 3)
        #expect(ll[1].contains("--resume"))
        #expect(ll[2].contains("--session-id") && !ll[2].contains("--resume"))
    }

    @Test("el reintento no se encadena: si la segunda forma también falla, error")
    func sinReintentoInfinito() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        // USADA falla con --session-id; el reintento con --resume funciona. Con NOCONV+USADA:
        // 1) --session-id -> USADA falla, 2) --resume -> NOCONV falla -> error final (no hay 3er intento)
        let r = await chat(b, message: "USADA NOCONV")
        #expect(r.status == 500)
        #expect(sb.llamadas.count == 2)
        #expect((r.obj["error"] as? String)?.contains("No conversation") == true)
    }

    @Test("error de login -> mensaje amigable, 500, sin reintento y guardado como error")
    func loginAmigable() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        let r = await chat(b, message: "LOGINERR")
        #expect(r.status == 500)
        #expect(r.obj["error"] as? String == ClaudeError.mensajeLogin)
        #expect(sb.llamadas.count == 1)
        let h = msgs(await historial(b, session: U.a))
        #expect(h.count == 2)
        #expect(h[1]["e"] as? Bool == true)
        #expect(h[1]["t"] as? String == "No pude responder: " + ClaudeError.mensajeLogin)
        // un chat fallido no marca la sesión como activa: el siguiente vuelve a --session-id
        _ = await chat(b, message: "bien")
        #expect(sb.llamadas.last?.contains("--session-id") == true)
    }

    @Test("rc != 0 sin JSON -> 500 con el stderr")
    func exitDistintoDeCero() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        let r = await chat(b, message: "SALE3")
        #expect(r.status == 500)
        #expect((r.obj["error"] as? String)?.contains("boom") == true)
    }

    @Test("is_error=true con rc 0 también es error")
    func isErrorConRcCero() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        let r = await chat(b, message: "ISERR")
        #expect(r.status == 500)
        #expect(r.obj["error"] as? String == "fallo raro")
    }

    @Test("salida que no es JSON (rc 0) se devuelve como texto")
    func jsonInvalido() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        let r = await chat(b, message: "NOJSON")
        #expect(r.status == 200)
        #expect(r.obj["reply"] as? String == "esto no es json")
    }

    @Test("parsearJSON: objeto completo, ruido previo y basura")
    func parsearJSON() {
        #expect(ClaudeRunner.parsearJSON(#"{"result":"x"}"#)?["result"] as? String == "x")
        #expect(ClaudeRunner.parsearJSON("ruido\n{\"result\":\"y\"}\n")?["result"] as? String == "y")
        #expect(ClaudeRunner.parsearJSON("nada") == nil)
        #expect(ClaudeRunner.parsearJSON("[1,2]") == nil)
        #expect(ClaudeRunner.parsearJSON("") == nil)
    }

    @Test("clasificar: 'login' (sin importar mayúsculas) es error de login; lo demás, error de claude")
    func clasificar() {
        #expect(ClaudeError.clasificar("Please run /login") == .login("Please run /login"))
        #expect(ClaudeError.clasificar("Not LOGIN") == .login("Not LOGIN"))
        #expect(ClaudeError.clasificar("otra cosa") == .claude("otra cosa"))
        #expect(ClaudeError.timeout.status == 504)
        #expect(ClaudeError.claude("x").status == 500)
    }

    @Test("timeout -> 504, error guardado y ningún proceso huérfano (ni el hijo del claude)")
    func timeout504() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend { $0.timeout = 1 }
        let t0 = Date()
        let r = await chat(b, message: "LENTO")
        #expect(r.status == 504)
        #expect(r.obj["error"] as? String == ClaudeError.timeout.mensaje)
        #expect(Date().timeIntervalSince(t0) < 8)
        #expect(b.runner.procesosVivos == 0)
        let pid = try #require(sb.childPid)
        #expect(await esperar(hasta: 3) { !vivo(pid) }, "el hijo del claude falso sigue vivo")
        let h = msgs(await historial(b, session: U.a))
        #expect(h.last?["e"] as? Bool == true)
        #expect(h.last?["t"] as? String == "No pude responder: Tardó demasiado en responder.")
        // la app sigue usable después de un timeout
        let r2 = await chat(b, message: "ok", session: U.b)
        #expect(r2.status == 200)
    }

    @Test("el timeout de un agente no bloquea a otro, y su carril se libera")
    func timeoutLiberaCarril() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend { $0.timeout = 1 }
        _ = await chat(b, message: "LENTO")
        let r = await chat(b, message: "siguiente", session: U.b)   // mismo agente, mismo carril
        #expect(r.status == 200)
    }

    @Test("shutdown() en pleno chat termina el proceso, el chat devuelve 'cerrando' y no queda huérfano")
    func shutdownEnPlenoChat() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        let tarea = Task { await chat(b, message: "LENTO") }
        #expect(await esperar { sb.childPid != nil })
        let pid = try #require(sb.childPid)
        #expect(vivo(pid))
        let t0 = Date()
        await b.shutdown()
        #expect(Date().timeIntervalSince(t0) < 6)
        let r = await tarea.value
        #expect(r.status == 500)
        #expect(r.obj["error"] as? String == ClaudeError.cerrando.mensaje)
        #expect(b.runner.procesosVivos == 0)
        #expect(await esperar(hasta: 3) { !vivo(pid) }, "el hijo del claude falso sigue vivo tras shutdown")
    }

    @Test("después de shutdown() un chat nuevo no lanza claude")
    func chatTrasShutdown() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        await b.shutdown()
        let r = await chat(b)
        #expect(r.status == 500)
        #expect(sb.llamadas.isEmpty)
    }

    @Test("shutdown() sin procesos en curso es inmediato e idempotente")
    func shutdownSinNada() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        await b.runner.shutdown()
        await b.runner.shutdown()
        #expect(b.runner.procesosVivos == 0)
    }

    @Test("shutdown() mata el proceso que ignora SIGTERM (kill tras la gracia)")
    func shutdownKillSiIgnoraTerm() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        // claude falso que ignora SIGTERM
        let terco = sb.root + "/bin/terco"
        let s = "#!/bin/bash\ntrap '' TERM\necho $$ > \"$(dirname \"$0\")/terco.pid\"\nwhile true; do sleep 0.1; done\n"
        FileManager.default.createFile(atPath: terco, contents: Data(s.utf8), attributes: [.posixPermissions: 0o755])
        let cfg = sb.config()
        let log = HQLog(dir: nil)
        let runner = ClaudeRunner(config: cfg, resolver: ClaudePathResolver(fijo: terco), log: log, grace: 1)
        let tarea = Task { try await runner.enviar(agente: "betty", mensaje: "x", sid: U.a, activa: false) }
        let pidPath = sb.root + "/bin/terco.pid"
        #expect(await esperar { FileManager.default.fileExists(atPath: pidPath) })
        let pid = Int32((try String(contentsOfFile: pidPath, encoding: .utf8)).trimmingCharacters(in: .whitespacesAndNewlines))!
        #expect(vivo(pid))
        await runner.shutdown()
        #expect(await esperar(hasta: 3) { !vivo(pid) })
        _ = await tarea.result
    }

    @Test("un mismo agente se serializa: S,E,S,E (nunca dos a la vez)")
    func serializacionPorAgente() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        async let r1 = chat(b, agent: "betty", message: "DORMIR 1", session: U.a)
        async let r2 = chat(b, agent: "betty", message: "DORMIR 2", session: U.b)
        async let r3 = chat(b, agent: "betty", message: "DORMIR 3", session: U.c)
        let rs = await [r1, r2, r3]
        #expect(rs.allSatisfy { $0.status == 200 })
        #expect(sb.eventos == ["S betty", "E betty", "S betty", "E betty", "S betty", "E betty"])
    }

    @Test("agentes distintos corren en paralelo")
    func paralelismoEntreAgentes() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        let t0 = Date()
        async let r1 = chat(b, agent: "betty", message: "DORMIR", session: U.a)
        async let r2 = chat(b, agent: "marce", message: "DORMIR", session: U.b)
        async let r3 = chat(b, agent: "sofia", message: "DORMIR", session: U.c)
        let rs = await [r1, r2, r3]
        let dt = Date().timeIntervalSince(t0)
        #expect(rs.allSatisfy { $0.status == 200 })
        let ev = sb.eventos
        #expect(ev.count == 6)
        // los tres arrancan antes de que termine el primero
        #expect(Array(ev.prefix(3)).allSatisfy { $0.hasPrefix("S ") })
        #expect(Set(ev.prefix(3)) == ["S betty", "S marce", "S sofia"])
        #expect(dt < 2.6, "tardó \(dt)s: parece secuencial")
    }

    @Test("dos mensajes seguidos al mismo agente: el segundo ya usa --resume (carril cubre guardar+ejecutar)")
    func carrilCubreEstadoActiva() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        async let r1 = chat(b, message: "DORMIR uno", session: U.a)
        try await Task.sleep(nanoseconds: 200_000_000)
        async let r2 = chat(b, message: "dos", session: U.a)
        _ = await [r1, r2]
        let ll = sb.llamadas
        #expect(ll.count == 2)
        #expect(ll[0].contains("--session-id"))
        #expect(ll[1].contains("--resume"))
        // orden en el historial: u, a, u, a
        #expect(msgs(await historial(b, session: U.a)).map { $0["r"] as? String } == ["u", "a", "u", "a"])
    }

    @Test("el claude hijo corre con cwd = carpeta del proyecto")
    func cwdEsElProyecto() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let pwdBin = sb.root + "/bin/pwdclaude"
        let s = "#!/bin/bash\npwd -P > \"$(dirname \"$0\")/cwd.txt\"\necho '{\"result\":\"ok\",\"is_error\":false}'\n"
        FileManager.default.createFile(atPath: pwdBin, contents: Data(s.utf8), attributes: [.posixPermissions: 0o755])
        let b = try sb.backend(claudePath: pwdBin)
        _ = await chat(b)
        let cwd = try String(contentsOfFile: sb.root + "/bin/cwd.txt", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        func sinPrivate(_ p: String) -> String { p.hasPrefix("/private/") ? String(p.dropFirst(8)) : p }
        #expect(sinPrivate(cwd) == sinPrivate(sb.proyecto))
    }

    @Test("authStatus: true/false según rc; nil sin claude")
    func authStatus() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        #expect(await b.runner.authStatus(timeout: 10) == true)
        sb.setAuth(false)
        #expect(await b.runner.authStatus(timeout: 10) == false)
        let sin = try sb.backend(claudePath: sb.root + "/nada/claude")
        #expect(await sin.runner.authStatus(timeout: 10) == nil)
    }

    @Test("ClaudeLocator: sin nada, nil; CLAUDE_BIN y config pisan; orden de rutas conocidas")
    func locator() throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        #expect(ClaudeLocator.locate(env: [:], home: sb.home, usarShell: false) == nil)
        #expect(ClaudeLocator.locate(explicito: "/x/claude", env: [:], home: sb.home, usarShell: false) == "/x/claude")
        #expect(ClaudeLocator.locate(explicito: "/x/claude", env: ["CLAUDE_BIN": "/y/claude"], home: sb.home, usarShell: false) == "/y/claude")
        // ~/.local/bin/claude del HOME temporal
        let dir = sb.home + "/.local/bin"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: dir + "/claude", contents: Data("#!/bin/bash\n".utf8), attributes: [.posixPermissions: 0o755])
        #expect(ClaudeLocator.locate(env: [:], home: sb.home, usarShell: false) == dir + "/claude")
    }

    @Test("childEnvironment: PATH incluye el dir de claude y se quita CLAUDECODE")
    func entornoHijo() {
        let e = ClaudeLocator.childEnvironment(claude: "/a/b/claude", env: ["PATH": "/zzz", "CLAUDECODE": "1", "HOME": "/h"], home: "/h")
        #expect(e["CLAUDECODE"] == nil)
        let p = (e["PATH"] ?? "").split(separator: ":").map(String.init)
        #expect(p.first == "/a/b")
        #expect(p.contains("/zzz") && p.contains("/usr/bin"))
        #expect(Set(p).count == p.count)
    }

    @Test("childEnvironment: quita lo que inyecta una sesión de Claude Code y conserva la config del usuario")
    func entornoHijoSinSesion() {
        let heredado = ["PATH": "/zzz", "HOME": "/h", "CLAUDECODE": "1", "CLAUDE_PID": "123", "CLAUDE_EFFORT": "high",
                        "CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "CLAUDE_CODE_SESSION_ID": "x",
                        "CLAUDE_AGENT_SDK_VERSION": "1",
                        "CLAUDE_CODE_USE_BEDROCK": "1", "CLAUDE_CODE_SKIP_BEDROCK_AUTH": "1",
                        "CLAUDE_CODE_OAUTH_TOKEN": "t", "ANTHROPIC_API_KEY": "k", "CLAUDE_BIN": "/c", "OTRA": "v"]
        let e = ClaudeLocator.childEnvironment(claude: "/a/b/claude", env: heredado, home: "/h")
        for k in ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT",
                  "CLAUDE_CODE_SESSION_ID", "CLAUDE_AGENT_SDK_VERSION"] {
            #expect(e[k] == nil, "\(k) debería quitarse")
        }
        for k in ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "CLAUDE_CODE_OAUTH_TOKEN",
                  "ANTHROPIC_API_KEY", "CLAUDE_BIN", "OTRA", "HOME"] {
            #expect(e[k] == heredado[k], "\(k) debería conservarse")
        }
    }

    @Test("desdeShell: shell de login interactivo y ruta entre marcadores aunque el rc imprima ruido")
    func shellInteractivo() {
        #expect(ClaudeLocator.argumentosShell().first == "-ilc")
        let s = ClaudeLocator.marcaInicio, f = ClaudeLocator.marcaFin
        #expect(ClaudeLocator.rutaDeSalida("Bienvenido!\n/tmp/ruido\n\(s)/Users/x/.local/bin/claude\(f)") == "/Users/x/.local/bin/claude")
        #expect(ClaudeLocator.rutaDeSalida("\(s)\(f)") == nil)             // command -v no lo encontró
        #expect(ClaudeLocator.rutaDeSalida("\(s)claude: not found\(f)") == nil)
        #expect(ClaudeLocator.rutaDeSalida("/usr/local/bin/claude") == nil) // sin marcadores no se adivina
    }
}
