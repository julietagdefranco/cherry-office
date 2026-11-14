import AppKit
import UniformTypeIdentifiers
import Foundation

/// Abrir archivos de la oficina en su aplicación nativa (Finder, Preview, Pages...) desde el front.
/// El front manda `window.webkit.messageHandlers.hq.postMessage({accion: 'abrir' | 'revelar', ruta})`; acá se valida que la
/// ruta, ya con los enlaces simbólicos resueltos, esté dentro de la carpeta de la oficina activa o de una carpeta vinculada.
enum AbrirArchivo {
    /// Tipos que ejecutan código: nunca se abren desde la oficina (un agente o una carpeta vinculada podría traer uno).
    static let extensionesBloqueadas: Set<String> = [
        "app", "command", "sh", "zsh", "bash", "csh", "tcsh", "ksh", "pkg", "mpkg", "dmg", "scpt", "scptd", "applescript",
        "workflow", "action", "terminal", "tool", "jar", "exe", "bat", "cmd", "msi", "pl", "py", "rb", "wflow", "osax", "prefpane",
    ]

    static func normalizar(_ ruta: String) -> URL {
        URL(fileURLWithPath: ruta).standardizedFileURL.resolvingSymlinksInPath()
    }

    /// La ruta resuelta si existe y cae dentro de alguna de las `bases`; nil si no.
    static func resolver(_ ruta: String, bases: [String]) -> URL? {
        guard ruta.hasPrefix("/"), !ruta.contains("\0") else { return nil }
        let url = normalizar(ruta)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        for b in bases where b.hasPrefix("/") {
            let base = normalizar(b).path
            if base == "/" { continue }
            if url.path == base || url.path.hasPrefix(base + "/") { return url }
        }
        return nil
    }

    /// true si abrirla ejecutaría código (aplicaciones, scripts, instaladores, archivos con permiso de ejecución).
    static func ejecutable(_ url: URL) -> Bool {
        if extensionesBloqueadas.contains(url.pathExtension.lowercased()) { return true }
        var esDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &esDir), !esDir.boolValue {
            return FileManager.default.isExecutableFile(atPath: url.path)
        }
        return false
    }
}

extension AppDelegate {
    /// Carpeta de la oficina activa y carpetas vinculadas (consulta al backend, que es la fuente de verdad).
    func basesPermitidas() async -> (oficina: String?, bases: [String]) {
        var oficina: String?
        var bases: [String] = []
        let (s1, d1) = await runtime.router.handle(method: "GET", path: "/api/estado", query: [:], body: nil)
        if s1 == 200, let e = (try? JSONSerialization.jsonObject(with: d1)) as? [String: Any],
           let o = e["oficina"] as? [String: Any], let c = o["carpeta"] as? String, !c.isEmpty {
            oficina = c; bases.append(c)
        }
        if oficina != nil {
            let (s2, d2) = await runtime.router.handle(method: "GET", path: "/api/vinculos", query: [:], body: nil)
            if s2 == 200, let j = (try? JSONSerialization.jsonObject(with: d2)) as? [String: Any],
               let vs = j["vinculos"] as? [[String: Any]] {
                for v in vs { if let r = v["ruta"] as? String { bases.append(r) } }
            }
        }
        return (oficina, bases)
    }

