import AppKit
import UserNotifications
import WebKit
import Backend

/// Notificaciones de macOS para los avisos «te necesita» (#2) y la insignia del Dock.
/// Solo notifica si la app no está al frente (si está, alcanza con el faro y el banner de la oficina).
/// Fuera de un .app (binario suelto de `swift build`) no hay `UNUserNotificationCenter`: queda desactivado.
@MainActor
final class Notificador: NSObject, UNUserNotificationCenterDelegate {
    private let disponible: Bool
    private weak var webView: WKWebView?
    private let traerVentana: () -> Void
    private var pedido = false

    init(webView: WKWebView, traerVentana: @escaping () -> Void) {
        self.webView = webView
        self.traerVentana = traerVentana
        disponible = Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app"
        super.init()
        if disponible { UNUserNotificationCenter.current().delegate = self }
    }

    /// Se suscribe al canal del backend (los avisos se crean en hilos del backend).
    func escuchar(_ canal: CanalAvisos?) {
        canal?.alCrear { [weak self] aviso, nombre in
            Task { @MainActor in self?.avisar(aviso, nombre: nombre) }
        }
    }

    func insignia(_ n: Int) {
        NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
    }

    private func avisar(_ a: Aviso, nombre: String) {
        guard disponible, !NSApp.isActive else { return }
        let c = UNUserNotificationCenter.current()
        let enviar = {
            let n = UNMutableNotificationContent()
            n.title = Notificador.titulo(a, nombre: nombre)
            n.body = a.texto
            n.sound = .default
            n.userInfo = ["aviso": a.id]
            c.add(UNNotificationRequest(identifier: a.id, content: n, trigger: nil))
        }
        if pedido { enviar(); return }
        c.requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
            Task { @MainActor in self.pedido = true; if ok { enviar() } }
        }
    }

    static func titulo(_ a: Aviso, nombre: String) -> String {
        switch a.tipo {
        case "respuesta": return "\(nombre) te respondió"
        case "error": return "\(nombre) no pudo responder"
        case "tarea": return "\(nombre) terminó una tarea"
        case "entrega": return a.agente.isEmpty ? "Nueva entrega para revisar" : "\(nombre) te entregó algo"
        default: return "Oficina"
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])  // con la app al frente no se muestra (ya está el banner)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["aviso"] as? String ?? ""
        Task { @MainActor in
            self.traerVentana()
            let lit = (try? JSONSerialization.data(withJSONObject: [id])).flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
            _ = try? await self.webView?.evaluateJavaScript("window.App && App.Avisos && App.Avisos.abrir(\(lit)[0])")
            completionHandler()
        }
    }
}
