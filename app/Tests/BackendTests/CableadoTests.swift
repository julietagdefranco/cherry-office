import Foundation
import Testing
@testable import Backend

/// Un router extra de mentira: atiende `/api/actividad` (que el Router ya atiende) para probar que los extras van primero.
private struct ExtraFalso: SubRouter {
    func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)? {
        path == "/api/actividad" ? (200, Data("{\"extra\":true}".utf8)) : nil
    }
}

private struct ParteFalsa: MCPHerramientas {
    let nombre: String
    var definiciones: [[String: Any]] { [["name": nombre]] }
    func llamar(_ n: String, argumentos: [String: Any]) async -> MCPResultado? { n == nombre ? .ok("de \(nombre)") : nil }
}

private actor Registro {
    var entregas: [(Entrega, Ejecucion?)] = []
    var terminadas = 0
    func agregar(_ e: Entrega, _ ej: Ejecucion?) { entregas.append((e, ej)) }
    func termino() { terminadas += 1 }
    var cuantas: Int { entregas.count }
}

/// Cableado de la ejecución: comando de claude, MCP por perfil, ganchos del programador y routers extra.
@Suite("Cableado de ejecución", .serialized)
struct CableadoTests {
    static let home = "/tmp/hqtest-home"

    func cfg() -> Config { Config(home: Self.home) }

    func fix() async throws -> Fix {
        try await Fix.crear(deps: ["Dirección"], agentes: [("marce", "direccion", "Directora")], env: ["HQ_PROGRAMADOR": "0"])
    }

    // MARK: comando

    @Test("argumentos de un agente de oficina: orden exacto con todos los campos")
    func ordenExacto() {
        var ctx = ContextoOficina(carpeta: "/o", escritura: ["/o/notas.md", "/o/ent/**"], dirsExtra: ["/d1", "/d2"], mcpUrl: "http://127.0.0.1:1/mcp")
        ctx.instrucciones = "Reglas de la oficina"
        ctx.herramientasMCP = ["mcp__hq__colegas", "mcp__hq__encargar"]
        ctx.herramientasBase = "Read,Grep"
        ctx.permitidas = ["mcp__claude_ai_Gmail__search_threads"]
        ctx.vedadas = ["mcp__claude_ai_Gmail__send_message"]
        let a = Permisos.argumentos(cfg(), oficina: ctx, agente: "marce", mensaje: "hola", sid: U.a, flag: "--session-id")
        let esperado = ["-p", "--agent", "marce", "--session-id", U.a, "--output-format", "stream-json", "--verbose",
                        "--tools", "Read,Grep,Edit,Write,mcp__hq__colegas,mcp__hq__encargar",
                        "--permission-mode", "dontAsk",
                        "--mcp-config", Permisos.configMCP(url: "http://127.0.0.1:1/mcp"),
                        "--add-dir", "/d1", "--add-dir", "/d2",
                        "--allowedTools", "Read", "Grep", "Edit(//o/notas.md)", "Write(//o/notas.md)", "Edit(//o/ent/**)", "Write(//o/ent/**)",
                        "mcp__hq__colegas", "mcp__hq__encargar", "mcp__claude_ai_Gmail__search_threads",
                        "--disallowedTools", "mcp__claude_ai_Gmail__send_message",
                        "--append-system-prompt", "Reglas de la oficina",
                        "--", "hola"]
        #expect(a == esperado)
    }

    @Test("sin mcpUrl no hay --mcp-config ni herramientas MCP; sin vedadas ni instrucciones no hay esas opciones")
    func sinOpcionales() {
        let ctx = ContextoOficina(carpeta: "/o", escritura: [])
        let a = Permisos.argumentos(cfg(), oficina: ctx, agente: "marce", mensaje: "m", sid: U.a, flag: "--resume")
        #expect(!a.contains("--mcp-config") && !a.contains("--disallowedTools") && !a.contains("--append-system-prompt"))
        #expect(a.contains("--allowedTools"))
        #expect(Sandbox.valor(a, "--tools") == "Read,Glob,Grep,Skill")
        #expect(a.suffix(2) == ["--", "m"])
    }

