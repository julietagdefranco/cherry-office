import Foundation

// Explorador de carpetas (para elegir dónde abrir/crear/vincular) y de la carpeta de la oficina (solo lectura).
// Misma API, mismos topes y mismas reglas de seguridad que tools/hq_explorador.py (modo desarrollo): si cambia una, cambia la otra.
//
//   GET  /api/fs/carpetas?ruta=&ocultas=0|1   subcarpetas de una carpeta DENTRO de $HOME (nunca contenido de archivos)
//   POST /api/fs/carpetas {padre, nombre}     crea una subcarpeta dentro de $HOME
//   GET  /api/oficina/archivos?ruta=<rel>     lista de la carpeta de la oficina activa
//   GET  /api/oficina/archivo?ruta=<rel>      vista previa: {texto} (tope 512 KB) o {base64, mime} (imágenes, tope 2 MB)

public struct ExploradorRouter: SubRouter {
    static let maxEntradas = 500
    static let maxTexto = 512 * 1024
    static let maxImagen = 2 * 1024 * 1024
    static let maxNombre = 120
    static let extTexto: Set<String> = ["md", "markdown", "txt", "json", "csv", "tsv", "log"]
    static let extImagen: [String: String] = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"]
    static let rutas: Set<String> = ["/api/fs/carpetas", "/api/oficina/archivos", "/api/oficina/archivo"]

    let config: Config
    let oficinas: Oficinas
    let log: HQLog

    public init(config: Config, oficinas: Oficinas, log: HQLog) {
        self.config = config; self.oficinas = oficinas; self.log = log
    }

    public static func esRuta(_ p: String) -> Bool { rutas.contains(p) }

