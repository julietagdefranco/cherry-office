import Foundation
import Backend

// Servidor de desarrollo: la interfaz de la oficina en el navegador con el backend Swift real.
//
//   cd app && swift run oficina-dev            → http://localhost:8765
//
// Variables: PORT (8765), HQ_DATA_DIR (base y logs; por defecto los de la app), HQ_OFICINAS_DIR, CLAUDE_BIN,
// HQ_CONFIG y las demás de Config. HQ_UI_DIR apunta a otra carpeta `oficina/` (por defecto la del repo).

let env = ProcessInfo.processInfo.environment
let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent()   // app/Sources/Dev
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let ui = env["HQ_UI_DIR"].map { URL(fileURLWithPath: $0) } ?? repo.appendingPathComponent("oficina")
let vendor = repo.appendingPathComponent("app/Resources/vendor")
let puerto = UInt16(env["PORT"] ?? "") ?? 8765

let backend: Backend
do { backend = try Backend.makeDefault() } catch {
    FileHandle.standardError.write(Data("oficina-dev: no pude arrancar el backend: \(error)\n".utf8))
    exit(1)
}
let servidor = ServidorDev(router: backend.router, raizUI: ui, raizVendor: vendor, puerto: puerto)
do { try servidor.arrancar() } catch {
    FileHandle.standardError.write(Data("oficina-dev: no pude escuchar en el puerto \(puerto): \(error)\n".utf8))
    exit(1)
}
print("Oficina (desarrollo) en http://localhost:\(puerto)  ·  datos: \(backend.config.datosDir)  ·  Ctrl+C para salir")

// Ctrl+C / kill: mata los claude en curso y cierra la base antes de salir.
signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
var fuentes: [DispatchSourceSignal] = []
for s in [SIGINT, SIGTERM] {
    let src = DispatchSource.makeSignalSource(signal: s, queue: .main)
    src.setEventHandler {
        servidor.cerrar()
        Task { await backend.shutdown(); exit(0) }
    }
    src.resume()
    fuentes.append(src)
}
dispatchMain()
