import Foundation

/// Resumen corto del pedido para el cartel sobre la cabeza del agente (#9). Lo hace Haiku en paralelo al chat;
/// mientras tanto se ve el mensaje recortado. Los mensajes cortos no se resumen (ya entran en el cartel).
public enum ResumenTarea {
    /// Mensajes de hasta este largo se muestran tal cual.
    public static let minimo = 40
    public static let timeout: TimeInterval = 20

    public static func hace(falta msg: String) -> Bool {
        msg.trimmingCharacters(in: .whitespacesAndNewlines).count > minimo
    }

    public static func prompt(_ msg: String) -> String {
        let m = msg.count > 2000 ? String(msg.prefix(2000)) + "…" : msg
        return """
        Resumí en 3 a 6 palabras, en español, qué le están pidiendo a la persona en este mensaje. Empezá con un verbo \
        en gerundio (por ejemplo «Armando el calendario de reels»). Respondé solo con el resumen, sin comillas ni punto final.

        Mensaje:
        \(m)
        """
    }

    /// Primera línea, sin comillas ni punto final, máx. 48 caracteres. Vacío -> nil.
    public static func limpiar(_ s: String) -> String? {
        var t = s.split(separator: "\n").first.map(String.init) ?? ""
        t = t.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\"'«»“”*")))
        while t.hasSuffix(".") { t.removeLast() }
        guard !t.isEmpty else { return nil }
        return ActividadRegistro.recortar(t)
    }
}

extension ClaudeRunner {
    /// Lanza el resumen en segundo plano y lo vuelca en la actividad de esa corrida. Devuelve la Task (cancelable)
    /// o nil si el mensaje es corto. El costo se registra con origen "resumen".
    func resumirTarea(_ msg: String, oficina: String, agente: String, token: String, store: Store) -> Task<Void, Never>? {
        guard ResumenTarea.hace(falta: msg) else { return nil }
        return Task.detached { [self] in
            let caja = CajaCosto()
            defer { let c = caja.valor; Task { await store.registrarCosto(oficina: oficina, agente: agente, origen: "resumen", costo: c) } }
            guard let t = try? await correrSinAgente(prompt: ResumenTarea.prompt(msg), timeout: ResumenTarea.timeout, cwd: oficina,
                                                     modelo: "haiku", obs: caja.observador()),
                  !Task.isCancelled, let r = ResumenTarea.limpiar(t) else { return }
            actividad.tarea(oficina: oficina, agente: agente, token: token, texto: r)
        }
    }
}
