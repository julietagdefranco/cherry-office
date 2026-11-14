import Foundation
import Testing
@testable import Backend

/// Perfil (YO): quien dirige cada oficina, guardado en su oficina.json (duenio + avatarDuenio).
extension Etapa2 {
@Suite("Perfil de quien dirige")
struct PerfilTests {
    @Test("sin minifig: el perfil es el dueño de la oficina activa")
    func vacio() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        let r = await llamar(b, "GET", "/api/perfil")
        #expect(r.status == 200)
        #expect(dict(r.obj["perfil"])["nombre"] as? String == "Tester")
        #expect(dict(r.obj["perfil"])["avatar"] is NSNull)
        let e = await llamar(b, "GET", "/api/estado")
        #expect(dict(e.obj["perfil"])["nombre"] as? String == "Tester")
        #expect(dict((await llamar(b, "GET", "/api/oficina")).obj["oficina"])["duenio"] as? String == "Tester")
    }

    @Test("guardar: queda en el oficina.json de la oficina activa (nombre y minifig) y sobrevive al reinicio")
    func guardar() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        let r = await llamar(b, "PUT", "/api/perfil", body: json(["nombre": "  Luis ", "avatar": ["colorTorso": "#141414", "pelo": "corto", "colorPiel": "#f2c79b"]]))
        #expect(r.status == 200)
        let p = dict(r.obj["perfil"])
        #expect(p["nombre"] as? String == "Luis")
        #expect(dict(p["avatar"])["semilla"] as? String == "yo")
        #expect(dict(p["avatar"])["colorTorso"] as? String == "#141414")
        #expect(dict(p["avatar"])["colorPiel"] as? String == "#f2c79b")
        #expect(dict(r.obj["oficina"])["duenio"] as? String == "Luis")
        let of = (try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: sb.proyecto + "/oficina.json")))) as? [String: Any] ?? [:]
        #expect(of["duenio"] as? String == "Luis")
        #expect(dict(of["avatarDuenio"])["pelo"] as? String == "corto")
        // ya no hay un perfil global en config.json
        let cfg = (try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: sb.datos + "/config.json")))) as? [String: Any] ?? [:]
        #expect(cfg["perfil"] == nil)
        #expect(cfg["oficina_activa"] as? String == sb.proyecto)

        let b2 = try Backend(config: sb.config(), dataDir: sb.datos, claudePath: sb.bin, env: [:])
        let p2 = dict((await llamar(b2, "GET", "/api/perfil")).obj["perfil"])
        #expect(p2["nombre"] as? String == "Luis")
        #expect(dict(p2["avatar"])["colorTorso"] as? String == "#141414")
    }

    @Test("cada oficina tiene su propio director: crear o abrir otra no lo pisa")
    func otrasOficinas() async throws {
        let sb = Sandbox()
        let b = try sb.backend()
        _ = await llamar(b, "PUT", "/api/perfil", body: json(["nombre": "Luis", "avatar": ["pelo": "corto"]]))
        let n = await llamar(b, "POST", "/api/oficinas", body: json(["nombre": "Taller", "duenio": "Ana"]))
        #expect(dict(n.obj["oficina"])["duenio"] as? String == "Ana")
        #expect(dict((await llamar(b, "GET", "/api/perfil")).obj["perfil"])["nombre"] as? String == "Ana")
        _ = await llamar(b, "PUT", "/api/perfil", body: json(["nombre": "Ana", "avatar": ["pelo": "largo"]]))
        // una oficina vieja con otro dueño: al abrirla lo conserva
        let vieja = sb.home + "/Vieja"
        try FileManager.default.createDirectory(atPath: vieja, withIntermediateDirectories: true)
        try OficinaStore.escribir(Oficina(nombre: "Vieja", duenio: "Juli"), carpeta: vieja)
        #expect((await llamar(b, "POST", "/api/oficinas/abrir", body: json(["carpeta": vieja]))).status == 200)
        #expect(dict((await llamar(b, "GET", "/api/oficina")).obj["oficina"])["duenio"] as? String == "Juli")
        // volver a la primera: sigue siendo Luis, con su minifig
        #expect((await llamar(b, "POST", "/api/oficinas/abrir", body: json(["carpeta": sb.proyecto]))).status == 200)
        let p = dict((await llamar(b, "GET", "/api/perfil")).obj["perfil"])
        #expect(p["nombre"] as? String == "Luis")
        #expect(dict(p["avatar"])["pelo"] as? String == "corto")
    }

    @Test("migración: el perfil global viejo le pasa su minifig a las oficinas que dirigía")
    func migracion() async throws {
        let sb = Sandbox()
        let b0 = try sb.backend()
        _ = await llamar(b0, "PUT", "/api/perfil", body: json(["nombre": "Tester"]))
        // config.json como lo dejaba la versión anterior
        let ruta = sb.datos + "/config.json"
        var cfg = (try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: ruta)))) as? [String: Any] ?? [:]
        cfg["perfil"] = ["nombre": "Tester", "avatar": ["semilla": "yo", "pelo": "corto"]]
        try JSONSerialization.data(withJSONObject: cfg).write(to: URL(fileURLWithPath: ruta))
        var of = try OficinaStore.leer(carpeta: sb.proyecto); of.avatarDuenio = nil
        try OficinaStore.escribir(of, carpeta: sb.proyecto)
        let b = try Backend(config: sb.config(), dataDir: sb.datos, claudePath: sb.bin, env: [:])
        let p = dict((await llamar(b, "GET", "/api/perfil")).obj["perfil"])
        #expect(p["nombre"] as? String == "Tester")
        #expect(dict(p["avatar"])["pelo"] as? String == "corto")
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
