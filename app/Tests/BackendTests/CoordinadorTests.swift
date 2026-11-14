import Foundation
import Testing
@testable import Backend

/// Coordinador: perfil, herramientas MCP (`mcp__hq__estado_oficina`, `entregas`, `corridas`, `bloqueos`, `encargar`) y permisos.
@Suite("Coordinador", .serialized)
struct CoordinadorTests {
    func fix() async throws -> Fix {
        let f = try await Fix.crear(deps: ["Dirección"], agentes: [("marce", "direccion", "Directora"), ("nico", "direccion", "Anuncios")],
                                    env: ["HQ_PROGRAMADOR": "0"])
        let c = await contratar(f.b, id: "coordi", depto: "direccion", rol: "Coordinadora", extra: ["permisos": ["coordinador"]])
        try #require(c.status == 200, "contratar coordinador: \(c.obj)")
        return f
    }

    /// Las herramientas que ve un token con ese perfil.
    func tools(_ f: Fix, agente: String, perfil: String) -> MCPHerramientas {
        let t = f.b.mcp.tokens.emitir(oficina: f.carpeta, agente: agente, sid: U.a, perfil: perfil)
        return f.b.mcp.consultas.herramientas(token: t, identidad: IdentidadMCP(oficina: f.carpeta, agente: agente, sid: U.a, perfil: perfil))
    }

    func nombres(_ h: MCPHerramientas) -> [String] { h.definiciones.compactMap { $0["name"] as? String } }

    func objeto(_ r: MCPResultado?) -> [String: Any] {
        ((try? JSONSerialization.jsonObject(with: Data((r?.texto ?? "").utf8))) as? [String: Any]) ?? [:]
    }

    // MARK: perfil y lista

    @Test("perfil: coordinador si tiene el permiso; herramientasMCP solo para él")
    func perfilYLista() {
        let marce = AgenteDef(id: "marce", nombre: "Marce", rol: "r", departamento: "d")
        let coordi = AgenteDef(id: "coordi", nombre: "Coordi", rol: "r", departamento: "d", permisos: ["coordinador"])
        let o = Oficina(nombre: "O", duenio: "D", departamentos: [], agentes: [marce, coordi])
        #expect(Coordinador.perfil(o, marce) == "agente" && Coordinador.perfil(o, coordi) == "coordinador")
        #expect(Coordinador.herramientasMCP(o, marce).isEmpty)
        #expect(Coordinador.herramientasMCP(o, coordi) == ["mcp__hq__estado_oficina", "mcp__hq__entregas", "mcp__hq__corridas", "mcp__hq__bloqueos", "mcp__hq__encargar"])
        #expect(HerramientasMCPAgente.lista(o, coordi) == Permisos.herramientasMCP + Coordinador.herramientasMCP(o, coordi))
        #expect(HerramientasMCPAgente.lista(o, marce) == Permisos.herramientasMCP)
    }

