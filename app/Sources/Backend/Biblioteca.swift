import Foundation

// Biblioteca de la oficina: archivos del usuario (subidos o vinculados), ficha de cada uno por el "bibliotecario"
// (un `claude -p` sin agente), catálogo en `conocimiento/archivos.md`, búsqueda FTS5, lectura por rol,
// propuestas de contradicción y carpetas vinculadas. Misma API, archivos y prompts que tools/hq_biblioteca.py
// (modo desarrollo): si cambia una implementación, cambia la otra.
//
// Carpetas: archivos/compartido/, archivos/<departamento>/, archivos/entregables/<agente>/, archivos/.texto/<slug>.md,
// archivos/.papelera/, conocimiento/archivos.md, conocimiento/fuentes/<slug>.md.

// MARK: - modelo

struct Ficha: Sendable, Equatable {
    var titulo = ""
    var resumen = ""
    var datosClave: [String] = []
    var temas: [String] = []
    var utilPara: [String] = []
    var fechas: [String] = []

    var json: [String: Any] {
        ["titulo": titulo, "resumen": resumen, "datos_clave": datosClave, "temas": temas, "util_para": utilPara, "fechas": fechas]
    }

    static func desde(_ o: [String: Any]) -> Ficha {
        Ficha(titulo: Biblioteca.cadena(o["titulo"]), resumen: Biblioteca.cadena(o["resumen"]),
              datosClave: Biblioteca.lista(o["datos_clave"]), temas: Biblioteca.lista(o["temas"]),
              utilPara: Biblioteca.lista(o["util_para"]), fechas: Biblioteca.lista(o["fechas"]))
    }
}

struct Contradiccion: Sendable, Equatable {
    var actual: String
    var nuevo: String
    var sugerencia: String
}

struct ArchivoFila: Sendable {
    var slug: String
    var oficina: String
    var nombre: String
    /// "compartido", id de departamento o "vinculo".
    var departamento: String
    /// Relativa a la oficina (`archivos/...`) si se subió; absoluta si viene de una carpeta vinculada.
    var ruta: String
    /// "subido" | "vinculo"
    var origen: String
    var vinculo: String?
    var tipo: String
    var tam: Int64
    var hash: String
    /// pendiente | extrayendo | fichando | leyendo | listo | error
    var estado: String
    var error: String?
    var aviso: String?
    var ficha: Ficha?
    /// Agentes que todavía tienen que leerlo por rol.
    var leer: [String] = []
    var lectura: [String: String] = [:]
    var creado: Double
    var actualizado: Double
    var papelera = false
    /// El usuario pidió lectura por rol al subirlo.
    var leerPedido = false
}

struct PropuestaFila: Sendable {
    var id: String
    var oficina: String
    var archivo: String
    var titulo: String
    var actual: String
    var nuevo: String
    var sugerencia: String
    /// pendiente | aceptada | rechazada
    var estado: String
    var creada: Double
    var resuelta: Double?
}

// MARK: - SQLite

extension Store {
    private static let colsArchivo = "slug,oficina,nombre,departamento,ruta,origen,vinculo,tipo,tam,hash,estado,error,aviso,ficha,leer,lectura,creado,actualizado,papelera,leer_pedido"

    private static func jsonA(_ o: Any) -> String {
        String(data: (try? JSONSerialization.data(withJSONObject: o, options: [.withoutEscapingSlashes])) ?? Data("[]".utf8), encoding: .utf8) ?? "[]"
    }

    private static func archivoDe(_ r: SQLRow) -> ArchivoFila {
        let ficha = r.isNull(13) ? nil : ((try? JSONSerialization.jsonObject(with: Data(r.text(13).utf8))) as? [String: Any]).map(Ficha.desde)
        let leer = r.isNull(14) ? [] : ((try? JSONSerialization.jsonObject(with: Data(r.text(14).utf8))) as? [String] ?? [])
        let lect = r.isNull(15) ? [:] : ((try? JSONSerialization.jsonObject(with: Data(r.text(15).utf8))) as? [String: String] ?? [:])
        return ArchivoFila(slug: r.text(0), oficina: r.text(1), nombre: r.text(2), departamento: r.text(3), ruta: r.text(4),
                           origen: r.text(5), vinculo: r.isNull(6) ? nil : r.text(6), tipo: r.text(7), tam: r.int(8), hash: r.text(9),
                           estado: r.text(10), error: r.isNull(11) ? nil : r.text(11), aviso: r.isNull(12) ? nil : r.text(12),
                           ficha: ficha, leer: leer, lectura: lect, creado: r.double(16), actualizado: r.double(17),
                           papelera: r.int(18) != 0, leerPedido: r.int(19) != 0)
    }

    /// Crea las tablas si faltan (con FTS5 si el SQLite lo trae; si no, una tabla común y búsqueda con LIKE) y deja
    /// `pendiente` lo que estaba a medio procesar al apagarse la app.
    func prepararBiblioteca(sinFTS: Bool = false) throws {
        try db.exec("""
        CREATE TABLE IF NOT EXISTS archivos (
            slug TEXT NOT NULL,
            oficina TEXT NOT NULL,
            nombre TEXT NOT NULL,
            departamento TEXT NOT NULL,
            ruta TEXT NOT NULL,
            origen TEXT NOT NULL,
            vinculo TEXT,
            tipo TEXT NOT NULL,
            tam INTEGER NOT NULL DEFAULT 0,
            hash TEXT NOT NULL DEFAULT '',
            estado TEXT NOT NULL,
            error TEXT,
            aviso TEXT,
            ficha TEXT,
            leer TEXT,
            lectura TEXT,
            creado REAL NOT NULL,
            actualizado REAL NOT NULL,
            papelera INTEGER NOT NULL DEFAULT 0,
            leer_pedido INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (oficina, slug)
        );
        CREATE INDEX IF NOT EXISTS archivos_estado ON archivos(estado, papelera);
        CREATE TABLE IF NOT EXISTS propuestas (
            id TEXT PRIMARY KEY,
            oficina TEXT NOT NULL,
            archivo TEXT NOT NULL,
            titulo TEXT NOT NULL,
            actual TEXT NOT NULL,
            nuevo TEXT NOT NULL,
            sugerencia TEXT NOT NULL,
            estado TEXT NOT NULL,
            creada REAL NOT NULL,
            resuelta REAL
        );
        CREATE INDEX IF NOT EXISTS propuestas_oficina ON propuestas(oficina, estado);
        """)
        let hay = (try db.query("SELECT 1 FROM sqlite_master WHERE name='archivos_fts'") { $0.int(0) }).first != nil
        if !hay {
            if sinFTS {
                try db.exec("CREATE TABLE archivos_fts (slug TEXT, oficina TEXT, titulo TEXT, resumen TEXT, temas TEXT, texto TEXT, norm TEXT)")
            } else {
                do {
                    try db.exec("CREATE VIRTUAL TABLE archivos_fts USING fts5(slug UNINDEXED, oficina UNINDEXED, titulo, resumen, temas, texto, tokenize='unicode61 remove_diacritics 2')")
                } catch {
                    try db.exec("CREATE TABLE archivos_fts (slug TEXT, oficina TEXT, titulo TEXT, resumen TEXT, temas TEXT, texto TEXT, norm TEXT)")
                }
            }
        }
        // Índice sin FTS: `norm` guarda el texto sin acentos ni mayúsculas, que es donde busca el LIKE.
        if !indiceEsFTS() {
            let cols = try db.query("SELECT name FROM pragma_table_info('archivos_fts')") { $0.text(0) }
            if !cols.contains("norm") {
                try db.exec("ALTER TABLE archivos_fts ADD COLUMN norm TEXT")
                let filas = try db.query("SELECT rowid, titulo, resumen, temas, texto FROM archivos_fts") {
                    (id: $0.int(0), norm: Store.normIndice($0.text(1), $0.text(2), $0.text(3), $0.text(4)))
                }
                for f in filas { try db.run("UPDATE archivos_fts SET norm=? WHERE rowid=?", [.text(f.norm), .int(f.id)]) }
            }
        }
        try db.run("UPDATE archivos SET estado='pendiente' WHERE estado IN ('extrayendo','fichando')")
    }

    /// Texto del índice sin FTS: título, resumen, temas y texto, sin acentos y en minúsculas.
    static func normIndice(_ partes: String...) -> String {
        ReunionTexto.plano(partes.joined(separator: "\n"))
    }

    func indiceEsFTS() -> Bool {
        ((try? db.query("SELECT sql FROM sqlite_master WHERE name='archivos_fts'") { $0.text(0) })?.first ?? "").uppercased().contains("VIRTUAL")
    }

