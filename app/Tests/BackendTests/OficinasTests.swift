import Foundation
import Testing
@testable import Backend

/// Oficinas (crear, abrir, recientes, persistencia, PATCH, 409 sin oficina) y departamentos.
extension Etapa2 {
@Suite("Oficinas y departamentos")
struct OficinasTests {
    func nueva(_ b: Backend, _ body: [String: Any]) async -> Resp { await llamar(b, "POST", "/api/oficinas", body: json(body)) }

    // MARK: crear

    @Test("crear: estructura de carpetas, plantillas y departamentos por defecto")
    func crearEstructura() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let r = await nueva(b, ["nombre": "Taller", "duenio": "Ana"])
        #expect(r.status == 200)
        #expect(Set(r.obj.keys) == ["carpeta", "oficina"])
        let carpeta = str(r.obj["carpeta"])
        #expect(carpeta == sb.oficinasDir + "/Taller")
        for d in ["conocimiento/agentes", "conocimiento/fuentes", "reuniones", "archivos", ".claude/agents", "archivos/compartido",
                  "archivos/entregables", "archivos/.texto", "archivos/.papelera", "archivos/direccion", "archivos/comunicacion",
                  "archivos/operaciones"] {
            var isDir: ObjCBool = false
            #expect(FileManager.default.fileExists(atPath: carpeta + "/" + d, isDirectory: &isDir) && isDir.boolValue, "falta la carpeta \(d)")
        }
        for f in ["oficina.json", "conocimiento/oficina.md", "conocimiento/decisiones.md", "conocimiento/archivos.md"] {
            #expect(existe(carpeta + "/" + f), "falta \(f)")
        }
        #expect(leerTexto(carpeta + "/conocimiento/oficina.md").contains("# Taller"))
        #expect(leerTexto(carpeta + "/conocimiento/oficina.md").contains("**Dueño:** Ana"))
        #expect(leerTexto(carpeta + "/conocimiento/decisiones.md").contains("# Decisiones de Taller"))
        #expect(leerTexto(carpeta + "/conocimiento/archivos.md").contains("(Todavía no hay documentos.)"))

