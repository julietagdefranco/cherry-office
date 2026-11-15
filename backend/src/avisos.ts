// «Te necesita» (Avisos.swift). Dos clases de avisos:
// - guardados: una respuesta lista, un error, una tarea que terminó. Se marcan como vistos.
// - calculados al leer: una reunión que espera, una corrida de flujo que espera, una espera vencida entre agentes, propuestas de la biblioteca. Salen
//   solos cuando se resuelve lo que los causa. Sus tablas las crean los módulos de reuniones, flujos y biblioteca: si
//   todavía no existen, simplemente no aportan avisos.
import type { EventEmitter } from 'node:events'
import type { Obj } from './json.js'
import { num, txt } from './sqlite.js'
import type { Store } from './store.js'
import { largo, prefijo } from './validar.js'

export type Aviso = {
  /** "a<n>" guardado | "reunion:<id>" | "flujo:<corrida>" | "espera:<id>" | "propuestas" | "e<n>" (entrega, solo en el canal) */
  id: string
  /** respuesta | error | tarea | reunion | flujo | espera | propuestas | entrega */
  tipo: string
  agente: string
  texto: string
  ref: string
  creado: number
}

export const avisoJSON = (a: Aviso): Obj => ({ id: a.id, tipo: a.tipo, agente: a.agente, texto: a.texto, ref: a.ref, creado: a.creado })

/** Avisos calculados que aportan otros módulos (flujos, …), en el orden en que se registran. */
export type FuenteAvisos = (store: Store, oficina: string) => Aviso[]

export class Avisos {
  readonly fuentes: FuenteAvisos[] = []

  constructor(private readonly store: Store, private readonly canal: EventEmitter) {
    store.db.exec(`
    CREATE TABLE IF NOT EXISTS avisos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        oficina TEXT NOT NULL,
        tipo TEXT NOT NULL,
        agente TEXT NOT NULL DEFAULT '',
        texto TEXT NOT NULL,
        ref TEXT NOT NULL DEFAULT '',
        creado REAL NOT NULL,
        visto INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS avisos_oficina ON avisos(oficina, visto);
    `)
  }

  /** Avisa a la app nativa (notificación) de un aviso nuevo. */
  emitir(aviso: Aviso, nombre: string) { this.canal.emit('aviso', { aviso, nombre }) }

  /** Crea un aviso. Si ya hay uno sin ver del mismo tipo y agente, lo reemplaza (no se apilan «te respondió»). */
  crear(p: { oficina: string; tipo: string; agente?: string; texto: string; ref?: string }): Aviso | undefined {
    const agente = p.agente ?? ''
    const ref = p.ref ?? ''
    const ahora = Date.now() / 1000
    const db = this.store.db
    try {
      db.run("UPDATE avisos SET visto=1 WHERE oficina=? AND tipo=? AND agente=? AND visto=0 AND agente<>''", [p.oficina, p.tipo, agente])
      db.run('INSERT INTO avisos(oficina,tipo,agente,texto,ref,creado) VALUES(?,?,?,?,?,?)', [p.oficina, p.tipo, agente, p.texto, ref, ahora])
      const id = num(db.query('SELECT last_insert_rowid() AS id')[0]?.id)
      return { id: `a${id}`, tipo: p.tipo, agente, texto: p.texto, ref, creado: ahora }
    } catch {
      return undefined
    }
  }

  /** Marca como vistos: un guardado ("a<n>"), una reunión ("reunion:<id>"), una corrida ("flujo:<n>"), una espera vencida ("espera:<n>"), todos los de un
   *  agente, o todos los de la oficina. */
  vistos(oficina: string, { id, agente }: { id?: string; agente?: string } = {}): number {
    const db = this.store.db
    try {
      if (id?.startsWith('flujo:')) {
        const n = Number(id.slice('flujo:'.length))
        if (!Number.isInteger(n)) return 0
        return this.marcarCorridaVista?.(oficina, n) ? 1 : 0
      }
      if (id?.startsWith('espera:')) {
        const n = Number(id.slice('espera:'.length))
        if (!Number.isInteger(n)) return 0
        return this.marcarEsperaVista?.(oficina, n) ? 1 : 0
      }
      if (id?.startsWith('reunion:')) {
        return db.run("UPDATE reuniones SET vista=1 WHERE oficina=? AND id=? AND estado='esperando'", [oficina, id.slice('reunion:'.length)])
      }
      if (id !== undefined) {
        const n = Number(id.slice(1))
        if (!id.startsWith('a') || !/^\d+$/.test(id.slice(1))) return 0
        return db.run('UPDATE avisos SET visto=1 WHERE oficina=? AND id=?', [oficina, n])
      }
      if (agente !== undefined) return db.run('UPDATE avisos SET visto=1 WHERE oficina=? AND agente=? AND visto=0', [oficina, agente])
      return db.run('UPDATE avisos SET visto=1 WHERE oficina=? AND visto=0', [oficina])
    } catch {
      return 0
    }
  }

  /** Marca vistos los guardados sin ver de un tipo y una ref (p. ej. el «necesita tu parte» de una reunión cuando ya no queda nada). */
  vistosPorRef(oficina: string, tipo: string, ref: string): number {
    try {
      return this.store.db.run('UPDATE avisos SET visto=1 WHERE oficina=? AND tipo=? AND ref=? AND visto=0', [oficina, tipo, ref])
    } catch {
      return 0
    }
  }

  /** Lo pone el módulo de flujos: marca vista una corrida que espera a la persona. */
  marcarCorridaVista?: (oficina: string, id: number) => boolean

  /** Lo pone el módulo de dependencias: marca vista una espera vencida. */
  marcarEsperaVista?: (oficina: string, id: number) => boolean

  /** Pendientes de la oficina, del más viejo al más nuevo: guardados sin ver + calculados. */
  pendientes(oficina: string): Aviso[] {
    const db = this.store.db
    const out: Aviso[] = db.query('SELECT id,tipo,agente,texto,ref,creado FROM avisos WHERE oficina=? AND visto=0 ORDER BY id', [oficina])
      .map((f) => ({ id: `a${num(f.id)}`, tipo: txt(f.tipo), agente: txt(f.agente), texto: txt(f.texto), ref: txt(f.ref), creado: num(f.creado) }))
    try {
      for (const f of db.query("SELECT id,tema,creada FROM reuniones WHERE oficina=? AND estado='esperando' AND vista IS NULL ORDER BY creada", [oficina])) {
        out.push({ id: `reunion:${txt(f.id)}`, tipo: 'reunion', agente: '', texto: `La reunión «${txt(f.tema)}» te espera`, ref: txt(f.id), creado: num(f.creada) })
      }
    } catch {}
    for (const fuente of this.fuentes) {
      try {
        out.push(...fuente(this.store, oficina))
      } catch {}
    }
    try {
      const f = db.query("SELECT COUNT(*) AS n, MIN(creada) AS desde FROM propuestas WHERE oficina=? AND estado='pendiente'", [oficina])[0]
      const n = num(f?.n)
      if (n > 0) {
        out.push({ id: 'propuestas', tipo: 'propuestas', agente: '', ref: '', creado: num(f?.desde),
          texto: n === 1 ? 'Hay 1 propuesta de la biblioteca para revisar' : `Hay ${n} propuestas de la biblioteca para revisar` })
      }
    } catch {}
    return out.sort((a, b) => a.creado - b.creado)
  }
}

export const TextoAviso = {
  respuesta(texto: string): string {
    const t = texto.replace(/\n/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '')
    return largo(t) > 90 ? prefijo(t, 89) + '…' : t
  },
}