    func archivoGuardar(_ f: ArchivoFila) throws {
        try db.run("INSERT OR REPLACE INTO archivos(\(Store.colsArchivo)) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
            .text(f.slug), .text(f.oficina), .text(f.nombre), .text(f.departamento), .text(f.ruta), .text(f.origen),
            f.vinculo.map { .text($0) } ?? .null, .text(f.tipo), .int(f.tam), .text(f.hash), .text(f.estado),
            f.error.map { .text($0) } ?? .null, f.aviso.map { .text($0) } ?? .null,
            f.ficha.map { .text(Store.jsonA($0.json)) } ?? .null,
            f.leer.isEmpty ? .null : .text(Store.jsonA(f.leer)), f.lectura.isEmpty ? .null : .text(Store.jsonA(f.lectura)),
            .double(f.creado), .double(f.actualizado), .int(f.papelera ? 1 : 0), .int(f.leerPedido ? 1 : 0)])
    }

    func archivo(_ slug: String, oficina: String) -> ArchivoFila? {
        (try? db.query("SELECT \(Store.colsArchivo) FROM archivos WHERE oficina=? AND slug=?", [.text(oficina), .text(slug)], Store.archivoDe))?.first
    }

    func archivos(oficina: String, papelera: Bool = false) -> [ArchivoFila] {
        (try? db.query("SELECT \(Store.colsArchivo) FROM archivos WHERE oficina=? AND papelera=? ORDER BY creado DESC, slug",
                       [.text(oficina), .int(papelera ? 1 : 0)], Store.archivoDe)) ?? []
    }

    func archivoPorRuta(oficina: String, ruta: String) -> ArchivoFila? {
        (try? db.query("SELECT \(Store.colsArchivo) FROM archivos WHERE oficina=? AND ruta=? AND papelera=0", [.text(oficina), .text(ruta)], Store.archivoDe))?.first
    }

    func slugsUsados(oficina: String) -> Set<String> {
        Set((try? db.query("SELECT slug FROM archivos WHERE oficina=?", [.text(oficina)]) { $0.text(0) }) ?? [])
    }

    /// Próximo archivo a procesar (de cualquier oficina): pendiente, o con lectura por rol pedida.
    func siguienteArchivo() -> ArchivoFila? {
        (try? db.query("SELECT \(Store.colsArchivo) FROM archivos WHERE papelera=0 AND estado IN ('pendiente','leyendo') ORDER BY actualizado, slug LIMIT 1",
                       [], Store.archivoDe))?.first
    }

    func archivoEstado(_ slug: String, oficina: String, _ estado: String, error: String? = nil) throws {
        try db.run("UPDATE archivos SET estado=?, error=?, actualizado=? WHERE oficina=? AND slug=? AND papelera=0",
                   [.text(estado), error.map { .text($0) } ?? .null, .double(Date().timeIntervalSince1970), .text(oficina), .text(slug)])
    }

    func archivoAviso(_ slug: String, oficina: String, _ aviso: String?) throws {
        try db.run("UPDATE archivos SET aviso=? WHERE oficina=? AND slug=? AND papelera=0", [aviso.map { .text($0) } ?? .null, .text(oficina), .text(slug)])
    }

    func archivoFicha(_ slug: String, oficina: String, ficha: Ficha) throws {
        try db.run("UPDATE archivos SET ficha=? WHERE oficina=? AND slug=? AND papelera=0", [.text(Store.jsonA(ficha.json)), .text(oficina), .text(slug)])
    }

    func archivoLeer(_ slug: String, oficina: String, pendientes: [String], resultados: [String: String]) throws {
        try db.run("UPDATE archivos SET leer=?, lectura=?, actualizado=? WHERE oficina=? AND slug=? AND papelera=0",
                   [pendientes.isEmpty ? .null : .text(Store.jsonA(pendientes)), resultados.isEmpty ? .null : .text(Store.jsonA(resultados)),
                    .double(Date().timeIntervalSince1970), .text(oficina), .text(slug)])
    }

    /// Pide lectura por rol de estos agentes: pasa a `leyendo` (el procesador la toma enseguida).
    func archivoPedirLectura(_ slug: String, oficina: String, agentes: [String]) throws {
        try db.run("UPDATE archivos SET estado='leyendo', leer=?, lectura=NULL, error=NULL, actualizado=? WHERE oficina=? AND slug=? AND papelera=0",
                   [.text(Store.jsonA(agentes)), .double(Date().timeIntervalSince1970), .text(oficina), .text(slug)])
    }

    func archivoPapelera(_ slug: String, oficina: String, ruta: String) throws {
        try db.run("UPDATE archivos SET papelera=1, ruta=?, actualizado=? WHERE oficina=? AND slug=?",
                   [.text(ruta), .double(Date().timeIntervalSince1970), .text(oficina), .text(slug)])
    }

    /// El contenido cambió (hash distinto): se vuelve a procesar.
    func archivoReprocesar(_ slug: String, oficina: String, hash: String, tam: Int64, leerPedido: Bool? = nil) throws {
        try db.run("UPDATE archivos SET hash=?, tam=?, estado='pendiente', error=NULL, aviso=NULL, leer=NULL, lectura=NULL, actualizado=? WHERE oficina=? AND slug=? AND papelera=0",
                   [.text(hash), .int(tam), .double(Date().timeIntervalSince1970), .text(oficina), .text(slug)])
        if let l = leerPedido { try db.run("UPDATE archivos SET leer_pedido=? WHERE oficina=? AND slug=?", [.int(l ? 1 : 0), .text(oficina), .text(slug)]) }
    }

    // MARK: índice de búsqueda

    func indiceGuardar(_ slug: String, oficina: String, titulo: String, resumen: String, temas: String, texto: String) throws {
        try db.run("DELETE FROM archivos_fts WHERE slug=? AND oficina=?", [.text(slug), .text(oficina)])
        let recorte = String(texto.prefix(300_000))
        if indiceEsFTS() {
            try db.run("INSERT INTO archivos_fts(slug,oficina,titulo,resumen,temas,texto) VALUES(?,?,?,?,?,?)",
                       [.text(slug), .text(oficina), .text(titulo), .text(resumen), .text(temas), .text(recorte)])
        } else {
            try db.run("INSERT INTO archivos_fts(slug,oficina,titulo,resumen,temas,texto,norm) VALUES(?,?,?,?,?,?,?)",
                       [.text(slug), .text(oficina), .text(titulo), .text(resumen), .text(temas), .text(recorte),
                        .text(Store.normIndice(titulo, resumen, temas, recorte))])
        }
    }

    func indiceQuitar(_ slug: String, oficina: String) {
        _ = try? db.run("DELETE FROM archivos_fts WHERE slug=? AND oficina=?", [.text(slug), .text(oficina)])
    }

    /// Slugs que coinciden con `q` (mejor primero) y un fragmento del texto. FTS5 si está; si no, LIKE.
    func buscar(oficina: String, q: String) -> [(slug: String, snippet: String)] {
        let toks = ReunionTexto.palabras(q)
        guard !toks.isEmpty else { return [] }
        if indiceEsFTS() {
            let m = toks.map { "\"\($0)\"*" }.joined(separator: " ")
            return (try? db.query("""
                SELECT slug, snippet(archivos_fts, 5, '[', ']', '…', 14) FROM archivos_fts
                WHERE archivos_fts MATCH ? AND oficina=? ORDER BY rank LIMIT 100
                """, [.text(m), .text(oficina)]) { (slug: $0.text(0), snippet: $0.text(1)) }) ?? []
        }
        let cond = toks.map { _ in "norm LIKE ?" }.joined(separator: " AND ")
        var params: [SQLValue] = [.text(oficina)]
        for t in toks { params.append(.text("%\(t)%")) }
        let filas = (try? db.query("SELECT slug, texto FROM archivos_fts WHERE oficina=? AND \(cond) LIMIT 100", params) { (slug: $0.text(0), texto: $0.text(1)) }) ?? []
        return filas.map { f in
            var s = ""
            if let r = f.texto.range(of: toks[0], options: [.caseInsensitive, .diacriticInsensitive]) {
                let a = f.texto.index(r.lowerBound, offsetBy: -60, limitedBy: f.texto.startIndex) ?? f.texto.startIndex
                let b = f.texto.index(r.upperBound, offsetBy: 80, limitedBy: f.texto.endIndex) ?? f.texto.endIndex
                s = "…" + f.texto[a..<b].replacingOccurrences(of: "\n", with: " ") + "…"
            }
            return (slug: f.slug, snippet: s)
        }
    }

    // MARK: propuestas

    private static func propuestaDe(_ r: SQLRow) -> PropuestaFila {
        PropuestaFila(id: r.text(0), oficina: r.text(1), archivo: r.text(2), titulo: r.text(3), actual: r.text(4), nuevo: r.text(5),
                      sugerencia: r.text(6), estado: r.text(7), creada: r.double(8), resuelta: r.isNull(9) ? nil : r.double(9))
    }

    func propuestaAgregar(_ p: PropuestaFila) throws {
        // no repetir la misma sugerencia pendiente para el mismo archivo
        let ya = (try db.query("SELECT 1 FROM propuestas WHERE oficina=? AND archivo=? AND sugerencia=? AND estado='pendiente'",
                               [.text(p.oficina), .text(p.archivo), .text(p.sugerencia)]) { $0.int(0) }).first != nil
        if ya { return }
        try db.run("INSERT INTO propuestas(id,oficina,archivo,titulo,actual,nuevo,sugerencia,estado,creada) VALUES(?,?,?,?,?,?,?,?,?)",
                   [.text(p.id), .text(p.oficina), .text(p.archivo), .text(p.titulo), .text(p.actual), .text(p.nuevo),
                    .text(p.sugerencia), .text(p.estado), .double(p.creada)])
    }

    func propuestas(oficina: String, todas: Bool) -> [PropuestaFila] {
        (try? db.query("SELECT id,oficina,archivo,titulo,actual,nuevo,sugerencia,estado,creada,resuelta FROM propuestas WHERE oficina=? \(todas ? "" : "AND estado='pendiente'") ORDER BY creada DESC",
                       [.text(oficina)], Store.propuestaDe)) ?? []
    }

    func propuesta(_ id: String, oficina: String) -> PropuestaFila? {
        (try? db.query("SELECT id,oficina,archivo,titulo,actual,nuevo,sugerencia,estado,creada,resuelta FROM propuestas WHERE id=? AND oficina=?",
                       [.text(id), .text(oficina)], Store.propuestaDe))?.first
    }

    func propuestaResolver(_ id: String, estado: String) throws {
        try db.run("UPDATE propuestas SET estado=?, resuelta=? WHERE id=?", [.text(estado), .double(Date().timeIntervalSince1970), .text(id)])
    }
}

