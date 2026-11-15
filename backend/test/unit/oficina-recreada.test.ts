// Borrar la carpeta de una oficina y crear otra con el mismo nombre (misma ruta): la nueva no hereda lo guardado en hq.db.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Config } from '../../src/config.js'
import { TarjetasStore } from '../../src/creador.js'
import { HQLog } from '../../src/log.js'
import { Oficinas } from '../../src/oficinas.js'
import { Store } from '../../src/store.js'

const tmps: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const OTRA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'

test('una oficina nueva en la carpeta de una borrada arranca sin la conversación ni el borrador viejos', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recreada-')))
  tmps.push(root)
  const config = new Config(path.join(root, 'home'))
  config.datosDir = path.join(root, 'datos')
  config.oficinasDir = path.join(root, 'oficinas')
  const store = new Store(path.join(config.datosDir, 'hq.db'))
  stores.push(store)
  const tarjetas = new TarjetasStore(store)
  const oficinas = new Oficinas(config, new HQLog())
  oficinas.alOlvidar.push((dir) => store.olvidarOficina(dir))

  const vieja = oficinas.crear({ nombre: 'Taller', duenio: '', vacia: true })
  const otra = oficinas.crear({ nombre: 'Otra', duenio: '', vacia: true })
  const tarjeta = (oficina: string) => ({
    id: 't1', oficina, sid: SID, tipo: 'departamento', accion: 'crear', datos: '{}', faltantes: '[]', origen: 'x', estado: 'borrador', creada: 0, actualizada: 0,
  })
  store.asegurarSesion(SID, 'creador', vieja.carpeta)
  store.agregar(SID, 'u', 'hola, vendo empanadas')
  tarjetas.guardar(tarjeta(vieja.carpeta))
  store.asegurarSesion(OTRA, 'creador', otra.carpeta)
  store.agregar(OTRA, 'u', 'esto es de la otra')
  tarjetas.guardar(tarjeta(otra.carpeta))

  fs.rmSync(vieja.carpeta, { recursive: true, force: true })
  const nueva = oficinas.crear({ nombre: 'Taller', duenio: '', vacia: true })
  expect(nueva.carpeta).toBe(vieja.carpeta)

  expect(store.oficinaDe(SID)).toBeUndefined()
  expect(store.mensajes(SID)).toEqual([])
  expect(tarjetas.lista(nueva.carpeta)).toEqual([])
  // la otra oficina no se toca
  expect(store.mensajes(OTRA).map((m) => m.t)).toEqual(['esto es de la otra'])
  expect(tarjetas.lista(otra.carpeta)).toHaveLength(1)
})

test('borrar una oficina la cierra, la saca de recientes y olvida lo guardado, sin tocar la carpeta', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'borrada-')))
  tmps.push(root)
  const config = new Config(path.join(root, 'home'))
  config.datosDir = path.join(root, 'datos')
  config.oficinasDir = path.join(root, 'oficinas')
  const store = new Store(path.join(config.datosDir, 'hq.db'))
  stores.push(store)
  const oficinas = new Oficinas(config, new HQLog())
  oficinas.alOlvidar.push((dir) => store.olvidarOficina(dir))

  const otra = oficinas.crear({ nombre: 'Otra', duenio: '', vacia: true })
  const a = oficinas.crear({ nombre: 'Taller', duenio: '', vacia: true })
  store.asegurarSesion(SID, 'marce', a.carpeta)
  store.agregar(SID, 'u', 'hola')

  oficinas.borrar(a.carpeta)
  expect(oficinas.activa()).toBeUndefined()
  expect(oficinas.listar().map((o) => o.carpeta)).toEqual([otra.carpeta])
  expect(store.mensajes(SID)).toEqual([])
  expect(fs.existsSync(a.carpeta)).toBe(true)
  // sigue sin oficina activa después de reabrir la app
  expect(new Oficinas(config, new HQLog()).activa()).toBeUndefined()
})
