import Foundation
import Testing
@testable import Backend

/// Gobierno: instrucciones inyectadas (reglas, límites, conectores), conectores por agente y acciones aprobadas por la persona.
/// Siempre con el claude falso: nunca se toca la cuenta real.
@Suite("Gobierno: instrucciones, conectores y acciones", .serialized)
struct GobiernoTests {
    static let leerCal = "mcp__claude_ai_Google_Calendar__list_events"
    static let verCal = "mcp__claude_ai_Google_Calendar__get_event"
    static let crearCal = "mcp__claude_ai_Google_Calendar__create_event"
    static let leerMail = "mcp__claude_ai_Gmail__search_threads"
    static let enviarMail = "mcp__claude_ai_Gmail__send_message"

    func fix(_ agentes: [(id: String, depto: String, rol: String?)] = [("marce", "direccion", "Directora")]) async throws -> Fix {
        CatalogoConectores.compartido.limpiar()
        return try await Fix.crear(deps: ["Dirección"], agentes: agentes, env: ["HQ_PROGRAMADOR": "0"])
    }

    func conectoresCalendar(actuar: Bool = true) -> [String: Any] {
        ["servidor": "Google Calendar", "leer": [Self.leerCal, Self.verCal], "actuar": actuar ? [Self.crearCal] : []]
    }

    func asignar(_ f: Fix, _ conectores: [[String: Any]], agente: String = "marce") async throws {
        let r = await f.patch("/api/agentes/\(agente)", ["conectores": conectores])
        try #require(r.status == 200, "asignar conectores: \(r.obj)")
    }

    func agente(conectores: [ConectorAsignado]? = nil, limites: LimitesAgente? = nil, permisos: [String]? = nil) -> AgenteDef {
        AgenteDef(id: "sofia", nombre: "Sofía", rol: "Directora", departamento: "dir", limites: limites, conectores: conectores, permisos: permisos)
    }

    func oficina(duenio: String = "Ana", reglas: [Regla]? = nil) -> Oficina {
        Oficina(nombre: "O", duenio: duenio, departamentos: [Departamento(id: "dir", nombre: "Dir", color: "#aabbcc")], agentes: [], reglas: reglas)
    }

    let catalogo = [
        ServidorConector(nombre: "Google Calendar", prefijo: "mcp__claude_ai_Google_Calendar", estado: "connected",
                         herramientas: [GobiernoTests.leerCal, GobiernoTests.verCal, GobiernoTests.crearCal]),
        ServidorConector(nombre: "Gmail", prefijo: "mcp__claude_ai_Gmail", estado: "connected",
                         herramientas: [GobiernoTests.leerMail, GobiernoTests.enviarMail]),
    ]

    // MARK: instrucciones

    @Test("Instrucciones: arma reglas, límites, conectores y coordinador")
    func instruccionesCompletas() throws {
        let o = oficina(reglas: [Regla(id: "a", texto: "No inventes datos."), Regla(id: "b", texto: "Citá la fuente.")])
        let a = agente(conectores: [ConectorAsignado(servidor: "Google Calendar", leer: [Self.leerCal, Self.verCal], actuar: [Self.crearCal]),
                                    ConectorAsignado(servidor: "Gmail", leer: [], actuar: [Self.enviarMail])],
                       limites: LimitesAgente(solo: ["Diseñar fichas"], proponer: ["Cambiar el plan"]), permisos: ["coordinador"])
        let t = try #require(Instrucciones.para(o, a))
        #expect(t.contains("## Reglas de la oficina\n- No inventes datos.\n- Citá la fuente."))
        #expect(t.contains("## Tus límites"))
        #expect(t.contains("Hacés solo: Diseñar fichas."))
        #expect(t.contains("Dejás como propuesta y esperás la aprobación de Ana: Cambiar el plan."))
        #expect(t.contains("Nunca hacés directo nada que salga de la oficina"))
        #expect(t.contains("## Conectores"))
        #expect(t.contains("Podés leer con: Google Calendar (list_events, get_event)."))
        #expect(t.contains("Para actuar con Google Calendar (create_event); Gmail (send_message) usá la herramienta proponer_accion: Ana la aprueba"))
        #expect(t.contains("## Sos coordinador/a de la oficina"))
        #expect(t.contains("estado_oficina, entregas, corridas, bloqueos"))
    }