// MARK: - textos, prompts y parseo (puros; mismos que hq_biblioteca.py)

enum Biblioteca {
    static let maxTextoPrompt = 12_000
    static let maxMemoriaPrompt = 3_000
    static let maxDecisionesPrompt = 2_000
    static let maxContradicciones = 5
    static let maxLectores = 10
    static let carpetaCompartido = "compartido"
    static let carpetaVinculo = "vinculo"

    static func cadena(_ v: Any?) -> String {
        if let s = v as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let n = v as? NSNumber { return n.stringValue }
        return ""
    }

    static func lista(_ v: Any?) -> [String] {
        if let s = v as? String { let t = cadena(s); return t.isEmpty ? [] : [t] }
        guard let a = v as? [Any] else { return [] }
        return a.map { x -> String in
            if let d = x as? [String: Any] { return d.map { "\($0.key): \(cadena($0.value))" }.sorted().joined(separator: ", ") }
            return cadena(x)
        }.filter { !$0.isEmpty }
    }

    static func recortar(_ s: String, _ max: Int) -> String { s.count > max ? String(s.prefix(max)) + "…" : s }

    static func nombreDepartamento(_ id: String, oficina: Oficina) -> String {
        if id == carpetaCompartido { return "Compartido" }
        if id == carpetaVinculo { return "Carpeta vinculada" }
        return oficina.departamento(id)?.nombre ?? id
    }

    static func tamTexto(_ n: Int64) -> String {
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 { return "\(n / 1024) KB" }
        return String(format: "%.1f MB", Double(n) / 1_048_576)
    }

    static func promptFicha(oficina: Oficina, carpeta: String, nombre: String, tipo: String, departamento: String, texto: String) -> String {
        let deps = oficina.departamentos.map { "- \($0.id): \($0.nombre)" }.joined(separator: "\n")
        let memoria = recortar(ReunionTexto.leer((carpeta as NSString).appendingPathComponent("conocimiento/oficina.md")).trimmingCharacters(in: .whitespacesAndNewlines), maxMemoriaPrompt)
        let decisiones = ReunionTexto.decisiones(carpeta: carpeta)
        return """
        Sos el bibliotecario de la oficina «\(oficina.nombre)». Llegó un documento nuevo y tenés que fichar.

        Documento: \(nombre) (tipo: \(tipo); carpeta: \(nombreDepartamento(departamento, oficina: oficina)))

        Departamentos de la oficina (id: nombre):
        \(deps.isEmpty ? "(ninguno)" : deps)

        Memoria común de la oficina (recortada):
        \(memoria.isEmpty ? "(vacía)" : memoria)

        Decisiones recientes:
        \(recortar(decisiones, maxDecisionesPrompt))

        Texto del documento (recortado a \(maxTextoPrompt) caracteres):
        <<<
        \(String(texto.prefix(maxTextoPrompt)))
        >>>

        Devolvé SOLO un objeto JSON estricto (sin texto antes ni después, sin bloques de código) con esta forma:
        {"titulo": "título claro del documento", "resumen": "resumen en 3-5 oraciones", "datos_clave": ["dato concreto: cifras, nombres, fechas, condiciones"], "temas": ["tema"], "util_para": ["id-de-departamento"], "fechas": ["fechas relevantes"], "contradicciones": [{"actual": "lo que dice hoy la memoria o las decisiones", "nuevo": "lo que dice el documento", "sugerencia": "frase breve para anexar a la memoria común"}]}
        Reglas: en "util_para" poné solo ids de la lista de departamentos a los que este documento les sirve. En "contradicciones" poné solo diferencias reales y verificables entre el documento y la memoria o las decisiones (lista vacía si no hay). No inventes nada que no esté en el texto.
        """
    }

    /// Extrae el objeto JSON (con o sin ```json) y lo normaliza. nil si no hay forma de leerlo.
    static func parsearFicha(_ t: String, nombre: String, oficina: Oficina) -> (Ficha, [Contradiccion])? {
        guard let a = t.firstIndex(of: "{"), let b = t.lastIndex(of: "}"), a < b,
              let d = String(t[a...b]).data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
        var f = Ficha.desde(o)
        if f.titulo.isEmpty && f.resumen.isEmpty { return nil }
        if f.titulo.isEmpty { f.titulo = nombre }
        f.utilPara = departamentosDe(f.utilPara, oficina: oficina)
        var cs: [Contradiccion] = []
        for x in (o["contradicciones"] as? [Any]) ?? [] {
            guard let m = x as? [String: Any] else { continue }
            let c = Contradiccion(actual: cadena(m["actual"]), nuevo: cadena(m["nuevo"]), sugerencia: cadena(m["sugerencia"]))
            if !c.sugerencia.isEmpty { cs.append(c) }
            if cs.count >= maxContradicciones { break }
        }
        return (f, cs)
    }

    /// Ids de departamento a partir de ids o nombres (descarta los desconocidos, sin repetir).
    static func departamentosDe(_ v: [String], oficina: Oficina) -> [String] {
        var out: [String] = []
        for x in v {
            let s = Slug.de(x)
            let hit = oficina.departamentos.first { $0.id == x || $0.id == s || Slug.de($0.nombre) == s }
            if let h = hit, !out.contains(h.id) { out.append(h.id) }
        }
        return out
    }

    static func fichaMD(_ f: ArchivoFila, ficha: Ficha, oficina: Oficina, carpeta: String) -> String {
        let dia = ReunionTexto.dia(Date(timeIntervalSince1970: f.creado))
        let origen = f.origen == "vinculo" ? "carpeta vinculada «\(f.vinculo ?? "")»" : "subido el \(dia)"
        var s = "# \(ficha.titulo.isEmpty ? f.nombre : ficha.titulo)\n\n"
        s += "- **Archivo:** \(f.nombre)\n"
        s += "- **Tipo:** \(f.tipo) · \(tamTexto(f.tam))\n"
        s += "- **Carpeta:** \(nombreDepartamento(f.departamento, oficina: oficina))\n"
        s += "- **Origen:** \(origen)\n"
        s += "- **Ubicación del original:** \(f.ruta)\n"
        s += "- **Texto completo:** archivos/.texto/\(f.slug).md\n"
        s += "- **Identificador:** \(f.slug) (sha256 \(f.hash.prefix(12)))\n"
        if !ficha.utilPara.isEmpty { s += "- **Útil para:** " + ficha.utilPara.map { nombreDepartamento($0, oficina: oficina) }.joined(separator: ", ") + "\n" }
        if !ficha.fechas.isEmpty { s += "- **Fechas:** " + ficha.fechas.joined(separator: "; ") + "\n" }
        s += "\n## Resumen\n\n\(ficha.resumen.isEmpty ? "(sin resumen)" : ficha.resumen)\n"
        if !ficha.datosClave.isEmpty { s += "\n## Datos clave\n\n" + ficha.datosClave.map { "- \($0)" }.joined(separator: "\n") + "\n" }
        if !ficha.temas.isEmpty { s += "\n## Temas\n\n" + ficha.temas.joined(separator: ", ") + "\n" }
        return s
    }

    /// Una línea por documento (los que no están en la papelera).
    static func catalogoMD(_ filas: [ArchivoFila], oficina: Oficina) -> String {
        var s = """
        # Archivos de la oficina

        Catálogo de documentos: una línea por documento. Para el detalle, leé su ficha en `conocimiento/fuentes/<slug>.md` y, si hace falta, el texto completo en `archivos/.texto/<slug>.md`.


        """
        let vivas = filas.filter { !$0.papelera }.sorted { ($0.departamento, $0.nombre) < ($1.departamento, $1.nombre) }
        if vivas.isEmpty { return s + "(Todavía no hay documentos.)\n" }
        for f in vivas {
            let dep = nombreDepartamento(f.departamento, oficina: oficina)
            if let fi = f.ficha {
                var resumen = fi.resumen.split(whereSeparator: \.isNewline).joined(separator: " ")
                if resumen.count > 180 { resumen = String(resumen.prefix(180)) + "…" }
                s += "- **\(fi.titulo.isEmpty ? f.nombre : fi.titulo)** (`\(f.slug)`, \(dep), \(f.tipo)): \(resumen) → `conocimiento/fuentes/\(f.slug).md`\n"
            } else {
                s += "- **\(f.nombre)** (`\(f.slug)`, \(dep), \(f.tipo)): todavía sin ficha (\(f.estado == "error" ? "no se pudo fichar" : "en proceso")) → texto en `archivos/.texto/\(f.slug).md`\n"
            }
        }
        return s
    }

