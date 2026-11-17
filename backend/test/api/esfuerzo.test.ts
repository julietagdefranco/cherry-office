// Modelo y esfuerzo: el esfuerzo por defecto de cada agente (oficina.json) y la elección de una charla (chat, reunión),
// que pisa los del agente solo en esa corrida. Sin nada elegido no se pasa `--effort` (queda el de Claude Code).
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, esperar, llamar, type Obj } from '../support/sandbox.js'

const U1 = '11111111-1111-4111-8111-111111111111'
const fix = () => Fix.crear({ deps: ['Dirección'], agentes: [{ id: 'sofia', depto: 'direccion', rol: 'Directora' }, { id: 'marce', depto: 'direccion', rol: 'Analista' }], env: { HQ_PROGRAMADOR: '0' } })
const chatear = (f: Fix, body: Obj = {}) => f.post('/api/chat', { agent: 'sofia', session: U1, message: 'hola', ...body })
/** La última corrida de `agente` (descarta los resúmenes, que corren sin agente). */
const corridaDe = (f: Fix, agente: string) => f.sb.llamadas.filter((a) => Sandbox.valor(a, '--agent') === agente).at(-1)!

describe('Modelo y esfuerzo', () => {
  test('sin elegir nada: ni --effort ni --model (manda el .md del agente)', async () => {
    const f = await fix()
    expect((await chatear(f)).status).toBe(200)
    const a = corridaDe(f, 'sofia')
    expect(a.includes('--effort')).toBe(false)
    expect(a.includes('--model')).toBe(false)
  })

  test('la charla elige modelo y esfuerzo: llegan a claude solo en ese mensaje', async () => {
    const f = await fix()
    expect((await chatear(f, { modelo: 'haiku', esfuerzo: 'low' })).status).toBe(200)
    let a = corridaDe(f, 'sofia')
    expect(Sandbox.valor(a, '--model')).toBe('haiku')
    expect(Sandbox.valor(a, '--effort')).toBe('low')
    expect((await chatear(f, { message: 'otra' })).status).toBe(200)
    a = corridaDe(f, 'sofia')
    expect(a.includes('--effort')).toBe(false)
    expect(a.includes('--model')).toBe(false)
  })

  test('valores inválidos: 400', async () => {
    const f = await fix()
    expect((await chatear(f, { esfuerzo: 'muchisimo' })).status).toBe(400)
    expect((await chatear(f, { modelo: 'gpt' })).status).toBe(400)
  })

  test('esfuerzo del agente: se guarda en su ficha, vale por defecto y la charla lo pisa', async () => {
    const f = await fix()
    expect((await f.patch('/api/agentes/sofia', { esfuerzo: 'medium' })).status).toBe(200)
    expect((await f.patch('/api/agentes/sofia', { esfuerzo: 'enorme' })).status).toBe(400)
    await chatear(f)
    expect(Sandbox.valor(corridaDe(f, 'sofia'), '--effort')).toBe('medium')
    await chatear(f, { message: 'difícil', esfuerzo: 'high' })
    expect(Sandbox.valor(corridaDe(f, 'sofia'), '--effort')).toBe('high')
    // '' vuelve al de Claude Code
    expect((await f.patch('/api/agentes/sofia', { esfuerzo: '' })).status).toBe(200)
    await chatear(f, { message: 'sin esfuerzo' })
    expect(corridaDe(f, 'sofia').includes('--effort')).toBe(false)
  })

  test('reunión: el modelo y el esfuerzo elegidos valen para todos los turnos', async () => {
    const f = await fix()
    const r = await f.post('/api/reuniones', { tema: 'Plan', agentes: ['sofia', 'marce'], modelo: 'haiku', esfuerzo: 'low' })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(r.obj.modelo).toBe('haiku')
    expect(r.obj.esfuerzo).toBe('low')
    await esperar(() => f.sb.llamadas.some((a) => Sandbox.valor(a, '--agent') === 'marce'))
    for (const ag of ['sofia', 'marce']) {
      const a = corridaDe(f, ag)
      expect(Sandbox.valor(a, '--model')).toBe('haiku')
      expect(Sandbox.valor(a, '--effort')).toBe('low')
    }
  })
})

