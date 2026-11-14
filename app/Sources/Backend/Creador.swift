import Foundation

// El Creador de oficinas (docs/plan-creador-flujos.md §6 y §11).
// Un agente especial de la recepción que arma y cambia la oficina charlando: propone tarjetas (departamento, agente, flujo,
// regla, conector, tarea) por el servidor MCP propio y la persona las aprueba con un botón (`Creador.aplicar`).
// Nunca crea nada solo: las herramientas `proponer_*` solo escriben tarjetas en SQLite.

/// Una o más tarjetas en `borrador` impiden aplicar (409). Lleva las tarjetas para que el router devuelva sus faltantes.
struct AplicarBloqueado: Error { var tarjetas: [Tarjeta] }

enum Creador {
    static let idAgente = "creador"
    static let prefijoMCP = "mcp__hq__"
    /// Nombres cortos, en el orden de la tabla de §6.
    static let nombresCortos: [String] = ["ver_oficina", "listar_conectores"] + Tarjeta.tipos.map { "proponer_" + $0 }
        + ["marcar_faltante", "descartar_tarjeta"]
    static let nombresMCP: [String] = nombresCortos.map { prefijoMCP + $0 }
    /// Escrituras (proponer, marcar, descartar) por mensaje de la persona.
    static let maxEscrituras = 80
    static let claveCupo = "creador"
    static let maxOrigen = 600
    static let maxDatos = 200_000
    /// Orden en que se aplican los tipos: lo que otro necesita va antes.
    static let ordenTipos = ["departamento", "agente", "regla", "conector", "flujo", "tarea"]
    static let acciones = ["crear", "modificar", "quitar"]

    static func herramientas(_ s: ServiciosHQ, token: String, identidad: IdentidadMCP) -> MCPHerramientas? {
        HerramientasCreador(s: s, token: token, identidad: identidad)
    }

    // MARK: utilidades

    static func sanear(_ v: Any) -> Any {
        switch v {
        case let s as String: return ConsultasMCP.sanear(s)
        case let a as [Any]: return a.map { sanear($0) }
        case let d as [String: Any]: return d.mapValues { sanear($0) }
        default: return v
        }
    }

    /// Sin los `NSNull` (un null es «sin valor»).
    static func sinNulos(_ v: Any) -> Any {
        switch v {
        case let a as [Any]: return a.filter { !($0 is NSNull) }.map { sinNulos($0) }
        case let d as [String: Any]: return d.filter { !($0.value is NSNull) }.mapValues { sinNulos($0) }
        default: return v
        }
    }

    static func texto(_ v: Any?) -> String? {
        guard let s = v as? String else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    static func json(_ o: Any, ordenado: Bool = true) -> String {
        var op: JSONSerialization.WritingOptions = [.withoutEscapingSlashes]
        if ordenado { op.insert(.sortedKeys) }
        let d = (try? JSONSerialization.data(withJSONObject: o, options: op)) ?? Data("{}".utf8)
        return String(decoding: d, as: UTF8.self)
    }

    static func objeto(_ s: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
    }

    static func lista(_ s: String) -> [[String: Any]] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [[String: Any]] ?? []
    }

