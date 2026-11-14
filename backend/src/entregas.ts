// Entregas: lo que un agente terminó y la persona tiene que revisar (Entregas.swift). Nacen «sin revisar» y pasan a
// «revisada» solo cuando la persona toca «Listo». Este archivo tiene el modelo, la tabla y el registro (lo usan chat,
// tareas y reuniones); las rutas /api/entregas* se portan en el paso 4.
import fs from 'node:fs'
import path from 'node:path'
import type { Avisos } from './avisos.js'
import type { Obj } from './json.js'
import { num, txt, type Fila, type SQLValor } from './sqlite.js'
import type { Store } from './store.js'
import { largo, prefijo } from './validar.js'

export const estadosEntrega = ['sin_revisar', 'revisada', 'cambios']

export type Entrega = {
  id: number
  oficina: string
  /** '' = sin agente (actas de reunión). */
  agente: string
  /** tarea | encargo | reunion | chat | cambios */
  origen: string
  ref: string
  titulo: string
  texto: string
  sid: string
  /** Rutas relativas a la carpeta de la oficina. */
  archivos: string[]
  creada: number
  estado: string
  revisada?: number
  padre?: number
  costo?: number
}

export const iso = (t: number) => new Date(t * 1000).toISOString()

export const TextoEntrega = {
  maxTexto: 100_000,
  resumen(t: string): string {
    const s = unaLinea(t)
    return largo(s) > 280 ? prefijo(s, 279) + '…' : s
  },
  /** Título corto a partir de un pedido de chat. */
  titulo(t: string): string {
    const s = unaLinea(t)
    return largo(s) > 70 ? prefijo(s, 69) + '…' : s
  },
}

/** Líneas unidas con un espacio (sin las vacías), sin espacios en los bordes. */
function unaLinea(t: string): string {
  return t.split(/\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/).filter((x) => x !== '').join(' ').replace(/^[ \t]+|[ \t]+$/g, '')
}

/** Fila para listas (sin el texto completo). */
export function entregaJSON(e: Entrega): Obj {
  return {
    id: e.id, agente: e.agente, origen: e.origen, ref: e.ref, titulo: e.titulo, resumen: TextoEntrega.resumen(e.texto),
    sid: e.sid, archivos: e.archivos, creada: iso(e.creada), estado: e.estado,
    revisada: e.revisada === undefined ? null : iso(e.revisada), padre: e.padre ?? null, costo: e.costo ?? null,
  }
}
export const entregaJSONCompleto = (e: Entrega): Obj => ({ ...entregaJSON(e), texto: e.texto })

/** Qué archivos escritos cuentan para una entrega. */
export const ArchivosEntrega = {
  carpetaEntregables: 'archivos/entregables/',
  /** Notas internas que los agentes tocan seguido: no son trabajo para revisar. */
  ignorados: ['.claude/', 'conocimiento/agentes/'],

  /** Rutas relativas a `carpeta` (con `/`), sin repetir, de las que caen dentro de la oficina. */
  relativos(rutas: string[], carpeta: string): string[] {
    const real = (p: string) => { try { return fs.realpathSync.native(p) } catch { return p } }
    const bases = [...new Set([path.resolve(carpeta), real(carpeta)])].map((b) => (b.endsWith(path.sep) ? b : b + path.sep))
    const out: string[] = []
    for (const r of rutas) {
      const abs = path.isAbsolute(r) ? r : path.join(carpeta, r)
      const cands = [path.resolve(abs), realAunqueFalte(abs)]
      let rel: string | undefined
      for (const c of cands) {
        const b = bases.find((x) => c.startsWith(x))
        if (b) { rel = c.slice(b.length).split(path.sep).join('/'); break }
      }
      if (!rel || rel.split('/').includes('..') || this.ignorados.some((i) => rel!.startsWith(i)) || out.includes(rel)) continue
      out.push(rel)
    }
    return out
  },

  enEntregables(rels: string[]) { return rels.filter((r) => r.startsWith(this.carpetaEntregables)) },
}

function realAunqueFalte(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    const padre = path.dirname(p)
    return padre === p ? p : path.join(realAunqueFalte(padre), path.basename(p))
  }
}

// MARK: - SQLite

const columnas = 'id,oficina,agente,origen,ref,titulo,texto,sid,archivos,creada,estado,revisada,padre,costo'