describe('Consumo de IA (Ajustes y charla)', () => {
  const herramientas = (a: string[]) => Sandbox.valor(a, '--tools') ?? ''
  const instrucciones = (a: string[]) => Sandbox.valor(a, '--append-system-prompt') ?? ''

  test('por defecto: Skill, colegas y memoria completa, como siempre', async () => {
    const f = await fix()
    expect((await f.get('/api/preferencias')).obj.ia).toEqual({ esfuerzo: '', skills: true, memoria: 'completa', colegas: true })
    await chatear(f)
    const a = corridaDe(f, 'sofia')
    expect(herramientas(a).split(',')).toContain('Skill')
    expect(instrucciones(a)).not.toContain('modo liviano')
  })

  test('Ajustes: sin skills, memoria liviana, sin colegas y esfuerzo bajo valen para todo', async () => {
    const f = await fix()
    const r = await llamar(f.b, 'PUT', '/api/preferencias', { body: { ia: { skills: false, memoria: 'liviana', colegas: false, esfuerzo: 'low' } } })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(r.obj.ia).toEqual({ esfuerzo: 'low', skills: false, memoria: 'liviana', colegas: false })
    await chatear(f)
    const a = corridaDe(f, 'sofia')
    const t = herramientas(a).split(',')
    expect(t).not.toContain('Skill')
    expect(a).not.toContain('Skill')
    expect(t.some((h) => h.endsWith('__consultar'))).toBe(false)
    expect(t.some((h) => h.endsWith('__buscar'))).toBe(true)
    expect(instrucciones(a)).toContain('modo liviano')
    expect(Sandbox.valor(a, '--effort')).toBe('low')
    // el esfuerzo del agente le gana al de la app
    await f.patch('/api/agentes/sofia', { esfuerzo: 'high' })
    await chatear(f, { message: 'otra' })
    expect(Sandbox.valor(corridaDe(f, 'sofia'), '--effort')).toBe('high')
  })

  test('la charla pisa lo de Ajustes', async () => {
    const f = await fix()
    await llamar(f.b, 'PUT', '/api/preferencias', { body: { ia: { skills: false, memoria: 'liviana' } } })
    await chatear(f, { skills: true, memoria: 'completa' })
    const a = corridaDe(f, 'sofia')
    expect(herramientas(a).split(',')).toContain('Skill')
    expect(instrucciones(a)).not.toContain('modo liviano')
    expect((await chatear(f, { memoria: 'media' })).status).toBe(400)
    expect((await chatear(f, { skills: 'no' })).status).toBe(400)
  })

  test('valida y guarda en config.json', async () => {
    const f = await fix()
    expect((await llamar(f.b, 'PUT', '/api/preferencias', { body: { ia: { memoria: 'poca' } } })).status).toBe(400)
    expect((await llamar(f.b, 'PUT', '/api/preferencias', { body: { ia: { otra: true } } })).status).toBe(400)
    expect((await llamar(f.b, 'PUT', '/api/preferencias', { body: { ia: { esfuerzo: 'mucho' } } })).status).toBe(400)
    await llamar(f.b, 'PUT', '/api/preferencias', { body: { ia: { skills: false } } })
    expect((await f.get('/api/estado')).obj.ia.skills).toBe(false)
  })

  test('reunión nueva con memoria liviana: cada turno lo recibe', async () => {
    const f = await fix()
    const r = await f.post('/api/reuniones', { tema: 'Plan', agentes: ['sofia', 'marce'], memoria: 'liviana' })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(r.obj.memoria).toBe('liviana')
    await esperar(() => f.sb.llamadas.some((a) => Sandbox.valor(a, '--agent') === 'marce'))
    expect(instrucciones(corridaDe(f, 'marce'))).toContain('modo liviano')
  })
})
