// Port de app/Tests/BackendTests/ReunionesTests.swift.
// Reuniones: varios agentes opinan por rondas, el usuario interviene, al cerrar sale el acta y las decisiones.
//
// Diferencias con Swift (caja negra por HTTP):
// - `timeouts(f, ...)` reemplazaba el router en proceso: acá los timeouts van en el env del servidor (HQ_REUNION_*_TIMEOUT).
// - `patronesPuros` prueba funciones de ReunionPatron: interno (skip).
// - Swift (Foundation) pasa los argumentos de proceso al `claude` falso en NFD en macOS: los prompts se normalizan a NFC.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  Fix, Sandbox, U, chat, contratar, dict, esperar, historial, lista, llamar, msgs, escribir, sinPrivate, str, vivo, type Obj, type Resp,
} from '../support/sandbox.js'

type Ag = { id: string; depto: string; rol?: string }
type Cli = { get(ruta: string, query?: Record<string, string>): Promise<Resp>; post(ruta: string, body?: unknown): Promise<Resp> }

const equipo: Ag[] = [
  { id: 'marce', depto: 'redes', rol: 'Directora creativa de redes' },
  { id: 'nico', depto: 'ads', rol: 'Especialista en anuncios pagos' },
  { id: 'betty', depto: 'direccion', rol: 'PM y directora del equipo' },
]

const fix = (agentes: Ag[] = equipo, env: Record<string, string> = {}) =>
  Fix.crear({ nombre: 'Taller', duenio: 'Ana', deps: ['Dirección', 'Redes', 'Ads'], agentes, env })

const nfc = (l: string[]) => l.map((x) => x.normalize('NFC'))
/** Prompts (último argumento) de todas las llamadas, en NFC. */
const prompts = (f: Fix) => f.sb.llamadas.map((a) => (a.at(-1) ?? '').normalize('NFC'))
const promptsTurno = (f: Fix) => prompts(f).filter((p) => p.includes('Estás en una reunión'))
const llamadasConPrompt = (f: Fix, t: string) => f.sb.llamadas.map(nfc).filter((a) => (a.at(-1) ?? '').includes(t))

const nueva = (f: Cli, tema = 'plan de lanzamiento', agentes: string[] = ['marce', 'nico', 'betty'], extra: Obj = {}) =>
  f.post('/api/reuniones', { tema, agentes, ...extra })

const ver = async (f: Cli, id: string): Promise<Obj> => (await f.get(`/api/reuniones/${id}`)).obj

/** Espera a que la reunión llegue a uno de esos estados (hasta 15 s) y la devuelve. */
async function aguardar(f: Cli, id: string, estados: string[] = ['esperando', 'error', 'cerrada']): Promise<Obj> {
  let ult: Obj = {}
  await esperar(async () => {
    ult = await ver(f, id)
    return estados.includes(str(ult.estado))
  }, 15)
  return ult
}

const turnos = (r: Obj): Obj[] => lista(r.turnos)

function hoy(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Prompts de los turnos de agentes (no la síntesis), en orden. */
const llamadasTurno = (f: Fix) => llamadasConPrompt(f, 'Estás en una reunión')

const uuidValido = (s: string) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)

const equipo4: Ag[] = [...equipo, { id: 'lola', depto: 'redes', rol: 'Community manager' }]