function deFila(f: Fila): Entrega {
  let archivos: string[] = []
  try {
    const a = JSON.parse(txt(f.archivos))
    if (Array.isArray(a)) archivos = a.filter((x): x is string => typeof x === 'string')
  } catch {}
  const e: Entrega = {
    id: num(f.id), oficina: txt(f.oficina), agente: txt(f.agente), origen: txt(f.origen), ref: txt(f.ref), titulo: txt(f.titulo),
    texto: txt(f.texto), sid: txt(f.sid), archivos, creada: num(f.creada), estado: txt(f.estado),
  }
  if (f.revisada !== null && f.revisada !== undefined) e.revisada = num(f.revisada)
  if (f.padre !== null && f.padre !== undefined) e.padre = num(f.padre)
  if (f.costo !== null && f.costo !== undefined) e.costo = num(f.costo)
  return e
}

export class Entregas {
  constructor(private readonly store: Store, private readonly avisos: Avisos) {
    store.db.exec(`
    CREATE TABLE IF NOT EXISTS entregas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        oficina TEXT NOT NULL,
        agente TEXT NOT NULL DEFAULT '',
        origen TEXT NOT NULL,
        ref TEXT NOT NULL DEFAULT '',
        titulo TEXT NOT NULL,
        texto TEXT NOT NULL DEFAULT '',
        sid TEXT NOT NULL DEFAULT '',
        archivos TEXT NOT NULL DEFAULT '[]',
        creada REAL NOT NULL,
        estado TEXT NOT NULL DEFAULT 'sin_revisar',
        revisada REAL,
        padre INTEGER,
        costo REAL
    );
    CREATE INDEX IF NOT EXISTS entregas_oficina ON entregas(oficina, estado, id);
    `)
  }

  crear(p: { oficina: string; agente: string; origen: string; ref: string; titulo: string; texto: string; sid?: string; archivos?: string[]; padre?: number; costo?: number }): Entrega | undefined {
    const t = largo(p.texto) > TextoEntrega.maxTexto ? prefijo(p.texto, TextoEntrega.maxTexto) : p.texto
    const tit = p.titulo.trim()
    try {
      this.store.db.run('INSERT INTO entregas(oficina,agente,origen,ref,titulo,texto,sid,archivos,creada,padre,costo) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [
        p.oficina, p.agente, p.origen, p.ref, tit === '' ? 'Entrega' : tit, t, p.sid ?? '', JSON.stringify(p.archivos ?? []),
        Date.now() / 1000, p.padre ?? null, p.costo ?? null,
      ])
      const id = num(this.store.db.query('SELECT last_insert_rowid() AS id')[0]?.id)
      return this.una(p.oficina, id)
    } catch {
      return undefined
    }
  }

  una(oficina: string, id: number): Entrega | undefined {
    const f = this.store.db.query(`SELECT ${columnas} FROM entregas WHERE oficina=? AND id=?`, [oficina, id])[0]
    return f ? deFila(f) : undefined
  }

  /** De la más nueva a la más vieja. Filtros opcionales. */
  lista(oficina: string, { estado, agente, origen, limite = 100 }: { estado?: string; agente?: string; origen?: string; limite?: number } = {}): Entrega[] {
    let sql = `SELECT ${columnas} FROM entregas WHERE oficina=?`
    const p: SQLValor[] = [oficina]
    if (estado !== undefined) { sql += ' AND estado=?'; p.push(estado) }
    if (agente !== undefined) { sql += ' AND agente=?'; p.push(agente) }
    if (origen !== undefined) { sql += ' AND origen=?'; p.push(origen) }
    sql += ' ORDER BY id DESC LIMIT ?'
    p.push(Math.max(1, Math.min(limite, 500)))
    return this.store.db.query(sql, p).map(deFila)
  }

  sinRevisar(oficina: string): number {
    return num(this.store.db.query("SELECT COUNT(*) AS n FROM entregas WHERE oficina=? AND estado='sin_revisar'", [oficina])[0]?.n)
  }

  /** Cambia el estado. `revisada` guarda cuándo; volver a `sin_revisar` lo borra. */
  marcar(oficina: string, id: number, estado: string): Entrega | undefined {
    if (!estadosEntrega.includes(estado)) return undefined
    try {
      this.store.db.run('UPDATE entregas SET estado=?, revisada=? WHERE oficina=? AND id=?', [estado, estado === 'revisada' ? Date.now() / 1000 : null, oficina, id])
    } catch {}
    return this.una(oficina, id)
  }

  /** Crea la entrega y avisa a la app nativa («te entregó»). */
  registrar(p: { oficina: string; agente: string; nombre: string; origen: string; ref: string; titulo: string; texto: string; sid?: string; archivos?: string[]; padre?: number; costo?: number }): Entrega | undefined {
    const e = this.crear(p)
    if (!e) return undefined
    this.avisos.emitir({ id: `e${e.id}`, tipo: 'entrega', agente: p.agente, texto: e.titulo, ref: String(e.id), creado: e.creada }, p.nombre)
    return e
  }
}
