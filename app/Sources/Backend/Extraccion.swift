import Foundation
import CryptoKit
import PDFKit

// Extracción de texto de los archivos de la biblioteca y utilidades de archivos (nombres seguros, hash, tipos).
// Misma lógica que tools/hq_biblioteca.py (modo desarrollo): si cambia una, cambia la otra.

enum TipoArchivo {
    static let pdf = "pdf"
    static let documentos: Set<String> = ["docx", "doc", "rtf", "pages", "odt"]
    static let planos: Set<String> = ["txt", "md", "csv", "tsv", "json"]
    static let imagenes: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic"]
    static var soportados: Set<String> { documentos.union(planos).union(imagenes).union([pdf]) }
    static var lista: String { soportados.sorted().map { "." + $0 }.joined(separator: " ") }

    static func extension_(_ nombre: String) -> String { (nombre as NSString).pathExtension.lowercased() }

    static func mime(_ ext: String) -> String {
        switch ext {
        case "pdf": return "application/pdf"
        case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        case "doc": return "application/msword"
        case "rtf": return "application/rtf"
        case "odt": return "application/vnd.oasis.opendocument.text"
        case "pages": return "application/vnd.apple.pages"
        case "txt": return "text/plain; charset=utf-8"
        case "md": return "text/markdown; charset=utf-8"
        case "csv": return "text/csv; charset=utf-8"
        case "tsv": return "text/tab-separated-values; charset=utf-8"
        case "json": return "application/json"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        default: return "application/octet-stream"
        }
    }
}

enum Extraccion {
    /// Texto máximo que se guarda por documento (caracteres).
    static let maxTexto = 2_000_000

    struct Resultado: Sendable {
        var texto: String?
        var aviso: String?
        /// Es una imagen: el texto sale de describirla con Claude.
        var necesitaVision = false
    }

    // MARK: nombres

    /// Nombre de archivo seguro: sin rutas, sin `..`, sin caracteres de control ni `:`, sin punto inicial, hasta 120 caracteres.
    static func nombreSeguro(_ crudo: String) -> String {
        var s = crudo.replacingOccurrences(of: "\\", with: "/")
        if let i = s.lastIndex(of: "/") { s = String(s[s.index(after: i)...]) }
        s = String(s.unicodeScalars.map { u -> Character in
            (u.value < 32 || u.value == 127 || u == ":" || u == "*" || u == "?" || u == "\"" || u == "<" || u == ">" || u == "|") ? "-" : Character(u)
        })
        s = s.replacingOccurrences(of: "..", with: ".")
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasPrefix(".") { s.removeFirst() }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.count > 120 {
            let ext = (s as NSString).pathExtension
            let base = (s as NSString).deletingPathExtension
            let tope = max(1, 119 - ext.count)
            s = String(base.prefix(tope)) + (ext.isEmpty ? "" : "." + ext)
        }
        return s.isEmpty ? "archivo" : s
    }

    /// `ruta` sin pisar nada que exista: `nombre.ext`, `nombre-2.ext`, ...
    static func rutaLibre(_ dir: String, _ nombre: String) -> String {
        let fm = FileManager.default
        var cand = (dir as NSString).appendingPathComponent(nombre)
        var n = 2
        let base = (nombre as NSString).deletingPathExtension, ext = (nombre as NSString).pathExtension
        while fm.fileExists(atPath: cand) {
            cand = (dir as NSString).appendingPathComponent(base + "-\(n)" + (ext.isEmpty ? "" : "." + ext))
            n += 1
        }
        return cand
    }

    // MARK: hash

    static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    static func sha256(archivo path: String) -> String? {
        guard let fh = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? fh.close() }
        var h = SHA256()
        while true {
            guard let d = try? fh.read(upToCount: 1 << 20), !d.isEmpty else { break }
            h.update(data: d)
        }
        return h.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: texto

