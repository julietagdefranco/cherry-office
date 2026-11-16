// Modo de permisos de toda la app (`modo_permisos` en config.json): «auto» corre a los agentes con
// `--permission-mode auto` (un clasificador de Claude Code decide; lo que frena va a la tarjeta o a los pedidos de la
// tarea); «preguntar» o sin elegir deja el comportamiento de siempre (default con la persona, dontAsk sin ella).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, U, chat, llamar } from '../support/sandbox.js'

const fix = () => Fix.crear({ deps: ['Dirección'], agentes: [{ id: 'marce', depto: 'direccion', rol: 'Directora' }], env: { HQ_PROGRAMADOR: '0' } })
const leerJSON = (ruta: string) => JSON.parse(fs.readFileSync(ruta, 'utf8'))

describe('Modo de permisos', () => {
  test('sin elegir: /api/estado y /api/preferencias dan null y el chat sigue en default', async () => {
    const f = await fix()
    expect((await llamar(f.b, 'GET', '/api/estado')).obj.modo_permisos).toBeNull()
    expect((await llamar(f.b, 'GET', '/api/preferencias')).obj.modo_permisos).toBeNull()
    await chat(f.b, { agent: 'marce', message: 'hola', session: U.a })
    const l = f.sb.llamadas.at(-1)!
    expect(Sandbox.valor(l, '--permission-mode')).toBe('default')
  })

  test('valida el valor', async () => {
    const f = await fix()
    expect((await llamar(f.b, 'PUT', '/api/preferencias', { body: { modo_permisos: 'todo' } })).status).toBe(400)
    expect((await llamar(f.b, 'PUT', '/api/preferencias', { body: {} })).status).toBe(400)
  })

  test('auto: el chat corre en modo auto, sigue preguntando lo que frena el clasificador y ve Bash, Edit y Write', async () => {
    const f = await fix()
    const r = await llamar(f.b, 'PUT', '/api/preferencias', { body: { modo_permisos: 'auto' } })
    expect(r.status).toBe(200)
    expect(r.obj.modo_permisos).toBe('auto')
    await chat(f.b, { agent: 'marce', message: 'hola', session: U.a })
    const l = f.sb.llamadas.at(-1)!
    expect(Sandbox.valor(l, '--permission-mode')).toBe('auto')
    expect(Sandbox.valor(l, '--permission-prompt-tool')).toBe('mcp__hq__pedir_permiso')
    expect(Sandbox.valor(l, '--tools')?.split(',')).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']))
    // la veda de conectores sigue: una regla de prohibición le gana al clasificador
    expect(Sandbox.valor(l, '--disallowedTools')).toBe('mcp__claude_ai_*')

    // volver a preguntar: default otra vez
    await llamar(f.b, 'PUT', '/api/preferencias', { body: { modo_permisos: 'preguntar' } })
    await chat(f.b, { agent: 'marce', message: 'hola de nuevo', session: U.b })
    expect(Sandbox.valor(f.sb.llamadas.at(-1)!, '--permission-mode')).toBe('default')
  })

  test('se guarda en config.json y sobrevive al reinicio', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    await llamar(b, 'PUT', '/api/preferencias', { body: { modo_permisos: 'auto' } })
    const cfg = leerJSON(path.join(sb.datos, 'config.json'))
    expect(cfg.modo_permisos).toBe('auto')
    expect(cfg.oficina_activa).toBe(sb.proyecto)
    await b.cerrar()
    const b2 = await sb.backend({ oficina: false })
    expect((await llamar(b2, 'GET', '/api/estado')).obj.modo_permisos).toBe('auto')
  })
})
