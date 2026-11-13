import Foundation
import Testing
@testable import Backend

/// Exportar una oficina a .zip e importarla en otra «compu» (otro sandbox: otra carpeta personal, otra hq.db).
extension Etapa2 {
@Suite("Exportar e importar oficinas")
struct PaqueteTests {
    func oficinaConTodo() async throws -> Fix {
        let f = try await Fix.crear(nombre: "Taller", duenio: "Ana", deps: ["Dirección", "Redes"],
                                    agentes: [("betty", "direccion", nil), ("marce", "redes", nil)])
        // un documento fichado
        let r = await f.post("/api/archivos", ["nombre": "precios.txt", "base64": Data("El taller cuesta 150 dolares.".utf8).base64EncodedString()])
        try #require(r.status == 200, "\(r.obj)")
        _ = await esperarAsync(hasta: 15) { str(dict((await f.get("/api/archivos/precios")).obj["archivo"])["estado"]) == "listo" }
        // otro que va a la papelera
        _ = await f.post("/api/archivos", ["nombre": "viejo.txt", "base64": Data("Borrador viejo.".utf8).base64EncodedString()])
        _ = await esperarAsync(hasta: 15) { str(dict((await f.get("/api/archivos/viejo")).obj["archivo"])["estado"]) == "listo" }
        #expect((await f.delete("/api/archivos/viejo")).status == 200)
        // una carpeta vinculada (con un documento fichado en su lugar)
        let ext = f.sb.root + "/externa"
        try FileManager.default.createDirectory(atPath: ext, withIntermediateDirectories: true)
        escribir("Contrato con el proveedor.", en: ext + "/contrato.txt")
        try #require((await f.post("/api/vinculos", ["ruta": ext, "id": "externa"])).status == 200)
        _ = await f.post("/api/vinculos/externa/escanear", [:])
        _ = await esperarAsync(hasta: 15) { (await f.get("/api/biblioteca/estado")).obj["pendientes"] as? Int == 0 }
        // notas que mencionan la ruta de la oficina
        escribir("Notas de Betty. Ver \(f.carpeta)/conocimiento/oficina.md\n", en: f.ruta("conocimiento/agentes/betty.md"))
        escribir("Acta de prueba.\n", en: f.ruta("reuniones/2026-11-01-arranque.md"))
        escribir("basura", en: f.ruta(".DS_Store"))
        return f
    }

    func exportar(_ f: Fix, destino: String? = nil) async throws -> Resp {
        let dir = destino ?? (f.sb.root + "/exportados")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return await f.post("/api/oficina/exportar", ["destino": dir])
    }

    func entradas(_ zip: String) -> [String] {
        PaqueteRouter.correr("/usr/bin/zipinfo", ["-1", zip]).1.split(separator: "\n").map(String.init)
    }

    func importar(_ b: Backend, _ zip: String) async -> Resp {
        await llamar(b, "POST", "/api/oficinas/importar", body: json(["archivo": zip]))
    }

    @Test("exportar: .zip con la oficina, el índice de la biblioteca y sin papelera, vínculos ni la ruta de esta compu")
    func exportarZip() async throws {
        let f = try await oficinaConTodo()
        let r = try await exportar(f)
        #expect(r.status == 200, "\(r.obj)")
        #expect(Set(r.obj.keys) == ["archivo", "nombre", "tam", "documentos", "omitidos", "avisos"])
        let zip = str(r.obj["archivo"])
        #expect(zip == f.sb.root + "/exportados/Taller.oficina.zip")
        #expect(r.obj["nombre"] as? String == "Taller.oficina.zip")
        #expect((r.obj["tam"] as? Int ?? 0) > 0)
        #expect(r.obj["documentos"] as? Int == 1)
        #expect(dict(r.obj["omitidos"])["vinculos"] as? Int == 1)
        #expect(dict(r.obj["omitidos"])["papelera"] as? Bool == true)
        #expect((r.obj["avisos"] as? [String]) == [])

        let e = entradas(zip)
        for x in ["Taller/oficina.json", "Taller/.oficina-paquete.json", "Taller/.claude/agents/betty.md", "Taller/.claude/agents/marce.md",
                  "Taller/conocimiento/agentes/betty.md", "Taller/conocimiento/fuentes/precios.md", "Taller/archivos/.texto/precios.md",
                  "Taller/archivos/compartido/precios.txt", "Taller/reuniones/2026-11-01-arranque.md"] {
            #expect(e.contains(x), "falta \(x)")
        }
        #expect(!e.contains { $0.hasPrefix("Taller/archivos/.papelera/") && $0 != "Taller/archivos/.papelera/" }, "\(e)")
        #expect(!e.contains { $0.contains("contrato") }, "\(e)")
        #expect(!e.contains { $0.hasSuffix(".DS_Store") || $0.contains("__MACOSX") })

        // la oficina original no se tocó
        #expect(f.oficinaJSON()["vinculos"] != nil)
        #expect(f.leer("conocimiento/agentes/betty.md").contains(f.carpeta))

        // exportar de nuevo no pisa el anterior
        let r2 = try await exportar(f)
        #expect(str(r2.obj["archivo"]) == f.sb.root + "/exportados/Taller 2.oficina.zip")
    }

