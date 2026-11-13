import Foundation

// Exportar una oficina a un .zip y volver a importarla (en esta u otra Mac).
//
//   POST /api/oficina/exportar  {destino?}  → {archivo, nombre, tam, documentos, omitidos:{vinculos, papelera}, avisos}
//   POST /api/oficinas/importar {archivo}   → {carpeta, oficina, documentos, reprocesar, avisos}
//
// El .zip lleva la carpeta de la oficina (agentes, conocimiento, actas, archivos subidos y entregables) más
// `.oficina-paquete.json`, con las filas de la biblioteca (ficha incluida) para que al importarla no haya que volver a
// fichar nada. No lleva lo que vive en `hq.db` (chats, estado de reuniones, entregas, costos), ni la papelera, ni las
// carpetas vinculadas (son rutas de la otra Mac). La ruta absoluta de la oficina en los textos viaja como `{{OFICINA}}`.

public final class PaqueteRouter: SubRouter, Sendable {
    static let manifiesto = ".oficina-paquete.json"
    static let marcador = "{{OFICINA}}"
    static let formato = 1
    static let extension_ = ".oficina.zip"
    /// Topes del zip a importar: tamaño del archivo, total descomprimido y cantidad de entradas.
    static let maxZip: Int64 = 2 * 1024 * 1024 * 1024
    static let maxDescomprimido: Int64 = 4 * 1024 * 1024 * 1024
    static let maxEntradas = 50_000
    /// Carpetas cuyos textos pueden mencionar la ruta de la oficina (los documentos del usuario no se tocan).
    static let carpetasConRutas = [".claude", "conocimiento", "reuniones"]
    static let extensionesTexto: Set<String> = ["md", "txt", "json"]

    private let config: Config
    private let store: Store
    private let oficinas: Oficinas
    private let biblioteca: BibliotecaRouter
    private let log: HQLog

    init(config: Config, store: Store, oficinas: Oficinas, biblioteca: BibliotecaRouter, log: HQLog) {
        self.config = config; self.store = store; self.oficinas = oficinas; self.biblioteca = biblioteca; self.log = log
    }

    public static func esRuta(_ p: String) -> Bool { p == "/api/oficina/exportar" || p == "/api/oficinas/importar" }

