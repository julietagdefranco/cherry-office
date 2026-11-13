import Foundation
import Testing
@testable import Backend

@Suite("Servidor de desarrollo (oficina-dev)")
struct ServidorDevTests {
    /// Router de mentira: devuelve método, ruta, query y cuerpo.
    struct Eco: APIHandler {
        func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data) {
            (200, Router.codificar(["m": method, "p": path, "q": query, "b": body.map { String(decoding: $0, as: UTF8.self) } ?? ""]))
        }
    }

    func servidor() throws -> (ServidorDev, Sandbox) {
        let sb = Sandbox()
        let ui = sb.proyecto + "/oficina", vendor = sb.proyecto + "/vendor"
        for d in [ui + "/ui", ui + "/ldraw", vendor, sb.proyecto + "/secreto"] {
            try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        }
        try "<html>".write(toFile: ui + "/index.html", atomically: true, encoding: .utf8)
        try "x()".write(toFile: ui + "/ui/app.js", atomically: true, encoding: .utf8)
        try "three".write(toFile: vendor + "/three.min.js", atomically: true, encoding: .utf8)
        try "no".write(toFile: ui + "/server.py", atomically: true, encoding: .utf8)
        try "no".write(toFile: sb.proyecto + "/secreto/x.txt", atomically: true, encoding: .utf8)
        return (ServidorDev(router: Eco(), raizUI: URL(fileURLWithPath: ui), raizVendor: URL(fileURLWithPath: vendor), puerto: 8765), sb)
    }

    func pedido(_ m: String, _ ruta: String, host: String = "localhost:8765", origin: String? = nil, tipo: String? = nil, cuerpo: String = "") -> HTTPMinimo.Pedido {
        var h = ["host": host]
        if let origin { h["origin"] = origin }
        if let tipo { h["content-type"] = tipo }
        return HTTPMinimo.Pedido(metodo: m, ruta: ruta, cabeceras: h, cuerpo: Data(cuerpo.utf8))
    }

    func partes(_ d: Data) -> (Int, String) {
        let s = String(decoding: d, as: UTF8.self)
        let st = Int(s.split(separator: " ")[1]) ?? 0
        return (st, s.components(separatedBy: "\r\n\r\n").dropFirst().joined(separator: "\r\n\r\n"))
    }

    @Test("estáticos: index, ui/, vendor/; nada fuera de la lista blanca ni con ..")
    func estaticos() async throws {
        let (s, sb) = try servidor(); defer { withExtendedLifetime(sb) {} }
        #expect(partes(await s.manejar(pedido("GET", "/"))) == (200, "<html>"))
        #expect(partes(await s.manejar(pedido("GET", "/ui/app.js"))) == (200, "x()"))
        #expect(partes(await s.manejar(pedido("GET", "/vendor/three.min.js"))) == (200, "three"))
        #expect(partes(await s.manejar(pedido("GET", "/server.py"))).0 == 404)
        #expect(partes(await s.manejar(pedido("GET", "/ui/../server.py"))).0 == 404)
        #expect(partes(await s.manejar(pedido("GET", "/ui/%2e%2e/%2e%2e/secreto/x.txt"))).0 == 404)
        #expect(partes(await s.manejar(pedido("GET", "/ui"))).0 == 404)
        #expect(partes(await s.manejar(pedido("POST", "/ui/app.js"))).0 == 405)
        #expect(String(decoding: await s.manejar(pedido("GET", "/ui/app.js")), as: UTF8.self).contains("application/javascript"))
    }

    @Test("Host de loopback obligatorio (contra DNS rebinding)")
    func host() async throws {
        let (s, sb) = try servidor(); defer { withExtendedLifetime(sb) {} }
        #expect(partes(await s.manejar(pedido("GET", "/", host: "evil.com"))).0 == 403)
        #expect(partes(await s.manejar(pedido("GET", "/api/estado", host: "localhost:9999"))).0 == 403)
        #expect(partes(await s.manejar(pedido("GET", "/", host: "127.0.0.1:8765"))).0 == 200)
    }

    @Test("API: GET pasa con query; escrituras exigen Origin propio y JSON")
    func api() async throws {
        let (s, sb) = try servidor(); defer { withExtendedLifetime(sb) {} }
        let (st, js) = partes(await s.manejar(pedido("GET", "/api/entregas?estado=sin_revisar&agente=mar%20ce")))
        #expect(st == 200)
        let o = (try JSONSerialization.jsonObject(with: Data(js.utf8))) as? [String: Any] ?? [:]
        #expect(o["p"] as? String == "/api/entregas")
        #expect(o["q"] as? [String: String] == ["estado": "sin_revisar", "agente": "mar ce"])
        #expect(partes(await s.manejar(pedido("POST", "/api/chat", tipo: "application/json", cuerpo: "{}"))).0 == 403)
        #expect(partes(await s.manejar(pedido("POST", "/api/chat", origin: "http://evil.com", tipo: "application/json", cuerpo: "{}"))).0 == 403)
        #expect(partes(await s.manejar(pedido("POST", "/api/chat", origin: "http://localhost:8765", tipo: "text/plain", cuerpo: "{}"))).0 == 415)
        let ok = partes(await s.manejar(pedido("POST", "/api/chat", origin: "http://localhost:8765", tipo: "application/json", cuerpo: "{\"a\":1}")))
        #expect(ok.0 == 200 && ok.1.contains("{\\\"a\\\":1}"))
        #expect(partes(await s.manejar(pedido("DELETE", "/api/tareas/x", origin: "http://localhost:8765"))).0 == 200)
    }
}