describe('Reuniones', () => {
  // MARK: crear

  test('crear: validaciones del cuerpo (no lanza claude)', async () => {
    const f = await fix()
    const malo = async (d: Obj, motivo: string) => {
      const r = await f.post('/api/reuniones', d)
      expect(r.status, `${motivo} -> ${r.status} ${JSON.stringify(r.obj)}`).toBe(400)
      expect(typeof r.obj.error).toBe('string')
    }
    await malo({}, 'sin nada')
    await malo({ agentes: ['marce'] }, 'sin tema')
    await malo({ tema: '  ', agentes: ['marce'] }, 'tema vacío')
    await malo({ tema: 't'.repeat(501), agentes: ['marce'] }, 'tema largo')
    await malo({ tema: 5, agentes: ['marce'] }, 'tema no texto')
    await malo({ tema: 't' }, 'sin agentes')
    await malo({ tema: 't', agentes: [] }, 'agentes vacío')
    await malo({ tema: 't', agentes: 'marce' }, 'agentes no lista')
    await malo({ tema: 't', agentes: ['marce', 5] }, 'agente no texto')
    await malo({ tema: 't', agentes: ['Mal Id'] }, 'id inválido')
    await malo({ tema: 't', agentes: ['fantasma'] }, 'agente que no está en la oficina')
    await malo({ tema: 't', agentes: ['marce', 'fantasma'] }, 'uno bueno y uno malo')
    for (const r of [0, 4, -1, '2', true, false]) await malo({ tema: 't', agentes: ['marce'], rondas: r }, `rondas=${r}`)
    await malo({ tema: 't', agentes: ['marce'], documentos: 'x' }, 'documentos no lista')
    await malo({ tema: 't', agentes: ['marce'], documentos: [3] }, 'documentos no slugs')
    await malo({ tema: 't', agentes: ['marce'], documentos: ['no-existe'] }, 'documento inexistente')
    expect((await llamar(f.b, 'POST', '/api/reuniones')).status).toBe(400)
    expect((await llamar(f.b, 'POST', '/api/reuniones', { body: '[1]' })).status).toBe(400)
    expect((await llamar(f.b, 'POST', '/api/reuniones', { body: ' '.repeat(200_001) })).status).toBe(413)
    expect(f.sb.llamadas).toEqual([])
    expect(lista((await f.get('/api/reuniones')).obj.reuniones)).toEqual([])
    // tema de 500 justos y rondas null: bien
    const ok = await nueva(f, 't'.repeat(500), ['marce'], { rondas: null })
    expect(ok.status).toBe(200)
    await aguardar(f, str(ok.obj.id))
  })

  test('crear: máximo 20 participantes', async () => {
    const ags: Ag[] = Array.from({ length: 21 }, (_, i) => ({ id: `a${i}`, depto: 'redes' }))
    const f = await fix(ags)
    const r = await nueva(f, 'tema', ags.map((a) => a.id))
    expect(r.status).toBe(400)
    expect(str(r.obj.error).includes('20')).toBe(true)
    expect(f.sb.llamadas).toEqual([])
    const veinte = await nueva(f, 'tema', ags.slice(0, 20).map((a) => a.id))
    expect(veinte.status).toBe(200)
    const fin = await aguardar(f, str(veinte.obj.id))
    expect(turnos(fin).length).toBe(20)
  })

  test('crear: respuesta con id UUID, estado en_curso, agentes sin repetir y la reunión arranca sola en segundo plano', async () => {
    const f = await fix()
    f.sb.modo('marce', 'puerta')
    const r = await nueva(f, 'plan', ['marce', 'marce'])
    expect(r.status).toBe(200)
    expect(new Set(Object.keys(r.obj))).toEqual(new Set(['id', 'tema', 'agentes', 'estado', 'creada', 'hablando', 'rondas', 'turnos', 'patron', 'salida']))
    const id = str(r.obj.id)
    expect(uuidValido(id) && id === id.toLowerCase()).toBe(true)
    expect(r.obj.tema).toBe('plan')
    expect(r.obj.agentes).toEqual(['marce'])
    expect(r.obj.estado).toBe('en_curso')
    expect(r.obj.rondas).toBe(0)
    expect(lista(r.obj.turnos)).toEqual([])
    expect(!Number.isNaN(Date.parse(str(r.obj.creada))) || str(r.obj.creada).endsWith('Z')).toBe(true)
    expect(await esperar(() => f.sb.eventos.includes('S marce'))).toBe(true)
    const g = await ver(f, id)
    expect(g.hablando).toBe('marce')
    expect(g.estado).toBe('en_curso')
    f.sb.abrirPuerta()
    const fin = await aguardar(f, id)
    expect(fin.estado).toBe('esperando')
    expect(fin.hablando).toBeNull()
    expect(turnos(fin).map((t) => str(t.agente))).toEqual(['marce'])
  })

  // MARK: orden

  test('orden: primero quien más se relaciona con el tema (rol y departamento pesan más que brief y chips); a igual puntaje, el orden de llegada', async () => {
    const f = await fix()
    const a = await nueva(f, 'campaña de anuncios pagos', ['marce', 'betty', 'nico'])
    expect(a.obj.agentes).toEqual(['nico', 'marce', 'betty'])
    const b = await nueva(f, 'estrategia en redes sociales', ['betty', 'nico', 'marce'])
    expect(b.obj.agentes).toEqual(['marce', 'betty', 'nico'])   // «redes» está en el rol y en el departamento de Marce
    const c = await nueva(f, 'algo sin relación aquí', ['nico', 'betty', 'marce'])
    expect(c.obj.agentes).toEqual(['nico', 'betty', 'marce'])   // sin coincidencias: el orden original
    const d = await nueva(f, 'Anuncios', ['betty', 'marce', 'nico'])         // mayúsculas y plural exacto
    expect(d.obj.agentes).toEqual(['nico', 'betty', 'marce'])
    for (const x of [a, b, c, d]) await aguardar(f, str(x.obj.id))
  })

  test('orden: brief y chips pesan 1, rol y departamento pesan 2; se guarda y se usa en todas las rondas', async () => {
    const f = await Fix.crear({ deps: ['Dirección', 'Redes'], agentes: [] })
    await contratar(f.b, { id: 'ana', depto: 'redes', rol: 'Asistente', extra: { brief: 'arma el presupuesto trimestral' } })
    await contratar(f.b, { id: 'luz', depto: 'direccion', rol: 'Otra cosa' })
    await contratar(f.b, { id: 'ivo', depto: 'direccion', rol: 'Contador de presupuesto' })
    await contratar(f.b, { id: 'zoe', depto: 'direccion', rol: 'Sin relación', extra: { chips: ['¿Cómo va el presupuesto?'] } })
    const r = await nueva(f, 'presupuesto', ['luz', 'ana', 'zoe', 'ivo'], { rondas: 2 })
    expect(r.obj.agentes).toEqual(['ivo', 'ana', 'zoe', 'luz'])   // ivo (rol, 2); ana y zoe (brief/chips, 1) en orden de llegada; luz (0)
    const id = str(r.obj.id)
    const fin = await aguardar(f, id)
    expect(turnos(fin).map((t) => str(t.agente))).toEqual(['ivo', 'ana', 'zoe', 'luz', 'ivo', 'ana', 'zoe', 'luz'])
    expect(fin.agentes).toEqual(['ivo', 'ana', 'zoe', 'luz'])
  })

  // MARK: turnos

  test('turnos: secuenciales, un turno por participante y ronda, claude solo con Read,Glob,Grep y cwd en la oficina', async () => {
    const f = await fix()
    const r = await nueva(f, 'plan de lanzamiento', ['marce', 'nico', 'betty'], { rondas: 2 })
    const id = str(r.obj.id)
    const fin = await aguardar(f, id)
    expect(fin.estado).toBe('esperando')
    expect(fin.hablando).toBeNull()
    expect(fin.rondas).toBe(2)
    const ts = turnos(fin)
    const orden = ['marce', 'nico', 'betty', 'marce', 'nico', 'betty']
    expect(ts.map((t) => str(t.agente))).toEqual(orden)
    expect(ts.map((t) => t.ronda)).toEqual([1, 1, 1, 2, 2, 2])
    expect(ts.every((t) => t.error === undefined)).toBe(true)
    expect(ts.map((t) => str(t.texto))).toEqual(orden.map((x) => `Opinión de ${x} sobre el tema.`))
    for (const t of ts) expect(str(t.ts) !== '' && typeof t.ts === 'string').toBe(true)
    // nunca dos claude a la vez: S/E alternados y en orden
    expect(f.sb.eventos).toEqual(orden.flatMap((x) => [`S ${x}`, `E ${x}`]))
    // argumentos de cada turno
    const ll = llamadasTurno(f)
    expect(ll.length).toBe(6)
    const sids = new Set<string>()
    ll.forEach((l, i) => {
      expect(Sandbox.valor(l, '--agent')).toBe(orden[i])
      expect(Sandbox.valor(l, '--tools')).toBe('Read,Glob,Grep')
      expect(Sandbox.reglas(l)).toEqual(['Read', 'Glob', 'Grep', '--disallowedTools', 'mcp__claude_ai_*'])
      expect(!l.includes('Edit') && !l.includes('Write')).toBe(true)
      expect(Sandbox.valor(l, '--permission-mode')).toBe('dontAsk')
      expect(Sandbox.valor(l, '--output-format')).toBe('stream-json')
      expect(l.includes('--session-id') && !l.includes('--resume')).toBe(true)
      expect(l.includes('--add-dir')).toBe(false)
      sids.add(Sandbox.valor(l, '--session-id') ?? '')
    })
    expect(sids.size).toBe(6)                           // sesión nueva en cada turno
    expect([...sids].every(uuidValido)).toBe(true)
    expect(f.sb.cwds.every((c) => sinPrivate(c) === sinPrivate(f.carpeta))).toBe(true)
    // los turnos no tocan el historial del chat 1 a 1
    expect(msgs(await historial(f.b, { agent: 'marce' }))).toEqual([])
  })

  test('prompt del turno: tema, participantes, memoria común, decisiones, transcripción por ronda y consigna', async () => {
    const f = await fix()
    escribir('# Taller\nMEMORIA_X: vendemos talleres', f.ruta('conocimiento/oficina.md'))
    escribir('# Decisiones\n\n- 2026-01-01: DECISION_UNO\nlínea que no es decisión\n- 2026-01-02: DECISION_DOS\n', f.ruta('conocimiento/decisiones.md'))
    const r = await nueva(f, 'plan de lanzamiento', ['marce', 'nico', 'betty'], { rondas: 2 })
    await aguardar(f, str(r.obj.id))
    const p = promptsTurno(f)
    expect(p.length).toBe(6)
    const p1 = p[0]!
    expect(p1.includes('Estás en una reunión de la oficina «Taller». Tema de la reunión:\nplan de lanzamiento')).toBe(true)
    expect(p1.includes('Participantes: Marce (Directora creativa de redes), Nico (Especialista en anuncios pagos), Betty (PM y directora del equipo)')).toBe(true)
    expect(p1.includes('Memoria común de la oficina:\n# Taller\nMEMORIA_X: vendemos talleres')).toBe(true)
    expect(p1.includes('Decisiones recientes:\n- 2026-01-01: DECISION_UNO\n- 2026-01-02: DECISION_DOS')).toBe(true)
    expect(p1.includes('línea que no es decisión')).toBe(false)
    expect(p1.includes('(estamos en la ronda 1):\n(todavía no habló nadie)')).toBe(true)
    expect(p1.includes('Sos Marce, Directora creativa de redes. Opiná desde tu rol en 120-180 palabras')).toBe(true)
    expect(p[1]!.includes('Sos Nico, Especialista en anuncios pagos.')).toBe(true)
    // el segundo ya ve al primero, con el separador de ronda
    expect(p[1]!.includes('— Ronda 1 —\nMarce: Opinión de marce sobre el tema.')).toBe(true)
    expect(p[1]!.includes('(todavía no habló nadie)')).toBe(false)
    expect(p[2]!.includes('Nico: Opinión de nico sobre el tema.')).toBe(true)
    // la ronda 2 ve toda la ronda 1 y, a medida que avanza, la 2
    expect(p[3]!.includes('(estamos en la ronda 2)')).toBe(true)
    expect(p[3]!.includes('Betty: Opinión de betty sobre el tema.')).toBe(true)
    expect(p[3]!.includes('— Ronda 2 —')).toBe(false)
    expect(p[4]!.includes('— Ronda 2 —\nMarce: Opinión de marce sobre el tema.')).toBe(true)
    // nadie ve su propio turno futuro
    expect(p[0]!.includes('Opinión de')).toBe(false)
  })

  test('prompt del turno: la memoria común se recorta a 2000 caracteres y solo entran las últimas 15 decisiones', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }])
    escribir('m'.repeat(5000) + 'FINAL_DE_MEMORIA', f.ruta('conocimiento/oficina.md'))
    escribir(Array.from({ length: 20 }, (_, i) => { const n = String(i + 1).padStart(2, '0'); return `- 2026-01-${n}: DEC_${n}` }).join('\n') + '\n', f.ruta('conocimiento/decisiones.md'))
    await aguardar(f, str((await nueva(f, 'algo', ['marce'])).obj.id))
    const p = promptsTurno(f)[0]!
    expect(p).toBeDefined()
    expect(p.includes('m'.repeat(2000) + '…')).toBe(true)
    expect(p.includes('m'.repeat(2001))).toBe(false)
    expect(p.includes('FINAL_DE_MEMORIA')).toBe(false)
    expect(p.includes('DEC_20') && p.includes('DEC_06')).toBe(true)
    expect(!p.includes('DEC_05') && !p.includes('DEC_01')).toBe(true)
    // sin memoria ni decisiones
    escribir('', f.ruta('conocimiento/oficina.md'))
    fs.rmSync(f.ruta('conocimiento/decisiones.md'))
    await aguardar(f, str((await nueva(f, 'otra cosa', ['marce'])).obj.id))
    const q = promptsTurno(f).at(-1)!
    expect(q.includes('(sin memoria común todavía)')).toBe(true)
    expect(q.includes('(todavía no hay decisiones registradas)')).toBe(true)
  })

  test('hablando: en curso muestra quién habla; no se puede pedir otra ronda ni cerrar mientras tanto', async () => {
    const f = await fix()
    f.sb.modo('nico', 'puerta')
    const r = await nueva(f, 'campaña de anuncios pagos', ['marce', 'nico', 'betty'])
    const id = str(r.obj.id)
    expect(r.obj.agentes).toEqual(['nico', 'marce', 'betty'])
    expect(await esperar(() => f.sb.eventos.includes('S nico'))).toBe(true)
    const g = await ver(f, id)
    expect(g.estado).toBe('en_curso')
    expect(g.hablando).toBe('nico')
    expect(turnos(g)).toEqual([])
    const l = lista((await f.get('/api/reuniones')).obj.reuniones)
    expect(l[0]?.estado).toBe('en_curso')
    const ronda = await f.post(`/api/reuniones/${id}/ronda`)
    expect(ronda.status).toBe(409)
    expect(str(ronda.obj.error).includes('ronda en curso')).toBe(true)
    const cerrar = await f.post(`/api/reuniones/${id}/cerrar`)
    expect(cerrar.status).toBe(409)
    expect(str(cerrar.obj.error).includes('ronda en curso')).toBe(true)
    expect(llamadasConPrompt(f, 'secretario de actas')).toEqual([])
    f.sb.abrirPuerta()
    const fin = await aguardar(f, id)
    expect(fin.estado).toBe('esperando')
    expect(turnos(fin).map((t) => str(t.agente))).toEqual(['nico', 'marce', 'betty'])
  })

  // MARK: intervenir

  test('intervención en medio de la ronda: queda como turno «usuario» y la leen los turnos que siguen', async () => {
    const f = await fix()
    f.sb.modo('nico', 'puerta')
    const id = str((await nueva(f, 'campaña de anuncios pagos', ['marce', 'nico', 'betty'])).obj.id)
    expect(await esperar(() => f.sb.eventos.includes('S nico'))).toBe(true)
    const r = await f.post(`/api/reuniones/${id}/intervencion`, { texto: '  quiero ver números concretos  ' })
    expect(r.status).toBe(200)
    const t = turnos(r.obj)
    expect(t.length).toBe(1)
    expect(t[0]!.agente).toBe('usuario')
    expect(t[0]!.texto).toBe('quiero ver números concretos')
    expect(t[0]!.ronda).toBe(0)       // antes de que hable nadie: ronda 0
    expect(r.obj.estado).toBe('en_curso')
    f.sb.abrirPuerta()
    const fin = await aguardar(f, id)
    expect(turnos(fin).map((x) => str(x.agente))).toEqual(['usuario', 'nico', 'marce', 'betty'])
    const p = promptsTurno(f)
    expect(p[0]!.includes('quiero ver números')).toBe(false)                      // nico ya estaba hablando
    expect(p[1]!.includes('Ana (dueño de la oficina): quiero ver números concretos')).toBe(true)
    expect(p[2]!.includes('Ana (dueño de la oficina): quiero ver números concretos')).toBe(true)
  })

  test('intervención entre rondas: lleva la última ronda vista, y la siguiente ronda la lee', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }])
    const id = str((await nueva(f, 'tema', ['marce'])).obj.id)
    await aguardar(f, id)
    const r = await f.post(`/api/reuniones/${id}/intervencion`, { texto: 'ahora más corto' })
    expect(turnos(r.obj).at(-1)?.ronda).toBe(1)
    expect(turnos(r.obj).at(-1)?.agente).toBe('usuario')
    expect((await f.post(`/api/reuniones/${id}/ronda`)).status).toBe(200)
    const fin = await aguardar(f, id)
    expect(turnos(fin).map((t) => str(t.agente))).toEqual(['marce', 'usuario', 'marce'])
    expect(turnos(fin).map((t) => t.ronda)).toEqual([1, 1, 2])
    const ult = promptsTurno(f).at(-1)!
    expect(ult.includes('Ana (dueño de la oficina): ahora más corto')).toBe(true)
    // la transcripción del turno no incluye los turnos fallidos ni repite la ronda
    expect(ult.includes('— Ronda 1 —\nMarce: Opinión de marce sobre el tema.\n\nAna (dueño de la oficina): ahora más corto')).toBe(true)
  })

  test('intervención: validaciones y errores (404, 409 si está cerrada)', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }])
    const id = str((await nueva(f, 'tema', ['marce'])).obj.id)
    await aguardar(f, id)
    const inter = (b?: unknown) => f.post(`/api/reuniones/${id}/intervencion`, b)
    expect((await inter()).status).toBe(400)
    expect((await inter({})).status).toBe(400)
    expect((await inter({ texto: '  ' })).status).toBe(400)
    expect((await inter({ texto: 3 })).status).toBe(400)
    expect((await inter({ texto: 't'.repeat(5001) })).status).toBe(400)
    expect((await inter({ texto: 't'.repeat(5000) })).status).toBe(200)
    expect((await f.post(`/api/reuniones/${U.a}/intervencion`, { texto: 'x' })).status).toBe(404)
    expect((await f.post('/api/reuniones/no-es-uuid/intervencion', { texto: 'x' })).status).toBe(404)
    expect((await f.post(`/api/reuniones/${id}/otra-cosa`)).status).toBe(404)
    expect((await llamar(f.b, 'GET', `/api/reuniones/${id}/cerrar`)).status).toBe(405)
    expect((await llamar(f.b, 'DELETE', `/api/reuniones/${id}`)).status).toBe(405)
    expect((await f.post(`/api/reuniones/${id}/cerrar`)).status).toBe(200)
    const c = await inter({ texto: 'tarde' })
    expect(c.status).toBe(409)
    expect((await f.post(`/api/reuniones/${id}/ronda`)).status).toBe(409)
    expect(turnos(await ver(f, id)).filter((t) => str(t.agente) === 'usuario').length).toBe(1)
  })

  // MARK: otra ronda

  test('otra ronda: arranca en segundo plano, suma turnos y no se puede pisar con otra', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }, { id: 'nico', depto: 'ads' }])
    const id = str((await nueva(f, 'algo', ['marce', 'nico'])).obj.id)
    const uno = await aguardar(f, id)
    expect(turnos(uno).length).toBe(2)
    f.sb.modo('marce', 'puerta')
    const r = await f.post(`/api/reuniones/${id}/ronda`)
    expect(r.status).toBe(200)
    expect(r.obj.estado).toBe('en_curso')
    expect(await esperar(() => f.sb.eventos.filter((e) => e === 'S marce').length === 2)).toBe(true)
    expect((await ver(f, id)).hablando).toBe('marce')
    expect((await f.post(`/api/reuniones/${id}/ronda`)).status).toBe(409)
    f.sb.abrirPuerta()
    const dos = await aguardar(f, id)
    expect(dos.estado).toBe('esperando')
    expect(turnos(dos).map((t) => t.ronda)).toEqual([1, 1, 2, 2])
    expect(dos.rondas).toBe(2)
    expect((await f.post(`/api/reuniones/${U.b}/ronda`)).status).toBe(404)
  })

  // MARK: turnos que fallan

  test('un turno que falla queda registrado con error:true y la ronda sigue con los demás', async () => {
    const f = await fix()
    f.sb.modo('marce', 'error')
    const id = str((await nueva(f, 'plan', ['marce', 'nico', 'betty'])).obj.id)
    const fin = await aguardar(f, id)
    expect(fin.estado).toBe('esperando')   // alguno respondió
    const ts = turnos(fin)
    expect(ts.map((t) => str(t.agente))).toEqual(['marce', 'nico', 'betty'])
    expect(ts[0]!.error).toBe(true)
    expect(str(ts[0]!.texto)).not.toBe('')
    expect(ts[1]!.error === undefined && ts[2]!.error === undefined).toBe(true)
    // el turno fallido no entra en la transcripción de los que siguen
    const p = promptsTurno(f)
    expect(p[1]!.includes(str(ts[0]!.texto))).toBe(false)
    expect(p[1]!.includes('(todavía no habló nadie)')).toBe(true)
    // ni en la síntesis, pero sí queda en el acta
    const c = await f.post(`/api/reuniones/${id}/cerrar`)
    expect(c.status).toBe(200)
    const sint = prompts(f).filter((x) => x.includes('secretario de actas')).at(-1)!
    expect(sint).toBeDefined()
    expect(sint.includes(str(ts[0]!.texto))).toBe(false)
    expect(sint.includes('Nico (Especialista en anuncios pagos): Opinión de nico')).toBe(true)
    expect(f.leer(str(c.obj.acta)).includes(`**Marce (Directora creativa de redes):** _(no pudo responder: ${str(ts[0]!.texto)})_`)).toBe(true)
  })

  test('turno sin respuesta -> «(sin respuesta)» con error; si nadie responde la reunión queda en «error» y se puede reintentar o cerrar', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }, { id: 'nico', depto: 'ads' }])
    f.sb.modo('marce', 'vacio')
    f.sb.modo('nico', 'error')
    const id = str((await nueva(f, 'plan', ['marce', 'nico'])).obj.id)
    // (no se espera «esperando»: entre que la ronda termina y se guarda el estado final, el GET informa «esperando»)
    const fin = await aguardar(f, id, ['error', 'cerrada'])
    expect(fin.estado).toBe('error')
    expect(str(fin.error)).not.toBe('')
    const ts = turnos(fin)
    expect(ts.length === 2 && ts.every((t) => t.error === true)).toBe(true)
    expect(ts[0]!.texto).toBe('(sin respuesta)')
    // se puede pedir otra ronda (ahora sí responden)
    f.sb.modo('marce', null); f.sb.modo('nico', null)
    expect((await f.post(`/api/reuniones/${id}/ronda`)).status).toBe(200)
    const dos = await aguardar(f, id)
    expect(dos.estado).toBe('esperando')
    expect(dos.error).toBeUndefined()
    expect(turnos(dos).length).toBe(4)
  })

  test('cerrar sin ninguna opinión válida: acta sin síntesis (no llama al secretario) y no toca decisiones.md', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }])
    f.sb.modo('marce', 'error')
    const id = str((await nueva(f, 'plan', ['marce'])).obj.id)
    await aguardar(f, id)
    const decisiones = f.leer('conocimiento/decisiones.md')
    const c = await f.post(`/api/reuniones/${id}/cerrar`)
    expect(c.status).toBe(200)
    expect(c.obj.estado).toBe('cerrada')
    expect(c.obj.sintesis).toBeUndefined()
    expect(c.obj.errorSintesis).toBe('No hubo opiniones para resumir.')
    expect(llamadasConPrompt(f, 'secretario de actas')).toEqual([])
    const acta = f.leer(str(c.obj.acta))
    expect(acta.includes('_No se pudo generar la síntesis: No hubo opiniones para resumir.')).toBe(true)
    // detalle cosmético: el motivo ya termina en punto y la plantilla agrega otro («resumir.._»)
    expect(acta.includes('.._'), `acta=${acta}`).toBe(false)
    expect(f.leer('conocimiento/decisiones.md')).toBe(decisiones)
  })

  test('turno que pasa el timeout (HQ_REUNION_TURNO_TIMEOUT): error «Tardó demasiado» y sin procesos huérfanos', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }, { id: 'nico', depto: 'ads' }], { HQ_REUNION_TURNO_TIMEOUT: '0.7' })
    f.sb.modo('marce', 'lento')
    const id = str((await nueva(f, 'plan', ['marce', 'nico'])).obj.id)
    const fin = await aguardar(f, id)
    expect(fin.estado).toBe('esperando')
    const ts = turnos(fin)
    expect(ts[0]!.error).toBe(true)
    expect(ts[0]!.texto).toBe('Tardó demasiado en responder.')
    expect(ts[1]!.texto).toBe('Opinión de nico sobre el tema.')
    const pid = f.sb.childPid
    if (pid) expect(await esperar(() => !vivo(pid), 5), 'quedó el hijo del claude vivo').toBe(true)
  })

  // MARK: cerrar

  test('cerrar: síntesis, acta en reuniones/ con la fecha y el tema, y decisiones anexadas a decisiones.md', async () => {
    const f = await fix()
    const previas = f.leer('conocimiento/decisiones.md')
    const id = str((await nueva(f, 'Plan de Lanzamiento: ¡Diciembre!', ['marce', 'nico'])).obj.id)
    await aguardar(f, id)
    const c = await f.post(`/api/reuniones/${id}/cerrar`)
    expect(c.status).toBe(200)
    expect(c.obj.estado).toBe('cerrada')
    expect(str(c.obj.cerrada).endsWith('Z')).toBe(true)
    expect(c.obj.hablando).toBeNull()
    const s = dict(c.obj.sintesis)
    expect(s.resumen).toBe('Se acordó avanzar con el plan.')
    expect(s.decisiones).toEqual(['Lanzar en diciembre', 'Priorizar los reels'])
    expect(lista(s.pendientes).map((x) => `${str(x.quien)}|${str(x.que)}`)).toEqual(['Marce|Armar el calendario'])
    expect(c.obj.errorSintesis).toBeUndefined()
    // acta
    const rel = str(c.obj.acta)
    expect(rel).toBe(`reuniones/${hoy()}-plan-de-lanzamiento-diciembre.md`)
    expect(c.obj.actaRuta).toBe(`${f.carpeta}/${rel}`)
    const acta = f.leer(rel)
    expect(acta.startsWith('# Reunión: Plan de Lanzamiento: ¡Diciembre!\n')).toBe(true)
    expect(acta.includes('- **Oficina:** Taller')).toBe(true)
    expect(acta.includes(`- **Fecha:** ${hoy()}`)).toBe(true)
    expect(
      acta.includes('- **Participantes:** Marce (Directora creativa de redes), Nico (Especialista en anuncios pagos)') ||
      acta.includes('- **Participantes:** Nico (Especialista en anuncios pagos), Marce (Directora creativa de redes)'),
    ).toBe(true)
    expect(acta.includes('## Transcripción')).toBe(true)
    expect(acta.includes('### Ronda 1')).toBe(true)
    expect(acta.includes('**Marce (Directora creativa de redes):** Opinión de marce sobre el tema.')).toBe(true)
    expect(acta.includes('## Síntesis\n\nSe acordó avanzar con el plan.')).toBe(true)
    expect(acta.includes('### Decisiones\n\n- Lanzar en diciembre\n- Priorizar los reels')).toBe(true)
    expect(acta.includes('### Pendientes\n\n- **Marce:** Armar el calendario')).toBe(true)
    // decisiones.md: lo anterior intacto y las nuevas al final con la fecha
    const dec = f.leer('conocimiento/decisiones.md')
    expect(dec.startsWith(previas)).toBe(true)
    expect(dec.endsWith(`- ${hoy()}: Lanzar en diciembre\n- ${hoy()}: Priorizar los reels\n`)).toBe(true)
    // una sola llamada de síntesis: sin agente, sin herramientas, cwd en la oficina
    const ll = llamadasConPrompt(f, 'secretario de actas')
    expect(ll.length).toBe(1)
    const l = ll[0]!
    expect(l.includes('--agent')).toBe(false)
    expect(Sandbox.valor(l, '--tools')).toBe('')
    const p = l.at(-1)!
    expect(p.includes('Sos el secretario de actas de la oficina «Taller». Tema de la reunión: Plan de Lanzamiento: ¡Diciembre!')).toBe(true)
    expect(p.includes('— Ronda 1 —')).toBe(true)
    expect(p.includes('Marce (Directora creativa de redes): Opinión de marce')).toBe(true)
    const idx = f.sb.llamadas.findIndex((a) => (a.at(-1) ?? '').normalize('NFC') === p)
    expect(sinPrivate(f.sb.cwds[idx]!)).toBe(sinPrivate(f.carpeta))
    // GET y lista muestran la reunión cerrada con todo
    const g = await ver(f, id)
    expect(g.estado).toBe('cerrada')
    expect(dict(g.sintesis)).toEqual(s)
    expect(g.acta).toBe(rel)
    expect(lista((await f.get('/api/reuniones')).obj.reuniones)[0]?.estado).toBe('cerrada')
  })

  test('cerrar: dos veces 409; actas del mismo día y tema con -2; tema sin letras -> «reunion»', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }])
    const actas: string[] = []
    for (const tema of ['Mismo tema', 'Mismo tema', '¿¿??']) {
      const id = str((await nueva(f, tema, ['marce'])).obj.id)
      await aguardar(f, id)
      const c = await f.post(`/api/reuniones/${id}/cerrar`)
      actas.push(str(c.obj.acta))
      if (actas.length === 1) {
        expect((await f.post(`/api/reuniones/${id}/cerrar`)).status).toBe(409)
        expect((await f.post(`/api/reuniones/${id}/cerrar`)).obj.error).toBe('La reunión ya está cerrada.')
      }
    }
    expect(actas).toEqual([`reuniones/${hoy()}-mismo-tema.md`, `reuniones/${hoy()}-mismo-tema-2.md`, `reuniones/${hoy()}-reunion.md`])
    expect(actas.every((a) => f.existe(a))).toBe(true)
    expect(llamadasConPrompt(f, 'secretario de actas').length).toBe(3)   // el 409 no volvió a llamar
  })

  test('síntesis en bloque ```json con texto alrededor, pendientes como texto y decisiones de varias líneas', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }])
    f.sb.responder('acta', 'Acá está el acta:\n```json\n{"resumen": "  Resumen  ", "decisiones": ["Una\\ncon salto", "  ", 5, "Dos"], "pendientes": ["Hacer algo", {"quien": "Ana", "que": "Llamar"}, {"quien": "Beto", "que": ""}]}\n```\nListo.')
    const id = str((await nueva(f, 'tema', ['marce'])).obj.id)
    await aguardar(f, id)
    const c = await f.post(`/api/reuniones/${id}/cerrar`)
    const s = dict(c.obj.sintesis)
    expect(s.resumen).toBe('Resumen')
    expect(s.decisiones).toEqual(['Una\ncon salto', 'Dos'])
    expect(lista(s.pendientes).map((x) => `${str(x.quien)}|${str(x.que)}`)).toEqual(['|Hacer algo', 'Ana|Llamar'])
    const dec = f.leer('conocimiento/decisiones.md')
    expect(dec.includes(`- ${hoy()}: Una con salto\n- ${hoy()}: Dos\n`)).toBe(true)
    const acta = f.leer(str(c.obj.acta))
    expect(acta.includes('- **Ana:** Llamar') && acta.includes('- Hacer algo')).toBe(true)
  })

  test('síntesis que falla (claude con error, texto sin JSON, JSON vacío, timeout): la reunión se cierra igual, sin síntesis y sin decisiones', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }])
    const decisiones = f.leer('conocimiento/decisiones.md')
    const cerrarCon = async (preparar: () => void): Promise<Obj> => {
      f.sb.modo('acta', null)
      fs.rmSync(`${f.sb.binDir}/resp.acta.json`, { force: true })
      preparar()
      const id = str((await nueva(f, 'tema', ['marce'])).obj.id)
      await aguardar(f, id)
      const c = await f.post(`/api/reuniones/${id}/cerrar`)
      expect(c.status).toBe(200)
      expect(c.obj.estado).toBe('cerrada')
      expect(c.obj.sintesis).toBeUndefined()
      const acta = f.leer(str(c.obj.acta))
      expect(acta.includes('## Síntesis\n\n_No se pudo generar la síntesis: '), `acta=${acta}`).toBe(true)
      expect(f.leer('conocimiento/decisiones.md')).toBe(decisiones)
      const g = await ver(f, id)
      expect(g.sintesis).toBeUndefined()
      expect(g.errorSintesis).toBe(c.obj.errorSintesis)
      return c.obj
    }
    const e1 = await cerrarCon(() => f.sb.modo('acta', 'error'))
    expect(str(e1.errorSintesis)).not.toBe('')
    const e2 = await cerrarCon(() => f.sb.modo('acta', 'nojson'))
    expect(e2.errorSintesis).toBe('La síntesis no vino en el formato esperado.')
    const e3 = await cerrarCon(() => f.sb.responder('acta', '{"resumen": "", "decisiones": [], "pendientes": []}'))
    expect(e3.errorSintesis).toBe('La síntesis no vino en el formato esperado.')
    const e4 = await cerrarCon(() => f.sb.responder('acta', 'no tengo nada para decir'))
    expect(e4.errorSintesis).toBe('La síntesis no vino en el formato esperado.')
    const e5 = await cerrarCon(() => f.sb.modo('acta', 'vacio'))
    expect(str(e5.errorSintesis)).not.toBe('')
  })

  test('síntesis que pasa el timeout (HQ_REUNION_SINTESIS_TIMEOUT): errorSintesis «Tardó demasiado» y el acta igual se escribe', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }], { HQ_REUNION_TURNO_TIMEOUT: '10', HQ_REUNION_SINTESIS_TIMEOUT: '0.7' })
    f.sb.modo('acta', 'lento')
    const id = str((await nueva(f, 'tema', ['marce'])).obj.id)
    await aguardar(f, id)
    const c = await f.post(`/api/reuniones/${id}/cerrar`)
    expect(c.status).toBe(200)
    expect(c.obj.errorSintesis).toBe('Tardó demasiado en responder.')
    expect(f.existe(str(c.obj.acta))).toBe(true)
    const pid = f.sb.childPid
    if (pid) expect(await esperar(() => !vivo(pid), 5)).toBe(true)
  })

  test('si se despide a un participante entre rondas, la reunión sigue con los que quedan y el acta lista solo a los presentes', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }, { id: 'nico', depto: 'ads' }])
    const id = str((await nueva(f, 'algo', ['marce', 'nico'])).obj.id)
    await aguardar(f, id)
    expect((await f.delete('/api/agentes/nico')).status).toBe(200)
    expect((await f.post(`/api/reuniones/${id}/ronda`)).status).toBe(200)
    const fin = await aguardar(f, id)
    expect(turnos(fin).map((t) => str(t.agente))).toEqual(['marce', 'nico', 'marce'])   // nico solo habló en la ronda 1
    const c = await f.post(`/api/reuniones/${id}/cerrar`)
    expect(c.status).toBe(200)
    expect(f.leer(str(c.obj.acta)).includes('- **Participantes:** Marce (Rol de marce)\n')).toBe(true)
  })

  // MARK: reinicio

  test('reinicio de la app en medio de una ronda: la reunión pasa a «esperando» con los turnos que alcanzó y se puede seguir', async () => {
    const f = await fix()
    f.sb.modo('nico', 'puerta')
    const id = str((await nueva(f, 'campaña de anuncios pagos', ['marce', 'nico', 'betty'])).obj.id)
    expect(await esperar(() => f.sb.eventos.includes('S nico'))).toBe(true)
    expect((await ver(f, id)).estado).toBe('en_curso')
    await f.b.cerrar()
    // nuevo Backend sobre los mismos datos: la oficina activa se recupera de config.json
    const b2 = await f.sb.backend({ oficina: false })
    const f2: Cli = { get: (r, q) => llamar(b2, 'GET', r, { query: q }), post: (r, body) => llamar(b2, 'POST', r, { body }) }
    const g = await ver(f2, id)
    expect(g.estado).toBe('esperando')
    expect(g.hablando).toBeNull()
    expect(turnos(g)).toEqual([])       // la ronda interrumpida no llegó a registrar turnos
    expect(lista((await f2.get('/api/reuniones')).obj.reuniones)[0]?.estado).toBe('esperando')
    // y se puede pedir otra ronda y cerrar
    f.sb.abrirPuerta()
    expect((await f2.post(`/api/reuniones/${id}/ronda`)).status).toBe(200)
    const fin = await aguardar(f2, id)
    expect(fin.estado).toBe('esperando')
    expect(turnos(fin).map((t) => str(t.agente))).toEqual(['nico', 'marce', 'betty'])
    expect((await f2.post(`/api/reuniones/${id}/cerrar`)).status).toBe(200)
  })

  // MARK: aislamiento entre oficinas y listado

  test('listado: más nuevas primero, con la cantidad de turnos; otra oficina no las ve (404) y al volver reaparecen', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }, { id: 'nico', depto: 'ads' }])
    const a = str((await nueva(f, 'primera', ['marce'])).obj.id)
    await aguardar(f, a)
    await new Promise((r) => setTimeout(r, 20))
    const b = str((await nueva(f, 'segunda', ['marce', 'nico'])).obj.id)
    await aguardar(f, b)
    const l = lista((await f.get('/api/reuniones')).obj.reuniones)
    expect(l.map((x) => str(x.id))).toEqual([b, a])
    expect(l.map((x) => x.turnos)).toEqual([2, 1])
    expect(new Set(Object.keys(l[0]!))).toEqual(new Set(['id', 'tema', 'agentes', 'estado', 'creada', 'turnos', 'patron', 'salida']))
    // otra oficina
    await llamar(f.b, 'POST', '/api/oficinas', { body: { nombre: 'Otra' } })
    expect(lista((await f.get('/api/reuniones')).obj.reuniones)).toEqual([])
    expect((await f.get(`/api/reuniones/${a}`)).status).toBe(404)
    expect((await f.post(`/api/reuniones/${a}/intervencion`, { texto: 'x' })).status).toBe(404)
    expect((await f.post(`/api/reuniones/${a}/ronda`)).status).toBe(404)
    expect((await f.post(`/api/reuniones/${a}/cerrar`)).status).toBe(404)
    expect((await nueva(f, 'x', ['marce'])).status).toBe(400)   // marce no está en la otra oficina
    await llamar(f.b, 'POST', '/api/oficinas/abrir', { body: { carpeta: f.carpeta } })
    expect(lista((await f.get('/api/reuniones')).obj.reuniones).length).toBe(2)
    expect((await f.get(`/api/reuniones/${a}`)).status).toBe(200)
  })

  // MARK: carril y permisos

  test('los turnos usan el carril del agente: esperan a que termine su chat 1 a 1 (nunca dos claude del mismo agente a la vez)', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }])
    const chatTarea = chat(f.b, { agent: 'marce', message: 'DORMIR', session: U.a })
    expect(await esperar(() => f.sb.eventos.includes('S marce'))).toBe(true)
    const id = str((await nueva(f, 'tema', ['marce'])).obj.id)
    const fin = await aguardar(f, id)
    await chatTarea
    expect(fin.estado).toBe('esperando')
    expect(f.sb.eventos).toEqual(['S marce', 'E marce', 'S marce', 'E marce'])
  })

  test('turnos de reunión: --add-dir de las carpetas vinculadas solo para quien tiene acceso', async () => {
    const f = await fix()
    for (const n of ['todos', 'solomarce']) fs.mkdirSync(`${f.sb.root}/ext/${n}`, { recursive: true })
    expect((await f.post('/api/vinculos', { ruta: `${f.sb.root}/ext/todos`, id: 'todos' })).status).toBe(200)
    expect((await f.post('/api/vinculos', { ruta: `${f.sb.root}/ext/solomarce`, id: 'solomarce', alcance: { agentes: ['marce'] } })).status).toBe(200)
    await aguardar(f, str((await nueva(f)).obj.id))
    const por: Record<string, string[]> = {}
    for (const l of llamadasTurno(f)) por[Sandbox.valor(l, '--agent') ?? ''] = Sandbox.valores(l, '--add-dir')
    const e = `${f.sb.root}/ext/`
    expect(por.marce).toEqual([`${e}todos`, `${e}solomarce`])
    expect(por.nico).toEqual([`${e}todos`])
    expect(por.betty).toEqual([`${e}todos`])
  })

  // MARK: documentos adjuntos

  test('documentos adjuntos: su ficha entra en el prompt de todos los turnos y la reunión devuelve la lista', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }, { id: 'nico', depto: 'ads' }])
    escribir('# Lista de precios\nFICHA_PRECIOS: el taller cuesta 100', f.ruta('conocimiento/fuentes/precios.md'))
    escribir('# Guion\nFICHA_GUION: abrir con un gancho', f.ruta('conocimiento/fuentes/guion.md'))
    const r = await nueva(f, 'tema', ['marce', 'nico'], { documentos: ['precios', 'guion', 'precios'] })
    expect(r.status).toBe(200)
    expect(r.obj.documentos).toEqual(['precios', 'guion'])
    const id = str(r.obj.id)
    const fin = await aguardar(f, id)
    expect(fin.documentos).toEqual(['precios', 'guion'])
    const p = promptsTurno(f)
    expect(p.length).toBe(2)
    for (const x of p) {
      expect(x.includes('Documentos adjuntos a la reunión')).toBe(true)
      expect(x.includes('FICHA_PRECIOS: el taller cuesta 100')).toBe(true)
      expect(x.includes('FICHA_GUION: abrir con un gancho')).toBe(true)
      expect(x.includes('archivos/.texto/<slug>.md')).toBe(true)
    }
    // sin documentos no hay sección
    const sin = await nueva(f, 'otro', ['marce'])
    expect(sin.obj.documentos).toBeUndefined()
    await aguardar(f, str(sin.obj.id))
    expect((promptsTurno(f).at(-1) ?? '').includes('Documentos adjuntos')).toBe(false)
  })

  test('documentos adjuntos: cada ficha se recorta a 2500 caracteres y el total a 8000; máximo 10', async () => {
    const f = await fix([{ id: 'marce', depto: 'redes' }])
    for (let i = 1; i <= 4; i++) escribir(`DOC${i}_INICIO ${'x'.repeat(4000)} DOC${i}_FIN`, f.ruta(`conocimiento/fuentes/doc${i}.md`))
    const r = await nueva(f, 'tema', ['marce'], { documentos: ['doc1', 'doc2', 'doc3', 'doc4'] })
    expect(r.status).toBe(200)
    await aguardar(f, str(r.obj.id))
    const p = promptsTurno(f)[0]!
    expect(p).toBeDefined()
    for (let i = 1; i <= 3; i++) expect(p.includes(`DOC${i}_INICIO`)).toBe(true)
    expect(!p.includes('DOC1_FIN') && !p.includes('DOC2_FIN')).toBe(true)   // recortadas a 2500
    expect(p.includes('DOC4_INICIO')).toBe(false)                          // el cuarto ya no entra en los 8000
    // más de 10
    for (let i = 5; i <= 12; i++) escribir(`ficha ${i}`, f.ruta(`conocimiento/fuentes/doc${i}.md`))
    const once = await nueva(f, 'tema', ['marce'], { documentos: Array.from({ length: 11 }, (_, i) => `doc${i + 1}`) })
    expect(once.status).toBe(400)
    expect(str(once.obj.error).includes('10')).toBe(true)
    const diez = await nueva(f, 'tema', ['marce'], { documentos: Array.from({ length: 10 }, (_, i) => `doc${i + 1}`) })
    expect(diez.status).toBe(200)
    await aguardar(f, str(diez.obj.id))
  })

  // MARK: patrones de reunión

  // interno (unit test del port): ReunionPatron.plan / visibles / errorDeSalida / rutaLibre / salidaPorDefecto
  test.skip('patrones: puros (plan, visibles, validación y sufijo de la salida)', () => {})

  test('patrones: validaciones del cuerpo', async () => {
    const f = await fix(equipo4)
    escribir('ficha', f.ruta('conocimiento/fuentes/doc.md'))
    const malo = async (extra: Obj, motivo: string, ags: string[] = ['marce', 'nico', 'betty']) => {
      const r = await nueva(f, 'tema', ags, extra)
      expect(r.status, `${motivo} -> ${r.status} ${JSON.stringify(r.obj)}`).toBe(400)
      expect(typeof r.obj.error).toBe('string')
    }
    await malo({ patron: 'asamblea' }, 'patrón desconocido')
    await malo({ patron: 3 }, 'patrón no texto')
    await malo({ patron: 'lider' }, 'líder sin lider')
    await malo({ patron: 'lider', lider: 'lola' }, 'líder que existe pero no participa')
    await malo({ patron: 'lider', lider: 'fantasma' }, 'líder inexistente')
    await malo({ patron: 'lider', lider: 4 }, 'líder no texto')
    await malo({ patron: 'redblue' }, 'redblue sin bandos')
    await malo({ patron: 'redblue', bandos: { a: ['marce', 'nico', 'betty'], b: [] } }, 'bando b vacío')
    await malo({ patron: 'redblue', bandos: { a: [], b: ['marce', 'nico', 'betty'] } }, 'bando a vacío')
    await malo({ patron: 'redblue', bandos: { a: ['marce'], b: ['nico'] } }, 'no cubre a betty')
    await malo({ patron: 'redblue', bandos: { a: ['marce', 'nico'], b: ['nico', 'betty'] } }, 'nico en los dos')
    await malo({ patron: 'redblue', bandos: { a: ['marce', 'nico'], b: ['betty', 'lola'] } }, 'lola no participa')
    await malo({ patron: 'redblue', bandos: { a: ['marce', 'nico'] } }, 'falta b')
    await malo({ patron: 'redblue', bandos: { a: 'marce', b: 'nico' } }, 'bandos no listas')
    await malo({ patron: 'redblue', bandos: { a: ['marce', 1], b: ['nico', 'betty'] } }, 'bando con no texto')
    await malo({ patron: 'revision' }, 'revisión sin documentos')
    await malo({ patron: 'revision', documentos: [] }, 'revisión con lista vacía')
    for (const s of ['archivos/../x.md', '/tmp/x.md', 'archivos/x.txt', 'reuniones/x.md', 5]) await malo({ salida: s }, `salida=${s}`)
    expect(f.sb.llamadas).toEqual([])
    expect(lista((await f.get('/api/reuniones')).obj.reuniones)).toEqual([])
    // los que sí: datos de otro patrón se ignoran
    const ok = await nueva(f, 'tema', ['marce', 'nico'], { patron: 'mapreduce', lider: 'lola', bandos: { a: 1 } })
    expect(ok.status).toBe(200)
    expect(ok.obj.patron).toBe('mapreduce')
    expect(ok.obj.lider === undefined && ok.obj.bandos === undefined).toBe(true)
    await aguardar(f, str(ok.obj.id))
    const rev = await nueva(f, 'tema', ['marce'], { patron: 'revision', documentos: ['doc'], salida: null })
    expect(rev.status).toBe(200)
    await aguardar(f, str(rev.obj.id))
  })

  test('patrones: por defecto es debate, con salida sugerida; el listado y el detalle devuelven patrón, líder, bandos y salida', async () => {
    const f = await fix(equipo4)
    const r = await nueva(f, 'Plan de lanzamiento')
    expect(r.obj.patron).toBe('debate')
    expect(r.obj.salida).toBe(`archivos/entregables/reuniones/${hoy()}-plan-de-lanzamiento.md`)
    expect(r.obj.lider === undefined && r.obj.bandos === undefined).toBe(true)
    await aguardar(f, str(r.obj.id))
    const l = lista((await f.get('/api/reuniones')).obj.reuniones)[0]!
    expect(l).toBeDefined()
    expect(l.patron).toBe('debate')
    expect(l.salida).toBe(`archivos/entregables/reuniones/${hoy()}-plan-de-lanzamiento.md`)
    const b = await nueva(f, 'Otro', ['marce', 'nico', 'betty', 'lola'], {
      patron: 'redblue', salida: ' archivos/mi/carpeta/x.md ', bandos: { a: ['marce', 'lola'], b: ['nico', 'betty'] },
    })
    expect(b.status).toBe(200)
    const id = str(b.obj.id)
    await aguardar(f, id)
    const d = await ver(f, id)
    expect(d.patron).toBe('redblue')
    expect(d.salida).toBe('archivos/mi/carpeta/x.md')
    const bd = d.bandos as Record<string, string[]> | undefined
    expect(bd?.a).toEqual(['marce', 'lola'])
    expect(bd?.b).toEqual(['nico', 'betty'])
    const li = await nueva(f, 'Tercero', ['marce', 'nico'], { patron: 'lider', lider: 'nico' })
    expect(li.obj.lider).toBe('nico')
    await aguardar(f, str(li.obj.id))
    const l2 = lista((await f.get('/api/reuniones')).obj.reuniones).find((x) => x.id === str(li.obj.id))
    expect(l2?.lider).toBe('nico')
    expect(l2?.patron).toBe('lider')
  })

  test('lider: en cada ronda abre el líder, opina el resto y cierra el líder; la consigna lo dice', async () => {
    const f = await fix()
    const r = await nueva(f, 'plan de lanzamiento', ['marce', 'nico', 'betty'], { patron: 'lider', lider: 'betty', rondas: 2 })
    expect(r.status).toBe(200)
    const base = r.obj.agentes as string[]
    const resto = base.filter((x) => x !== 'betty')
    const fin = await aguardar(f, str(r.obj.id))
    const t = turnos(fin)
    expect(t.map((x) => str(x.agente))).toEqual([...['betty', ...resto, 'betty'], ...['betty', ...resto, 'betty']])
    expect(t.map((x) => (x.ronda as number | undefined) ?? 0)).toEqual([1, 1, 1, 1, 2, 2, 2, 2])
    const p = promptsTurno(f)
    expect(p.length).toBe(8)
    expect(p[0]!.includes('Abrí la ronda') && p[0]!.includes('Sos Betty')).toBe(true)
    for (const i of [1, 2]) expect(p[i]!.includes('lidera la reunión y ya abrió la ronda') && p[i]!.includes('Betty (')).toBe(true)
    expect(p[3]!.includes('Cerrala con tu posición')).toBe(true)
    expect(p[4]!.includes('Abrí la ronda') && p[7]!.includes('Cerrala con tu posición')).toBe(true)
    // la síntesis sabe quién lideró
    const c = await f.post(`/api/reuniones/${str(r.obj.id)}/cerrar`)
    expect(c.status).toBe(200)
    expect((prompts(f).filter((x) => x.includes('secretario de actas')).at(-1) ?? '').includes('La reunión la lideró Betty')).toBe(true)
  })

  test('redblue: alternan A, B, A, B; la consigna dice de qué bando es cada uno; la síntesis pondera ambos', async () => {
    const f = await fix(equipo4)
    const r = await nueva(f, 'plan de lanzamiento', ['marce', 'nico', 'betty', 'lola'], {
      patron: 'redblue', bandos: { a: ['marce', 'betty'], b: ['nico', 'lola'] },
    })
    expect(r.status).toBe(200)
    const base = r.obj.agentes as string[]
    const a = base.filter((x) => ['marce', 'betty'].includes(x)), b = base.filter((x) => ['nico', 'lola'].includes(x))
    const fin = await aguardar(f, str(r.obj.id))
    expect(turnos(fin).map((t) => str(t.agente))).toEqual([a[0], b[0], a[1], b[1]])
    const p = promptsTurno(f)
    expect(p.length).toBe(4)
    expect(p[0]!.includes('del bando A: DEFENDÉS') && p[2]!.includes('del bando A: DEFENDÉS')).toBe(true)
    expect(p[1]!.includes('del bando B: CRITICÁS') && p[3]!.includes('del bando B: CRITICÁS')).toBe(true)
    expect(p[0]!.includes('Bando A (defiende') && p[0]!.includes('Bando B (la critica)')).toBe(true)
    await f.post(`/api/reuniones/${str(r.obj.id)}/cerrar`)
    const s = prompts(f).filter((x) => x.includes('secretario de actas')).at(-1)!
    expect(s).toBeDefined()
    expect(s.includes('ponderar los argumentos de ambos bandos')).toBe(true)
  })

  test('mapreduce: todos corren a la vez, sin ver los turnos de su ronda (sí los de rondas anteriores)', async () => {
    const f = await fix()
    for (const a of ['marce', 'nico', 'betty']) f.sb.modo(a, 'puerta')
    const r = await nueva(f, 'plan de lanzamiento', ['marce', 'nico', 'betty'], { patron: 'mapreduce', rondas: 2 })
    expect(r.status).toBe(200)
    const id = str(r.obj.id)
    // los tres procesos están esperando a la vez: ninguno terminó todavía
    expect(await esperar(() => {
      const s = new Set(f.sb.eventos.filter((e) => e.startsWith('S ')))
      return s.size === 3 && ['S marce', 'S nico', 'S betty'].every((x) => s.has(x))
    })).toBe(true)
    expect(f.sb.eventos.some((e) => e.startsWith('E '))).toBe(false)
    const g = await ver(f, id)
    expect(g.estado).toBe('en_curso')
    expect(turnos(g)).toEqual([])
    f.sb.abrirPuerta()
    const fin = await aguardar(f, id)
    expect(fin.estado).toBe('esperando')
    expect(turnos(fin).length).toBe(6)
    const esperados = new Set(['marce', 'nico', 'betty'])
    expect(new Set(turnos(fin).filter((t) => t.ronda === 1).map((t) => str(t.agente)))).toEqual(esperados)
    expect(new Set(turnos(fin).filter((t) => t.ronda === 2).map((t) => str(t.agente)))).toEqual(esperados)
    const p = promptsTurno(f)
    expect(p.length).toBe(6)
    const ronda1 = p.filter((x) => x.includes('estamos en la ronda 1')), ronda2 = p.filter((x) => x.includes('estamos en la ronda 2'))
    expect(ronda1.length === 3 && ronda2.length === 3).toBe(true)
    for (const x of ronda1) {
      expect(x.includes('Opinión de')).toBe(false)                      // nadie vio a nadie
      expect(x.includes('(todavía no habló nadie)')).toBe(true)
      expect(x.includes('cada participante responde por separado')).toBe(true)
    }
    for (const x of ronda2) {
      expect(x.includes('— Ronda 1 —')).toBe(true)
      expect(['Opinión de marce', 'Opinión de nico', 'Opinión de betty'].every((o) => x.includes(o))).toBe(true)
      expect(x.includes('— Ronda 2 —')).toBe(false)
    }
    // el costo se registra por turno, como siempre (6 x 0.02)
    expect(await esperar(async () => (((await f.get('/api/costos')).obj.total as number | undefined) ?? 0) > 0.11)).toBe(true)
  })

  test('revision: cada uno revisa los documentos adjuntos desde su rol', async () => {
    const f = await fix()
    escribir('# Guion\nFICHA_GUION: abrir con un gancho', f.ruta('conocimiento/fuentes/guion.md'))
    const r = await nueva(f, 'revisar el guion', ['marce', 'nico'], { patron: 'revision', documentos: ['guion'] })
    expect(r.status).toBe(200)
    const id = str(r.obj.id)
    const fin = await aguardar(f, id)
    expect(turnos(fin).length).toBe(2)
    for (const x of promptsTurno(f)) {
      expect(x.includes('panel de revisión') && x.includes('hallazgos') && x.includes('FICHA_GUION')).toBe(true)
    }
    const c = await f.post(`/api/reuniones/${id}/cerrar`)
    expect(c.status).toBe(200)
    expect((prompts(f).filter((x) => x.includes('secretario de actas')).at(-1) ?? '').includes('cambios recomendados')).toBe(true)
    // el archivo de salida llama «Cambios recomendados» a las decisiones
    expect(f.leer(str(c.obj.salida)).includes('## Cambios recomendados')).toBe(true)
  })

  // MARK: archivo de salida

  test('salida: al cerrar el backend escribe el markdown (por defecto o el pedido), crea carpetas y agrega -2 si existe', async () => {
    const f = await fix()
    const r = await nueva(f, 'Plan de lanzamiento', ['marce', 'nico'], { patron: 'lider', lider: 'nico' })
    const id = str(r.obj.id)
    await aguardar(f, id)
    expect(f.existe(str(r.obj.salida))).toBe(false)                   // todavía no: se escribe al cerrar
    const c = await f.post(`/api/reuniones/${id}/cerrar`)
    expect(c.status).toBe(200)
    const rel = `archivos/entregables/reuniones/${hoy()}-plan-de-lanzamiento.md`
    expect(c.obj.salida).toBe(rel)
    expect(c.obj.salidaRuta).toBe(f.ruta(rel))
    expect(c.obj.error).toBeUndefined()
    const md = f.leer(rel)
    expect(md.startsWith('# Plan de lanzamiento')).toBe(true)
    expect(md.includes('**Patrón:** Líder y equipo') && md.includes('**Líder:** Nico')).toBe(true)
    expect(md.includes('## Resumen') && md.includes('Se acordó avanzar con el plan.')).toBe(true)
    expect(md.includes('## Decisiones') && md.includes('- Lanzar en diciembre')).toBe(true)
    expect(md.includes('## Pendientes') && md.includes('- **Marce:** Armar el calendario')).toBe(true)
    expect(md.includes('`' + str(c.obj.acta) + '`')).toBe(true)
    expect(f.existe(str(c.obj.acta))).toBe(true)                      // el acta sigue como siempre
    // misma ruta otra vez: sufijo -2, y el campo apunta al archivo real
    const r2 = await nueva(f, 'Plan de lanzamiento', ['marce'])
    await aguardar(f, str(r2.obj.id))
    const c2 = await f.post(`/api/reuniones/${str(r2.obj.id)}/cerrar`)
    expect(c2.obj.salida).toBe(`archivos/entregables/reuniones/${hoy()}-plan-de-lanzamiento-2.md`)
    expect(f.existe(str(c2.obj.salida))).toBe(true)
    // ruta pedida, con carpetas intermedias nuevas
    const r3 = await nueva(f, 'x', ['marce'], { salida: 'archivos/a/b/c/informe.md' })
    await aguardar(f, str(r3.obj.id))
    const c3 = await f.post(`/api/reuniones/${str(r3.obj.id)}/cerrar`)
    expect(c3.obj.salida).toBe('archivos/a/b/c/informe.md')
    expect(f.leer('archivos/a/b/c/informe.md').includes('**Patrón:** Debate')).toBe(true)
    expect((await ver(f, str(r3.obj.id))).salidaRuta).toBe(f.ruta('archivos/a/b/c/informe.md'))
  })

  test('salida: si no hubo síntesis igual se escribe, avisándolo; si no se puede escribir se informa y el cierre sigue', async () => {
    const f = await fix()
    f.sb.modo('acta', 'nojson')
    const r = await nueva(f, 'sin sintesis', ['marce'])
    await aguardar(f, str(r.obj.id))
    const c = await f.post(`/api/reuniones/${str(r.obj.id)}/cerrar`)
    expect(c.obj.errorSintesis).toBeDefined()
    expect(f.leer(str(c.obj.salida)).includes('No se pudo generar la síntesis')).toBe(true)
    // «archivos/estorbo» es un archivo: no se pueden crear las carpetas
    f.sb.modo('acta', null)
    escribir('estorbo', f.ruta('archivos/estorbo'))
    const r2 = await nueva(f, 'con estorbo', ['marce'], { salida: 'archivos/estorbo/x.md' })
    await aguardar(f, str(r2.obj.id))
    const c2 = await f.post(`/api/reuniones/${str(r2.obj.id)}/cerrar`)
    expect(c2.status).toBe(200)
    expect(c2.obj.estado).toBe('cerrada')
    expect(str(c2.obj.error).includes('archivo de salida')).toBe(true)
    expect(c2.obj.salidaRuta).toBeUndefined()
    expect(f.existe(str(c2.obj.acta))).toBe(true)                     // el acta se guardó igual
  })
})
