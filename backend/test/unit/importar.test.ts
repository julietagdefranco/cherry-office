// Lógica interna de importar Próspera (sin servidor): adaptación de rutas y chats anteriores a las oficinas.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Config } from '../../src/config.js'
import { adaptarRutas, importarProspera, marcaProspera, reclamarSiProspera } from '../../src/importar.js'
import { HQLog } from '../../src/log.js'
import { Oficinas } from '../../src/oficinas.js'
import type { Servicios } from '../../src/servicios.js'
import { Store } from '../../src/store.js'

const tmps: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function armar() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'imp-')))
  tmps.push(root)
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const config = new Config(home)
  config.datosDir = path.join(root, 'datos')
  config.oficinasDir = path.join(root, 'oficinas')
  config.legacyDirs = [path.join(root, 'nada', 'oficina')]
  const log = new HQLog()
  const store = new Store(path.join(config.datosDir, 'hq.db'))
  stores.push(store)
  const oficinas = new Oficinas(config, log)
  const s = { config, log, store, oficinas, alAbrir: [] } as unknown as Servicios
  return { root, home, config, store, oficinas, s }
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'

describe('adaptarRutas', () => {
  test('las rutas de la instalación del autor pasan a rutas de la oficina', () => {
    const t = 'Leé /Users/juli/Próspera/_betty/estado-actual.md y /Users/juli/.claude/betty/contexto-maestro.md y /Users/juli/Próspera/_equipo/decisiones.md.'
    expect(adaptarRutas(t)).toBe('Leé conocimiento/oficina.md y conocimiento/contexto-maestro.md y conocimiento/decisiones.md.')
    // «Próspera» descompuesta (o + U+0301)
    expect(adaptarRutas('/Users/juli/Pro\u0301spera/_equipo/x.md')).toBe('conocimiento/x.md')
  })

  test('con proyecto, el resto de /Users/<x>/Próspera apunta a la carpeta real (y no toca Próspera2 ni Próspera-x)', () => {
    const t = 'Videos en /Users/juli/Próspera/Reels y /Users/juli/Próspera (fin). Otra: /Users/juli/Próspera2/x y /Users/juli/Próspera-x'
    expect(adaptarRutas(t, 'C:\\Users\\ana\\Próspera$1')).toBe('Videos en C:\\Users\\ana\\Próspera$1/Reels y C:\\Users\\ana\\Próspera$1 (fin). Otra: /Users/juli/Próspera2/x y /Users/juli/Próspera-x')
    expect(adaptarRutas(t)).toBe(t)
  })
})

describe('chats anteriores a las oficinas', () => {
  test('se asignan a Próspera HQ al importarla (y no a otras oficinas)', () => {
    const { root, s, store, oficinas } = armar()
    const origen = path.join(root, 'origen')
    fs.mkdirSync(path.join(origen, 'agentes'), { recursive: true })
    fs.writeFileSync(path.join(origen, 'agentes', 'betty.md'), '---\nname: betty\n---\nSos betty.')
    store.asegurarSesion(A, 'betty')
    store.agregar(A, 'u', 'hola')
    expect(store.oficinaDe(A)).toBe('')
    const otra = oficinas.crear({ nombre: 'Otra', duenio: '' })
    reclamarSiProspera(s, otra.carpeta)   // una oficina común no reclama nada
    expect(store.oficinaDe(A)).toBe('')
    const r = importarProspera(s, origen)
    expect(r.yaExistia).toBe(false)
    expect(fs.existsSync(path.join(r.activa.carpeta, marcaProspera))).toBe(true)
    reclamarSiProspera(s, r.activa.carpeta)
    expect(store.oficinaDe(A)).toBe(r.activa.carpeta)
  })

  test('abrir una carpeta con la marca también reclama los chats anteriores; una oficina común no', () => {
    const { root, s, store, oficinas } = armar()
    const origen = path.join(root, 'origen')
    fs.mkdirSync(path.join(origen, 'agentes'), { recursive: true })
    fs.writeFileSync(path.join(origen, 'agentes', 'betty.md'), '---\nname: betty\n---\nSos betty.')
    const p = importarProspera(s, origen).activa.carpeta
    const comun = oficinas.crear({ nombre: 'Comun', duenio: '' }).carpeta
    store.asegurarSesion(B, 'betty')
    reclamarSiProspera(s, oficinas.abrir(comun).carpeta)
    expect(store.oficinaDe(B)).toBe('')
    reclamarSiProspera(s, oficinas.abrir(p).carpeta)
    expect(store.oficinaDe(B)).toBe(p)
    // lo ya asignado no se reclama de nuevo
    store.asegurarSesion(A, 'betty', comun)
    reclamarSiProspera(s, p)
    expect(store.oficinaDe(A)).toBe(comun)
  })
})
