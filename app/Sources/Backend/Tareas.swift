import Foundation

// Tareas programadas por agente (Fase 5): modelo en `oficina.json` (`tareas`), validación y lógica pura de horarios.
// Misma lógica que tools/hq_tareas.py (modo desarrollo): si cambia una, cambia la otra.

// MARK: - modelo

/// Una consigna que un agente corre solo, en ciertos días a cierta hora (en la zona de la tarea).
public struct TareaProgramada: Codable, Sendable, Equatable {
    public var id: String
    public var agente: String
    public var nombre: String
    public var consigna: String
    /// 1 = lunes … 7 = domingo (ISO).
    public var dias: [Int]
    /// "HH:MM" (24 h).
    public var hora: String
    /// Zona IANA (p. ej. "America/Argentina/Buenos_Aires"). nil = la del sistema.
    public var zona: String?
    public var activa: Bool
    /// Fecha de creación (ISO 8601, UTC).
    public var creada: String?
    /// "A partir de": una corrida anterior a esta fecha no se pone al día (se fija al crear, al reactivar y al cambiar el horario,
    /// para que una tarea nueva o movida no dispare enseguida la corrida de hoy que ya pasó). ISO 8601, UTC.
    public var desde: String?

    public init(id: String, agente: String, nombre: String, consigna: String, dias: [Int], hora: String,
                zona: String? = nil, activa: Bool = true, creada: String? = nil, desde: String? = nil) {
        self.id = id; self.agente = agente; self.nombre = nombre; self.consigna = consigna; self.dias = dias
        self.hora = hora; self.zona = zona; self.activa = activa; self.creada = creada; self.desde = desde
    }

    enum CodingKeys: String, CodingKey { case id, agente, nombre, consigna, dias, hora, zona, activa, creada, desde }

    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        agente = try c.decode(String.self, forKey: .agente)
        nombre = try c.decodeIfPresent(String.self, forKey: .nombre) ?? ""
        consigna = try c.decodeIfPresent(String.self, forKey: .consigna) ?? ""
        dias = try c.decodeIfPresent([Int].self, forKey: .dias) ?? []
        hora = try c.decodeIfPresent(String.self, forKey: .hora) ?? ""
        zona = try c.decodeIfPresent(String.self, forKey: .zona)
        activa = try c.decodeIfPresent(Bool.self, forKey: .activa) ?? true
        creada = try c.decodeIfPresent(String.self, forKey: .creada)
        desde = try c.decodeIfPresent(String.self, forKey: .desde)
    }

    /// Zona efectiva: la de la tarea, o la del sistema si no tiene (o no se reconoce).
    public func zonaEfectiva(sistema: TimeZone = .current) -> TimeZone {
        zona.flatMap { TimeZone(identifier: $0) } ?? sistema
    }

    /// Instante a partir del cual cuenta la tarea (el más reciente entre `creada` y `desde`).
    public var fechaInicio: Date? {
        [creada, desde].compactMap { $0.flatMap(Programacion.fecha) }.max()
    }

    /// JSON de la API (la zona siempre viene resuelta).
    public func json(sistema: TimeZone = .current) -> [String: Any] {
        var o: [String: Any] = ["id": id, "agente": agente, "nombre": nombre, "consigna": consigna, "dias": dias,
                                "hora": hora, "zona": zona ?? sistema.identifier, "activa": activa]
        if let creada { o["creada"] = creada }
        return o
    }
}

// MARK: - validación

public enum ValidarTareas {
    public static let maxTareas = 50
    public static let maxConsigna = 4000
    public static let maxNombre = 80

    /// "HH:MM" estricto (dos dígitos y dos dígitos, 00:00–23:59) -> (hora, minuto).
    public static func hora(_ s: String) -> (Int, Int)? { Programacion.horaMinuto(s) }

    public static func zonaValida(_ s: String) -> Bool { !s.isEmpty && TimeZone(identifier: s) != nil }

    /// Reglas de `tareas` dentro de una oficina: id slug único, agente existente (solo exigido a las activas: al despedir a un
    /// agente sus tareas quedan desactivadas y se conservan), días 1…7 sin repetir y no vacíos, hora, zona, consigna y nombre.
    public static func validar(_ o: Oficina) throws {
        let ts = o.tareas ?? []
        guard ts.count <= maxTareas else { throw ErrorAPI(400, "Máximo \(maxTareas) tareas programadas.") }
        var ids = Set<String>()
        for t in ts {
            guard Slug.valido(t.id), ids.insert(t.id).inserted else { throw ErrorAPI(400, "Tarea con id inválido o repetido: \(t.id).") }
            guard Slug.valido(t.agente) else { throw ErrorAPI(400, "La tarea \(t.id) tiene un agente inválido.") }
            if t.activa, o.agente(t.agente) == nil { throw ErrorAPI(400, "La tarea \(t.id) es de un agente que no existe (\(t.agente)).") }
            let n = t.nombre.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !n.isEmpty, n.count <= maxNombre else { throw ErrorAPI(400, "La tarea \(t.id) necesita un nombre (hasta \(maxNombre) caracteres).") }
            let c = t.consigna.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !c.isEmpty, c.count <= maxConsigna else { throw ErrorAPI(400, "La consigna de la tarea \(t.id) tiene que tener entre 1 y \(maxConsigna) caracteres.") }
            guard !t.dias.isEmpty, t.dias.allSatisfy({ (1...7).contains($0) }), Set(t.dias).count == t.dias.count else {
                throw ErrorAPI(400, "Los días de la tarea \(t.id) tienen que ser números del 1 (lunes) al 7 (domingo), sin repetir y al menos uno.")
            }
            guard hora(t.hora) != nil else { throw ErrorAPI(400, "La hora de la tarea \(t.id) tiene que ser HH:MM (por ejemplo 08:00).") }
            if let z = t.zona, !zonaValida(z) { throw ErrorAPI(400, "La zona horaria de la tarea \(t.id) no existe: \(z).") }
        }
    }
}