    public func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)? {
        guard Self.esRuta(path) else { return nil }
        guard method == "POST" else { return (405, Router.codificar(["error": "método no permitido"])) }
        do {
            let obj = path == "/api/oficina/exportar" ? try await exportar(body) : try await importar(body)
            return (200, Router.codificar(obj))
        } catch let e as ErrorAPI {
            return (e.status, Router.codificar(["error": e.mensaje]))
        } catch {
            log.error("paquete: \(error)")
            return (500, Router.codificar(["error": "No pude completar la operación."]))
        }
    }

    // MARK: exportar

    func exportar(_ body: Data?) async throws -> [String: Any] {
        let act = try await oficinas.requerirActiva()
        let d = try Self.objeto(body, opcional: true)
        let destino = try carpetaDestino(try Validar.texto(d["destino"], "destino", max: 1024, obligatorio: false))

        let filas = try await biblioteca.filasParaExportar(carpeta: act.carpeta)
        let subidos = filas.filter { $0.origen == "subido" && Self.rutaDocumentoValida($0.ruta) }
        let deVinculos = filas.filter { $0.origen != "subido" }.map(\.slug)

        let fm = FileManager.default
        let tmp = (NSTemporaryDirectory() as NSString).appendingPathComponent("oficina-exportar-\(UUID().uuidString)")
        defer { try? fm.removeItem(atPath: tmp) }
        let raiz = Oficinas.carpetaLibre(base: tmp, nombre: act.oficina.nombre)
        let papelera = try Self.copiar(act.carpeta, a: raiz)

        // lo de las carpetas vinculadas no viaja: sus fichas y su texto apuntan a archivos de esta Mac
        for slug in deVinculos where Self.slugValido(slug) {
            try? fm.removeItem(atPath: (raiz as NSString).appendingPathComponent("conocimiento/fuentes/\(slug).md"))
            try? fm.removeItem(atPath: (raiz as NSString).appendingPathComponent("archivos/.texto/\(slug).md"))
        }
        var of = act.oficina
        let vinculos = of.vinculos?.count ?? 0
        of.vinculos = nil
        try OficinaStore.escribir(of, carpeta: raiz)
        try Self.escribirTexto(Biblioteca.catalogoMD(subidos, oficina: of), en: (raiz as NSString).appendingPathComponent("conocimiento/archivos.md"))

        // la ruta de la oficina viaja como marcador; las demás rutas de esta Mac quedan y se avisan
        let carpetas = Set([act.carpeta, ExploradorRouter.realAunqueFalte(act.carpeta)])
        Self.reemplazarEnTextos(raiz, carpetas.map { ($0, Self.marcador) })
        let avisos = Self.avisosRutas(raiz, oficina: of, existe: { _ in false })

        let manifiesto: [String: Any] = [
            "formato": Self.formato, "app": "oficina", "version": config.version, "exportada": ReunionesRouter.iso(Date().timeIntervalSince1970),
            "nombre": of.nombre, "archivos": subidos.map(Self.filaJSON),
        ]
        try JSONSerialization.data(withJSONObject: manifiesto, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            .write(to: URL(fileURLWithPath: (raiz as NSString).appendingPathComponent(Self.manifiesto)))

        let zip = Self.archivoLibre(en: destino, nombre: (raiz as NSString).lastPathComponent)
        let (ok, salida) = Self.correr("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--noextattr", "--keepParent", raiz, zip])
        guard ok else {
            try? fm.removeItem(atPath: zip)
            log.error("exportar: ditto falló: \(salida)")
            throw ErrorAPI(500, "No pude armar el archivo .zip.")
        }
        let tam = ((try? fm.attributesOfItem(atPath: zip))?[.size] as? NSNumber)?.int64Value ?? 0
        log.info("oficina exportada documentos=\(subidos.count) vinculos=\(vinculos) tam=\(tam)")
        return ["archivo": zip, "nombre": (zip as NSString).lastPathComponent, "tam": tam, "documentos": subidos.count,
                "omitidos": ["vinculos": vinculos, "papelera": papelera], "avisos": avisos]
    }

    /// Carpeta donde dejar el .zip: la pedida (absoluta, tiene que existir) o Descargas (o la carpeta personal).
    func carpetaDestino(_ pedido: String?) throws -> String {
        let fm = FileManager.default
        var esDir: ObjCBool = false
        if let p = pedido?.trimmingCharacters(in: .whitespaces), !p.isEmpty {
            guard p.hasPrefix("/") || p == "~" || p.hasPrefix("~/") else { throw ErrorAPI(400, "La carpeta tiene que ser una ruta absoluta.") }
            let r = Config.ruta(p, home: config.home)
            guard fm.fileExists(atPath: r, isDirectory: &esDir), esDir.boolValue else { throw ErrorAPI(404, "No encuentro esa carpeta.") }
            guard fm.isWritableFile(atPath: r) else { throw ErrorAPI(403, "No puedo escribir en esa carpeta.") }
            return r
        }
        let descargas = (config.home as NSString).appendingPathComponent("Downloads")
        if fm.fileExists(atPath: descargas, isDirectory: &esDir), esDir.boolValue { return descargas }
        return config.home
    }

    // MARK: importar

    func importar(_ body: Data?) async throws -> [String: Any] {
        let d = try Self.objeto(body, opcional: false)
        let pedido = try Validar.texto(d["archivo"], "archivo", max: 1024)!.trimmingCharacters(in: .whitespaces)
        guard pedido.hasPrefix("/") || pedido.hasPrefix("~/") else { throw ErrorAPI(400, "El archivo tiene que ser una ruta absoluta.") }
        let zip = Config.ruta(pedido, home: config.home)
        let fm = FileManager.default
        var esDir: ObjCBool = false
        guard fm.fileExists(atPath: zip, isDirectory: &esDir), !esDir.boolValue else { throw ErrorAPI(404, "No encuentro ese archivo.") }
        guard zip.lowercased().hasSuffix(".zip") else { throw ErrorAPI(400, "Elegí un archivo .zip exportado desde Oficina.") }
        let tam = ((try? fm.attributesOfItem(atPath: zip))?[.size] as? NSNumber)?.int64Value ?? 0
        guard tam <= Self.maxZip else { throw ErrorAPI(413, "El archivo es demasiado grande (máximo 2 GB).") }
        try Self.revisarZip(zip)

        let tmp = (NSTemporaryDirectory() as NSString).appendingPathComponent("oficina-importar-\(UUID().uuidString)")
        defer { try? fm.removeItem(atPath: tmp) }
        try fm.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        let (ok, salida) = Self.correr("/usr/bin/ditto", ["-x", "-k", "--norsrc", "--noextattr", "--noqtn", zip, tmp])
        guard ok else {
            log.warn("importar: ditto falló: \(salida)")
            throw ErrorAPI(400, "No pude descomprimir ese archivo.")
        }
        Self.quitarEnlaces(tmp)
        guard let raiz = Self.buscarRaiz(tmp) else {
            throw ErrorAPI(400, "Ese .zip no tiene una oficina adentro (falta oficina.json).")
        }
        var of = try OficinaStore.leer(carpeta: raiz)

        try fm.createDirectory(atPath: config.oficinasDir, withIntermediateDirectories: true)
        let dest = Oficinas.carpetaLibre(base: config.oficinasDir, nombre: of.nombre)
        do { try fm.moveItem(atPath: raiz, toPath: dest) }
        catch { throw ErrorAPI(500, "No pude crear la carpeta de la oficina.") }

        var avisos: [String] = []
        let pathManifiesto = (dest as NSString).appendingPathComponent(Self.manifiesto)
        let manifiesto = fm.contents(atPath: pathManifiesto).flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
        try? fm.removeItem(atPath: pathManifiesto)
        if manifiesto == nil { avisos.append("El archivo no trae el índice de la biblioteca: los documentos están en la carpeta, pero no aparecen en la Biblioteca.") }
        // la marca de Próspera reclama los chats viejos de esta Mac: una oficina importada no la necesita
        try? fm.removeItem(atPath: (dest as NSString).appendingPathComponent(ImportarProspera.marca))

        if let vs = of.vinculos, !vs.isEmpty {
            let quedan = vs.filter { fm.fileExists(atPath: $0.ruta) }
            if quedan.count < vs.count {
                avisos.append("Se quitaron \(vs.count - quedan.count) carpeta(s) vinculada(s) que no existen en esta Mac.")
                of.vinculos = quedan.isEmpty ? nil : quedan
                try OficinaStore.escribir(of, carpeta: dest)
            }
        }
        Self.reemplazarEnTextos(dest, [(Self.marcador, dest)])
        avisos += Self.avisosRutas(dest, oficina: of, existe: { fm.fileExists(atPath: $0) })

        let ahora = Date().timeIntervalSince1970
        var filas: [ArchivoFila] = []
        var usados = Set<String>()
        for o in (manifiesto?["archivos"] as? [[String: Any]]) ?? [] {
            guard var f = Self.filaDesde(o, oficina: dest, ahora: ahora), !usados.contains(f.slug),
                  fm.fileExists(atPath: (dest as NSString).appendingPathComponent(f.ruta)) else { continue }
            let hayTexto = fm.fileExists(atPath: (dest as NSString).appendingPathComponent("archivos/.texto/\(f.slug).md"))
            f.estado = (f.ficha != nil && hayTexto) ? "listo" : "pendiente"
            usados.insert(f.slug)
            filas.append(f)
        }
        let (listos, pendientes) = try await biblioteca.importarFilas(filas, carpeta: dest, oficina: of)
        if pendientes > 0 { avisos.append("\(pendientes) documento(s) se van a volver a fichar (hace falta Claude Code).") }

        let act = try await oficinas.abrir(carpeta: dest)
        log.info("oficina importada documentos=\(listos) reprocesar=\(pendientes) avisos=\(avisos.count)")
        var r = Router.sobreOficina(act)
        r["documentos"] = listos + pendientes; r["reprocesar"] = pendientes; r["avisos"] = avisos
        return r
    }

    /// Revisa la lista del zip antes de extraer nada: sin rutas absolutas ni `..`, sin enlaces simbólicos y dentro de los topes.
    static func revisarZip(_ zip: String) throws {
        let (ok1, nombres) = correr("/usr/bin/zipinfo", ["-1", zip])
        guard ok1 else { throw ErrorAPI(400, "Ese archivo no es un .zip válido.") }
        let lista = nombres.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        guard !lista.isEmpty else { throw ErrorAPI(400, "El .zip está vacío.") }
        guard lista.count <= maxEntradas else { throw ErrorAPI(413, "El .zip tiene demasiados archivos.") }
        for n in lista {
            let partes = n.split(separator: "/", omittingEmptySubsequences: false)
            if n.hasPrefix("/") || n.contains("\\") || n.contains("\0") || partes.contains("..") {
                throw ErrorAPI(400, "El .zip tiene rutas inválidas; no lo importo.")
            }
        }
        let (ok2, largo) = correr("/usr/bin/zipinfo", [zip])
        guard ok2 else { throw ErrorAPI(400, "Ese archivo no es un .zip válido.") }
        for linea in largo.split(separator: "\n") where linea.hasPrefix("l") && linea.count > 10 {
            // «lrwxr-xr-x  3.0 unx …»: un enlace simbólico podría apuntar fuera de la carpeta
            if linea.dropFirst().prefix(9).allSatisfy({ "rwx-sStT".contains($0) }) {
                throw ErrorAPI(400, "El .zip trae enlaces simbólicos; no lo importo.")
            }
        }
        if let total = largo.split(separator: "\n").last, let bytes = descomprimido(String(total)), bytes > maxDescomprimido {
            throw ErrorAPI(413, "El .zip descomprimido pesa demasiado (máximo 4 GB).")
        }
    }

    /// Bytes descomprimidos de la última línea de `zipinfo` («12 files, 3456 bytes uncompressed, …»).
    static func descomprimido(_ linea: String) -> Int64? {
        let t = linea.split(separator: " ").map(String.init)
        guard let i = t.firstIndex(of: "uncompressed,") ?? t.firstIndex(of: "uncompressed"), i >= 2, t[i - 1] == "bytes" else { return nil }
        return Int64(t[i - 2])
    }

    /// La carpeta con `oficina.json`: la raíz del zip o su única carpeta (sin contar `__MACOSX` ni ocultos).
    static func buscarRaiz(_ tmp: String) -> String? {
        if OficinaStore.existe(tmp) { return tmp }
        let fm = FileManager.default
        let hijos = ((try? fm.contentsOfDirectory(atPath: tmp)) ?? []).filter { !$0.hasPrefix(".") && $0 != "__MACOSX" }
        let dirs = hijos.map { (tmp as NSString).appendingPathComponent($0) }.filter { ExploradorRouter.esDirectorio($0) }
        guard dirs.count == 1, OficinaStore.existe(dirs[0]) else { return nil }
        return dirs[0]
    }

    // MARK: archivos

    /// Copia la carpeta de la oficina a `destino` sin seguir enlaces simbólicos y sin la papelera ni los `.DS_Store`.
    /// Devuelve true si la papelera tenía algo (quedó afuera).
    static func copiar(_ origen: String, a destino: String) throws -> Bool {
        let fm = FileManager.default
        try fm.createDirectory(atPath: destino, withIntermediateDirectories: true)
        var papelera = false
        guard let en = fm.enumerator(atPath: origen) else { throw ErrorAPI(500, "No pude leer la carpeta de la oficina.") }
        while let rel = en.nextObject() as? String {
            let nombre = (rel as NSString).lastPathComponent
            let tipo = en.fileAttributes?[.type] as? FileAttributeType
            if rel == "archivos/.papelera" {
                papelera = !((try? fm.contentsOfDirectory(atPath: (origen as NSString).appendingPathComponent(rel))) ?? []).isEmpty
                en.skipDescendants()
                try fm.createDirectory(atPath: (destino as NSString).appendingPathComponent(rel), withIntermediateDirectories: true)
                continue
            }
            if nombre == ".DS_Store" || rel == ImportarProspera.marca || tipo == .typeSymbolicLink { continue }
            let src = (origen as NSString).appendingPathComponent(rel), dst = (destino as NSString).appendingPathComponent(rel)
            if tipo == .typeDirectory {
                try fm.createDirectory(atPath: dst, withIntermediateDirectories: true)
            } else if tipo == .typeRegular {
                do { try fm.copyItem(atPath: src, toPath: dst) }
                catch { throw ErrorAPI(500, "No pude copiar «\(rel)».") }
            }
        }
        return papelera
    }

    /// Borra los enlaces simbólicos que haya dejado la extracción (el zip ya se revisó; esto es por las dudas).
    static func quitarEnlaces(_ dir: String) {
        let fm = FileManager.default
        guard let en = fm.enumerator(atPath: dir) else { return }
        var enlaces: [String] = []
        while let rel = en.nextObject() as? String {
            if en.fileAttributes?[.type] as? FileAttributeType == .typeSymbolicLink { enlaces.append(rel) }
        }
        for rel in enlaces { try? fm.removeItem(atPath: (dir as NSString).appendingPathComponent(rel)) }
    }

    /// Reemplaza textos (p. ej. la ruta de la oficina por el marcador) en los .md/.txt/.json de agentes, conocimiento y actas.
    static func reemplazarEnTextos(_ raiz: String, _ pares: [(String, String)]) {
        let pares = pares.filter { !$0.0.isEmpty && $0.0 != $0.1 }.sorted { $0.0.count > $1.0.count }
        guard !pares.isEmpty else { return }
        for p in archivosDeTexto(raiz) {
            guard let t = try? String(contentsOfFile: p, encoding: .utf8) else { continue }
            var n = t
            for (de, a) in pares { n = n.replacingOccurrences(of: de, with: a) }
            if n != t { try? Data(n.utf8).write(to: URL(fileURLWithPath: p), options: .atomic) }
        }
    }

    static func archivosDeTexto(_ raiz: String) -> [String] {
        let fm = FileManager.default
        var out: [String] = []
        for c in carpetasConRutas {
            let base = (raiz as NSString).appendingPathComponent(c)
            guard let en = fm.enumerator(atPath: base) else { continue }
            while let rel = en.nextObject() as? String {
                guard en.fileAttributes?[.type] as? FileAttributeType == .typeRegular,
                      extensionesTexto.contains((rel as NSString).pathExtension.lowercased()) else { continue }
                out.append((base as NSString).appendingPathComponent(rel))
            }
        }
        return out.sorted()
    }

    /// Agentes cuyo `.md` menciona rutas absolutas de una carpeta personal (`/Users/...`) que `existe` no encuentra.
    static func avisosRutas(_ raiz: String, oficina: Oficina, existe: (String) -> Bool) -> [String] {
        var out: [String] = []
        for a in oficina.agentes {
            let p = (raiz as NSString).appendingPathComponent(".claude/agents/\(a.id).md")
            guard let t = try? String(contentsOfFile: p, encoding: .utf8) else { continue }
            let rutas = rutasAbsolutas(t).filter { !existe($0) }
            if !rutas.isEmpty {
                out.append("«\(a.nombre)» menciona rutas de otra compu (por ejemplo \(rutas[0])). Revisá sus instrucciones.")
            }
        }
        return out
    }

    /// Rutas `/Users/<usuario>/...` que aparecen en el texto (hasta un espacio, comilla, paréntesis o fin de línea).
    static func rutasAbsolutas(_ t: String) -> [String] {
        var out: [String] = []
        var resto = t[...]
        while let r = resto.range(of: "/Users/") {
            if r.lowerBound > resto.startIndex, let prev = resto[resto.index(before: r.lowerBound)...].first,
               prev.isLetter || prev.isNumber || prev == "." { resto = resto[r.upperBound...]; continue }
            var fin = r.upperBound
            while fin < resto.endIndex, !" \t\n\"'`)]>*,;".contains(resto[fin]) { fin = resto.index(after: fin) }
            var ruta = String(resto[r.lowerBound..<fin])
            while ruta.hasSuffix(".") || ruta.hasSuffix(":") { ruta.removeLast() }
            if ruta.count > "/Users/".count, !out.contains(ruta) { out.append(ruta) }
            resto = resto[fin...]
        }
        return out
    }

    static func archivoLibre(en dir: String, nombre: String) -> String {
        let fm = FileManager.default
        var cand = (dir as NSString).appendingPathComponent(nombre + extension_)
        var n = 2
        while fm.fileExists(atPath: cand) {
            cand = (dir as NSString).appendingPathComponent("\(nombre) \(n)" + extension_)
            n += 1
        }
        return cand
    }

    static func escribirTexto(_ t: String, en p: String) throws {
        try Plantillas.crearDir((p as NSString).deletingLastPathComponent)
        try OficinaStore.escribirAtomico(Data(t.utf8), en: p)
    }

    // MARK: filas de la biblioteca

    static func rutaDocumentoValida(_ r: String) -> Bool {
        r.hasPrefix("archivos/") && !r.hasPrefix("archivos/.") && !r.contains("\0") && !r.contains("\\")
            && !r.split(separator: "/").contains("..")
    }

    static func slugValido(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 200 && !s.contains("/") && !s.contains("\\") && !s.contains("\0") && !s.hasPrefix(".")
    }

    static func filaJSON(_ f: ArchivoFila) -> [String: Any] {
        var o: [String: Any] = ["slug": f.slug, "nombre": f.nombre, "departamento": f.departamento, "ruta": f.ruta, "tipo": f.tipo,
                                "tam": f.tam, "hash": f.hash, "creado": f.creado]
        if let fi = f.ficha { o["ficha"] = fi.json }
        if let a = f.aviso { o["aviso"] = a }
        return o
    }

    static func filaDesde(_ o: [String: Any], oficina: String, ahora: Double) -> ArchivoFila? {
        guard let slug = o["slug"] as? String, slugValido(slug), let ruta = o["ruta"] as? String, rutaDocumentoValida(ruta) else { return nil }
        let nombre = (o["nombre"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (ruta as NSString).lastPathComponent
        let tipo = (o["tipo"] as? String) ?? (ruta as NSString).pathExtension.lowercased()
        return ArchivoFila(slug: slug, oficina: oficina, nombre: String(nombre.prefix(200)), departamento: (o["departamento"] as? String) ?? "compartido",
                           ruta: ruta, origen: "subido", vinculo: nil, tipo: tipo, tam: (o["tam"] as? NSNumber)?.int64Value ?? 0,
                           hash: (o["hash"] as? String) ?? "", estado: "pendiente", error: nil, aviso: o["aviso"] as? String,
                           ficha: (o["ficha"] as? [String: Any]).map(Ficha.desde), creado: (o["creado"] as? NSNumber)?.doubleValue ?? ahora,
                           actualizado: ahora)
    }

    // MARK: utilidades

    static func objeto(_ body: Data?, opcional: Bool) throws -> [String: Any] {
        guard let body, !body.isEmpty else {
            if opcional { return [:] }
            throw ErrorAPI(400, "Falta el cuerpo del pedido.")
        }
        guard let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { throw ErrorAPI(400, "JSON inválido.") }
        return o
    }

    /// Corre un programa del sistema y devuelve (terminó bien, salida estándar + error).
    static func correr(_ exe: String, _ args: [String]) -> (Bool, String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        let salida = Pipe()
        p.standardOutput = salida
        p.standardError = salida
        do { try p.run() } catch { return (false, "\(error)") }
        let data = salida.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus == 0, String(decoding: data, as: UTF8.self))
    }
}

