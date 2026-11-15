import AppKit
import Sparkle

/// Actualizaciones automáticas con Sparkle 2.
/// El feed (`SUFeedURL` en Info.plist) es el appcast.xml de la última release publicada de GitHub: los borradores no
/// cuentan, así que publicar la release es lo que la manda a todos. Cada actualización viene firmada con la clave
/// EdDSA del proyecto (`SUPublicEDKey`), que reemplaza a la firma Developer ID que la app no tiene.
@MainActor
final class Actualizador: NSObject {
    private let controlador: SPUStandardUpdaterController?

    override init() {
        // Solo dentro de una Oficina.app armada por build.sh (con `swift run` no hay bundle ni Info.plist).
        let enBundle = Bundle.main.bundleURL.pathExtension == "app"
            && Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil
            && ProcessInfo.processInfo.environment["HQ_SIN_ACTUALIZACIONES"] != "1"
        controlador = enBundle
            ? SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
            : nil
        super.init()
    }

    var disponible: Bool { controlador != nil }

    /// Ítem «Buscar actualizaciones…» (se deshabilita solo mientras Sparkle ya está buscando).
    func itemDeMenu() -> NSMenuItem? {
        guard let controlador else { return nil }
        let item = NSMenuItem(title: "Buscar actualizaciones…",
                              action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
        item.target = controlador
        return item
    }
}