    static func texto(de ruta: String, ext: String) -> Resultado {
        var r = Resultado()
        switch ext {
        case _ where TipoArchivo.imagenes.contains(ext):
            r.necesitaVision = true
        case TipoArchivo.pdf:
            guard let doc = PDFDocument(url: URL(fileURLWithPath: ruta)) else { r.aviso = "No pude abrir el PDF."; return r }
            if doc.isLocked { r.aviso = "El PDF está protegido con contraseña."; return r }
            let t = (doc.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { r.aviso = "El PDF no tiene texto (¿es un escaneo?)." } else { r.texto = t }
        case _ where TipoArchivo.documentos.contains(ext):
            guard FileManager.default.isExecutableFile(atPath: "/usr/bin/textutil") else {
                r.aviso = "No encuentro textutil para leer este tipo de documento."
                return r
            }
            let res = try? RunningProcess().run(exe: "/usr/bin/textutil", args: ["-convert", "txt", "-stdout", ruta], cwd: nil,
                                                env: ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"], timeout: 60,
                                                onStart: {}, onEnd: {})
            if let res, res.rc == 0, !res.timedOut {
                let t = res.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                if t.isEmpty { r.aviso = "El documento no tiene texto." } else { r.texto = t }
            } else {
                r.aviso = "No pude leer el texto de este documento (.\(ext))."
            }
        default:
            guard let d = FileManager.default.contents(atPath: ruta) else { r.aviso = "No pude leer el archivo."; return r }
            let t = (String(data: d, encoding: .utf8) ?? String(data: d, encoding: .isoLatin1) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { r.aviso = "El archivo está vacío." } else { r.texto = t }
        }
        if let t = r.texto, t.count > maxTexto { r.texto = String(t.prefix(maxTexto)) }
        return r
    }

    // MARK: escaneo de carpetas vinculadas

    struct Hallado: Sendable { var ruta: String; var tam: Int64; var hash: String }

    struct Escaneo: Sendable {
        var hallados: [Hallado] = []
        /// Archivos soportados que no entraron (demasiado grandes o por pasar el tope).
        var omitidos = 0
        var tope = false
    }

    /// Recorre `raiz` (sin ocultos ni enlaces simbólicos), solo extensiones soportadas, con tope de archivos y de bytes.
    static func escanear(raiz: String, maxArchivos: Int, maxBytes: Int64, maxArchivoBytes: Int64) -> Escaneo {
        var out = Escaneo()
        let fm = FileManager.default
        guard let en = fm.enumerator(at: URL(fileURLWithPath: raiz), includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey, .isSymbolicLinkKey],
                                     options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return out }
        var candidatos: [(String, Int64)] = []
        for case let u as URL in en {
            guard let v = try? u.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .isSymbolicLinkKey]),
                  v.isSymbolicLink != true, v.isRegularFile == true else { continue }
            guard TipoArchivo.soportados.contains(u.pathExtension.lowercased()) else { continue }
            candidatos.append((u.path, Int64(v.fileSize ?? 0)))
        }
        candidatos.sort { $0.0 < $1.0 }
        var total: Int64 = 0
        for (p, tam) in candidatos {
            if tam > maxArchivoBytes { out.omitidos += 1; continue }
            if out.hallados.count >= maxArchivos || total + tam > maxBytes { out.omitidos += 1; out.tope = true; continue }
            guard let h = sha256(archivo: p) else { out.omitidos += 1; continue }
            total += tam
            out.hallados.append(Hallado(ruta: p, tam: tam, hash: h))
        }
        return out
    }
}

// MARK: - claude con solo lectura (imágenes)

extension ClaudeRunner {
    /// Un `claude -p` SIN agente con la herramienta `Read` y carpetas extra (`--add-dir`): para describir imágenes.
    func correrConLectura(prompt: String, cwd: String, dirs: [String], timeout: TimeInterval,
                          obs: Observador? = nil) async throws -> String {
        try verificar(carpeta: cwd)
        var a = ["-p"] + Self.formatoSalida + ["--tools", "Read"]
        for d in dirs { a += ["--add-dir", d] }
        a += ["--allowedTools", "Read"] + Self.sinConectores
        return try await resultado(a + ["--", prompt], timeout: timeout, cwd: cwd, obs: obs)
    }
}
