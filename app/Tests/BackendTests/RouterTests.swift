import Foundation
import Testing
@testable import Backend

@Suite("Router")
struct RouterTests {
    let invalido = "pedido inválido"

    // MARK: /api/estado

    @Test("estado: forma exacta con claude y sesión iniciada")
    func estadoConClaude() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        let r = await llamar(b, "GET", "/api/estado")
        #expect(r.status == 200)
        #expect(Set(r.obj.keys) == ["app", "version", "claude", "agentes", "auth", "claudePath", "oficina", "perfil"])
        #expect(r.obj["app"] as? String == "prospera-hq")
        #expect(r.obj["version"] as? String == "1.0.0")
        #expect(r.obj["claude"] as? Bool == true)
        #expect(r.obj["auth"] as? Bool == true)
        #expect(r.obj["claudePath"] as? String == sb.bin)
        #expect(r.obj["agentes"] as? [String] == ["betty", "catalina", "don-armando", "marce", "mario", "nicolas", "patricia", "sofia"])
    }

    @Test("estado: auth=false cuando claude auth status falla")
    func estadoSinSesion() async throws {
        let sb = Sandbox()
        sb.setAuth(false)
        let b = try sb.backend()
        let r = await llamar(b, "GET", "/api/estado")
        #expect(r.status == 200)
        #expect(r.obj["claude"] as? Bool == true)
        #expect(r.obj["auth"] as? Bool == false)
    }

    @Test("estado: refleja agentes y versión de la config; ignora query y fragmento en el path")
    func estadoConfigYPath() async throws {
        let sb = Sandbox()
        let b = try sb.backend { $0.agentes = ["zeta", "alfa"]; $0.version = "9.8.7" }
        let r = await llamar(b, "GET", "/api/estado?x=1#frag")
        #expect(r.status == 200)
        #expect(r.obj["agentes"] as? [String] == ["alfa", "zeta"])
        #expect(r.obj["version"] as? String == "9.8.7")
    }

    @Test("estado: método en minúsculas se acepta")
    func estadoMetodoMinusculas() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }; let b = try sb.backend()
        let r = await llamar(b, "get", "/api/estado")
        #expect(r.status == 200)
    }

    @Test("estado: sin claude encontrable -> claude=false, auth=null, claudePath=null")
    func estadoSinClaude() async throws {
        let sb = Sandbox()
        // sin claudePath fijo: el resolver busca (rutas conocidas y shell de login)
        let b = try Backend(config: sb.config(), dataDir: sb.datos, claudePath: nil, env: [:])
        guard b.runner.claudePath == nil else {
            // En esta máquina hay un claude real instalado (~/.local/bin, shell de login): no se puede simular su ausencia.
            // La ausencia se cubre en ClaudeLocator con usarShell: false (ver RunnerTests).
            Issue.record("omitido: hay un claude real localizable (\(b.runner.claudePath ?? "")); el caso sin claude no se pudo simular", severity: .warning)
            return
        }
        let r = await llamar(b, "GET", "/api/estado")
        #expect(r.obj["claude"] as? Bool == false)
        #expect(r.obj["auth"] is NSNull)
        #expect(r.obj["claudePath"] is NSNull)
    }

    // MARK: /api/historial

    @Test("historial: sin sesiones -> session null y msgs vacío")
    func historialVacio() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }; let b = try sb.backend()
        let r = await historial(b)
        #expect(r.status == 200)
        #expect(Set(r.obj.keys) == ["session", "msgs"])
        #expect(r.obj["session"] is NSNull)
        #expect(msgs(r).isEmpty)
    }

    @Test("historial: sin session devuelve la última del agente con forma {r,t} y e solo en errores")
    func historialSinSession() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        _ = await chat(b, message: "uno", session: U.a)
        _ = await chat(b, message: "LOGINERR", session: U.a)
        let r = await historial(b)
        #expect(r.status == 200)
        #expect(Set(r.obj.keys) == ["session", "msgs"])
        #expect(r.obj["session"] as? String == U.a)
        let esperado: [[String: Any]] = [
            ["r": "u", "t": "uno"],
            ["r": "a", "t": "hola betty"],
            ["r": "u", "t": "LOGINERR"],
            ["r": "a", "t": "No pude responder: " + ClaudeError.mensajeLogin, "e": true],
        ]
        #expect(igual(msgs(r), esperado))
    }

    @Test("historial: la última sesión es la que tuvo el mensaje más reciente")
    func historialUltimaSesion() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }; let b = try sb.backend()
        _ = await chat(b, message: "en A", session: U.a)
        _ = await chat(b, message: "en B", session: U.b)
        #expect((await historial(b)).obj["session"] as? String == U.b)
        _ = await chat(b, message: "otra vez A", session: U.a)
        #expect((await historial(b)).obj["session"] as? String == U.a)
    }

    @Test("historial: con session devuelve solo msgs (sin clave session)")
    func historialConSession() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }; let b = try sb.backend()
        _ = await chat(b, message: "hola", session: U.a)
        let r = await historial(b, session: U.a)
        #expect(r.status == 200)
        #expect(Set(r.obj.keys) == ["msgs"])
        #expect(igual(msgs(r), [["r": "u", "t": "hola"], ["r": "a", "t": "hola betty"]] as [[String: Any]]))
    }

    @Test("historial: session desconocida y válida -> msgs vacío; en mayúsculas se normaliza")
    func historialSessionDesconocidaYMayusculas() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }; let b = try sb.backend()
        #expect(msgs(await historial(b, session: U.c)).isEmpty)
        _ = await chat(b, message: "hola", session: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")
        let r = await historial(b, session: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        #expect(msgs(r).count == 2)
        let r2 = await historial(b, session: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")
        #expect(msgs(r2).count == 2)
    }

    @Test("historial: session de otro agente -> 200 con msgs vacío (igual que server.py)")
    func historialSessionAjena() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }; let b = try sb.backend()
        _ = await chat(b, agent: "betty", message: "secreto", session: U.a)
        let r = await historial(b, agent: "marce", session: U.a)
        #expect(r.status == 200)
        #expect(igual(r.obj, ["msgs": [Any]()]))
    }

    @Test("historial: agent faltante, desconocido o session inválida -> 400")
    func historialInvalido() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }; let b = try sb.backend()
        let sinAgente = await llamar(b, "GET", "/api/historial")
        #expect(sinAgente.status == 400)
        #expect(sinAgente.obj["error"] as? String == invalido)
        #expect((await historial(b, agent: "nadie")).status == 400)
        #expect((await historial(b, agent: "")).status == 400)
        for s in ["", "no-es-uuid", "11111111-1111-4111-8111-11111111111", "11111111-1111-4111-8111-1111111111111", "gggggggg-1111-4111-8111-111111111111"] {
            let r = await historial(b, session: s)
            #expect(r.status == 400, "session=\(s)")
            #expect(r.obj["error"] as? String == invalido)
        }
    }

    // MARK: /api/chat

    @Test("chat: respuesta exacta {reply} y queda guardada")
    func chatOk() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        let r = await chat(b, message: "  hola  ")
        #expect(r.status == 200)
        #expect(igual(r.obj, ["reply": "hola betty"]))
        // el mensaje se guarda y se envía recortado
        #expect(sb.llamadas.last?.last == "hola")
        #expect(msgs(await historial(b, session: U.a)).first?["t"] as? String == "hola")
    }

    @Test("chat: sin respuesta de texto -> '(sin respuesta)' guardado y reply vacío")
    func chatSinRespuesta() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }; let b = try sb.backend()
        let r = await chat(b, message: "VACIO")
        #expect(r.status == 200)
        #expect(r.obj["reply"] as? String == "")
        #expect(msgs(await historial(b, session: U.a)).last?["t"] as? String == "(sin respuesta)")
    }

    @Test("chat: cuerpo inválido -> 400 sin lanzar claude", arguments: [
        "nil", "no json", "[]", "{}",
        #"{"agent":"betty","message":"hola"}"#,
        #"{"agent":"betty","session":"11111111-1111-4111-8111-111111111111"}"#,
        #"{"message":"hola","session":"11111111-1111-4111-8111-111111111111"}"#,
        #"{"agent":1,"message":"hola","session":"11111111-1111-4111-8111-111111111111"}"#,
        #"{"agent":"betty","message":123,"session":"11111111-1111-4111-8111-111111111111"}"#,
        #"{"agent":"betty","message":"hola","session":7}"#,
    ])
    func chatCuerpoInvalido(cuerpo: String) async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        let r = await llamar(b, "POST", "/api/chat", body: cuerpo == "nil" ? nil : Data(cuerpo.utf8))
        #expect(r.status == 400)
        #expect(r.obj["error"] as? String == invalido)
        #expect(sb.llamadas.isEmpty)
    }

    @Test("chat: UUID inválido, agente desconocido o mensaje vacío -> 400")
    func chatValidaciones() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        for s in ["", "x", "11111111111141118111111111111111", "11111111-1111-4111-8111-11111111111z", " 11111111-1111-4111-8111-111111111111"] {
            let r = await chat(b, session: s)
            #expect(r.status == 400, "session=\(s)")
            #expect(r.obj["error"] as? String == invalido)
        }
        let ag = await chat(b, agent: "fantasma")
        #expect(ag.status == 400)
        #expect(ag.obj["error"] as? String == invalido)
        #expect((await chat(b, agent: "../betty")).status == 400)
        for m in ["", "   ", "\n\t "] {
            let r = await chat(b, message: m)
            #expect(r.status == 400, "mensaje vacío")
        }
        #expect(sb.llamadas.isEmpty)
        // nada se guardó
        #expect(msgs(await historial(b)).isEmpty)
    }

    @Test("chat: mensaje de 100001 caracteres -> 400; de 100000 -> ok")
    func chatLargoMensaje() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        let r = await chat(b, message: String(repeating: "a", count: 100_001))
        #expect(r.status == 400)
        #expect(sb.llamadas.isEmpty)
        let ok = await chat(b, message: String(repeating: "a", count: 100_000))
        #expect(ok.status == 200)
    }

    @Test("chat: cuerpo de más de 200000 bytes -> 413")
    func chat413() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        let r = await llamar(b, "POST", "/api/chat", body: Data(repeating: UInt8(ascii: "x"), count: 200_001))
        #expect(r.status == 413)
        #expect(r.obj["error"] as? String == "pedido demasiado grande")
        // justo en el límite ya no es 413 (es 400 por no ser JSON)
        let lim = await llamar(b, "POST", "/api/chat", body: Data(repeating: UInt8(ascii: "x"), count: 200_000))
        #expect(lim.status == 400)
        #expect(sb.llamadas.isEmpty)
    }

    @Test("chat: sesión que pertenece a otro agente -> 400 y no lanza claude")
    func chatSesionAjena() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        _ = await chat(b, agent: "betty", message: "hola", session: U.a)
        let antes = sb.llamadas.count
        let r = await chat(b, agent: "marce", message: "intruso", session: U.a)
        #expect(r.status == 400)
        #expect(r.obj["error"] as? String == invalido)
        #expect(sb.llamadas.count == antes)
        #expect(msgs(await historial(b, agent: "betty", session: U.a)).count == 2)
    }

    @Test("chat: UUID en mayúsculas se guarda y se envía en minúsculas")
    func chatMayusculas() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        let r = await chat(b, session: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")
        #expect(r.status == 200)
        let a = try #require(sb.llamadas.last)
        #expect(a.contains("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
        #expect(!a.contains("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"))
    }

    @Test("chat: claude inexistente (ruta fija que no ejecuta) -> 500 'No pude ejecutar'")
    func chatNoEjecuta() async throws {
        let sb = Sandbox()
        let b = try sb.backend(claudePath: sb.root + "/no-existe/claude")
        let r = await chat(b)
        #expect(r.status == 500)
        #expect(r.obj["error"] as? String == ClaudeError.noEjecuta("").mensaje)
        // el error queda en el historial
        let h = msgs(await historial(b, session: U.a))
        #expect(h.last?["e"] as? Bool == true)
    }

    @Test("chat: sin claude -> 500 'No encontré Claude Code' y no se guarda nada")
    func chatSinClaude() async throws {
        let sb = Sandbox()
        let b = try Backend(config: sb.config(), dataDir: sb.datos, claudePath: nil, env: [:])
        guard b.runner.claudePath == nil else {
            Issue.record("omitido: hay un claude real localizable (\(b.runner.claudePath ?? "")); el caso sin claude no se pudo simular", severity: .warning)
            return
        }
        let r = await chat(b)
        #expect(r.status == 500)
        #expect(r.obj["error"] as? String == ClaudeError.noEncontrado.mensaje)
        #expect(msgs(await historial(b, session: U.a)).isEmpty)
    }

    /// Cambio de contrato (oficinas): sin carpeta de oficina no hay oficina activa, así que el chat responde 409.
    @Test("chat: sin oficina abierta (carpeta inexistente) -> 409 'No hay una oficina abierta'")
    func chatSinProyecto() async throws {
        let sb = Sandbox(proyecto: false)
        let b = try sb.backend()
        let r = await chat(b)
        #expect(r.status == 409)
        #expect(r.obj["error"] as? String == "No hay una oficina abierta")
        #expect(sb.llamadas.isEmpty)
    }

    // MARK: rutas y métodos

    @Test("404 para rutas desconocidas (incluye /api/ y estáticos)", arguments: ["/", "/api", "/api/", "/api/otra", "/api/estado/", "/index.html", "/api/chat/x"])
    func ruta404(path: String) async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }; let b = try sb.backend()
        for m in ["GET", "POST"] {
            let r = await llamar(b, m, path)
            #expect(r.status == 404, "\(m) \(path)")
            #expect(igual(r.obj, ["error": "no"]))
        }
    }

    @Test("405 con método equivocado")
    func metodo405() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }; let b = try sb.backend()
        let casos: [(String, String)] = [
            ("POST", "/api/estado"), ("PUT", "/api/estado"), ("DELETE", "/api/estado"),
            ("POST", "/api/historial"), ("DELETE", "/api/historial"),
            ("GET", "/api/chat"), ("PUT", "/api/chat"), ("DELETE", "/api/chat"), ("HEAD", "/api/chat"),
        ]
        for (m, p) in casos {
            let r = await llamar(b, m, p)
            #expect(r.status == 405, "\(m) \(p)")
            #expect(igual(r.obj, ["error": "método no permitido"]))
        }
    }
}
