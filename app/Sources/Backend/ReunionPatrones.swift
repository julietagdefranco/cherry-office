import Foundation

// Patrones de reunión (fase 3): quién habla en cada ronda y con qué consigna. Todo puro (sin actor ni disco, salvo lo
// que se indica) para poder probarlo aislado. Mismos textos y mismo orden que tools/hq_reuniones.py: si cambia una, cambia la otra.

enum PatronReunion: String, CaseIterable, Sendable {
    case debate, lider, mapreduce, redblue, revision

    var etiqueta: String {
        switch self {
        case .debate: return "Debate"
        case .lider: return "Líder y equipo"
        case .mapreduce: return "Map-reduce (opiniones independientes)"
        case .redblue: return "Red/blue (dos bandos)"
        case .revision: return "Panel de revisión"
        }
    }
}

/// Qué se le pide a quien habla en ese turno.
enum FaseTurno: String, Sendable {
    case libre       // debate y map-reduce
    case abre, opina, cierra   // líder y equipo
    case defiende, critica     // red/blue (bando A defiende, bando B critica)
    case revisa      // panel de revisión
}

struct PasoTurno: Sendable, Equatable {
    var agente: String
    var fase: FaseTurno
}

enum ReunionPatron {
    /// Orden de una ronda. `ids` ya viene en el orden de la reunión. Map-reduce devuelve el mismo orden, pero se corre en paralelo.
    static func plan(patron: PatronReunion, ids: [String], lider: String?, bandos: (a: [String], b: [String])?) -> [PasoTurno] {
        switch patron {
        case .debate:
            return ids.map { PasoTurno(agente: $0, fase: .libre) }
        case .mapreduce:
            return ids.map { PasoTurno(agente: $0, fase: .libre) }
        case .revision:
            return ids.map { PasoTurno(agente: $0, fase: .revisa) }
        case .lider:
            guard let l = lider, ids.contains(l) else { return ids.map { PasoTurno(agente: $0, fase: .libre) } }
            return [PasoTurno(agente: l, fase: .abre)] + ids.filter { $0 != l }.map { PasoTurno(agente: $0, fase: .opina) }
                + [PasoTurno(agente: l, fase: .cierra)]
        case .redblue:
            guard let b = bandos else { return ids.map { PasoTurno(agente: $0, fase: .libre) } }
            let a = ids.filter { b.a.contains($0) }, c = ids.filter { b.b.contains($0) }
            var out: [PasoTurno] = []
            for i in 0..<max(a.count, c.count) {
                if i < a.count { out.append(PasoTurno(agente: a[i], fase: .defiende)) }
                if i < c.count { out.append(PasoTurno(agente: c[i], fase: .critica)) }
            }
            return out
        }
    }

    /// Map-reduce: en la ronda en curso nadie ve los turnos de la misma ronda (sí las intervenciones del usuario y las rondas anteriores).
    static func visibles(patron: PatronReunion, turnos: [TurnoReunion], ronda: Int) -> [TurnoReunion] {
        patron == .mapreduce ? turnos.filter { $0.ronda < ronda || $0.agente == "usuario" } : turnos
    }

    // MARK: salida

    static func salidaPorDefecto(tema: String, fecha: Date) -> String {
        let s = Slug.de(tema)
        return "archivos/entregables/reuniones/\(ReunionTexto.dia(fecha))-\(s.isEmpty ? "reunion" : s).md"
    }

    /// Mensaje de error si `s` no sirve como ruta de salida; nil si está bien. Relativa, dentro de `archivos/`, sin `..`,
    /// sin componentes ocultos (así no pisa `archivos/.texto`) y termina en `.md`.
    static func errorDeSalida(_ s: String) -> String? {
        let malo = "«salida» tiene que ser una ruta relativa dentro de archivos/ que termine en .md (sin «..»)."
        if s.isEmpty || s.count > 200 || s.hasPrefix("/") || s.hasPrefix("~") || s.contains("\\") || s.contains("\0") { return malo }
        let comps = s.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if comps.count < 2 || comps[0] != "archivos" { return malo }
        if comps.contains(where: { $0.isEmpty || $0.hasPrefix(".") }) { return malo }
        let archivo = comps[comps.count - 1]
        if !archivo.lowercased().hasSuffix(".md") || archivo.count <= 3 { return malo }
        return nil
    }

