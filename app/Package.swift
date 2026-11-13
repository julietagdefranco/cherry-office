// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Oficina",
    platforms: [.macOS(.v13)],
    targets: [
        // Backend: API en Swift (Router, ClaudeRunner, Store, Config, Permisos). Dueño: instancia B.
        .target(name: "Backend", path: "Sources/Backend"),
        // App: ventana + WKWebView + esquema hq://. Dueño: instancia A.
        .executableTarget(name: "Oficina", dependencies: ["Backend"], path: "Sources/App"),
        // Servidor de desarrollo: la misma API y la interfaz en el navegador (http://localhost:8765), sin compilar la app.
        .executableTarget(name: "oficina-dev", dependencies: ["Backend"], path: "Sources/Dev"),
        // Tests del backend. Dueño: instancia E.
        .testTarget(name: "BackendTests", dependencies: ["Backend"], path: "Tests/BackendTests"),
    ]
)