    @Test("un agente común: dontAsk y la veda de los conectores de claude.ai")
    func agenteComun() async throws {
        let f = try await fix()
        _ = await chat(f.b, agent: "marce", message: "hola", session: U.a)
        let l = try #require(f.sb.llamadas.last)
        #expect(Sandbox.valor(l, "--permission-mode") == "dontAsk")
        #expect(Sandbox.valor(l, "--disallowedTools") == "mcp__claude_ai_*")
        #expect(!l.contains("--append-system-prompt"))
    }

    @Test("entorno: MCP_CONNECTION_NONBLOCKING=false solo si hay conectores de claude.ai permitidos")
    func entorno() {
        var ctx = ContextoOficina(carpeta: "/o", escritura: [])
        #expect(Permisos.entorno(ctx).isEmpty)
        ctx.permitidas = ["mcp__hq__otra"]
        #expect(Permisos.entorno(ctx).isEmpty)
        ctx.permitidas = ["mcp__claude_ai_Gmail__search_threads"]
        #expect(Permisos.entorno(ctx) == ["MCP_CONNECTION_NONBLOCKING": "false"])
    }

    @Test("entorno: MCP_CONNECTION_NONBLOCKING=false llega al proceso hijo de ejecutarChat (sin conectores no se toca)")
    func entornoLlegaAlHijo() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        // claude falso mínimo que anota la variable (o «-») y responde bien
        let bin = sb.root + "/bin/claude-env"
        let salida = sb.root + "/bin/env.log"
        let s = "#!/bin/bash\necho \"${MCP_CONNECTION_NONBLOCKING:--}\" >> \"\(salida)\"\necho '{\"result\":\"ok\",\"is_error\":false}'\n"
        FileManager.default.createFile(atPath: bin, contents: Data(s.utf8), attributes: [.posixPermissions: 0o755])
        let runner = ClaudeRunner(config: sb.config(), resolver: ClaudePathResolver(fijo: bin), log: HQLog(dir: nil))
        var ctx = ContextoOficina(carpeta: sb.root, escritura: [])
        _ = try await runner.ejecutarChat(agente: "a", mensaje: "x", sid: U.a, activa: false, oficina: ctx)
        ctx.permitidas = ["mcp__claude_ai_Gmail__search_threads"]
        _ = try await runner.ejecutarChat(agente: "a", mensaje: "x", sid: U.b, activa: false, oficina: ctx)
        let lineas = try String(contentsOfFile: salida, encoding: .utf8).split(separator: "\n").map(String.init)
        // sin conectores no se toca lo heredado (una sesión de Claude Code puede traer «true»); con conectores, «false»
        let heredada = ProcessInfo.processInfo.environment["MCP_CONNECTION_NONBLOCKING"] ?? "-"
        #expect(lineas == [heredada, "false"])
    }

    @Test("turnoSoloLectura: orden exacto, con y sin instrucciones")
    func soloLectura() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        let act = try #require(await b.oficinas.activa())
        _ = try await b.runner.turnoSoloLectura(agente: "betty", prompt: "p1", cwd: act.carpeta, dirsExtra: ["/dx"], instrucciones: "Sé breve")
        _ = try await b.runner.turnoSoloLectura(agente: "betty", prompt: "p2", cwd: act.carpeta)
        let ll = sb.llamadas
        let a1 = try #require(ll.first), a2 = try #require(ll.last)
        let sid1 = try #require(Sandbox.valor(a1, "--session-id"))
        #expect(a1 == ["-p", "--agent", "betty", "--session-id", sid1, "--output-format", "stream-json", "--verbose",
                       "--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk", "--add-dir", "/dx",
                       "--allowedTools", "Read", "Glob", "Grep", "--disallowedTools", "mcp__claude_ai_*",
                       "--append-system-prompt", "Sé breve", "--", "p1"])
        #expect(!a2.contains("--append-system-prompt") && a2.suffix(2) == ["--", "p2"])
    }

    // MARK: programador

    @Test("origenEntrega por prefijo y deFlujo / idFlujo")
    func origenes() {
        #expect(Programador.origenEntrega("encargo:r1:0") == "encargo")
        #expect(Programador.origenEntrega("coord:ab12cd34") == "encargo")
        #expect(Programador.origenEntrega("flujo:4:2:1") == "flujo")
        #expect(Programador.origenEntrega("accion:7") == "accion")
        #expect(Programador.origenEntrega("parte:2026-11-13") == "parte")
        #expect(Programador.origenEntrega("informe") == "tarea")
        #expect(Programador.idFlujo(corrida: 4, paso: 2, intento: 1) == "flujo:4:2:1")
        let d = Programador.deFlujo("flujo:4:2:1")
        #expect(d?.0 == 4 && d?.1 == 2 && d?.2 == 1)
        #expect(Programador.deFlujo("flujo:4:2") == nil && Programador.deFlujo("tarea") == nil && Programador.deFlujo("flujo:a:2:1") == nil)
    }

    @Test("encargarLibre con flujo:1:0:1: entrega con origen flujo y dispara alEntregar con la ejecución")
    func encargarLibre() async throws {
        let f = try await fix()
        let reg = Registro()
        await f.b.programador.alEntregar { e, ej in await reg.agregar(e, ej) }
        let act = try #require(await f.b.oficinas.activa())
        let def = try #require(act.oficina.agente("marce"))
        let ej = try await f.b.programador.encargarLibre(act, def, id: "flujo:1:0:1", nombre: "Paso uno", consigna: "Hacé el paso")
        #expect(ej.tarea == "flujo:1:0:1")
        #expect(await esperarAsync { await reg.cuantas == 1 })
        let (e, fin) = try #require(await reg.entregas.first)
        #expect(e.origen == "flujo" && e.ref == "flujo:1:0:1" && e.agente == "marce")
        #expect(fin?.id == ej.id && fin?.estado == "ok")
        let r = await f.get("/api/entregas")
        #expect(lista(r.obj["entregas"]).first.map { str($0["origen"]) } == "flujo")
    }

    @Test("alTerminar agrega ganchos (no reemplaza)")
    func ganchosEnLista() async throws {
        let f = try await fix()
        let n = Registro()
        await f.b.programador.alTerminar { _ in await n.termino() }
        await f.b.programador.alTerminar { _ in await n.termino() }
        let act = try #require(await f.b.oficinas.activa())
        let def = try #require(act.oficina.agente("marce"))
        _ = try await f.b.programador.encargarLibre(act, def, id: "coord:abcd1234", nombre: "X", consigna: "hola")
        #expect(await esperarAsync { await n.terminadas >= 2 })
    }

    @Test("una corrida del programador con MCP pasa --mcp-config y las herramientas del perfil, y revoca el token")
    func tareaConMCP() async throws {
        let f = try await fix()
        let act = try #require(await f.b.oficinas.activa())
        let def = try #require(act.oficina.agente("marce"))
        let ej = try await f.b.programador.encargarLibre(act, def, id: "coord:abcd1234", nombre: "X", consigna: "hola")
        #expect(await esperarAsync { await f.b.store.ejecucion(ej.id)?.estado != "corriendo" })
        let l = try #require(f.sb.llamadas.last)
        let cfgMCP = try #require(Sandbox.valor(l, "--mcp-config"))
        #expect(cfgMCP.contains("http://127.0.0.1:"))
        #expect(Sandbox.valor(l, "--tools")?.hasSuffix("mcp__hq__consultar,mcp__hq__colegas") == true)
        #expect(Sandbox.reglas(l).contains("mcp__hq__consultar"))
        #expect(f.b.mcp.tokens.activos == 0)
    }

    // MARK: MCP

    @Test("tokens: perfil por defecto 'agente', perfil explícito y cupo genérico tomar(clave:max:)")
    func tokens() {
        let t = MCPTokens()
        let a = t.emitir(oficina: "/o", agente: "marce", sid: U.a)
        let c = t.emitir(oficina: "/o", agente: "creador", sid: U.b, perfil: "creador")
        #expect(t.identidad(a)?.perfil == "agente" && t.identidad(c)?.perfil == "creador")
        #expect(t.tomar(a, clave: "encargar", max: 2) && t.tomar(a, clave: "encargar", max: 2))
        #expect(!t.tomar(a, clave: "encargar", max: 2))
        #expect(t.tomar(a, clave: "otra", max: 1))      // otra clave, otro cupo
        #expect(t.tomar(c, clave: "encargar", max: 1))  // otro token, otro cupo
        t.revocar(a)
        #expect(!t.tomar(a, clave: "otra", max: 5))
    }

    @Test("HerramientasCompuestas: concatena definiciones y llama al primero que responde")
    func compuestas() async {
        let h = HerramientasCompuestas(partes: [ParteFalsa(nombre: "a"), ParteFalsa(nombre: "b")])
        #expect(h.definiciones.compactMap { $0["name"] as? String } == ["a", "b"])
        #expect(await h.llamar("b", argumentos: [:]) == .ok("de b"))
        #expect(await h.llamar("a", argumentos: [:]) == .ok("de a"))
        #expect(await h.llamar("z", argumentos: [:]) == nil)
        #expect(HerramientasVacias().definiciones.isEmpty)
        #expect(await HerramientasVacias().llamar("a", argumentos: [:]) == nil)
    }

    @Test("el servidor compone por perfil: agente -> hq; creador -> las del Creador")
    func perfiles() async throws {
        let f = try await fix()
        let c = f.b.mcp.consultas
        let ag = c.herramientas(token: "t", identidad: IdentidadMCP(oficina: f.carpeta, agente: "marce", sid: U.a))
        #expect(ag.definiciones.compactMap { $0["name"] as? String } == ["colegas", "consultar"])
        let cr = c.herramientas(token: "t", identidad: IdentidadMCP(oficina: f.carpeta, agente: "creador", sid: U.a, perfil: "creador"))
        #expect(cr.definiciones.compactMap { $0["name"] as? String }.map { "mcp__hq__" + $0 } == Creador.nombresMCP)
    }

    @Test("lista de herramientas MCP del agente: sin duplicados, empieza por las propias de hq")
    func listaMCP() async throws {
        let f = try await fix()
        let act = try #require(await f.b.oficinas.activa())
        let def = try #require(act.oficina.agente("marce"))
        #expect(HerramientasMCPAgente.lista(act.oficina, def) == Permisos.herramientasMCP)
    }

    // MARK: router y API

    @Test("un router extra atiende antes que los demás")
    func routerExtra() async throws {
        let f = try await fix()
        let antes = await f.get("/api/actividad")
        #expect(antes.obj["extra"] == nil)
        f.b.registrarExtra(ExtraFalso())
        let r = await f.get("/api/actividad")
        #expect(r.obj["extra"] as? Bool == true)
        // lo que el extra no atiende sigue su camino
        #expect((await f.get("/api/estado")).status == 200)
    }

    @Test("/api/actividad trae corridas y creadorVersion (con y sin oficina)")
    func actividad() async throws {
        let f = try await fix()
        var r = await f.get("/api/actividad")
        #expect(lista(r.obj["corridas"]).isEmpty)
        #expect(r.obj["creadorVersion"] as? Int == 0)
        VersionCreador.compartida.subir(f.carpeta)
        r = await f.get("/api/actividad")
        #expect(r.obj["creadorVersion"] as? Int == VersionCreador.compartida.valor(f.carpeta))
        #expect((r.obj["creadorVersion"] as? Int ?? 0) >= 1)
        // sin oficina activa
        let sb = Sandbox(proyecto: false); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend(oficina: false)
        let v = await llamar(b, "GET", "/api/actividad")
        #expect((v.obj["corridas"] as? [Any])?.isEmpty == true && v.obj["creadorVersion"] as? Int == 0)
    }

    @Test("VersionCreador sube por oficina; CatalogoConectores guarda y limpia")
    func estadoCompartido() {
        let v = VersionCreador()
        #expect(v.valor("/a") == 0 && v.subir("/a") == 1 && v.subir("/a") == 2 && v.valor("/b") == 0)
        let c = CatalogoConectores()
        #expect(c.servidores() == nil && c.detectado() == nil)
        let s = ServidorConector(nombre: "Gmail", prefijo: "mcp__claude_ai_Gmail", estado: "connected",
                                 herramientas: ["mcp__claude_ai_Gmail__search_threads"])
        c.fijar([s, ServidorConector(nombre: "X", prefijo: "mcp__claude_ai_X", estado: "needs-auth")], en: Date(timeIntervalSince1970: 5))
        #expect(c.servidores()?.map(\.disponible) == [true, false] && c.detectado() == Date(timeIntervalSince1970: 5))
        c.limpiar()
        #expect(c.servidores() == nil)
    }
}
