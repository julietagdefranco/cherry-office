import AppKit
import ServiceManagement
import Backend

/// Ícono en la barra de menú: la app sigue viva (y corriendo las tareas programadas) con la ventana cerrada.
/// Abrir la oficina, las próximas tareas (se consultan al router en proceso), «Abrir al iniciar sesión» y Salir.
@MainActor
final class BarraMenu: NSObject, NSMenuDelegate {
    private let item: NSStatusItem
    private let router: APIHandler
    private let abrir: () -> Void
    private let menu = NSMenu()
    private let proximas = NSMenuItem(title: "Próximas tareas", action: nil, keyEquivalent: "")
    private let submenu = NSMenu(title: "Próximas tareas")
    private let inicio = NSMenuItem(title: "Abrir al iniciar sesión", action: #selector(alternarInicio(_:)), keyEquivalent: "")
    /// «N entregas sin revisar»: abre la oficina en el panel de entregables. Oculto con 0.
    private let entregas = NSMenuItem(title: "", action: #selector(verEntregas(_:)), keyEquivalent: "")
    private let abrirEntregas: () -> Void
    private static let maxProximas = 5

    init(router: APIHandler, abrir: @escaping () -> Void, abrirEntregas: @escaping () -> Void) {
        self.router = router
        self.abrir = abrir
        self.abrirEntregas = abrirEntregas
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()
        if let b = item.button {
            let img = NSImage(systemSymbolName: "building.2", accessibilityDescription: "Oficina")
            img?.isTemplate = true
            b.image = img
            if img == nil { b.title = "Of." }
            b.toolTip = "Oficina"
        }
        let abrirItem = NSMenuItem(title: "Abrir Oficina", action: #selector(abrirOficina(_:)), keyEquivalent: "")
        abrirItem.target = self
        menu.addItem(abrirItem)
        entregas.target = self
        entregas.isHidden = true
        menu.addItem(entregas)
        proximas.submenu = submenu
        menu.addItem(proximas)
        menu.addItem(.separator())
        inicio.target = self
        menu.addItem(inicio)
        menu.addItem(.separator())
        let salir = NSMenuItem(title: "Salir de Oficina", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        menu.addItem(salir)
        menu.delegate = self
        item.menu = menu
        actualizarInicio()
        Task { await refrescar() }
    }

    func quitar() { NSStatusBar.system.removeStatusItem(item) }

    // MARK: acciones

    @objc private func abrirOficina(_ sender: Any?) { abrir() }
    @objc private func verEntregas(_ sender: Any?) { abrirEntregas() }

    /// Prende o apaga «Abrir al iniciar sesión». Si no se puede registrar (por ejemplo, app sin firmar o sin aprobar),
    /// se avisa sin romper y el checkbox muestra el estado real.
    @objc private func alternarInicio(_ sender: Any?) {
        let s = SMAppService.mainApp
        do {
            if s.status == .enabled || s.status == .requiresApproval { try s.unregister() } else { try s.register() }
        } catch {
            NSLog("Abrir al iniciar sesión: \(error)")
            let a = NSAlert()
            a.messageText = "No pude cambiar «Abrir al iniciar sesión»"
            a.informativeText = "macOS no lo permitió (\(error.localizedDescription)). Podés activarlo a mano en Ajustes del Sistema > General > Ítems de inicio."
            a.addButton(withTitle: "OK")
            a.runModal()
        }
        actualizarInicio()
    }

    private func actualizarInicio() {
        switch SMAppService.mainApp.status {
        case .enabled:
            inicio.state = .on; inicio.toolTip = nil
        case .requiresApproval:
            inicio.state = .mixed
            inicio.toolTip = "Falta aprobarlo en Ajustes del Sistema > General > Ítems de inicio."
        default:
            inicio.state = .off; inicio.toolTip = nil
        }
    }

    // MARK: menú

    func menuWillOpen(_ menu: NSMenu) {
        actualizarInicio()
        Task { await refrescar() }
    }

    private func obtener(_ path: String) async -> [String: Any]? {
        let (status, data) = await router.handle(method: "GET", path: path, query: [:], body: nil)
        guard status == 200 else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// Las próximas `maxProximas` corridas de las tareas activas de la oficina abierta.
    private func refrescar() async {
        let n = (await obtener("/api/actividad")?["entregasSinRevisar"] as? Int) ?? 0
        entregas.title = n == 1 ? "1 entrega sin revisar" : "\(n) entregas sin revisar"
        entregas.isHidden = n == 0
        var lineas: [String] = []
        if let t = await obtener("/api/tareas")?["tareas"] as? [[String: Any]] {
            let ags = (await obtener("/api/agentes")?["agentes"] as? [[String: Any]]) ?? []
            let nombres = Dictionary(ags.compactMap { a -> (String, String)? in
                guard let id = a["id"] as? String, let n = a["nombre"] as? String else { return nil }
                return (id, n)
            }, uniquingKeysWith: { a, _ in a })
            let iso = ISO8601DateFormatter()
            let prox: [(Date, String)] = t.compactMap { x in
                guard (x["activa"] as? Bool) != false, let s = x["proxima"] as? String, let d = iso.date(from: s) else { return nil }
                let ag = (x["agente"] as? String).map { nombres[$0] ?? $0 } ?? ""
                return (d, "\(x["nombre"] as? String ?? "Tarea") (\(ag)) · \(Self.cuando(d))")
            }
            lineas = prox.sorted { $0.0 < $1.0 }.prefix(Self.maxProximas).map(\.1)
        }
        submenu.removeAllItems()
        if lineas.isEmpty {
            let v = NSMenuItem(title: "Sin tareas programadas", action: nil, keyEquivalent: "")
            v.isEnabled = false
            submenu.addItem(v)
        }
        for l in lineas {
            let m = NSMenuItem(title: l, action: #selector(abrirOficina(_:)), keyEquivalent: "")
            m.target = self
            submenu.addItem(m)
        }
    }

    /// «hoy 08:00», «mañana 08:00» o «vie 13 nov 08:00».
    static func cuando(_ d: Date, ahora: Date = Date(), calendario: Calendar = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "es")
        f.timeZone = calendario.timeZone
        f.dateFormat = "HH:mm"
        let hora = f.string(from: d)
        if calendario.isDate(d, inSameDayAs: ahora) { return "hoy " + hora }
        if let m = calendario.date(byAdding: .day, value: 1, to: ahora), calendario.isDate(d, inSameDayAs: m) { return "mañana " + hora }
        f.dateFormat = "EEE d MMM HH:mm"
        return f.string(from: d)
    }
}