    @Test("Instrucciones: nil si no hay nada; sin dueño dice «la persona»; la frase de salida va con límites, actuar o reglas")
    func instruccionesNil() throws {
        #expect(Instrucciones.para(oficina(), agente()) == nil)
        // solo leer: ni límites ni frase de salida
        let leer = try #require(Instrucciones.para(oficina(), agente(conectores: [ConectorAsignado(servidor: "G", leer: [Self.leerCal])])))
        #expect(leer.contains("## Conectores") && !leer.contains("## Tus límites"))
        // solo reglas: lleva la frase
        let r = try #require(Instrucciones.para(oficina(reglas: [Regla(id: "a", texto: "Sé breve.")]), agente()))
        #expect(r.contains("Nunca hacés directo nada que salga de la oficina"))
        // actuar sin dueño
        let sd = try #require(Instrucciones.para(oficina(duenio: ""), agente(conectores: [ConectorAsignado(servidor: "G", actuar: [Self.crearCal])])))
        #expect(sd.contains("proponer_accion: la persona la aprueba"))
        #expect(!sd.contains("Podés leer con"))
    }

    @Test("Instrucciones: tope de 8000 caracteres")
    func instruccionesTope() throws {
        let reglas = (0..<40).map { Regla(id: "r\($0)", texto: String(repeating: "x", count: 590)) }
        let t = try #require(Instrucciones.para(oficina(reglas: reglas), agente()))
        #expect(t.count == 8000)
    }

    @Test("un chat con reglas lleva --append-system-prompt")
    func chatConReglas() async throws {
        let f = try await fix()
        let p = await f.b.llamarReglas(f, [["texto": "No inventes datos."]])
        #expect(p.status == 200)
        _ = await chat(f.b, agent: "marce", message: "hola", session: U.a)
        let l = try #require(f.sb.llamadas.last)
        let i = try #require(Sandbox.valor(l, "--append-system-prompt"))
        #expect(i.contains("## Reglas de la oficina") && i.contains("No inventes datos."))
    }

    @Test("una reunión lleva --append-system-prompt con las reglas")
    func reunionConReglas() async throws {
        let f = try await fix([("marce", "direccion", "Directora"), ("nico", "direccion", "Analista")])
        #expect(await f.b.llamarReglas(f, [["texto": "Hablá en voseo."]]).status == 200)
        let r = await f.post("/api/reuniones", ["tema": "plan", "agentes": ["marce", "nico"]])
        try #require(r.status == 200 || r.status == 202, "\(r.obj)")
        #expect(await esperarAsync(hasta: 15) { !f.sb.llamadas(conPrompt: "en una reuni").isEmpty })
        let l = try #require(f.sb.llamadas(conPrompt: "en una reuni").first)
        #expect(Sandbox.valor(l, "--append-system-prompt")?.contains("Hablá en voseo.") == true)
        #expect(Sandbox.valor(l, "--disallowedTools") == "mcp__claude_ai_*")
    }

    // MARK: conectores

    @Test("parsearInit: servidores de claude.ai, su prefijo y sus herramientas")
    func parsearInit() throws {
        let l = #"{"type":"system","subtype":"init","mcp_servers":[{"name":"claude.ai Google Calendar","status":"connected","source":"claudeai"},{"name":"claude.ai Gmail","status":"needs-auth","source":"claudeai"},{"name":"hq","status":"connected","source":"project"}],"tools":["Read","mcp__claude_ai_Google_Calendar__list_events","mcp__claude_ai_Google_Calendar__create_event","mcp__hq__colegas"]}"#
        let s = try #require(Conectores.parsearInit(l))
        #expect(s.map(\.nombre) == ["Google Calendar", "Gmail"])
        #expect(s[0].prefijo == "mcp__claude_ai_Google_Calendar" && s[0].disponible)
        #expect(s[0].herramientas == [Self.leerCal, Self.crearCal])
        #expect(s[1].estado == "needs-auth" && !s[1].disponible && s[1].herramientas.isEmpty)
        #expect(Conectores.parsearInit(#"{"type":"result","result":"ok"}"#) == nil)
        #expect(Conectores.parsearInit("no es json") == nil)
        #expect(Conectores.parsearInit(#"{"type":"system","subtype":"init"}"#)?.isEmpty == true)
    }

