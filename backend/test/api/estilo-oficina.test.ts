// Estilo de la oficina (`estilo_oficina` en config.json): «pixel» (por defecto) dibuja la oficina en pixel art;
// «lego» deja la maqueta 3D. Las claves `px*` del avatar guardan la apariencia pixel sin pisar la de LEGO.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, llamar } from '../support/sandbox.js'

const fix = () => Fix.crear({ deps: ['Dirección'], agentes: [{ id: 'marce', depto: 'direccion', rol: 'Directora' }], env: { HQ_PROGRAMADOR: '0' } })
const leerJSON = (ruta: string) => JSON.parse(fs.readFileSync(ruta, 'utf8'))

describe('Estilo de la oficina', () => {
  test('sin elegir: pixel en /api/estado y /api/preferencias', async () => {
    const f = await fix()
    expect((await llamar(f.b, 'GET', '/api/estado')).obj.estilo_oficina).toBe('pixel')
    expect((await llamar(f.b, 'GET', '/api/preferencias')).obj.estilo_oficina).toBe('pixel')
  })

  test('valida el valor', async () => {
    const f = await fix()
    expect((await llamar(f.b, 'PUT', '/api/preferencias', { body: { estilo_oficina: 'acuarela' } })).status).toBe(400)
  })

  test('se guarda en config.json y sobrevive al reinicio', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    const r = await llamar(b, 'PUT', '/api/preferencias', { body: { estilo_oficina: 'lego' } })
    expect(r.status).toBe(200)
    expect(r.obj.estilo_oficina).toBe('lego')
    expect(leerJSON(path.join(sb.datos, 'config.json')).estilo_oficina).toBe('lego')
    await b.cerrar()
    const b2 = await sb.backend({ oficina: false })
    expect((await llamar(b2, 'GET', '/api/estado')).obj.estilo_oficina).toBe('lego')
  })

  test('el avatar guarda las claves pixel junto a las de LEGO', async () => {
    const f = await fix()
    const r = await llamar(f.b, 'PATCH', '/api/agentes/marce', { body: { avatar: { pelo: 'pelo-corto', pxPelo: 'bob', pxArriba: 'campera', pxAbajo: 'pollera', pxAccesorio: 'gorra', colorTorso: '#E2574C' } } })
    expect(r.status).toBe(200)
    const av = (await llamar(f.b, 'GET', '/api/agentes/marce')).obj.agente.avatar
    expect(av).toMatchObject({ pelo: 'pelo-corto', pxPelo: 'bob', pxArriba: 'campera', pxAbajo: 'pollera', pxAccesorio: 'gorra', colorTorso: '#e2574c' })
  })
})
