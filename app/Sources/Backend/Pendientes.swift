import Foundation

/// Pendientes de reunión que llegan a quien se encarga: al cerrar, cada pendiente asignado a un agente se anota en
/// sus notas (`conocimiento/agentes/<id>.md`, sección «Pendientes de reuniones»), que el agente lee al empezar.
/// Los que necesitan a la persona (correr programas, mandar mensajes, mirar el calendario…) quedan marcados y generan
/// un aviso «te necesita». Paridad: tools/hq_reuniones.py.
enum PendientesReunion {
    static let titulo = "## Pendientes de reuniones"

    static func normal(_ s: String) -> String {
        s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "es")).trimmingCharacters(in: .whitespaces)
    }

    /// Agente responsable de un pendiente: id exacto, nombre completo o primera palabra del nombre. nil = nadie / la persona.
    static func agente(de quien: String, en of: Oficina) -> AgenteDef? {
        let q = normal(quien)
        guard !q.isEmpty else { return nil }
        if let a = of.agentes.first(where: { normal($0.id) == q || normal($0.nombre) == q }) { return a }
        let primera = q.split(separator: " ").first.map(String.init) ?? q
        let cand = of.agentes.filter { normal($0.nombre).split(separator: " ").first.map(String.init) == primera }
        return cand.count == 1 ? cand[0] : nil
    }

    static func linea(_ p: Pendiente, tema: String, dia: String) -> String {
        let que = p.que.split(whereSeparator: \.isNewline).joined(separator: " ")
        return "- [ ] \(dia) · reunión «\(tema)»: \(que)" + (p.usuario ? " (necesita a la persona: avisale qué hace falta)" : "")
    }

    /// Anexa los pendientes a las notas de cada agente. Devuelve cuántos se anotaron por agente.
    @discardableResult
    static func repartir(carpeta: String, oficina of: Oficina, tema: String, pendientes: [Pendiente], fecha: Date) throws -> [String: Int] {
        let dia = ReunionTexto.dia(fecha)
        var porAgente: [String: [String]] = [:]
        for p in pendientes { if let a = agente(de: p.quien, en: of) { porAgente[a.id, default: []].append(linea(p, tema: tema, dia: dia)) } }
        for (id, lineas) in porAgente {
            let ruta = (carpeta as NSString).appendingPathComponent("conocimiento/agentes/\(id).md")
            var t = (try? String(contentsOfFile: ruta, encoding: .utf8)) ?? ""
            if !t.isEmpty, !t.hasSuffix("\n") { t += "\n" }
            if !t.contains(titulo) { t += (t.isEmpty ? "" : "\n") + titulo + "\n" }
            // se agregan al final de la sección (que es la última o la siguiente sección empieza con «## »)
            if let r = t.range(of: titulo) {
                let resto = t[r.upperBound...]
                let fin = resto.range(of: "\n## ").map { $0.lowerBound } ?? t.endIndex
                var bloque = String(t[r.upperBound..<fin])
                if !bloque.hasSuffix("\n") { bloque += "\n" }
                bloque += lineas.joined(separator: "\n") + "\n"
                t = String(t[..<r.upperBound]) + bloque + String(t[fin...])
            }
            try FileManager.default.createDirectory(atPath: (ruta as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            try Data(t.utf8).write(to: URL(fileURLWithPath: ruta), options: .atomic)
        }
        return porAgente.mapValues(\.count)
    }

    /// Texto que se suma a la consigna del secretario de actas.
    static func consignaSecretario(duenio: String) -> String {
        """

        Para cada pendiente agregá "necesita_usuario": true si el responsable NO lo puede hacer solo. Los agentes de la oficina \
        solo pueden leer archivos de la oficina y escribir sus notas y sus entregables: no pueden correr programas ni scripts, \
        mandar mensajes o mails, publicar, ni mirar el calendario, el correo u otras apps. Si un pendiente necesita eso, \
        asignalo a \(duenio.isEmpty ? "la persona dueña de la oficina" : duenio) (o al agente, con "necesita_usuario": true si \
        el agente prepara algo y la persona lo ejecuta). Usá en "quien" el nombre exacto de un participante o el de la persona.
        """
    }
}