// MARK: - lógica pura de horarios

/// Cuándo le toca correr a una tarea. Sin estado ni reloj: `ahora`, el calendario y la zona del sistema entran por parámetro.
public enum Programacion {
    /// Una corrida perdida (app cerrada o dormida) se pone al día si pasaron menos de esto desde su horario.
    public static let ventanaPuestaAlDia: TimeInterval = 12 * 3600

    public static func horaMinuto(_ s: String) -> (Int, Int)? {
        let u = Array(s.utf8)
        func dig(_ c: UInt8) -> Int? { (c >= 48 && c <= 57) ? Int(c) - 48 : nil }
        guard u.count == 5, u[2] == UInt8(ascii: ":"), let a = dig(u[0]), let b = dig(u[1]), let c = dig(u[3]), let d = dig(u[4]) else { return nil }
        let h = a * 10 + b, m = c * 10 + d
        return h < 24 && m < 60 ? (h, m) : nil
    }

    private static let formato: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let formatoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// ISO 8601 en UTC con segundos (`2026-11-13T11:00:00Z`).
    public static func iso(_ d: Date) -> String { formato.string(from: d) }
    public static func fecha(_ s: String) -> Date? { formato.date(from: s) ?? formatoFrac.date(from: s) }

    /// Calendario gregoriano en la zona de la tarea (parte de `base`, que se inyecta en los tests).
    static func calendario(_ t: TareaProgramada, base: Calendar, sistema: TimeZone) -> Calendar {
        var c = base
        c.timeZone = t.zonaEfectiva(sistema: sistema)
        return c
    }

    /// Lunes = 1 … domingo = 7.
    static func diaISO(_ d: Date, _ cal: Calendar) -> Int { (cal.component(.weekday, from: d) + 5) % 7 + 1 }

    /// El horario de la tarea en el día calendario de `dia` (en la zona del calendario), sin mirar si ese día está marcado.
    /// Si la hora no existe ese día (salto de DST) Calendar la corre hacia adelante; si existe dos veces, toma la primera.
    static func horario(_ t: TareaProgramada, enElDiaDe dia: Date, _ cal: Calendar) -> Date? {
        guard let (h, m) = horaMinuto(t.hora) else { return nil }
        var comp = cal.dateComponents([.year, .month, .day], from: dia)
        comp.hour = h; comp.minute = m; comp.second = 0
        return cal.date(from: comp)
    }

    /// Horario del día `offset` (0 = el día de `ref`, +1 = mañana, -1 = ayer...).
    private static func dia(_ ref: Date, _ offset: Int, _ cal: Calendar) -> Date? { cal.date(byAdding: .day, value: offset, to: ref) }

    /// Próxima corrida estrictamente posterior a `desde`, o nil si no hay (tarea sin días válidos).
    public static func proxima(_ t: TareaProgramada, desde: Date, calendario base: Calendar = Calendar(identifier: .gregorian),
                               sistema: TimeZone = .current) -> Date? {
        let cal = calendario(t, base: base, sistema: sistema)
        for i in 0...8 {
            guard let d = dia(desde, i, cal), t.dias.contains(diaISO(d, cal)), let c = horario(t, enElDiaDe: d, cal), c > desde else { continue }
            return c
        }
        return nil
    }

    /// Último horario marcado que ya pasó (≤ `hasta`), buscando hasta una semana atrás.
    public static func anterior(_ t: TareaProgramada, hasta: Date, calendario base: Calendar = Calendar(identifier: .gregorian),
                                sistema: TimeZone = .current) -> Date? {
        let cal = calendario(t, base: base, sistema: sistema)
        for i in 0...8 {
            guard let d = dia(hasta, -i, cal), t.dias.contains(diaISO(d, cal)), let c = horario(t, enElDiaDe: d, cal), c <= hasta else { continue }
            return c
        }
        return nil
    }

    /// ¿Corre ahora? Devuelve el horario programado que hay que correr, o nil.
    /// - Corre el último horario marcado que ya pasó (en el horario de su zona, en los días marcados);
    /// - nunca dos veces el mismo: si `ultimaProgramada` (la última que se corrió) es igual o posterior, no;
    /// - si la app estuvo cerrada o dormida, se pone al día UNA vez si pasaron menos de 12 h desde ese horario;
    /// - una corrida anterior a la creación de la tarea (o a su último cambio de horario) no cuenta.
    public static func debeCorrer(_ t: TareaProgramada, ahora: Date, ultimaProgramada: Date?,
                                  calendario base: Calendar = Calendar(identifier: .gregorian), sistema: TimeZone = .current) -> Date? {
        guard t.activa, let p = anterior(t, hasta: ahora, calendario: base, sistema: sistema) else { return nil }
        if let u = ultimaProgramada, u >= p { return nil }
        if ahora.timeIntervalSince(p) >= ventanaPuestaAlDia { return nil }
        if let inicio = t.fechaInicio, inicio > p { return nil }
        return p
    }
}