    /// Minúsculas, sin acentos y con los blancos colapsados, para comparar citas.
    static func compactar(_ s: String) -> String {
        ConsultasMCP.normalizar(s).split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// Anti-invento: la cita (sin comillas alrededor) tiene que estar en algún mensaje `u` de la sesión.
    static func citaValida(_ origen: String, mensajes: [Mensaje]) -> Bool {
        let comillas = CharacterSet(charactersIn: "«»\"'“”‘’").union(.whitespacesAndNewlines)
        let o = compactar(origen.trimmingCharacters(in: comillas))
        guard !o.isEmpty else { return false }
        return mensajes.contains { $0.r == "u" && compactar($0.t).contains(o) }
    }

    static func faltante(_ campo: String, _ pregunta: String) -> [String: Any] { ["campo": campo, "pregunta": pregunta] }

    static func clave(_ s: String) -> String { ConsultasMCP.normalizar(s).replacingOccurrences(of: "_", with: " ") }

    /// Busca el servidor del catálogo que corresponde al nombre pedido.
    static func servidor(_ nombre: String, _ catalogo: [ServidorConector]?) -> ServidorConector? {
        let n = clave(nombre)
        guard !n.isEmpty else { return nil }
        for s in catalogo ?? [] {
            let a = clave(s.nombre), p = clave(s.prefijo)
            if a == n || p == n || (!a.isEmpty && (a.contains(n) || n.contains(a))) { return s }
        }
        return nil
    }

    /// «Conectá X en claude.ai» si el conector no está disponible.
    static func faltanteConector(_ nombre: String, _ catalogo: [ServidorConector]?, campo: String) -> [String: Any]? {
        if let s = servidor(nombre, catalogo) {
            if s.disponible { return nil }
            return faltante(campo, "Conectá \(nombre) en claude.ai: está en tu cuenta pero necesita que lo autorices.")
        }
        if catalogo == nil {
            return faltante(campo, "Conectá \(nombre) en claude.ai y actualizá los conectores: todavía no pude comprobar si está disponible.")
        }
        return faltante(campo, "Conectá \(nombre) en claude.ai: no está entre los conectores de tu cuenta.")
    }

    // MARK: evaluación de una tarjeta

    /// Qué pasa con una tarjeta: sus datos limpios y lo que le falta. Lanza `ErrorAPI` si hay un error de formato.
    /// `tarjetas`: las demás tarjetas no descartadas (para resolver `tarjeta:<id>`).
    static func evaluar(tipo: String, accion: String, datos crudos: [String: Any], oficina o: Oficina, tarjetas: [Tarjeta],
                        catalogo: [ServidorConector]?) throws -> (datos: [String: Any], faltantes: [[String: Any]]) {
        guard var d = sinNulos(sanear(crudos)) as? [String: Any] else { return ([:], []) }
        if accion == "quitar" {
            var q: [String: Any] = [:]
            for k in ["moverA", "servidor"] { if let v = texto(d[k]) { q[k] = v } }
            return (q, [])
        }
        let crear = accion == "crear"
        if !crear { d["id"] = nil }
        var f: [[String: Any]] = []

        func falta(_ campo: String, _ pregunta: String) { f.append(faltante(campo, pregunta)) }
        func vacio(_ k: String) -> Bool { texto(d[k]) == nil }
        func refOk(_ v: Any?, tipo t: String, existentes: Set<String>, persona: Bool = false) throws -> (String, Bool)? {
            guard let v else { return nil }
            guard let s = v as? String else { throw ErrorAPI(400, "Una referencia a \(t) tiene que ser texto (un id o «tarjeta:<id>»).") }
            let r = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if persona, r == "persona" { return (r, true) }
            if existentes.contains(r) { return (r, true) }
            if r.hasPrefix("tarjeta:") {
                let id = String(r.dropFirst("tarjeta:".count))
                return (r, tarjetas.contains { $0.id == id && $0.tipo == t && $0.estado != "descartada" })
            }
            return (r, false)
        }
        let agentesIds = Set(o.agentes.map(\.id))

        switch tipo {
        case "departamento":
            if crear, vacio("nombre") { falta("nombre", "¿Cómo se llama el departamento?") }
            let usados = crear ? Set(o.departamentos.map(\.id)) : []
            _ = try Oficinas.armarDepartamento(
                Oficinas.DepartamentoNuevo(id: texto(d["id"]), nombre: texto(d["nombre"]) ?? "x", color: texto(d["color"]),
                                           mision: d["mision"] as? String),
                indice: 0, usados: usados)

        case "agente":
            if crear {
                if vacio("nombre") { falta("nombre", "¿Cómo se llama?") }
                if vacio("rol") { falta("rol", "¿Cuál es su rol?") }
                if vacio("prompt") { falta("prompt", "¿Qué hace y cómo trabaja? Falta lo que dice el texto para armarle las instrucciones.") }
                if vacio("departamento") { falta("departamento", "¿En qué departamento va?") }
            }
            var v = d
            if crear { for k in ["nombre", "rol", "prompt", "departamento"] where vacio(k) { v[k] = "x" } }
            if crear {
                _ = try NuevoAgente.desde(v)
                if let id = texto(d["id"]) {
                    if Validar.reservados.contains(id) { throw ErrorAPI(400, "Ese id está reservado: elegí otro para el agente.") }
                    if agentesIds.contains(id) { throw ErrorAPI(409, "Ya hay un agente con el id «\(id)»: usá accion «modificar» con objetivo.") }
                }
            } else {
                _ = try Oficinas.CambiosAgente.desde(v)
            }
            if let (r, ok) = try refOk(d["departamento"], tipo: "departamento", existentes: Set(o.departamentos.map(\.id))), !ok {
                falta("departamento", "«\(r)» no es un departamento de la oficina ni hay una tarjeta para crearlo: ¿en cuál va?")
            }
            for c in try NuevoAgente.conectoresValidos(d["conectores"]) ?? [] {
                if let x = faltanteConector(c.servidor, catalogo, campo: "conectores") { f.append(x) }
            }

        case "flujo":
            var v = d
            if let crudos = d["pasos"] {
                guard let pasos = crudos as? [Any] else { throw ErrorAPI(400, "«pasos» tiene que ser una lista de pasos.") }
                var nuevos: [[String: Any]] = []
                for (i, x) in pasos.enumerated() {
                    guard var p = x as? [String: Any] else { throw ErrorAPI(400, "Cada paso del flujo tiene que ser un objeto.") }
                    let nombre = texto(p["nombre"]) ?? "el paso \(i + 1)"
                    if texto(p["nombre"]) == nil { falta("pasos[\(i)].nombre", "¿Cómo se llama el paso \(i + 1)?"); p["nombre"] = "x" }
                    let tieneQuien = texto(p["quien"]) != nil
                    if !tieneQuien { falta("pasos[\(i)].quien", "¿Quién hace «\(nombre)»: un agente o vos?"); p["quien"] = "persona" }
                    if texto(p["entrega"]) == nil { falta("pasos[\(i)].entrega", "¿Qué entrega «\(nombre)»?"); p["entrega"] = "x" }
                    if p["aprobacion"] == nil {
                        falta("pasos[\(i)].aprobacion", "¿«\(nombre)» necesita tu aprobación antes de que siga el flujo?")
                    } else if !(p["aprobacion"] is Bool) {
                        throw ErrorAPI(400, "«aprobacion» del paso «\(nombre)» tiene que ser verdadero o falso.")
                    }
                    if tieneQuien, let (r, ok) = try refOk(p["quien"], tipo: "agente", existentes: agentesIds, persona: true), !ok {
                        falta("pasos[\(i)].quien", "«\(r)» no es un agente de la oficina ni hay una tarjeta para crearlo: ¿quién hace «\(nombre)»?")
                    }
                    if let q = p["quien"] as? String, q.hasPrefix("tarjeta:") { p["quien"] = "tarjeta-" + q.dropFirst("tarjeta:".count) }
                    nuevos.append(p)
                }
                v["pasos"] = nuevos
                if crear, nuevos.isEmpty { falta("pasos", "¿Cuáles son los pasos del flujo?") }
            } else if crear {
                falta("pasos", "¿Cuáles son los pasos del flujo?")
            }
            if crear, vacio("nombre") { falta("nombre", "¿Cómo se llama el flujo?") }
            if texto(v["nombre"]) == nil { v["nombre"] = "x" }
            if (v["pasos"] as? [Any])?.isEmpty ?? true { v["pasos"] = [["nombre": "x", "quien": "persona", "entrega": "x"]] }
            let usados = Set((o.flujos ?? []).map(\.id))
            _ = try FlujoDef.desde(v, idsUsados: crear ? usados : [])

        case "regla":
            if crear, vacio("texto") { falta("texto", "¿Qué dice la regla?") }
            var v = d
            if texto(v["texto"]) == nil { v["texto"] = "x" }
            _ = try Regla.desde(v, idsUsados: crear ? Set((o.reglas ?? []).map(\.id)) : [])

        case "conector":
            if crear {
                if vacio("agente") { falta("agente", "¿A qué agente le damos el conector?") }
                if vacio("servidor") { falta("servidor", "¿Qué conector es?") }
            }
            let leer = try LecturaAPI.lista(d["leer"], "leer"), actuar = try LecturaAPI.lista(d["actuar"], "actuar")
            let nombre = texto(d["servidor"])
            if let nombre, nombre.count > ValidarAgenteExtra.maxLargoServidor {
                throw ErrorAPI(400, "El nombre del conector es demasiado largo (máximo \(ValidarAgenteExtra.maxLargoServidor) caracteres).")
            }
            try ValidarAgenteExtra.conectores([ConectorAsignado(servidor: nombre ?? "x", leer: leer ?? [], actuar: actuar ?? [])])
            if let (r, ok) = try refOk(d["agente"], tipo: "agente", existentes: agentesIds), !ok {
                falta("agente", "«\(r)» no es un agente de la oficina ni hay una tarjeta para crearlo: ¿a quién se lo damos?")
            }
            if let nombre, let x = faltanteConector(nombre, catalogo, campo: "servidor") { f.append(x) }
            if crear, (leer ?? []).isEmpty, (actuar ?? []).isEmpty, nombre != nil {
                falta("leer", "¿Qué tiene que poder hacer con \(nombre!): solo leer o también actuar? Elegí las herramientas.")
            }

        case "tarea":
            if crear {
                if vacio("agente") { falta("agente", "¿Qué agente hace la tarea?") }
                if vacio("nombre") { falta("nombre", "¿Cómo se llama la tarea?") }
                if vacio("consigna") { falta("consigna", "¿Qué tiene que hacer cada vez?") }
                if vacio("hora") { falta("hora", "¿A qué hora (HH:MM)?") }
                if d["dias"] == nil, vacio("fecha") { falta("dias", "¿Qué días de la semana se repite?") }
            }
            if let p = texto(d["periodicidad"]) {
                let ok: Set<String> = ["semanal", "semanales", "cada semana", "diaria", "diario", "todos los dias", "unica", "una vez", "unico"]
                if !ok.contains(ConsultasMCP.normalizar(p)) {
                    falta("periodicidad", "Por ahora las tareas se repiten por días de la semana, no \(p): ¿la hacemos cada semana o la dejás como recordatorio tuyo?")
                }
            }
            if let n = texto(d["nombre"]), n.count > ValidarTareas.maxNombre {
                throw ErrorAPI(400, "El nombre de la tarea es demasiado largo (máximo \(ValidarTareas.maxNombre) caracteres).")
            }
            if let c = texto(d["consigna"]), c.count > ValidarTareas.maxConsigna {
                throw ErrorAPI(400, "La consigna de la tarea es demasiado larga (máximo \(ValidarTareas.maxConsigna) caracteres).")
            }
            if let h = texto(d["hora"]), ValidarTareas.hora(h) == nil { throw ErrorAPI(400, "La hora tiene que ser HH:MM (por ejemplo 08:00).") }
            if let z = texto(d["zona"]), !ValidarTareas.zonaValida(z) {
                throw ErrorAPI(400, "No conozco esa zona horaria (usá, por ejemplo, America/Argentina/Buenos_Aires).")
            }
            if let fe = texto(d["fecha"]), Programacion.diaCalendario(fe) == nil {
                throw ErrorAPI(400, "La fecha tiene que ser AAAA-MM-DD (por ejemplo 2026-11-20).")
            }
            if d["dias"] != nil {
                if d["fecha"] != nil { throw ErrorAPI(400, "Elegí días (si se repite) o una fecha (si es una sola vez), no las dos cosas.") }
                _ = try diasValidos(d["dias"])
            }
            if let id = texto(d["id"]), !Slug.valido(id) { throw ErrorAPI(400, "Id de tarea inválido (usá minúsculas, números y guiones).") }
            if let (r, ok) = try refOk(d["agente"], tipo: "agente", existentes: agentesIds), !ok {
                falta("agente", "«\(r)» no es un agente de la oficina ni hay una tarjeta para crearlo: ¿quién hace la tarea?")
            }

        default:
            throw ErrorAPI(400, "Tipo de tarjeta desconocido: \(tipo).")
        }
        return (d, f)
    }

    /// `[1...7]` sin repetir y no vacío.
    static func diasValidos(_ v: Any?) throws -> [Int] {
        guard let a = v as? [Any], !a.isEmpty else { throw ErrorAPI(400, "Elegí al menos un día (números del 1, lunes, al 7, domingo).") }
        var out: [Int] = []
        for x in a {
            guard let n = x as? Int, CFGetTypeID(x as CFTypeRef) != CFBooleanGetTypeID(), (1...7).contains(n), !out.contains(n) else {
                throw ErrorAPI(400, "Los días tienen que ser números del 1 (lunes) al 7 (domingo), sin repetir.")
            }
            out.append(n)
        }
        return out.sorted()
    }

    /// Que el objetivo de un `modificar` o `quitar` exista en la oficina.
    static func existeObjetivo(_ tipo: String, _ id: String, _ o: Oficina) -> Bool {
        switch tipo {
        case "departamento": return o.departamento(id) != nil
        case "agente", "conector": return o.agente(id) != nil
        case "flujo": return (o.flujos ?? []).contains { $0.id == id }
        case "regla": return (o.reglas ?? []).contains { $0.id == id }
        case "tarea": return (o.tareas ?? []).contains { $0.id == id }
        default: return false
        }
    }

    /// Los faltantes puestos a mano (`marcar_faltante`) siguen mientras el campo no se complete.
    static func manualesVigentes(_ viejos: [[String: Any]], datos: [String: Any]) -> [[String: Any]] {
        viejos.filter { ($0["manual"] as? Bool) == true && texto(datos[$0["campo"] as? String ?? ""]) == nil
            && !((datos[$0["campo"] as? String ?? ""] as? [Any])?.isEmpty == false) }
    }

    // MARK: guardar una tarjeta (proponer y PATCH)

    /// Arma, valida y guarda una tarjeta. Con `ref` (o una tarjeta existente) actualiza: los `datos` nuevos se suman a los viejos
    /// (un `null` borra un campo). Lanza `ErrorAPI` con un mensaje para el modelo o para la persona.
    static func armar(_ s: ServiciosHQ, carpeta: String, sid: String, tipo: String, accion: String?, objetivo: String?, ref: String?,
                      origen: String?, datos: [String: Any]) async throws -> Tarjeta {
        var existente: Tarjeta?
        if let ref {
            guard let t = await s.store.tarjeta(oficina: carpeta, id: ref) else { throw ErrorAPI(404, "No existe la tarjeta «\(ref)».") }
            guard t.tipo == tipo else { throw ErrorAPI(400, "La tarjeta «\(ref)» es de tipo \(t.tipo), no \(tipo).") }
            guard ["borrador", "lista", "error"].contains(t.estado) else {
                throw ErrorAPI(409, "La tarjeta «\(ref)» ya está \(t.estado == "creada" ? "creada" : "descartada") y no se puede cambiar.")
            }
            existente = t
        }
        let accionF = accion ?? existente?.accion ?? "crear"
        guard acciones.contains(accionF) else { throw ErrorAPI(400, "«accion» tiene que ser crear, modificar o quitar.") }
        let o = try OficinaStore.leer(carpeta: carpeta)
        var objetivoF: String? = accionF == "crear" ? nil : (texto(objetivo) ?? existente?.objetivo)
        if accionF != "crear" {
            guard let ob = objetivoF else { throw ErrorAPI(400, "Para \(accionF) hace falta «objetivo»: el id de lo que ya existe (miralo con ver_oficina).") }
            guard existeObjetivo(tipo, ob, o) else {
                throw ErrorAPI(400, "No hay \(tipo == "conector" ? "un agente" : "un \(tipo)") con el id «\(ob)» en la oficina: miralo con ver_oficina.")
            }
        } else { objetivoF = nil }

        var base: [String: Any] = [:]
        if let e = existente { base = objeto(e.datos) }
        for (k, v) in datos { base[k] = v }
        let otras = await s.store.tarjetas(oficina: carpeta, estados: ["borrador", "lista", "creada", "error"]).filter { $0.id != existente?.id }
        let (limpios, calculados) = try evaluar(tipo: tipo, accion: accionF, datos: base, oficina: o, tarjetas: otras,
                                                catalogo: CatalogoConectores.compartido.servidores())
        var faltantes = calculados
        if let e = existente {
            for m in manualesVigentes(lista(e.faltantes), datos: limpios) where !faltantes.contains(where: { ($0["campo"] as? String) == (m["campo"] as? String) }) {
                faltantes.append(m)
            }
        }
        let datosTexto = json(limpios)
        guard datosTexto.utf8.count <= maxDatos else { throw ErrorAPI(413, "La tarjeta es demasiado grande.") }
        var t = existente ?? Tarjeta(id: "", oficina: carpeta, sid: sid, tipo: tipo, accion: accionF)
        t.accion = accionF; t.objetivo = objetivoF; t.datos = datosTexto; t.faltantes = json(faltantes, ordenado: false)
        if let origen { t.origen = String(origen.prefix(maxOrigen)) }
        t.estado = faltantes.isEmpty ? "lista" : "borrador"
        t.error = nil
        if t.sid.isEmpty { t.sid = sid }
        let guardada: Tarjeta?
        if existente != nil {
            await s.store.tarjetaGuardar(t)
            guardada = await s.store.tarjeta(oficina: carpeta, id: t.id)
        } else {
            guardada = await s.store.tarjetaGuardarNueva(t)
        }
        guard let g = guardada else { throw ErrorAPI(500, "No pude guardar la tarjeta.") }
        VersionCreador.compartida.subir(carpeta)
        return g
    }

    // MARK: aplicar (§11)

    /// Pide confirmación: una tarjeta `quitar` sin `confirmarQuitar`.
    private struct SinConfirmar: Error {}

    static func aplicar(_ s: ServiciosHQ, act: OficinaActiva, ids: [String]?, confirmarQuitar: Bool) async throws -> [[String: Any]] {
        let carpeta = act.carpeta
        let todas = await s.store.tarjetas(oficina: carpeta)
        var elegidas: [Tarjeta] = []
        if let ids, !ids.isEmpty {
            for id in ids {
                guard let t = todas.first(where: { $0.id == id }) else { throw ErrorAPI(404, "No existe la tarjeta «\(id)».") }
                if !elegidas.contains(where: { $0.id == id }) { elegidas.append(t) }
            }
        } else {
            elegidas = todas.filter { $0.estado == "lista" }
        }
        let borradores = elegidas.filter { $0.estado == "borrador" }
        if !borradores.isEmpty { throw AplicarBloqueado(tarjetas: borradores) }

        var mapa: [String: String] = [:]
        for t in todas where t.estado == "creada" { if let c = t.creadaId { mapa[t.id] = c } }

        var resultados: [String: [String: Any]] = [:]
        var pendientes: [Tarjeta] = []
        for t in elegidas {
            switch t.estado {
            case "creada": resultados[t.id] = ["id": t.id, "ok": true, "creadaId": t.creadaId ?? NSNull()]
            case "descartada": resultados[t.id] = ["id": t.id, "ok": false, "error": "Esta tarjeta está descartada."]
            default: pendientes.append(t)
            }
        }
        // primero lo que se crea o cambia (departamento -> agente -> regla -> conector -> flujo -> tarea), al final lo que se quita
        let posicion = Dictionary(uniqueKeysWithValues: todas.enumerated().map { ($1.id, $0) })
        func rango(_ t: Tarjeta) -> Int {
            let i = ordenTipos.firstIndex(of: t.tipo) ?? ordenTipos.count
            return t.accion == "quitar" ? 100 + (ordenTipos.count - i) : i
        }
        pendientes.sort { (rango($0), posicion[$0.id] ?? 0) < (rango($1), posicion[$1.id] ?? 0) }

        for t in pendientes {
            do {
                if t.accion == "quitar", !confirmarQuitar { throw SinConfirmar() }
                let id = try await aplicarUna(s, carpeta: carpeta, t, mapa: mapa)
                await s.store.tarjetaEstado(oficina: carpeta, id: t.id, estado: "creada", creadaId: id)
                mapa[t.id] = id
                resultados[t.id] = ["id": t.id, "ok": true, "creadaId": id]
            } catch is SinConfirmar {
                // sigue lista: hace falta que la persona confirme que quiere quitar
                resultados[t.id] = ["id": t.id, "ok": false,
                                    "error": "Quitar necesita tu confirmación: confirmá que querés quitar «\(t.objetivo ?? t.tipo)»."]
            } catch let e as ErrorAPI {
                await s.store.tarjetaEstado(oficina: carpeta, id: t.id, estado: "error", error: e.mensaje)
                resultados[t.id] = ["id": t.id, "ok": false, "error": e.mensaje]
            } catch {
                let m = "No pude aplicar esta tarjeta."
                await s.store.tarjetaEstado(oficina: carpeta, id: t.id, estado: "error", error: m)
                resultados[t.id] = ["id": t.id, "ok": false, "error": m]
            }
        }
        VersionCreador.compartida.subir(carpeta)
        return elegidas.compactMap { resultados[$0.id] }
    }

    private static func resolver(_ v: Any?, _ mapa: [String: String]) throws -> Any? {
        guard let s = v as? String, s.hasPrefix("tarjeta:") else { return v }
        let id = String(s.dropFirst("tarjeta:".count))
        guard let r = mapa[id] else { throw ErrorAPI(409, "Depende de la tarjeta «\(id)», que todavía no se creó.") }
        return r
    }

    /// Aplica una tarjeta con lo que ya existe en `Oficinas`. Devuelve el id de lo creado o cambiado.
    private static func aplicarUna(_ s: ServiciosHQ, carpeta: String, _ t: Tarjeta, mapa: [String: String]) async throws -> String {
        var d = objeto(t.datos)
        let of = s.oficinas
        let obj = t.objetivo ?? ""
        let faltaObj = ErrorAPI(400, "La tarjeta no dice sobre qué cambio (falta el objetivo).")
        switch (t.tipo, t.accion) {
        case ("departamento", "crear"):
            guard let nombre = texto(d["nombre"]) else { throw ErrorAPI(400, "Falta el nombre del departamento.") }
            let (dep, _) = try await of.crearDepartamento(Oficinas.DepartamentoNuevo(id: texto(d["id"]), nombre: nombre, color: texto(d["color"]),
                                                                                     mision: texto(d["mision"])))
            return dep.id
        case ("departamento", "modificar"):
            guard !obj.isEmpty else { throw faltaObj }
            _ = try await of.editarDepartamento(obj, nombre: texto(d["nombre"]), color: texto(d["color"]), mision: d["mision"] as? String)
            return obj
        case ("departamento", "quitar"):
            guard !obj.isEmpty else { throw faltaObj }
            _ = try await of.borrarDepartamento(obj, moverA: texto(d["moverA"]))
            return obj

        case ("agente", "crear"):
            d["departamento"] = try resolver(d["departamento"], mapa)
            let (a, _) = try await of.contratar(try NuevoAgente.desde(d))
            return a.id
        case ("agente", "modificar"):
            guard !obj.isEmpty else { throw faltaObj }
            if d["departamento"] != nil { d["departamento"] = try resolver(d["departamento"], mapa) }
            _ = try await of.editarAgente(obj, try Oficinas.CambiosAgente.desde(d))
            return obj
        case ("agente", "quitar"):
            guard !obj.isEmpty else { throw faltaObj }
            _ = try await of.despedir(obj)
            return obj

        case ("regla", "crear"):
            let origen = String(t.origen.prefix(ValidarReglas.maxTexto))
            let (r, _) = try await of.modificar { o -> Regla in
                var rs = o.reglas ?? []
                guard rs.count < ValidarReglas.maxReglas else { throw ErrorAPI(400, "Máximo \(ValidarReglas.maxReglas) reglas.") }
                var x = d; if !origen.isEmpty { x["origen"] = origen }
                let r = try Regla.desde(x, idsUsados: Set(rs.map(\.id)))
                rs.append(r); o.reglas = rs
                return r
            }
            return r.id
        case ("regla", "modificar"):
            guard !obj.isEmpty else { throw faltaObj }
            _ = try await of.modificar { o in
                guard let i = o.reglas?.firstIndex(where: { $0.id == obj }) else { throw ErrorAPI(404, "No existe esa regla.") }
                if let tx = texto(d["texto"]) { o.reglas![i].texto = tx }
            }
            return obj
        case ("regla", "quitar"):
            guard !obj.isEmpty else { throw faltaObj }
            _ = try await of.modificar { o in
                guard o.reglas?.contains(where: { $0.id == obj }) == true else { throw ErrorAPI(404, "No existe esa regla.") }
                o.reglas?.removeAll { $0.id == obj }
                if o.reglas?.isEmpty == true { o.reglas = nil }
            }
            return obj

        case ("conector", "crear"), ("conector", "modificar"):
            let agente = try resolver(d["agente"], mapa) as? String ?? obj
            guard !agente.isEmpty, let servidor = texto(d["servidor"]) else { throw ErrorAPI(400, "Faltan el agente o el conector.") }
            let leer = try LecturaAPI.lista(d["leer"], "leer"), actuar = try LecturaAPI.lista(d["actuar"], "actuar")
            _ = try await of.modificar { o in
                guard let i = o.agentes.firstIndex(where: { $0.id == agente }) else { throw ErrorAPI(404, "No existe el agente «\(agente)».") }
                var cs = o.agentes[i].conectores ?? []
                if let j = cs.firstIndex(where: { clave($0.servidor) == clave(servidor) }) {
                    if let leer { cs[j].leer = leer }
                    if let actuar { cs[j].actuar = actuar }
                } else {
                    cs.append(ConectorAsignado(servidor: servidor, leer: leer ?? [], actuar: actuar ?? []))
                }
                o.agentes[i].conectores = cs
            }
            return agente
        case ("conector", "quitar"):
            guard !obj.isEmpty, let servidor = texto(d["servidor"]) else { throw ErrorAPI(400, "Para quitar un conector hace falta el agente y el servidor.") }
            _ = try await of.modificar { o in
                guard let i = o.agentes.firstIndex(where: { $0.id == obj }) else { throw ErrorAPI(404, "No existe ese agente.") }
                var cs = o.agentes[i].conectores ?? []
                cs.removeAll { clave($0.servidor) == clave(servidor) }
                o.agentes[i].conectores = cs.isEmpty ? nil : cs
            }
            return obj

        case ("flujo", "crear"):
            d = try resolverPasos(d, mapa)
            d["origen"] = String(t.origen.prefix(ValidarReglas.maxTexto))
            d["creado"] = Oficinas.ahoraISO()
            let (f, _) = try await of.modificar { o -> FlujoDef in
                var fs = o.flujos ?? []
                guard fs.count < ValidarFlujos.maxFlujos else { throw ErrorAPI(400, "Máximo \(ValidarFlujos.maxFlujos) flujos.") }
                let f = try FlujoDef.desde(d, idsUsados: Set(fs.map(\.id)))
                fs.append(f); o.flujos = fs
                return f
            }
            return f.id
        case ("flujo", "modificar"):
            guard !obj.isEmpty else { throw faltaObj }
            d = try resolverPasos(d, mapa)
            _ = try await of.modificar { o in
                guard var fs = o.flujos, let i = fs.firstIndex(where: { $0.id == obj }) else { throw ErrorAPI(404, "No existe ese flujo.") }
                var base = fs[i].json
                for (k, v) in d { base[k] = v }
                base["id"] = obj
                fs[i] = try FlujoDef.desde(base, idsUsados: Set(fs.map(\.id)).subtracting([obj]))
                o.flujos = fs
            }
            return obj
        case ("flujo", "quitar"):
            guard !obj.isEmpty else { throw faltaObj }
            _ = try await of.modificar { o in
                guard o.flujos?.contains(where: { $0.id == obj }) == true else { throw ErrorAPI(404, "No existe ese flujo.") }
                o.flujos?.removeAll { $0.id == obj }
                if o.flujos?.isEmpty == true { o.flujos = nil }
            }
            return obj

        case ("tarea", "crear"):
            let agente = try resolver(d["agente"], mapa) as? String ?? ""
            guard !agente.isEmpty, let nombre = texto(d["nombre"]), let consigna = texto(d["consigna"]), let hora = texto(d["hora"]) else {
                throw ErrorAPI(400, "A la tarea le faltan datos.")
            }
            let unica = texto(d["fecha"]) != nil
            let dias = unica ? [] : try diasValidos(d["dias"])
            let zona = texto(d["zona"]) ?? TimeZone.current.identifier
            let ahora = Programacion.iso(Date())
            let (tarea, _) = try await of.modificar { o -> TareaProgramada in
                guard o.agente(agente) != nil else { throw ErrorAPI(404, "No existe el agente «\(agente)».") }
                var ts = o.tareas ?? []
                guard ts.count < ValidarTareas.maxTareas else { throw ErrorAPI(400, "Máximo \(ValidarTareas.maxTareas) tareas programadas.") }
                let usados = Set(ts.map(\.id))
                if let p = texto(d["id"]), usados.contains(p) { throw ErrorAPI(409, "Ya hay una tarea con ese id.") }
                let id = texto(d["id"]) ?? Slug.unico(nombre, usados: usados, respaldo: "tarea")
                let tarea = TareaProgramada(id: id, agente: agente, nombre: nombre, consigna: consigna, dias: dias, hora: hora, zona: zona,
                                            activa: true, creada: ahora, desde: ahora, origen: nil, fecha: texto(d["fecha"]))
                ts.append(tarea); o.tareas = ts
                return tarea
            }
            return tarea.id
        case ("tarea", "modificar"):
            guard !obj.isEmpty else { throw faltaObj }
            let agente = d["agente"] == nil ? nil : try resolver(d["agente"], mapa) as? String
            let ahora = Programacion.iso(Date())
            _ = try await of.modificar { o in
                guard let i = o.tareas?.firstIndex(where: { $0.id == obj }) else { throw ErrorAPI(404, "No existe esa tarea.") }
                var x = o.tareas![i]
                var cambioHorario = false
                if let a = agente { x.agente = a }
                if let n = texto(d["nombre"]) { x.nombre = n }
                if let c = texto(d["consigna"]) { x.consigna = c }
                if d["dias"] != nil { x.dias = try diasValidos(d["dias"]); x.fecha = nil; x.hecha = nil; cambioHorario = true }
                if let fe = texto(d["fecha"]) { x.fecha = fe; x.dias = []; x.hecha = nil; cambioHorario = true }
                if let h = texto(d["hora"]), h != x.hora { x.hora = h; cambioHorario = true }
                if let z = texto(d["zona"]), z != x.zona { x.zona = z; cambioHorario = true }
                if cambioHorario { x.desde = ahora }
                o.tareas![i] = x
            }
            return obj
        case ("tarea", "quitar"):
            guard !obj.isEmpty else { throw faltaObj }
            _ = try await of.modificar { o in
                guard o.tareas?.contains(where: { $0.id == obj }) == true else { throw ErrorAPI(404, "No existe esa tarea.") }
                o.tareas?.removeAll { $0.id == obj }
                if o.tareas?.isEmpty == true { o.tareas = nil }
            }
            return obj

        default:
            throw ErrorAPI(400, "No sé aplicar una tarjeta \(t.tipo) con la acción \(t.accion).")
        }
    }

    private static func resolverPasos(_ d: [String: Any], _ mapa: [String: String]) throws -> [String: Any] {
        guard let pasos = d["pasos"] as? [[String: Any]] else { return d }
        var out = d
        out["pasos"] = try pasos.map { p -> [String: Any] in
            var x = p
            if p["quien"] != nil { x["quien"] = try resolver(p["quien"], mapa) }
            return x
        }
        return out
    }

    // MARK: vistas

    /// Tarjetas visibles (sin las descartadas) y cuántas hay en cada estado.
    static func resumen(_ tarjetas: [Tarjeta]) -> [String: Int] {
        var r = ["borrador": 0, "lista": 0, "creada": 0, "error": 0]
        for t in tarjetas { if r[t.estado] != nil { r[t.estado]! += 1 } }
        return r
    }

    static func resumenOficina(_ o: Oficina, tarjetas: [Tarjeta]) -> [String: Any] {
        var r: [String: Any] = ["nombre": o.nombre]
        r["departamentos"] = o.departamentos.map { d -> [String: Any] in
            var x: [String: Any] = ["id": d.id, "nombre": d.nombre]
            if let m = d.mision { x["mision"] = m }
            return x
        }
        r["agentes"] = o.agentes.map { a -> [String: Any] in
            var x: [String: Any] = ["id": a.id, "nombre": a.nombre, "rol": a.rol, "departamento": a.departamento]
            if a.esCoordinador { x["coordinador"] = true }
            if let c = a.conectores, !c.isEmpty { x["conectores"] = c.map(\.servidor) }
            if let l = a.limites, !l.vacio { x["limites"] = ["solo": l.solo?.count ?? 0, "proponer": l.proponer?.count ?? 0] }
            return x
        }
        r["reglas"] = (o.reglas ?? []).map { ["id": $0.id, "texto": $0.texto] }
        r["flujos"] = (o.flujos ?? []).map { f -> [String: Any] in
            ["id": f.id, "nombre": f.nombre, "pasos": f.pasos.map { ["id": $0.id, "nombre": $0.nombre, "quien": $0.quien, "aprobacion": $0.aprobacion] }]
        }
        r["tareas"] = (o.tareas ?? []).map { t -> [String: Any] in
            var x: [String: Any] = ["id": t.id, "agente": t.agente, "nombre": t.nombre, "hora": t.hora, "activa": t.activa]
            if let f = t.fecha { x["fecha"] = f } else { x["dias"] = t.dias }
            return x
        }
        r["tarjetas"] = tarjetas.filter { $0.estado != "descartada" }.map { t -> [String: Any] in
            var x: [String: Any] = ["id": t.id, "tipo": t.tipo, "accion": t.accion, "estado": t.estado,
                                    "faltantes": lista(t.faltantes).map { $0["campo"] as? String ?? "" }]
            if let ob = t.objetivo { x["objetivo"] = ob }
            let dt = objeto(t.datos)
            if let n = texto(dt["nombre"]) ?? texto(dt["texto"]) { x["nombre"] = String(n.prefix(80)) }
            return x
        }
        return r
    }

    static func conectoresJSON(_ catalogo: [ServidorConector]?) -> [String: Any] {
        guard let catalogo else {
            return ["detectado": false, "nota": "Todavía no se detectaron los conectores de la cuenta de claude.ai: la persona tiene que abrir Conectores y actualizar.",
                    "servidores": [Any]()]
        }
        return ["detectado": true,
                "servidores": catalogo.map { ["nombre": $0.nombre, "estado": $0.estado, "disponible": $0.disponible, "herramientas": $0.herramientas] as [String: Any] }]
    }
}

// MARK: - Store: id nuevo y guardado atómico, y mensajes con fecha

extension Store {
    /// Le asigna el siguiente `tN` libre y la guarda, todo dentro del actor (sin cortes entre medio).
    func tarjetaGuardarNueva(_ t: Tarjeta) -> Tarjeta? {
        var n = t
        n.id = tarjetaNuevoId(oficina: t.oficina)
        guard tarjetaGuardar(n) else { return nil }
        return tarjeta(oficina: n.oficina, id: n.id)
    }