    /// Si `rel` existe, `-2`, `-3`... antes de la extensión.
    static func rutaLibre(_ rel: String, existe: (String) -> Bool) -> String {
        if !existe(rel) { return rel }
        let base = String(rel.dropLast(3))
        var n = 2
        while existe("\(base)-\(n).md") { n += 1 }
        return "\(base)-\(n).md"
    }

    // MARK: consignas

    private static func nombres(_ l: [AgenteDef]) -> String { l.map { "\($0.nombre) (\($0.rol))" }.joined(separator: ", ") }

    /// Último párrafo del prompt de un turno. En debate es el texto de siempre.
    static func consigna(patron: PatronReunion, fase: FaseTurno, quien: AgenteDef, lider: AgenteDef?,
                         bandoA: [AgenteDef], bandoB: [AgenteDef]) -> String {
        let cierre = "Respondé solo con tu intervención, en primera persona y sin encabezados."
        switch (patron, fase) {
        case (.lider, .abre):
            return "Sos \(quien.nombre), \(quien.rol), y liderás esta reunión. Abrí la ronda en 100-150 palabras: encuadrá el tema, decí qué hay que resolver y dejale al equipo dos o tres preguntas concretas. \(cierre)"
        case (.lider, .opina):
            let l = lider.map { "\($0.nombre) (\($0.rol))" } ?? "el líder"
            return "Sos \(quien.nombre), \(quien.rol). \(l) lidera la reunión y ya abrió la ronda. Opiná desde tu rol en 120-180 palabras, respondiendo a lo que planteó y sin repetir lo ya dicho; decí con qué estás de acuerdo y con qué no, y proponé un próximo paso concreto. \(cierre)"
        case (.lider, .cierra):
            return "Sos \(quien.nombre), \(quien.rol), y liderás esta reunión. El equipo ya opinó en esta ronda. Cerrala con tu posición en 100-150 palabras: qué tomás de lo dicho, qué descartás y por qué, y qué queda por decidir. \(cierre)"
        case (.mapreduce, _):
            return "Sos \(quien.nombre), \(quien.rol). En esta ronda cada participante responde por separado y sin ver lo que dicen los demás; no asumas qué van a decir. Opiná desde tu rol en 120-180 palabras, con tu propia postura (podés apoyarte en lo dicho en rondas anteriores) y proponé un próximo paso concreto. \(cierre)"
        case (.redblue, .defiende):
            return "Esta reunión es un debate entre dos bandos. Bando A (defiende la propuesta o postura del tema): \(nombres(bandoA)). Bando B (la critica): \(nombres(bandoB)). Sos \(quien.nombre), \(quien.rol), del bando A: DEFENDÉS. Argumentá a favor desde tu rol en 120-180 palabras, respondiendo a las críticas del bando B si ya hablaron y sin repetir lo ya dicho, y proponé un próximo paso concreto. \(cierre)"
        case (.redblue, .critica):
            return "Esta reunión es un debate entre dos bandos. Bando A (defiende la propuesta o postura del tema): \(nombres(bandoA)). Bando B (la critica): \(nombres(bandoB)). Sos \(quien.nombre), \(quien.rol), del bando B: CRITICÁS. Señalá desde tu rol en 120-180 palabras los riesgos, huecos y objeciones de lo que defendió el bando A, sin repetir lo ya dicho, y proponé qué habría que cambiar o probar. \(cierre)"
        case (.revision, _):
            return "Sos \(quien.nombre), \(quien.rol). Esta reunión es un panel de revisión de los documentos adjuntos. Revisalos desde tu rol en 120-180 palabras: hallazgos (qué está bien y qué falla), riesgos y qué cambiarías, sin repetir lo que ya señalaron tus colegas. Si necesitás el texto completo, leelo en archivos/.texto/<slug>.md. \(cierre.replacingOccurrences(of: "tu intervención", with: "tu revisión"))"
        default:
            return "Sos \(quien.nombre), \(quien.rol). Opiná desde tu rol en 120-180 palabras, sin repetir lo ya dicho; decí con qué estás de acuerdo y con qué no, y proponé un próximo paso concreto. Respondé solo con tu opinión, en primera persona y sin encabezados."
        }
    }

