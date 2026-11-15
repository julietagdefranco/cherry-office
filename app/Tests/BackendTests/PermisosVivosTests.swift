import Foundation
import Testing
@testable import Backend

private func objetoJSON(_ s: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
}

/// Pedidos de permiso en vivo: claude `--permission-prompt-tool mcp__hq__pedir_permiso` en los chats, la tarjeta de la
/// oficina (`permisos` en /api/actividad) y la respuesta (`POST /api/permisos/<id>`), con «Siempre» guardado en el agente.
extension Etapa2 {
@Suite("Permisos en vivo")
struct PermisosVivosTests {
    static let ident = IdentidadMCP(oficina: "/of", agente: "marce", sid: U.a, interactivo: true)

    // MARK: lógica pura

    @Test("reglas sugeridas: programa (y subcomando conocido) para Bash; carpeta del archivo para Edit/Write; nada para el resto")
    func reglasSugeridas() {
        func bash(_ c: String) -> [String] { PermisosVivos.reglasSugeridas("Bash", ["command": c]) }
        #expect(bash("git pull origin main") == ["Bash(git pull:*)"])
        #expect(bash("  npm install  ") == ["Bash(npm install:*)"])
        #expect(bash("git --version") == ["Bash(git:*)"])
        #expect(bash("ls -la /tmp") == ["Bash(ls:*)"])
        // compuestos, redirecciones, sustituciones, comodines y variables: solo una vez
        for c in ["git pull && rm -rf x", "cat a | grep b", "echo hola > x", "ls; rm x", "echo $(whoami)", "rm *", "FOO=1 make", "", "echo 'a b'"] {
            #expect(bash(c).isEmpty, "\(c)")
        }
        #expect(PermisosVivos.reglasSugeridas("Edit", ["file_path": "/Users/ana/repo/src/a.ts"]) == ["Edit(//Users/ana/repo/src/**)", "Write(//Users/ana/repo/src/**)"])
        #expect(PermisosVivos.reglasSugeridas("Write", ["file_path": "/tmp/x.md"]) == ["Edit(//tmp/**)", "Write(//tmp/**)"])
        #expect(PermisosVivos.reglasSugeridas("Write", ["file_path": "relativo/x.md"]).isEmpty)
        #expect(PermisosVivos.reglasSugeridas("Write", ["file_path": "/a/../b.md"]).isEmpty)
        #expect(PermisosVivos.reglasSugeridas("Write", ["file_path": "/raiz.md"]).isEmpty)
        #expect(PermisosVivos.reglasSugeridas("WebFetch", ["url": "https://x.com"]).isEmpty)
        // todo lo que sugiere pasa la validación de oficina.json
        #expect(ValidarAgenteExtra.reglaValida("Bash(git pull:*)") && ValidarAgenteExtra.reglaValida("Edit(//tmp/**)"))
    }

    @Test("detalle: el comando, la ruta o la URL; si no, el input como JSON; saneado y recortado")
    func detalle() {
        #expect(PermisosVivos.detalle("Bash", ["command": "git pull\u{7}"]) == "git pull")
        #expect(PermisosVivos.detalle("Edit", ["file_path": "/a/b.md", "old_string": "x"]) == "/a/b.md")
        #expect(PermisosVivos.detalle("WebFetch", ["url": "https://x.com"]) == "https://x.com")
        #expect(PermisosVivos.detalle("Otra", ["b": 1, "a": "x"]) == "{\"a\":\"x\",\"b\":1}")
        #expect(PermisosVivos.detalle("Bash", ["command": String(repeating: "a", count: 5000)]).count == PermisosVivos.maxDetalle)
    }