    @Test("importar en otra compu: misma oficina, biblioteca lista sin volver a fichar, rutas adaptadas")
    func idaYVuelta() async throws {
        let f = try await oficinaConTodo()
        let zip = str(try await exportar(f).obj["archivo"])

        let sb2 = Sandbox()
        let b2 = try sb2.backend(oficina: false)
        let r = await importar(b2, zip)
        #expect(r.status == 200, "\(r.obj)")
        let carpeta = str(r.obj["carpeta"])
        #expect(carpeta == sb2.oficinasDir + "/Taller")
        #expect(r.obj["documentos"] as? Int == 1)
        #expect(r.obj["reprocesar"] as? Int == 0)
        #expect((r.obj["avisos"] as? [String]) == [])
        let of = dict(r.obj["oficina"])
        #expect(of["nombre"] as? String == "Taller")
        #expect(lista(of["agentes"]).map { str($0["id"]) } == ["betty", "marce"])
        #expect(of["vinculos"] == nil)

        // queda abierta
        let est = await llamar(b2, "GET", "/api/estado")
        #expect(dict(est.obj["oficina"])["carpeta"] as? String == carpeta)
        // archivos y rutas
        #expect(leerTexto(carpeta + "/conocimiento/agentes/betty.md") == "Notas de Betty. Ver \(carpeta)/conocimiento/oficina.md\n")
        #expect(leerTexto(carpeta + "/reuniones/2026-11-01-arranque.md") == "Acta de prueba.\n")
        #expect(!existe(carpeta + "/.oficina-paquete.json"))
        #expect(existe(carpeta + "/archivos/.papelera"))
        #expect(listar(carpeta + "/archivos/.papelera").isEmpty)
        #expect(leerTexto(carpeta + "/.claude/agents/betty.md").contains("name: betty"))
        // biblioteca: el documento aparece listo, se puede buscar y no se llamó al bibliotecario
        let arch = await llamar(b2, "GET", "/api/archivos")
        let filas = lista(arch.obj["archivos"])
        #expect(filas.map { str($0["slug"]) } == ["precios"])
        #expect(filas.first?["estado"] as? String == "listo")
        #expect(dict(filas.first?["ficha"])["titulo"] as? String == "Ficha de prueba")
        let q = await llamar(b2, "GET", "/api/archivos", query: ["q": "dolares"])
        #expect(lista(q.obj["archivos"]).map { str($0["slug"]) } == ["precios"])
        #expect(sb2.llamadas(conPrompt: "Sos el bibliotecario").isEmpty)
        let cat = leerTexto(carpeta + "/conocimiento/archivos.md")
        #expect(cat.contains("`precios`"))
        #expect(!cat.contains("contrato"))
        // el chat funciona en la oficina importada
        let c = await llamar(b2, "POST", "/api/chat", body: json(["agent": "betty", "message": "hola", "session": U.a]))
        #expect(c.status == 200, "\(c.obj)")
        #expect(sinPrivate(sb2.cwds.last ?? "") == sinPrivate(carpeta))

        // importarla otra vez no pisa la primera
        let r2 = await importar(b2, zip)
        #expect(r2.status == 200)
        #expect(str(r2.obj["carpeta"]) == sb2.oficinasDir + "/Taller 2")
        await b2.shutdown()
    }