        let of = dict(r.obj["oficina"])
        #expect(of["version"] as? Int == 1)
        #expect(of["nombre"] as? String == "Taller")
        #expect(of["duenio"] as? String == "Ana")
        #expect((of["agentes"] as? [Any])?.isEmpty == true)
        let deps = lista(of["departamentos"])
        #expect(deps.map { str($0["nombre"]) } == ["Dirección", "Comunicación", "Operaciones"])
        #expect(deps.map { str($0["id"]) } == ["direccion", "comunicacion", "operaciones"])
        #expect(deps.map { str($0["color"]) } == ["#ee6da6", "#a88bd6", "#f0a35b"])
        // oficina.json en disco = lo que devolvió la API
        let disco = (try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: carpeta + "/oficina.json")))) as? [String: Any] ?? [:]
        #expect(igual(disco, of))
    }

    @Test("crear: queda activa (GET /api/oficina, /api/estado y recientes)")
    func crearQuedaActiva() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let e0 = await llamar(b, "GET", "/api/estado")
        #expect(e0.obj["oficina"] is NSNull)
        #expect(e0.obj["agentes"] as? [String] == [])
        let r = await nueva(b, ["nombre": "Taller", "duenio": "Ana"])
        let carpeta = str(r.obj["carpeta"])
        let g = await llamar(b, "GET", "/api/oficina")
        #expect(g.status == 200)
        #expect(g.obj["carpeta"] as? String == carpeta)
        let e = await llamar(b, "GET", "/api/estado")
        #expect(dict(e.obj["oficina"])["carpeta"] as? String == carpeta)
        #expect(dict(e.obj["oficina"])["nombre"] as? String == "Taller")
        let l = await llamar(b, "GET", "/api/oficinas")
        #expect(l.obj["activa"] as? String == carpeta)
        #expect(lista(l.obj["oficinas"]).map { str($0["nombre"]) } == ["Taller"])
        #expect(lista(l.obj["oficinas"]).first?["activa"] as? Bool == true)
    }

    @Test("crear: departamentos como texto u objeto {nombre, color, id}")
    func crearDepartamentosPedidos() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let r = await nueva(b, ["nombre": "Estudio", "departamentos": ["Gestión de Ventas", ["nombre": "Arte", "color": "#ABCDEF", "id": "arte-1"], ["nombre": "Soporte"]]])
        #expect(r.status == 200)
        let deps = lista(dict(r.obj["oficina"])["departamentos"])
        #expect(deps.map { str($0["id"]) } == ["gestion-de-ventas", "arte-1", "soporte"])
        #expect(deps.map { str($0["color"]) } == ["#ee6da6", "#abcdef", "#f0a35b"])  // color en minúsculas; el resto sigue la paleta por posición
    }

    @Test("crear: validaciones de departamentos")
    func crearValidacionDepartamentos() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let casos: [(Any, Int)] = [
            ("texto", 400),                                              // no es lista
            ([["color": "#ffffff"]], 400),                              // objeto sin nombre
            ([["nombre": "A", "color": "rojo"]], 400),                  // color inválido
            ([["nombre": "A", "id": "Mal Id"]], 400),                   // id inválido
            ([["nombre": "A", "id": "x"], ["nombre": "B", "id": "x"]], 409),  // id repetido
            ([42], 400),                                                  // ni texto ni objeto
            ([String](repeating: "D", count: 13), 400),                  // más de 12
            ([String(repeating: "n", count: 61)], 400),                  // nombre largo
        ]
        for (deps, esperado) in casos {
            let r = await nueva(b, ["nombre": "Estudio", "departamentos": deps])
            #expect(r.status == esperado, "departamentos=\(deps) -> \(r.status) \(r.obj)")
            #expect(r.obj["error"] is String)
        }
        // nada quedó creado ni activo
        #expect(listar(sb.oficinasDir).isEmpty)
        #expect((await llamar(b, "GET", "/api/oficinas")).obj["activa"] is NSNull)
        // lista vacía o null: usa los de por defecto
        for v in [[Any](), NSNull()] as [Any] {
            let r = await nueva(b, ["nombre": "Vacía \(listar(sb.oficinasDir).count)", "departamentos": v])
            #expect(r.status == 200)
            #expect(lista(dict(r.obj["oficina"])["departamentos"]).count == 3)
        }
    }

    @Test("crear: validaciones del cuerpo y del nombre")
    func crearValidacionCuerpo() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        #expect((await nueva(b, [:])).status == 400)
        #expect((await nueva(b, ["nombre": "   "])).status == 400)
        #expect((await nueva(b, ["nombre": 5])).status == 400)
        #expect((await nueva(b, ["nombre": String(repeating: "a", count: 81)])).status == 400)
        #expect((await nueva(b, ["nombre": "Ok", "duenio": String(repeating: "a", count: 81)])).status == 400)
        #expect((await llamar(b, "POST", "/api/oficinas")).status == 400)
        #expect((await llamar(b, "POST", "/api/oficinas", body: Data("[1]".utf8))).status == 400)
        #expect((await llamar(b, "POST", "/api/oficinas", body: Data("no json".utf8))).status == 400)
        let grande = await llamar(b, "POST", "/api/oficinas", body: Data(repeating: 0x20, count: 200_001))
        #expect(grande.status == 413)
        #expect(listar(sb.oficinasDir).isEmpty)
        // espacios alrededor del nombre se recortan
        let r = await nueva(b, ["nombre": "  Con espacios  "])
        #expect(dict(r.obj["oficina"])["nombre"] as? String == "Con espacios")
    }

    @Test("crear: nombre ocupado -> «Nombre 2», «Nombre 3»; caracteres de ruta en el nombre pasan a «-»")
    func crearNombreOcupado() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let a = await nueva(b, ["nombre": "Taller"])
        let c = await nueva(b, ["nombre": "Taller"])
        let d = await nueva(b, ["nombre": "Taller"])
        #expect([a, c, d].map { str($0.obj["carpeta"]) } == [sb.oficinasDir + "/Taller", sb.oficinasDir + "/Taller 2", sb.oficinasDir + "/Taller 3"])
        // el nombre de la oficina queda tal cual aunque la carpeta tenga sufijo
        #expect(dict(c.obj["oficina"])["nombre"] as? String == "Taller")
        let raro = await nueva(b, ["nombre": "A/B:C"])
        #expect(str(raro.obj["carpeta"]) == sb.oficinasDir + "/A-B-C")
        let punto = await nueva(b, ["nombre": "..oculta"])
        #expect(str(punto.obj["carpeta"]) == sb.oficinasDir + "/oculta")
        // la última creada es la activa
        #expect((await llamar(b, "GET", "/api/oficinas")).obj["activa"] as? String == sb.oficinasDir + "/oculta")
    }

    @Test("crear: carpeta explícita (absoluta, con ~ del HOME temporal), relativa -> 400, 409 si ya hay oficina.json")
    func crearCarpetaExplicita() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let abs = sb.root + "/elegida/Mi Oficina"
        let r = await nueva(b, ["nombre": "X", "carpeta": abs])
        #expect(r.status == 200)
        #expect(str(r.obj["carpeta"]) == abs)
        #expect(existe(abs + "/oficina.json"))

        let tilde = await nueva(b, ["nombre": "Y", "carpeta": "~/Casa"])
        #expect(tilde.status == 200)
        #expect(str(tilde.obj["carpeta"]) == sb.home + "/Casa")
        #expect(existe(sb.home + "/Casa/oficina.json"))

        #expect((await nueva(b, ["nombre": "Z", "carpeta": "relativa/carpeta"])).status == 400)

        // ya hay oficina.json: 409 y no se pisa
        let antes = leerTexto(abs + "/oficina.json")
        let dup = await nueva(b, ["nombre": "Otra", "carpeta": abs])
        #expect(dup.status == 409)
        #expect(leerTexto(abs + "/oficina.json") == antes)
        // la que sigue activa es la anterior (la del 409 no la cambió)
        #expect((await llamar(b, "GET", "/api/oficinas")).obj["activa"] as? String == sb.home + "/Casa")
    }

    @Test("crear sobre una carpeta que ya existe: no pisa el contenido del usuario")
    func crearNoPisa() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let dir = sb.root + "/existente"
        escribir("MI MEMORIA", en: dir + "/conocimiento/oficina.md")
        escribir("otro", en: dir + "/nota.txt")
        let r = await nueva(b, ["nombre": "Existente", "carpeta": dir])
        #expect(r.status == 200)
        #expect(leerTexto(dir + "/conocimiento/oficina.md") == "MI MEMORIA")
        #expect(leerTexto(dir + "/nota.txt") == "otro")
        #expect(existe(dir + "/conocimiento/decisiones.md"))
    }

    // MARK: abrir

    @Test("abrir: 404 carpeta inexistente o sin oficina.json; 400 ruta relativa o falta de campo")
    func abrirErrores() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        func abrir(_ c: Any?) async -> Resp { await llamar(b, "POST", "/api/oficinas/abrir", body: c.map { json(["carpeta": $0]) } ?? json([:])) }
        #expect((await abrir(sb.root + "/no-existe")).status == 404)
        try FileManager.default.createDirectory(atPath: sb.root + "/vacia", withIntermediateDirectories: true)
        let sin = await abrir(sb.root + "/vacia")
        #expect(sin.status == 404)
        #expect(str(sin.obj["error"]).contains("oficina.json"))
        #expect((await abrir("relativa")).status == 400)
        #expect((await abrir(nil)).status == 400)
        #expect((await abrir(7)).status == 400)
        #expect((await llamar(b, "POST", "/api/oficinas/abrir")).status == 400)
        // un archivo común no es una carpeta
        escribir("x", en: sb.root + "/archivo.txt")
        #expect((await abrir(sb.root + "/archivo.txt")).status == 404)
        #expect((await llamar(b, "GET", "/api/oficinas")).obj["activa"] is NSNull)
    }

    @Test("abrir: oficina.json inválido -> 400 y no se activa")
    func abrirInvalida() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        func con(_ nombre: String, _ contenido: String) async -> Resp {
            escribir(contenido, en: sb.root + "/\(nombre)/oficina.json")
            return await llamar(b, "POST", "/api/oficinas/abrir", body: json(["carpeta": sb.root + "/" + nombre]))
        }
        #expect((await con("a", "esto no es json")).status == 400)
        #expect((await con("b", ##"{"version":2,"nombre":"X","departamentos":[],"agentes":[]}"##)).status == 400)
        #expect((await con("c", ##"{"nombre":"X","departamentos":[{"id":"d","nombre":"D","color":"#ffffff"}],"agentes":[{"id":"a","nombre":"A","rol":"r","departamento":"inexistente"}]}"##)).status == 400)
        #expect((await con("d", ##"{"nombre":"X","departamentos":[{"id":"Mal Id","nombre":"D","color":"#ffffff"}],"agentes":[]}"##)).status == 400)
        #expect((await con("e", ##"{"nombre":"X","departamentos":[{"id":"d","nombre":"D","color":"rojo"}],"agentes":[]}"##)).status == 400)
        #expect((await con("f", ##"{"nombre":"  ","departamentos":[],"agentes":[]}"##)).status == 400)
        #expect((await con("g", ##"{"nombre":"X","departamentos":[{"id":"d","nombre":"D","color":"#ffffff"}],"agentes":[{"id":"a","nombre":"A","rol":"r","departamento":"d"},{"id":"a","nombre":"B","rol":"r","departamento":"d"}]}"##)).status == 400)
        #expect((await llamar(b, "GET", "/api/oficinas")).obj["activa"] is NSNull)
        #expect((await llamar(b, "GET", "/api/oficina")).status == 409)
    }

    @Test("abrir: una oficina válida queda activa y se completan las carpetas que falten (sin pisar nada)")
    func abrirCompleta() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let dir = sb.root + "/mia"
        escribir(##"{"version":1,"nombre":"Mía","duenio":"Eva","departamentos":[{"id":"d","nombre":"D","color":"#ffffff"}],"agentes":[]}"##,
                 en: dir + "/oficina.json")
        escribir("catálogo propio", en: dir + "/conocimiento/archivos.md")
        let r = await llamar(b, "POST", "/api/oficinas/abrir", body: json(["carpeta": dir]))
        #expect(r.status == 200)
        #expect(r.obj["carpeta"] as? String == dir)
        #expect(dict(r.obj["oficina"])["nombre"] as? String == "Mía")
        for d in ["conocimiento/agentes", "conocimiento/fuentes", "reuniones", "archivos", ".claude/agents", "archivos/compartido",
                  "archivos/entregables", "archivos/.texto", "archivos/.papelera"] {
            #expect(existe(dir + "/" + d), "falta \(d)")
        }
        #expect(leerTexto(dir + "/conocimiento/archivos.md") == "catálogo propio")
        #expect((await llamar(b, "GET", "/api/oficina")).obj["carpeta"] as? String == dir)
        // con ~ del HOME temporal
        let tilde = await llamar(b, "POST", "/api/oficinas/abrir", body: json(["carpeta": "~/../mia"]))
        #expect(tilde.status == 200)
        #expect(str(tilde.obj["carpeta"]) == dir)
    }

    // MARK: recientes y persistencia

    @Test("recientes: la más reciente primero, solo una activa, salta las borradas, máximo 10")
    func recientes() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        var carpetas: [String] = []
        for i in 1...12 { carpetas.append(str((await nueva(b, ["nombre": "Of \(i)"])).obj["carpeta"])) }
        var l = await llamar(b, "GET", "/api/oficinas")
        var of = lista(l.obj["oficinas"])
        #expect(of.count == 10)
        #expect(of.map { str($0["nombre"]) } == (3...12).reversed().map { "Of \($0)" })
        #expect(of.filter { $0["activa"] as? Bool == true }.count == 1)
        #expect(of.first?["activa"] as? Bool == true)
        // abrir una vieja la sube al principio y la hace activa
        _ = await llamar(b, "POST", "/api/oficinas/abrir", body: json(["carpeta": carpetas[5]]))
        l = await llamar(b, "GET", "/api/oficinas")
        of = lista(l.obj["oficinas"])
        #expect(str(of.first?["nombre"]) == "Of 6")
        #expect(l.obj["activa"] as? String == carpetas[5])
        #expect(of.count == 10)
        // borrar la carpeta de una reciente: se saltea
        try FileManager.default.removeItem(atPath: carpetas[8])
        of = lista((await llamar(b, "GET", "/api/oficinas")).obj["oficinas"])
        #expect(of.count == 9)
        #expect(!of.map { str($0["carpeta"]) }.contains(carpetas[8]))
    }

    @Test("persistencia: la oficina activa y los recientes sobreviven a recrear el Backend")
    func persistencia() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let a = str((await nueva(b, ["nombre": "Uno"])).obj["carpeta"])
        let c = str((await nueva(b, ["nombre": "Dos"])).obj["carpeta"])
        let cfg = (try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: sb.datos + "/config.json")))) as? [String: Any] ?? [:]
        #expect(cfg["oficina_activa"] as? String == c)
        #expect(lista(cfg["oficinas_recientes"]).map { str($0["carpeta"]) } == [c, a])

        let b2 = try sb.backend(oficina: false)
        let g = await llamar(b2, "GET", "/api/oficina")
        #expect(g.status == 200)
        #expect(g.obj["carpeta"] as? String == c)
        let l = await llamar(b2, "GET", "/api/oficinas")
        #expect(lista(l.obj["oficinas"]).map { str($0["nombre"]) } == ["Dos", "Uno"])
        #expect(l.obj["activa"] as? String == c)
        let e = await llamar(b2, "GET", "/api/estado")
        #expect(dict(e.obj["oficina"])["nombre"] as? String == "Dos")
    }

    @Test("persistencia: otras claves de config.json se conservan; un config.json ilegible no se pisa")
    func persistenciaConfigJson() async throws {
        let sb = Sandbox()
        try FileManager.default.createDirectory(atPath: sb.datos, withIntermediateDirectories: true)
        escribir(##"{"otra_clave": 123}"##, en: sb.datos + "/config.json")
        let b = try sb.backend(oficina: false)
        _ = await nueva(b, ["nombre": "Uno"])
        let cfg = (try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: sb.datos + "/config.json")))) as? [String: Any] ?? [:]
        #expect(cfg["otra_clave"] as? Int == 123)
        #expect(cfg["oficina_activa"] is String)

        let sb2 = Sandbox()
        try FileManager.default.createDirectory(atPath: sb2.datos, withIntermediateDirectories: true)
        escribir("{ esto no es json", en: sb2.datos + "/config.json")
        let b2 = try sb2.backend(oficina: false)
        let r = await nueva(b2, ["nombre": "Uno"])
        #expect(r.status == 200)  // la oficina se crea igual
        #expect(leerTexto(sb2.datos + "/config.json") == "{ esto no es json")  // y el archivo ilegible queda como estaba
    }

    @Test("si la oficina activa pierde su oficina.json: 409 y /api/oficinas ya no la marca activa")
    func activaDesaparece() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let c = str((await nueva(b, ["nombre": "Uno"])).obj["carpeta"])
        try FileManager.default.removeItem(atPath: c + "/oficina.json")
        #expect((await llamar(b, "GET", "/api/oficina")).status == 409)
        let l = await llamar(b, "GET", "/api/oficinas")
        #expect(lista(l.obj["oficinas"]).isEmpty)
        #expect(l.obj["activa"] is NSNull)
        #expect((await llamar(b, "GET", "/api/estado")).obj["oficina"] is NSNull)
    }

    // MARK: PATCH /api/oficina

    @Test("PATCH oficina: nombre y dueño (se guardan en oficina.json, se recortan y actualizan los recientes)")
    func patchOficina() async throws {
        let f = try await Fix.crear(nombre: "Viejo", duenio: "Ana")
        let r = await f.patch("/api/oficina", ["nombre": "  Nuevo  ", "duenio": "Beto"])
        #expect(r.status == 200)
        #expect(dict(r.obj["oficina"])["nombre"] as? String == "Nuevo")
        #expect(dict(r.obj["oficina"])["duenio"] as? String == "Beto")
        #expect(f.oficinaJSON()["nombre"] as? String == "Nuevo")
        #expect(f.oficinaJSON()["duenio"] as? String == "Beto")
        #expect(r.obj["carpeta"] as? String == f.carpeta)
        #expect(lista((await f.get("/api/oficinas")).obj["oficinas"]).map { str($0["nombre"]) } == ["Nuevo"])
        // solo el dueño: el nombre no cambia
        _ = await f.patch("/api/oficina", ["duenio": "Cata"])
        #expect(f.oficinaJSON()["nombre"] as? String == "Nuevo")
        #expect(f.oficinaJSON()["duenio"] as? String == "Cata")
        // {} no cambia nada
        let vacio = await f.patch("/api/oficina", [:])
        #expect(vacio.status == 200)
        #expect(f.oficinaJSON()["nombre"] as? String == "Nuevo")
        // el resto de oficina.json (departamentos) sigue igual
        #expect((f.oficinaJSON()["departamentos"] as? [Any])?.count == 2)
    }

    @Test("PATCH oficina: validaciones")
    func patchOficinaValidacion() async throws {
        let f = try await Fix.crear()
        #expect((await f.patch("/api/oficina", ["nombre": 3])).status == 400)
        #expect((await f.patch("/api/oficina", ["nombre": String(repeating: "x", count: 81)])).status == 400)
        #expect((await f.patch("/api/oficina", ["duenio": String(repeating: "x", count: 81)])).status == 400)
        #expect((await f.patch("/api/oficina")).status == 400)
        #expect((await llamar(f.b, "PATCH", "/api/oficina", body: Data("[]".utf8))).status == 400)
        #expect(f.oficinaJSON()["nombre"] as? String == "Taller")
        #expect((await llamar(f.b, "DELETE", "/api/oficina")).status == 405)
    }

    // MARK: 409 sin oficina

    @Test("sin oficina abierta: las rutas que la exigen responden 409 «No hay una oficina abierta»")
    func sinOficina409() async throws {
        let sb = Sandbox()
        let b = try sb.backend(oficina: false)
        let u = U.a
        let casos: [(String, String, Any?)] = [
            ("GET", "/api/oficina", nil), ("PATCH", "/api/oficina", ["nombre": "X"]),
            ("POST", "/api/departamentos", ["nombre": "X"]), ("PATCH", "/api/departamentos/x", ["nombre": "X"]),
            ("DELETE", "/api/departamentos/x", nil),
            ("GET", "/api/agentes", nil),
            ("POST", "/api/agentes", ["nombre": "N", "rol": "r", "prompt": "p", "departamento": "d"]),
            ("POST", "/api/agentes/borrador", ["descripcion": "algo", "departamento": "d"]),
            ("GET", "/api/agentes/x", nil), ("PATCH", "/api/agentes/x", ["nombre": "X"]), ("DELETE", "/api/agentes/x", nil),
            ("GET", "/api/agentes/x/conocimiento", nil),
            ("POST", "/api/chat", ["agent": "x", "message": "hola", "session": u]),
            ("GET", "/api/historial?agent=x", nil),
            ("GET", "/api/reuniones", nil), ("POST", "/api/reuniones", ["tema": "t", "agentes": ["x"]]),
            ("GET", "/api/reuniones/\(u)", nil), ("POST", "/api/reuniones/\(u)/cerrar", nil),
            ("GET", "/api/archivos", nil), ("POST", "/api/archivos", ["nombre": "a.txt", "base64": "aG9sYQ=="]),
            ("GET", "/api/vinculos", nil), ("POST", "/api/vinculos", ["ruta": "/tmp"]),
            ("GET", "/api/biblioteca/estado", nil), ("GET", "/api/biblioteca/config", nil),
            ("GET", "/api/biblioteca/propuestas", nil),
        ]
        for (m, p, body) in casos {
            var q: [String: String] = [:]
            var path = p
            if let i = p.firstIndex(of: "?") {
                path = String(p[..<i])
                q = Dictionary(uniqueKeysWithValues: p[p.index(after: i)...].split(separator: "&").map { kv -> (String, String) in
                    let x = kv.split(separator: "="); return (String(x[0]), String(x[1]))
                })
            }
            let r = await llamar(b, m, path, query: q, body: body.map(json))
            #expect(r.status == 409, "\(m) \(p) -> \(r.status) \(r.obj)")
            #expect(r.obj["error"] as? String == "No hay una oficina abierta", "\(m) \(p)")
        }
        // /api/estado y /api/oficinas funcionan sin oficina
        #expect((await llamar(b, "GET", "/api/estado")).status == 200)
        let l = await llamar(b, "GET", "/api/oficinas")
        #expect(l.status == 200)
        #expect((l.obj["oficinas"] as? [Any])?.isEmpty == true)
        // y no se lanzó ningún claude
        #expect(sb.llamadas.isEmpty)
    }

    @Test("rutas desconocidas -> 404; método no permitido -> 405")
    func rutasYMetodos() async throws {
        let f = try await Fix.crear()
        #expect((await f.get("/api/nada")).status == 404)
        #expect((await f.get("/api/oficinas/otra")).status == 404)
        #expect((await f.get("/api/agentes/Mal_Id")).status == 404)
        #expect((await f.get("/api/departamentos/Mal_Id")).status == 404)
        #expect((await llamar(f.b, "PUT", "/api/oficinas")).status == 405)
        #expect((await llamar(f.b, "GET", "/api/departamentos")).status == 405)
        #expect((await llamar(f.b, "DELETE", "/api/agentes")).status == 405)
        #expect((await llamar(f.b, "POST", "/api/oficinas/abrir/x")).status == 404)
    }

    // MARK: departamentos

    @Test("departamentos: crear (id desde el nombre, color de la paleta, ids únicos, id explícito, color en minúsculas)")
    func departamentoCrear() async throws {
        let f = try await Fix.crear(deps: ["Dirección"])
        let r = await f.post("/api/departamentos", ["nombre": "Compras y Ventas"])
        #expect(r.status == 200)
        #expect(Set(r.obj.keys) == ["departamento", "oficina"])
        let d = dict(r.obj["departamento"])
        #expect(d["id"] as? String == "compras-y-ventas")
        #expect(d["nombre"] as? String == "Compras y Ventas")
        #expect(d["color"] as? String == "#a88bd6")  // índice 1 de la paleta
        #expect(lista(dict(r.obj["oficina"])["departamentos"]).count == 2)
        // mismo nombre: id con -2
        let dup = await f.post("/api/departamentos", ["nombre": "Compras y Ventas"])
        #expect(dict(dup.obj["departamento"])["id"] as? String == "compras-y-ventas-2")
        // acentos y mayúsculas
        #expect(dict((await f.post("/api/departamentos", ["nombre": "GESTIÓN Ñandú"])).obj["departamento"])["id"] as? String == "gestion-nandu")
        // nombre sin letras: id de respaldo
        #expect(dict((await f.post("/api/departamentos", ["nombre": "★★★"])).obj["departamento"])["id"] as? String == "depto")
        // id y color explícitos
        let ex = await f.post("/api/departamentos", ["nombre": "Arte", "id": "arte", "color": "#ABC123"])
        #expect(dict(ex.obj["departamento"])["id"] as? String == "arte")
        #expect(dict(ex.obj["departamento"])["color"] as? String == "#abc123")
        // persistido
        let ids = lista(f.oficinaJSON()["departamentos"]).map { str($0["id"]) }
        #expect(ids == ["direccion", "compras-y-ventas", "compras-y-ventas-2", "gestion-nandu", "depto", "arte"])
    }

    @Test("departamentos: validaciones al crear (nombre, id, color, duplicado 409, máximo 12)")
    func departamentoCrearValidacion() async throws {
        let f = try await Fix.crear(deps: ["Uno"])
        #expect((await f.post("/api/departamentos", [:])).status == 400)
        #expect((await f.post("/api/departamentos", ["nombre": " "])).status == 400)
        #expect((await f.post("/api/departamentos", ["nombre": String(repeating: "n", count: 61)])).status == 400)
        #expect((await f.post("/api/departamentos", ["nombre": "A", "color": "rojo"])).status == 400)
        #expect((await f.post("/api/departamentos", ["nombre": "A", "color": "#fff"])).status == 400)
        #expect((await f.post("/api/departamentos", ["nombre": "A", "id": "Mal Id"])).status == 400)
        #expect((await f.post("/api/departamentos", ["nombre": "A", "id": "uno"])).status == 409)
        #expect((await f.post("/api/departamentos")).status == 400)
        #expect(lista(f.oficinaJSON()["departamentos"]).count == 1)
        for i in 2...12 { #expect((await f.post("/api/departamentos", ["nombre": "D\(i)"])).status == 200) }
        let trece = await f.post("/api/departamentos", ["nombre": "D13"])
        #expect(trece.status == 400)
        #expect(str(trece.obj["error"]).contains("12"))
        #expect(lista(f.oficinaJSON()["departamentos"]).count == 12)
    }

    @Test("departamentos: PATCH nombre y color; el id no cambia; 404 y validaciones")
    func departamentoPatch() async throws {
        let f = try await Fix.crear(deps: ["Redes", "Ads"])
        let r = await f.patch("/api/departamentos/redes", ["nombre": "  Redes sociales ", "color": "#AABBCC"])
        #expect(r.status == 200)
        let d = dict(r.obj["departamento"])
        #expect(d["id"] as? String == "redes")
        #expect(d["nombre"] as? String == "Redes sociales")
        #expect(d["color"] as? String == "#aabbcc")
        #expect(lista(f.oficinaJSON()["departamentos"]).map { str($0["nombre"]) } == ["Redes sociales", "Ads"])
        // solo color
        let c = await f.patch("/api/departamentos/ads", ["color": "#112233"])
        #expect(dict(c.obj["departamento"])["nombre"] as? String == "Ads")
        // errores
        #expect((await f.patch("/api/departamentos/nada", ["nombre": "X"])).status == 404)
        #expect((await f.patch("/api/departamentos/Mal_Id", ["nombre": "X"])).status == 404)
        #expect((await f.patch("/api/departamentos/redes", ["nombre": String(repeating: "n", count: 61)])).status == 400)
        #expect((await f.patch("/api/departamentos/redes", ["color": "azul"])).status == 400)
        #expect((await f.patch("/api/departamentos/redes", ["nombre": 4])).status == 400)
        #expect((await f.patch("/api/departamentos/redes")).status == 400)
        // {} no cambia
        #expect((await f.patch("/api/departamentos/redes", [:])).status == 200)
        #expect(lista(f.oficinaJSON()["departamentos"]).map { str($0["nombre"]) } == ["Redes sociales", "Ads"])
    }

    @Test("departamentos: borrar uno sin agentes")
    func departamentoBorrar() async throws {
        let f = try await Fix.crear(deps: ["Uno", "Dos", "Tres"])
        let r = await f.delete("/api/departamentos/dos")
        #expect(r.status == 200)
        #expect(r.obj["ok"] as? Bool == true)
        #expect(lista(dict(r.obj["oficina"])["departamentos"]).map { str($0["id"]) } == ["uno", "tres"])
        #expect(lista(f.oficinaJSON()["departamentos"]).map { str($0["id"]) } == ["uno", "tres"])
        #expect((await f.delete("/api/departamentos/dos")).status == 404)
        #expect((await f.delete("/api/departamentos/Mal_Id")).status == 404)
        // el borrado no toca archivos/<depto> (nada se borra)
        #expect(f.existe("archivos/dos"))
    }

    @Test("departamentos: borrar con agentes exige moverA (cuerpo o query); destino inválido 400; los agentes se mueven")
    func departamentoBorrarConAgentes() async throws {
        let f = try await Fix.crear(deps: ["Uno", "Dos", "Tres"],
                                    agentes: [("a", "dos", nil), ("b", "dos", nil), ("c", "uno", nil)])
        let sin = await f.delete("/api/departamentos/dos")
        #expect(sin.status == 409)
        #expect(str(sin.obj["error"]).contains("2 agente(s)"))
        #expect((await f.delete("/api/departamentos/dos", ["moverA": ""])).status == 409)
        #expect((await f.delete("/api/departamentos/dos", ["moverA": "inexistente"])).status == 400)
        #expect((await f.delete("/api/departamentos/dos", ["moverA": "dos"])).status == 400)
        #expect(lista(f.oficinaJSON()["departamentos"]).count == 3)  // nada cambió
        let ok = await f.delete("/api/departamentos/dos", ["moverA": "tres"])
        #expect(ok.status == 200)
        let ags = lista(f.oficinaJSON()["agentes"])
        #expect(ags.first { str($0["id"]) == "a" }?["departamento"] as? String == "tres")
        #expect(ags.first { str($0["id"]) == "b" }?["departamento"] as? String == "tres")
        #expect(ags.first { str($0["id"]) == "c" }?["departamento"] as? String == "uno")
        #expect(lista(dict(ok.obj["oficina"])["agentes"]).count == 3)
        // moverA por query
        let q = await f.delete("/api/departamentos/uno", query: ["moverA": "tres"])
        #expect(q.status == 200)
        #expect(lista(f.oficinaJSON()["agentes"]).allSatisfy { str($0["departamento"]) == "tres" })
        // los .md de los agentes no se tocaron
        #expect(f.existe(".claude/agents/a.md") && f.existe(".claude/agents/b.md") && f.existe(".claude/agents/c.md"))
    }

    @Test("departamentos: no se puede borrar el último (409), ni siquiera con moverA")
    func departamentoUltimo() async throws {
        let f = try await Fix.crear(deps: ["Solo"], agentes: [("a", "solo", nil)])
        let r = await f.delete("/api/departamentos/solo")
        #expect(r.status == 409)
        #expect(str(r.obj["error"]).contains("al menos un departamento"))
        #expect((await f.delete("/api/departamentos/solo", ["moverA": "solo"])).status == 409)
        #expect(lista(f.oficinaJSON()["departamentos"]).count == 1)
        // cuerpo que no es un objeto JSON
        #expect((await llamar(f.b, "DELETE", "/api/departamentos/solo", body: Data("[1]".utf8))).status == 400)
    }
}
}  // extension Etapa2
