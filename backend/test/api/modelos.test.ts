// Modelos de los procesos que no son un agente (`modelos` en config.json, toda la app): el Creador, los internos
// (borradores, fichas, imágenes, síntesis) y los resúmenes. `inherit` no pasa `--model` (queda el de Claude Code).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { creadorMD } from '../../src/plantillas.js'
import { Fix, Sandbox, llamar } from '../support/sandbox.js'

const fix = () => Fix.crear({ deps: ['Dirección'], agentes: [{ id: 'marce', depto: 'direccion', rol: 'Directora' }], env: { HQ_PROGRAMADOR: '0' } })
const borrador = (f: Fix) => f.post('/api/agentes/borrador', { descripcion: 'alguien que mida', departamento: 'direccion' })

describe('Modelos de los procesos internos', () => {
  test('por defecto: sonnet, sonnet y haiku; el borrador corre con sonnet', async () => {
    const f = await fix()
    expect((await llamar(f.b, 'GET', '/api/preferencias')).obj.modelos).toEqual({ creador: 'sonnet', internos: 'sonnet', resumenes: 'haiku' })
    expect((await llamar(f.b, 'GET', '/api/estado')).obj.modelos).toEqual({ creador: 'sonnet', internos: 'sonnet', resumenes: 'haiku' })
    f.sb.modo('borrador', 'vacio')
    await borrador(f)
    expect(Sandbox.valor(f.sb.llamadas.at(-1)!, '--model')).toBe('sonnet')
  })

  test('valida claves y valores', async () => {
    const f = await fix()
    expect((await llamar(f.b, 'PUT', '/api/preferencias', { body: { modelos: 'opus' } })).status).toBe(400)
    expect((await llamar(f.b, 'PUT', '/api/preferencias', { body: { modelos: { internos: 'gpt' } } })).status).toBe(400)
    expect((await llamar(f.b, 'PUT', '/api/preferencias', { body: { modelos: { otro: 'opus' } } })).status).toBe(400)
  })

  test('cambiar uno deja los demás; opus llega al borrador e inherit no pasa --model', async () => {
    const f = await fix()
    const r = await llamar(f.b, 'PUT', '/api/preferencias', { body: { modelos: { internos: 'opus' } } })
    expect(r.status).toBe(200)
    expect(r.obj.modelos).toEqual({ creador: 'sonnet', internos: 'opus', resumenes: 'haiku' })
    f.sb.modo('borrador', 'vacio')
    await borrador(f)
    expect(Sandbox.valor(f.sb.llamadas.at(-1)!, '--model')).toBe('opus')

    await llamar(f.b, 'PUT', '/api/preferencias', { body: { modelos: { internos: 'inherit' } } })
    await borrador(f)
    expect(f.sb.llamadas.at(-1)!.includes('--model')).toBe(false)
  })

  test('se guarda en config.json (solo lo cambiado) y sobrevive al reinicio', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    await llamar(b, 'PUT', '/api/preferencias', { body: { modelos: { creador: 'opus' } } })
    const cfg = JSON.parse(fs.readFileSync(path.join(sb.datos, 'config.json'), 'utf8'))
    expect(cfg.modelos).toEqual({ creador: 'opus' })
    await b.cerrar()
    const b2 = await sb.backend({ oficina: false })
    expect((await llamar(b2, 'GET', '/api/preferencias')).obj.modelos.creador).toBe('opus')
  })

  test('el .md del Creador lleva el modelo elegido', () => {
    const of = { version: 1, nombre: 'Taller', duenio: 'Ana', departamentos: [], agentes: [] }
    expect(creadorMD(of)).toContain('\nmodel: sonnet\n')
    expect(creadorMD(of, 'opus')).toContain('\nmodel: opus\n')
  })
})
