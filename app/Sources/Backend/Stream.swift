import Foundation

/// Un evento de `claude -p --output-format stream-json --verbose`, ya reducido a lo que la oficina muestra.
/// Nunca lleva contenido de mensajes ni de archivos: solo nombres de herramientas y un objetivo corto.
/// Formato verificado en docs/aprendizajes.md.
public enum EventoClaude: Sendable, Equatable {
    case inicio(sesion: String)
    case pensando
    case herramienta(nombre: String, objetivo: String?)
    case texto
    case resultado(costo: Double?, error: Bool)
}

/// Recibe los eventos de una corrida, en orden, desde el hilo que lee el pipe.
public typealias Observador = @Sendable (EventoClaude) -> Void

extension EventoClaude {
    /// Eventos de una línea de stream-json (una línea `assistant` puede traer varios bloques). Líneas que no son
    /// JSON o tipos desconocidos (hooks, rate limits) devuelven [].
    public static func parsear(_ linea: String) -> [EventoClaude] {
        guard let d = linea.data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let tipo = o["type"] as? String else { return [] }
        switch tipo {
        case "system":
            if o["subtype"] as? String == "init", let s = o["session_id"] as? String { return [.inicio(sesion: s)] }
            return []
        case "assistant":
            let bloques = ((o["message"] as? [String: Any])?["content"] as? [[String: Any]]) ?? []
            return bloques.compactMap { b in
                switch b["type"] as? String {
                case "thinking": return .pensando
                case "text": return .texto
                case "tool_use":
                    guard let n = b["name"] as? String else { return nil }
                    return .herramienta(nombre: n, objetivo: objetivo(n, b["input"] as? [String: Any] ?? [:]))
                default: return nil
                }
            }
        case "result":
            let costo = (o["total_cost_usd"] as? NSNumber)?.doubleValue
            return [.resultado(costo: costo, error: (o["is_error"] as? Bool) == true)]
        default:
            return []
        }
    }

    /// Objetivo legible y corto de una herramienta: nombre de archivo, patrón, dominio o colega. Sin contenido.
    static func objetivo(_ herramienta: String, _ input: [String: Any]) -> String? {
        func corto(_ s: String) -> String { s.count > 60 ? String(s.prefix(59)) + "…" : s }
        if let p = input["file_path"] as? String ?? input["path"] as? String, !p.isEmpty {
            return corto((p as NSString).lastPathComponent)
        }
        if let p = input["pattern"] as? String, !p.isEmpty { return corto(p) }
        if let u = input["url"] as? String, let h = URL(string: u)?.host { return corto(h) }
        if let q = input["query"] as? String, !q.isEmpty { return corto(q) }
        if let c = input["colega"] as? String, !c.isEmpty { return corto(c) }
        return nil
    }
}

/// Corta bytes en líneas completas (los chunks del pipe pueden partir una línea). No es thread-safe:
/// se usa desde la cola de un único `LectorPipe`.
final class CortadorLineas {
    private var buf = Data()
    private let alLinea: @Sendable (String) -> Void

    init(_ alLinea: @escaping @Sendable (String) -> Void) { self.alLinea = alLinea }

    func agregar(_ d: Data) {
        buf.append(d)
        while let i = buf.firstIndex(of: 0x0A) {
            let linea = buf[buf.startIndex..<i]
            buf.removeSubrange(buf.startIndex...i)
            if !linea.isEmpty { alLinea(String(decoding: linea, as: UTF8.self)) }
        }
    }

    /// Lo que quedó sin `\n` al final.
    func terminar() {
        if !buf.isEmpty { alLinea(String(decoding: buf, as: UTF8.self)); buf.removeAll() }
    }
}

/// Junta el costo de una o varias corridas (el observador corre en otro hilo).
public final class CajaCosto: @unchecked Sendable {
    private let lock = NSLock()
    private var total: Double?
    public init() {}
    public func sumar(_ c: Double?) { guard let c else { return }; lock.lock(); total = (total ?? 0) + c; lock.unlock() }
    public var valor: Double? { lock.lock(); defer { lock.unlock() }; return total }

    /// Observador que suma el costo del `result` y además reenvía todo a `siguiente`.
    public func observador(_ siguiente: Observador? = nil) -> Observador {
        { [self] e in
            if case .resultado(let c, _) = e { sumar(c) }
            siguiente?(e)
        }
    }
}
