import Foundation
import Testing
@testable import Backend

extension Etapa2 {
@Suite("Pendientes de reunión")
struct PendientesTests {
    /// Caso real (reunión de Betty y Don Armando): los que el agente no puede hacer vienen marcados.
    static let sintesis = """
    {"resumen":"Se acordó una prueba visual.","decisiones":["Probar con un fragmento"],"pendientes":[
     {"quien":"Betty","que":"Leer oficina.md y decisiones.md para saber qué clase sigue","necesita_usuario":false},
     {"quien":"Betty","que":"Mandarle a Ana un mensaje con la decisión","necesita_usuario":true},
     {"quien":"Don Armando","que":"Probar transcribir.py con el fragmento limpio","necesita_usuario":true},
     {"quien":"Don Armando","que":"Pasarle a Betty capturas con y sin texto"},
     {"quien":"Ana","que":"Revisar el Calendar"}]}
    """

    @Test("al cerrar, cada pendiente llega a las notas de su agente; lo que necesita a la persona queda marcado y deja un aviso")
    func repartir() async throws {
        let f = try await Fix.crear(agentes: [("betty", "direccion", "Asistente"), ("armando", "direccion", "Editor")])
        _ = await f.patch("/api/agentes/armando", ["nombre": "Don Armando"])
        f.sb.responder("acta", Self.sintesis)
        let r = await f.post("/api/reuniones", ["tema": "prueba visual", "agentes": ["betty", "armando"]])
        let id = str(r.obj["id"])
        _ = await esperarAsync(hasta: 15) { str((await f.get("/api/reuniones/\(id)")).obj["estado"]) == "esperando" }
        #expect((await f.post("/api/reuniones/\(id)/cerrar")).status == 200)
        _ = await esperarAsync(hasta: 15) { str((await f.get("/api/reuniones/\(id)")).obj["estado"]) == "cerrada" }

        let betty = f.leer("conocimiento/agentes/betty.md")
        #expect(betty.contains("## Pendientes de reuniones"))
        #expect(betty.contains("reunión «prueba visual»: Leer oficina.md"))
        #expect(betty.contains("Mandarle a Ana un mensaje con la decisión (necesita a la persona"))
        #expect(!betty.contains("transcribir.py"))
        let arm = f.leer("conocimiento/agentes/armando.md")
        #expect(arm.contains("Probar transcribir.py con el fragmento limpio (necesita a la persona"))
        #expect(arm.contains("Pasarle a Betty capturas con y sin texto\n") || arm.hasSuffix("Pasarle a Betty capturas con y sin texto"))
        // 2 marcados + 1 asignado a la persona (Ana, la dueña) = 3 para vos
        let av = lista(await f.get("/api/avisos").obj["avisos"]).first { str($0["tipo"]) == "pendiente" } ?? [:]
        #expect(str(av["texto"]).contains("Quedaron 3 pendientes"))
        #expect(str(av["ref"]) == id)
        // el secretario recibe la consigna sobre lo que los agentes no pueden hacer
        #expect(f.sb.prompts.contains { $0.contains("necesita_usuario") && $0.contains("asignalo a Ana") })
        // una segunda reunión agrega a la misma sección, no la duplica
        let r2 = await f.post("/api/reuniones", ["tema": "otra", "agentes": ["betty"]])
        let id2 = str(r2.obj["id"])
        _ = await esperarAsync(hasta: 15) { str((await f.get("/api/reuniones/\(id2)")).obj["estado"]) == "esperando" }
        _ = await f.post("/api/reuniones/\(id2)/cerrar")
        _ = await esperarAsync(hasta: 15) { str((await f.get("/api/reuniones/\(id2)")).obj["estado"]) == "cerrada" }
        let b2 = f.leer("conocimiento/agentes/betty.md")
        #expect(b2.components(separatedBy: "## Pendientes de reuniones").count == 2)
        #expect(b2.contains("reunión «otra»"))
    }

    @Test("responsable: por id, nombre o primera palabra única; la persona o un nombre ambiguo no son agentes")
    func responsable() throws {
        var of = Oficina(nombre: "T", duenio: "Ana", departamentos: [], agentes: [])
        of.agentes = [AgenteDef(id: "armando", nombre: "Don Armando", rol: "x", departamento: "d"),
                      AgenteDef(id: "sofia", nombre: "Doña Sofía", rol: "x", departamento: "d"),
                      AgenteDef(id: "betty", nombre: "Betty", rol: "x", departamento: "d")]
        #expect(PendientesReunion.agente(de: "don armando", en: of)?.id == "armando")
        #expect(PendientesReunion.agente(de: "BETTY", en: of)?.id == "betty")
        #expect(PendientesReunion.agente(de: "Dona Sofia", en: of)?.id == "sofia")
        #expect(PendientesReunion.agente(de: "Ana", en: of) == nil)
        #expect(PendientesReunion.agente(de: "", en: of) == nil)
    }
}
}