    @Test("clasificar: leer por prefijo (también camelCase), actuar si hay duda")
    func clasificar() {
        for l in ["list_events", "get_event", "search_threads", "read_file_content", "find_duplicates", "fetch", "download_file_content",
                  "query", "lookup_user", "suggest_time", "listEvents", "getThread", "searchConfluenceUsingCql", "LookupJiraAccountId"] {
            #expect(Conectores.clasificar(l) == "leer", "\(l)")
        }
        for l in ["create_event", "send_message", "trash_file", "update_values", "delete_draft", "share_file", "forward", "createDraft", "algo_raro"] {
            #expect(Conectores.clasificar(l) == "actuar", "\(l)")
        }
        #expect(Conectores.corto("mcp__claude_ai_Gmail__send_message") == "send_message")
    }

    @Test("ConectoresAgente: veda create_event y Gmail; pedir actuar habilita create_event")
    func conectoresAgente() {
        let a = agente(conectores: [ConectorAsignado(servidor: "Google Calendar", leer: [Self.leerCal, Self.verCal], actuar: [Self.crearCal])])
        let (p, v) = ConectoresAgente.herramientas(oficina(), a, catalogo: catalogo, actuar: [])
        #expect(p == [Self.leerCal, Self.verCal])
        #expect(Set(v) == [Self.crearCal, "mcp__claude_ai_Gmail"])
        let (p2, v2) = ConectoresAgente.herramientas(oficina(), a, catalogo: catalogo, actuar: [Self.crearCal])
        #expect(p2 == [Self.leerCal, Self.verCal, Self.crearCal])
        #expect(v2 == ["mcp__claude_ai_Gmail"])
        // pedir actuar algo que no tiene asignado no sirve
        let (p3, _) = ConectoresAgente.herramientas(oficina(), a, catalogo: catalogo, actuar: [Self.enviarMail])
        #expect(!p3.contains(Self.enviarMail))
    }

    @Test("ConectoresAgente: sin catálogo no veda nada; sin permitidas veda todos los conectores")
    func conectoresAgenteBordes() {
        let a = agente(conectores: [ConectorAsignado(servidor: "Google Calendar", leer: [Self.leerCal])])
        let (p, v) = ConectoresAgente.herramientas(oficina(), a, catalogo: nil, actuar: [])
        #expect(p == [Self.leerCal] && v.isEmpty)
        for ag in [agente(), agente(conectores: [ConectorAsignado(servidor: "Gmail", actuar: [Self.enviarMail])])] {
            let (pp, vv) = ConectoresAgente.herramientas(oficina(), ag, catalogo: catalogo, actuar: [])
            #expect(pp.isEmpty && vv == ["mcp__claude_ai_*"])
        }
        let (p0, v0) = ConectoresAgente.herramientas(oficina(), agente(), catalogo: nil, actuar: [])
        #expect(p0.isEmpty && v0 == ["mcp__claude_ai_*"])
    }

    @Test("un chat con conectores asignados: permitidas en --allowedTools, vedados los demás y el entorno de conexión")
    func chatConConectores() async throws {
        let f = try await fix()
        CatalogoConectores.compartido.fijar(catalogo)
        defer { CatalogoConectores.compartido.limpiar() }
        try await asignar(f, [conectoresCalendar()])
        _ = await chat(f.b, agent: "marce", message: "hola", session: U.a)
        let l = try #require(f.sb.llamadas.last)
        let reglas = Array(Sandbox.reglas(l).prefix { !$0.hasPrefix("--") })
        #expect(reglas.contains(Self.leerCal) && reglas.contains(Self.verCal) && !reglas.contains(Self.crearCal))
        #expect(reglas.contains("mcp__hq__proponer_accion"))
        let vedadas = l[(l.firstIndex(of: "--disallowedTools")! + 1)...].prefix { !$0.hasPrefix("--") }
        #expect(Set(vedadas) == [Self.crearCal, "mcp__claude_ai_Gmail"])
        #expect(Sandbox.valor(l, "--append-system-prompt")?.contains("proponer_accion") == true)
    }

