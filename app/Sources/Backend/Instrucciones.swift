import Foundation

/// Instrucciones inyectadas a los agentes de oficina con `--append-system-prompt` (plan §4):
/// reglas de la oficina, límites del agente, conectores y rol de coordinador. Cada sección aparece solo si tiene algo.
enum Instrucciones {
    static let maxCaracteres = 8000

    static func para(_ o: Oficina, _ a: AgenteDef) -> String? {
        let jefe: String = {
            let d = o.duenio.trimmingCharacters(in: .whitespacesAndNewlines)
            return d.isEmpty ? "la persona" : d
        }()
        var secciones: [String] = []

        // reglas
        let reglas = (o.reglas ?? []).map { limpio($0.texto) }.filter { !$0.isEmpty }
        if !reglas.isEmpty {
            secciones.append("## Reglas de la oficina\n" + reglas.map { "- " + $0 }.joined(separator: "\n"))
        }

        // límites
        let solo = (a.limites?.solo ?? []).map(limpio).filter { !$0.isEmpty }
        let proponer = (a.limites?.proponer ?? []).map(limpio).filter { !$0.isEmpty }
        let conectores = a.conectores ?? []
        let actuaConectores = conectores.contains { !$0.actuar.isEmpty }
        if !solo.isEmpty || !proponer.isEmpty || actuaConectores || !reglas.isEmpty {
            var l = ["## Tus límites"]
            if !solo.isEmpty { l.append("Hacés solo: " + solo.joined(separator: "; ") + ".") }
            if !proponer.isEmpty {
                l.append("Dejás como propuesta y esperás la aprobación de \(jefe): " + proponer.joined(separator: "; ") + ".")
            }
            l.append("Nunca hacés directo nada que salga de la oficina (mandar un mail, crear un evento, publicar, gastar): lo dejás como propuesta.")
            secciones.append(l.joined(separator: "\n"))
        }

        // conectores
        var c: [String] = []
        let leen = conectores.filter { !$0.leer.isEmpty }
        if !leen.isEmpty {
            c.append("Podés leer con: " + leen.map { "\($0.servidor) (\($0.leer.map(Conectores.corto).joined(separator: ", ")))" }.joined(separator: "; ") + ".")
        }
        let actuan = conectores.filter { !$0.actuar.isEmpty }
        if !actuan.isEmpty {
            c.append("Para actuar con " + actuan.map { "\($0.servidor) (\($0.actuar.map(Conectores.corto).joined(separator: ", ")))" }.joined(separator: "; ")
                     + " usá la herramienta proponer_accion: \(jefe) la aprueba y recién ahí se ejecuta.")
        }
        if !c.isEmpty { secciones.append("## Conectores\n" + c.joined(separator: "\n")) }

        // coordinador
        if a.esCoordinador {
            secciones.append("## Sos coordinador/a de la oficina\n"
                + "Ves entregas, flujos y bloqueos de todos (herramientas estado_oficina, entregas, corridas, bloqueos) y podés repartir encargos (encargar). No hacés el trabajo de otros: lo pedís.")
        }

        guard !secciones.isEmpty else { return nil }
        let texto = secciones.joined(separator: "\n\n")
        return texto.count > maxCaracteres ? String(texto.prefix(maxCaracteres)) : texto
    }

    private static func limpio(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }
}
