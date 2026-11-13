import Foundation
import Testing
@testable import Backend

/// Entorno aislado por test: HOME, proyecto y datos en un directorio temporal, y un `claude` falso (bash).
/// Nunca toca ~/Próspera ni ~/.claude reales.
///
/// El `claude` falso responde según una palabra clave dentro del mensaje (último argumento):
///   (nada)    -> {"result":"hola","is_error":false}
///   USADA     -> con --session-id: error "already in use" (rc 1)
///   NOCONV    -> con --resume: error "No conversation found" (rc 1)
///   NOTFOUND  -> con --resume: error "session not found" (rc 1)
///   LOGINERR  -> error "Please run /login" (rc 1)
///   LENTO     -> lanza un `sleep 300` hijo (pid en child.pid) y espera
///   DORMIR    -> duerme 1 s y responde bien
///   NOJSON    -> imprime texto que no es JSON (rc 0)
///   SALE3     -> escribe "boom" por stderr y sale con rc 3
///   ISERR     -> JSON con is_error=true y rc 0
///   VACIO     -> JSON con result ""
///
/// Además reconoce el TIPO de llamada por el texto del prompt y responde en consecuencia (sin tocar los casos de arriba):
/// (Los patrones son ASCII: Process pasa los argumentos en NFD y un acento compuesto no coincidiría.)
///   borrador  (sin --agent, "diseñador de equipos")        -> JSON de agente dentro de ```json
///   acta      (sin --agent, "secretario de actas")          -> JSON {resumen, decisiones, pendientes}
///   ficha     (sin --agent, "Sos el bibliotecario")         -> JSON de ficha (util_para ["direccion"], sin contradicciones)
///   imagen    (sin --agent, "Describí la imagen")           -> texto descriptivo
///   turno     (--agent, "Estás en una reunión")             -> "Opinión de <agente> sobre el tema."
///   consulta  (--agent, "consulta de un colega")             -> "Mi mirada de <agente> sobre la consulta." (costo 0.03)
///   CONSULTAR:<colega> [x4] (en un chat) -> llama por HTTP a `consultar` del servidor MCP (URL de --mcp-config, token de
///                         $HQ_MCP_TOKEN); guarda las respuestas en `mcp.<agente>.out`, el token en `token.log` y la URL en `url.log`
///   lectura   (--agent, "Se sumó un documento a la biblioteca") -> agrega una línea a conocimiento/agentes/<agente>.md y responde "listo"
/// `Sandbox.responder(clave, texto)` pisa la respuesta (clave: borrador|acta|ficha|imagen|turno|lectura, o `turno.<agente>`).
/// `Sandbox.modo(clave, modo)` cambia el comportamiento de una clave (`<tipo>` o un id de agente):
///   error (is_error), vacio (result ""), nojson (texto plano), lento (sleep 300: sirve para timeouts),
///   puerta (espera a `Sandbox.abrirPuerta()`, hasta 15 s: sirve para controlar el orden sin sleeps).
/// Registra en `args.log` los argumentos de cada llamada de chat, en `cwd.log` su carpeta de trabajo y en `events.log`
/// el orden de S/E por agente.
final class Sandbox: @unchecked Sendable {
    let root: String
    let home: String
    let proyecto: String
    let datos: String
    let bin: String
    var binDir: String { (bin as NSString).deletingLastPathComponent }
    /// Carpeta donde la API crea las oficinas (en vez de ~/Oficinas).
    var oficinasDir: String { root + "/oficinas" }

    init(proyecto crear: Bool = true) {
        let base = (NSTemporaryDirectory() as NSString).appendingPathComponent("hqtests-\(UUID().uuidString)")
        root = base
        home = base + "/home"
        proyecto = home + "/Próspera"
        datos = base + "/datos"
        bin = base + "/bin/claude"
        let fm = FileManager.default
        try? fm.createDirectory(atPath: base + "/bin", withIntermediateDirectories: true)
        try? fm.createDirectory(atPath: home, withIntermediateDirectories: true)
        if crear { try? fm.createDirectory(atPath: proyecto, withIntermediateDirectories: true) }
        fm.createFile(atPath: bin, contents: Data(Sandbox.script.utf8), attributes: [.posixPermissions: 0o755])
    }