    @Test("respuesta para claude: allow con el input tal cual, o deny con un mensaje (rechazado o sin respuesta)")
    func respuesta() {
        let input: [String: Any] = ["command": "ls"]
        for d in [DecisionPermiso.unaVez, .siempre] {
            let o = objetoJSON(PermisosVivos.respuesta(d, input: input))
            #expect(str(o["behavior"]) == "allow" && str(dict(o["updatedInput"])["command"]) == "ls")
        }
        let no = objetoJSON(PermisosVivos.respuesta(.rechazar, input: input))
        #expect(str(no["behavior"]) == "deny" && str(no["message"]).contains("no dio permiso"))
        let nadie = objetoJSON(PermisosVivos.respuesta(nil, input: input))
        #expect(str(nadie["behavior"]) == "deny" && str(nadie["message"]).contains("Nadie respondió"))
    }

    @Test("validación de las reglas guardadas: Bash(algo), Edit/Write con ruta absoluta; sin Bash pelado, saltos, .. ni repetidas")
    func validacion() throws {
        try ValidarAgenteExtra.reglas(["Bash(git pull:*)", "Edit(//a/**)", "Write(/a/b.md)"])
        for r in ["Bash", "Bash()", "Bash( )", "Edit(relativo/**)", "Write(//a/../b)", "Bash(ls\n)", "Read(//a)", "mcp__x__y", "Bash(ls"] {
            #expect(throws: ErrorAPI.self, "\(r)") { try ValidarAgenteExtra.reglas([r]) }
        }
        #expect(throws: ErrorAPI.self) { try ValidarAgenteExtra.reglas(["Bash(ls:*)", "Bash(ls:*)"]) }
        #expect(throws: ErrorAPI.self) { try ValidarAgenteExtra.reglas((0...40).map { "Bash(p\($0):*)" }) }
    }

    @Test("registro: pedir espera la respuesta; pendientes por oficina; responder, vencer y cancelar devuelven y sacan el pedido")
    func registro() async throws {
        let cambios = CajaContador()
        let v = PermisosVivos(timeout: 5)
        v.alCambiar { cambios.sumar() }
        let espera = Task { await v.pedir(token: "t1", identidad: Self.ident, herramienta: "Bash", input: ["command": "git pull"]) }
        #expect(await esperar { v.pendientes(oficina: "/of").count == 1 })
        #expect(v.pendientes(oficina: "/otra").isEmpty)
        let p = try #require(v.pendientes(oficina: "/of").first)
        #expect(p.agente == "marce" && p.herramienta == "Bash" && p.detalle == "git pull" && p.reglas == ["Bash(git pull:*)"])
        #expect(v.responder(oficina: "/otra", id: p.id, decision: .unaVez) == nil, "otra oficina no lo puede responder")
        #expect(v.responder(oficina: "/of", id: p.id, decision: .siempre)?.id == p.id)
        #expect(await espera.value == .siempre)
        #expect(v.pendientes(oficina: "/of").isEmpty)
        #expect(v.responder(oficina: "/of", id: p.id, decision: .unaVez) == nil, "ya respondido")
        #expect(cambios.valor >= 2)

        // vence: nadie responde
        let corto = PermisosVivos(timeout: 0.2)
        #expect(await corto.pedir(token: "t", identidad: Self.ident, herramienta: "Bash", input: ["command": "ls"]) == nil)
        #expect(corto.pendientes(oficina: "/of").isEmpty)

        // el chat terminó: se cancelan los de ese token y no los de otro
        let w = PermisosVivos(timeout: 5)
        let a = Task { await w.pedir(token: "ta", identidad: Self.ident, herramienta: "Bash", input: ["command": "ls"]) }
        let b = Task { await w.pedir(token: "tb", identidad: Self.ident, herramienta: "Bash", input: ["command": "pwd"]) }
        #expect(await esperar { w.pendientes(oficina: "/of").count == 2 })
        w.cancelar(token: "ta")
        #expect(await a.value == nil)
        #expect(w.pendientes(oficina: "/of").map(\.detalle) == ["pwd"])
        _ = w.responder(oficina: "/of", id: w.pendientes(oficina: "/of")[0].id, decision: .rechazar)
        #expect(await b.value == .rechazar)
    }

