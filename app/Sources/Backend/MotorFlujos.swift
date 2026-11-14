import Foundation

/// Motor de flujos (plan §7). Stub: la ola 2 lo completa sin cambiar las firmas.
actor MotorFlujos {
    private let store: Store
    private let runner: ClaudeRunner
    private let oficinas: Oficinas
    private let programador: Programador
    private let log: HQLog
    private let env: [String: String]

    init(store: Store, runner: ClaudeRunner, oficinas: Oficinas, programador: Programador, log: HQLog,
         env: [String: String] = ProcessInfo.processInfo.environment) {
        self.store = store; self.runner = runner; self.oficinas = oficinas; self.programador = programador
        self.log = log; self.env = env
    }

    func preparar() async {}
    func alEntregar(_ e: Entrega, _ ej: Ejecucion?) async {}
    func revisada(_ e: Entrega, _ act: OficinaActiva) async {}
    func alTerminar(_ ej: Ejecucion) async {}
    /// Corridas abiertas para `/api/actividad`.
    func resumenActividad(oficina: String) async -> [[String: Any]] { [] }
}
