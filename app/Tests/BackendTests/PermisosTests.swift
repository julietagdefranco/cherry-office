import Foundation
import Testing
@testable import Backend

@Suite("Permisos")
struct PermisosTests {
    static let home = "/tmp/hqtest-home"
    func cfg(_ mod: (inout Config) -> Void = { _ in }) -> Config {
        var c = Config(home: Self.home)
        mod(&c)
        return c
    }
    func regla(_ h: String, _ ruta: String) -> String { "\(h)(//\(ruta.dropFirst()))" }

    @Test("betty: Edit/Write en sus 3 rutas, en el orden '*' primero y luego las propias; argumentos exactos")
    func argumentosBetty() {
        let c = cfg()
        let p = "\(Self.home)/Próspera"
        let a = Permisos.argumentos(c, agente: "betty", mensaje: "hola", sid: U.a, flag: "--session-id")
        let rutas = ["\(p)/_equipo/agentes/betty.md", "\(p)/_betty/estado-actual.md", "\(p)/_equipo/decisiones.md"]
        var esperado = ["-p", "--agent", "betty", "--session-id", U.a, "--output-format", "stream-json", "--verbose",
                        "--tools", "Read,Glob,Grep,Skill,Edit,Write",
                        "--add-dir", "\(Self.home)/.claude/betty", "--allowedTools"]
        for r in rutas { esperado += [regla("Edit", r), regla("Write", r)] }
        esperado += ["--", "hola"]
        #expect(a == esperado)
        #expect(Permisos.rutasEscritura(c, agente: "betty") == rutas)
    }

    @Test("otro agente: una sola ruta (_equipo/agentes/<id>.md)")
    func argumentosOtro() {
        let c = cfg()
        let p = "\(Self.home)/Próspera/_equipo/agentes/marce.md"
        let a = Permisos.argumentos(c, agente: "marce", mensaje: "hola", sid: U.b, flag: "--resume")
        let esperado = ["-p", "--agent", "marce", "--resume", U.b, "--output-format", "stream-json", "--verbose",
                        "--tools", "Read,Glob,Grep,Skill,Edit,Write",
                        "--add-dir", "\(Self.home)/.claude/betty",
                        "--allowedTools", regla("Edit", p), regla("Write", p),
                        "--", "hola"]
        #expect(a == esperado)
        for ag in Config.agentesPorDefecto where ag != "betty" {
            #expect(Permisos.rutasEscritura(c, agente: ag) == ["\(Self.home)/Próspera/_equipo/agentes/\(ag).md"])
        }
    }

    @Test("el mensaje va siempre último, justo después de '--', aunque empiece con guiones", arguments: [
        "--help", "-p", "--agent betty", "--dangerously-skip-permissions", "-- --resume x", "--", "  --help", "--allowedTools Bash",
    ])
    func dobleGuion(mensaje: String) {
        let a = Permisos.argumentos(cfg(), agente: "betty", mensaje: mensaje, sid: U.a, flag: "--session-id")
        #expect(a.last == mensaje)
        #expect(a[a.count - 2] == "--")
        // el primer "--" suelto es el separador: nada del mensaje se interpreta como opción
        #expect(a.firstIndex(of: "--") == a.count - 2)
    }

    @Test("sin rutas de escritura: no hay Edit/Write ni --allowedTools")
    func sinEscritura() {
        let c = cfg { $0.escritura = [:] }
        let a = Permisos.argumentos(c, agente: "betty", mensaje: "hola", sid: U.a, flag: "--session-id")
        #expect(!a.contains("--allowedTools"))
        #expect(a[a.firstIndex(of: "--tools")! + 1] == "Read,Glob,Grep,Skill")
        #expect(Permisos.herramientas(c, agente: "betty") == "Read,Glob,Grep,Skill")
    }

    @Test("herramientas por agente pisan la base; Edit,Write se suman igual si hay rutas")
    func herramientasPorAgente() {
        let c = cfg { $0.herramientasAgente = ["marce": "Read,WebSearch"]; $0.herramientas = "Read" }
        #expect(Permisos.herramientas(c, agente: "marce") == "Read,WebSearch,Edit,Write")
        #expect(Permisos.herramientas(c, agente: "sofia") == "Read,Edit,Write")
        // valor vacío -> se usa la base
        let c2 = cfg { $0.herramientasAgente = ["marce": ""] }
        #expect(Permisos.herramientas(c2, agente: "marce") == "Read,Glob,Grep,Skill,Edit,Write")
    }

    @Test("{id} se expande, rutas absolutas y ~ se respetan, duplicados se eliminan")
    func rutasEspeciales() {
        let c = cfg {
            $0.escritura = ["*": ["notas/{id}.md", "/abs/uno.md", "~/dos.md", "notas/{id}.md"], "x": ["notas/x.md"]]
        }
        let r = Permisos.rutasEscritura(c, agente: "x")
        #expect(r == ["\(Self.home)/Próspera/notas/x.md", "/abs/uno.md", "\(Self.home)/dos.md"])
        #expect(Permisos.rutasEscritura(c, agente: "y") == ["\(Self.home)/Próspera/notas/y.md", "/abs/uno.md", "\(Self.home)/dos.md"])
    }

    @Test("regla: doble barra, sin barras extra")
    func reglaFormato() {
        #expect(Permisos.regla("Edit", ruta: "/a/b.md") == "Edit(//a/b.md)")
        #expect(Permisos.regla("Write", ruta: "///a/b.md") == "Write(//a/b.md)")
    }

    @Test("--add-dir: uno por cada dir extra, antes de --allowedTools")
    func addDirs() {
        let c = cfg { $0.dirsExtra = ["/d1", "/d2"] }
        let a = Permisos.argumentos(c, agente: "marce", mensaje: "m", sid: U.a, flag: "--session-id")
        let idx = a.indices.filter { a[$0] == "--add-dir" }
        #expect(idx.map { a[$0 + 1] } == ["/d1", "/d2"])
        #expect(idx.max()! < a.firstIndex(of: "--allowedTools")!)
        let sin = cfg { $0.dirsExtra = [] }
        #expect(!Permisos.argumentos(sin, agente: "marce", mensaje: "m", sid: U.a, flag: "--resume").contains("--add-dir"))
    }

    @Test("de punta a punta: lo que recibe el claude falso es exactamente lo que arma Permisos (mensaje '--help')")
    func extremoAExtremo() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let b = try sb.backend()
        let r = await chat(b, agent: "betty", message: "--help", session: U.a)
        #expect(r.status == 200)
        // desde las oficinas, el chat arma los permisos con la oficina activa (carpeta = sb.proyecto)
        let act = try #require(await b.oficinas.activa())
        var ctx = Permisos.contexto(act, agente: try #require(act.oficina.agente("betty")))
        ctx.mcpUrl = await b.mcp.url()   // el chat suma el servidor MCP propio (Fase 4)
        let esperado = Permisos.argumentos(sb.config(), oficina: ctx, agente: "betty", mensaje: "--help", sid: U.a, flag: "--session-id")
        #expect(sb.llamadas == [esperado])
        #expect(sb.llamadas.first?.suffix(2) == ["--", "--help"])
        // y otro agente con una sola ruta
        _ = await chat(b, agent: "marce", message: "-p hola", session: U.b)
        let a2 = try #require(sb.llamadas.last)
        #expect(a2.filter { $0.hasPrefix("Edit(") }.count == 1)
        #expect(a2.suffix(2) == ["--", "-p hola"])
    }
}
