import Foundation

/// Archivos que la persona le pasa a un agente («hacé algo con esta foto»): en el chat, al arrancar una corrida de flujo
/// y en las tareas. Viajan en base64 dentro del JSON (`archivos: [{nombre, base64}]`), se guardan dentro de la oficina en
/// `archivos/adjuntos/<origen>/<AAAAMMDD-HHMMSS>/` y el agente recibe sus rutas (relativas a la oficina, que es su carpeta
/// de trabajo) al final del mensaje, para leerlos con Read (que también lee imágenes y PDF).
enum Adjuntos {
    static let maxArchivos = 10
    /// Tope del total decodificado de un pedido (y por lo tanto de cada archivo).
    static let maxTotal = 25 * 1_048_576
    static let maxNombre = 120
    /// Cuerpo de un pedido con adjuntos: el total en base64 (4/3) más el resto del pedido. Entra en el tope del servidor.
    static let maxBody = maxTotal * 4 / 3 + 300_000
    static let carpeta = "archivos/adjuntos"
    /// Encabezado del bloque de adjuntos en el mensaje (el front lo reconoce para mostrar los archivos).
    static let encabezado = "Archivos adjuntos (leelos con Read antes de responder):"

    /// `archivos` del cuerpo; ausente o null = ninguno. Valida todo antes de guardar nada.
    static func leer(_ v: Any?) throws -> [(nombre: String, datos: Data)] {
        guard let v, !(v is NSNull) else { return [] }
        guard let lista = v as? [Any], lista.allSatisfy({ $0 is [String: Any] }) else {
            throw ErrorAPI(400, "«archivos» tiene que ser una lista de {nombre, base64}.")
        }
        guard lista.count <= maxArchivos else { throw ErrorAPI(400, "Máximo \(maxArchivos) archivos por vez.") }
        var out: [(nombre: String, datos: Data)] = []
        var total = 0
        for case let a as [String: Any] in lista {
            let crudo = try Validar.texto(a["nombre"], "nombre del archivo", max: maxNombre)!
            guard let n = nombreValido(crudo) else {
                throw ErrorAPI(400, "El nombre de archivo «\(crudo)» no es válido (sin «/» ni «..», hasta \(maxNombre) caracteres).")
            }
            guard var b64 = a["base64"] as? String, !b64.isEmpty else { throw ErrorAPI(400, "Falta el contenido de «\(n)» (base64).") }
            if b64.hasPrefix("data:"), let i = b64.firstIndex(of: ",") { b64 = String(b64[b64.index(after: i)...]) }
            if b64.utf8.count > maxTotal * 4 / 3 + 8 {
                throw ErrorAPI(413, "«\(n)» es demasiado grande (el máximo es \(maxTotal / 1_048_576) MB).")
            }
            guard let datos = Data(base64Encoded: b64, options: .ignoreUnknownCharacters), !datos.isEmpty else {
                throw ErrorAPI(400, "El contenido de «\(n)» no es base64 válido.")
            }
            total += datos.count
            guard total <= maxTotal else {
                throw ErrorAPI(413, "Los archivos pesan más de \(maxTotal / 1_048_576) MB en total.")
            }
            out.append((n, datos))
        }
        return out
    }

    /// Nombre de archivo seguro (sin carpetas ni caracteres de control), o nil.
    static func nombreValido(_ n: String) -> String? {
        let t = n.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.count <= maxNombre, t != ".", !t.contains("/"), !t.contains("\\"),
              !t.contains(".."), !t.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
        return t
    }

    /// Guarda los archivos en una carpeta nueva de `archivos/adjuntos/<origen>/` y devuelve sus rutas relativas a la oficina.
    /// `origen`: "chat/<agente>", "flujos/<flujo>", "tareas/<agente>"… (ids ya validados).
    static func guardar(_ act: OficinaActiva, origen: String, _ archivos: [(nombre: String, datos: Data)],
                        ahora: Date = Date()) throws -> [String] {
        guard !archivos.isEmpty else { return [] }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyyyMMdd-HHmmss"
        let padre = "\(carpeta)/\(origen)"
        var rutas: [String] = []
        do {
            try Plantillas.crearDir(act.ruta(padre))
            let dir = Extraccion.rutaLibre(act.ruta(padre), f.string(from: ahora))
            try Plantillas.crearDir(dir)
            let relDir = padre + "/" + (dir as NSString).lastPathComponent
            for a in archivos {
                let destino = Extraccion.rutaLibre(dir, a.nombre)
                try a.datos.write(to: URL(fileURLWithPath: destino), options: .atomic)
                rutas.append(relDir + "/" + (destino as NSString).lastPathComponent)
            }
        } catch { throw ErrorAPI(500, "No pude guardar los archivos adjuntos.") }
        return rutas
    }

    /// Bloque que va al final del mensaje del agente (vacío si no hay adjuntos).
    static func texto(_ rutas: [String]) -> String {
        rutas.isEmpty ? "" : "\n\n\(encabezado)\n" + rutas.map { "- \($0)" }.joined(separator: "\n")
    }

    /// Ruta relativa de un adjunto ya guardado (la que se le puede dejar a una tarea): dentro de `archivos/adjuntos/`.
    static func rutaValida(_ r: String) -> Bool {
        r.hasPrefix(carpeta + "/") && !r.contains("..") && !r.contains("\\") && r.count <= 400
            && !r.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
    }
}
