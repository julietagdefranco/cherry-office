import Foundation
import Backend

/// Stub del backend para desarrollar/probar el contenedor sin `claude`.
/// Se activa con HQ_STUB_API=1 (o HQ_SPIKE=1). Variables: HQ_STUB_CLAUDE=0 simula claude ausente,
/// HQ_STUB_AUTH=0 simula sin sesión.
struct StubAPI: APIHandler {
    func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data) {
        let env = ProcessInfo.processInfo.environment
        func json(_ o: Any, _ status: Int = 200) -> (status: Int, json: Data) {
            (status, (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{}".utf8))
        }
        switch (method, path) {
        case ("GET", "/api/estado"):
            let claude = env["HQ_STUB_CLAUDE"] != "0"
            let auth = env["HQ_STUB_AUTH"] != "0"
            return json(["app": "prospera-hq", "version": "stub", "claude": claude,
                         "auth": claude ? auth : NSNull(), "claudePath": claude ? "/usr/local/bin/claude" : NSNull(),
                         "agentes": ["betty", "marce"]] as [String: Any])
        case ("GET", "/api/historial"):
            return json(["msgs": [Any]()])
        case ("POST", "/api/chat"):
            let text = body.flatMap { String(data: $0, encoding: .utf8) } ?? "<sin body>"
            return json(["reply": "stub eco (\(body?.count ?? -1) bytes): \(text)"])
        case ("POST", "/api/echo"):
            let text = body.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            return json(["len": body?.count ?? -1, "head": String(text.prefix(40))] as [String: Any])
        default:
            return json(["error": "not found"], 404)
        }
    }
}

/// Lo que la app necesita del backend: router + apagado.
struct Runtime {
    let router: APIHandler
    let shutdown: () async -> Void

    static func make() -> Runtime {
        let env = ProcessInfo.processInfo.environment
        if env["HQ_STUB_API"] == "1" || env["HQ_SPIKE"] == "1" {
            return Runtime(router: StubAPI(), shutdown: {})
        }
        do {
            let b = try Backend.makeDefault()
            return Runtime(router: b.router, shutdown: { await b.shutdown() })
        } catch {
            FileHandle.standardError.write(Data("[hq] Backend no pudo iniciar: \(error)\n".utf8))
            return Runtime(router: FailedAPI(message: "\(error)"), shutdown: {})
        }
    }
}

struct FailedAPI: APIHandler {
    let message: String
    func handle(method: String, path: String, query: [String: String], body: Data?) async -> (status: Int, json: Data) {
        let o = ["error": "El backend no pudo iniciar: \(message)"]
        return (500, (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{}".utf8))
    }
}