// MARK: - biblioteca

extension BibliotecaRouter {
    /// Filas de la biblioteca de la oficina (sin la papelera), para el manifiesto del paquete.
    func filasParaExportar(carpeta: String) async throws -> [ArchivoFila] {
        try await preparar()
        return await store.archivos(oficina: carpeta)
    }

    /// Registra los documentos de una oficina importada: los que traen ficha y texto quedan `listo` (y se indexan); el resto,
    /// `pendiente`, y el trabajador los vuelve a fichar. Regenera el catálogo.
    func importarFilas(_ filas: [ArchivoFila], carpeta: String, oficina: Oficina) async throws -> (listos: Int, pendientes: Int) {
        try await preparar()
        var listos = 0, pendientes = 0
        for f in filas {
            try await store.archivoGuardar(f)
            if f.estado == "listo", let fi = f.ficha {
                let texto = (try? String(contentsOfFile: (carpeta as NSString).appendingPathComponent("archivos/.texto/\(f.slug).md"), encoding: .utf8)) ?? ""
                try? await store.indiceGuardar(f.slug, oficina: carpeta, titulo: [fi.titulo, f.nombre].joined(separator: " "),
                                               resumen: fi.resumen, temas: fi.temas.joined(separator: " "), texto: texto)
                listos += 1
            } else {
                pendientes += 1
            }
        }
        let todas = await store.archivos(oficina: carpeta)
        try? PaqueteRouter.escribirTexto(Biblioteca.catalogoMD(todas, oficina: oficina),
                                         en: (carpeta as NSString).appendingPathComponent("conocimiento/archivos.md"))
        if pendientes > 0 { despertar() }
        return (listos, pendientes)
    }
}
