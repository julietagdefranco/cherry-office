import AppKit

enum MainMenu {
    @MainActor static func build(delegate: AppDelegate) -> NSMenu {
        let main = NSMenu()
        func add(_ menu: NSMenu, _ title: String, _ sel: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) {
            let item = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            if !key.isEmpty { item.keyEquivalentModifierMask = mods }
            menu.addItem(item)
        }
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem(); main.addItem(item)
            let m = NSMenu(title: title); item.submenu = m
            return m
        }

        let app = submenu("Oficina")
        let acerca = NSMenuItem(title: "Acerca de Oficina", action: #selector(AppDelegate.mostrarAcerca(_:)), keyEquivalent: "")
        acerca.target = delegate
        app.addItem(acerca)
        if let buscar = delegate.actualizador?.itemDeMenu() { app.addItem(buscar) }
        app.addItem(.separator())
        add(app, "Ocultar Oficina", #selector(NSApplication.hide(_:)), "h")
        add(app, "Ocultar otros", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
        add(app, "Mostrar todo", #selector(NSApplication.unhideAllApplications(_:)))
        app.addItem(.separator())
        add(app, "Salir de Oficina", #selector(NSApplication.terminate(_:)), "q")

        let oficina = submenu("Oficina")
        let abrir = NSMenuItem(title: "Abrir carpeta de la oficina", action: #selector(AppDelegate.abrirCarpetaOficina(_:)), keyEquivalent: "o")
        abrir.keyEquivalentModifierMask = [.command, .shift]
        abrir.target = delegate
        oficina.addItem(abrir)

        let edit = submenu("Edición")
        add(edit, "Deshacer", Selector(("undo:")), "z")
        add(edit, "Rehacer", Selector(("redo:")), "z", [.command, .shift])
        edit.addItem(.separator())
        add(edit, "Cortar", #selector(NSText.cut(_:)), "x")
        add(edit, "Copiar", #selector(NSText.copy(_:)), "c")
        add(edit, "Pegar", #selector(NSText.paste(_:)), "v")
        add(edit, "Seleccionar todo", #selector(NSText.selectAll(_:)), "a")

        let view = submenu("Visualización")
        add(view, "Pantalla completa", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])

        let win = submenu("Ventana")
        add(win, "Minimizar", #selector(NSWindow.performMiniaturize(_:)), "m")
        add(win, "Zoom", #selector(NSWindow.performZoom(_:)))
        win.addItem(.separator())
        add(win, "Cerrar", #selector(NSWindow.performClose(_:)), "w")
        NSApp.windowsMenu = win
        return main
    }
}
