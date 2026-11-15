import AppKit
import WebKit
import Backend

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    private var window: NSWindow!
    private var webView: WKWebView!
    var runtime: Runtime!
    private var handler: HQSchemeHandler!
    private let env = ProcessInfo.processInfo.environment
    private var terminating = false
    private var notificador: Notificador?
    /// Ícono de la barra de menú: mantiene la app (y las tareas programadas) a la vista con la ventana cerrada.
    private var barraMenu: BarraMenu?
    /// Sparkle: busca versiones nuevas al abrir y cada día (nil fuera de una Oficina.app empaquetada).
    private(set) var actualizador: Actualizador?

    func applicationDidFinishLaunching(_ notification: Notification) {
        runtime = Runtime.make()
        actualizador = Actualizador()
        NSApp.mainMenu = MainMenu.build(delegate: self)
        buildWindow()
        notificador = Notificador(webView: webView) { [weak self] in self?.mostrarVentana() }
        notificador?.escuchar(runtime.avisos)
        if env["HQ_SPIKE"] != "1" {
            barraMenu = BarraMenu(router: runtime.router, abrir: { [weak self] in self?.mostrarVentana() }, abrirEntregas: { [weak self] in
                self?.mostrarVentana()
                self?.webView.evaluateJavaScript("window.App && App.Entregables && App.Entregables.abrir()")
            })
        }
        NSApp.activate(ignoringOtherApps: true)
        Task { await boot() }
    }

    // MARK: Ventana

    private func buildWindow() {
        handler = HQSchemeHandler(router: runtime.router, roots: Self.webRoots(env))
        handler.embedded["/__onboarding.html"] = Pages.onboarding
        handler.embedded["/__spike.html"] = Pages.spike

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(handler, forURLScheme: HQSchemeHandler.scheme)
        config.websiteDataStore = .default() // persistente: localStorage del front (hq-*) sobrevive al reinicio
        // con respuesta (macOS 11+): `postMessage` devuelve una Promise; las acciones sin valor contestan nil
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "hq")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground") // evita el flash blanco
        if #available(macOS 13.3, *), env["HQ_INSPECTABLE"] == "1" { webView.isInspectable = true }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Oficina"
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("OficinaMain")
        if !window.setFrameUsingName("OficinaMain") { window.center() }
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(webView)
    }

    /// Dónde buscar los estáticos: bundle, o variables de entorno para correr sin empaquetar.
    static func webRoots(_ env: [String: String]) -> [URL] {
        var roots: [URL] = []
        if let p = env["HQ_WEB_ROOT"] { roots.append(URL(fileURLWithPath: p)) }
        if let p = env["HQ_VENDOR_ROOT"] { roots.append(URL(fileURLWithPath: p)) }
        if let r = Bundle.main.resourceURL?.appendingPathComponent("oficina"),
           FileManager.default.fileExists(atPath: r.path) { roots.append(r) }
        return roots
    }

    private func boot() async {
        let entry: String
        if env["HQ_SPIKE"] == "1" {
            entry = "__spike.html"
        } else if await needsOnboarding() {
            entry = "__onboarding.html"
        } else {
            entry = "index.html"
        }
        webView.load(URLRequest(url: URL(string: "hq://app/\(entry)")!))
    }

    private func estado() async -> [String: Any]? {
        let (status, data) = await runtime.router.handle(method: "GET", path: "/api/estado", query: [:], body: nil)
        guard status == 200 else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func needsOnboarding() async -> Bool {
        guard let e = await estado() else { return true }
        if (e["claude"] as? Bool) != true { return true }
        if (e["auth"] as? Bool) == false { return true }
        return false
    }

    // MARK: Ciclo de vida

    /// Cerrar la ventana no cierra la app: las tareas programadas siguen corriendo (⌘Q o «Salir» en la barra de menú cierran todo).
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Clic en el ícono del Dock: vuelve a mostrar la ventana.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { mostrarVentana() }
        return true
    }

    func mostrarVentana() {
        if window.isMiniaturized { window.deminiaturize(nil) }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating { return .terminateLater }
        terminating = true
        barraMenu?.quitar()
        let rt = runtime!
        Task {
            await rt.shutdown()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    // MARK: Mensajes del WebView (onboarding, spike)

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        if let body = message.body as? [String: Any], ((body["accion"] as? String) ?? (body["action"] as? String)) == "elegirCarpeta" {
            // solo desde nuestras páginas (hq://), nunca desde otro origen
            guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == HQSchemeHandler.scheme else {
                replyHandler(NSNull(), nil); return
            }
            elegirCarpeta(titulo: body["titulo"] as? String, inicio: body["inicio"] as? String,
                          crear: (body["crear"] as? Bool) ?? false) { replyHandler($0 as Any? ?? NSNull(), nil) }
            return
        }
        if let body = message.body as? [String: Any], (body["accion"] as? String) == "elegirArchivo" {
            guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == HQSchemeHandler.scheme else {
                replyHandler(NSNull(), nil); return
            }
            elegirArchivoZip(titulo: body["titulo"] as? String) { replyHandler($0 as Any? ?? NSNull(), nil) }
            return
        }
        userContentController(ucc, didReceive: message)
        replyHandler(nil, nil)
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = (body["accion"] as? String) ?? (body["action"] as? String) else { return }
        switch action {
        case "abrir", "revelar":
            // solo desde nuestras páginas (hq://), nunca desde otro origen
            guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == HQSchemeHandler.scheme else { return }
            let ruta = body["ruta"] as? String
            Task { await manejarAbrir(accion: action, ruta: ruta) }
        case "acerca":
            mostrarAcerca(nil)
        case "insignia":
            notificador?.insignia((body["n"] as? Int) ?? 0)
        case "open":
            if let s = body["url"] as? String, let u = URL(string: s), u.scheme == "https" { NSWorkspace.shared.open(u) }
        case "login":
            Task { await openLoginInTerminal() }
        case "spike":
            guard env["HQ_SPIKE"] == "1" else { return }
            let data = (try? JSONSerialization.data(withJSONObject: body["result"] ?? [:], options: [.prettyPrinted, .sortedKeys])) ?? Data()
            print("[spike] " + (String(data: data, encoding: .utf8) ?? ""))
            fflush(stdout)
            if env["HQ_SPIKE_EXIT"] == "1" { NSApp.terminate(nil) }
        default: break
        }
    }

    /// `claude auth login` suele pedir TTY: se abre Terminal con un .command temporal.
    private func openLoginInTerminal() async {
        guard let path = (await estado())?["claudePath"] as? String, !path.isEmpty else { return }
        let quoted = "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let script = "#!/bin/zsh\nclear\necho 'Iniciá sesión en Claude. Cuando termines, volvé a Oficina.'\n\(quoted) auth login\necho\necho 'Listo. Ya podés cerrar esta ventana.'\n"
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("oficina-login-\(UUID().uuidString).command")
        do {
            try script.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            p.arguments = ["-a", "Terminal", file.path]
            try p.run()
        } catch {
            NSLog("No pude abrir Terminal: \(error)")
        }
    }

    // MARK: Navegación y diálogos JS

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.scheme == HQSchemeHandler.scheme || url.scheme == "about" { return .allow }
        if url.scheme == "https" || url.scheme == "http" || url.scheme == "mailto" { NSWorkspace.shared.open(url) }
        return .cancel
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme != HQSchemeHandler.scheme { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancelar")
        return a.runModal() == .alertFirstButtonReturn
    }

    /// `<input type="file">`: sin este método WKWebView no abre ningún selector y el clic no hace nada
    /// (en el navegador sí anda, por eso solo fallaba en la app). Se muestra como hoja sobre la ventana.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.prompt = "Subir"
        let r: NSApplication.ModalResponse
        if let w = webView.window { r = await panel.beginSheetModal(for: w) } else { r = panel.runModal() }
        return r == .OK ? panel.urls : nil
    }
}