    @Test("importar: un .zip hecho a mano con la carpeta (sin índice) también se abre, con aviso")
    func zipSinManifiesto() async throws {
        let f = try await Fix.crear(agentes: [("betty", "direccion", nil)])
        let zip = f.sb.root + "/a-mano.zip"
        #expect(PaqueteRouter.correr("/usr/bin/ditto", ["-c", "-k", "--keepParent", f.carpeta, zip]).0)
        let sb2 = Sandbox()
        let b2 = try sb2.backend(oficina: false)
        let r = await importar(b2, zip)
        #expect(r.status == 200, "\(r.obj)")
        #expect((r.obj["avisos"] as? [String] ?? []).contains { $0.contains("índice de la biblioteca") })
        #expect(lista(dict(r.obj["oficina"])["agentes"]).map { str($0["id"]) } == ["betty"])
        await b2.shutdown()
    }

    @Test("importar: avisa de agentes con rutas de otra compu y quita vínculos que no existen")
    func avisosAlImportar() async throws {
        let f = try await Fix.crear(agentes: [("betty", "direccion", nil)])
        let md = f.ruta(".claude/agents/betty.md")
        escribir(leerTexto(md) + "\nLeé /Users/otra-persona/Documentos/plan.md antes de empezar.\n", en: md)
        var of = f.oficinaJSON()
        of["vinculos"] = [["id": "lejos", "ruta": "/Users/otra-persona/Drive", "alcance": "oficina"]]
        try JSONSerialization.data(withJSONObject: of).write(to: URL(fileURLWithPath: f.ruta("oficina.json")))
        let zip = f.sb.root + "/a-mano.zip"
        #expect(PaqueteRouter.correr("/usr/bin/ditto", ["-c", "-k", "--keepParent", f.carpeta, zip]).0)
        let sb2 = Sandbox()
        let b2 = try sb2.backend(oficina: false)
        let r = await importar(b2, zip)
        #expect(r.status == 200, "\(r.obj)")
        let avisos = r.obj["avisos"] as? [String] ?? []
        #expect(avisos.contains { $0.contains("«Betty»") && $0.contains("/Users/otra-persona/Documentos/plan.md") }, "\(avisos)")
        #expect(avisos.contains { $0.contains("carpeta(s) vinculada(s)") }, "\(avisos)")
        #expect(dict(r.obj["oficina"])["vinculos"] == nil)
        await b2.shutdown()
    }

