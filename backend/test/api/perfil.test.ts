// Port de app/Tests/BackendTests/PerfilTests.swift.
// Perfil (YO): quien dirige cada oficina, guardado en su oficina.json (duenio + avatarDuenio).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { Sandbox, dict, llamar } from '../support/sandbox.js'

const leerJSON = (ruta: string) => JSON.parse(fs.readFileSync(ruta, 'utf8'))

describe('Perfil de quien dirige', () => {
  test('sin minifig: el perfil es el dueño de la oficina activa', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    const r = await llamar(b, 'GET', '/api/perfil')
    expect(r.status).toBe(200)
    expect(dict(r.obj.perfil).nombre).toBe('Tester')
    expect(dict(r.obj.perfil).avatar).toBeNull()
    const e = await llamar(b, 'GET', '/api/estado')
    expect(dict(e.obj.perfil).nombre).toBe('Tester')
    expect(dict((await llamar(b, 'GET', '/api/oficina')).obj.oficina).duenio).toBe('Tester')
  })

  test('guardar: queda en el oficina.json de la oficina activa (nombre y minifig) y sobrevive al reinicio', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    const r = await llamar(b, 'PUT', '/api/perfil', {
      body: { nombre: '  Luis ', avatar: { colorTorso: '#141414', pelo: 'corto', colorPiel: '#f2c79b' } },
    })
    expect(r.status).toBe(200)
    const p = dict(r.obj.perfil)
    expect(p.nombre).toBe('Luis')
    expect(dict(p.avatar).semilla).toBe('yo')
    expect(dict(p.avatar).colorTorso).toBe('#141414')
    expect(dict(p.avatar).colorPiel).toBe('#f2c79b')
    expect(dict(r.obj.oficina).duenio).toBe('Luis')
    const of = leerJSON(path.join(sb.proyecto, 'oficina.json'))
    expect(of.duenio).toBe('Luis')
    expect(dict(of.avatarDuenio).pelo).toBe('corto')
    // ya no hay un perfil global en config.json
    const cfg = leerJSON(path.join(sb.datos, 'config.json'))
    expect(cfg.perfil).toBeUndefined()
    expect(cfg.oficina_activa).toBe(sb.proyecto)

    await b.cerrar()
    const b2 = await sb.backend({ oficina: false })
    const p2 = dict((await llamar(b2, 'GET', '/api/perfil')).obj.perfil)
    expect(p2.nombre).toBe('Luis')
    expect(dict(p2.avatar).colorTorso).toBe('#141414')
  })

  test('cada oficina tiene su propio director: crear o abrir otra no lo pisa', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    await llamar(b, 'PUT', '/api/perfil', { body: { nombre: 'Luis', avatar: { pelo: 'corto' } } })
    const n = await llamar(b, 'POST', '/api/oficinas', { body: { nombre: 'Taller', duenio: 'Ana' } })
    expect(dict(n.obj.oficina).duenio).toBe('Ana')
    expect(dict((await llamar(b, 'GET', '/api/perfil')).obj.perfil).nombre).toBe('Ana')
    await llamar(b, 'PUT', '/api/perfil', { body: { nombre: 'Ana', avatar: { pelo: 'largo' } } })
    // una oficina vieja con otro dueño: al abrirla lo conserva
    const vieja = path.join(sb.home, 'Vieja')
    fs.mkdirSync(vieja, { recursive: true })
    fs.writeFileSync(path.join(vieja, 'oficina.json'), JSON.stringify({ version: 1, nombre: 'Vieja', duenio: 'Juli', departamentos: [], agentes: [] }))
    expect((await llamar(b, 'POST', '/api/oficinas/abrir', { body: { carpeta: vieja } })).status).toBe(200)
    expect(dict((await llamar(b, 'GET', '/api/oficina')).obj.oficina).duenio).toBe('Juli')
    // volver a la primera: sigue siendo Luis, con su minifig
    expect((await llamar(b, 'POST', '/api/oficinas/abrir', { body: { carpeta: sb.proyecto } })).status).toBe(200)
    const p = dict((await llamar(b, 'GET', '/api/perfil')).obj.perfil)
    expect(p.nombre).toBe('Luis')
    expect(dict(p.avatar).pelo).toBe('corto')
  })

  test('migración: el perfil global viejo le pasa su minifig a las oficinas que dirigía', async () => {
    const sb = new Sandbox()
    const b0 = await sb.backend()
    await llamar(b0, 'PUT', '/api/perfil', { body: { nombre: 'Tester' } })
    await b0.cerrar()
    // config.json como lo dejaba la versión anterior
    const ruta = path.join(sb.datos, 'config.json')
    const cfg = leerJSON(ruta)
    cfg.perfil = { nombre: 'Tester', avatar: { semilla: 'yo', pelo: 'corto' } }
    fs.writeFileSync(ruta, JSON.stringify(cfg))
    const rutaOf = path.join(sb.proyecto, 'oficina.json')
    const of = leerJSON(rutaOf)
    delete of.avatarDuenio
    fs.writeFileSync(rutaOf, JSON.stringify(of))
    const b = await sb.backend({ oficina: false })
    const p = dict((await llamar(b, 'GET', '/api/perfil')).obj.perfil)
    expect(p.nombre).toBe('Tester')
    expect(dict(p.avatar).pelo).toBe('corto')
  })

  test('validación: nombre largo y avatar inválido', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    expect((await llamar(b, 'PUT', '/api/perfil', { body: { nombre: 'x'.repeat(81) } })).status).toBe(400)
    expect((await llamar(b, 'PUT', '/api/perfil', { body: { nombre: 'Luis', avatar: { colorPelo: 'rojo' } } })).status).toBe(400)
    expect((await llamar(b, 'PATCH', '/api/perfil', { body: { nombre: 'Luis' } })).status).toBe(405)
  })
})
