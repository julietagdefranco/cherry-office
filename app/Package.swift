// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ProsperaHQ",
    platforms: [.macOS(.v13)],
    targets: [
        // Backend: API en Swift (Router, ClaudeRunner, Store, Config, Permisos). Dueño: instancia B.
        .target(name: "Backend", path: "Sources/Backend"),
        // App: ventana + WKWebView + esquema hq://. Dueño: instancia A.
        .executableTarget(name: "ProsperaHQ", dependencies: ["Backend"], path: "Sources/App"),
        // Tests del backend. Dueño: instancia E.
        .testTarget(name: "BackendTests", dependencies: ["Backend"], path: "Tests/BackendTests"),
    ]
)