    @Test("el perfil agente no ve las herramientas del coordinador, ni siquiera llamándolas por nombre")
    func agenteNoVe() async throws {
        let f = try await fix()
        let h = tools(f, agente: "marce", perfil: "agente")
        #expect(nombres(h) == ["colegas", "consultar"])
        for n in Coordinador.nombresMCP { #expect(await h.llamar(n, argumentos: [:]) == nil) }
        let c = tools(f, agente: "coordi", perfil: "coordinador")
        #expect(nombres(c) == ["colegas", "consultar", "estado_oficina", "entregas", "corridas", "bloqueos", "encargar"])
        #expect(Coordinador.herramientas(f.b.servicios, token: "t", identidad: IdentidadMCP(oficina: f.carpeta, agente: "marce", sid: U.a)) == nil)
    }

    // MARK: lecturas

    @Test("estado_oficina, entregas, corridas y bloqueos devuelven JSON y respetan los filtros")
    func lecturas() async throws {
        let f = try await fix()
        let s = f.b.store, c = f.carpeta
        for i in 1...35 { _ = await s.entregaCrear(oficina: c, agente: i % 2 == 0 ? "nico" : "marce", origen: "tarea", ref: "t", titulo: "Entrega \(i)", texto: "x") }
        await s.entregaMarcar(oficina: c, id: 1, estado: "revisada")
        _ = await s.corridaCrear(oficina: c, flujo: "f", nombre: "Clase 1", contexto: "ctx", definicion: "{\"nombre\":\"F\",\"pasos\":[]}", estado: "trabada")
        _ = await s.corridaCrear(oficina: c, flujo: "f", nombre: "Clase 0", contexto: "", definicion: "{\"nombre\":\"F\",\"pasos\":[]}", estado: "terminada")
        let h = tools(f, agente: "coordi", perfil: "coordinador")

        let est = objeto(await h.llamar("estado_oficina", argumentos: [:]))
        #expect(est["desde"] != nil && est["bloqueos"] is [Any] && est["flujos"] is [Any] && est["paso"] is [String: Any])
        #expect(lista(est["flujos"]).count == 1)

        var e = objeto(await h.llamar("entregas", argumentos: [:]))
        #expect(lista(e["entregas"]).count == 10)
        e = objeto(await h.llamar("entregas", argumentos: ["limite": 500]))
        #expect(lista(e["entregas"]).count == 30)
        e = objeto(await h.llamar("entregas", argumentos: ["estado": "revisada"]))
        #expect(lista(e["entregas"]).count == 1)
        e = objeto(await h.llamar("entregas", argumentos: ["agente": "nico", "limite": 30]))
        #expect(lista(e["entregas"]).allSatisfy { str($0["agente"]) == "nico" } && lista(e["entregas"]).count == 17)
        #expect(await h.llamar("entregas", argumentos: ["estado": "rara"])?.esError == true)

        var cs = objeto(await h.llamar("corridas", argumentos: [:]))
        #expect(lista(cs["corridas"]).count == 2 && lista(cs["corridas"]).allSatisfy { $0["definicion"] == nil })
        cs = objeto(await h.llamar("corridas", argumentos: ["estado": "abiertas"]))
        #expect(lista(cs["corridas"]).map { str($0["nombre"]) } == ["Clase 1"])
        cs = objeto(await h.llamar("corridas", argumentos: ["estado": "terminada"]))
        #expect(lista(cs["corridas"]).map { str($0["nombre"]) } == ["Clase 0"])
        #expect(await h.llamar("corridas", argumentos: ["estado": "rara"])?.esError == true)

        #expect(objeto(await h.llamar("bloqueos", argumentos: [:]))["bloqueos"] is [Any])
    }

    @Test("las respuestas no pasan de 12000 caracteres y siguen siendo JSON")
    func tope() async throws {
        let f = try await fix()
        let largo = String(repeating: "palabra ", count: 100)
        for i in 1...30 { _ = await f.b.store.entregaCrear(oficina: f.carpeta, agente: "marce", origen: "tarea", ref: "t", titulo: "T\(i)", texto: largo) }
        let h = tools(f, agente: "coordi", perfil: "coordinador")
        let r = try #require(await h.llamar("entregas", argumentos: ["limite": 30]))
        #expect(!r.esError && r.texto.count <= Coordinador.maxRespuesta)
        let o = objeto(r)
        #expect(!lista(o["entregas"]).isEmpty && lista(o["entregas"]).count < 30 && o["recortado"] as? Bool == true)
        #expect(HerramientasCoordinador.respuesta(["x": [1, 2]]).texto == "{\"x\":[1,2]}")
    }

    // MARK: encargar

    @Test("encargar crea una corrida coord:<8 hex> del agente pedido, con la consigna saneada y de quién viene; máximo 3 por token")
    func encargar() async throws {
        let f = try await fix()
        let h = tools(f, agente: "coordi", perfil: "coordinador")
        var ids: [String] = []
        for i in 1...3 {
            let r = try #require(await h.llamar("encargar", argumentos: ["agente": "nico", "consigna": "Preparame el anuncio \(i)\u{202E}\u{0007}", "nombre": "Anuncio \(i)"]))
            #expect(!r.esError, "\(r.texto)")
            let j = objeto(r)
            let tarea = str(j["tarea"])
            #expect(tarea.hasPrefix("coord:") && tarea.dropFirst(6).count == 8 && tarea.dropFirst(6).allSatisfy { $0.isHexDigit })
            #expect(str(j["agente"]) == "nico")
            ids.append(tarea)
        }
        #expect(Set(ids).count == 3)
        // cuarto: sin cupo
        let cuarto = try #require(await h.llamar("encargar", argumentos: ["agente": "nico", "consigna": "Uno más"]))
        #expect(cuarto.esError && cuarto.texto.contains("3 encargos"))
        #expect(await esperarAsync { await f.b.store.entregas(oficina: f.carpeta, origen: "encargo").count == 3 })
        let es = await f.b.store.entregas(oficina: f.carpeta, origen: "encargo")
        #expect(Set(es.map(\.ref)) == Set(ids) && es.allSatisfy { $0.agente == "nico" })
        #expect(f.sb.llamadas.count == 3)
        let l = try #require(f.sb.llamadas(conPrompt: "Preparame el anuncio 1").first)
        let p = try #require(l.last)
        #expect(p.contains("Coordi") && p.contains("no es un pedido directo del usuario") && !p.contains("\u{202E}") && !p.contains("\u{0007}"))
        // el agente del encargo no es coordinador: no lleva las herramientas del coordinador
        #expect(Sandbox.valor(l, "--tools")?.contains("encargar") == false)
        // el cupo es por token: otro token tiene el suyo
        let h2 = tools(f, agente: "coordi", perfil: "coordinador")
        #expect(await h2.llamar("encargar", argumentos: ["agente": "marce", "consigna": "Hola"])?.esError == false)
    }

    @Test("encargar: a sí mismo, agente inexistente y datos faltantes dan isError, sin lanzar claude ni gastar cupo")
    func encargarErrores() async throws {
        let f = try await fix()
        let h = tools(f, agente: "coordi", perfil: "coordinador")
        let yo = try #require(await h.llamar("encargar", argumentos: ["agente": "coordi", "consigna": "Hacelo vos"]))
        #expect(yo.esError && yo.texto.contains("vos mismo"))
        let nombreMio = try #require(await h.llamar("encargar", argumentos: ["agente": "Coordi", "consigna": "Hacelo vos"]))
        #expect(nombreMio.esError)
        let nadie = try #require(await h.llamar("encargar", argumentos: ["agente": "fantasma", "consigna": "Hola"]))
        #expect(nadie.esError && nadie.texto.contains("fantasma"))
        #expect(await h.llamar("encargar", argumentos: ["agente": "nico"])?.esError == true)
        #expect(await h.llamar("encargar", argumentos: ["consigna": "x"])?.esError == true)
        #expect(f.sb.llamadas.isEmpty)
        // el cupo sigue intacto: se pueden hacer los 3 (por nombre también se resuelve)
        for q in ["nico", "Nico", "marce"] { #expect(await h.llamar("encargar", argumentos: ["agente": q, "consigna": "Va"])?.esError == false) }
        #expect(await h.llamar("encargar", argumentos: ["agente": "nico", "consigna": "Va"])?.esError == true)
    }

    @Test("con la oficina cerrada o cambiada las herramientas dan isError")
    func sinOficina() async throws {
        let f = try await fix()
        let t = f.b.mcp.tokens.emitir(oficina: "/otra/oficina", agente: "coordi", sid: U.a, perfil: "coordinador")
        let h = f.b.mcp.consultas.herramientas(token: t, identidad: IdentidadMCP(oficina: "/otra/oficina", agente: "coordi", sid: U.a, perfil: "coordinador"))
        let r = try #require(await h.llamar("encargar", argumentos: ["agente": "nico", "consigna": "Hola"]))
        #expect(r.esError && r.texto.contains("oficina"))
        #expect(await h.llamar("estado_oficina", argumentos: [:])?.esError == true)
        #expect(f.sb.llamadas.isEmpty)
    }

    // MARK: chat y permisos

    @Test("el chat del coordinador lleva las herramientas del coordinador en --tools y --allowedTools; el de un agente común, no")
    func chatDelCoordinador() async throws {
        let f = try await fix()
        let r = await chat(f.b, agent: "coordi", message: "hola", session: U.a)
        #expect(r.status == 200)
        let l = try #require(f.sb.llamadas.last)
        let tools = try #require(Sandbox.valor(l, "--tools"))
        for n in Coordinador.nombresMCP { #expect(tools.contains("mcp__hq__" + n)); #expect(Sandbox.reglas(l).contains("mcp__hq__" + n)) }
        #expect(Sandbox.reglas(l).contains("mcp__hq__encargar"))
        #expect(tools.hasSuffix("mcp__hq__consultar,mcp__hq__colegas,mcp__hq__estado_oficina,mcp__hq__entregas,mcp__hq__corridas,mcp__hq__bloqueos,mcp__hq__encargar"))
        #expect(f.b.mcp.tokens.activos == 0)

        _ = await chat(f.b, agent: "marce", message: "hola", session: U.b)
        let m = try #require(f.sb.llamadas.last)
        #expect(Sandbox.valor(m, "--tools")?.contains("encargar") == false && !Sandbox.reglas(m).contains("mcp__hq__encargar"))
    }

    @Test("el contexto del coordinador emite el token con perfil coordinador; el del agente, con perfil agente")
    func perfilDelContexto() async throws {
        let f = try await fix()
        let act = try #require(await f.b.oficinas.activa())
        #expect(Permisos.contexto(act, agente: try #require(act.oficina.agente("coordi")), dirsExtra: []).perfilMCP == "coordinador")
        #expect(Permisos.contexto(act, agente: try #require(act.oficina.agente("marce")), dirsExtra: []).perfilMCP == "agente")
    }

    @Test("PATCH /api/agentes/:id acepta permisos, limites y conectores, y los valida")
    func patchAgente() async throws {
        let f = try await fix()
        let r = await f.patch("/api/agentes/marce", ["permisos": ["coordinador"], "limites": ["solo": ["Diseñar fichas"], "proponer": ["Cambiar el plan"]],
                                                      "conectores": [["servidor": "Google Calendar", "leer": ["mcp__claude_ai_Google_Calendar__list_events"], "actuar": [String]()]]])
        #expect(r.status == 200, "\(r.obj)")
        let ag = lista(f.oficinaJSON()["agentes"]).first { str($0["id"]) == "marce" }
        #expect((ag?["permisos"] as? [String]) == ["coordinador"])
        #expect((dict(ag?["limites"])["solo"] as? [String]) == ["Diseñar fichas"])
        #expect(lista(ag?["conectores"]).first.map { str($0["servidor"]) } == "Google Calendar")
        let act = try #require(await f.b.oficinas.activa())
        #expect(act.oficina.agente("marce")?.esCoordinador == true)
        // inválidos
        #expect((await f.patch("/api/agentes/marce", ["permisos": ["jefe"]])).status == 400)
        #expect((await f.patch("/api/agentes/marce", ["conectores": [["servidor": "X", "leer": ["mcp__hq__encargar"], "actuar": [String]()]]])).status == 400)
        // quitarlo
        #expect((await f.patch("/api/agentes/marce", ["permisos": [String]()])).status == 200)
        #expect(try #require(await f.b.oficinas.activa()).oficina.agente("marce")?.esCoordinador == false)
    }
}
