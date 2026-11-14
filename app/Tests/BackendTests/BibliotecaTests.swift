import Foundation
import CryptoKit
import Testing
@testable import Backend

/// Biblioteca: subida, extracción, ficha del bibliotecario, catálogo, búsqueda, lectura por rol, propuestas, vínculos y papelera.
extension Etapa2 {
@Suite("Biblioteca")
struct BibliotecaTests {
    static let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!
    static let hayCups = FileManager.default.isExecutableFile(atPath: "/usr/sbin/cupsfilter")
    static let hayTextutil = FileManager.default.isExecutableFile(atPath: "/usr/bin/textutil")

    func bib(env: [String: String] = [:], agentes: [Fix.Ag]? = nil) async throws -> Fix {
        try await Fix.crear(nombre: "Taller", duenio: "Ana", deps: ["Dirección", "Redes"],
                            agentes: agentes ?? [("betty", "direccion", nil), ("marce", "redes", nil)], env: env)
    }

    func sha(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

    func subir(_ f: Fix, _ nombre: String, _ data: Data, depto: String? = nil, leer: Bool? = nil) async -> Resp {
        var d: [String: Any] = ["nombre": nombre, "base64": data.base64EncodedString()]
        if let depto { d["departamento"] = depto }
        if let leer { d["leer"] = leer }
        return await f.post("/api/archivos", d)
    }

    func subirTexto(_ f: Fix, _ nombre: String, _ texto: String, depto: String? = nil, leer: Bool? = nil) async -> Resp {
        await subir(f, nombre, Data(texto.utf8), depto: depto, leer: leer)
    }

    func archivo(_ r: Resp) -> [String: Any] { dict(r.obj["archivo"]) }

    /// Espera a que el archivo llegue a uno de esos estados y devuelve su ficha de API.
    @discardableResult
    func aguardar(_ f: Fix, _ slug: String, _ estados: Set<String> = ["listo", "error"], hasta: Double = 15) async -> [String: Any] {
        var ult: [String: Any] = [:]
        _ = await esperarAsync(hasta: hasta) {
            ult = dict((await f.get("/api/archivos/\(slug)")).obj["archivo"])
            return estados.contains(str(ult["estado"]))
        }
        return ult
    }

    /// Sube un texto y espera a que quede listo.
    @discardableResult
    func subirYEsperar(_ f: Fix, _ nombre: String, _ texto: String, depto: String? = nil) async -> [String: Any] {
        let r = await subirTexto(f, nombre, texto, depto: depto)
        return await aguardar(f, str(archivo(r)["slug"]))
    }

    /// Espera a que no quede nada en la cola (para no dejar un claude corriendo al terminar el test).
    func reposo(_ f: Fix) async {
        _ = await esperarAsync(hasta: 15) { (await f.get("/api/biblioteca/estado")).obj["pendientes"] as? Int == 0 }
    }

    func buscar(_ f: Fix, _ q: String, _ extra: [String: String] = [:]) async -> [String] {
        var query = ["q": q]
        for (k, v) in extra { query[k] = v }
        return lista((await f.get("/api/archivos", query)).obj["archivos"]).map { str($0["slug"]) }
    }

    func fichas(_ f: Fix) -> [[String]] { f.sb.llamadas(conPrompt: "Sos el bibliotecario") }

    func fichaJSON(_ c: [String: Any]) -> String {
        var d: [String: Any] = ["titulo": "Tarifario", "resumen": "Precios del taller.", "datos_clave": ["150 dólares"], "temas": ["finanzas"],
                                "util_para": ["direccion"], "fechas": [String](), "contradicciones": [Any]()]
        for (k, v) in c { d[k] = v }
        return String(data: json(d), encoding: .utf8) ?? "{}"
    }

    func convertir(_ f: Fix, _ texto: String, _ formato: String) throws -> Data {
        let src = f.sb.root + "/conv-\(UUID().uuidString.prefix(6)).txt"
        let dst = src.replacingOccurrences(of: ".txt", with: "." + formato)
        escribir(texto, en: src)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/textutil")
        p.arguments = ["-convert", formato, src, "-output", dst]
        try p.run(); p.waitUntilExit()
        return try Data(contentsOf: URL(fileURLWithPath: dst))
    }

    // MARK: subir y fichar

    @Test("subir un .txt: se guarda, se extrae el texto, el bibliotecario lo ficha y queda en el catálogo")
    func subirTxt() async throws {
        let f = try await bib()
        let texto = "Lista de precios 2026. El taller cuesta 150 dolares. Pedido minimo 12 unidades."
        let data = Data(texto.utf8)
        let r = await subir(f, "precios.txt", data)
        #expect(r.status == 200)
        let a = archivo(r)
        #expect(a["slug"] as? String == "precios")
        #expect(a["nombre"] as? String == "precios.txt")
        #expect(a["departamento"] as? String == "compartido")
        #expect(a["tipo"] as? String == "txt")
        #expect(a["tam"] as? Int == data.count)
        #expect(a["hash"] as? String == sha(data))
        #expect(a["origen"] as? String == "subido")
        #expect(a["ruta"] as? String == "archivos/compartido/precios.txt")
        #expect(a["estado"] as? String == "pendiente")
        #expect(a["fichaRuta"] as? String == "conocimiento/fuentes/precios.md")
        #expect(a["textoRuta"] as? String == "archivos/.texto/precios.md")
        #expect(r.obj["duplicado"] == nil)
        #expect((try Data(contentsOf: URL(fileURLWithPath: f.ruta("archivos/compartido/precios.txt")))) == data)

        let fin = await aguardar(f, "precios")
        #expect(fin["estado"] as? String == "listo")
        #expect(fin["error"] == nil)
        #expect(f.leer("archivos/.texto/precios.md") == texto)
        let ficha = dict(fin["ficha"])
        #expect(ficha["titulo"] as? String == "Ficha de prueba")
        #expect(ficha["resumen"] as? String == "Resumen de prueba del documento.")
        #expect(ficha["util_para"] as? [String] == ["direccion"])
        #expect(fin["titulo"] as? String == "Ficha de prueba")
        let md = f.leer("conocimiento/fuentes/precios.md")
        #expect(md.hasPrefix("# Ficha de prueba\n"))
        #expect(md.contains("- **Archivo:** precios.txt"))
        #expect(md.contains("- **Tipo:** txt · \(data.count) B"))
        #expect(md.contains("- **Carpeta:** Compartido"))
        #expect(md.contains("- **Ubicación del original:** archivos/compartido/precios.txt"))
        #expect(md.contains("- **Texto completo:** archivos/.texto/precios.md"))
        #expect(md.contains("- **Identificador:** precios (sha256 \(sha(data).prefix(12)))"))
        #expect(md.contains("- **Útil para:** Dirección"))
        #expect(md.contains("## Resumen\n\nResumen de prueba del documento."))
        #expect(md.contains("## Datos clave\n\n- dato uno"))
        #expect(md.contains("## Temas\n\npruebas"))
        let cat = f.leer("conocimiento/archivos.md")
        #expect(cat.contains("- **Ficha de prueba** (`precios`, Compartido, txt): Resumen de prueba del documento. → `conocimiento/fuentes/precios.md`"))
        #expect(!cat.contains("(Todavía no hay documentos.)"))
        // detalle
        let d = await f.get("/api/archivos/precios")
        #expect(d.status == 200)
        #expect(d.obj["texto"] as? String == texto)
        #expect(dict(d.obj["archivo"])["rutaAbsoluta"] as? String == f.carpeta + "/archivos/compartido/precios.txt")
        // y un listado
        #expect(lista((await f.get("/api/archivos")).obj["archivos"]).map { str($0["slug"]) } == ["precios"])
    }

    @Test("detalle: el texto se corta a 4000 caracteres con puntos suspensivos; el archivo de texto guarda todo")
    func detalleTextoLargo() async throws {
        let f = try await bib()
        let largo = String(repeating: "abcdefghij", count: 500)   // 5000
        await subirYEsperar(f, "largo.txt", largo)
        let d = await f.get("/api/archivos/largo")
        #expect(d.obj["texto"] as? String == String(largo.prefix(4000)) + "…")
        #expect(f.leer("archivos/.texto/largo.md") == largo)
    }

    @Test("la ficha se pide a claude SIN agente y SIN herramientas, con cwd en la oficina y el contexto en el prompt")
    func fichaLlamada() async throws {
        let f = try await bib()
        escribir("# Taller\nMEMORIA_Z: precios en dólares", en: f.ruta("conocimiento/oficina.md"))
        escribir("- 2026-01-01: DECISION_Y", en: f.ruta("conocimiento/decisiones.md"))
        await subirYEsperar(f, "precios.txt", "TEXTO_DEL_DOCUMENTO uno dos tres", depto: "redes")
        let ll = fichas(f)
        #expect(ll.count == 1)
        let l = try #require(ll.first)
        #expect(!l.contains("--agent"))
        #expect(Sandbox.valor(l, "--tools") == "")
        #expect(sinPrivate(try #require(f.sb.cwds[f.sb.llamadas.firstIndex(where: { $0 == l })!])) == sinPrivate(f.carpeta))
        let p = try #require(l.last)
        #expect(p.contains("Sos el bibliotecario de la oficina «Taller»"))
        #expect(p.contains("Documento: precios.txt (tipo: txt; carpeta: Redes)"))
        #expect(p.contains("- direccion: Dirección\n- redes: Redes"))
        #expect(p.contains("MEMORIA_Z: precios en dólares"))
        #expect(p.contains("DECISION_Y"))
        #expect(p.contains("<<<\nTEXTO_DEL_DOCUMENTO uno dos tres\n>>>"))
    }

    @Test("el texto que va al prompt de la ficha se recorta a 12000 caracteres (el completo queda en archivos/.texto)")
    func fichaTextoRecortado() async throws {
        let f = try await bib()
        let texto = String(repeating: "x", count: 12_000) + "FUERA_DEL_PROMPT"
        await subirYEsperar(f, "largo.txt", texto)
        let p = try #require(fichas(f).first?.last)
        #expect(p.contains(String(repeating: "x", count: 12_000)))
        #expect(!p.contains("FUERA_DEL_PROMPT"))
        #expect(f.leer("archivos/.texto/largo.md") == texto)
    }

    @Test("PDF: el texto sale con PDFKit",
          .enabled(if: BibliotecaTests.hayCups, "hace falta cupsfilter para generar el PDF"))
    func subirPDF() async throws {
        let f = try await bib()
        escribir("Pedido minimo 12 unidades\nEntrega en 5 dias habiles\n", en: f.sb.root + "/origen.txt")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/cupsfilter")
        p.arguments = ["-i", "text/plain", "-m", "application/pdf", f.sb.root + "/origen.txt"]
        let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
        try p.run()
        let pdf = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        try #require(pdf.starts(with: Data("%PDF".utf8)), "cupsfilter no generó un PDF")
        let r = await subir(f, "condiciones.pdf", pdf)
        #expect(r.status == 200)
        #expect(archivo(r)["tipo"] as? String == "pdf")
        let fin = await aguardar(f, "condiciones")
        #expect(fin["estado"] as? String == "listo")
        let texto = f.leer("archivos/.texto/condiciones.md")
        #expect(texto.contains("Pedido minimo 12 unidades"), "texto extraído: \(texto)")
        #expect(texto.contains("Entrega en 5 dias habiles"))
        #expect(try #require(fichas(f).first?.last).contains("Pedido minimo 12 unidades"))
        #expect(await buscar(f, "unidades") == ["condiciones"])
    }

    @Test("PDF roto: queda en error con aviso, sin ficha, pero buscable por su nombre")
    func pdfRoto() async throws {
        let f = try await bib()
        let r = await subir(f, "roto.pdf", Data("%PDF-1.4\nesto no es un pdf de verdad".utf8))
        #expect(r.status == 200)
        let fin = await aguardar(f, "roto")
        #expect(fin["estado"] as? String == "error")
        #expect(fin["aviso"] as? String == "No pude abrir el PDF.")
        #expect(fin["error"] as? String == "No pude abrir el PDF.")
        #expect(fin["ficha"] == nil)
        #expect(!f.existe("conocimiento/fuentes/roto.md"))
        #expect(fichas(f).isEmpty)
        #expect(f.leer("conocimiento/archivos.md").contains("- **roto.pdf** (`roto`, Compartido, pdf): todavía sin ficha (no se pudo fichar)"))
        #expect(await buscar(f, "roto") == ["roto"])
    }

    @Test(".docx y .rtf: textutil extrae el texto",
          .enabled(if: BibliotecaTests.hayTextutil, "hace falta textutil"))
    func subirDocumentos() async throws {
        let f = try await bib()
        let texto = "Contrato de servicio. Duracion: 12 meses. Precio mensual: 90 dolares."
        let docx = try convertir(f, texto, "docx")
        let rtf = try convertir(f, texto, "rtf")
        for (nombre, data) in [("contrato.docx", docx), ("acuerdo.rtf", rtf)] {
            let r = await subir(f, nombre, data)
            #expect(r.status == 200, "\(nombre): \(r.obj)")
            let slug = str(archivo(r)["slug"])
            let fin = await aguardar(f, slug)
            #expect(fin["estado"] as? String == "listo", "\(nombre): \(fin)")
            #expect(f.leer("archivos/.texto/\(slug).md").contains("Duracion: 12 meses"), "\(nombre)")
        }
        #expect(Set(await buscar(f, "dolares")) == ["contrato", "acuerdo"])
    }

    @Test(".docx que no se puede leer: error con aviso")
    func docxRoto() async throws {
        let f = try await bib()
        _ = await subir(f, "malo.docx", Data("PK\u{03}\u{04}garbagegarbagegarbage".utf8))
        let fin = await aguardar(f, "malo")
        #expect(fin["estado"] as? String == "error")
        #expect(!str(fin["aviso"]).isEmpty)
        #expect(!f.existe("conocimiento/fuentes/malo.md"))
    }

    @Test("imagen .png: claude -p sin agente con Read la describe; la descripción es su texto y se ficha")
    func subirPNG() async throws {
        let f = try await bib()
        let r = await subir(f, "foto.png", Self.png)
        #expect(r.status == 200)
        #expect(archivo(r)["tipo"] as? String == "png")
        let fin = await aguardar(f, "foto")
        #expect(fin["estado"] as? String == "listo")
        let desc = f.sb.llamadas(conPrompt: "Describí la imagen")
        #expect(desc.count == 1)
        let l = try #require(desc.first)
        #expect(!l.contains("--agent"))
        #expect(Sandbox.valor(l, "--tools") == "Read")
        #expect(Sandbox.valores(l, "--add-dir") == [f.carpeta + "/archivos/compartido"])
        #expect(try #require(l.last).contains(f.carpeta + "/archivos/compartido/foto.png"))
        #expect(f.leer("archivos/.texto/foto.md") == "Una imagen de prueba con el texto HOLA MUNDO.")
        #expect(try #require(fichas(f).first?.last).contains("HOLA MUNDO"))
        #expect(await buscar(f, "hola") == ["foto"])
        // el original se puede bajar tal cual
        let o = await f.get("/api/archivos/foto/original")
        #expect(o.status == 200)
        #expect(o.obj["mime"] as? String == "image/png")
        #expect(o.obj["nombre"] as? String == "foto.png")
        #expect(o.obj["tam"] as? Int == Self.png.count)
        #expect(o.obj["base64"] as? String == Self.png.base64EncodedString())
        #expect(o.obj["ruta"] as? String == f.carpeta + "/archivos/compartido/foto.png")
    }

    @Test("imagen: si claude no puede describirla, queda en error con aviso y sin ficha")
    func imagenSinDescripcion() async throws {
        let f = try await bib()
        f.sb.modo("imagen", "error")
        _ = await subir(f, "foto.png", Self.png)
        let fin = await aguardar(f, "foto")
        #expect(fin["estado"] as? String == "error")
        #expect(str(fin["aviso"]).hasPrefix("No pude describir la imagen:"))
        #expect(fichas(f).isEmpty)
        #expect(!f.existe("archivos/.texto/foto.md"))
        // descripción vacía
        f.sb.modo("imagen", "vacio")
        _ = await subir(f, "otra.png", Self.png + Data([0]))
        let v = await aguardar(f, "otra")
        #expect(v["estado"] as? String == "error")
        #expect(v["aviso"] as? String == "Claude no devolvió una descripción de la imagen.")
    }

    // MARK: sanitización, tipos y tamaños

    @Test("el nombre se sanea: sin rutas, «..», caracteres de control ni «:»; no se escribe nada fuera de la oficina")
    func sanitizacion() async throws {
        let f = try await bib()
        let casos: [(String, String)] = [
            ("../../etc/pass:wd*.txt", "pass-wd-.txt"),
            ("..\\..\\windows\\x.txt", "x.txt"),
            (".hidden.txt", "hidden.txt"),
            ("con\u{07}control.txt", "con-control.txt"),
            ("a..b.txt", "a.b.txt"),
            ("  espacios  .txt", "espacios  .txt"),
            ("pregunta?.txt", "pregunta-.txt"),
            (String(repeating: "n", count: 130) + ".txt", String(repeating: "n", count: 116) + ".txt"),
            ("MAYUS.TXT", "MAYUS.TXT"),
        ]
        for (crudo, esperado) in casos {
            let r = await subirTexto(f, crudo, "contenido de \(crudo.hashValue)")
            #expect(r.status == 200, "\(crudo) -> \(r.obj)")
            let a = archivo(r)
            #expect(a["nombre"] as? String == esperado, "\(crudo) -> \(String(describing: a["nombre"]))")
            #expect(f.existe("archivos/compartido/\(esperado)"), "\(crudo)")
            #expect(a["ruta"] as? String == "archivos/compartido/\(esperado)")
        }
        #expect((archivo(await subirTexto(f, "MAYUS2.TXT", "x"))["tipo"] as? String) == "txt")
        // nada afuera: la carpeta de oficinas solo tiene la oficina, y la oficina no tiene carpetas nuevas por los «..»
        #expect(listar(f.sb.oficinasDir) == ["Taller"])
        #expect(!existe(f.sb.oficinasDir + "/Taller/etc") && !existe(f.sb.oficinasDir + "/etc") && !existe(f.sb.root + "/etc"))
        #expect(!existe(f.carpeta + "/archivos/etc"))
        await reposo(f)
    }

    @Test("subida: tipos no soportados, sin extensión, nombre o contenido inválidos -> 400")
    func subidaInvalida() async throws {
        let f = try await bib()
        func malo(_ d: [String: Any], _ contiene: String? = nil) async {
            let r = await f.post("/api/archivos", d)
            #expect(r.status == 400, "\(d) -> \(r.status) \(r.obj)")
            if let c = contiene { #expect(str(r.obj["error"]).contains(c), "\(d) -> \(r.obj)") }
        }
        let b = Data("hola".utf8).base64EncodedString()
        await malo(["nombre": "virus.exe", "base64": b], ".exe")
        await malo(["nombre": "sinextension", "base64": b], "sin extensión")
        await malo(["nombre": ".txt", "base64": b])
        await malo(["base64": b], "nombre")
        await malo(["nombre": "  ", "base64": b])
        await malo(["nombre": 5, "base64": b])
        await malo(["nombre": String(repeating: "n", count: 256) + ".txt", "base64": b])
        await malo(["nombre": "a.txt"], "base64")
        await malo(["nombre": "a.txt", "base64": ""], "base64")
        await malo(["nombre": "a.txt", "base64": "%%%%"], "base64")
        await malo(["nombre": "a.txt", "base64": b, "departamento": "inexistente"], "no existe")
        #expect((await f.post("/api/archivos")).status == 400)
        // la lista de tipos soportados está en el mensaje
        let r = await f.post("/api/archivos", ["nombre": "x.zip", "base64": b])
        #expect(str(r.obj["error"]).contains(".pdf") && str(r.obj["error"]).contains(".docx") && str(r.obj["error"]).contains(".png"))
        #expect(listar(f.carpeta + "/archivos/compartido").isEmpty)
        #expect(lista((await f.get("/api/archivos")).obj["archivos"]).isEmpty)
        // data: URL y departamento válido
        let ok = await f.post("/api/archivos", ["nombre": "ok.txt", "base64": "data:text/plain;base64," + b, "departamento": "redes"])
        #expect(ok.status == 200)
        #expect(archivo(ok)["departamento"] as? String == "redes")
        #expect(archivo(ok)["ruta"] as? String == "archivos/redes/ok.txt")
        #expect(f.leer("archivos/redes/ok.txt") == "hola")
        let compartido = await f.post("/api/archivos", ["nombre": "ok2.txt", "base64": b, "departamento": "compartido"])
        #expect(archivo(compartido)["departamento"] as? String == "compartido")
        await aguardar(f, "ok"); await aguardar(f, "ok2")
    }

    @Test("tamaño máximo: 413 por encima de maxMB (config de la oficina o HQ_BIBLIOTECA_MAX_MB) y nada se escribe")
    func tamanioMaximo() async throws {
        let f = try await bib()
        let cfg = await f.patch("/api/biblioteca/config", ["maxMB": 1])
        #expect(cfg.status == 200)
        #expect(cfg.obj["maxMB"] as? Int == 1)
        let uno = 1_048_576
        let justo = await subir(f, "justo.txt", Data(repeating: 0x61, count: uno + 1))
        #expect(justo.status == 413)
        #expect(str(justo.obj["error"]).contains("1 MB"))
        let enorme = await subir(f, "enorme.txt", Data(repeating: 0x61, count: 3 * uno))
        #expect(enorme.status == 413)
        #expect(listar(f.carpeta + "/archivos/compartido").isEmpty)
        #expect(lista((await f.get("/api/archivos")).obj["archivos"]).isEmpty)
        // en el límite exacto pasa
        let ok = await subir(f, "limite.txt", Data(repeating: 0x61, count: uno))
        #expect(ok.status == 200)
        await aguardar(f, "limite")
        // la variable de entorno rige cuando la oficina no define nada
        let g = try await bib(env: ["HQ_BIBLIOTECA_MAX_MB": "1"])
        #expect((await g.get("/api/biblioteca/config")).obj["maxMB"] as? Int == 1)
        #expect((await subir(g, "justo.txt", Data(repeating: 0x61, count: uno + 1))).status == 413)
        // y lo de la oficina pisa al entorno
        _ = await g.patch("/api/biblioteca/config", ["maxMB": 2])
        #expect((await subir(g, "justo.txt", Data(repeating: 0x61, count: uno + 1))).status == 200)
        await aguardar(g, "justo")
    }

    // MARK: duplicados y reemplazos

    @Test("duplicado: mismo contenido en la misma carpeta no se vuelve a procesar; en otra carpeta es otro archivo")
    func duplicado() async throws {
        let f = try await bib()
        await subirYEsperar(f, "precios.txt", "contenido uno")
        #expect(fichas(f).count == 1)
        let d1 = await subirTexto(f, "precios.txt", "contenido uno")
        #expect(d1.status == 200)
        #expect(d1.obj["duplicado"] as? Bool == true)
        #expect(archivo(d1)["slug"] as? String == "precios")
        #expect(archivo(d1)["duplicado"] as? Bool == true)
        // mismo contenido con otro nombre, misma carpeta: también es el mismo
        let d2 = await subirTexto(f, "copia.txt", "contenido uno")
        #expect(d2.obj["duplicado"] as? Bool == true)
        #expect(archivo(d2)["slug"] as? String == "precios")
        #expect(!f.existe("archivos/compartido/copia.txt"))
        #expect(lista((await f.get("/api/archivos")).obj["archivos"]).count == 1)
        // otra carpeta: archivo nuevo con slug distinto
        let otra = await subirTexto(f, "precios.txt", "contenido uno", depto: "redes")
        #expect(otra.obj["duplicado"] == nil)
        #expect(archivo(otra)["slug"] as? String == "precios-2")
        #expect(archivo(otra)["ruta"] as? String == "archivos/redes/precios.txt")
        await aguardar(f, "precios-2")
        #expect(fichas(f).count == 2)
    }

    @Test("mismo nombre con otro contenido en la misma carpeta: se reemplaza y se vuelve a procesar (reindexa por hash)")
    func reemplazo() async throws {
        let f = try await bib()
        let v1 = await subirYEsperar(f, "precios.txt", "version vieja con palabra_vieja")
        let h1 = str(v1["hash"])
        let r = await subirTexto(f, "precios.txt", "version nueva con palabra_nueva")
        #expect(r.status == 200)
        #expect(r.obj["reemplazado"] as? Bool == true)
        let a = archivo(r)
        #expect(a["slug"] as? String == "precios")
        #expect(a["estado"] as? String == "pendiente")
        #expect(a["hash"] as? String != h1)
        #expect(a["hash"] as? String == sha(Data("version nueva con palabra_nueva".utf8)))
        let fin = await aguardar(f, "precios")
        #expect(fin["estado"] as? String == "listo")
        #expect(f.leer("archivos/compartido/precios.txt") == "version nueva con palabra_nueva")
        #expect(f.leer("archivos/.texto/precios.md") == "version nueva con palabra_nueva")
        #expect(fichas(f).count == 2)
        #expect(await buscar(f, "palabra_nueva") == ["precios"])
        #expect(await buscar(f, "palabra_vieja").isEmpty)
        #expect(lista((await f.get("/api/archivos")).obj["archivos"]).count == 1)
        #expect(f.leer("conocimiento/fuentes/precios.md").contains("sha256 \(String(sha(Data("version nueva con palabra_nueva".utf8)).prefix(12)))"))
    }

    @Test("slugs: dos archivos con el mismo nombre base y distinta extensión no se pisan")
    func slugsUnicos() async throws {
        let f = try await bib()
        let a = await subirTexto(f, "notas.txt", "uno")
        let b = await subirTexto(f, "notas.md", "dos")
        #expect(archivo(a)["slug"] as? String == "notas")
        #expect(archivo(b)["slug"] as? String == "notas-2")
        #expect(f.leer("archivos/compartido/notas.txt") == "uno" && f.leer("archivos/compartido/notas.md") == "dos")
        await aguardar(f, "notas"); await aguardar(f, "notas-2")
        #expect(f.existe("conocimiento/fuentes/notas.md") && f.existe("conocimiento/fuentes/notas-2.md"))
        #expect(f.leer("archivos/.texto/notas.md") == "uno" && f.leer("archivos/.texto/notas-2.md") == "dos")
    }

    // MARK: ficha: variantes y errores

    @Test("ficha: acepta ```json con texto, normaliza listas, mapea nombres de departamento a ids y usa el nombre si falta el título")
    func fichaVariantes() async throws {
        let f = try await bib()
        f.sb.responder("ficha", "Claro, acá va:\n```json\n{\"resumen\": \"Solo resumen\", \"datos_clave\": \"un dato\", \"temas\": \"tema suelto\", \"util_para\": [\"Redes\", \"redes\", \"inexistente\", \"Dirección\"], \"fechas\": [\"2026-12-01\"]}\n```\nEspero que sirva.")
        let fin = await subirYEsperar(f, "notas.txt", "texto de notas")
        #expect(fin["estado"] as? String == "listo")
        let ficha = dict(fin["ficha"])
        #expect(ficha["titulo"] as? String == "notas.txt")
        #expect(ficha["datos_clave"] as? [String] == ["un dato"])
        #expect(ficha["temas"] as? [String] == ["tema suelto"])
        #expect(ficha["util_para"] as? [String] == ["redes", "direccion"])
        #expect(ficha["fechas"] as? [String] == ["2026-12-01"])
        #expect(f.leer("conocimiento/fuentes/notas.md").contains("- **Fechas:** 2026-12-01"))
        #expect(f.leer("conocimiento/fuentes/notas.md").contains("- **Útil para:** Redes, Dirección"))
    }

    @Test("ficha mal formada o con error de claude: el archivo queda en error pero su texto es buscable y está en el catálogo")
    func fichaFallida() async throws {
        let f = try await bib()
        f.sb.responder("ficha", "no puedo armar una ficha")
        let a = await subirYEsperar(f, "primero.txt", "contenido buscable alfa")
        #expect(a["estado"] as? String == "error")
        #expect(a["error"] as? String == "El bibliotecario no devolvió la ficha en el formato esperado.")
        #expect(a["ficha"] == nil)
        #expect(!f.existe("conocimiento/fuentes/primero.md"))
        #expect(f.existe("archivos/.texto/primero.md"))
        #expect(await buscar(f, "alfa") == ["primero"])
        let linea = "- **primero.txt** (`primero`, Compartido, txt): todavía sin ficha"
        #expect(f.leer("conocimiento/archivos.md").contains(linea))
        // BUG (Biblioteca.extraerYFichar): el catálogo se regenera antes de pasar el archivo a «error», así que la línea queda
        // para siempre en «(en proceso)» en vez de «(no se pudo fichar)».
        #expect(f.leer("conocimiento/archivos.md").contains(linea + " (no se pudo fichar)"))
        f.sb.modo("ficha", "error")
        let b = await subirYEsperar(f, "segundo.txt", "contenido buscable beta")
        #expect(b["estado"] as? String == "error")
        #expect(!str(b["error"]).isEmpty)
        #expect(await buscar(f, "beta") == ["segundo"])
        // ficha con título y resumen vacíos: tampoco sirve
        f.sb.modo("ficha", nil)
        f.sb.responder("ficha", "{\"titulo\": \"\", \"resumen\": \"\"}")
        let c = await subirYEsperar(f, "tercero.txt", "contenido gamma")
        #expect(c["estado"] as? String == "error")
    }

    @Test("reprocesar: vuelve a extraer y fichar; 404 si no existe o si el original ya no está")
    func reprocesar() async throws {
        let f = try await bib()
        await subirYEsperar(f, "precios.txt", "contenido")
        escribir("contenido modificado a mano", en: f.ruta("archivos/compartido/precios.txt"))
        let r = await f.post("/api/archivos/precios/reprocesar")
        #expect(r.status == 200)
        #expect(archivo(r)["estado"] as? String == "pendiente")
        let fin = await aguardar(f, "precios")
        #expect(fin["estado"] as? String == "listo")
        #expect(f.leer("archivos/.texto/precios.md") == "contenido modificado a mano")
        #expect(fichas(f).count == 2)
        #expect((await f.post("/api/archivos/nada/reprocesar")).status == 404)
        try FileManager.default.removeItem(atPath: f.ruta("archivos/compartido/precios.txt"))
        #expect((await f.post("/api/archivos/precios/reprocesar")).status == 404)
        #expect((await f.get("/api/archivos/precios/original")).status == 404)
    }

    @Test("catálogo: una línea por documento, ordenado por carpeta y nombre; el listado filtra por departamento")
    func catalogoYFiltro() async throws {
        let f = try await bib()
        f.sb.responder("ficha", fichaJSON(["titulo": "Doc de redes"]))
        await subirYEsperar(f, "zeta.txt", "z", depto: "redes")
        f.sb.responder("ficha", fichaJSON(["titulo": "Doc compartido B"]))
        await subirYEsperar(f, "b.txt", "b")
        f.sb.responder("ficha", fichaJSON(["titulo": "Doc compartido A"]))
        await subirYEsperar(f, "a.txt", "a")
        let cat = f.leer("conocimiento/archivos.md")
        let lineas = cat.components(separatedBy: "\n").filter { $0.hasPrefix("- ") }
        #expect(lineas.count == 3)
        #expect(lineas[0].hasPrefix("- **Doc compartido A** (`a`, Compartido, txt)"))
        #expect(lineas[1].hasPrefix("- **Doc compartido B** (`b`, Compartido, txt)"))
        #expect(lineas[2].hasPrefix("- **Doc de redes** (`zeta`, Redes, txt)"))
        #expect(await buscar(f, "", ["departamento": "redes"]) == ["zeta"])
        let todos = lista((await f.get("/api/archivos", ["departamento": "compartido"])).obj["archivos"]).map { str($0["slug"]) }
        #expect(Set(todos) == ["a", "b"])
        #expect(lista((await f.get("/api/archivos")).obj["archivos"]).count == 3)
    }

    // MARK: búsqueda

    /// Dos documentos con fichas distintas para probar la búsqueda.
    func prepararBusqueda(_ f: Fix) async {
        f.sb.responder("ficha", fichaJSON(["titulo": "Tarifario", "temas": ["finanzas"], "resumen": "Precios del taller."]))
        await subirYEsperar(f, "precios.txt", "El precio del taller de agosto es 150 dólares por persona.")
        f.sb.responder("ficha", fichaJSON(["titulo": "Guion verano", "temas": ["video"], "resumen": "Idea de reel."]))
        await subirYEsperar(f, "guion.txt", "Guion del reel de verano con musica alegre.", depto: "redes")
    }

    @Test("búsqueda FTS5: sin importar mayúsculas ni acentos, por prefijo, varias palabras (todas), en título, resumen, temas y texto")
    func busquedaFTS() async throws {
        let f = try await bib()
        await prepararBusqueda(f)
        #expect((await f.get("/api/biblioteca/estado")).obj["fts"] as? Bool == true)
        #expect(await buscar(f, "agosto") == ["precios"])
        #expect(await buscar(f, "AGOSTO") == ["precios"])
        #expect(await buscar(f, "dolares") == ["precios"])       // el texto dice «dólares»
        #expect(await buscar(f, "dólares") == ["precios"])
        #expect(await buscar(f, "dolar") == ["precios"])         // prefijo
        #expect(await buscar(f, "taller agosto") == ["precios"])
        #expect(await buscar(f, "taller reel").isEmpty)          // todas las palabras
        #expect(await buscar(f, "guion") == ["guion"])           // título/nombre
        #expect(await buscar(f, "finanzas") == ["precios"])      // temas
        #expect(await buscar(f, "idea") == ["guion"])            // resumen
        #expect(await buscar(f, "Tarifario") == ["precios"])
        #expect(await buscar(f, "nada de esto").isEmpty)
        #expect(await buscar(f, "!!!").isEmpty)
        // sintaxis de FTS en la consulta no rompe nada
        let r = await f.get("/api/archivos", ["q": "\"agosto\" OR * NEAR("])
        #expect(r.status == 200)
        // snippet con la coincidencia entre corchetes
        let s = lista((await f.get("/api/archivos", ["q": "agosto"])).obj["archivos"])
        #expect(str(s[0]["snippet"]).contains("[agosto]"))
        #expect((await f.get("/api/archivos", ["q": "agosto"])).obj["q"] as? String == "agosto")
        // sin q: todo, sin snippet; con q en blanco también
        let todos = lista((await f.get("/api/archivos", ["q": "   "])).obj["archivos"])
        #expect(todos.count == 2 && todos.allSatisfy { $0["snippet"] == nil })
        #expect((await f.get("/api/archivos", ["q": "   "])).obj["q"] == nil)
        // se combina con el filtro por departamento
        #expect(await buscar(f, "reel", ["departamento": "redes"]) == ["guion"])
        #expect(await buscar(f, "reel", ["departamento": "compartido"]).isEmpty)
    }

    @Test("búsqueda sin FTS5 (HQ_BIBLIOTECA_SIN_FTS=1): LIKE con los mismos resultados y fragmento con puntos suspensivos")
    func busquedaLIKE() async throws {
        let f = try await bib(env: ["HQ_BIBLIOTECA_SIN_FTS": "1"])
        await prepararBusqueda(f)
        #expect((await f.get("/api/biblioteca/estado")).obj["fts"] as? Bool == false)
        #expect(await buscar(f, "agosto") == ["precios"])
        #expect(await buscar(f, "AGOSTO") == ["precios"])
        #expect(await buscar(f, "taller agosto") == ["precios"])
        #expect(await buscar(f, "taller reel").isEmpty)
        #expect(await buscar(f, "guion") == ["guion"])
        #expect(await buscar(f, "finanzas") == ["precios"])
        #expect(await buscar(f, "idea") == ["guion"])
        #expect(await buscar(f, "precio") == ["precios"])
        #expect(await buscar(f, "nada de esto").isEmpty)
        #expect((await f.get("/api/archivos", ["q": "\"agosto\" OR * NEAR("])).status == 200)
        let s = lista((await f.get("/api/archivos", ["q": "agosto"])).obj["archivos"])
        let snippet = str(s[0]["snippet"])
        #expect(snippet.hasPrefix("…") && snippet.hasSuffix("…") && snippet.contains("agosto"))
        // la búsqueda ignora los acentos del texto: «dolares» tiene que encontrar «dólares» (FTS lo hace; LIKE no)
        #expect(await buscar(f, "dolares") == ["precios"])
    }

    @Test("búsqueda: separada por oficina y sin lo que está en la papelera")
    func busquedaAislada() async throws {
        let f = try await bib()
        await prepararBusqueda(f)
        #expect(await buscar(f, "agosto") == ["precios"])
        // otra oficina no lo ve
        _ = await llamar(f.b, "POST", "/api/oficinas", body: json(["nombre": "Otra"]))
        #expect(await buscar(f, "agosto").isEmpty)
        #expect(lista((await f.get("/api/archivos")).obj["archivos"]).isEmpty)
        #expect((await f.get("/api/archivos/precios")).status == 404)
        _ = await llamar(f.b, "POST", "/api/oficinas/abrir", body: json(["carpeta": f.carpeta]))
        #expect(await buscar(f, "agosto") == ["precios"])
        // papelera
        #expect((await f.delete("/api/archivos/precios")).status == 200)
        #expect(await buscar(f, "agosto").isEmpty)
        #expect(await buscar(f, "taller").isEmpty)
        #expect(await buscar(f, "guion") == ["guion"])
    }

    // MARK: lectura por rol

    @Test("lectura por rol al subir con leer:true: lee el agente de los departamentos «útil para», solo escribe su nota")
    func lecturaPorRol() async throws {
        let f = try await bib()
        f.sb.responder("ficha", fichaJSON(["util_para": ["redes"]]))
        let r = await subirTexto(f, "precios.txt", "El taller cuesta 150 dolares", leer: true)
        #expect(r.status == 200)
        let fin = await aguardar(f, "precios")
        #expect(fin["estado"] as? String == "listo")
        #expect(fin["lectura"] as? [String: String] == ["marce": "ok"])
        #expect(fin["leer"] == nil)
        #expect(f.leer("conocimiento/agentes/marce.md").contains("- leyó el documento (prueba)"))
        #expect(!f.leer("conocimiento/agentes/betty.md").contains("leyó"))
        // una sola lectura, de marce
        let lect = f.sb.llamadas(conPrompt: "Se sumó un documento a la biblioteca")
        #expect(lect.count == 1)
        let l = try #require(lect.first)
        #expect(Sandbox.valor(l, "--agent") == "marce")
        #expect(Router.uuidValido(Sandbox.valor(l, "--session-id") ?? ""))
        #expect(Sandbox.valor(l, "--tools") == "Read,Glob,Grep,Skill,Edit,Write")
        // permiso de escritura: SOLO su archivo de notas (ni entregables ni nada más)
        let notas = f.carpeta + "/conocimiento/agentes/marce.md"
        #expect(Sandbox.reglas(l) == ["Read", "Glob", "Grep", "Skill", "Edit(/\(notas))", "Write(/\(notas))"])
        #expect(!l.contains("--add-dir"))
        #expect(sinPrivate(try #require(f.sb.cwds[f.sb.llamadas.firstIndex(where: { $0 == l })!])) == sinPrivate(f.carpeta))
        let p = try #require(l.last)
        #expect(p.contains("«Tarifario» (archivo precios.txt)"))
        #expect(p.contains("`conocimiento/fuentes/precios.md`") && p.contains("`archivos/.texto/precios.md`"))
        #expect(p.contains("`conocimiento/agentes/marce.md`, el único archivo que podés escribir"))
        #expect(p.contains("desde tu rol de Rol de marce"))
        // el catálogo, la ficha y el texto los escribió el backend, no el agente
        #expect(f.existe("conocimiento/fuentes/precios.md"))
        // las lecturas no tocan el chat 1 a 1
        #expect(msgs(await historial(f.b, agent: "marce")).isEmpty)
    }

    @Test("lectura por rol: sin «útil para» lee quien está en el departamento del archivo; sin nadie, no lee")
    func lecturaPorDepartamento() async throws {
        let f = try await bib()
        f.sb.responder("ficha", fichaJSON(["util_para": [String]()]))
        let en = await subirTexto(f, "a.txt", "uno", depto: "redes", leer: true)
        await aguardar(f, str(archivo(en)["slug"]))
        #expect(f.sb.llamadas(conPrompt: "Se sumó un documento").compactMap { Sandbox.valor($0, "--agent") } == ["marce"])
        // en «compartido» y sin «útil para» no hay a quién mandar: queda listo sin lecturas
        let sin = await subirTexto(f, "b.txt", "dos", leer: true)
        let fin = await aguardar(f, str(archivo(sin)["slug"]))
        #expect(fin["estado"] as? String == "listo")
        #expect(fin["lectura"] == nil)
        #expect(f.sb.llamadas(conPrompt: "Se sumó un documento").count == 1)
    }

    @Test("lectura por rol a pedido: POST /leer con o sin agentes; validaciones y 409")
    func lecturaAPedido() async throws {
        let f = try await bib()
        await subirYEsperar(f, "precios.txt", "El taller cuesta 150 dolares")        // util_para ["direccion"] (betty)
        let r = await f.post("/api/archivos/precios/leer", ["agentes": ["marce"]])
        #expect(r.status == 200)
        #expect(r.obj["agentes"] as? [String] == ["marce"])
        let a = await aguardar(f, "precios")
        #expect(a["lectura"] as? [String: String] == ["marce": "ok"])
        // sin cuerpo: los de «útil para» (Dirección -> betty)
        let b = await f.post("/api/archivos/precios/leer")
        #expect(b.status == 200)
        #expect(b.obj["agentes"] as? [String] == ["betty"])
        let c = await aguardar(f, "precios")
        #expect(c["lectura"] as? [String: String] == ["betty": "ok"])
        #expect(f.leer("conocimiento/agentes/betty.md").contains("leyó"))
        // errores
        #expect((await f.post("/api/archivos/precios/leer", ["agentes": ["fantasma"]])).status == 400)
        #expect((await f.post("/api/archivos/precios/leer", ["agentes": "betty"])).status == 400)
        #expect((await f.post("/api/archivos/nada/leer")).status == 404)
        #expect((await llamar(f.b, "GET", "/api/archivos/precios/leer")).status == 405)
        // sin «útil para» ni departamento propio: 409
        f.sb.responder("ficha", fichaJSON(["util_para": [String]()]))
        await subirYEsperar(f, "huerfano.txt", "sin dueño")
        let v = await f.post("/api/archivos/huerfano/leer")
        #expect(v.status == 409)
        #expect(str(v.obj["error"]).contains("No hay agentes"))
    }

    @Test("lectura por rol: 409 mientras el archivo no tiene ficha (todavía procesándose)")
    func lecturaSinFicha() async throws {
        let f = try await bib()
        f.sb.modo("ficha", "puerta")
        _ = await subirTexto(f, "precios.txt", "texto")
        #expect(await esperarAsync { f.sb.eventos.contains("S ") })
        let r = await f.post("/api/archivos/precios/leer", ["agentes": ["betty"]])
        #expect(r.status == 409)
        #expect(str(r.obj["error"]).contains("ficha"))
        f.sb.abrirPuerta()
        #expect((await aguardar(f, "precios"))["estado"] as? String == "listo")
    }

    @Test("estado de la biblioteca: la cola, quién está leyendo y las propuestas; vacío cuando todo está listo")
    func estadoYCola() async throws {
        let f = try await bib()
        let vacio = await f.get("/api/biblioteca/estado")
        #expect(vacio.status == 200)
        #expect(Set(vacio.obj.keys) == ["cola", "pendientes", "total", "leyendo", "propuestas", "fts"])
        #expect(vacio.obj["total"] as? Int == 0 && vacio.obj["pendientes"] as? Int == 0)
        // mientras se ficha
        f.sb.modo("ficha", "puerta")
        _ = await subirTexto(f, "uno.txt", "texto uno")
        #expect(await esperarAsync { f.sb.eventos.contains("S ") })
        var e = await f.get("/api/biblioteca/estado")
        #expect(e.obj["pendientes"] as? Int == 1 && e.obj["total"] as? Int == 1)
        #expect(lista(e.obj["cola"]).map { str($0["slug"]) + ":" + str($0["estado"]) } == ["uno:fichando"])
        f.sb.abrirPuerta()
        await aguardar(f, "uno")
        // mientras lee un agente
        f.sb.modo("ficha", nil)
        f.sb.modo("marce", "puerta")
        try? FileManager.default.removeItem(atPath: f.sb.binDir + "/go")
        f.sb.responder("ficha", fichaJSON(["util_para": ["redes"]]))
        _ = await subirTexto(f, "dos.txt", "texto dos", leer: true)
        #expect(await esperarAsync { f.sb.eventos.contains("S marce") })
        e = await f.get("/api/biblioteca/estado")
        #expect(e.obj["leyendo"] as? [String] == ["marce"])
        let item = try #require(lista(e.obj["cola"]).first)
        #expect(item["slug"] as? String == "dos" && item["estado"] as? String == "leyendo" && item["leer"] as? [String] == ["marce"])
        f.sb.abrirPuerta()
        await aguardar(f, "dos")
        e = await f.get("/api/biblioteca/estado")
        #expect(e.obj["leyendo"] as? [String] == [])
        #expect(lista(e.obj["cola"]).isEmpty && e.obj["pendientes"] as? Int == 0 && e.obj["total"] as? Int == 2)
    }

    @Test("lectura por rol: si el agente falla queda registrado como error y el archivo igual termina listo")
    func lecturaFallida() async throws {
        let f = try await bib()
        f.sb.modo("marce", "error")
        f.sb.responder("ficha", fichaJSON(["util_para": ["redes", "direccion"]]))
        _ = await subirTexto(f, "precios.txt", "texto", leer: true)
        let fin = await aguardar(f, "precios")
        #expect(fin["estado"] as? String == "listo")
        let lectura = fin["lectura"] as? [String: String] ?? [:]
        #expect(lectura["betty"] == "ok")
        #expect(lectura["marce"]?.hasPrefix("error: ") == true)
    }

    @Test("config de la biblioteca: lectura automática, límites y validaciones; se guarda en oficina.json")
    func configBiblioteca() async throws {
        let f = try await bib()
        let g = await f.get("/api/biblioteca/config")
        #expect(g.status == 200)
        #expect(g.obj["lecturaAutomatica"] as? Bool == false)
        #expect(g.obj["maxMB"] as? Int == 25 && g.obj["maxArchivos"] as? Int == 200 && g.obj["maxTotalMB"] as? Int == 500)
        let ext = g.obj["extensiones"] as? [String] ?? []
        #expect(ext == ext.sorted())
        #expect(Set(ext).isSuperset(of: ["pdf", "docx", "txt", "md", "png", "jpg", "csv"]))
        #expect(f.oficinaJSON()["biblioteca"] == nil)
        let p = await f.patch("/api/biblioteca/config", ["lecturaAutomatica": true, "maxArchivos": 10])
        #expect(p.obj["lecturaAutomatica"] as? Bool == true && p.obj["maxArchivos"] as? Int == 10 && p.obj["maxMB"] as? Int == 25)
        #expect(dict(f.oficinaJSON()["biblioteca"])["lecturaAutomatica"] as? Bool == true)
        // parcial: lo demás se conserva
        let q = await f.patch("/api/biblioteca/config", ["maxTotalMB": 100])
        #expect(q.obj["lecturaAutomatica"] as? Bool == true && q.obj["maxArchivos"] as? Int == 10 && q.obj["maxTotalMB"] as? Int == 100)
        for malo in [["maxMB": 0], ["maxMB": 501], ["maxMB": "x"], ["maxMB": true], ["maxArchivos": 5001], ["maxTotalMB": 20001], ["lecturaAutomatica": "si"]] as [[String: Any]] {
            #expect((await f.patch("/api/biblioteca/config", malo)).status == 400, "\(malo)")
        }
        #expect((await f.patch("/api/biblioteca/config")).status == 400)
        #expect((await llamar(f.b, "DELETE", "/api/biblioteca/config")).status == 405)
    }

    @Test("lectura automática (config): todo archivo nuevo se lee por rol sin pedirlo")
    func lecturaAutomatica() async throws {
        let f = try await bib()
        _ = await f.patch("/api/biblioteca/config", ["lecturaAutomatica": true])
        let fin = await subirYEsperar(f, "precios.txt", "texto")      // util_para ["direccion"] por defecto -> betty
        #expect(fin["lectura"] as? [String: String] == ["betty": "ok"])
        #expect(f.sb.llamadas(conPrompt: "Se sumó un documento").compactMap { Sandbox.valor($0, "--agent") } == ["betty"])
        // sin la opción, no
        _ = await f.patch("/api/biblioteca/config", ["lecturaAutomatica": false])
        let otro = await subirYEsperar(f, "otro.txt", "otro texto")
        #expect(otro["lectura"] == nil)
        #expect(f.sb.llamadas(conPrompt: "Se sumó un documento").count == 1)
    }

    // MARK: propuestas de cambio al conocimiento

    func contradiccion(sug: String = "El taller cuesta 150 dólares.") -> String {
        fichaJSON(["contradicciones": [["actual": "El taller cuesta 100 dólares", "nuevo": "El taller cuesta 150 dólares", "sugerencia": sug],
                                       ["actual": "x", "nuevo": "y", "sugerencia": ""]]])
    }

    @Test("propuestas: las contradicciones quedan pendientes y NUNCA se aplican solas; aceptar anexa a oficina.md")
    func propuestaAceptar() async throws {
        let f = try await bib()
        let antes = f.leer("conocimiento/oficina.md")
        f.sb.responder("ficha", contradiccion())
        await subirYEsperar(f, "precios.txt", "El taller cuesta 150 dolares")
        #expect(f.leer("conocimiento/oficina.md") == antes)
        let l = lista((await f.get("/api/biblioteca/propuestas")).obj["propuestas"])
        #expect(l.count == 1)          // la que no tiene sugerencia se descarta
        let p = l[0]
        #expect(Router.uuidValido(str(p["id"])))
        #expect(p["archivo"] as? String == "precios" && p["titulo"] as? String == "Tarifario")
        #expect(p["actual"] as? String == "El taller cuesta 100 dólares" && p["nuevo"] as? String == "El taller cuesta 150 dólares")
        #expect(p["sugerencia"] as? String == "El taller cuesta 150 dólares." && p["estado"] as? String == "pendiente")
        #expect(str(p["creada"]).hasSuffix("Z"))
        #expect((await f.get("/api/biblioteca/estado")).obj["propuestas"] as? Int == 1)
        let id = str(p["id"])
        let r = await f.post("/api/biblioteca/propuestas/\(id)", ["aceptar": true])
        #expect(r.status == 200)
        let v = dict(r.obj["propuesta"])
        #expect(v["estado"] as? String == "aceptada" && v["aplicada"] as? Bool == true && !str(v["resuelta"]).isEmpty)
        let dia = DateFormatter(); dia.locale = Locale(identifier: "en_US_POSIX"); dia.dateFormat = "yyyy-MM-dd"
        let despues = f.leer("conocimiento/oficina.md")
        #expect(despues.hasPrefix(antes))
        #expect(despues.hasSuffix("\n## Actualizado \(dia.string(from: Date()))\nEl taller cuesta 150 dólares.\n(Fuente: Tarifario, `conocimiento/fuentes/precios.md`)\n"))
        // ya resuelta: 409 y no se anexa dos veces
        let otra = await f.post("/api/biblioteca/propuestas/\(id)", ["aceptar": true])
        #expect(otra.status == 409)
        #expect(f.leer("conocimiento/oficina.md") == despues)
        #expect(lista((await f.get("/api/biblioteca/propuestas")).obj["propuestas"]).isEmpty)
        let todas = lista((await f.get("/api/biblioteca/propuestas", ["todas": "1"])).obj["propuestas"])
        #expect(todas.map { str($0["estado"]) } == ["aceptada"])
        #expect((await f.get("/api/biblioteca/estado")).obj["propuestas"] as? Int == 0)
    }

    @Test("propuestas: rechazar la descarta sin tocar nada; validaciones y 404")
    func propuestaRechazar() async throws {
        let f = try await bib()
        let antes = f.leer("conocimiento/oficina.md")
        f.sb.responder("ficha", contradiccion())
        await subirYEsperar(f, "precios.txt", "El taller cuesta 150 dolares")
        let id = str(lista((await f.get("/api/biblioteca/propuestas")).obj["propuestas"])[0]["id"])
        #expect((await f.post("/api/biblioteca/propuestas/\(id)")).status == 400)
        #expect((await f.post("/api/biblioteca/propuestas/\(id)", [:])).status == 400)
        #expect((await f.post("/api/biblioteca/propuestas/\(id)", ["aceptar": "true"])).status == 400)
        #expect((await f.post("/api/biblioteca/propuestas/\(U.a)", ["aceptar": true])).status == 404)
        #expect((await f.post("/api/biblioteca/propuestas/no-es-uuid", ["aceptar": true])).status == 404)
        #expect((await llamar(f.b, "GET", "/api/biblioteca/propuestas/\(id)")).status == 405)
        let r = await f.post("/api/biblioteca/propuestas/\(id)", ["aceptar": false])
        #expect(r.status == 200)
        #expect(dict(r.obj["propuesta"])["estado"] as? String == "rechazada")
        #expect(dict(r.obj["propuesta"])["aplicada"] as? Bool == false)
        #expect(lista((await f.get("/api/biblioteca/propuestas")).obj["propuestas"]).isEmpty)
        #expect(lista((await f.get("/api/biblioteca/propuestas", ["todas": "1"])).obj["propuestas"]).map { str($0["estado"]) } == ["rechazada"])
        #expect(f.leer("conocimiento/oficina.md") == antes)
        #expect((await f.post("/api/biblioteca/propuestas/\(id)", ["aceptar": true])).status == 409)
    }

    @Test("propuestas: no se repite la misma sugerencia pendiente al reprocesar y hay un máximo de 5 por ficha")
    func propuestasRepetidasYTope() async throws {
        let f = try await bib()
        f.sb.responder("ficha", contradiccion())
        await subirYEsperar(f, "precios.txt", "uno")
        _ = await f.post("/api/archivos/precios/reprocesar")
        await aguardar(f, "precios")
        #expect(lista((await f.get("/api/biblioteca/propuestas")).obj["propuestas"]).count == 1)
        let siete = (1...7).map { ["actual": "a\($0)", "nuevo": "n\($0)", "sugerencia": "sugerencia \($0)"] }
        f.sb.responder("ficha", fichaJSON(["contradicciones": siete]))
        await subirYEsperar(f, "otro.txt", "dos")
        #expect(lista((await f.get("/api/biblioteca/propuestas")).obj["propuestas"]).count == 6)   // 1 + 5
    }

    // MARK: vínculos

    /// Carpeta externa con material variado.
    func externa(_ f: Fix, _ nombre: String = "externa") throws -> String {
        let d = f.sb.root + "/" + nombre
        escribir("alfa uno", en: d + "/a.txt")
        escribir("beta dos", en: d + "/sub/b.md")
        escribir("oculto", en: d + "/.oculto.txt")
        escribir("oculto 2", en: d + "/.git/x.txt")
        escribir("binario", en: d + "/c.exe")
        try FileManager.default.createSymbolicLink(atPath: d + "/link.txt", withDestinationPath: d + "/a.txt")
        return d
    }

    @Test("vínculos: validaciones al crear")
    func vinculoValidaciones() async throws {
        let f = try await bib()
        let ext = try externa(f)
        func crear(_ d: [String: Any]) async -> Resp { await f.post("/api/vinculos", d) }
        // demasiado amplias
        #expect((await crear(["ruta": "/"])).status == 400)
        #expect((await crear(["ruta": "~"])).status == 400)
        #expect((await crear(["ruta": f.sb.home])).status == 400)
        #expect((await crear(["ruta": f.sb.home + "/"])).status == 400)
        try FileManager.default.createSymbolicLink(atPath: f.sb.root + "/atajo", withDestinationPath: f.sb.home)
        #expect((await crear(["ruta": f.sb.root + "/atajo"])).status == 400)      // enlace a la carpeta personal
        // rutas inválidas
        #expect((await crear(["ruta": "relativa/carpeta"])).status == 400)
        #expect((await crear([:])).status == 400)
        #expect((await crear(["ruta": 7])).status == 400)
        #expect((await crear(["ruta": f.sb.root + "/no-existe"])).status == 404)
        #expect((await crear(["ruta": ext + "/a.txt"])).status == 400)             // es un archivo
        // ya es parte de la oficina
        #expect((await crear(["ruta": f.carpeta])).status == 400)
        #expect((await crear(["ruta": f.carpeta + "/archivos"])).status == 400)
        // alcance
        #expect((await crear(["ruta": ext, "alcance": "todos"])).status == 400)
        #expect((await crear(["ruta": ext, "alcance": 5])).status == 400)
        #expect((await crear(["ruta": ext, "alcance": [String: Any]()])).status == 400)
        #expect((await crear(["ruta": ext, "alcance": ["departamentos": [String]()]])).status == 400)
        #expect((await crear(["ruta": ext, "alcance": ["departamentos": ["inexistente"]]])).status == 400)
        #expect((await crear(["ruta": ext, "alcance": ["agentes": ["fantasma"]]])).status == 400)
        #expect((await crear(["ruta": ext, "alcance": ["agentes": "marce"]])).status == 400)
        #expect((await crear(["ruta": ext, "id": "Mal Id"])).status == 400)
        #expect(((await f.get("/api/vinculos")).obj["vinculos"] as? [Any])?.isEmpty == true)
        #expect(f.oficinaJSON()["vinculos"] == nil)
        // bien, y duplicados
        let ok = await crear(["ruta": ext, "id": "mi-ext"])
        #expect(ok.status == 200)
        let v = dict(ok.obj["vinculo"])
        #expect(v["id"] as? String == "mi-ext" && v["ruta"] as? String == ext && v["alcance"] as? String == "oficina")
        #expect(v["archivos"] as? Int == 0 && v["pendientes"] as? Int == 0 && v["existe"] as? Bool == true)
        #expect((await crear(["ruta": ext])).status == 409)
        #expect((await crear(["ruta": ext + "/"])).status == 409)
        let otra = try externa(f, "otra")
        #expect((await crear(["ruta": otra, "id": "mi-ext"])).status == 409)
        // el id sale del nombre de la carpeta
        let con = f.sb.root + "/Mi Carpeta Grande"
        try FileManager.default.createDirectory(atPath: con, withIntermediateDirectories: true)
        #expect(dict((await crear(["ruta": con])).obj["vinculo"])["id"] as? String == "mi-carpeta-grande")
        // y se guarda en oficina.json
        let guardados = lista(f.oficinaJSON()["vinculos"])
        #expect(guardados.map { str($0["id"]) } == ["mi-ext", "mi-carpeta-grande"])
        // NO se escanea sola al vincular
        #expect(lista((await f.get("/api/archivos")).obj["archivos"]).isEmpty)
        #expect(f.sb.llamadas.isEmpty)
    }

    @Test("vínculos: máximo 20 carpetas y alcances guardados tal cual en oficina.json")
    func vinculoMaximoYAlcances() async throws {
        let f = try await bib()
        for i in 0..<20 {
            let d = f.sb.root + "/v\(i)"
            try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
            let alcance: Any = i == 1 ? ["departamentos": ["redes"]] : (i == 2 ? ["agentes": ["marce", "betty"]] : "oficina")
            #expect((await f.post("/api/vinculos", ["ruta": d, "alcance": alcance])).status == 200)
        }
        try FileManager.default.createDirectory(atPath: f.sb.root + "/v20", withIntermediateDirectories: true)
        let r = await f.post("/api/vinculos", ["ruta": f.sb.root + "/v20"])
        #expect(r.status == 400)
        #expect(str(r.obj["error"]).contains("20"))
        let g = lista(f.oficinaJSON()["vinculos"])
        #expect(g.count == 20)
        #expect(dict(g[1]["alcance"])["departamentos"] as? [String] == ["redes"])
        #expect(dict(g[2]["alcance"])["agentes"] as? [String] == ["marce", "betty"])
        #expect(g[0]["alcance"] as? String == "oficina")
        let l = lista((await f.get("/api/vinculos")).obj["vinculos"])
        #expect(l.count == 20 && l.allSatisfy { $0["existe"] as? Bool == true })
    }

    @Test("escanear: sin copiar nada, solo extensiones soportadas, sin ocultos ni enlaces; se ficha en su lugar")
    func escanearSinCopiar() async throws {
        let f = try await bib()
        let ext = try externa(f)
        _ = await f.post("/api/vinculos", ["ruta": ext, "id": "ext"])
        let e = await f.post("/api/vinculos/ext/escanear")
        #expect(e.status == 200)
        #expect(e.obj["ok"] as? Bool == true)
        #expect(e.obj["nuevos"] as? Int == 2 && e.obj["actualizados"] as? Int == 0 && e.obj["sinCambios"] as? Int == 0)
        #expect(e.obj["quitados"] as? Int == 0 && e.obj["omitidos"] as? Int == 0 && e.obj["tope"] as? Bool == false)
        #expect(e.obj["aviso"] == nil)
        let l = lista((await f.get("/api/archivos")).obj["archivos"])
        #expect(Set(l.map { str($0["slug"]) }) == ["a", "b"])
        for a in l {
            #expect(a["origen"] as? String == "vinculo" && a["departamento"] as? String == "vinculo" && a["vinculo"] as? String == "ext")
            #expect(str(a["ruta"]).hasPrefix("/"))
        }
        await aguardar(f, "a"); await aguardar(f, "b")
        // no se copió nada a la oficina
        #expect(listar(f.carpeta + "/archivos/compartido").isEmpty)
        #expect(!f.existe("archivos/vinculo"))
        // pero sí se extrajo y se ficho en su lugar
        #expect(f.leer("archivos/.texto/a.md") == "alfa uno" && f.leer("archivos/.texto/b.md") == "beta dos")
        let md = f.leer("conocimiento/fuentes/a.md")
        #expect(md.contains("- **Origen:** carpeta vinculada «ext»"))
        #expect(md.contains("- **Carpeta:** Carpeta vinculada"))
        #expect(md.contains("- **Ubicación del original:** /") && md.contains("/externa/a.txt"))
        let p = try #require(fichas(f).first?.last)
        #expect(p.contains("carpeta: Carpeta vinculada"))
        // los originales no se tocaron
        #expect(leerTexto(ext + "/a.txt") == "alfa uno" && leerTexto(ext + "/sub/b.md") == "beta dos")
        #expect(await buscar(f, "alfa") == ["a"])
        // el detalle muestra la ruta absoluta del original y la lista de vínculos cuenta sus archivos
        #expect(str(dict((await f.get("/api/archivos/a")).obj["archivo"])["rutaAbsoluta"]).hasSuffix("/externa/a.txt"))
        let v = dict(lista((await f.get("/api/vinculos")).obj["vinculos"])[0])
        #expect(v["archivos"] as? Int == 2 && v["pendientes"] as? Int == 0)
        #expect(v["existe"] as? Bool == true)
    }

    @Test("escanear de nuevo: sin cambios, cambió el contenido (reindexa por hash) y desapareció un archivo (va a la papelera)")
    func escanearReindexa() async throws {
        let f = try await bib()
        let ext = try externa(f)
        _ = await f.post("/api/vinculos", ["ruta": ext, "id": "ext"])
        _ = await f.post("/api/vinculos/ext/escanear")
        await aguardar(f, "a"); await aguardar(f, "b")
        let hashA = str(dict((await f.get("/api/archivos/a")).obj["archivo"])["hash"])
        #expect(fichas(f).count == 2)
        let igual = await f.post("/api/vinculos/ext/escanear")
        #expect(igual.obj["sinCambios"] as? Int == 2 && igual.obj["nuevos"] as? Int == 0 && igual.obj["actualizados"] as? Int == 0)
        #expect(fichas(f).count == 2)      // no se reprocesó nada
        // cambia a.txt, se borra b.md, aparece c.txt
        escribir("alfa dos modificado", en: ext + "/a.txt")
        try FileManager.default.removeItem(atPath: ext + "/sub/b.md")
        escribir("gamma tres", en: ext + "/c.txt")
        let r = await f.post("/api/vinculos/ext/escanear")
        #expect(r.obj["actualizados"] as? Int == 1 && r.obj["quitados"] as? Int == 1 && r.obj["nuevos"] as? Int == 1 && r.obj["sinCambios"] as? Int == 0)
        await aguardar(f, "a"); await aguardar(f, "c")
        let a = dict((await f.get("/api/archivos/a")).obj["archivo"])
        #expect(a["hash"] as? String != hashA)
        #expect(f.leer("archivos/.texto/a.md") == "alfa dos modificado")
        #expect(fichas(f).count == 4)      // a de nuevo y c
        #expect(await buscar(f, "modificado") == ["a"])
        #expect(await buscar(f, "gamma") == ["c"])
        // b salió de la biblioteca
        #expect((await f.get("/api/archivos/b")).status == 404)
        #expect(await buscar(f, "beta").isEmpty)
        #expect(!f.leer("conocimiento/archivos.md").contains("`b`"))
        #expect(Set(lista((await f.get("/api/archivos")).obj["archivos"]).map { str($0["slug"]) }) == ["a", "c"])
    }

    @Test("escanear: tope de archivos, de peso total y de tamaño por archivo; omitidos y aviso")
    func escanearTopes() async throws {
        let f = try await bib()
        let d = f.sb.root + "/muchos"
        for n in ["a", "b", "c", "d", "e"] { escribir("texto \(n)", en: d + "/\(n).txt") }
        _ = await f.post("/api/vinculos", ["ruta": d, "id": "muchos"])
        _ = await f.patch("/api/biblioteca/config", ["maxArchivos": 2])
        let r = await f.post("/api/vinculos/muchos/escanear")
        #expect(r.obj["nuevos"] as? Int == 2 && r.obj["omitidos"] as? Int == 3 && r.obj["tope"] as? Bool == true)
        #expect(str(r.obj["aviso"]).contains("tope"))
        #expect(Set(lista((await f.get("/api/archivos")).obj["archivos"]).map { str($0["slug"]) }) == ["a", "b"])   // por orden de ruta
        await aguardar(f, "a"); await aguardar(f, "b")
        // peso total: máximo 1 MB entre todos
        let g = f.sb.root + "/pesados"
        escribir(String(repeating: "a", count: 600_000), en: g + "/a.txt")
        escribir(String(repeating: "b", count: 600_000), en: g + "/b.txt")
        _ = await f.post("/api/vinculos", ["ruta": g, "id": "pesados"])
        _ = await f.patch("/api/biblioteca/config", ["maxArchivos": 50, "maxTotalMB": 1])
        let t = await f.post("/api/vinculos/pesados/escanear")
        #expect(t.obj["nuevos"] as? Int == 1 && t.obj["omitidos"] as? Int == 1 && t.obj["tope"] as? Bool == true)
        // un archivo más grande que maxMB se omite sin marcar tope
        let h = f.sb.root + "/grandes"
        escribir("chico", en: h + "/chico.txt")
        try Data(repeating: 0x61, count: 1_100_000).write(to: URL(fileURLWithPath: h + "/grande.txt"))
        _ = await f.post("/api/vinculos", ["ruta": h, "id": "grandes"])
        _ = await f.patch("/api/biblioteca/config", ["maxMB": 1, "maxTotalMB": 500])
        let m = await f.post("/api/vinculos/grandes/escanear")
        #expect(m.obj["nuevos"] as? Int == 1 && m.obj["omitidos"] as? Int == 1 && m.obj["tope"] as? Bool == false)
        #expect(m.obj["aviso"] == nil)
        for s in ["a-2", "chico"] { await aguardar(f, s) }
    }

    @Test("escanear: 404 si el vínculo no existe o si su carpeta ya no está; la lista marca existe:false")
    func escanearErrores() async throws {
        let f = try await bib()
        let ext = try externa(f)
        _ = await f.post("/api/vinculos", ["ruta": ext, "id": "ext"])
        #expect((await f.post("/api/vinculos/nada/escanear")).status == 404)
        #expect((await f.post("/api/vinculos/Mal_Id/escanear")).status == 404)
        #expect((await llamar(f.b, "GET", "/api/vinculos/ext/escanear")).status == 405)
        try FileManager.default.removeItem(atPath: ext)
        let r = await f.post("/api/vinculos/ext/escanear")
        #expect(r.status == 404)
        #expect(str(r.obj["error"]).contains("ya no existe"))
        #expect(dict(lista((await f.get("/api/vinculos")).obj["vinculos"])[0])["existe"] as? Bool == false)
    }

    @Test("quitar un vínculo: sus archivos salen de la biblioteca (papelera) y la carpeta del usuario no se toca")
    func quitarVinculo() async throws {
        let f = try await bib()
        let ext = try externa(f)
        _ = await f.post("/api/vinculos", ["ruta": ext, "id": "ext"])
        _ = await f.post("/api/vinculos/ext/escanear")
        await aguardar(f, "a"); await aguardar(f, "b")
        let r = await f.delete("/api/vinculos/ext")
        #expect(r.status == 200)
        #expect(r.obj["ok"] as? Bool == true && r.obj["quitados"] as? Int == 2)
        #expect(leerTexto(ext + "/a.txt") == "alfa uno" && leerTexto(ext + "/sub/b.md") == "beta dos")
        #expect(lista((await f.get("/api/archivos")).obj["archivos"]).isEmpty)
        #expect(await buscar(f, "alfa").isEmpty)
        #expect(f.oficinaJSON()["vinculos"] == nil)
        #expect(((await f.get("/api/vinculos")).obj["vinculos"] as? [Any])?.isEmpty == true)
        #expect(f.leer("conocimiento/archivos.md").contains("(Todavía no hay documentos.)"))
        #expect(!f.existe("conocimiento/fuentes/a.md"))
        #expect((await f.delete("/api/vinculos/ext")).status == 404)
        #expect((await f.delete("/api/vinculos/Mal_Id")).status == 404)
        // se puede volver a vincular y escanear: los slugs se reutilizan sin chocar con la papelera
        _ = await f.post("/api/vinculos", ["ruta": ext, "id": "ext"])
        let otra = await f.post("/api/vinculos/ext/escanear")
        #expect(otra.obj["nuevos"] as? Int == 2)
        await aguardar(f, "a-2"); await aguardar(f, "b-2")
    }

    @Test("quitar un archivo vinculado no toca el original; quitar uno subido lo mueve a la papelera con su ficha y su texto")
    func papelera() async throws {
        let f = try await bib()
        let ext = try externa(f)
        _ = await f.post("/api/vinculos", ["ruta": ext, "id": "ext"])
        _ = await f.post("/api/vinculos/ext/escanear")
        await aguardar(f, "a"); await aguardar(f, "b")
        let v = await f.delete("/api/archivos/a")
        #expect(v.status == 200)
        #expect(str(v.obj["papelera"]).hasSuffix("/externa/a.txt"))
        #expect(leerTexto(ext + "/a.txt") == "alfa uno")
        // subido
        await subirYEsperar(f, "precios.txt", "contenido de precios")
        let r = await f.delete("/api/archivos/precios")
        #expect(r.status == 200)
        #expect(r.obj["ok"] as? Bool == true)
        let rel = str(r.obj["papelera"])
        #expect(rel.range(of: #"^archivos/\.papelera/precios-\d{4}-\d{2}-\d{2}-\d+/precios\.txt$"#, options: .regularExpression) != nil, "papelera=\(rel)")
        #expect(f.leer(rel) == "contenido de precios")
        let dir = (rel as NSString).deletingLastPathComponent
        #expect(f.leer(dir + "/texto.md") == "contenido de precios")
        #expect(f.leer(dir + "/ficha.md").contains("# Ficha de prueba"))
        #expect(!f.existe("archivos/compartido/precios.txt") && !f.existe("archivos/.texto/precios.md") && !f.existe("conocimiento/fuentes/precios.md"))
        #expect((await f.get("/api/archivos/precios")).status == 404)
        #expect((await f.delete("/api/archivos/precios")).status == 404)
        #expect((await f.delete("/api/archivos/Mal_Id")).status == 404)
        #expect(!lista((await f.get("/api/archivos")).obj["archivos"]).contains { str($0["slug"]) == "precios" })
        #expect(!f.leer("conocimiento/archivos.md").contains("`precios`"))
        // se puede subir otro con el mismo nombre; el slug no choca con el de la papelera
        let otro = await subirTexto(f, "precios.txt", "otra version")
        #expect(otro.status == 200 && otro.obj["reemplazado"] == nil && otro.obj["duplicado"] == nil)
        #expect(archivo(otro)["slug"] as? String == "precios-2")
        await aguardar(f, "precios-2")
    }

    @Test("quitar un archivo mientras se está fichando: no queda ficha ni catálogo del archivo quitado")
    func quitarMientrasSeProcesa() async throws {
        let f = try await bib()
        f.sb.modo("ficha", "puerta")
        _ = await subirTexto(f, "precios.txt", "texto")
        #expect(await esperarAsync { f.sb.eventos.contains("S ") })
        #expect((await f.delete("/api/archivos/precios")).status == 200)
        f.sb.abrirPuerta()
        #expect(await esperarAsync { f.sb.eventos.last == "E " })
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(!f.existe("conocimiento/fuentes/precios.md"))
        #expect(!f.leer("conocimiento/archivos.md").contains("precios"))
        #expect(await buscar(f, "texto").isEmpty)
        #expect((await f.get("/api/biblioteca/estado")).obj["pendientes"] as? Int == 0)
    }

    // MARK: arranque

    @Test("al arrancar, lo que quedó a medio procesar (extrayendo o fichando) vuelve a pendiente y se procesa")
    func reinicioReprocesa() async throws {
        let f = try await bib()
        _ = await f.get("/api/biblioteca/estado")            // prepara las tablas
        let ahora = Date().timeIntervalSince1970
        for (slug, estado) in [("viejo", "fichando"), ("viejo2", "extrayendo")] {
            escribir("contenido de \(slug)", en: f.ruta("archivos/compartido/\(slug).txt"))
            let fila = ArchivoFila(slug: slug, oficina: f.carpeta, nombre: "\(slug).txt", departamento: "compartido", ruta: "archivos/compartido/\(slug).txt",
                                   origen: "subido", vinculo: nil, tipo: "txt", tam: 10, hash: "abc", estado: estado, error: nil, aviso: nil,
                                   ficha: nil, creado: ahora, actualizado: ahora)
            try await f.b.store.archivoGuardar(fila)
        }
        await f.b.shutdown()
        let b2 = try f.sb.backend(oficina: false)
        let f2 = Fix(sb: f.sb, b: b2, carpeta: f.carpeta)
        for slug in ["viejo", "viejo2"] {
            let fin = await aguardar(f2, slug)
            #expect(fin["estado"] as? String == "listo", "\(slug): \(fin)")
            #expect(f2.leer("archivos/.texto/\(slug).md") == "contenido de \(slug)")
            #expect(f2.existe("conocimiento/fuentes/\(slug).md"))
        }
    }

    // MARK: original y entregables

    @Test("entregables de un agente: listado ordenado, sin ocultos; el contenido se baja por ruta y no se sale de la carpeta")
    func entregables() async throws {
        let f = try await bib()
        escribir("informe", en: f.ruta("archivos/entregables/marce/informe.md"))
        escribir("deck", en: f.ruta("archivos/entregables/marce/sub/deck.txt"))
        escribir("oculto", en: f.ruta("archivos/entregables/marce/.oculto"))
        escribir("de otro", en: f.ruta("archivos/entregables/betty/ajeno.md"))
        try FileManager.default.createSymbolicLink(atPath: f.ruta("archivos/entregables/marce/escape.md"), withDestinationPath: f.ruta("oficina.json"))
        let r = await f.get("/api/biblioteca/entregables", ["agente": "marce"])
        #expect(r.status == 200)
        #expect(r.obj["agente"] as? String == "marce" && r.obj["carpeta"] as? String == "archivos/entregables/marce")
        let l = lista(r.obj["entregables"])
        #expect(Set(l.map { str($0["ruta"]) }).isSuperset(of: ["informe.md", "sub/deck.txt"]))
        #expect(!l.contains { str($0["nombre"]) == ".oculto" || str($0["nombre"]) == "ajeno.md" })
        let inf = try #require(l.first { str($0["ruta"]) == "informe.md" })
        #expect(inf["tam"] as? Int == 7 && inf["tipo"] as? String == "md" && inf["nombre"] as? String == "informe.md" && str(inf["modificado"]).hasSuffix("Z"))
        let c = await f.get("/api/biblioteca/entregable", ["agente": "marce", "ruta": "informe.md"])
        #expect(c.status == 200)
        #expect(c.obj["base64"] as? String == Data("informe".utf8).base64EncodedString() && c.obj["nombre"] as? String == "informe.md")
        #expect((await f.get("/api/biblioteca/entregable", ["agente": "marce", "ruta": "sub/deck.txt"])).status == 200)
        // fuera de la carpeta: ni con «..» ni con un enlace simbólico
        #expect((await f.get("/api/biblioteca/entregable", ["agente": "marce", "ruta": "../betty/ajeno.md"])).status == 404)
        #expect((await f.get("/api/biblioteca/entregable", ["agente": "marce", "ruta": "../../../oficina.json"])).status == 404)
        #expect((await f.get("/api/biblioteca/entregable", ["agente": "marce", "ruta": "escape.md"])).status == 404)
        #expect((await f.get("/api/biblioteca/entregable", ["agente": "marce", "ruta": "no-existe.md"])).status == 404)
        #expect((await f.get("/api/biblioteca/entregable", ["agente": "marce"])).status == 400)
        #expect((await f.get("/api/biblioteca/entregable", ["agente": "Mal Id", "ruta": "x"])).status == 400)
        #expect((await f.get("/api/biblioteca/entregables")).status == 400)
        // agente sin entregables: lista vacía
        let sin = await f.get("/api/biblioteca/entregables", ["agente": "nadie"])
        #expect(sin.status == 200 && lista(sin.obj["entregables"]).isEmpty)
    }

    @Test("original: base64 hasta 8 MB; más grande devuelve solo la ruta")
    func originalGrande() async throws {
        let f = try await bib()
        let grande = Data(repeating: 0x61, count: 8 * 1_048_576 + 1)
        // por la API de entregables (el límite de subida es 25 MB, así que se prueba con la carpeta de un agente)
        try FileManager.default.createDirectory(atPath: f.ruta("archivos/entregables/marce"), withIntermediateDirectories: true)
        try grande.write(to: URL(fileURLWithPath: f.ruta("archivos/entregables/marce/grande.bin")))
        try Data("chico".utf8).write(to: URL(fileURLWithPath: f.ruta("archivos/entregables/marce/chico.txt")))
        let g = await f.get("/api/biblioteca/entregable", ["agente": "marce", "ruta": "grande.bin"])
        #expect(g.status == 200)
        #expect(g.obj["base64"] == nil)
        #expect(g.obj["tam"] as? Int == grande.count)
        #expect(str(g.obj["ruta"]).hasSuffix("/entregables/marce/grande.bin"))
        #expect(g.obj["mime"] as? String == "application/octet-stream")
        #expect((await f.get("/api/biblioteca/entregable", ["agente": "marce", "ruta": "chico.txt"])).obj["base64"] as? String == Data("chico".utf8).base64EncodedString())
    }

    @Test("rutas de la biblioteca: 404 para lo desconocido y 405 para métodos no permitidos")
    func rutas() async throws {
        let f = try await bib()
        #expect((await f.get("/api/biblioteca/nada")).status == 404)
        #expect((await f.get("/api/archivos/a/b/c")).status == 404)
        #expect((await f.get("/api/archivos/Mal_Id")).status == 404)
        #expect((await f.get("/api/archivos/no-existe")).status == 404)
        #expect((await f.get("/api/archivos/no-existe/original")).status == 404)
        #expect((await llamar(f.b, "PUT", "/api/archivos")).status == 405)
        #expect((await llamar(f.b, "PATCH", "/api/archivos/x")).status == 405)
        #expect((await llamar(f.b, "DELETE", "/api/vinculos")).status == 405)
        #expect((await llamar(f.b, "POST", "/api/biblioteca/estado")).status == 405)
    }
}

}  // extension Etapa2

extension Fix {
    typealias Ag = (id: String, depto: String, rol: String?)
}
