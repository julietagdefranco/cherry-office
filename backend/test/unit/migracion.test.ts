// Port de app/Tests/BackendTests/MigracionTests.swift: importación de los datos del server Python (sin servidor).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Config } from '../../src/config.js'
import { HQLog } from '../../src/log.js'
import { claveMigracion, codificarCarpeta, ejecutarMigracion } from '../../src/migracion.js'
import { SQLiteDB } from '../../src/sqlite.js'
import { Store } from '../../src/store.js'

const U = {
  a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  c: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3', d: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
}

const abiertos: Store[] = []
const tmps: string[] = []
afterEach(() => {
  for (const s of abiertos.splice(0)) s.close()
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

class Sb {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')))
  readonly home = path.join(this.root, 'home')
  readonly proyecto = path.join(this.home, 'Próspera')
  readonly datos = path.join(this.root, 'datos')
  constructor() { tmps.push(this.root); fs.mkdirSync(this.home, { recursive: true }) }

  /** Carpeta legacy temporal (como ~/Próspera HQ/oficina del server Python). */
  legacy(sesiones?: Record<string, unknown>): string {
    const d = path.join(this.root, 'legacy', 'oficina')
    fs.mkdirSync(path.join(d, '.datos'), { recursive: true })
    if (sesiones) fs.writeFileSync(path.join(d, '.sesiones.json'), JSON.stringify(sesiones))
    return d
  }

  /** hq.db viejo de Python: sesiones(sid,agente,activa,creada) y mensajes(sid,r,t,e,ts). */
  baseVieja(ruta: string, sesiones: [string, string, number, number][], mensajes: [string, string, string, number, number][]) {
    const db = new SQLiteDB(ruta)
    db.exec(`
      CREATE TABLE sesiones (sid TEXT PRIMARY KEY, agente TEXT NOT NULL, activa INTEGER NOT NULL DEFAULT 0, creada REAL NOT NULL, extra TEXT);
      CREATE TABLE mensajes (id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, r TEXT NOT NULL, t TEXT NOT NULL, e INTEGER NOT NULL DEFAULT 0, ts REAL NOT NULL);`)
    for (const s of sesiones) db.run('INSERT INTO sesiones(sid,agente,activa,creada) VALUES(?,?,?,?)', s)
    for (const m of mensajes) db.run('INSERT INTO mensajes(sid,r,t,e,ts) VALUES(?,?,?,?,?)', m)
    db.close()
  }

  transcript(sid: string, lineas: string[], carpeta?: string) {
    const dir = path.join(this.home, '.claude', 'projects', carpeta ?? codificarCarpeta(this.proyecto))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lineas.join('\n') + '\n')
  }

  config(legacyDir?: string): Config {
    const c = new Config(this.home)
    c.proyecto = this.proyecto
    c.legacyDirs = [legacyDir ?? path.join(this.root, 'no-existe')]
    return c
  }

  store(): Store {
    const s = new Store(path.join(this.datos, 'hq.db'))
    abiertos.push(s)
    return s
  }
}

const correr = (s: Store, c: Config, env: NodeJS.ProcessEnv = {}) => ejecutarMigracion({ store: s, config: c, log: new HQLog(), env })

describe('.sesiones.json', () => {
  test('importa sesiones activas, en minúsculas; descarta inválidas', async () => {
    const sb = new Sb()
    const d = sb.legacy({ 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA': 'betty', [U.b]: 'marce', 'no-uuid': 'betty', [U.c]: '', [U.d]: 'sofia' })
    const s = sb.store()
    const r = await correr(s, sb.config(d))
    expect(r.hecha && !r.yaHabiaCorrido).toBe(true)
    expect([r.sesiones, r.mensajes]).toEqual([3, 0])
    expect(s.agenteDe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe('betty')
    expect(s.estaActiva(U.b)).toBe(true)
    expect(s.agenteDe(U.c)).toBeUndefined()
    expect(s.agenteDe('no-uuid')).toBeUndefined()
    expect(s.meta(claveMigracion)).toBeDefined()
  })

  test('corrupto o con tipos raros no rompe la migración', async () => {
    const sb = new Sb()
    const d = sb.legacy()
    fs.writeFileSync(path.join(d, '.sesiones.json'), '{ esto no es json')
    const r = await correr(sb.store(), sb.config(d))
    expect(r.hecha && r.sesiones === 0).toBe(true)
    fs.writeFileSync(path.join(d, '.sesiones.json'), JSON.stringify({ [U.a]: 5, [U.b]: ['x'], [U.c]: 'betty' }))
    const sb2 = new Sb()
    const s2 = sb2.store()
    const r2 = await correr(s2, sb2.config(d))
    expect(r2.sesiones).toBe(1)
    expect(s2.agenteDe(U.c)).toBe('betty')
  })
})

describe('hq.db viejo', () => {
  test('sesiones y mensajes con flag de error, en orden', async () => {
    const sb = new Sb()
    const d = sb.legacy()
    sb.baseVieja(path.join(d, '.datos', 'hq.db'),
      [[U.a, 'betty', 1, 10], [U.b, 'marce', 0, 20], ['basura', 'betty', 1, 1], [U.c, '', 1, 1]],
      [[U.a, 'u', 'hola', 0, 11], [U.a, 'a', 'fallo', 1, 12], [U.a, 'u', 'chau', 0, 13], [U.b, 'u', 'x', 0, 21]])
    const s = sb.store()
    const r = await correr(s, sb.config(d))
    expect(r.hecha).toBe(true)
    expect([r.sesiones, r.mensajes]).toEqual([2, 4])
    expect(s.estaActiva(U.a)).toBe(true)
    expect(s.estaActiva(U.b)).toBe(false)
    expect(s.mensajes(U.a)).toEqual([{ r: 'u', t: 'hola', e: false }, { r: 'a', t: 'fallo', e: true }, { r: 'u', t: 'chau', e: false }])
    expect(s.agenteDe(U.c)).toBeUndefined()
    expect(s.agenteDe('basura')).toBeUndefined()
  })

  test('hq.db viejo + .sesiones.json: se combinan sin duplicar sesiones', async () => {
    const sb = new Sb()
    const d = sb.legacy({ [U.a]: 'betty', [U.b]: 'marce' })
    sb.baseVieja(path.join(d, '.datos', 'hq.db'), [[U.a, 'betty', 1, 10], [U.c, 'sofia', 1, 30]], [[U.a, 'u', 'hola', 0, 11]])
    const r = await correr(sb.store(), sb.config(d))
    expect([r.sesiones, r.mensajes]).toEqual([3, 1])
  })

  test('ilegible (no es SQLite) se ignora', async () => {
    const sb = new Sb()
    const d = sb.legacy({ [U.a]: 'betty' })
    fs.writeFileSync(path.join(d, '.datos', 'hq.db'), 'no soy sqlite')
    const r = await correr(sb.store(), sb.config(d))
    expect([r.sesiones, r.mensajes]).toEqual([1, 0])
  })
})

describe('transcripts', () => {
  test('.jsonl sintético: un turno por mensaje de usuario, última respuesta del asistente, ignora ruido', async () => {
    const sb = new Sb()
    const d = sb.legacy({ [U.a]: 'betty' })
    sb.transcript(U.a, [
      '{"type":"summary","summary":"x"}',
      '{"type":"user","timestamp":"2025-03-01T10:00:00.000Z","message":{"role":"user","content":"Hola Betty"}}',
      '{"type":"assistant","timestamp":"2025-03-01T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Pensando..."},{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"datos"}]}}',
      '{"type":"assistant","timestamp":"2025-03-01T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Respuesta final 1"}]}}',
      '{"type":"user","isSidechain":true,"message":{"role":"user","content":"subagente"}}',
      '{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"sub-respuesta"}]}}',
      '{"type":"user","isMeta":true,"message":{"role":"user","content":"meta"}}',
      '{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}',
      '{"type":"user","message":{"role":"user","content":"<system-reminder>x</system-reminder>"}}',
      'esta línea está rota {',
      '{"type":"user","timestamp":"2025-03-01T11:00:00Z","message":{"role":"user","content":[{"type":"text","text":"Segunda pregunta"}]}}',
      '{"type":"assistant","timestamp":"2025-03-01T11:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"Respuesta final 2"}]}}',
      '{"type":"user","timestamp":"2025-03-01T12:00:00Z","message":{"role":"user","content":"Sin respuesta todavía"}}',
    ])
    const s = sb.store()
    const r = await correr(s, sb.config(d))
    expect(r.hecha).toBe(true)
    expect([r.sesiones, r.mensajes, r.desdeTranscripts]).toEqual([1, 0, 5])
    expect(s.mensajes(U.a).map((m) => [m.r, m.t])).toEqual([
      ['u', 'Hola Betty'], ['a', 'Respuesta final 1'], ['u', 'Segunda pregunta'], ['a', 'Respuesta final 2'], ['u', 'Sin respuesta todavía'],
    ])
    // las fechas del transcript se conservan
    const ts = s.db.query('SELECT ts FROM mensajes WHERE sid=? ORDER BY id', [U.a]).map((f) => Number(f.ts))
    expect(ts[0]).toBe(Date.parse('2025-03-01T10:00:00.000Z') / 1000)
    expect(ts[1]).toBe(Date.parse('2025-03-01T10:00:05.000Z') / 1000)
  })

  test('se prefiere la carpeta codificada; si no, cualquier carpeta de projects que lo tenga', async () => {
    const sb = new Sb()
    const d = sb.legacy({ [U.a]: 'betty' })
    sb.transcript(U.a, [
      '{"type":"user","message":{"role":"user","content":"en otra carpeta"}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
    ], '-otra-codificacion')
    const s = sb.store()
    const r = await correr(s, sb.config(d))
    expect(r.desdeTranscripts).toBe(2)
    expect(s.mensajes(U.a).map((m) => m.t)).toEqual(['en otra carpeta', 'ok'])
  })

  test('no se usa si la sesión ya trajo mensajes de hq.db', async () => {
    const sb = new Sb()
    const d = sb.legacy()
    sb.baseVieja(path.join(d, '.datos', 'hq.db'), [[U.a, 'betty', 1, 1], [U.b, 'marce', 1, 1]], [[U.a, 'u', 'de la base', 0, 1]])
    for (const sid of [U.a, U.b]) {
      sb.transcript(sid, [
        '{"type":"user","message":{"role":"user","content":"del transcript"}}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"resp"}]}}',
      ])
    }
    const s = sb.store()
    const r = await correr(s, sb.config(d))
    expect(r.desdeTranscripts).toBe(2)
    expect(s.mensajes(U.a).map((m) => m.t)).toEqual(['de la base'])
    expect(s.mensajes(U.b).map((m) => m.t)).toEqual(['del transcript', 'resp'])
  })

  test('inexistente o vacío: la sesión se importa sin mensajes y no falla', async () => {
    const sb = new Sb()
    const d = sb.legacy({ [U.a]: 'betty', [U.b]: 'marce' })
    sb.transcript(U.b, [])
    const s = sb.store()
    const r = await correr(s, sb.config(d))
    expect([r.sesiones, r.desdeTranscripts]).toEqual([2, 0])
    expect(s.cuentaMensajes(U.a)).toBe(0)
  })

  test("codificar: todo lo que no es [A-Za-z0-9] pasa a '-'", () => {
    expect(codificarCarpeta('/Users/a b/Próspera')).toBe('-Users-a-b-Pr-spera')
    expect(codificarCarpeta('/x/y_z.w')).toBe('-x-y-z-w')
  })
})

describe('idempotencia y seguridad', () => {
  test('la segunda corrida no hace nada aunque haya datos nuevos en el origen', async () => {
    const sb = new Sb()
    const d = sb.legacy({ [U.a]: 'betty' })
    const s = sb.store()
    const c = sb.config(d)
    const r1 = await correr(s, c)
    expect(r1.hecha && r1.sesiones === 1).toBe(true)
    fs.writeFileSync(path.join(d, '.sesiones.json'), JSON.stringify({ [U.a]: 'betty', [U.b]: 'marce' }))
    const r2 = await correr(s, c)
    expect(r2.yaHabiaCorrido && !r2.hecha && r2.sesiones === 0).toBe(true)
    expect(s.agenteDe(U.b)).toBeUndefined()
  })

  test('entre reinicios: una nueva instancia del Store (misma base) no reimporta ni duplica', async () => {
    const sb = new Sb()
    const d = sb.legacy()
    sb.baseVieja(path.join(d, '.datos', 'hq.db'), [[U.a, 'betty', 1, 1]], [[U.a, 'u', 'uno', 0, 1]])
    const s = sb.store()
    const c = sb.config(d)
    await correr(s, c)
    s.close()
    const s2 = sb.store()
    const r = await correr(s2, c)
    expect(r.yaHabiaCorrido).toBe(true)
    expect(s2.cuentaMensajes(U.a)).toBe(1)
  })

  test('sin ninguna carpeta de origen: hecha=false y NO marca la migración (puede correr luego)', async () => {
    const sb = new Sb()
    const s = sb.store()
    const r = await correr(s, sb.config())
    expect(!r.hecha && !r.yaHabiaCorrido).toBe(true)
    expect(s.meta(claveMigracion)).toBeUndefined()
    const d = sb.legacy({ [U.a]: 'betty' })
    const r2 = await correr(s, sb.config(d))
    expect(r2.hecha && r2.sesiones === 1).toBe(true)
  })

  test('HQ_LEGACY_DIR del entorno tiene prioridad y las carpetas repetidas se procesan una vez', async () => {
    const sb = new Sb()
    const d = sb.legacy({ [U.a]: 'betty' })
    const c = sb.config(d)
    c.legacyDirs = [d, d]
    const r = await correr(sb.store(), c, { HQ_LEGACY_DIR: d })
    expect(r.sesiones).toBe(1)
  })

  test('no modifica ni borra los archivos de origen', async () => {
    const sb = new Sb()
    const d = sb.legacy({ [U.a]: 'betty' })
    sb.baseVieja(path.join(d, '.datos', 'hq.db'), [[U.b, 'marce', 1, 1]], [[U.b, 'u', 'x', 0, 1]])
    sb.transcript(U.a, ['{"type":"user","message":{"role":"user","content":"t"}}'])
    const archivos = [path.join(d, '.sesiones.json'), path.join(d, '.datos', 'hq.db'),
      path.join(sb.home, '.claude', 'projects', codificarCarpeta(sb.proyecto), `${U.a}.jsonl`)]
    const antes = archivos.map((a) => fs.readFileSync(a))
    const s = sb.store()
    await correr(s, sb.config(d))
    s.close()
    expect(archivos.map((a) => fs.readFileSync(a).equals(antes[archivos.indexOf(a)]!))).toEqual([true, true, true])
    // y no aparecen archivos nuevos (-wal/-shm) en la carpeta de origen
    expect(fs.readdirSync(path.join(d, '.datos'))).toEqual(['hq.db'])
  })
})