    deinit {
        // por si un test dejó un hijo vivo
        if let s = try? String(contentsOfFile: binDir + "/child.pid", encoding: .utf8), let p = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)) {
            kill(p, SIGKILL)
        }
        try? FileManager.default.removeItem(atPath: root)
    }

    static let script = #"""
    #!/bin/bash
    D="$(cd "$(dirname "$0")" && pwd)"
    if [[ "$1" == "auth" ]]; then
      echo "AUTH" >> "$D/events.log"
      if [[ -f "$D/noauth" ]]; then echo '{"loggedIn":false}'; exit 1; fi
      echo '{"loggedIn":true}'; exit 0
    fi
    agent=""; prev=""
    for a in "$@"; do
      if [[ "$prev" == "--agent" ]]; then agent="$a"; fi
      prev="$a"
    done
    msg="${@: -1}"
    { printf '%s\x1f' "$@"; printf '\x1e'; } >> "$D/args.log"
    echo "S $agent" >> "$D/events.log"
    fin() { echo "E $agent" >> "$D/events.log"; }
    has() { [[ " $* " == *" $1 "* ]]; }
    echo "$PWD" >> "$D/cwd.log"
    kind=""
    if [[ -z "$agent" ]]; then
      if [[ "$msg" == *"ador de equipos"* ]]; then kind=borrador
      elif [[ "$msg" == *"secretario de actas"* ]]; then kind=acta
      elif [[ "$msg" == *"Sos el bibliotecario"* ]]; then kind=ficha
      elif [[ "$msg" == *"imagen que est"* ]]; then kind=imagen
      fi
    else
      if [[ "$msg" == *"en una reuni"* ]]; then kind=turno
      elif [[ "$msg" == *"documento a la biblioteca"* ]]; then kind=lectura
      elif [[ "$msg" == *"consulta de un colega"* ]]; then kind=consulta
      fi
    fi
    modo=""
    if [[ -n "$agent" && -f "$D/modo.$agent" ]]; then modo="$(cat "$D/modo.$agent")"
    elif [[ -n "$kind" && -f "$D/modo.$kind" ]]; then modo="$(cat "$D/modo.$kind")"; fi
    case "$modo" in
      lento) sleep 300 & echo $! > "$D/child.pid"; wait; fin; exit 0;;
      error) echo '{"type":"result","result":"fallo raro","is_error":true}'; fin; exit 0;;
      vacio) echo '{"type":"result","result":"","is_error":false}'; fin; exit 0;;
      nojson) echo "esto no es json"; fin; exit 0;;
      puerta) n=0; while [[ ! -f "$D/go" && $n -lt 300 ]]; do sleep 0.05; n=$((n+1)); done;;
    esac
    if [[ "$msg" == *LENTO* ]]; then
      sleep 300 &
      echo $! > "$D/child.pid"
      wait
      fin; exit 0
    fi
    if [[ "$msg" == *DORMIR* ]]; then sleep 1; fi
    if [[ "$msg" == *USADA* && " $* " == *" --session-id "* ]]; then
      echo '{"type":"result","result":"Error: Session ID is already in use","is_error":true}'; fin; exit 1
    fi
    if [[ "$msg" == *NOCONV* && " $* " == *" --resume "* ]]; then
      echo '{"type":"result","result":"No conversation found with session ID","is_error":true}'; fin; exit 1
    fi
    if [[ "$msg" == *NOTFOUND* && " $* " == *" --resume "* ]]; then
      echo '{"type":"result","result":"Error: session not found","is_error":true}'; fin; exit 1
    fi
    if [[ "$msg" == *LOGINERR* ]]; then
      echo '{"type":"result","result":"Please run /login","is_error":true}'; fin; exit 1
    fi
    if [[ "$msg" == *NOJSON* ]]; then echo "esto no es json"; fin; exit 0; fi
    if [[ "$msg" == *SALE3* ]]; then echo "boom" >&2; fin; exit 3; fi
    if [[ "$msg" == *ISERR* ]]; then echo '{"type":"result","result":"fallo raro","is_error":true}'; fin; exit 0; fi
    if [[ "$msg" == *VACIO* ]]; then echo '{"type":"result","result":"","is_error":false}'; fin; exit 0; fi
    if [[ -n "$kind" ]]; then
      if [[ -n "$agent" && -f "$D/resp.$kind.$agent.json" ]]; then cat "$D/resp.$kind.$agent.json"; fin; exit 0; fi
      if [[ -f "$D/resp.$kind.json" ]]; then cat "$D/resp.$kind.json"; fin; exit 0; fi
      case "$kind" in
        borrador) echo '{"type":"result","result":"Acá va el borrador:\n```json\n{\"id\":\"valentina\",\"nombre\":\"Valentina\",\"rol\":\"Analista de datos\",\"description\":\"Analista de datos. Usala cuando haga falta medir resultados.\",\"prompt\":\"Sos Valentina, analista de datos.\",\"chips\":[\"¿Cómo vamos?\",\"Armame un informe\",\"¿Qué medimos?\"],\"modelo\":\"sonnet\"}\n```","is_error":false}';;
        acta) echo '{"type":"result","result":"{\"resumen\":\"Se acordó avanzar con el plan.\",\"decisiones\":[\"Lanzar en diciembre\",\"Priorizar los reels\"],\"pendientes\":[{\"quien\":\"Marce\",\"que\":\"Armar el calendario\"}]}","is_error":false}';;
        ficha) echo '{"type":"result","result":"{\"titulo\":\"Ficha de prueba\",\"resumen\":\"Resumen de prueba del documento.\",\"datos_clave\":[\"dato uno\"],\"temas\":[\"pruebas\"],\"util_para\":[\"direccion\"],\"fechas\":[],\"contradicciones\":[]}","is_error":false}';;
        imagen) echo '{"type":"result","result":"Una imagen de prueba con el texto HOLA MUNDO.","is_error":false}';;
        turno) echo "{\"type\":\"result\",\"result\":\"Opinión de $agent sobre el tema.\",\"is_error\":false,\"total_cost_usd\":0.02}";;
        lectura) mkdir -p conocimiento/agentes; echo "- leyó el documento (prueba)" >> "conocimiento/agentes/$agent.md"; echo '{"type":"result","result":"listo","is_error":false}';;
        consulta) echo "{\"type\":\"result\",\"result\":\"Mi mirada de $agent sobre la consulta.\",\"is_error\":false,\"total_cost_usd\":0.03}";;
      esac
      fin; exit 0
    fi
    if [[ -n "$kind" ]]; then
      if [[ -n "$agent" && -f "$D/resp.$kind.$agent.json" ]]; then cat "$D/resp.$kind.$agent.json"; fin; exit 0; fi
      if [[ -f "$D/resp.$kind.json" ]]; then cat "$D/resp.$kind.json"; fin; exit 0; fi
      case "$kind" in
        borrador) echo '{"type":"result","result":"Acá va el borrador:\n```json\n{\"id\":\"valentina\",\"nombre\":\"Valentina\",\"rol\":\"Analista de datos\",\"description\":\"Analista de datos. Usala cuando haga falta medir resultados.\",\"prompt\":\"Sos Valentina, analista de datos.\",\"chips\":[\"¿Cómo vamos?\",\"Armame un informe\",\"¿Qué medimos?\"],\"modelo\":\"sonnet\"}\n```","is_error":false}';;
        acta) echo '{"type":"result","result":"{\"resumen\":\"Se acordó avanzar con el plan.\",\"decisiones\":[\"Lanzar en diciembre\",\"Priorizar los reels\"],\"pendientes\":[{\"quien\":\"Marce\",\"que\":\"Armar el calendario\"}]}","is_error":false}';;
        ficha) echo '{"type":"result","result":"{\"titulo\":\"Ficha de prueba\",\"resumen\":\"Resumen de prueba del documento.\",\"datos_clave\":[\"dato uno\"],\"temas\":[\"pruebas\"],\"util_para\":[\"direccion\"],\"fechas\":[],\"contradicciones\":[]}","is_error":false}';;
        imagen) echo '{"type":"result","result":"Una imagen de prueba con el texto HOLA MUNDO.","is_error":false}';;
        turno) echo "{\"type\":\"result\",\"result\":\"Opinión de $agent sobre el tema.\",\"is_error\":false,\"total_cost_usd\":0.02}";;
        lectura) mkdir -p conocimiento/agentes; echo "- leyó el documento (prueba)" >> "conocimiento/agentes/$agent.md"; echo '{"type":"result","result":"listo","is_error":false}';;
      esac
      fin; exit 0
    fi
    if [[ "$msg" == *CONSULTAR:* ]]; then
      # llama a `consultar` del servidor MCP con el token del entorno, como haría claude (xN: N veces)
      colega="${msg#*CONSULTAR:}"; colega="${colega%% *}"
      veces=1; [[ "$msg" == *x4* ]] && veces=4
      cfg=""; prev=""
      for a in "$@"; do if [[ "$prev" == "--mcp-config" ]]; then cfg="$a"; fi; prev="$a"; done
      url="$(echo "$cfg" | grep -o 'http://127[^"]*')"
      echo "$HQ_MCP_TOKEN" >> "$D/token.log"
      echo "$url" >> "$D/url.log"
      for i in $(seq 1 $veces); do
        body="{\"jsonrpc\":\"2.0\",\"id\":$i,\"method\":\"tools/call\",\"params\":{\"name\":\"consultar\",\"arguments\":{\"colega\":\"$colega\",\"pregunta\":\"Como vamos con lo tuyo?\"}}}"
        curl -s -m 20 -H "Authorization: Bearer $HQ_MCP_TOKEN" -H 'Content-Type: application/json' -d "$body" "$url" >> "$D/mcp.$agent.out"
        echo >> "$D/mcp.$agent.out"
      done
      echo "{\"type\":\"result\",\"result\":\"consulte\",\"is_error\":false,\"total_cost_usd\":0.01}"
      fin; exit 0
    fi
    if [[ "$msg" == *STREAM* ]]; then
      echo '{"type":"system","subtype":"hook_started","hook_name":"x"}'
      echo "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s-$agent\"}"
      echo '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""}]}}'
      echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/x/conocimiento/oficina.md"}}]}}'
      if [[ "$msg" == *PAUSA* ]]; then n=0; while [[ ! -f "$D/go" && $n -lt 300 ]]; do sleep 0.05; n=$((n+1)); done; fi
      echo '{"type":"user","message":{"content":[{"type":"tool_result","content":"secreto"}]}}'
      echo '{"type":"assistant","message":{"content":[{"type":"text","text":"listo"}]}}'
      echo "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"stream $agent\",\"is_error\":false,\"total_cost_usd\":0.25}"
      fin; exit 0
    fi
    echo "{\"type\":\"result\",\"result\":\"hola $agent\",\"is_error\":false,\"total_cost_usd\":0.01}"
    fin
    exit 0
    """#

    func config(_ mod: (inout Config) -> Void = { _ in }) -> Config {
        var c = Config(home: home)
        c.datosDir = datos
        c.oficinasDir = oficinasDir
        mod(&c)
        return c
    }

    /// Backend con el claude falso (o `claudePath` distinto). `env` vacío: sin variables reales.
    /// Con `oficina` (default) deja abierta una oficina en `proyecto` con los agentes por defecto, así los tests de
    /// chat/historial siguen ejerciendo la misma ruta que antes (desde las oficinas, chat exige una oficina activa).
    func backend(claudePath: String? = nil, env: [String: String] = [:], oficina: Bool = true,
                 _ mod: (inout Config) -> Void = { _ in }) throws -> Backend {
        let cfg = config(mod)
        if oficina { try abrirOficinaDePrueba(ids: cfg.agentes) }
        return try Backend(config: cfg, dataDir: datos, claudePath: claudePath ?? bin, env: env)
    }

    /// Escribe `oficina.json` en `proyecto` y `config.json` con esa oficina como activa (antes de crear el Backend).
    func abrirOficinaDePrueba(ids: [String]) throws {
        guard FileManager.default.fileExists(atPath: proyecto) else { return }
        let o = Oficina(nombre: "Prueba", duenio: "Tester",
                        departamentos: [Departamento(id: "dir", nombre: "Dirección", color: "#ee6da6")],
                        agentes: ids.map { AgenteDef(id: $0, nombre: $0.capitalized, rol: "rol de prueba", departamento: "dir") })
        try OficinaStore.escribir(o, carpeta: proyecto)
        try FileManager.default.createDirectory(atPath: datos, withIntermediateDirectories: true)
        let cfg = json(["oficina_activa": proyecto])
        try cfg.write(to: URL(fileURLWithPath: datos + "/config.json"))
    }

    func setAuth(_ ok: Bool) {
        let p = binDir + "/noauth"
        if ok { try? FileManager.default.removeItem(atPath: p) } else { FileManager.default.createFile(atPath: p, contents: Data()) }
    }

    /// Llamadas de chat (`-p ...`) al claude falso, cada una como lista de argumentos.
    var llamadas: [[String]] {
        guard let s = try? String(contentsOfFile: binDir + "/args.log", encoding: .utf8) else { return [] }
        return s.components(separatedBy: "\u{1e}").filter { !$0.isEmpty }.map { rec in
            var a = rec.components(separatedBy: "\u{1f}")
            if a.last == "" { a.removeLast() }
            return a
        }
    }

    /// "S betty", "E betty", ... en orden de ocurrencia.
    var eventos: [String] {
        ((try? String(contentsOfFile: binDir + "/events.log", encoding: .utf8)) ?? "")
            .split(separator: "\n").map(String.init).filter { $0 != "AUTH" }
    }

    var childPid: Int32? {
        (try? String(contentsOfFile: binDir + "/child.pid", encoding: .utf8)).flatMap {
            Int32($0.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }
}

/// UUIDs fijos y válidos para los tests.
enum U {
    static let a = "11111111-1111-4111-8111-111111111111"
    static let b = "22222222-2222-4222-8222-222222222222"
    static let c = "33333333-3333-4333-8333-333333333333"
    static let d = "44444444-4444-4444-8444-444444444444"
}

typealias Resp = (status: Int, obj: [String: Any])

/// Llama al router y decodifica el JSON de la respuesta.
func llamar(_ b: Backend, _ metodo: String, _ path: String, query: [String: String] = [:], body: Data? = nil) async -> Resp {
    let r = await b.router.handle(method: metodo, path: path, query: query, body: body)
    let o = (try? JSONSerialization.jsonObject(with: r.json)) as? [String: Any] ?? ["__no_json__": String(decoding: r.json, as: UTF8.self)]
    return (r.status, o)
}

func json(_ o: Any) -> Data { try! JSONSerialization.data(withJSONObject: o) }

func chat(_ b: Backend, agent: String = "betty", message: String = "hola", session: String = U.a) async -> Resp {
    await llamar(b, "POST", "/api/chat", body: json(["agent": agent, "message": message, "session": session]))
}

func historial(_ b: Backend, agent: String = "betty", session: String? = nil) async -> Resp {
    var q = ["agent": agent]
    if let s = session { q["session"] = s }
    return await llamar(b, "GET", "/api/historial", query: q)
}

/// Igualdad estructural de objetos JSON (dicts/arrays/números/bool/null).
func igual(_ a: Any, _ b: Any) -> Bool { (a as AnyObject).isEqual(b) }

func esperar(hasta segundos: Double = 5, _ cond: () -> Bool) async -> Bool {
    let limite = Date().addingTimeInterval(segundos)
    while Date() < limite {
        if cond() { return true }
        try? await Task.sleep(nanoseconds: 25_000_000)
    }
    return cond()
}

func vivo(_ pid: Int32) -> Bool { kill(pid, 0) == 0 }

/// Respuesta como [[String: Any]] de `msgs`.
func msgs(_ r: Resp) -> [[String: Any]] { r.obj["msgs"] as? [[String: Any]] ?? [] }


// MARK: - claude falso: control y registro (reuniones, biblioteca, agentes)

extension Sandbox {
    /// Pisa la respuesta del claude falso para `clave` (ver la documentación de `Sandbox.script`).
    func responder(_ clave: String, _ texto: String) {
        let j = json(["type": "result", "result": texto, "is_error": false])
        FileManager.default.createFile(atPath: binDir + "/resp.\(clave).json", contents: j)
    }

    /// Cambia el modo de una clave (`error`, `vacio`, `nojson`, `lento`, `puerta`); `nil` lo quita.
    func modo(_ clave: String, _ modo: String?) {
        let p = binDir + "/modo.\(clave)"
        if let modo { FileManager.default.createFile(atPath: p, contents: Data(modo.utf8)) }
        else { try? FileManager.default.removeItem(atPath: p) }
    }

    /// Deja pasar a todos los claude que esperan en modo `puerta` (y a los siguientes).
    func abrirPuerta() { FileManager.default.createFile(atPath: binDir + "/go", contents: Data()) }

    /// Carpeta de trabajo de cada llamada, en el mismo orden que `llamadas`.
    var cwds: [String] {
        ((try? String(contentsOfFile: binDir + "/cwd.log", encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }

    /// Último argumento (el prompt) de cada llamada.
    var prompts: [String] { llamadas.map { $0.last ?? "" } }

    /// Llamadas cuyo prompt contiene `texto`.
    func llamadas(conPrompt texto: String) -> [[String]] { llamadas.filter { ($0.last ?? "").contains(texto) } }

    /// Valor del argumento que sigue a `flag` (o nil).
    static func valor(_ args: [String], _ flag: String) -> String? {
        args.firstIndex(of: flag).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
    }

    /// Todos los valores de un flag que puede repetirse (`--add-dir`).
    static func valores(_ args: [String], _ flag: String) -> [String] {
        args.indices.filter { args[$0] == flag && $0 + 1 < args.count }.map { args[$0 + 1] }
    }

    /// Reglas de `--allowedTools` (todo lo que sigue hasta el `--` final).
    static func reglas(_ args: [String]) -> [String] {
        guard let i = args.firstIndex(of: "--allowedTools") else { return [] }
        let fin = args.lastIndex(of: "--") ?? args.count
        return Array(args[(i + 1)..<fin])
    }
}

func sinPrivate(_ p: String) -> String { p.hasPrefix("/private/") ? String(p.dropFirst(8)) : p }

func leerTexto(_ ruta: String) -> String { (try? String(contentsOfFile: ruta, encoding: .utf8)) ?? "" }
func existe(_ ruta: String) -> Bool { FileManager.default.fileExists(atPath: ruta) }
func escribir(_ texto: String, en ruta: String) {
    try? FileManager.default.createDirectory(atPath: (ruta as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try? Data(texto.utf8).write(to: URL(fileURLWithPath: ruta))
}
func listar(_ ruta: String) -> [String] { ((try? FileManager.default.contentsOfDirectory(atPath: ruta)) ?? []).sorted() }

/// Raíz del repo (tres niveles sobre este archivo: app/Tests/BackendTests).
let raizRepo: String = {
    var u = URL(fileURLWithPath: #filePath)
    for _ in 0..<4 { u.deleteLastPathComponent() }
    return u.path
}()

func str(_ v: Any?) -> String { (v as? String) ?? "" }
func dict(_ v: Any?) -> [String: Any] { (v as? [String: Any]) ?? [:] }
func lista(_ v: Any?) -> [[String: Any]] { (v as? [[String: Any]]) ?? [] }

/// Espera con una condición asíncrona (consulta la API); devuelve si se cumplió.
func esperarAsync(hasta segundos: Double = 10, _ cond: () async -> Bool) async -> Bool {
    let limite = Date().addingTimeInterval(segundos)
    while Date() < limite {
        if await cond() { return true }
        try? await Task.sleep(nanoseconds: 25_000_000)
    }
    return await cond()
}

/// Una oficina creada por la API sobre un Backend con el claude falso. `ruta(rel)` = ruta absoluta dentro de la oficina.
struct Fix {
    let sb: Sandbox
    let b: Backend
    let carpeta: String

    func ruta(_ rel: String) -> String { carpeta + "/" + rel }
    func leer(_ rel: String) -> String { leerTexto(ruta(rel)) }
    func existe(_ rel: String) -> Bool { FileManager.default.fileExists(atPath: ruta(rel)) }
    func oficinaJSON() -> [String: Any] {
        ((try? JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: ruta("oficina.json"))))) as? [String: Any]) ?? [:]
    }
    func get(_ path: String, _ q: [String: String] = [:]) async -> Resp { await llamar(b, "GET", path, query: q) }
    func post(_ path: String, _ body: Any? = nil) async -> Resp { await llamar(b, "POST", path, body: body.map(json)) }
    func patch(_ path: String, _ body: Any? = nil) async -> Resp { await llamar(b, "PATCH", path, body: body.map(json)) }
    func delete(_ path: String, _ body: Any? = nil, query: [String: String] = [:]) async -> Resp {
        await llamar(b, "DELETE", path, query: query, body: body.map(json))
    }

    /// Crea la oficina (activa) por la API, con departamentos por nombre y agentes `(id, departamento, rol?)`.
    static func crear(nombre: String = "Taller", duenio: String = "Ana", deps: [String] = ["Dirección", "Redes"],
                      agentes: [(id: String, depto: String, rol: String?)] = [], sb: Sandbox = Sandbox(),
                      env: [String: String] = [:], _ mod: (inout Config) -> Void = { _ in }) async throws -> Fix {
        let b = try sb.backend(env: env, oficina: false, mod)
        let r = await llamar(b, "POST", "/api/oficinas", body: json(["nombre": nombre, "duenio": duenio, "departamentos": deps]))
        try #require(r.status == 200, "crear oficina: \(r.obj)")
        let f = Fix(sb: sb, b: b, carpeta: str(r.obj["carpeta"]))
        for a in agentes {
            let c = await contratar(b, id: a.id, depto: a.depto, rol: a.rol)
            try #require(c.status == 200, "contratar \(a.id): \(c.obj)")
        }
        return f
    }
}

@discardableResult
func contratar(_ b: Backend, id: String, nombre: String? = nil, depto: String, rol: String? = nil,
               extra: [String: Any] = [:]) async -> Resp {
    var d: [String: Any] = ["id": id, "nombre": nombre ?? id.capitalized, "rol": rol ?? "Rol de \(id)",
                            "prompt": "Sos \(id).", "departamento": depto]
    for (k, v) in extra { d[k] = v }
    return await llamar(b, "POST", "/api/agentes", body: json(d))
}

/// Los tests de oficinas, agentes, reuniones y biblioteca van todos dentro de este grupo, que corre en serie. Cada test lanza
/// varios `claude` falsos (algunos quedan esperando una «puerta» o un timeout) y, corriendo los ~140 en paralelo junto con el
/// resto de la suite, se juntan >100 procesos a la vez: `RunningProcess.run` gasta ~3 hilos de GCD por proceso y con tantos
/// pierde la salida de los claude (respuestas vacías) o aborta con NSFileHandleOperationException («availableData: unknown
/// error») al cerrar un pipe que otro hilo todavía está leyendo. Ver el reporte de la instancia E.
@Suite("Etapa 2: oficinas, agentes, reuniones y biblioteca", .serialized)
enum Etapa2 {}