    /// Frase que se suma al prompt de la síntesis según el patrón ("" en debate).
    static func varianteSintesis(patron: PatronReunion, lider: AgenteDef?, bandoA: [AgenteDef], bandoB: [AgenteDef]) -> String {
        switch patron {
        case .debate: return ""
        case .lider:
            return "\nLa reunión la lideró \(lider.map { "\($0.nombre) (\($0.rol))" } ?? "un líder"), que abrió y cerró cada ronda: su posición final pesa en las decisiones."
        case .mapreduce:
            return "\nCada participante opinó por separado en cada ronda, sin ver a los demás: en el resumen marcá las coincidencias y las diferencias entre posturas independientes."
        case .redblue:
            return "\nFue un debate entre dos bandos. Bando A (defiende): \(nombres(bandoA)). Bando B (critica): \(nombres(bandoB)). El resumen tiene que ponderar los argumentos de ambos bandos con equilibrio, y las decisiones reflejar qué se adopta y qué objeciones del bando B se incorporan."
        case .revision:
            return "\nFue un panel de revisión de los documentos adjuntos: en «decisiones» poné los cambios recomendados (concretos y accionables) y en «resumen» los hallazgos y riesgos principales."
        }
    }

    // MARK: archivo de salida

    static func markdownSalida(oficina: Oficina, f: ReunionFila, participantes: [AgenteDef], sintesis: SintesisReunion?,
                               errorSintesis: String?, acta: String?, fecha: Date) -> String {
        let patron = PatronReunion(rawValue: f.patron) ?? .debate
        var s = "# \(f.tema)\n\n"
        s += "- **Patrón:** \(patron.etiqueta)\n- **Oficina:** \(oficina.nombre)\n- **Fecha:** \(ReunionTexto.dia(fecha))\n"
        s += "- **Participantes:** " + participantes.map { "\($0.nombre) (\($0.rol))" }.joined(separator: ", ") + "\n"
        if patron == .lider, let l = f.lider { s += "- **Líder:** \(ReunionTexto.nombreDe(l, oficina: oficina))\n" }
        if patron == .redblue, let b = f.bandos {
            s += "- **Bando A (defiende):** " + (b["a"] ?? []).map { ReunionTexto.nombreDe($0, oficina: oficina) }.joined(separator: ", ") + "\n"
            s += "- **Bando B (critica):** " + (b["b"] ?? []).map { ReunionTexto.nombreDe($0, oficina: oficina) }.joined(separator: ", ") + "\n"
        }
        s += "\n## Resumen\n\n"
        if let x = sintesis {
            s += (x.resumen.isEmpty ? "_(sin resumen)_" : x.resumen) + "\n\n## " + (patron == .revision ? "Cambios recomendados" : "Decisiones") + "\n\n"
            s += x.decisiones.isEmpty ? "_(ninguna)_\n" : x.decisiones.map { "- \($0)" }.joined(separator: "\n") + "\n"
            s += "\n## Pendientes\n\n"
            s += x.pendientes.isEmpty ? "_(ninguno)_\n" : x.pendientes.map(\.lineaMD).joined(separator: "\n") + "\n"
        } else {
            s += "_No se pudo generar la síntesis\(errorSintesis.map { ": " + ReunionTexto.sinPuntoFinal($0) } ?? "")._\n"
        }
        s += "\n---\n" + (acta.map { "Acta completa con la transcripción: `\($0)`.\n" } ?? "_(el acta no se pudo guardar)_\n")
        return s
    }
}
