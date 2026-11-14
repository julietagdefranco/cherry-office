import Foundation

/// `/api/entregas*`: entregas de la oficina activa. Mismas rutas, validaciones y textos que tools/hq_entregas.py.
///   GET  /api/entregas?estado=&agente=&origen=&limite=   → {entregas, sinRevisar}
///   GET  /api/entregas/:id                               → {entrega} (con el texto completo)
///   POST /api/entregas/:id/revisada | /sin-revisar       → {entrega, sinRevisar}
public struct EntregasRouter: SubRouter {
    private let oficinas: Oficinas
    private let store: Store
    /// Corre los «Pedir cambios». nil = sin esa ruta (tests).
    private let programador: Programador?
    static let maxBody = 200_000
    static let maxCambios = 4000
    /// Al revisar una entrega (E1: tilda el pendiente de reunión que la originó). Se setea al armar el backend.
    private let alRevisar: @Sendable (Entrega, OficinaActiva) async -> Void

    init(oficinas: Oficinas, store: Store, programador: Programador? = nil,
         alRevisar: @escaping @Sendable (Entrega, OficinaActiva) async -> Void = { _, _ in }) {
        self.oficinas = oficinas; self.store = store; self.programador = programador; self.alRevisar = alRevisar
    }

    static func esRuta(_ p: String) -> Bool { p == "/api/entregas" || p.hasPrefix("/api/entregas/") }

    public func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data)? {
        guard EntregasRouter.esRuta(path) else { return nil }
        let (code, obj) = await despachar(method: method, path: path, query: query, body: body)
        return (code, Router.codificar(obj))
    }

    private func despachar(method: String, path: String, query: [String: String], body: Data?) async -> (Int, [String: Any]) {
        let no: (Int, [String: Any]) = (405, ["error": "método no permitido"])
        let partes = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        guard partes.count >= 2, partes.count <= 4, !partes.contains("") else { return (404, ["error": "no"]) }
        do {
            let a = try await oficinas.requerirActiva()
            if partes.count == 2 {
                guard method == "GET" else { return no }
                return try await listar(a, query)
            }
            guard let id = Int64(partes[2]), id > 0 else { return (404, ["error": "no"]) }
            guard let e = await store.entrega(oficina: a.carpeta, id: id) else { return (404, ["error": "No existe esa entrega."]) }
            if partes.count == 3 {
                guard method == "GET" else { return no }
                var o = e.jsonCompleto
                o["enCambios"] = await programador?.cambiandoEntrega(oficina: a.carpeta, id: id) ?? false
                return (200, ["entrega": o])
            }
            guard method == "POST" else { return no }
            switch partes[3] {
            case "revisada":
                if e.estado == "cambios" { throw ErrorAPI(409, "Esa entrega ya tiene una versión nueva.") }
                guard let n = await store.entregaMarcar(oficina: a.carpeta, id: id, estado: "revisada") else { throw ErrorAPI(500, "No pude guardar.") }
                await alRevisar(n, a)
                return (200, ["entrega": n.json, "sinRevisar": await store.entregasSinRevisar(oficina: a.carpeta)])
            case "sin-revisar":
                if e.estado == "cambios" { throw ErrorAPI(409, "Esa entrega ya tiene una versión nueva.") }
                guard let n = await store.entregaMarcar(oficina: a.carpeta, id: id, estado: "sin_revisar") else { throw ErrorAPI(500, "No pude guardar.") }
                return (200, ["entrega": n.json, "sinRevisar": await store.entregasSinRevisar(oficina: a.carpeta)])
            case "cambios":
                guard let programador else { return (404, ["error": "no"]) }
                if e.estado == "cambios" { throw ErrorAPI(409, "Esa entrega ya tiene una versión nueva.") }
                guard !e.sid.isEmpty, let def = a.oficina.agente(e.agente) else {
                    throw ErrorAPI(409, "Esta entrega no tiene una conversación para retomar.")
                }
                guard let body, !body.isEmpty, body.count <= EntregasRouter.maxBody,
                      let d = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { throw ErrorAPI(400, "pedido inválido") }
                let texto = try Validar.texto(d["texto"], "texto", max: EntregasRouter.maxCambios)!
                try await programador.pedirCambios(a, def, entrega: e, texto: texto)
                var o = e.json
                o["enCambios"] = true
                return (202, ["entrega": o])
            default:
                return (404, ["error": "no"])
            }
        } catch let e as ErrorAPI {
            return (e.status, ["error": e.mensaje])
        } catch {
            return (500, ["error": "error interno"])
        }
    }

    private func listar(_ a: OficinaActiva, _ q: [String: String]) async throws -> (Int, [String: Any]) {
        func filtro(_ k: String) -> String? { q[k].flatMap { $0.isEmpty || $0 == "todas" ? nil : $0 } }
        let estado = filtro("estado")
        if let estado, !Entrega.estados.contains(estado) { throw ErrorAPI(400, "«estado» tiene que ser sin_revisar, revisada o cambios.") }
        let limite = q["limite"].flatMap { Int($0) } ?? 100
        let lista = await store.entregas(oficina: a.carpeta, estado: estado, agente: filtro("agente"), origen: filtro("origen"), limite: limite)
        return (200, ["entregas": lista.map(\.json), "sinRevisar": await store.entregasSinRevisar(oficina: a.carpeta)])
    }
}