    /// Mensajes de una sesión con su fecha (para `GET /api/creador/estado`).
    func mensajesConFecha(_ sid: String, limite: Int = 500) -> [(rol: String, texto: String, error: Bool, ts: Double)] {
        (try? db.query("""
            SELECT rol,texto,error,ts FROM (SELECT id,rol,texto,error,ts FROM mensajes WHERE sid=? ORDER BY id DESC LIMIT ?) ORDER BY id
            """, [.text(sid), .int(Int64(limite))]) { (rol: $0.text(0), texto: $0.text(1), error: $0.int(2) != 0, ts: $0.double(3)) }) ?? []
    }
}

/// Versión del borrador del Creador por oficina: sube con cada cambio y el front la sondea (`/api/actividad`).
final class VersionCreador: @unchecked Sendable {
    static let compartida = VersionCreador()
    private let lock = NSLock()
    private var versiones: [String: Int] = [:]

    init() {}

    func valor(_ oficina: String) -> Int { lock.lock(); defer { lock.unlock() }; return versiones[oficina] ?? 0 }

    @discardableResult
    func subir(_ oficina: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        let n = (versiones[oficina] ?? 0) + 1
        versiones[oficina] = n
        return n
    }
}

// MARK: - herramientas MCP del perfil creador

struct HerramientasCreador: MCPHerramientas {
    let s: ServiciosHQ
    let token: String
    let identidad: IdentidadMCP