    @Test("argumentos: sin la persona, dontAsk; con la persona y MCP, modo default, la herramienta y Bash,Edit,Write; las reglas siempre")
    func argumentos() {
        let cfg = Config(home: "/h")
        var ctx = ContextoOficina(carpeta: "/of", escritura: ["/of/notas.md"], mcpUrl: "http://127.0.0.1:1/mcp")
        ctx.reglas = ["Bash(git pull:*)"]
        let sin = Permisos.argumentos(cfg, oficina: ctx, agente: "marce", mensaje: "m", sid: U.a, flag: "--resume")
        #expect(Sandbox.valor(sin, "--permission-mode") == "dontAsk" && !sin.contains("--permission-prompt-tool"))
        #expect(Sandbox.valor(sin, "--tools") == "Read,Glob,Grep,Skill,Edit,Write,Bash,mcp__hq__consultar,mcp__hq__colegas")
        #expect(Sandbox.reglas(sin) == ["Read", "Glob", "Grep", "Skill", "Edit(//of/notas.md)", "Write(//of/notas.md)", "Bash(git pull:*)",
                                        "mcp__hq__consultar", "mcp__hq__colegas"])
        ctx.preguntar = true
        let con = Permisos.argumentos(cfg, oficina: ctx, agente: "marce", mensaje: "m", sid: U.a, flag: "--resume")
        #expect(Sandbox.valor(con, "--permission-mode") == "default")
        #expect(Sandbox.valor(con, "--permission-prompt-tool") == "mcp__hq__pedir_permiso")
        #expect(Sandbox.reglas(con).last == "mcp__hq__pedir_permiso")
        // sin servidor MCP no hay quién pregunte: vuelve a dontAsk y no suma Bash
        ctx.mcpUrl = nil; ctx.reglas = []
        let sinMCP = Permisos.argumentos(cfg, oficina: ctx, agente: "marce", mensaje: "m", sid: U.a, flag: "--resume")
        #expect(Sandbox.valor(sinMCP, "--permission-mode") == "dontAsk")
        #expect(Sandbox.valor(sinMCP, "--tools") == "Read,Glob,Grep,Skill,Edit,Write")
    }

    // MARK: de punta a punta (claude falso)

    func pendientes(_ f: Fix) async -> [[String: Any]] { lista((await f.get("/api/actividad")).obj["permisos"]) }

    @Test("chat: el pedido aparece en /api/actividad; «Siempre» lo deja pasar, lo guarda en el agente y va a --allowedTools después")
    func siempre() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", nil)])
        #expect(await pendientes(f).isEmpty)
        let chatA = Task { await chat(f.b, agent: "marce", message: "PERMISO:git pull origin main", session: U.a) }
        #expect(await esperarAsync { await pendientes(f).count == 1 })
        let p = try #require(await pendientes(f).first)
        #expect(str(p["agente"]) == "marce" && str(p["herramienta"]) == "Bash" && str(p["detalle"]) == "git pull origin main")
        #expect(str(p["descripcion"]) == "Prueba" && (p["reglas"] as? [String]) == ["Bash(git pull:*)"] && p["ts"] is Double)

        let r = await f.post("/api/permisos/\(str(p["id"]))", ["decision": "siempre"])
        #expect(r.status == 200 && (r.obj["reglas"] as? [String]) == ["Bash(git pull:*)"])
        #expect((await chatA.value).status == 200)
        let out = objetoJSON(leerTexto(f.sb.binDir + "/mcp.marce.out").trimmingCharacters(in: .whitespacesAndNewlines))
        let texto = str(lista(dict(out["result"])["content"]).first?["text"])
        #expect(str(objetoJSON(texto)["behavior"]) == "allow")
        #expect(await pendientes(f).isEmpty)
        // quedó en oficina.json y en el siguiente chat va a --tools y a --allowedTools (sin repetir al pedirlo de nuevo)
        let ag = lista(f.oficinaJSON()["agentes"]).first { str($0["id"]) == "marce" }
        #expect((ag?["reglas"] as? [String]) == ["Bash(git pull:*)"])
        _ = await chat(f.b, agent: "marce", message: "hola", session: U.b)
        let l = try #require(f.sb.llamadas.last)
        #expect(Sandbox.reglas(l).contains("Bash(git pull:*)"))
        #expect(Sandbox.valor(l, "--tools")?.contains("Bash") == true)
        // y se puede quitar desde la pestaña Permisos (PATCH con reglas vacías borra la clave)
        let q = await f.patch("/api/agentes/marce", ["reglas": [String]()])
        #expect(q.status == 200)
        let ag2 = lista(f.oficinaJSON()["agentes"]).first { str($0["id"]) == "marce" }
        #expect(ag2?["reglas"] == nil)
        #expect(await f.patch("/api/agentes/marce", ["reglas": ["Bash"]]).status == 400)
    }

    @Test("chat: «No» rechaza (deny) sin guardar nada; un pedido inexistente da 404 y una decisión inválida 400")
    func rechazar() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", nil)])
        #expect((await f.post("/api/permisos/no-existe", ["decision": "una_vez"])).status == 404)
        let chatA = Task { await chat(f.b, agent: "marce", message: "PERMISO:rm -rf build", session: U.a) }
        #expect(await esperarAsync { await pendientes(f).count == 1 })
        let id = str(await pendientes(f).first?["id"])
        let mal = await f.post("/api/permisos/\(id)", ["decision": "quizas"])
        #expect(mal.status == 400 && str(mal.obj["error"]) == "«decision» tiene que ser una_vez, siempre o rechazar.")
        #expect((await f.post("/api/permisos/\(id)", ["decision": "rechazar"])).status == 200)
        #expect((await chatA.value).status == 200)
        let out = objetoJSON(leerTexto(f.sb.binDir + "/mcp.marce.out").trimmingCharacters(in: .whitespacesAndNewlines))
        #expect(str(objetoJSON(str(lista(dict(out["result"])["content"]).first?["text"]))["behavior"]) == "deny")
        let ag = lista(f.oficinaJSON()["agentes"]).first { str($0["id"]) == "marce" }
        #expect(ag?["reglas"] == nil)
        #expect((await f.post("/api/permisos/\(id)", ["decision": "una_vez"])).status == 404, "ya respondido")
    }

    @Test("chat: un comando compuesto solo se permite una vez («Siempre» da 400); si nadie responde, vence y se rechaza")
    func soloUnaVezYVence() async throws {
        let f = try await Fix.crear(agentes: [("marce", "redes", nil)], env: ["HQ_PERMISO_TIMEOUT": "1"])
        let chatA = Task { await chat(f.b, agent: "marce", message: "PERMISO:git pull && make", session: U.a) }
        #expect(await esperarAsync { await pendientes(f).count == 1 })
        let p = try #require(await pendientes(f).first)
        #expect((p["reglas"] as? [String]) == [])
        let r = await f.post("/api/permisos/\(str(p["id"]))", ["decision": "siempre"])
        #expect(r.status == 400 && str(r.obj["error"]) == "Esto solo se puede permitir una vez.")
        #expect((await chatA.value).status == 200)
        let out = objetoJSON(leerTexto(f.sb.binDir + "/mcp.marce.out").trimmingCharacters(in: .whitespacesAndNewlines))
        let res = objetoJSON(str(lista(dict(out["result"])["content"]).first?["text"]))
        #expect(str(res["behavior"]) == "deny" && str(res["message"]).contains("Nadie respondió"))
        #expect(await pendientes(f).isEmpty)
    }
}
}

/// Contador seguro entre hilos (para `alCambiar`).
final class CajaContador: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func sumar() { lock.lock(); n += 1; lock.unlock() }
    var valor: Int { lock.lock(); defer { lock.unlock() }; return n }
}
