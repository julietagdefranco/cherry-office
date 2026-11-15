// Port de app/Tests/BackendTests/PermisosVivosTests.swift (la parte de punta a punta; la lógica pura va en
// test/unit/permisos-vivos.test.ts).
// Pedidos de permiso en vivo: claude `--permission-prompt-tool mcp__hq__pedir_permiso` en los chats, la tarjeta de la
// oficina (`permisos` en /api/actividad) y la respuesta (`POST /api/permisos/<id>`), con «Siempre» guardado en el agente.
// El claude falso, con `PERMISO:<comando>`, llama a `pedir_permiso` y espera la respuesta (la deja en mcp.<agente>.out).
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, U, chat, dict, esperar, leerTexto, lista, str, type Obj } from '../support/sandbox.js'

const fix = (env?: Record<string, string>) => Fix.crear({ agentes: [{ id: 'marce', depto: 'redes' }], env })
const pendientes = async (f: Fix): Promise<Obj[]> => lista((await f.get('/api/actividad')).obj.permisos)
const parsear = (s: string): Obj => { try { return dict(JSON.parse(s)) } catch { return {} } }
/** Lo que `pedir_permiso` le contestó al claude falso (el JSON de la respuesta, ya desarmado). */
const respuestaMCP = (f: Fix): Obj => {
  const out = parsear(leerTexto(`${f.sb.binDir}/mcp.marce.out`).trim())
  return parsear(str(lista(dict(out.result).content)[0]?.text))
}
const agente = (f: Fix): Obj | undefined => lista(f.oficinaJSON().agentes).find((a) => str(a.id) === 'marce')

describe('Permisos en vivo', () => {
  test('chat: el pedido aparece en /api/actividad; «Siempre» lo deja pasar, lo guarda en el agente y va a --allowedTools después', async () => {
    const f = await fix()
    expect(await pendientes(f)).toEqual([])
    const chatA = chat(f.b, { agent: 'marce', message: 'PERMISO:git pull origin main', session: U.a })
    expect(await esperar(async () => (await pendientes(f)).length === 1, 10)).toBe(true)
    const p = (await pendientes(f))[0]!
    expect(str(p.agente)).toBe('marce')
    expect(str(p.herramienta)).toBe('Bash')
    expect(str(p.detalle)).toBe('git pull origin main')
    expect(str(p.descripcion)).toBe('Prueba')
    expect(p.reglas).toEqual(['Bash(git pull:*)'])
    expect(typeof p.ts).toBe('number')

    const r = await f.post(`/api/permisos/${str(p.id)}`, { decision: 'siempre' })
    expect(r.status).toBe(200)
    expect(r.obj.reglas).toEqual(['Bash(git pull:*)'])
    expect((await chatA).status).toBe(200)
    expect(str(respuestaMCP(f).behavior)).toBe('allow')
    expect(await pendientes(f)).toEqual([])
    // quedó en oficina.json y en el siguiente chat va a --tools y a --allowedTools
    expect(agente(f)?.reglas).toEqual(['Bash(git pull:*)'])
    await chat(f.b, { agent: 'marce', message: 'hola', session: U.b })
    const l = f.sb.llamadas.at(-1)!
    expect(Sandbox.reglas(l)).toContain('Bash(git pull:*)')
    expect(Sandbox.valor(l, '--tools')?.split(',')).toContain('Bash')
    // y se puede quitar desde la pestaña Permisos (PATCH con reglas vacías borra la clave)
    expect((await f.patch('/api/agentes/marce', { reglas: [] })).status).toBe(200)
    expect(agente(f)?.reglas).toBeUndefined()
    expect((await f.patch('/api/agentes/marce', { reglas: ['Bash'] })).status).toBe(400)
  })

  test('chat: «No» rechaza (deny) sin guardar nada; un pedido inexistente da 404 y una decisión inválida 400', async () => {
    const f = await fix()
    expect((await f.post('/api/permisos/no-existe', { decision: 'una_vez' })).status).toBe(404)
    const chatA = chat(f.b, { agent: 'marce', message: 'PERMISO:rm -rf build', session: U.a })
    expect(await esperar(async () => (await pendientes(f)).length === 1, 10)).toBe(true)
    const id = str((await pendientes(f))[0]!.id)
    const mal = await f.post(`/api/permisos/${id}`, { decision: 'quizas' })
    expect(mal.status).toBe(400)
    expect(str(mal.obj.error)).toBe('«decision» tiene que ser una_vez, siempre o rechazar.')
    expect((await f.post(`/api/permisos/${id}`, { decision: 'rechazar' })).status).toBe(200)
    expect((await chatA).status).toBe(200)
    expect(str(respuestaMCP(f).behavior)).toBe('deny')
    expect(agente(f)?.reglas).toBeUndefined()
    expect((await f.post(`/api/permisos/${id}`, { decision: 'una_vez' })).status).toBe(404)
  })

  test('chat: un comando compuesto solo se permite una vez («Siempre» da 400); si nadie responde, vence y se rechaza', async () => {
    const f = await fix({ HQ_PERMISO_TIMEOUT: '1' })
    const chatA = chat(f.b, { agent: 'marce', message: 'PERMISO:git pull && make', session: U.a })
    expect(await esperar(async () => (await pendientes(f)).length === 1, 10)).toBe(true)
    const p = (await pendientes(f))[0]!
    expect(p.reglas).toEqual([])
    const r = await f.post(`/api/permisos/${str(p.id)}`, { decision: 'siempre' })
    expect(r.status).toBe(400)
    expect(str(r.obj.error)).toBe('Esto solo se puede permitir una vez.')
    expect((await chatA).status).toBe(200)
    const res = respuestaMCP(f)
    expect(str(res.behavior)).toBe('deny')
    expect(str(res.message)).toContain('Nadie respondió')
    expect(await pendientes(f)).toEqual([])
  })
})