    private static let accionSchema: [String: Any] = ["type": "string", "enum": Creador.acciones,
        "description": "crear una cosa nueva, modificar una que ya existe (con objetivo) o quitarla (con objetivo; la persona lo confirma)"]

    private static func proponer(_ tipo: String, _ que: String, datos: String) -> [String: Any] {
        ["name": "proponer_" + tipo,
         "description": "Propone una tarjeta de \(que) para que la persona la apruebe. No crea nada: la tarjeta queda en borrador (si falta algo) o lista. \(datos)",
         "inputSchema": ["type": "object",
                         "properties": [
                            "accion": accionSchema,
                            "objetivo": ["type": "string", "description": "id de lo que ya existe en la oficina (para modificar o quitar)"],
                            "ref": ["type": "string", "description": "id de una tarjeta tuya para actualizarla en vez de crear otra (por ejemplo t1)"],
                            "origen": ["type": "string", "description": "cita TEXTUAL de lo que dijo la persona y que justifica esta tarjeta"],
                            "datos": ["type": "object", "description": datos]] as [String: Any],
                         "required": ["accion", "origen"]] as [String: Any]]
    }

    var definiciones: [[String: Any]] {
        let ref = "Para referirte a otra tarjeta escribí \"tarjeta:<id>\"."
        return [
            ["name": "ver_oficina",
             "description": "Resumen de la oficina (departamentos, agentes, reglas, flujos, tareas) y de las tarjetas que ya armaste. Miralo antes de proponer cambios.",
             "inputSchema": ["type": "object", "properties": [String: Any]()]],
            ["name": "listar_conectores",
             "description": "Los conectores de la cuenta de claude.ai (Calendar, Gmail, Drive…) con sus herramientas y si están disponibles.",
             "inputSchema": ["type": "object", "properties": [String: Any]()]],
            Self.proponer("departamento", "departamento", datos: "{id?, nombre*, mision?, color?}"),
            Self.proponer("agente", "agente", datos: "{id?, nombre*, rol*, departamento* (id o tarjeta:x), prompt*, description?, modelo?, chips?, limites?:{solo?,proponer?}, conectores?, permisos? ([\"coordinador\"] para quien coordina la oficina)}. \(ref)"),
            Self.proponer("flujo", "flujo de trabajo", datos: "{id?, nombre*, descripcion?, pasos*:[{id?, nombre*, quien* (id de agente, tarjeta:x o persona), consigna?, recibe?, recibeDe?, entrega*, aprobacion* (true o false, tiene que venir explícita), plazoDias?, esperaDias?}]}. \(ref)"),
            Self.proponer("regla", "regla de la oficina", datos: "{id?, texto*}"),
            Self.proponer("conector", "conector para un agente", datos: "{agente* (id o tarjeta:x), servidor*, leer?, actuar?} con nombres completos de herramientas (ver listar_conectores). \(ref)"),
            Self.proponer("tarea", "tarea programada", datos: "{agente* (id o tarjeta:x), nombre*, consigna*, dias* ([1…7], 1 = lunes) o fecha (AAAA-MM-DD), hora* (HH:MM), zona?, periodicidad? (solo semanal)}. \(ref)"),
            ["name": "marcar_faltante",
             "description": "Anota una pregunta pendiente en una tarjeta: lo que el texto no dice. La tarjeta pasa a borrador hasta que se complete ese campo.",
             "inputSchema": ["type": "object",
                             "properties": ["ref": ["type": "string", "description": "id de la tarjeta"],
                                            "campo": ["type": "string", "description": "campo que falta (por ejemplo mision)"],
                                            "pregunta": ["type": "string", "description": "la pregunta para la persona"]] as [String: Any],
                             "required": ["ref", "campo", "pregunta"]] as [String: Any]],
            ["name": "descartar_tarjeta",
             "description": "Descarta una tarjeta tuya que ya no corresponde.",
             "inputSchema": ["type": "object", "properties": ["id": ["type": "string"]] as [String: Any], "required": ["id"]] as [String: Any]]
        ]
    }

