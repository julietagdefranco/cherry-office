import Foundation
import os

/// Log de la app: os.Logger + archivo rotativo hq.log (1 MB, 3 copias). Nunca recibe contenido de mensajes.
public final class HQLog: @unchecked Sendable {
    private let logger = Logger(subsystem: "com.oficina.app", category: "backend")
    private let queue = DispatchQueue(label: "hq.log")
    private let path: String?
    private let maxBytes: Int
    private let copias = 3
    private var size = 0
    private var handle: FileHandle?
    private let formatter: DateFormatter

    /// `dir == nil` -> solo os.Logger (útil en tests).
    public init(dir: String?, maxBytes: Int = 1_000_000) {
        self.maxBytes = maxBytes
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        formatter = f
        if let dir {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            path = (dir as NSString).appendingPathComponent("hq.log")
        } else {
            path = nil
        }
    }

    public func info(_ m: String) { escribir("INFO", m); logger.info("\(m, privacy: .public)") }
    public func warn(_ m: String) { escribir("WARNING", m); logger.warning("\(m, privacy: .public)") }
    public func error(_ m: String) { escribir("ERROR", m); logger.error("\(m, privacy: .public)") }

    private func escribir(_ nivel: String, _ m: String) {
        guard let path else { return }
        queue.async { [self] in
            let linea = "\(formatter.string(from: Date())) \(nivel) \(m)\n"
            guard let data = linea.data(using: .utf8) else { return }
            if handle == nil { abrir(path) }
            if size + data.count > maxBytes { rotar(path) }
            handle?.write(data)
            size += data.count
        }
    }

    private func abrir(_ path: String) {
        let fm = FileManager.default
        if !fm.fileExists(atPath: path) { fm.createFile(atPath: path, contents: nil) }
        handle = FileHandle(forWritingAtPath: path)
        if let h = handle {
            size = Int((try? h.seekToEnd()) ?? 0)
        }
    }

    private func rotar(_ path: String) {
        let fm = FileManager.default
        try? handle?.close()
        handle = nil
        try? fm.removeItem(atPath: "\(path).\(copias)")
        var i = copias - 1
        while i >= 1 {
            if fm.fileExists(atPath: "\(path).\(i)") {
                try? fm.moveItem(atPath: "\(path).\(i)", toPath: "\(path).\(i + 1)")
            }
            i -= 1
        }
        try? fm.moveItem(atPath: path, toPath: "\(path).1")
        size = 0
        abrir(path)
    }

    /// Espera a que se vacíe la cola de escritura (tests / cierre).
    public func flush() { queue.sync {} }
}
