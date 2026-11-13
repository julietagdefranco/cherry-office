import Foundation
import Testing
@testable import Backend

@Suite("Store")
struct StoreTests {
    func ruta(_ sb: Sandbox) -> String { sb.datos + "/hq.db" }

    @Test("persistencia entre instancias: sesiones, mensajes, activa, error")
    func persistencia() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        do {
            let s = try Store(path: ruta(sb))
            try await s.asegurarSesion(U.a, agente: "betty")
            try await s.agregar(sid: U.a, rol: "u", texto: "hola ñandú 🙂")
            try await s.agregar(sid: U.a, rol: "a", texto: "fallo", error: true)
            try await s.marcarActiva(U.a)
            await s.close()
        }
        let s2 = try Store(path: ruta(sb))
        #expect(await s2.agenteDe(U.a) == "betty")
        #expect(await s2.estaActiva(U.a))
        #expect(await s2.mensajes(U.a) == [Mensaje(r: "u", t: "hola ñandú 🙂"), Mensaje(r: "a", t: "fallo", e: true)])
        #expect(await s2.cuentaMensajes(U.a) == 2)
        #expect(await s2.ultimaSesion("betty") == U.a)
        #expect(await s2.ultimaSesion("marce") == nil)
    }

    @Test("crea la carpeta de datos si falta y la base queda en modo WAL")
    func creaCarpeta() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let p = sb.root + "/a/b/c/hq.db"
        let s = try Store(path: p)
        try await s.setMeta("k", "v")
        #expect(FileManager.default.fileExists(atPath: p))
        await s.close()
    }

    @Test("asegurarSesion no pisa agente ni activa de una sesión existente")
    func asegurarIdempotente() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try Store(path: ruta(sb))
        try await s.asegurarSesion(U.a, agente: "betty")
        try await s.marcarActiva(U.a)
        try await s.asegurarSesion(U.a, agente: "marce")
        #expect(await s.agenteDe(U.a) == "betty")
        #expect(await s.estaActiva(U.a))
        #expect(await s.agenteDe(U.b) == nil)
        #expect(await s.estaActiva(U.b) == false)
    }

    @Test("ultimaSesion ignora sesiones sin mensajes y elige la del mensaje más reciente")
    func ultimaSesion() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try Store(path: ruta(sb))
        try await s.asegurarSesion(U.a, agente: "betty")
        #expect(await s.ultimaSesion("betty") == nil)
        try await s.asegurarSesion(U.b, agente: "betty")
        try await s.asegurarSesion(U.c, agente: "betty")
        try await s.agregar(sid: U.a, rol: "u", texto: "1")
        try await s.agregar(sid: U.b, rol: "u", texto: "2")
        #expect(await s.ultimaSesion("betty") == U.b)
        try await s.agregar(sid: U.a, rol: "u", texto: "3")
        #expect(await s.ultimaSesion("betty") == U.a)
    }

    @Test("mensajes: límite devuelve los últimos N en orden cronológico")
    func limite() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try Store(path: ruta(sb))
        try await s.asegurarSesion(U.a, agente: "betty")
        for i in 1...10 { try await s.agregar(sid: U.a, rol: i % 2 == 1 ? "u" : "a", texto: "m\(i)") }
        #expect(await s.mensajes(U.a, limite: 3).map(\.t) == ["m8", "m9", "m10"])
        #expect(await s.mensajes(U.a).count == 10)
        #expect(await s.mensajes(U.b).isEmpty)
    }

    @Test("agregar con sesión inexistente falla (clave foránea)")
    func claveForanea() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try Store(path: ruta(sb))
        await #expect(throws: (any Error).self) { try await s.agregar(sid: U.a, rol: "u", texto: "x") }
    }

    @Test("meta: set, pisar y persistir")
    func meta() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try Store(path: ruta(sb))
        #expect(await s.meta("k") == nil)
        try await s.setMeta("k", "1")
        try await s.setMeta("k", "2")
        #expect(await s.meta("k") == "2")
        await s.close()
        #expect(await (try Store(path: ruta(sb))).meta("k") == "2")
    }

    @Test("importar: sesiones nuevas y mensajes; reimportar no duplica")
    func importar() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try Store(path: ruta(sb))
        var lote = LoteImportacion()
        lote.sesiones = [.init(sid: U.a, agente: "betty", activa: true, creada: 100),
                         .init(sid: U.b, agente: "marce", activa: false, creada: 200)]
        lote.mensajes = [.init(sid: U.a, r: "u", t: "p", e: false, ts: 1), .init(sid: U.a, r: "a", t: "r", e: true, ts: 2)]
        let r1 = try await s.importar(lote)
        #expect(r1.sesiones == 2 && r1.mensajes == 2)
        #expect(await s.estaActiva(U.a))
        #expect(await s.estaActiva(U.b) == false)
        #expect(await s.mensajes(U.a) == [Mensaje(r: "u", t: "p"), Mensaje(r: "a", t: "r", e: true)])
        let r2 = try await s.importar(lote)
        #expect(r2.sesiones == 0 && r2.mensajes == 0)
        #expect(await s.cuentaMensajes(U.a) == 2)
    }

    @Test("importar: no toca sesiones con mensajes propios y descarta mensajes de sesiones desconocidas")
    func importarConservador() async throws {
        let sb = Sandbox(); defer { withExtendedLifetime(sb) {} }
        let s = try Store(path: ruta(sb))
        try await s.asegurarSesion(U.a, agente: "betty")
        try await s.agregar(sid: U.a, rol: "u", texto: "mío")
        var lote = LoteImportacion()
        lote.sesiones = [.init(sid: U.a, agente: "marce", activa: true, creada: 1)]
        lote.mensajes = [.init(sid: U.a, r: "u", t: "ajeno", e: false, ts: 1), .init(sid: U.c, r: "u", t: "huérfano", e: false, ts: 1)]
        let r = try await s.importar(lote)
        #expect(r.sesiones == 0 && r.mensajes == 0)
        #expect(await s.agenteDe(U.a) == "betty")
        #expect(await s.mensajes(U.a).map(\.t) == ["mío"])
        #expect(await s.agenteDe(U.c) == nil)
    }
}