    private func cupo() -> Bool {
        guard let m = s.mcp else { return true }
        return m.tokens.tomar(token, clave: Creador.claveCupo, max: Creador.maxEscrituras)
    }

    private static let sinCupo = MCPResultado.error("Ya hiciste \(Creador.maxEscrituras) cambios en este mensaje y no podés hacer más. Respondé con lo que tengas.")

    func llamar(_ nombre: String, argumentos: [String: Any]) async -> MCPResultado? {
        switch nombre {
        case "ver_oficina": return await verOficina()
        case "listar_conectores": return .ok(Creador.json(Creador.conectoresJSON(CatalogoConectores.compartido.servidores())))
        case "marcar_faltante": return await marcar(argumentos)
        case "descartar_tarjeta": return await descartar(argumentos)
        default:
            if nombre.hasPrefix("proponer_"), Tarjeta.tipos.contains(String(nombre.dropFirst("proponer_".count))) {
                return await proponer(String(nombre.dropFirst("proponer_".count)), argumentos)
            }
            return nil
        }
    }

    private func verOficina() async -> MCPResultado {
        guard let o = try? OficinaStore.leer(carpeta: identidad.oficina) else { return .error("No pude leer la oficina.") }
        let ts = await s.store.tarjetas(oficina: identidad.oficina)
        return .ok(ConsultasMCP.sanear(Creador.json(Creador.resumenOficina(o, tarjetas: ts))))
    }