    static func promptLectura(titulo: String, nombre: String, slug: String, agente: AgenteDef, esImagen: Bool, ruta: String) -> String {
        var s = """
        Se sumó un documento a la biblioteca de la oficina: «\(titulo)» (archivo \(nombre)).
        Leé su ficha en `conocimiento/fuentes/\(slug).md` y, si hace falta, el texto completo en `archivos/.texto/\(slug).md`.
        """
        if esImagen { s += "\nEs una imagen: el original está en `\(ruta)`; podés verlo con Read." }
        s += """

        Después anotá en tus notas (`conocimiento/agentes/\(agente.id).md`, el único archivo que podés escribir) qué te sirve de este documento desde tu rol de \(agente.rol): breve, solo hechos, sin suposiciones. Leé tus notas antes y agregá al final sin pisar lo que ya tenés. Si nada de esto sirve para tu rol, anotá una línea que lo diga.
        Cuando termines, respondé solo «listo».
        """
        return s
    }

    static func anexarActualizacion(carpeta: String, sugerencia: String, titulo: String, slug: String, fecha: Date = Date()) throws {
        let p = (carpeta as NSString).appendingPathComponent("conocimiento/oficina.md")
        var actual = (try? String(contentsOfFile: p, encoding: .utf8)) ?? ""
        if !actual.isEmpty, !actual.hasSuffix("\n") { actual += "\n" }
        actual += "\n## Actualizado \(ReunionTexto.dia(fecha))\n\(sugerencia)\n(Fuente: \(titulo), `conocimiento/fuentes/\(slug).md`)\n"
        try Plantillas.crearDir((p as NSString).deletingLastPathComponent)
        try Data(actual.utf8).write(to: URL(fileURLWithPath: p), options: .atomic)
    }

    static func iso(_ t: Double) -> String { ReunionesRouter.iso(t) }
}

// MARK: - servicio

