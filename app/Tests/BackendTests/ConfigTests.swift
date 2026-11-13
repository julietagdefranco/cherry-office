import Foundation
import Testing
@testable import Backend

@Suite("Config")
struct ConfigTests {
    func escribir(_ sb: Sandbox, _ contenido: String, en rel: String = "datos/config.json") -> String {
        let p = sb.root + "/" + rel
        try? FileManager.default.createDirectory(atPath: (p as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try? contenido.write(toFile: p, atomically: true, encoding: .utf8)
        return p
    }
    func cargar(_ sb: Sandbox, _ env: [String: String] = [:]) -> Config {
        var e = ["HQ_DATA_DIR": sb.datos]
        e.merge(env) { $1 }
        return Config.load(home: sb.home, env: e)
    }

    @Test("defaults: valores del contrato derivados de HOME")
    func defaults() {
        let c = Config(home: "/h")
        #expect(c.proyecto == "/h/Próspera")
        #expect(c.dirsExtra == ["/h/.claude/betty"])
        #expect(c.agentes == ["betty", "don-armando", "marce", "catalina", "patricia", "sofia", "mario", "nicolas"])
        #expect(c.agentes.count == 8)
        #expect(c.herramientas == "Read,Glob,Grep,Skill")
        #expect(c.herramientasAgente.isEmpty)
        #expect(c.escritura == ["*": ["_equipo/agentes/{id}.md"], "betty": ["_betty/estado-actual.md", "_equipo/decisiones.md"]])
        #expect(c.timeout == 600)
        #expect(c.claudeBin == nil)
        #expect(c.datosDir == "/h/Library/Application Support/Próspera HQ")
        #expect(c.legacyDirs == ["/h/Próspera HQ/oficina"])
        #expect(c.version == "1.0.0")
    }

    @Test("load sin archivo ni entorno = defaults")
    func loadSinNada() {
        let sb = Sandbox()
        let c = cargar(sb)
        let d = Config(home: sb.home)
        #expect(c.proyecto == d.proyecto && c.agentes == d.agentes && c.timeout == d.timeout && c.dirsExtra == d.dirsExtra)
        #expect(c.datosDir == sb.datos)
    }

    @Test("config.json pisa los defaults campo por campo")
    func configJsonPisa() {
        let sb = Sandbox()
        _ = escribir(sb, """
        {"_comentario": "x", "proyecto": "~/MiProyecto", "dirs_extra": ["~/uno", "/dos"], "agentes": ["a1", "b-2", "mal id", "-x"],
         "herramientas": "Read", "herramientas_agente": {"a1": "Read,Bash"}, "escritura": {"*": ["x/{id}.md"]},
         "timeout": 42, "claude_bin": "~/bin/claude", "legacy_dirs": ["~/viejo"], "desconocida": 1}
        """)
        let c = cargar(sb)
        #expect(c.proyecto == sb.home + "/MiProyecto")
        #expect(c.dirsExtra == [sb.home + "/uno", "/dos"])
        #expect(c.agentes == ["a1", "b-2"])
        #expect(c.herramientas == "Read")
        #expect(c.herramientasAgente == ["a1": "Read,Bash"])
        #expect(c.escritura == ["*": ["x/{id}.md"]])
        #expect(c.timeout == 42)
        #expect(c.claudeBin == sb.home + "/bin/claude")
        #expect(c.legacyDirs == [sb.home + "/viejo", sb.home + "/Próspera HQ/oficina"])
    }

    @Test("config.json: dirs_extra como string, timeout como string, nulls y tipos raros se ignoran")
    func configJsonTolerante() {
        let sb = Sandbox()
        _ = escribir(sb, #"{"dirs_extra": "/solo", "timeout": "15", "proyecto": null, "agentes": 5, "herramientas": "", "claude_bin": 3}"#)
        let c = cargar(sb)
        #expect(c.dirsExtra == ["/solo"])
        #expect(c.timeout == 15)
        #expect(c.proyecto == sb.home + "/Próspera")
        #expect(c.agentes == Config.agentesPorDefecto)
        #expect(c.herramientas == "Read,Glob,Grep,Skill")
        #expect(c.claudeBin == nil)
    }

    @Test("config.json: timeout <= 0 se ignora")
    func timeoutNoPositivo() {
        let sb = Sandbox()
        _ = escribir(sb, #"{"timeout": 0}"#)
        #expect(cargar(sb).timeout == 600)
        _ = escribir(sb, #"{"timeout": -3}"#)
        #expect(cargar(sb).timeout == 600)
    }

    @Test("config.json inválido o no-objeto: defaults, sin romper", arguments: ["", "no json", "[1,2]", "42", "{"])
    func configJsonInvalido(contenido: String) {
        let sb = Sandbox()
        _ = escribir(sb, contenido)
        let c = cargar(sb)
        #expect(c.agentes == Config.agentesPorDefecto)
        #expect(c.timeout == 600)
        #expect(c.proyecto == sb.home + "/Próspera")
    }

    @Test("HQ_CONFIG apunta a otro archivo")
    func hqConfig() {
        let sb = Sandbox()
        _ = escribir(sb, #"{"timeout": 11}"#)
        let otro = escribir(sb, #"{"timeout": 22}"#, en: "otro/cfg.json")
        #expect(cargar(sb).timeout == 11)
        #expect(cargar(sb, ["HQ_CONFIG": otro]).timeout == 22)
    }

    @Test("el entorno pisa a config.json")
    func entornoPisaJson() {
        let sb = Sandbox()
        _ = escribir(sb, #"{"proyecto": "/json/proy", "dirs_extra": ["/json/extra"], "agentes": ["j1"], "timeout": 5}"#)
        let c = cargar(sb, ["HQ_PROYECTO": "~/envproy", "HQ_DIR_EXTRA": "/e1:/e2", "HQ_AGENTES": "x, y ,,z", "HQ_TIMEOUT": "99"])
        #expect(c.proyecto == sb.home + "/envproy")
        #expect(c.dirsExtra == ["/e1", "/e2"])
        #expect(c.agentes == ["x", "y", "z"])
        #expect(c.timeout == 99)
    }

    @Test("HQ_TIMEOUT inválido (no número, 0, negativo) se ignora")
    func envTimeoutInvalido() {
        let sb = Sandbox()
        _ = escribir(sb, #"{"timeout": 7}"#)
        for v in ["abc", "0", "-4", ""] { #expect(cargar(sb, ["HQ_TIMEOUT": v]).timeout == 7, "HQ_TIMEOUT=\(v)") }
    }

    @Test("HQ_AGENTES filtra ids inválidos; vacío no cambia nada")
    func envAgentesFiltra() {
        let sb = Sandbox()
        #expect(cargar(sb, ["HQ_AGENTES": "ok,../mal,con espacio,_x,bien_2"]).agentes == ["ok", "bien_2"])
        #expect(cargar(sb, ["HQ_AGENTES": "  "]).agentes == Config.agentesPorDefecto)
    }

    @Test("'auto' descubre ~/.claude/agents/*.md ordenado, desde el entorno y desde config.json")
    func agentesAuto() throws {
        let sb = Sandbox()
        let dir = sb.home + "/.claude/agents"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        for n in ["zeta.md", "alfa.md", "notas.txt", "mal id.md", ".oculto.md"] {
            FileManager.default.createFile(atPath: dir + "/" + n, contents: Data())
        }
        #expect(Config.descubrirAgentes(home: sb.home) == ["alfa", "zeta"])
        #expect(cargar(sb, ["HQ_AGENTES": "auto"]).agentes == ["alfa", "zeta"])
        _ = escribir(sb, #"{"agentes": "auto"}"#)
        #expect(cargar(sb).agentes == ["alfa", "zeta"])
        // sin carpeta -> lista vacía
        let sb2 = Sandbox()
        #expect(cargar(sb2, ["HQ_AGENTES": "auto"]).agentes.isEmpty)
    }

    @Test("HQ_DATA_DIR y HQ_LEGACY_DIR")
    func envDatosYLegacy() {
        let sb = Sandbox()
        let c = cargar(sb, ["HQ_LEGACY_DIR": "~/leg"])
        #expect(c.datosDir == sb.datos)
        #expect(c.legacyDirs.first == sb.home + "/leg")
        #expect(c.legacyDirs.count == 2)
    }

    @Test("HQ_DIR_EXTRA vacío deja la lista sin dirs extra")
    func envDirExtraVacio() {
        let sb = Sandbox()
        #expect(cargar(sb, ["HQ_DIR_EXTRA": ""]).dirsExtra.isEmpty)
    }

    @Test("ruta: ~, ~/x, absoluta, relativa y normalización de ..")
    func rutaExpansion() {
        #expect(Config.ruta("~", home: "/h") == "/h")
        #expect(Config.ruta("~/a/b", home: "/h") == "/h/a/b")
        #expect(Config.ruta("/x/../y", home: "/h") == "/y")
        #expect(Config.ruta("rel", home: "/h") == FileManager.default.currentDirectoryPath + "/rel")
    }

    @Test("esIdValido")
    func ids() {
        for ok in ["betty", "don-armando", "a_b", "A1", String(repeating: "a", count: 64)] { #expect(Config.esIdValido(ok), "\(ok)") }
        for mal in ["", "-x", "_x", "a b", "../x", "a/b", "ñandu", "a.b", String(repeating: "a", count: 65)] { #expect(!Config.esIdValido(mal), "\(mal)") }
    }
}