    private func proponer(_ tipo: String, _ args: [String: Any]) async -> MCPResultado {
        // 1) cupo
        guard cupo() else { return Self.sinCupo }
        guard let accion = args["accion"] as? String, Creador.acciones.contains(accion) else {
            return .error("«accion» tiene que ser crear, modificar o quitar.")
        }
        // 2) anti-invento: la cita tiene que estar en lo que dijo la persona
        guard let origen = Creador.texto(args["origen"]) else {
            return .error("Falta «origen»: citá textual lo que dijo la persona.")
        }
        let mensajes = await s.store.mensajes(identidad.sid)
        guard Creador.citaValida(origen, mensajes: mensajes) else {
            return .error("Citá textual lo que dijo la persona: «\(ConsultasMCP.sanear(String(origen.prefix(80))))» no aparece en sus mensajes. No inventes: si el texto no lo dice, marcalo con marcar_faltante.")
        }
        let datos = args["datos"] as? [String: Any] ?? [:]
        if args["datos"] != nil, !(args["datos"] is [String: Any]) { return .error("«datos» tiene que ser un objeto.") }
        do {
            // 3) a 8) sanear, faltantes, referencias, formato, estado, guardar, versión
            let t = try await Creador.armar(s, carpeta: identidad.oficina, sid: identidad.sid, tipo: tipo, accion: accion,
                                            objetivo: Creador.texto(args["objetivo"]), ref: Creador.texto(args["ref"]),
                                            origen: ConsultasMCP.sanear(origen), datos: datos)
            return .ok(ConsultasMCP.sanear(Creador.json(t.json)))
        } catch let e as ErrorAPI {
            return .error(ConsultasMCP.sanear(e.mensaje))
        } catch {
            return .error("No pude guardar la tarjeta.")
        }
    }

