import Foundation

/// Carpetas y archivos de una oficina, y la plantilla fija de los `.md` de agente.
public enum Plantillas {
    public static let marcaMemoria = "## Memoria de la oficina"

    // MARK: estructura de carpetas

    static func crearDir(_ p: String) throws {
        try FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true)
    }

    /// Crea `conocimiento/` (oficina.md, decisiones.md, agentes/), `reuniones/`, `archivos/` y
    /// `.claude/agents/`. Nunca pisa un archivo que ya existe.
    /// Carpetas de la biblioteca (ver `Biblioteca.swift`): material compartido, entregables de los agentes, texto
    /// extraído, papelera y fichas de los documentos.
    static let carpetasBiblioteca = ["archivos/compartido", "archivos/entregables", "archivos/.texto", "archivos/.papelera",
                                     "conocimiento/fuentes"]

    static func crearEstructura(carpeta: String, oficina: Oficina) throws {
        for d in ["conocimiento/agentes", "reuniones", "archivos", ".claude/agents"] + carpetasBiblioteca
            + oficina.departamentos.map({ "archivos/\($0.id)" }) {
            try crearDir((carpeta as NSString).appendingPathComponent(d))
        }
        try escribirSiFalta(carpeta, "conocimiento/archivos.md", archivosMD())
        try escribirSiFalta(carpeta, "conocimiento/oficina.md", oficinaMD(nombre: oficina.nombre, duenio: oficina.duenio))
        try escribirSiFalta(carpeta, "conocimiento/decisiones.md", decisionesMD(nombre: oficina.nombre))
    }

    /// Al abrir una oficina existente: recrea las carpetas que falten (sin tocar contenido).
    static func completarEstructura(carpeta: String) throws {
        for d in ["conocimiento/agentes", "reuniones", "archivos", ".claude/agents"] + carpetasBiblioteca {
            try crearDir((carpeta as NSString).appendingPathComponent(d))
        }
        try escribirSiFalta(carpeta, "conocimiento/archivos.md", archivosMD())
    }

    static func escribirSiFalta(_ carpeta: String, _ rel: String, _ texto: String) throws {
        let p = (carpeta as NSString).appendingPathComponent(rel)
        if FileManager.default.fileExists(atPath: p) { return }
        try crearDir((p as NSString).deletingLastPathComponent)
        try Data(texto.utf8).write(to: URL(fileURLWithPath: p))
    }

    // MARK: textos

    public static func oficinaMD(nombre: String, duenio: String) -> String {
        """
        # \(nombre)

        Memoria común de la oficina. Todos los agentes la leen al empezar; la edita \(duenio.isEmpty ? "el dueño" : duenio) y se completa con las decisiones de las reuniones.

        - **Oficina:** \(nombre)
        - **Dueño:** \(duenio.isEmpty ? "(sin completar)" : duenio)

        ## Qué hace el negocio
        (Completá acá: a qué se dedica, a quién le vende, productos o servicios, tono de voz.)

        ## Estado actual
        (Qué está en marcha, fechas importantes, prioridades de la semana.)

        ## Reglas permanentes
        (Cosas que ningún agente debe olvidar ni contradecir.)

        """
    }

    public static func decisionesMD(nombre: String) -> String {
        """
        # Decisiones de \(nombre)

        Decisiones confirmadas. Solo se agregan al final (nunca se borran ni se reescriben), con fecha.

        Formato: `- AAAA-MM-DD: decisión (contexto breve si hace falta).`

        """
    }

    /// Catálogo vacío (lo regenera la biblioteca a medida que se agregan documentos).
    public static func archivosMD() -> String {
        """
        # Archivos de la oficina

        Catálogo de documentos: una línea por documento. Para el detalle, leé su ficha en `conocimiento/fuentes/<slug>.md` y, si hace falta, el texto completo en `archivos/.texto/<slug>.md`.

        (Todavía no hay documentos.)

        """
    }

    public static func notasAgenteMD(nombre: String, rol: String) -> String {
        """
        # \(nombre): notas de trabajo

        Rol: \(rol)

        Acá \(nombre) anota lo que va aprendiendo: en qué está, qué entregó, qué espera de quién. Solo hechos, breve.

        """
    }

    /// Sección fija con las rutas de memoria (relativas a la oficina).
    public static func seccionMemoria(id: String) -> String {
        """
        \(marcaMemoria)
        Tu carpeta de trabajo es la raíz de la oficina; todas las rutas son relativas a ella.
        - Al empezar: leé `conocimiento/oficina.md` (contexto del negocio) y `conocimiento/decisiones.md` (decisiones confirmadas) y, si son relevantes para lo que te piden, las notas de otros agentes en `conocimiento/agentes/<id>.md`.
        - Al terminar algo concreto (una entrega, un pedido que quedó esperando a alguien, un cambio de plan): actualizá con Edit o Write SOLO tu archivo `conocimiento/agentes/\(id).md`. Breve y solo hechos: en qué estás, qué entregaste, qué esperás de quién. Sin suposiciones.
        - Conocimiento y archivos: `conocimiento/archivos.md` es el catálogo de documentos de la oficina (una línea por documento); leelo al empezar. Cada documento tiene su ficha en `conocimiento/fuentes/<slug>.md` y su texto en `archivos/.texto/<slug>.md`; el material original está en `archivos/` (`compartido/` es de todos, el resto por departamento). Para citar un documento, usá la ficha.
        - Lo que produzcas para el usuario (informes, borradores, archivos) guardalo con Write en `archivos/entregables/\(id)/`; esa es la única carpeta de archivos donde podés escribir.
        - No podés escribir ningún otro archivo (el sistema lo impide igual). Si algo debería quedar como decisión, proponelo en una reunión o decile al usuario que lo registre.
        - \(lineaConsultas)
        """
    }

    /// Documenta las herramientas del servidor MCP de la oficina (Fase 4). Su presencia marca una sección al día.
    static let lineaConsultas = "Podés consultar a un colega con la herramienta consultar(colega, pregunta) cuando necesites su mirada; usá colegas() para ver quiénes son. Máximo 3 consultas por mensaje."

    /// Al abrir una oficina: reescribe la sección de memoria de los `.md` de agente que la tienen desactualizada (sin la
    /// línea de consultas). Solo toca desde `## Memoria de la oficina` hasta el final (la sección fija, que va al final del
    /// cuerpo); el frontmatter y el prompt quedan como están. Idempotente. Devuelve cuántos reescribió.
    @discardableResult
    static func actualizarMemoria(carpeta: String, ids: [String]) -> Int {
        var n = 0
        for id in ids {
            let p = (carpeta as NSString).appendingPathComponent(".claude/agents/\(id).md")
            guard let t = try? String(contentsOfFile: p, encoding: .utf8), let r = t.range(of: marcaMemoria),
                  !t.contains(lineaConsultas) else { continue }
            let nuevo = String(t[..<r.lowerBound]) + seccionMemoria(id: id) + "\n"
            if (try? Data(nuevo.utf8).write(to: URL(fileURLWithPath: p), options: .atomic)) != nil { n += 1 }
        }
        return n
    }

    // MARK: .md del agente

    /// Línea de valor YAML en una sola línea (entrecomillada y escapada si el valor plano no sería YAML válido o
    /// cambiaría de tipo al leerlo). `valorFrontmatter` la desescapa.
    static func yamlLinea(_ s: String) -> String {
        let una = s.split(whereSeparator: { $0 == "\n" || $0 == "\r" }).map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }.joined(separator: " ")
        let reservadas: Set<String> = ["null", "~", "true", "false", "yes", "no", "on", "off", "y", "n"]
        let sinControl = una.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value != 0x7F }
        let peligroso = una.isEmpty || "\"'[]{}&*!|>%@`#-?:,".contains(una.first!) || una.contains(" #") || una.contains(": ")
            || una.hasSuffix(":") || una.contains("\"") || una.contains("\\") || !sinControl
            || reservadas.contains(una.lowercased()) || Double(una) != nil
        if !peligroso { return una }
        var esc = ""
        for u in una.unicodeScalars {
            switch u {
            case "\\": esc += "\\\\"
            case "\"": esc += "\\\""
            case "\t": esc += "\\t"
            default:
                if u.value < 0x20 || u.value == 0x7F { esc += String(format: "\\u%04X", u.value) } else { esc.unicodeScalars.append(u) }
            }
        }
        return "\"\(esc)\""
    }

    public static func agenteMD(id: String, description: String, modelo: String, prompt: String) -> String {
        """
        ---
        name: \(id)
        description: \(yamlLinea(description))
        model: \(modelo)
        ---

        \(prompt.trimmingCharacters(in: .whitespacesAndNewlines))

        \(seccionMemoria(id: id))

        """
    }

    /// Partes de un `.md` de agente: líneas del frontmatter y cuerpo (todo lo que sigue a la línea de cierre `---`,
    /// sin ese salto de línea; para rearmar: `"---\n" + fm + "\n---\n" + cuerpo`).
    struct PartesMD { var frontmatter: [String]; var cuerpo: String }

    static func partes(_ texto: String) -> PartesMD {
        let lineas = texto.components(separatedBy: "\n")
        guard lineas.first?.trimmingCharacters(in: .whitespaces) == "---",
              let fin = lineas.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) else {
            return PartesMD(frontmatter: [], cuerpo: texto)
        }
        return PartesMD(frontmatter: Array(lineas[1..<fin]), cuerpo: lineas[(fin + 1)...].joined(separator: "\n"))
    }

    /// Valor de `clave:` en el frontmatter (una sola línea; sin comillas, desescapado).
    static func valorFrontmatter(_ fm: [String], _ clave: String) -> String? {
        guard let l = fm.first(where: { $0.hasPrefix(clave + ":") }) else { return nil }
        let v = l.dropFirst(clave.count + 1).trimmingCharacters(in: .whitespaces)
        guard let f = v.first, f == "\"" || f == "'" else {
            if let r = v.range(of: " #") { return v[..<r.lowerBound].trimmingCharacters(in: .whitespaces) }
            return v
        }
        let c = Array(v.unicodeScalars.dropFirst())
        var out = String.UnicodeScalarView()
        var i = 0
        while i < c.count {
            let u = c[i]
            if f == "'" {
                if u == "'" { if i + 1 < c.count, c[i + 1] == "'" { out.append("'"); i += 2; continue } else { break } }
                out.append(u); i += 1; continue
            }
            if u == "\"" { break }
            guard u == "\\", i + 1 < c.count else { out.append(u); i += 1; continue }
            let e = c[i + 1]
            i += 2
            switch e {
            case "n": out.append("\n")
            case "r": out.append("\r")
            case "t": out.append("\t")
            case "0": out.append("\0")
            case "x", "u", "U":
                let n = e == "x" ? 2 : (e == "u" ? 4 : 8)
                let hex = String(String.UnicodeScalarView(c[i..<min(i + n, c.count)]))
                if hex.count == n, let code = UInt32(hex, radix: 16), let sc = Unicode.Scalar(code) { out.append(sc); i += n }
                else { out.append("\\"); out.append(e) }
            default: out.append(e)   // \\ \" \/ etc.
            }
        }
        return String(out)
    }

    /// Reemplaza (o agrega) `clave: valor` en el frontmatter, descartando líneas de continuación del valor viejo.
    static func fijarFrontmatter(_ fm: [String], _ clave: String, _ valor: String) -> [String] {
        var out: [String] = []
        var puesto = false, saltando = false
        for l in fm {
            if l.hasPrefix(clave + ":") {
                out.append("\(clave): \(valor)"); puesto = true; saltando = true; continue
            }
            if saltando, let c = l.first, c == " " || c == "\t" { continue }
            saltando = false
            out.append(l)
        }
        if !puesto { out.append("\(clave): \(valor)") }
        return out
    }

    /// Prompt = cuerpo sin la sección fija de memoria (si la tiene).
    static func promptDe(cuerpo: String) -> String {
        var c = cuerpo
        if let r = c.range(of: marcaMemoria) { c = String(c[..<r.lowerBound]) }
        return c.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: decisiones (para reuniones)

    /// Agrega líneas `- AAAA-MM-DD: texto` al final de `conocimiento/decisiones.md` (append-only).
    public static func anexarDecisiones(carpeta: String, decisiones: [String], fecha: Date = Date()) throws {
        guard !decisiones.isEmpty else { return }
        let p = (carpeta as NSString).appendingPathComponent("conocimiento/decisiones.md")
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"
        let dia = f.string(from: fecha)
        var actual = (try? String(contentsOfFile: p, encoding: .utf8)) ?? ""
        if !actual.isEmpty, !actual.hasSuffix("\n") { actual += "\n" }
        for d in decisiones {
            let una = d.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
            if !una.isEmpty { actual += "- \(dia): \(una)\n" }
        }
        try crearDir((p as NSString).deletingLastPathComponent)
        try Data(actual.utf8).write(to: URL(fileURLWithPath: p), options: .atomic)
    }
}