    /// `abrir`: abre el archivo con su aplicación. `revelar`: lo muestra en Finder (sin ruta: la carpeta de la oficina).
    func manejarAbrir(accion: String, ruta: String?) async {
        // el .zip de una oficina exportada se puede mostrar en Finder aunque esté fuera de la oficina (solo mostrarlo)
        if accion == "revelar", let r = ruta, r.hasPrefix("/"), !r.contains("\0"), r.hasSuffix(".oficina.zip") {
            let url = AbrirArchivo.normalizar(r)
            var esDir: ObjCBool = false
            if url.path.hasSuffix(".oficina.zip"), FileManager.default.fileExists(atPath: url.path, isDirectory: &esDir), !esDir.boolValue {
                NSWorkspace.shared.activateFileViewerSelecting([url])
                return
            }
        }
        let (oficina, bases) = await basesPermitidas()
        guard let oficina else { NSSound.beep(); return }
        let destino = (ruta?.isEmpty == false) ? ruta! : oficina
        guard let url = AbrirArchivo.resolver(destino, bases: bases) else {
            NSLog("Oficina: ruta fuera de la oficina y de las carpetas vinculadas: \(destino)")
            NSSound.beep(); return
        }
        var esDir: ObjCBool = false
        FileManager.default.fileExists(atPath: url.path, isDirectory: &esDir)
        if accion == "revelar" {
            if esDir.boolValue { NSWorkspace.shared.open(url) } else { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            return
        }
        if AbrirArchivo.ejecutable(url) { NSSound.beep(); return }
        NSWorkspace.shared.open(url)
    }

    /// `elegirCarpeta`: selector nativo de carpetas (NSOpenPanel). Solo carpetas, sin archivos; `crear` permite «Nueva carpeta».
    /// Llama a `fin` con la ruta elegida, o nil si se cancela. (No se puede probar sin clicar el diálogo: ver app/README.md.)
    func elegirCarpeta(titulo: String?, inicio: String?, crear: Bool, fin: @escaping (String?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = crear
        panel.prompt = "Elegir"
        if let t = titulo, !t.isEmpty { panel.message = String(t.prefix(200)) }
        if let i = inicio, i.hasPrefix("/"), !i.contains("\0") {
            var esDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: i, isDirectory: &esDir), esDir.boolValue { panel.directoryURL = URL(fileURLWithPath: i) }
        }
        let resultado: (NSApplication.ModalResponse) -> Void = { r in fin(r == .OK ? panel.url?.path : nil) }
        if let w = NSApp.keyWindow ?? NSApp.mainWindow { panel.beginSheetModal(for: w, completionHandler: resultado) }
        else { panel.begin(completionHandler: resultado) }
    }

    /// `elegirArchivo`: selector nativo de un archivo .zip (para importar una oficina exportada). Llama a `fin` con la ruta o nil.
    func elegirArchivoZip(titulo: String?, fin: @escaping (String?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.zip]
        panel.prompt = "Importar"
        if let t = titulo, !t.isEmpty { panel.message = String(t.prefix(200)) }
        let resultado: (NSApplication.ModalResponse) -> Void = { r in fin(r == .OK ? panel.url?.path : nil) }
        if let w = NSApp.keyWindow ?? NSApp.mainWindow { panel.beginSheetModal(for: w, completionHandler: resultado) }
        else { panel.begin(completionHandler: resultado) }
    }

    @objc func abrirCarpetaOficina(_ sender: Any?) {
        Task { await manejarAbrir(accion: "revelar", ruta: nil) }
    }

    /// «Acerca de Oficina»: versión y créditos de lo que lleva dentro la app.
    @objc func mostrarAcerca(_ sender: Any?) {
        let cuerpo = NSMutableAttributedString()
        let normal: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.labelColor]
        let negrita: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: 11), .foregroundColor: NSColor.labelColor]
        func linea(_ t: String, _ a: [NSAttributedString.Key: Any]) { cuerpo.append(NSAttributedString(string: t + "\n", attributes: a)) }
        linea("Tu oficina de agentes de Claude.", normal)
        linea("", normal)
        linea("Créditos", negrita)
        linea("Piezas LEGO en 3D: LDraw parts library (LDraw.org), licencia CC BY 4.0.", normal)
        linea("three.js: licencia MIT.", normal)
        linea("Tipografía Poppins: SIL Open Font License 1.1.", normal)
        linea("", normal)
        linea("LEGO® es una marca registrada de LEGO Group. Este proyecto es independiente y no está afiliado, patrocinado ni respaldado por LEGO Group.", normal)
        NSApp.orderFrontStandardAboutPanel(options: [.credits: cuerpo])
        NSApp.activate(ignoringOtherApps: true)
    }
}