/// `/api/archivos*`, `/api/vinculos*`, `/api/biblioteca*`. Un actor: la cola de procesamiento (un solo trabajador) vive acá;
/// el estado de cada archivo, en SQLite.
public actor BibliotecaRouter: SubRouter {
    static let maxBodyChico = 200_000
    static let maxVinculos = 20
    static let maxBase64Directo: Int64 = 8 * 1024 * 1024

    let store: Store
    private let runner: ClaudeRunner
    private let oficinas: Oficinas
    private let log: HQLog
    private let sinFTS: Bool
    private let timeoutFicha: TimeInterval
    private let timeoutImagen: TimeInterval
    private let envMaxMB: Int
    private let envMaxArchivos: Int
    private let envMaxTotalMB: Int
    private var preparado = false
    private var trabajador: Task<Void, Never>?
    private var otraVuelta = false
    private var leyendoAhora: Set<String> = []

    public init(store: Store, runner: ClaudeRunner, oficinas: Oficinas, log: HQLog,
                env: [String: String] = ProcessInfo.processInfo.environment) {
        self.store = store; self.runner = runner; self.oficinas = oficinas; self.log = log
        sinFTS = env["HQ_BIBLIOTECA_SIN_FTS"] == "1"
        func num(_ k: String, _ d: Double) -> Double { env[k].flatMap(Double.init).flatMap { $0 > 0 ? $0 : nil } ?? d }
        timeoutFicha = num("HQ_BIBLIOTECA_TIMEOUT", 180)
        timeoutImagen = num("HQ_BIBLIOTECA_IMAGEN_TIMEOUT", 120)
        envMaxMB = Int(num("HQ_BIBLIOTECA_MAX_MB", 25))
        envMaxArchivos = Int(num("HQ_BIBLIOTECA_MAX_ARCHIVOS", 200))
        envMaxTotalMB = Int(num("HQ_BIBLIOTECA_MAX_TOTAL_MB", 500))
    }

    func preparar() async throws {
        if preparado { return }
        try await store.prepararBiblioteca(sinFTS: sinFTS)
        preparado = true
        despertar()
    }

    // MARK: entrada

    public func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)? {
        let partes = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        guard partes.count >= 2, partes[0] == "api", ["archivos", "vinculos", "biblioteca"].contains(partes[1]), partes.count <= 5,
              !partes.contains("") else { return nil }
        do {
            try await preparar()
            let (code, obj) = try await despachar(method, partes, query, body)
            return (code, Router.codificar(obj))
        } catch let e as ErrorAPI {
            return (e.status, Router.codificar(["error": e.mensaje]))
        } catch {
            log.error("biblioteca error interno: \(error)")
            return (500, Router.codificar(["error": "error interno"]))
        }
    }

    private typealias R = (Int, [String: Any])

    private func despachar(_ m: String, _ partes: [String], _ query: [String: String], _ body: Data?) async throws -> R {
        let no: R = (405, ["error": "método no permitido"])
        let n = partes.count
        switch partes[1] {
        case "archivos":
            if n == 2 {
                switch m {
                case "GET": return (200, try await listar(query))
                case "POST": return (200, try await subir(body))
                default: return no
                }
            }
            let slug = partes[2]
            guard Slug.valido(slug) else { return (404, ["error": "no"]) }
            if n == 3 {
                switch m {
                case "GET": return (200, try await detalle(slug))
                case "DELETE": return (200, try await quitar(slug))
                default: return no
                }
            }
            guard n == 4 else { return (404, ["error": "no"]) }
            switch partes[3] {
            case "original": return m == "GET" ? (200, try await original(slug)) : no
            case "leer": return m == "POST" ? (200, try await leer(slug, body)) : no
            case "reprocesar": return m == "POST" ? (200, try await reprocesar(slug)) : no
            default: return (404, ["error": "no"])
            }
        case "vinculos":
            if n == 2 {
                switch m {
                case "GET": return (200, try await listarVinculos())
                case "POST": return (200, try await crearVinculo(body))
                default: return no
                }
            }
            let id = partes[2]
            guard Slug.valido(id) else { return (404, ["error": "no"]) }
            if n == 3 { return m == "DELETE" ? (200, try await quitarVinculo(id)) : no }
            if n == 4, partes[3] == "escanear" { return m == "POST" ? (200, try await escanearVinculo(id)) : no }
            return (404, ["error": "no"])
        default:  // biblioteca
            switch (partes[2], n) {
            case ("estado", 3): return m == "GET" ? (200, try await estado()) : no
            case ("config", 3):
                switch m {
                case "GET": return (200, try await config())
                case "PATCH": return (200, try await cambiarConfig(body))
                default: return no
                }
            case ("propuestas", 3): return m == "GET" ? (200, try await propuestas(query)) : no
            case ("propuestas", 4): return m == "POST" ? (200, try await resolverPropuesta(partes[3], body)) : no
            case ("entregables", 3): return m == "GET" ? (200, try await entregables(query)) : no
            case ("entregable", 3): return m == "GET" ? (200, try await entregable(query)) : no
            default: return (404, ["error": "no"])
            }
        }
    }

    // MARK: utilidades

    private func objeto(_ body: Data?, max: Int = BibliotecaRouter.maxBodyChico) throws -> [String: Any] {
        guard let body, !body.isEmpty else { throw ErrorAPI(400, "pedido inválido") }
        if body.count > max { throw ErrorAPI(413, "pedido demasiado grande") }
        guard let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { throw ErrorAPI(400, "pedido inválido") }
        return o
    }

    private func objetoOpcional(_ body: Data?) throws -> [String: Any] {
        guard let body, !body.isEmpty else { return [:] }
        return try objeto(body)
    }

    struct Limites { var maxArchivoBytes: Int64; var maxArchivos: Int; var maxTotalBytes: Int64 }

    private func limites(_ o: Oficina) -> Limites {
        let c = o.biblioteca
        func pos(_ v: Int?, _ d: Int) -> Int { (v ?? 0) > 0 ? v! : d }
        return Limites(maxArchivoBytes: Int64(pos(c?.maxMB, envMaxMB)) * 1_048_576, maxArchivos: pos(c?.maxArchivos, envMaxArchivos),
                       maxTotalBytes: Int64(pos(c?.maxTotalMB, envMaxTotalMB)) * 1_048_576)
    }

    func rutaAbsoluta(_ f: ArchivoFila, _ a: OficinaActiva) -> String { f.ruta.hasPrefix("/") ? f.ruta : a.ruta(f.ruta) }

    private func vista(_ f: ArchivoFila, snippet: String? = nil) -> [String: Any] {
        var o: [String: Any] = ["slug": f.slug, "nombre": f.nombre, "titulo": f.ficha?.titulo.isEmpty == false ? f.ficha!.titulo : f.nombre,
                                "departamento": f.departamento, "tipo": f.tipo, "tam": f.tam, "hash": f.hash, "estado": f.estado,
                                "origen": f.origen, "ruta": f.ruta, "creado": Biblioteca.iso(f.creado), "actualizado": Biblioteca.iso(f.actualizado),
                                "fichaRuta": "conocimiento/fuentes/\(f.slug).md", "textoRuta": "archivos/.texto/\(f.slug).md"]
        if let v = f.vinculo { o["vinculo"] = v }
        if let e = f.error { o["error"] = e }
        if let a = f.aviso { o["aviso"] = a }
        if let fi = f.ficha { o["ficha"] = fi.json }
        if !f.leer.isEmpty { o["leer"] = f.leer }
        if !f.lectura.isEmpty { o["lectura"] = f.lectura }
        if let s = snippet, !s.isEmpty { o["snippet"] = s }
        return o
    }

    private func fila(_ slug: String, _ a: OficinaActiva) async throws -> ArchivoFila {
        guard let f = await store.archivo(slug, oficina: a.carpeta), !f.papelera else { throw ErrorAPI(404, "No encontré ese archivo.") }
        return f
    }

    private func escribir(_ texto: String, _ ruta: String) throws {
        try Plantillas.crearDir((ruta as NSString).deletingLastPathComponent)
        try OficinaStore.escribirAtomico(Data(texto.utf8), en: ruta)
    }

    // MARK: archivos

    private func listar(_ q: [String: String]) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        var filas = await store.archivos(oficina: a.carpeta)
        var snippets: [String: String] = [:]
        let busqueda = (q["q"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !busqueda.isEmpty {
            let hits = await store.buscar(oficina: a.carpeta, q: busqueda)
            let orden = Dictionary(hits.enumerated().map { ($1.slug, $0) }, uniquingKeysWith: { x, _ in x })
            for h in hits { snippets[h.slug] = h.snippet }
            filas = filas.filter { orden[$0.slug] != nil }.sorted { orden[$0.slug]! < orden[$1.slug]! }
        }
        if let d = q["departamento"], !d.isEmpty { filas = filas.filter { $0.departamento == d } }
        var o: [String: Any] = ["archivos": filas.map { vista($0, snippet: snippets[$0.slug]) }]
        if !busqueda.isEmpty { o["q"] = busqueda }
        return o
    }

    private func detalle(_ slug: String) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let f = try await fila(slug, a)
        var v = vista(f)
        v["rutaAbsoluta"] = rutaAbsoluta(f, a)
        let texto = ReunionTexto.leer(a.ruta("archivos/.texto/\(slug).md"))
        return ["archivo": v, "texto": Biblioteca.recortar(texto, 4000)]
    }

    private func subir(_ body: Data?) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let lim = limites(a.oficina)
        let d = try objeto(body, max: Int(lim.maxArchivoBytes) * 4 / 3 + 100_000)
        let nombreCrudo = try Validar.texto(d["nombre"], "nombre", max: 255)!
        let nombre = Extraccion.nombreSeguro(nombreCrudo)
        let ext = TipoArchivo.extension_(nombre)
        guard TipoArchivo.soportados.contains(ext) else {
            throw ErrorAPI(400, "Ese tipo de archivo no se puede leer (\(ext.isEmpty ? "sin extensión" : "." + ext)). Tipos soportados: \(TipoArchivo.lista).")
        }
        var dep = try Validar.texto(d["departamento"], "departamento", max: 41, obligatorio: false) ?? Biblioteca.carpetaCompartido
        if dep != Biblioteca.carpetaCompartido {
            guard a.oficina.departamento(dep) != nil else { throw ErrorAPI(400, "El departamento «\(dep)» no existe.") }
        } else { dep = Biblioteca.carpetaCompartido }
        guard var b64 = d["base64"] as? String, !b64.isEmpty else { throw ErrorAPI(400, "Falta el contenido del archivo (base64).") }
        if b64.hasPrefix("data:"), let i = b64.firstIndex(of: ",") { b64 = String(b64[b64.index(after: i)...]) }
        let mb = lim.maxArchivoBytes / 1_048_576
        if Int64(b64.utf8.count) > lim.maxArchivoBytes * 4 / 3 + 8 { throw ErrorAPI(413, "El archivo es demasiado grande (el máximo es \(mb) MB).") }
        guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters), !data.isEmpty else {
            throw ErrorAPI(400, "El contenido del archivo no es base64 válido.")
        }
        if Int64(data.count) > lim.maxArchivoBytes {
            throw ErrorAPI(413, "El archivo pesa \(Biblioteca.tamTexto(Int64(data.count))) y el máximo es \(mb) MB.")
        }
        let leerPedido = (d["leer"] as? Bool) ?? false
        let hash = Extraccion.sha256(data)
        let carpeta = a.carpeta
        let existentes = await store.archivos(oficina: carpeta)

        // mismo contenido en la misma carpeta: ya está
        if let ya = existentes.first(where: { $0.origen == "subido" && $0.departamento == dep && $0.hash == hash }) {
            var v = vista(ya); v["duplicado"] = true
            return ["archivo": v, "duplicado": true]
        }
        // mismo nombre en la misma carpeta con otro contenido: se reemplaza y se vuelve a procesar
        let relBase = "archivos/\(dep)"
        if let viejo = existentes.first(where: { $0.origen == "subido" && $0.departamento == dep && $0.nombre == nombre }) {
            do {
                try Plantillas.crearDir(a.ruta(relBase))
                try data.write(to: URL(fileURLWithPath: a.ruta(viejo.ruta)), options: .atomic)
                try await store.archivoReprocesar(viejo.slug, oficina: carpeta, hash: hash, tam: Int64(data.count), leerPedido: leerPedido)
            } catch { throw ErrorAPI(500, "No pude guardar el archivo.") }
            despertar()
            var v = vista(await store.archivo(viejo.slug, oficina: carpeta) ?? viejo); v["reemplazado"] = true
            return ["archivo": v, "reemplazado": true]
        }
        let destino = Extraccion.rutaLibre(a.ruta(relBase), nombre)
        do {
            try Plantillas.crearDir(a.ruta(relBase))
            try data.write(to: URL(fileURLWithPath: destino), options: .atomic)
        } catch { throw ErrorAPI(500, "No pude guardar el archivo.") }
        let slug = Slug.unico((nombre as NSString).deletingPathExtension, usados: await store.slugsUsados(oficina: carpeta), respaldo: "archivo")
        let ahora = Date().timeIntervalSince1970
        let f = ArchivoFila(slug: slug, oficina: carpeta, nombre: (destino as NSString).lastPathComponent, departamento: dep,
                            ruta: relBase + "/" + (destino as NSString).lastPathComponent, origen: "subido", vinculo: nil, tipo: ext,
                            tam: Int64(data.count), hash: hash, estado: "pendiente", error: nil, aviso: nil, ficha: nil,
                            creado: ahora, actualizado: ahora, leerPedido: leerPedido)
        do { try await store.archivoGuardar(f) } catch { throw ErrorAPI(500, "No pude registrar el archivo.") }
        despertar()
        log.info("biblioteca: archivo subido tipo=\(ext) tam=\(data.count)")
        return ["archivo": vista(f)]
    }

    private func quitar(_ slug: String) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let f = try await fila(slug, a)
        let fm = FileManager.default
        let ts = ReunionTexto.dia(Date()) + "-" + String(Int(Date().timeIntervalSince1970) % 100000)
        let rel = "archivos/.papelera/\(slug)-\(ts)"
        try? Plantillas.crearDir(a.ruta(rel))
        // los archivos subidos se mueven (nada se borra); los vinculados no se tocan (son del usuario, fuera de la oficina)
        var destino = f.ruta
        if f.origen == "subido" {
            let d = Extraccion.rutaLibre(a.ruta(rel), f.nombre)
            if (try? fm.moveItem(atPath: a.ruta(f.ruta), toPath: d)) != nil { destino = rel + "/" + (d as NSString).lastPathComponent }
        }
        for (de, a2) in [("conocimiento/fuentes/\(slug).md", "ficha.md"), ("archivos/.texto/\(slug).md", "texto.md")] {
            if fm.fileExists(atPath: a.ruta(de)) { try? fm.moveItem(atPath: a.ruta(de), toPath: a.ruta(rel + "/" + a2)) }
        }
        do { try await store.archivoPapelera(slug, oficina: a.carpeta, ruta: destino) } catch { throw ErrorAPI(500, "No pude quitar el archivo.") }
        await store.indiceQuitar(slug, oficina: a.carpeta)
        await regenerarCatalogo(a)
        return ["ok": true, "papelera": destino]
    }

    private func original(_ slug: String) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let f = try await fila(slug, a)
        return try contenidoDe(ruta: rutaAbsoluta(f, a), nombre: f.nombre, tipo: f.tipo)
    }

    /// `{nombre, tipo, mime, tam, ruta, base64?}`: la app no puede abrir un archivo local desde el WebView, así que los
    /// archivos de hasta 8 MB viajan en base64 (el front arma un Blob); los más grandes devuelven solo la ruta.
    private func contenidoDe(ruta: String, nombre: String, tipo: String) throws -> [String: Any] {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: ruta), let tam = (attrs[.size] as? NSNumber)?.int64Value else {
            throw ErrorAPI(404, "El archivo original ya no está en esa ubicación.")
        }
        var o: [String: Any] = ["nombre": nombre, "tipo": tipo, "mime": TipoArchivo.mime(tipo), "tam": tam, "ruta": ruta]
        if tam <= Self.maxBase64Directo, let d = FileManager.default.contents(atPath: ruta) { o["base64"] = d.base64EncodedString() }
        return o
    }

    private func reprocesar(_ slug: String) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let f = try await fila(slug, a)
        guard let h = Extraccion.sha256(archivo: rutaAbsoluta(f, a)) else { throw ErrorAPI(404, "El archivo original ya no está en esa ubicación.") }
        let tam = ((try? FileManager.default.attributesOfItem(atPath: rutaAbsoluta(f, a)))?[.size] as? NSNumber)?.int64Value ?? f.tam
        try await store.archivoReprocesar(slug, oficina: a.carpeta, hash: h, tam: tam)
        despertar()
        return ["archivo": vista(await store.archivo(slug, oficina: a.carpeta) ?? f)]
    }

    // MARK: lectura por rol

    /// Agentes a los que les sirve: los de los departamentos de `util_para` (si no hay, los del departamento donde está
    /// el archivo), limitados por el alcance de la carpeta vinculada.
    private func lectoresPorDefecto(_ f: ArchivoFila, _ o: Oficina) -> [String] {
        var deps = f.ficha?.utilPara ?? []
        if deps.isEmpty, o.departamento(f.departamento) != nil { deps = [f.departamento] }
        var ags = o.agentes.filter { deps.contains($0.departamento) }
        if let v = f.vinculo, let vin = o.vinculos?.first(where: { $0.id == v }) { ags = ags.filter { vin.alcance.incluye($0) } }
        return Array(ags.prefix(Biblioteca.maxLectores)).map(\.id)
    }

    private func leer(_ slug: String, _ body: Data?) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let f = try await fila(slug, a)
        let d = try objetoOpcional(body)
        guard ["listo", "error"].contains(f.estado), f.ficha != nil else {
            throw ErrorAPI(409, f.ficha == nil ? "Todavía no hay ficha de este archivo: esperá a que termine de procesarse." : "El archivo todavía se está procesando.")
        }
        var ids: [String]
        if let v = d["agentes"], !(v is NSNull) {
            guard let arr = v as? [Any] else { throw ErrorAPI(400, "«agentes» tiene que ser una lista de ids.") }
            ids = []
            for x in arr {
                guard let id = x as? String, a.oficina.agente(id) != nil else { throw ErrorAPI(400, "Hay un agente que no está en la oficina.") }
                if !ids.contains(id) { ids.append(id) }
            }
            if ids.count > Biblioteca.maxLectores { throw ErrorAPI(400, "Máximo \(Biblioteca.maxLectores) agentes por lectura.") }
        } else {
            ids = lectoresPorDefecto(f, a.oficina)
        }
        guard !ids.isEmpty else { throw ErrorAPI(409, "No hay agentes a quienes les sirva este documento (revisá «útil para» o elegí agentes).") }
        do { try await store.archivoPedirLectura(slug, oficina: a.carpeta, agentes: ids) } catch { throw ErrorAPI(500, "No pude pedir la lectura.") }
        despertar()
        return ["archivo": vista(await store.archivo(slug, oficina: a.carpeta) ?? f), "agentes": ids]
    }

    // MARK: cola

    func despertar() {
        if trabajador != nil { otraVuelta = true; return }
        trabajador = Task { await self.bucle() }
    }

    private func bucle() async {
        while true {
            if let f = await store.siguienteArchivo() {
                await procesar(f)
                continue
            }
            if otraVuelta { otraVuelta = false; continue }
            break
        }
        trabajador = nil
    }

    private func sigue(_ f: ArchivoFila) async -> Bool {
        if let x = await store.archivo(f.slug, oficina: f.oficina), !x.papelera { return true }
        return false
    }

    private func procesar(_ f0: ArchivoFila) async {
        var f = f0
        guard let of = try? OficinaStore.leer(carpeta: f.oficina) else {
            try? await store.archivoEstado(f.slug, oficina: f.oficina, "error", error: "No pude leer la oficina.")
            return
        }
        let a = OficinaActiva(carpeta: f.oficina, oficina: of)
        if f.estado == "pendiente" {
            await extraerYFichar(&f, a)
            guard await sigue(f) else { return }
            guard let x = await store.archivo(f.slug, oficina: f.oficina) else { return }
            f = x
        }
        if f.estado == "leyendo" { await leerPorRol(f, a) }
    }

    /// Extrae el texto, ficha, indexa y deja el catálogo al día. Termina en `listo`, `error` o `leyendo`.
    private func extraerYFichar(_ f: inout ArchivoFila, _ a: OficinaActiva) async {
        let slug = f.slug, carpeta = a.carpeta
        let ruta = rutaAbsoluta(f, a)
        try? await store.archivoEstado(slug, oficina: carpeta, "extrayendo")
        try? await store.archivoAviso(slug, oficina: carpeta, nil)
        // 1) texto
        let tipo = f.tipo
        var r = await Task.detached { Extraccion.texto(de: ruta, ext: tipo) }.value
        if r.necesitaVision {
            do {
                let p = """
                Describí la imagen que está en «\(ruta)» (usá la herramienta Read para verla). Incluí todo el texto visible tal cual, números, objetos, personas (sin identificarlas), colores y contexto. Respondé en español, en texto plano, sin inventar lo que no se ve.
                """
                let caja = CajaCosto()
                defer { let c = caja.valor, st = store; Task { await st.registrarCosto(oficina: carpeta, origen: "biblioteca", ref: slug, costo: c) } }
                let t = try await runner.correrConLectura(prompt: p, cwd: carpeta, dirs: [(ruta as NSString).deletingLastPathComponent],
                                                          timeout: timeoutImagen, obs: caja.observador())
                let limpio = t.trimmingCharacters(in: .whitespacesAndNewlines)
                if limpio.isEmpty { r.aviso = "Claude no devolvió una descripción de la imagen." } else { r.texto = limpio }
            } catch let e as ClaudeError {
                r.aviso = "No pude describir la imagen: \(e.mensaje)"
            } catch { r.aviso = "No pude describir la imagen." }
        }
        guard await sigue(f) else { return }
        let texto = r.texto ?? ""
        if !texto.isEmpty { try? escribir(texto, a.ruta("archivos/.texto/\(slug).md")) }
        try? await store.archivoEstado(slug, oficina: carpeta, "fichando")
        if let av = r.aviso { try? await store.archivoAviso(slug, oficina: carpeta, av) }
        // 2) sin texto: no hay qué fichar; queda buscable por nombre
        if texto.isEmpty {
            let aviso = r.aviso ?? "No pude sacar texto de este archivo."
            try? await store.indiceGuardar(slug, oficina: carpeta, titulo: f.nombre, resumen: "", temas: "", texto: "")
            try? await store.archivoEstado(slug, oficina: carpeta, "error", error: aviso)
            try? await store.archivoAviso(slug, oficina: carpeta, aviso)
            await regenerarCatalogo(a)
            return
        }
        // 3) ficha del bibliotecario
        var ficha: Ficha?
        var contradicciones: [Contradiccion] = []
        var errorFicha: String?
        do {
            let p = Biblioteca.promptFicha(oficina: a.oficina, carpeta: carpeta, nombre: f.nombre, tipo: f.tipo, departamento: f.departamento, texto: texto)
            let caja = CajaCosto()
            defer { let c = caja.valor, st = store; Task { await st.registrarCosto(oficina: carpeta, origen: "biblioteca", ref: slug, costo: c) } }
            let t = try await runner.correrSinAgente(prompt: p, timeout: timeoutFicha, cwd: carpeta, obs: caja.observador())
            if let (fi, cs) = Biblioteca.parsearFicha(t, nombre: f.nombre, oficina: a.oficina) { ficha = fi; contradicciones = cs }
            else { errorFicha = "El bibliotecario no devolvió la ficha en el formato esperado." }
        } catch let e as ClaudeError { errorFicha = e.mensaje }
        catch { errorFicha = "No pude fichar el documento." }
        guard await sigue(f) else { return }
        // 4) indexar (con o sin ficha: el texto siempre es buscable)
        if let fi = ficha {
            f.ficha = fi
            try? await store.archivoFicha(slug, oficina: carpeta, ficha: fi)
            try? escribir(Biblioteca.fichaMD(f, ficha: fi, oficina: a.oficina, carpeta: carpeta), a.ruta("conocimiento/fuentes/\(slug).md"))
            for c in contradicciones {
                try? await store.propuestaAgregar(PropuestaFila(id: UUID().uuidString.lowercased(), oficina: carpeta, archivo: slug, titulo: fi.titulo,
                                                                actual: c.actual, nuevo: c.nuevo, sugerencia: c.sugerencia, estado: "pendiente",
                                                                creada: Date().timeIntervalSince1970))
            }
        }
        try? await store.indiceGuardar(slug, oficina: carpeta, titulo: [ficha?.titulo ?? "", f.nombre].joined(separator: " "),
                                       resumen: ficha?.resumen ?? "", temas: (ficha?.temas ?? []).joined(separator: " "), texto: texto)
        // el estado de error va antes del catálogo: si no, la línea queda para siempre en «en proceso»
        if ficha == nil { try? await store.archivoEstado(slug, oficina: carpeta, "error", error: errorFicha) }
        await regenerarCatalogo(a)
        guard let fi = ficha else { return }
        // 5) ¿lectura por rol?
        let auto = a.oficina.biblioteca?.lecturaAutomatica ?? false
        if f.leerPedido || auto {
            f.ficha = fi
            let ids = lectoresPorDefecto(f, a.oficina)
            if !ids.isEmpty {
                try? await store.archivoPedirLectura(slug, oficina: carpeta, agentes: ids)
                try? await store.archivoEstado(slug, oficina: carpeta, "leyendo")
                return
            }
        }
        try? await store.archivoEstado(slug, oficina: carpeta, "listo")
    }

    /// Cada agente lee la ficha y anota en SU archivo de notas (único permiso de escritura), en su carril.
    private func leerPorRol(_ f: ArchivoFila, _ a: OficinaActiva) async {
        let carpeta = a.carpeta, slug = f.slug
        let titulo = f.ficha?.titulo ?? f.nombre
        let ids = f.leer
        var resultados: [String: String] = [:]
        leyendoAhora.formUnion(ids)
        defer { leyendoAhora.subtract(ids) }
        for (i, id) in ids.enumerated() {
            guard await sigue(f) else { return }
            guard let ag = a.oficina.agente(id) else { resultados[id] = "error: el agente ya no está en la oficina"; continue }
            let prompt = Biblioteca.promptLectura(titulo: titulo, nombre: f.nombre, slug: slug, agente: ag, esImagen: TipoArchivo.imagenes.contains(f.tipo),
                                                  ruta: rutaAbsoluta(f, a))
            var c = ContextoOficina(carpeta: carpeta, escritura: [a.ruta("conocimiento/agentes/\(id).md")],
                                    dirsExtra: Permisos.dirsVinculos(a.oficina, agente: ag))
            c.vedadas = ["mcp__claude_ai_*"] // leer una ficha no usa conectores de claude.ai (plan §3)
            let ctx = c
            let runner = self.runner
            let caja = CajaCosto(), st = store
            defer { let c = caja.valor; Task { await st.registrarCosto(oficina: carpeta, agente: id, origen: "biblioteca", ref: slug, costo: c) } }
            do {
                _ = try await runner.conCarril(oficina: carpeta, agente: id) {
                    try await runner.actividad.seguir(oficina: carpeta, agente: id, origen: "biblioteca", tarea: "Leyendo " + f.nombre,
                                                      extra: caja.observador()) { obs, _ in
                        try await runner.ejecutarChat(agente: id, mensaje: prompt, sid: UUID().uuidString.lowercased(), activa: false,
                                                      oficina: ctx, obs: obs)
                    }
                }
                resultados[id] = "ok"
            } catch let e as ClaudeError {
                if e == .cerrando { return }
                resultados[id] = "error: " + e.mensaje
            } catch { resultados[id] = "error: no pude correr al agente" }
            try? await store.archivoLeer(slug, oficina: carpeta, pendientes: Array(ids.dropFirst(i + 1)), resultados: resultados)
        }
        try? await store.archivoLeer(slug, oficina: carpeta, pendientes: [], resultados: resultados)
        try? await store.archivoEstado(slug, oficina: carpeta, "listo")
    }

    // MARK: catálogo

    func regenerarCatalogo(_ a: OficinaActiva) async {
        let filas = await store.archivos(oficina: a.carpeta)
        try? escribir(Biblioteca.catalogoMD(filas, oficina: a.oficina), a.ruta("conocimiento/archivos.md"))
    }

    // MARK: estado, config y propuestas

    private func estado() async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let filas = await store.archivos(oficina: a.carpeta)
        let activos = filas.filter { $0.estado != "listo" }
        let enCurso = filas.filter { ["pendiente", "extrayendo", "fichando", "leyendo"].contains($0.estado) }
        let cola = activos.map { f -> [String: Any] in
            var o: [String: Any] = ["slug": f.slug, "nombre": f.nombre, "estado": f.estado]
            if let e = f.error { o["error"] = e }
            if let av = f.aviso { o["aviso"] = av }
            if !f.leer.isEmpty { o["leer"] = f.leer }
            return o
        }
        let lee = Array(leyendoAhora.intersection(Set(a.oficina.agentes.map(\.id)))).sorted()
        let props = await store.propuestas(oficina: a.carpeta, todas: false).count
        return ["cola": cola, "pendientes": enCurso.count, "total": filas.count, "leyendo": lee, "propuestas": props,
                "fts": await store.indiceEsFTS()]
    }

    private func config() async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let l = limites(a.oficina)
        return ["lecturaAutomatica": a.oficina.biblioteca?.lecturaAutomatica ?? false, "maxMB": Int(l.maxArchivoBytes / 1_048_576),
                "maxArchivos": l.maxArchivos, "maxTotalMB": Int(l.maxTotalBytes / 1_048_576), "extensiones": TipoArchivo.soportados.sorted()]
    }

    private func cambiarConfig(_ body: Data?) async throws -> [String: Any] {
        let d = try objeto(body)
        func entero(_ k: String, _ max: Int) throws -> Int? {
            guard let v = d[k], !(v is NSNull) else { return nil }
            guard let n = (v as? NSNumber).flatMap({ CFGetTypeID($0) == CFBooleanGetTypeID() ? nil : $0.intValue }), n >= 1, n <= max else {
                throw ErrorAPI(400, "«\(k)» tiene que ser un número entre 1 y \(max).")
            }
            return n
        }
        let auto = d["lecturaAutomatica"] as? Bool
        if d["lecturaAutomatica"] != nil, auto == nil, !(d["lecturaAutomatica"] is NSNull) { throw ErrorAPI(400, "«lecturaAutomatica» tiene que ser verdadero o falso.") }
        let mb = try entero("maxMB", 500), na = try entero("maxArchivos", 5000), mt = try entero("maxTotalMB", 20000)
        _ = try await oficinas.modificar { o in
            var c = o.biblioteca ?? BibliotecaCfg()
            if let auto { c.lecturaAutomatica = auto }
            if let mb { c.maxMB = mb }
            if let na { c.maxArchivos = na }
            if let mt { c.maxTotalMB = mt }
            o.biblioteca = c
        }
        return try await config()
    }

    private func vistaPropuesta(_ p: PropuestaFila) -> [String: Any] {
        var o: [String: Any] = ["id": p.id, "archivo": p.archivo, "titulo": p.titulo, "actual": p.actual, "nuevo": p.nuevo,
                                "sugerencia": p.sugerencia, "estado": p.estado, "creada": Biblioteca.iso(p.creada)]
        if let r = p.resuelta { o["resuelta"] = Biblioteca.iso(r) }
        return o
    }

    private func propuestas(_ q: [String: String]) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let todas = q["todas"] == "1"
        return ["propuestas": await store.propuestas(oficina: a.carpeta, todas: todas).map(vistaPropuesta)]
    }

    private func resolverPropuesta(_ id: String, _ body: Data?) async throws -> [String: Any] {
        guard Router.uuidValido(id) else { throw ErrorAPI(404, "No encontré esa propuesta.") }
        let a = try await oficinas.requerirActiva()
        guard let aceptar = try objeto(body)["aceptar"] as? Bool else { throw ErrorAPI(400, "Falta «aceptar» (verdadero o falso).") }
        guard let p = await store.propuesta(id.lowercased(), oficina: a.carpeta) else { throw ErrorAPI(404, "No encontré esa propuesta.") }
        guard p.estado == "pendiente" else { throw ErrorAPI(409, "Esa propuesta ya fue resuelta.") }
        if aceptar {
            do { try Biblioteca.anexarActualizacion(carpeta: a.carpeta, sugerencia: p.sugerencia, titulo: p.titulo, slug: p.archivo) }
            catch { throw ErrorAPI(500, "No pude actualizar la memoria de la oficina.") }
        }
        do { try await store.propuestaResolver(p.id, estado: aceptar ? "aceptada" : "rechazada") } catch { throw ErrorAPI(500, "No pude guardar la decisión.") }
        var v = vistaPropuesta(await store.propuesta(p.id, oficina: a.carpeta) ?? p)
        v["aplicada"] = aceptar
        return ["propuesta": v]
    }

    // MARK: entregables

    private func carpetaEntregables(_ q: [String: String], _ a: OficinaActiva) throws -> (id: String, dir: String) {
        guard let id = q["agente"], Slug.valido(id) else { throw ErrorAPI(400, "Falta el agente.") }
        return (id, a.ruta("archivos/entregables/\(id)"))
    }

    private func entregables(_ q: [String: String]) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let (id, dir) = try carpetaEntregables(q, a)
        let items = await Task.detached { Self.recorrerEntregables(dir) }.value
        return ["agente": id, "carpeta": "archivos/entregables/\(id)", "entregables": items]
    }

    nonisolated static func recorrerEntregables(_ dir: String) -> [[String: Any]] {
        var out: [(Double, [String: Any])] = []
        guard let en = FileManager.default.enumerator(at: URL(fileURLWithPath: dir), includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey],
                                                      options: [.skipsHiddenFiles]) else { return [] }
        let base = URL(fileURLWithPath: dir).resolvingSymlinksInPath().path
        for case let u as URL in en {
            guard let v = try? u.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]), v.isRegularFile == true else { continue }
            let p = u.resolvingSymlinksInPath().path
            let rel = p.hasPrefix(base + "/") ? String(p.dropFirst(base.count + 1)) : u.lastPathComponent
            let t = v.contentModificationDate?.timeIntervalSince1970 ?? 0
            out.append((t, ["nombre": u.lastPathComponent, "ruta": rel, "tam": v.fileSize ?? 0, "tipo": u.pathExtension.lowercased(),
                            "modificado": Biblioteca.iso(t)]))
            if out.count >= 300 { break }
        }
        return out.sorted { $0.0 > $1.0 }.map { $0.1 }
    }

    private func entregable(_ q: [String: String]) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let (_, dir) = try carpetaEntregables(q, a)
        guard let rel = q["ruta"], !rel.isEmpty, !rel.contains("\0") else { throw ErrorAPI(400, "Falta la ruta del entregable.") }
        let base = URL(fileURLWithPath: dir).resolvingSymlinksInPath().path
        let p = URL(fileURLWithPath: dir).appendingPathComponent(rel).resolvingSymlinksInPath().path
        guard p.hasPrefix(base + "/"), FileManager.default.fileExists(atPath: p) else { throw ErrorAPI(404, "No encontré ese entregable.") }
        return try contenidoDe(ruta: p, nombre: (p as NSString).lastPathComponent, tipo: (p as NSString).pathExtension.lowercased())
    }

    // MARK: vínculos

    private func vistaVinculo(_ v: Vinculo, _ filas: [ArchivoFila]) -> [String: Any] {
        let mios = filas.filter { $0.vinculo == v.id }
        return ["id": v.id, "ruta": v.ruta, "alcance": v.alcance.json, "archivos": mios.count,
                "existe": FileManager.default.fileExists(atPath: v.ruta), "pendientes": mios.filter { $0.estado != "listo" && $0.estado != "error" }.count]
    }

    private func listarVinculos() async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let filas = await store.archivos(oficina: a.carpeta)
        return ["vinculos": (a.oficina.vinculos ?? []).map { vistaVinculo($0, filas) }]
    }

    private func alcanceDe(_ v: Any?, _ o: Oficina) throws -> AlcanceVinculo {
        guard let v, !(v is NSNull) else { return .oficina }
        if let s = v as? String {
            guard s == "oficina" else { throw ErrorAPI(400, "«alcance» tiene que ser \"oficina\", {departamentos:[...]} o {agentes:[...]}.") }
            return .oficina
        }
        guard let d = v as? [String: Any] else { throw ErrorAPI(400, "«alcance» tiene que ser \"oficina\", {departamentos:[...]} o {agentes:[...]}.") }
        func ids(_ k: String) throws -> [String]? {
            guard let x = d[k] else { return nil }
            guard let arr = x as? [Any], !arr.isEmpty else { throw ErrorAPI(400, "«alcance.\(k)» tiene que ser una lista con al menos un id.") }
            var out: [String] = []
            for e in arr {
                guard let s = e as? String, Slug.valido(s) else { throw ErrorAPI(400, "«alcance.\(k)» tiene que ser una lista de ids.") }
                if !out.contains(s) { out.append(s) }
            }
            return out
        }
        if let deps = try ids("departamentos") {
            if let mal = deps.first(where: { o.departamento($0) == nil }) { throw ErrorAPI(400, "El departamento «\(mal)» no existe.") }
            return .departamentos(deps)
        }
        if let ags = try ids("agentes") {
            if let mal = ags.first(where: { o.agente($0) == nil }) { throw ErrorAPI(400, "El agente «\(mal)» no está en la oficina.") }
            return .agentes(ags)
        }
        throw ErrorAPI(400, "«alcance» tiene que ser \"oficina\", {departamentos:[...]} o {agentes:[...]}.")
    }

    private func crearVinculo(_ body: Data?) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        let d = try objeto(body)
        let cruda = try Validar.texto(d["ruta"], "ruta", max: 1024)!
        guard cruda.hasPrefix("/") || cruda == "~" || cruda.hasPrefix("~/") else { throw ErrorAPI(400, "La carpeta tiene que ser una ruta absoluta.") }
        let home = oficinas.config.home
        let ruta = Config.ruta(cruda, home: home)
        let real = URL(fileURLWithPath: ruta).resolvingSymlinksInPath().path
        let realHome = URL(fileURLWithPath: home).resolvingSymlinksInPath().path
        if ruta == "/" || real == "/" || ruta == home || real == realHome {
            throw ErrorAPI(400, "Esa carpeta es demasiado amplia: elegí una carpeta concreta (no «/» ni tu carpeta personal entera).")
        }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: ruta, isDirectory: &isDir) else { throw ErrorAPI(404, "No encuentro esa carpeta.") }
        guard isDir.boolValue else { throw ErrorAPI(400, "Eso no es una carpeta.") }
        let ofReal = URL(fileURLWithPath: a.carpeta).resolvingSymlinksInPath().path
        if real == ofReal || real.hasPrefix(ofReal + "/") { throw ErrorAPI(400, "Esa carpeta ya es parte de la oficina: no hace falta vincularla.") }
        let alcance = try alcanceDe(d["alcance"], a.oficina)
        let existentes = a.oficina.vinculos ?? []
        if existentes.contains(where: { $0.ruta == ruta }) { throw ErrorAPI(409, "Esa carpeta ya está vinculada.") }
        if existentes.count >= Self.maxVinculos { throw ErrorAPI(400, "Máximo \(Self.maxVinculos) carpetas vinculadas.") }
        let usados = Set(existentes.map(\.id))
        let id: String
        if let pid = try Validar.texto(d["id"], "id", max: 41, obligatorio: false) {
            guard Slug.valido(pid) else { throw ErrorAPI(400, "Id inválido (usá minúsculas, números y guiones).") }
            guard !usados.contains(pid) else { throw ErrorAPI(409, "Ya hay una carpeta vinculada con ese id.") }
            id = pid
        } else {
            id = Slug.unico((ruta as NSString).lastPathComponent, usados: usados, respaldo: "carpeta")
        }
        let v = Vinculo(id: id, ruta: ruta, alcance: alcance)
        _ = try await oficinas.modificar { o in o.vinculos = (o.vinculos ?? []) + [v] }
        log.info("biblioteca: carpeta vinculada id=\(id)")
        let filas = await store.archivos(oficina: a.carpeta)
        return ["vinculo": vistaVinculo(v, filas)]
    }

    private func quitarVinculo(_ id: String) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        guard (a.oficina.vinculos ?? []).contains(where: { $0.id == id }) else { throw ErrorAPI(404, "No existe esa carpeta vinculada.") }
        var quitados = 0
        for f in await store.archivos(oficina: a.carpeta) where f.vinculo == id {
            let rel = "archivos/.papelera/\(f.slug)-vinculo"
            for (de, a2) in [("conocimiento/fuentes/\(f.slug).md", "ficha.md"), ("archivos/.texto/\(f.slug).md", "texto.md")] {
                if FileManager.default.fileExists(atPath: a.ruta(de)) {
                    try? Plantillas.crearDir(a.ruta(rel))
                    try? FileManager.default.moveItem(atPath: a.ruta(de), toPath: a.ruta(rel + "/" + a2))
                }
            }
            try? await store.archivoPapelera(f.slug, oficina: a.carpeta, ruta: f.ruta)
            await store.indiceQuitar(f.slug, oficina: a.carpeta)
            quitados += 1
        }
        let (_, nueva) = try await oficinas.modificar { o in
            o.vinculos = (o.vinculos ?? []).filter { $0.id != id }
            if o.vinculos?.isEmpty == true { o.vinculos = nil }
        }
        await regenerarCatalogo(nueva)
        return ["ok": true, "quitados": quitados]
    }

    private func escanearVinculo(_ id: String) async throws -> [String: Any] {
        let a = try await oficinas.requerirActiva()
        guard let v = (a.oficina.vinculos ?? []).first(where: { $0.id == id }) else { throw ErrorAPI(404, "No existe esa carpeta vinculada.") }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: v.ruta, isDirectory: &isDir), isDir.boolValue else {
            throw ErrorAPI(404, "La carpeta vinculada ya no existe en esa ubicación.")
        }
        let lim = limites(a.oficina)
        let esc = await Task.detached {
            Extraccion.escanear(raiz: v.ruta, maxArchivos: lim.maxArchivos, maxBytes: lim.maxTotalBytes, maxArchivoBytes: lim.maxArchivoBytes)
        }.value
        let carpeta = a.carpeta
        var usados = await store.slugsUsados(oficina: carpeta)
        let previos = await store.archivos(oficina: carpeta).filter { $0.vinculo == id }
        var vistos = Set<String>()
        var nuevos = 0, actualizados = 0, iguales = 0
        let ahora = Date().timeIntervalSince1970
        for h in esc.hallados {
            vistos.insert(h.ruta)
            if let p = previos.first(where: { $0.ruta == h.ruta }) {
                if p.hash == h.hash { iguales += 1 }
                else { try? await store.archivoReprocesar(p.slug, oficina: carpeta, hash: h.hash, tam: h.tam); actualizados += 1 }
                continue
            }
            let nombre = (h.ruta as NSString).lastPathComponent
            let slug = Slug.unico((nombre as NSString).deletingPathExtension, usados: usados, respaldo: "archivo")
            usados.insert(slug)
            let f = ArchivoFila(slug: slug, oficina: carpeta, nombre: nombre, departamento: Biblioteca.carpetaVinculo, ruta: h.ruta, origen: "vinculo",
                                vinculo: id, tipo: TipoArchivo.extension_(nombre), tam: h.tam, hash: h.hash, estado: "pendiente", error: nil, aviso: nil,
                                ficha: nil, creado: ahora, actualizado: ahora)
            try? await store.archivoGuardar(f)
            nuevos += 1
        }
        // los que ya no están en la carpeta (y no quedaron fuera por el tope) salen de la biblioteca
        var quitados = 0
        for p in previos where !vistos.contains(p.ruta) && !FileManager.default.fileExists(atPath: p.ruta) {
            try? await store.archivoPapelera(p.slug, oficina: carpeta, ruta: p.ruta)
            await store.indiceQuitar(p.slug, oficina: carpeta)
            quitados += 1
        }
        if quitados > 0 || nuevos > 0 || actualizados > 0 { await regenerarCatalogo(a) }
        despertar()
        var o: [String: Any] = ["ok": true, "nuevos": nuevos, "actualizados": actualizados, "sinCambios": iguales, "quitados": quitados,
                                "omitidos": esc.omitidos, "tope": esc.tope]
        if esc.tope { o["aviso"] = "La carpeta tiene más archivos o más peso que el tope (\(lim.maxArchivos) archivos, \(lim.maxTotalBytes / 1_048_576) MB): se leyeron solo los primeros." }
        return o
    }
}
