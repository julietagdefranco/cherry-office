import Foundation

// Pendientes de reunión que se ejecutan (E1 de docs/plan-entregables.md):
// - «Hacelo ahora»: POST /api/reuniones/:id/pendientes/:n/encargar corre al agente con el pendiente como consigna
//   (un encargo del programador, id `encargo:<reunión>:<n>`), que al terminar deja una entrega.
// - «Convertir en tarea»: la tarea guarda `origen {reunion, pendiente}`.
// - Revisar la entrega de un encargo tilda su línea en las notas del agente.
// El estado de cada pendiente se calcula al leer la reunión (`pendientesEstado`): no hay tabla propia.
// Paridad: tools/hq_reuniones.py.

extension ReunionTexto {
    /// Consigna del encargo: el pendiente con su contexto (tema, acta) y dónde dejar lo que produzca.
    static func consignaEncargo(tema: String, acta: String?, pendiente p: Pendiente) -> String {
        var s = "Pendiente de la reunión «\(tema)»"
        if let acta { s += " (acta: `\(acta)`)" }
        s += ":\n\n\(p.que)\n\nHacelo ahora. Si producís un documento, guardalo en `archivos/entregables/` y decí al final qué archivo dejaste."
        return s
    }
}

extension PendientesReunion {
    /// Marca `- [x]` la línea del pendiente en las notas del agente. Devuelve si la encontró.
    @discardableResult
    static func tildar(carpeta: String, agente: String, linea: String) throws -> Bool {
        let ruta = (carpeta as NSString).appendingPathComponent("conocimiento/agentes/\(agente).md")
        guard var t = try? String(contentsOfFile: ruta, encoding: .utf8), linea.hasPrefix("- [ ] ") else { return false }
        let hecha = "- [x] " + linea.dropFirst(6)
        var hallada = false
        t = t.split(separator: "\n", omittingEmptySubsequences: false).map { l -> String in
            if !hallada, l == linea { hallada = true; return hecha }
            return String(l)
        }.joined(separator: "\n")
        guard hallada else { return false }
        try Data(t.utf8).write(to: URL(fileURLWithPath: ruta), options: .atomic)
        return true
    }

    /// Al revisar la entrega de un encargo: tilda el pendiente que lo originó (si sigue en las notas).
    static func tildarEncargo(_ e: Entrega, _ act: OficinaActiva, store: Store) async {
        guard e.origen == "encargo", let (reu, n) = Programador.deEncargo(e.ref),
              let f = await store.reunion(reu, oficina: act.carpeta), let js = f.sintesis,
              let s = ReunionTexto.parsearSintesis(js), n < s.pendientes.count else { return }
        let p = s.pendientes[n]
        guard let a = agente(de: p.quien, en: act.oficina) else { return }
        let dia = ReunionTexto.dia(Date(timeIntervalSince1970: f.cerrada ?? f.creada))
        _ = try? tildar(carpeta: act.carpeta, agente: a.id, linea: linea(p, tema: f.tema, dia: dia))
    }
}

extension Store {
    /// La entrega más nueva de un origen y referencia (p. ej. el encargo de un pendiente).
    func entregaPorRef(oficina: String, origen: String, ref: String) -> Entrega? {
        entregas(oficina: oficina, origen: origen, limite: 500).first { $0.ref == ref }
    }
}

extension ReunionesRouter {
    /// Pendientes de la síntesis de una reunión cerrada (nil si no está cerrada o no tiene).
    static func pendientes(_ f: ReunionFila) -> [Pendiente]? {
        guard f.estado == "cerrada", let js = f.sintesis, let s = ReunionTexto.parsearSintesis(js), !s.pendientes.isEmpty else { return nil }
        return s.pendientes
    }

    /// Estado de cada pendiente, en el orden de la síntesis: a quién le toca, si se puede encargar, el encargo (última
    /// ejecución y su entrega) y las tareas que salieron de él.
    func estadoPendientes(_ f: ReunionFila, _ a: OficinaActiva) async -> [[String: Any]]? {
        guard let ps = Self.pendientes(f) else { return nil }
        var out: [[String: Any]] = []
        for (i, p) in ps.enumerated() {
            let ag = PendientesReunion.agente(de: p.quien, en: a.oficina)
            var o: [String: Any] = ["pendiente": i, "agente": ag.map { $0.id as Any } ?? NSNull(),
                                    "encargable": ag != nil && !p.usuario && programador != nil]
            let idEnc = Programador.idEncargo(f.id, i)
            if let ej = await store.ultimaEjecucion(oficina: a.carpeta, tarea: idEnc) {
                var enc: [String: Any] = ["estado": ej.estado, "ejecucion": ej.id]
                if ej.estado == "error" { enc["error"] = ej.error ?? "Falló." }
                if let e = await store.entregaPorRef(oficina: a.carpeta, origen: "encargo", ref: idEnc) {
                    enc["entrega"] = e.id; enc["entregaEstado"] = e.estado
                }
                o["encargo"] = enc
            }
            o["tareas"] = (a.oficina.tareas ?? []).filter { $0.origen == OrigenTarea(reunion: f.id, pendiente: i) }
                .map { ["id": $0.id, "nombre": $0.nombre] }
            out.append(o)
        }
        return out
    }

    /// «Hacelo ahora»: valida el pendiente y lanza el encargo. 202 con la reunión (y su `pendientesEstado` actualizado).
    func encargar(_ id: String, _ n: Int) async throws -> [String: Any] {
        guard let programador else { throw ErrorAPI(404, "no") }
        let a = try await oficinas.requerirActiva()
        guard let f = await store.reunion(id, oficina: a.carpeta) else { throw ErrorAPI(404, "No encontré esa reunión.") }
        guard let ps = Self.pendientes(f) else { throw ErrorAPI(409, "La reunión todavía no tiene pendientes (se cierran con el acta).") }
        guard n < ps.count else { throw ErrorAPI(404, "No existe ese pendiente.") }
        let p = ps[n]
        if p.usuario { throw ErrorAPI(409, "Ese pendiente necesita tu parte: el agente no lo puede hacer solo.") }
        guard let def = PendientesReunion.agente(de: p.quien, en: a.oficina) else {
            throw ErrorAPI(409, "Ese pendiente no es de un agente de la oficina.")
        }
        _ = try await programador.encargar(a, def, reunion: id, pendiente: n, nombre: TextoEntrega.titulo(p.que),
                                           consigna: ReunionTexto.consignaEncargo(tema: f.tema, acta: f.acta, pendiente: p))
        return try await detalleConEstado(id, a)
    }

    private func detalleConEstado(_ id: String, _ a: OficinaActiva) async throws -> [String: Any] {
        guard let f = await store.reunion(id, oficina: a.carpeta) else { throw ErrorAPI(404, "No encontré esa reunión.") }
        return ["id": f.id, "pendientesEstado": await estadoPendientes(f, a) ?? []]
    }
}