    @Test("importar: rechaza zips peligrosos o que no son una oficina")
    func importarRechazos() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let fm = FileManager.default
        func zipDe(_ nombre: String, _ armar: (String) throws -> Void) throws -> String {
            let dir = sb.root + "/z-\(nombre)"
            try fm.createDirectory(atPath: dir + "/Oficina", withIntermediateDirectories: true)
            try armar(dir + "/Oficina")
            let zip = sb.root + "/\(nombre).zip"
            #expect(PaqueteRouter.correr("/usr/bin/ditto", ["-c", "-k", "--keepParent", dir + "/Oficina", zip]).0)
            return zip
        }
        // sin oficina.json
        let vacio = try zipDe("vacio") { escribir("hola", en: $0 + "/nota.txt") }
        #expect((await importar(b, vacio)).status == 400)
        // oficina.json inválido
        let malo = try zipDe("malo") { escribir("{no es json", en: $0 + "/oficina.json") }
        #expect((await importar(b, malo)).status == 400)
        // con un enlace simbólico
        let conEnlace = try zipDe("enlace") { d in
            escribir(String(data: json(["version": 1, "nombre": "X", "duenio": "", "departamentos": [["id": "a", "nombre": "A", "color": "#123456"]], "agentes": []]), encoding: .utf8)!, en: d + "/oficina.json")
            try fm.createSymbolicLink(atPath: d + "/afuera", withDestinationPath: "/etc")
        }
        let r = await importar(b, conEnlace)
        #expect(r.status == 400)
        #expect(str(r.obj["error"]).contains("enlaces simbólicos"))
        // con rutas que salen de la carpeta (zip-slip)
        let slip = sb.root + "/slip.zip"
        let py = "import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w')\nz.writestr('Oficina/oficina.json','{}')\nz.writestr('../../afuera.txt','x')\nz.close()\n"
        if fm.isExecutableFile(atPath: "/usr/bin/python3"), PaqueteRouter.correr("/usr/bin/python3", ["-I", "-c", py, slip]).0 {
            let s = await importar(b, slip)
            #expect(s.status == 400)
            #expect(str(s.obj["error"]).contains("rutas inválidas"))
            #expect(!existe(sb.root + "/../afuera.txt"))
        }
        // no es un zip / no existe / no es .zip / ruta relativa
        escribir("no soy un zip", en: sb.root + "/falso.zip")
        #expect((await importar(b, sb.root + "/falso.zip")).status == 400)
        #expect((await importar(b, sb.root + "/no-existe.zip")).status == 404)
        escribir("x", en: sb.root + "/otra.txt")
        #expect((await importar(b, sb.root + "/otra.txt")).status == 400)
        #expect((await importar(b, "relativa.zip")).status == 400)
        #expect((await llamar(b, "POST", "/api/oficinas/importar", body: json([:]))).status == 400)
        #expect((await llamar(b, "GET", "/api/oficinas/importar")).status == 405)
        // no quedó ninguna oficina a medias
        #expect(listar(sb.oficinasDir).isEmpty)
        await b.shutdown()
    }

    @Test("exportar: sin oficina 409; destino inválido 400/404; por defecto en Descargas")
    func exportarErrores() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        #expect((await llamar(b, "POST", "/api/oficina/exportar")).status == 409)
        await b.shutdown()

        let f = try await Fix.crear(agentes: [("betty", "direccion", nil)])
        #expect((await f.post("/api/oficina/exportar", ["destino": "relativa"])).status == 400)
        #expect((await f.post("/api/oficina/exportar", ["destino": f.sb.root + "/no-existe"])).status == 404)
        try FileManager.default.createDirectory(atPath: f.sb.home + "/Downloads", withIntermediateDirectories: true)
        let r = await f.post("/api/oficina/exportar")
        #expect(r.status == 200, "\(r.obj)")
        #expect(str(r.obj["archivo"]) == f.sb.home + "/Downloads/Taller.oficina.zip")
        #expect(existe(f.sb.home + "/Downloads/Taller.oficina.zip"))
    }

    @Test("explorador: con archivos=zip lista los .zip de la carpeta")
    func explorarZips() async throws {
        let f = try await Fix.crear()
        let dir = f.sb.home + "/Descargas-prueba"
        try FileManager.default.createDirectory(atPath: dir + "/sub", withIntermediateDirectories: true)
        escribir("zip", en: dir + "/Taller.oficina.zip")
        escribir("txt", en: dir + "/nota.txt")
        let sin = await f.get("/api/fs/carpetas", ["ruta": dir])
        #expect(sin.obj["archivos"] == nil)
        let con = await f.get("/api/fs/carpetas", ["ruta": dir, "archivos": "zip"])
        #expect(lista(con.obj["archivos"]).map { str($0["nombre"]) } == ["Taller.oficina.zip"])
        #expect(lista(con.obj["carpetas"]).map { str($0["nombre"]) } == ["sub"])
    }

    @Test("rutas absolutas de otra compu en un texto")
    func rutas() {
        #expect(PaqueteRouter.rutasAbsolutas("Leé /Users/ana/Documentos/plan.md, y también \"/Users/ana/x y\" (ver /Users/ana/z).")
                == ["/Users/ana/Documentos/plan.md", "/Users/ana/x", "/Users/ana/z"])
        #expect(PaqueteRouter.rutasAbsolutas("sin rutas acá, ni algo/Users/raro") == [])
        #expect(PaqueteRouter.descomprimido("3 files, 1234 bytes uncompressed, 600 bytes compressed:  51.4%") == 1234)
    }
}
}