    private func marcar(_ args: [String: Any]) async -> MCPResultado {
        guard cupo() else { return Self.sinCupo }
        guard let ref = Creador.texto(args["ref"]), let campo = Creador.texto(args["campo"]), let pregunta = Creador.texto(args["pregunta"]) else {
            return .error("Faltan «ref», «campo» y «pregunta».")
        }
        guard var t = await s.store.tarjeta(oficina: identidad.oficina, id: ref) else { return .error("No existe la tarjeta «\(ConsultasMCP.sanear(ref))».") }
        guard ["borrador", "lista", "error"].contains(t.estado) else { return .error("La tarjeta «\(ref)» ya está \(t.estado) y no se puede cambiar.") }
        var f = Creador.lista(t.faltantes).filter { ($0["campo"] as? String) != campo }
        var nuevo = Creador.faltante(String(ConsultasMCP.sanear(campo).prefix(80)), String(ConsultasMCP.sanear(pregunta).prefix(400)))
        nuevo["manual"] = true
        f.append(nuevo)
        t.faltantes = Creador.json(f, ordenado: false)
        t.estado = "borrador"; t.error = nil
        await s.store.tarjetaGuardar(t)
        VersionCreador.compartida.subir(identidad.oficina)
        guard let g = await s.store.tarjeta(oficina: identidad.oficina, id: ref) else { return .error("No pude guardar la tarjeta.") }
        return .ok(ConsultasMCP.sanear(Creador.json(g.json)))
    }

    private func descartar(_ args: [String: Any]) async -> MCPResultado {
        guard cupo() else { return Self.sinCupo }
        guard let id = Creador.texto(args["id"]) else { return .error("Falta «id».") }
        guard let t = await s.store.tarjeta(oficina: identidad.oficina, id: id) else { return .error("No existe la tarjeta «\(ConsultasMCP.sanear(id))».") }
        guard t.estado != "creada" else { return .error("La tarjeta «\(id)» ya se creó: no se puede descartar.") }
        guard let g = await s.store.tarjetaEstado(oficina: identidad.oficina, id: id, estado: "descartada") else { return .error("No pude descartar la tarjeta.") }
        VersionCreador.compartida.subir(identidad.oficina)
        return .ok(ConsultasMCP.sanear(Creador.json(g.json)))
    }
}
