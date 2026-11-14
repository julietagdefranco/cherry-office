import Foundation
import Testing
@testable import Backend

/// Perfil (YO): uno para toda la app, guardado en config.json, que pasa a ser el dueño de cada oficina.
extension Etapa2 {
@Suite("Perfil de quien dirige")
struct PerfilTests {
    @Test("sin perfil: vacío, y la oficina conserva su dueño")
    func vacio() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        let r = await llamar(b, "GET", "/api/perfil")
        #expect(r.status == 200)
        #expect(dict(r.obj["perfil"])["nombre"] as? String == "")
        #expect(dict(r.obj["perfil"])["avatar"] is NSNull)
        let e = await llamar(b, "GET", "/api/estado")
        #expect(dict(e.obj["perfil"])["nombre"] as? String == "")
        #expect(dict((await llamar(b, "GET", "/api/oficina")).obj["oficina"])["duenio"] as? String == "Tester")
    }

    @Test("guardar: persiste en config.json, sobrevive al reinicio y pasa a ser el dueño de la oficina activa")
    func guardar() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        let r = await llamar(b, "PUT", "/api/perfil", body: json(["nombre": "  Luis ", "avatar": ["colorTorso": "#141414", "pelo": "corto"]]))
        #expect(r.status == 200)
        let p = dict(r.obj["perfil"])
        #expect(p["nombre"] as? String == "Luis")
        #expect(dict(p["avatar"])["semilla"] as? String == "yo")
        #expect(dict(p["avatar"])["colorTorso"] as? String == "#141414")
        #expect(dict(r.obj["oficina"])["duenio"] as? String == "Luis")
        // en disco: oficina.json con el dueño nuevo y config.json con el perfil (sin perder la oficina activa)
        let of = (try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: sb.proyecto + "/oficina.json")))) as? [String: Any] ?? [:]
        #expect(of["duenio"] as? String == "Luis")
        let cfg = (try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: sb.datos + "/config.json")))) as? [String: Any] ?? [:]
        #expect(dict(cfg["perfil"])["nombre"] as? String == "Luis")
        #expect(cfg["oficina_activa"] as? String == sb.proyecto)

        let b2 = try Backend(config: sb.config(), dataDir: sb.datos, claudePath: sb.bin, env: [:])
        #expect(dict((await llamar(b2, "GET", "/api/perfil")).obj["perfil"])["nombre"] as? String == "Luis")
    }

    @Test("una oficina que se abre o se crea toma el perfil como dueño")
    func otrasOficinas() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        _ = await llamar(b, "PUT", "/api/perfil", body: json(["nombre": "Luis"]))
        let n = await llamar(b, "POST", "/api/oficinas", body: json(["nombre": "Taller", "duenio": "Ana"]))
        #expect(dict(n.obj["oficina"])["duenio"] as? String == "Luis")
        // una oficina vieja con otro dueño: al abrirla queda con el perfil
        let vieja = sb.home + "/Vieja"
        try FileManager.default.createDirectory(atPath: vieja, withIntermediateDirectories: true)
        try OficinaStore.escribir(Oficina(nombre: "Vieja", duenio: "Juli"), carpeta: vieja)
        let a = await llamar(b, "POST", "/api/oficinas/abrir", body: json(["carpeta": vieja]))
        #expect(a.status == 200)
        #expect(dict((await llamar(b, "GET", "/api/oficina")).obj["oficina"])["duenio"] as? String == "Luis")
    }

    @Test("validación: nombre largo y avatar inválido")
    func validacion() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        #expect((await llamar(b, "PUT", "/api/perfil", body: json(["nombre": String(repeating: "x", count: 81)]))).status == 400)
        #expect((await llamar(b, "PUT", "/api/perfil", body: json(["nombre": "Luis", "avatar": ["colorPelo": "rojo"]]))).status == 400)
        #expect((await llamar(b, "PATCH", "/api/perfil", body: json(["nombre": "Luis"]))).status == 405)
    }
}
}