    /// Un claude falso que emite un `system/init` con conectores y anota sus argumentos y el entorno.
    func claudeConInit(_ sb: Sandbox) -> String {
        let bin = sb.root + "/bin/claude-init"
        let s = #"""
        #!/bin/bash
        D="$(cd "$(dirname "$0")" && pwd)"
        if [[ "$1" == "auth" ]]; then echo '{"loggedIn":true}'; exit 0; fi
        printf '%s\x1f' "$@" >> "$D/det.log"; echo "NB=${MCP_CONNECTION_NONBLOCKING:--}" >> "$D/det.log"
        echo '{"type":"system","subtype":"hook_started"}'
        echo '{"type":"system","subtype":"init","mcp_servers":[{"name":"claude.ai Google Calendar","status":"connected","source":"claudeai"},{"name":"claude.ai Gmail","status":"needs-auth","source":"claudeai"},{"name":"hq","status":"connected","source":"project"}],"tools":["Read","mcp__claude_ai_Google_Calendar__list_events","mcp__claude_ai_Google_Calendar__create_event","mcp__hq__colegas"]}'
        echo '{"type":"result","result":"ok","is_error":false}'
        """#
        FileManager.default.createFile(atPath: bin, contents: Data(s.utf8), attributes: [.posixPermissions: 0o755])
        return bin
    }

    @Test("POST /api/conectores/actualizar detecta con haiku, sin herramientas y sin bloqueo, y GET lo devuelve clasificado")
    func detectarConectores() async throws {
        CatalogoConectores.compartido.limpiar()
        defer { CatalogoConectores.compartido.limpiar() }
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend(claudePath: claudeConInit(sb))
        let r = await llamar(b, "POST", "/api/conectores/actualizar")
        #expect(r.status == 200 && r.obj["error"] == nil)
        #expect(r.obj["detectando"] as? Bool == false)
        let s = lista(r.obj["servidores"])
        #expect(s.map { str($0["nombre"]) } == ["Google Calendar", "Gmail"])
        #expect(s[0]["disponible"] as? Bool == true && s[1]["disponible"] as? Bool == false)
        let hs = lista(s[0]["herramientas"])
        #expect(hs.map { str($0["corto"]) } == ["list_events", "create_event"])
        #expect(hs.map { str($0["tipo"]) } == ["leer", "actuar"])
        #expect(str(hs[0]["nombre"]) == Self.leerCal)
        #expect(!str(r.obj["detectado"]).isEmpty)
        let log = leerTexto(sb.binDir + "/det.log")
        #expect(log.contains("NB=false"))
        let args = log.components(separatedBy: "NB=").first!.components(separatedBy: "\u{1f}")
        #expect(Sandbox.valor(args, "--model") == "haiku" && Sandbox.valor(args, "--tools") == "")
        #expect(Sandbox.valor(args, "--permission-mode") == "dontAsk")
        #expect(args.contains("--output-format") && args.contains("stream-json") && args.contains("--verbose"))
        #expect(!args.contains("--allowedTools"))
        let g = await llamar(b, "GET", "/api/conectores")
        #expect(lista(g.obj["servidores"]).count == 2)
    }

    @Test("GET /api/conectores sin detección previa la lanza una vez en segundo plano; nunca al arrancar")
    func detectarPerezoso() async throws {
        CatalogoConectores.compartido.limpiar()
        defer { CatalogoConectores.compartido.limpiar() }
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend(claudePath: claudeConInit(sb))
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(!existe(sb.binDir + "/det.log"), "arrancar el backend no detecta")
        let g = await llamar(b, "GET", "/api/conectores")
        #expect(g.status == 200 && g.obj["detectado"] is NSNull && g.obj["detectando"] is Bool)
        #expect(await esperarAsync { CatalogoConectores.compartido.servidores()?.count == 2 })
        _ = await llamar(b, "GET", "/api/conectores")
        let veces = leerTexto(sb.binDir + "/det.log").components(separatedBy: "NB=").count - 1
        #expect(veces == 1)
    }

    @Test("si la detección falla (sin system/init) devuelve el estado con el error y no toca el catálogo")
    func detectarFalla() async throws {
        let f = try await fix()
        let r = await f.post("/api/conectores/actualizar")
        #expect(r.status == 200 && !str(r.obj["error"]).isEmpty && lista(r.obj["servidores"]).isEmpty)
        #expect(CatalogoConectores.compartido.servidores() == nil)
        #expect((await llamar(f.b, "DELETE", "/api/conectores")).status == 405)
    }

    // MARK: reglas

    @Test("GET y PUT /api/reglas: ids automáticos, persistencia, vaciar y validaciones (41 reglas dan 400)")
    func reglasAPI() async throws {
        let f = try await fix()
        var r = await f.get("/api/reglas")
        #expect(r.status == 200 && lista(r.obj["reglas"]).isEmpty)
        r = await llamar(f.b, "PUT", "/api/reglas", body: json(["reglas": [["texto": "No inventes datos", "origen": "«No inventar»"],
                                                                           ["id": "uno", "texto": "Otra regla"],
                                                                           ["texto": "No inventes datos"]]]))
        #expect(r.status == 200, "\(r.obj)")
        let rs = lista(r.obj["reglas"])
        #expect(rs.map { str($0["id"]) } == ["no-inventes-datos", "uno", "no-inventes-datos-2"])
        #expect(str(rs[0]["origen"]) == "«No inventar»")
        #expect(lista(f.oficinaJSON()["reglas"]).count == 3)
        #expect(lista((await f.get("/api/reglas")).obj["reglas"]).count == 3)

        func put(_ cuerpo: Any) async -> Resp { await llamar(f.b, "PUT", "/api/reglas", body: json(cuerpo)) }
        let muchas = (0..<41).map { ["texto": "regla \($0)"] }
        #expect((await put(["reglas": muchas])).status == 400)
        #expect((await put(["reglas": [["texto": "  "]]])).status == 400)
        #expect((await put(["reglas": [["texto": String(repeating: "x", count: 601)]]])).status == 400)
        #expect((await put(["reglas": [["id": "a", "texto": "x"], ["id": "a", "texto": "y"]]])).status == 409)
        #expect((await put(["reglas": [["id": "No Valido", "texto": "x"]]])).status == 400)
        #expect((await put(["reglas": "no"])).status == 400)
        #expect((await put(["otra": 1])).status == 400)
        #expect((await llamar(f.b, "PUT", "/api/reglas")).status == 400)
        #expect(lista((await f.get("/api/reglas")).obj["reglas"]).count == 3, "los pedidos malos no cambian nada")
        #expect((await put(["reglas": (0..<40).map { ["texto": "regla \($0)"] }])).status == 200)
        let vacio = await put(["reglas": [Any]()])
        #expect(vacio.status == 200 && lista(vacio.obj["reglas"]).isEmpty && f.oficinaJSON()["reglas"] == nil)
        #expect((await llamar(f.b, "DELETE", "/api/reglas")).status == 405)
    }

    // MARK: acciones

    func proponer(_ f: Fix, agente: String = "marce", herramienta: String = GobiernoTests.crearCal, resumen: String = "Crear la reunión del lunes",
                  detalle: Any? = ["titulo": "Reunión", "fecha": "2026-11-16"], token: String? = nil) async throws -> MCPResultado {
        let t = token ?? f.b.mcp.tokens.emitir(oficina: f.carpeta, agente: agente, sid: U.a)
        let h = try #require(Acciones.herramientas(f.b.servicios, token: t, identidad: IdentidadMCP(oficina: f.carpeta, agente: agente, sid: U.a)))
        var args: [String: Any] = ["herramienta": herramienta, "resumen": resumen]
        if let detalle { args["detalle"] = detalle }
        return try #require(await h.llamar("proponer_accion", argumentos: args))
    }

    @Test("herramientas MCP de acciones: solo con herramientas de actuar asignadas")
    func herramientasMCP() async throws {
        let f = try await fix([("marce", "direccion", "Directora"), ("nico", "direccion", "Analista")])
        try await asignar(f, [conectoresCalendar()])
        let act = try #require(await f.b.oficinas.activa())
        #expect(Acciones.herramientasMCP(act.oficina, try #require(act.oficina.agente("marce"))) == ["mcp__hq__proponer_accion"])
        #expect(Acciones.herramientasMCP(act.oficina, try #require(act.oficina.agente("nico"))).isEmpty)
        #expect(HerramientasMCPAgente.lista(act.oficina, try #require(act.oficina.agente("marce"))).contains("mcp__hq__proponer_accion"))
        let id = { (a: String) in IdentidadMCP(oficina: f.carpeta, agente: a, sid: U.a) }
        #expect(Acciones.herramientas(f.b.servicios, token: "t", identidad: id("nico")) == nil)
        let h = f.b.mcp.consultas.herramientas(token: "t", identidad: id("marce"))
        #expect(h.definiciones.compactMap { $0["name"] as? String } == ["colegas", "consultar", "proponer_accion"])
        #expect(f.b.mcp.consultas.herramientas(token: "t", identidad: id("nico")).definiciones.compactMap { $0["name"] as? String } == ["colegas", "consultar"])
    }

    @Test("proponer_accion crea la entrega «Propuesta: ...» y la acción pendiente; una herramienta no asignada da error")
    func proponerAccion() async throws {
        let f = try await fix()
        try await asignar(f, [conectoresCalendar()])
        let r = try await proponer(f)
        #expect(!r.esError, "\(r.texto)")
        let e = try #require(lista((await f.get("/api/entregas")).obj["entregas"]).first)
        #expect(str(e["origen"]) == "propuesta" && str(e["titulo"]) == "Propuesta: Crear la reunión del lunes" && str(e["estado"]) == "sin_revisar")
        let completa = (await f.get("/api/entregas/\(e["id"] as! Int)")).obj
        let texto = str(dict(completa["entrega"])["texto"])
        #expect(texto.contains("Crear la reunión del lunes") && texto.contains("create_event") && texto.contains("titulo: Reunión"))
        let a = dict((await f.get("/api/acciones", ["entrega": "\(e["id"] as! Int)"])).obj["accion"])
        #expect(str(a["estado"]) == "pendiente" && str(a["herramienta"]) == Self.crearCal && str(a["agente"]) == "marce")
        #expect(dict(a["detalle"])["fecha"] as? String == "2026-11-16")
        let todas = lista((await f.get("/api/acciones", ["estado": "pendiente"])).obj["acciones"])
        #expect(todas.count == 1)
        #expect(lista((await f.get("/api/acciones", ["estado": "hecha"])).obj["acciones"]).isEmpty)
        #expect((await f.get("/api/acciones", ["estado": "rara"])).status == 400)

        // no asignada para actuar (ni la de leer, ni una de otro servidor)
        for h in [Self.enviarMail, Self.leerCal, ""] {
            let m = try await proponer(f, herramienta: h)
            #expect(m.esError, "\(h)")
        }
        #expect(try await proponer(f, resumen: "  ").esError)
        #expect(try await proponer(f, detalle: "no es un objeto").esError)
        #expect(lista((await f.get("/api/entregas")).obj["entregas"]).count == 1, "los rechazos no dejan entregas")
    }

    @Test("proponer_accion: cupo de 5 por corrida")
    func cupo() async throws {
        let f = try await fix()
        try await asignar(f, [conectoresCalendar()])
        let t = f.b.mcp.tokens.emitir(oficina: f.carpeta, agente: "marce", sid: U.a)
        for i in 1...5 { #expect(try await !proponer(f, resumen: "Evento \(i)", token: t).esError) }
        let sexta = try await proponer(f, resumen: "Evento 6", token: t)
        #expect(sexta.esError && sexta.texto.contains("5"))
        #expect(lista((await f.get("/api/acciones")).obj["acciones"]).count == 5)
        // otro token, otro cupo
        #expect(try await !proponer(f, resumen: "Evento 7").esError)
    }

    @Test("ejecutar: la herramienta va en --allowedTools, la acción queda hecha con su resultado y la entrega revisada")
    func ejecutar() async throws {
        let f = try await fix()
        try await asignar(f, [conectoresCalendar()])
        _ = try await proponer(f)
        let e = try #require(lista((await f.get("/api/entregas")).obj["entregas"]).first)
        let id = e["id"] as! Int
        let r = await f.post("/api/entregas/\(id)/ejecutar")
        #expect(r.status == 202, "\(r.obj)")
        #expect(dict(r.obj["ejecucion"])["tarea"] as? String != nil)
        #expect(await esperarAsync(hasta: 15) { str(dict((await f.get("/api/acciones", ["entrega": "\(id)"])).obj["accion"])["estado"]) == "hecha" })
        let a = dict((await f.get("/api/acciones", ["entrega": "\(id)"])).obj["accion"])
        #expect(str(a["resultado"]).contains("hola marce") && a["ejecucion"] is Int)
        #expect(str(dict(dict((await f.get("/api/entregas/\(id)")).obj["entrega"]))["estado"]) == "revisada")

        let l = try #require(f.sb.llamadas(conPrompt: "exactamente esto").last)
        #expect(Sandbox.reglas(l).contains(Self.crearCal), "la herramienta aprobada va en --allowedTools")
        #expect(Sandbox.reglas(l).contains(Self.leerCal))
        let msg = try #require(l.last)
        #expect(msg.contains("Ana aprobó") && msg.contains("Crear la reunión del lunes") && msg.contains("2026-11-16"))
        // en la lista, la entrega del resultado tiene origen «accion»
        let origenes = lista((await f.get("/api/entregas")).obj["entregas"]).map { str($0["origen"]) }
        #expect(origenes.contains("accion") && origenes.contains("propuesta"))
        // ya no está pendiente
        #expect((await f.post("/api/entregas/\(id)/ejecutar")).status == 409)
        #expect((await f.post("/api/entregas/\(id)/descartar-accion")).status == 409)
    }

    @Test("ejecutar: sin acción da 404; con la herramienta ya desasignada da 409 y no cambia nada")
    func ejecutarBordes() async throws {
        let f = try await fix()
        try await asignar(f, [conectoresCalendar()])
        #expect((await f.post("/api/entregas/999/ejecutar")).status == 404)
        let suelta = try #require(await f.b.store.entregaCrear(oficina: f.carpeta, agente: "marce", origen: "tarea", ref: "x", titulo: "T", texto: "t"))
        #expect((await f.post("/api/entregas/\(suelta.id)/ejecutar")).status == 404)
        #expect((await f.post("/api/entregas/\(suelta.id)/descartar-accion")).status == 404)
        _ = try await proponer(f)
        let e = try #require(lista((await f.get("/api/entregas")).obj["entregas"]).first { str($0["origen"]) == "propuesta" })
        let id = e["id"] as! Int
        try await asignar(f, [conectoresCalendar(actuar: false)])
        #expect((await f.post("/api/entregas/\(id)/ejecutar")).status == 409)
        #expect(str(dict((await f.get("/api/acciones", ["entrega": "\(id)"])).obj["accion"])["estado"]) == "pendiente")
        #expect(str(dict(dict((await f.get("/api/entregas/\(id)")).obj["entrega"]))["estado"]) == "sin_revisar")
        #expect(f.sb.llamadas(conPrompt: "exactamente esto").isEmpty)
        #expect((await llamar(f.b, "GET", "/api/entregas/\(id)/ejecutar")).status == 405)
        // otras rutas de entregas siguen siendo del router de entregas
        #expect((await f.post("/api/entregas/\(id)/revisada")).status == 200)
    }

    @Test("ejecutar: si la ejecución falla, la acción queda en error")
    func ejecutarFalla() async throws {
        let f = try await fix()
        try await asignar(f, [conectoresCalendar()])
        _ = try await proponer(f)
        let e = try #require(lista((await f.get("/api/entregas")).obj["entregas"]).first)
        let id = e["id"] as! Int
        f.sb.modo("marce", "error")
        #expect((await f.post("/api/entregas/\(id)/ejecutar")).status == 202)
        #expect(await esperarAsync(hasta: 15) { str(dict((await f.get("/api/acciones", ["entrega": "\(id)"])).obj["accion"])["estado"]) == "error" })
        #expect(!str(dict((await f.get("/api/acciones", ["entrega": "\(id)"])).obj["accion"])["resultado"]).isEmpty)
    }

    @Test("descartar-accion: deja la acción descartada y la entrega revisada, sin lanzar claude")
    func descartar() async throws {
        let f = try await fix()
        try await asignar(f, [conectoresCalendar()])
        _ = try await proponer(f)
        let e = try #require(lista((await f.get("/api/entregas")).obj["entregas"]).first)
        let id = e["id"] as! Int
        let r = await f.post("/api/entregas/\(id)/descartar-accion")
        #expect(r.status == 200 && str(dict(r.obj["accion"])["estado"]) == "descartada")
        #expect(str(dict(dict((await f.get("/api/entregas/\(id)")).obj["entrega"]))["estado"]) == "revisada")
        #expect(f.sb.llamadas.isEmpty)
        #expect((await f.post("/api/entregas/\(id)/ejecutar")).status == 409)
        #expect(lista((await f.get("/api/acciones", ["estado": "descartada"])).obj["acciones"]).count == 1)
        #expect((await f.get("/api/acciones", ["entrega": "x"])).status == 400)
        #expect(dict((await f.get("/api/acciones", ["entrega": "12345"])).obj)["accion"] is NSNull)
    }
}

extension Backend {
    /// PUT /api/reglas con reglas dadas (atajo de los tests).
    func llamarReglas(_ f: Fix, _ reglas: [[String: Any]]) async -> Resp {
        await llamar(self, "PUT", "/api/reglas", body: json(["reglas": reglas]))
    }
}
