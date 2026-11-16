// Port de app/Tests/BackendTests/CasoProsperaTests.swift.
// Los tests que arman un Banco in-process (b.store, b.mcp.tokens, Creador.herramientas, CatalogoConectores, programador)
// quedan como test.skip: son unit tests del port.
import { describe, expect, test } from 'vitest'
import { Fix, dict, lista, str, type Obj, type Resp } from '../support/sandbox.js'

describe('Caso Próspera de punta a punta', () => {
  // MARK: el caso completo

  // interno: usa el Banco del Creador (store.asegurarSesion/agregar, mcp.tokens.emitir, Creador.herramientas) y CatalogoConectores.compartido.
  test.skip('las tarjetas del caso coinciden con el mapeo, aplicarlas deja la oficina válida y F1 llega al paso de la persona', () => {})

  // MARK: misión en departamentos (API)

  test('POST y PATCH de departamentos aceptan «mision» (hasta 600; vacía la borra)', async () => {
    const f = await Fix.crear({ deps: ['Dirección'] })
    const c = await f.post('/api/departamentos', { nombre: 'Ventas', mision: '  Vender mejor.  ' })
    expect(c.status === 200 && str(dict(c.obj.departamento).mision) === 'Vender mejor.', JSON.stringify(c.obj)).toBe(true)
    expect(lista(f.oficinaJSON().departamentos).find((d) => str(d.id) === 'ventas')?.mision).toBe('Vender mejor.')
    // sin misión: la clave no está
    const sin = await f.post('/api/departamentos', { nombre: 'Soporte' })
    expect(sin.status === 200 && dict(sin.obj.departamento).mision == null).toBe(true)
    // PATCH cambia, no tocar la deja igual, null y vacía la borran
    const p = await f.patch('/api/departamentos/ventas', { mision: 'Vender más.' })
    expect(p.status === 200 && str(dict(p.obj.departamento).mision) === 'Vender más.').toBe(true)
    const otro = await f.patch('/api/departamentos/ventas', { color: '#112233' })
    expect(str(dict(otro.obj.departamento).mision) === 'Vender más.' && str(dict(otro.obj.departamento).color) === '#112233').toBe(true)
    const vacia = await f.patch('/api/departamentos/ventas', { mision: '' })
    expect(vacia.status === 200 && dict(vacia.obj.departamento).mision == null).toBe(true)
    await f.patch('/api/departamentos/ventas', { mision: 'Otra vez.' })
    const nula = await f.patch('/api/departamentos/ventas', { mision: null })
    expect(nula.status === 200 && dict(nula.obj.departamento).mision == null).toBe(true)
    // tope de 600 caracteres y tipo
    const justo = 'm'.repeat(600)
    expect((await f.patch('/api/departamentos/ventas', { mision: justo })).status).toBe(200)
    expect((await f.patch('/api/departamentos/ventas', { mision: justo + 'm' })).status).toBe(400)
    expect((await f.post('/api/departamentos', { nombre: 'Larga', mision: justo + 'm' })).status).toBe(400)
    expect((await f.patch('/api/departamentos/ventas', { mision: 5 })).status).toBe(400)
    expect(lista(f.oficinaJSON().departamentos).find((d) => str(d.id) === 'ventas')?.mision).toBe(justo)
  })

  // MARK: cruces de la ola 2

  test('/api/actividad sigue rápido con 100 corridas abiertas de flujos largos', async () => {
    const f = await Fix.crear({ deps: ['Dirección'], env: { HQ_PROGRAMADOR: '0' } })
    // 20 pasos de la persona, con textos largos (el tope de cada campo): el peor caso para la definición guardada
    const largo = 'texto '.repeat(90)
    const pasos: Obj[] = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i + 1}`, nombre: `Paso ${i + 1}`, quien: 'persona', consigna: 'c'.repeat(3000), recibe: largo, entrega: largo, aprobacion: false,
    }))
    const r = await f.post('/api/flujos', { id: 'largo', nombre: 'Largo', pasos })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    for (let i = 1; i <= 100; i++) {
      const c = await f.post('/api/flujos/largo/correr', { nombre: `Corrida ${i}` })
      expect(c.status, JSON.stringify(c.obj)).toBe(200)
    }
    const inicio = Date.now()
    const veces = 10
    let ultimo: Resp = { status: 0, obj: {} }
    for (let i = 0; i < veces; i++) ultimo = await f.get('/api/actividad')
    const promedio = (Date.now() - inicio) / 1000 / veces
    expect(ultimo.status === 200 && lista(ultimo.obj.corridas).length === 100).toBe(true)
    expect(lista(ultimo.obj.avisos).filter((a) => str(a.tipo) === 'flujo').length).toBe(100)
    // Se mide que no se degrade. El margen es amplio porque corre con los demás archivos en paralelo: con la máquina
    // cargada (el pre-push mientras corre otra cosa) pasaba 0.15 s sin que hubiera regresión.
    const tope = 0.6
    expect(promedio, `GET /api/actividad tardó ${promedio} s en promedio con 100 corridas`).toBeLessThan(tope)
  }, 60_000)

  // interno: usa mcp.tokens.emitir / mcp.consultas.herramientas (proponer_accion, encargar) y store.entregas.
  test.skip('flujo, acción propuesta y encargo del coordinador a la vez: cada gancho toca solo lo suyo', () => {})

  // interno: usa programador.encargarLibre y oficinas.activa() directamente.
  test.skip('GobiernoRouter atiende ejecutar y deja pasar el resto de /api/entregas', () => {})
})