    public func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)? {
        guard Self.esRuta(path) else { return nil }
        let r: (Int, [String: Any])
        do {
            switch (path, method) {
            case ("/api/fs/carpetas", "GET"): r = (200, try carpetas(query))
            case ("/api/fs/carpetas", "POST"): r = (200, try crearCarpeta(body))
            case ("/api/oficina/archivos", "GET"): r = (200, try await archivos(query))
            case ("/api/oficina/archivo", "GET"): r = (200, try await archivo(query))
            default: r = (405, ["error": "método no permitido"])
            }
        } catch let e as ErrorAPI {
            r = (e.status, ["error": e.mensaje])
        } catch {
            log.error("explorador: error interno")
            r = (500, ["error": "error interno"])
        }
        return (r.0, Router.codificar(r.1))
    }

    // MARK: utilidades puras

    /// `realpath(3)` (resuelve enlaces simbólicos); nil si no existe.
    static func real(_ ruta: String) -> String? {
        guard let p = realpath(ruta, nil) else { return nil }
        defer { free(p) }
        return String(cString: p)
    }

    /// `realpath` de lo que exista: los componentes que faltan se agregan tal cual (como `os.path.realpath` de Python).
    static func realAunqueFalte(_ ruta: String) -> String {
        if let r = real(ruta) { return r }
        let padre = (ruta as NSString).deletingLastPathComponent
        if padre == ruta || padre.isEmpty { return ruta }
        return (realAunqueFalte(padre) as NSString).appendingPathComponent((ruta as NSString).lastPathComponent)
    }

    static func dentro(_ base: String, _ ruta: String) -> Bool {
        ruta == base || ruta.hasPrefix(base.hasSuffix("/") ? base : base + "/")
    }

    static func esDirectorio(_ ruta: String) -> Bool {
        var d: ObjCBool = false
        return FileManager.default.fileExists(atPath: ruta, isDirectory: &d) && d.boolValue
    }

    static func esArchivoRegular(_ ruta: String) -> Bool {
        var d: ObjCBool = false
        return FileManager.default.fileExists(atPath: ruta, isDirectory: &d) && !d.boolValue
    }

    static func esEnlace(_ ruta: String) -> Bool {
        (try? FileManager.default.destinationOfSymbolicLink(atPath: ruta)) != nil
    }

    /// Nombre de carpeta nuevo: sin separadores, `:` ni caracteres de control, sin puntos al principio. "" si no sirve.
    static func nombreSaneado(_ s: String) -> String {
        var t = String(s.unicodeScalars.map { c -> Character in
            (c == "/" || c == "\\" || c == ":" || c.value < 32 || c.value == 127) ? "-" : Character(c)
        })
        t = t.trimmingCharacters(in: .whitespacesAndNewlines)
        while t.hasPrefix(".") { t.removeFirst() }
        t = t.trimmingCharacters(in: .whitespacesAndNewlines)
        return String(t.prefix(maxNombre)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Dentro de la oficina solo se ven los ocultos `.claude` (nivel 0); el resto de los `.algo` queda fuera.
    static func parteOcultaPermitida(_ i: Int, _ parte: String) -> Bool {
        !parte.hasPrefix(".") || (i == 0 && parte == ".claude")
    }

    static func ordenar(_ a: String, _ b: String) -> Bool {
        let (x, y) = (a.lowercased(), b.lowercased())
        return x == y ? a < b : x < y
    }

    // MARK: carpetas dentro de $HOME

    private var home: String { Self.realAunqueFalte(config.home) }

    private func resolverEnHome(_ ruta: String) throws -> String {
        let home = self.home
        if ruta.isEmpty { return home }
        guard !ruta.contains("\0"), ruta.hasPrefix("/") else { throw ErrorAPI(400, "La ruta tiene que ser absoluta.") }
        let real = Self.realAunqueFalte(ruta)
        guard Self.dentro(home, real) else { throw ErrorAPI(403, "Solo se pueden explorar carpetas dentro de tu carpeta personal.") }
        guard FileManager.default.fileExists(atPath: real) else { throw ErrorAPI(404, "No encontré esa carpeta.") }
        guard Self.esDirectorio(real) else { throw ErrorAPI(400, "Eso no es una carpeta.") }
        return real
    }

    private func accesos(_ home: String) -> [[String: Any]] {
        var out: [[String: Any]] = [["nombre": "Inicio", "ruta": home]]
        for (nombre, rel) in [("Escritorio", "Desktop"), ("Documentos", "Documents"), ("Descargas", "Downloads")] {
            let r = Self.realAunqueFalte((home as NSString).appendingPathComponent(rel))
            if Self.dentro(home, r), Self.esDirectorio(r) { out.append(["nombre": nombre, "ruta": r]) }
        }
        let ofi = Self.realAunqueFalte(config.oficinasDir)
        if Self.dentro(home, ofi), Self.esDirectorio(ofi) { out.append(["nombre": "Oficinas", "ruta": ofi]) }
        return out
    }

    private func carpetas(_ q: [String: String]) throws -> [String: Any] {
        let home = self.home
        let real = try resolverEnHome((q["ruta"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
        let ocultas = ["1", "true"].contains(q["ocultas"] ?? "")
        guard var nombres = try? FileManager.default.contentsOfDirectory(atPath: real) else {
            throw ErrorAPI(403, "No tengo permiso para leer esa carpeta.")
        }
        nombres.sort(by: Self.ordenar)
        var lista: [[String: Any]] = []
        var truncado = false
        for n in nombres {
            if !ocultas && n.hasPrefix(".") { continue }
            let p = (real as NSString).appendingPathComponent(n)
            if Self.esEnlace(p), !Self.dentro(home, Self.realAunqueFalte(p)) { continue } // un enlace que sale de $HOME no se muestra
            guard Self.esDirectorio(p) else { continue }
            if lista.count >= Self.maxEntradas { truncado = true; break }
            let esOfi = Self.esArchivoRegular((p as NSString).appendingPathComponent("oficina.json"))
            lista.append(["nombre": n, "ruta": p, "esOficina": esOfi])
        }
        return ["ruta": real, "padre": real == home ? NSNull() : ((real as NSString).deletingLastPathComponent as Any),
                "esOficina": Self.esArchivoRegular((real as NSString).appendingPathComponent("oficina.json")),
                "accesos": accesos(home), "carpetas": lista, "truncado": truncado]
    }

    private func crearCarpeta(_ body: Data?) throws -> [String: Any] {
        guard let body, !body.isEmpty, body.count <= 10_000,
              let d = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let padre = d["padre"] as? String, let nombreCrudo = d["nombre"] as? String
        else { throw ErrorAPI(400, "pedido inválido") }
        let p = padre.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { throw ErrorAPI(400, "Falta la carpeta donde crearla.") }
        let real = try resolverEnHome(p)
        let nombre = Self.nombreSaneado(nombreCrudo)
        guard !nombre.isEmpty, nombre != ".", nombre != ".." else { throw ErrorAPI(400, "Ponele un nombre a la carpeta.") }
        let destino = (real as NSString).appendingPathComponent(nombre)
        if (try? FileManager.default.attributesOfItem(atPath: destino)) != nil || Self.esEnlace(destino) {
            throw ErrorAPI(409, "Ya existe algo con ese nombre.")
        }
        do { try FileManager.default.createDirectory(atPath: destino, withIntermediateDirectories: false) }
        catch { throw ErrorAPI(403, "No pude crear la carpeta ahí.") }
        return ["ok": true, "nombre": nombre, "ruta": destino]
    }

    // MARK: carpeta de la oficina activa (solo lectura)

    private func resolverEnOficina(_ relCruda: String) async throws -> (base: String, real: String, partes: [String]) {
        let act = try await oficinas.requerirActiva()
        let base = Self.realAunqueFalte(act.carpeta)
        var rel = relCruda.trimmingCharacters(in: .whitespacesAndNewlines)
        while rel.hasPrefix("/") { rel.removeFirst() }
        while rel.hasSuffix("/") { rel.removeLast() }
        let prohibido = ErrorAPI(403, "Esa ruta no está permitida.")
        if rel.contains("\0") || rel.contains("\\") || relCruda.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") { throw prohibido }
        let partes = rel.split(separator: "/").map(String.init).filter { $0 != "." }
        for (i, p) in partes.enumerated() where p == ".." || !Self.parteOcultaPermitida(i, p) { throw prohibido }
        let real = partes.isEmpty ? base : Self.realAunqueFalte(partes.reduce(base) { ($0 as NSString).appendingPathComponent($1) })
        guard Self.dentro(base, real) else { throw prohibido }
        guard FileManager.default.fileExists(atPath: real) else { throw ErrorAPI(404, "No encontré eso en la oficina.") }
        return (base, real, partes)
    }

    private func archivos(_ q: [String: String]) async throws -> [String: Any] {
        let (base, real, partes) = try await resolverEnOficina(q["ruta"] ?? "")
        guard Self.esDirectorio(real) else { throw ErrorAPI(400, "Eso no es una carpeta.") }
        guard let nombres = try? FileManager.default.contentsOfDirectory(atPath: real) else {
            throw ErrorAPI(403, "No tengo permiso para leer esa carpeta.")
        }
        struct Fila { var nombre: String; var rel: String; var dir: Bool; var tam: Int64; var mod: Int }
        var filas: [Fila] = []
        for n in nombres {
            guard Self.parteOcultaPermitida(partes.count, n) else { continue }
            if partes == [".claude"] && n != "agents" { continue }
            let r = Self.realAunqueFalte((real as NSString).appendingPathComponent(n))
            guard Self.dentro(base, r), let at = try? FileManager.default.attributesOfItem(atPath: r) else { continue } // enlace que sale de la oficina
            let dir = Self.esDirectorio(r)
            let mod = Int(((at[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)).timeIntervalSince1970)
            filas.append(Fila(nombre: n, rel: (partes + [n]).joined(separator: "/"), dir: dir,
                              tam: dir ? 0 : ((at[.size] as? NSNumber)?.int64Value ?? 0), mod: mod))
        }
        filas.sort { $0.dir != $1.dir ? $0.dir : Self.ordenar($0.nombre, $1.nombre) }
        let truncado = filas.count > Self.maxEntradas
        if truncado { filas = Array(filas.prefix(Self.maxEntradas)) }
        return ["carpeta": base, "ruta": partes.joined(separator: "/"), "truncado": truncado,
                "archivos": filas.map { ["rel": $0.rel, "nombre": $0.nombre, "esCarpeta": $0.dir, "tam": $0.tam, "mod": $0.mod] as [String: Any] }]
    }

    private func archivo(_ q: [String: String]) async throws -> [String: Any] {
        let (base, real, partes) = try await resolverEnOficina(q["ruta"] ?? "")
        guard !partes.isEmpty else { throw ErrorAPI(400, "Falta la ruta del archivo.") }
        guard Self.esArchivoRegular(real) else { throw ErrorAPI(400, "Eso no es un archivo.") }
        let nombre = partes[partes.count - 1]
        let ext = nombre.contains(".") ? (nombre.split(separator: ".", omittingEmptySubsequences: false).last.map { String($0).lowercased() } ?? "") : ""
        let at = (try? FileManager.default.attributesOfItem(atPath: real)) ?? [:]
        let tam = (at[.size] as? NSNumber)?.int64Value ?? 0
        let mod = Int(((at[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)).timeIntervalSince1970)
        var out: [String: Any] = ["rel": partes.joined(separator: "/"), "nombre": nombre, "tam": tam, "mod": mod,
                                  "ruta": partes.reduce(base) { ($0 as NSString).appendingPathComponent($1) }]
        guard let fh = FileHandle(forReadingAtPath: real) else { throw ErrorAPI(403, "No tengo permiso para leer ese archivo.") }
        defer { try? fh.close() }
        if Self.extTexto.contains(ext) {
            let datos = (try? fh.read(upToCount: Self.maxTexto + 1)) ?? Data()
            out["truncado"] = datos.count > Self.maxTexto
            out["texto"] = String(decoding: datos.prefix(Self.maxTexto), as: UTF8.self)
        } else if let mime = Self.extImagen[ext] {
            if tam > Self.maxImagen { throw ErrorAPI(413, "La imagen es demasiado grande para la vista previa (máximo 2 MB).") }
            out["base64"] = ((try? fh.readToEnd()) ?? Data()).base64EncodedString()
            out["mime"] = mime
        } else {
            out["sinVista"] = true
        }
        return out
    }
}
