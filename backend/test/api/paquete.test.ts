// Port de app/Tests/BackendTests/PaqueteTests.swift.
// Exportar una oficina a .zip e importarla en otra «compu» (otro sandbox: otra carpeta personal, otra hq.db).
// Los fixtures de zip se arman y se leen con fflate (sin ditto/zipinfo/python): corren igual en macOS y Windows.
// Sin acceso a internals: `PaqueteRouter.rutasAbsolutas/descomprimido` quedan para los unit tests del port (test/unit/paquete.test.ts).
import fs from 'node:fs'
import path from 'node:path'
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, U, dict, escribir, esperar, existe, leerTexto, lista, listar, llamar, sinPrivate, str, type Backend, type Resp, ruta } from '../support/sandbox.js'

/** Nombres de las entradas de un .zip (equivale a `zipinfo -1`). */
function nombresZip(zip: string): string[] {
  const nombres: string[] = []
  unzipSync(fs.readFileSync(zip), { filter: (f) => { nombres.push(f.name); return false } })
  return nombres
}

const unix = (modo: number) => ({ os: 3, attrs: (modo << 16) >>> 0 })

/** Zip de una carpeta, con su carpeta como raíz (equivale a `ditto -c -k --keepParent`). Los enlaces simbólicos quedan como tales. */
function zipearCarpeta(dir: string, zip: string): boolean {
  const raiz = path.basename(dir)
  const z: Zippable = { [raiz + '/']: [new Uint8Array(0), unix(0o040755)] }
  const ir = (d: string, rel: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n)
      const r = `${rel}/${n}`
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) z[r] = [strToU8(fs.readlinkSync(p)), { ...unix(0o120755), level: 0 }]
      else if (st.isDirectory()) { z[r + '/'] = [new Uint8Array(0), unix(0o040755)]; ir(p, r) }
      else z[r] = [fs.readFileSync(p), unix(0o100644)]
    }
  }
  ir(dir, raiz)
  fs.writeFileSync(zip, zipSync(z))
  return true
}

const claves = (o: Record<string, unknown>) => Object.keys(o).sort()

async function oficinaConTodo(): Promise<Fix> {
  const f = await Fix.crear({
    nombre: 'Taller', duenio: 'Ana', deps: ['Dirección', 'Redes'],
    agentes: [{ id: 'betty', depto: 'direccion' }, { id: 'marce', depto: 'redes' }],
  })
  // un documento fichado
  const r = await f.post('/api/archivos', { nombre: 'precios.txt', base64: Buffer.from('El taller cuesta 150 dolares.').toString('base64') })
  expect(r.status, JSON.stringify(r.obj)).toBe(200)
  await esperar(async () => str(dict((await f.get('/api/archivos/precios')).obj.archivo).estado) === 'listo', 15)
  // otro que va a la papelera
  await f.post('/api/archivos', { nombre: 'viejo.txt', base64: Buffer.from('Borrador viejo.').toString('base64') })
  await esperar(async () => str(dict((await f.get('/api/archivos/viejo')).obj.archivo).estado) === 'listo', 15)
  expect((await f.delete('/api/archivos/viejo')).status).toBe(200)
  // una carpeta vinculada (con un documento fichado en su lugar)
  const ext = f.sb.root + '/externa'
  fs.mkdirSync(ext, { recursive: true })
  escribir('Contrato con el proveedor.', ext + '/contrato.txt')
  expect((await f.post('/api/vinculos', { ruta: ext, id: 'externa' })).status).toBe(200)
  await f.post('/api/vinculos/externa/escanear', {})
  await esperar(async () => (await f.get('/api/biblioteca/estado')).obj.pendientes === 0, 15)
  // una carpeta de trabajo (un repo de esta compu)
  fs.mkdirSync(f.sb.root + '/repo', { recursive: true })
  expect((await f.post('/api/carpetas-trabajo', { ruta: f.sb.root + '/repo' })).status).toBe(200)
  // notas que mencionan la ruta de la oficina
  escribir(`Notas de Betty. Ver ${f.carpeta}/conocimiento/oficina.md\n`, f.ruta('conocimiento/agentes/betty.md'))
  escribir('Acta de prueba.\n', f.ruta('reuniones/2026-11-01-arranque.md'))
  escribir('basura', f.ruta('.DS_Store'))
  return f
}

async function exportar(f: Fix, destino?: string): Promise<Resp> {
  const dir = destino ?? f.sb.root + '/exportados'
  fs.mkdirSync(dir, { recursive: true })
  return f.post('/api/oficina/exportar', { destino: dir })
}

const entradas = (zip: string) => nombresZip(zip)

const importar = (b: Backend, zip: string) => llamar(b, 'POST', '/api/oficinas/importar', { body: { archivo: zip } })

describe('Exportar e importar oficinas', () => {
  test('exportar: .zip con la oficina, el índice de la biblioteca y sin papelera, vínculos ni la ruta de esta compu', async () => {
    const f = await oficinaConTodo()
    const r = await exportar(f)
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(claves(r.obj)).toEqual(['archivo', 'avisos', 'documentos', 'nombre', 'omitidos', 'tam'])
    const zip = str(r.obj.archivo)
    expect(zip).toBe(ruta(f.sb.root, 'exportados/Taller.oficina.zip'))
    expect(r.obj.nombre).toBe('Taller.oficina.zip')
    expect(r.obj.tam).toBeGreaterThan(0)
    expect(r.obj.documentos).toBe(1)
    expect(dict(r.obj.omitidos).vinculos).toBe(1)
    expect(dict(r.obj.omitidos).papelera).toBe(true)
    expect(r.obj.avisos).toEqual([])

    const e = entradas(zip)
    for (const x of ['Taller/oficina.json', 'Taller/.oficina-paquete.json', 'Taller/.claude/agents/betty.md', 'Taller/.claude/agents/marce.md',
      'Taller/conocimiento/agentes/betty.md', 'Taller/conocimiento/fuentes/precios.md', 'Taller/archivos/.texto/precios.md',
      'Taller/archivos/compartido/precios.txt', 'Taller/reuniones/2026-11-01-arranque.md']) {
      expect(e, `falta ${x}`).toContain(x)
    }
    expect(e.some((x) => x.startsWith('Taller/archivos/.papelera/') && x !== 'Taller/archivos/.papelera/'), JSON.stringify(e)).toBe(false)
    expect(e.some((x) => x.includes('contrato')), JSON.stringify(e)).toBe(false)
    expect(e.some((x) => x.endsWith('.DS_Store') || x.includes('__MACOSX'))).toBe(false)

    // la oficina original no se tocó
    expect(f.oficinaJSON().vinculos).not.toBeUndefined()
    expect(f.leer('conocimiento/agentes/betty.md')).toContain(f.carpeta)

    // exportar de nuevo no pisa el anterior
    const r2 = await exportar(f)
    expect(str(r2.obj.archivo)).toBe(ruta(f.sb.root, 'exportados/Taller 2.oficina.zip'))
  }, 60_000)

  test('importar en otra compu: misma oficina, biblioteca lista sin volver a fichar, rutas adaptadas', async () => {
    const f = await oficinaConTodo()
    const zip = str((await exportar(f)).obj.archivo)

    const sb2 = new Sandbox()
    const b2 = await sb2.backend({ oficina: false })
    const r = await importar(b2, zip)
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const carpeta = str(r.obj.carpeta)
    expect(carpeta).toBe(ruta(sb2.oficinasDir, 'Taller'))
    expect(r.obj.documentos).toBe(1)
    expect(r.obj.reprocesar).toBe(0)
    expect(r.obj.avisos).toEqual([])
    const of = dict(r.obj.oficina)
    expect(of.nombre).toBe('Taller')
    expect(lista(of.agentes).map((a) => str(a.id))).toEqual(['betty', 'marce'])
    expect(of.vinculos).toBeUndefined()
    expect(of.carpetasTrabajo).toBeUndefined()

    // queda abierta
    const est = await llamar(b2, 'GET', '/api/estado')
    expect(dict(est.obj.oficina).carpeta).toBe(carpeta)
    // archivos y rutas
    expect(leerTexto(carpeta + '/conocimiento/agentes/betty.md')).toBe(`Notas de Betty. Ver ${carpeta}/conocimiento/oficina.md\n`)
    expect(leerTexto(carpeta + '/reuniones/2026-11-01-arranque.md')).toBe('Acta de prueba.\n')
    expect(existe(carpeta + '/.oficina-paquete.json')).toBe(false)
    expect(existe(carpeta + '/archivos/.papelera')).toBe(true)
    expect(listar(carpeta + '/archivos/.papelera')).toEqual([])
    expect(leerTexto(carpeta + '/.claude/agents/betty.md')).toContain('name: betty')
    // biblioteca: el documento aparece listo, se puede buscar y no se llamó al bibliotecario
    const arch = await llamar(b2, 'GET', '/api/archivos')
    const filas = lista(arch.obj.archivos)
    expect(filas.map((x) => str(x.slug))).toEqual(['precios'])
    expect(filas[0]?.estado).toBe('listo')
    expect(dict(filas[0]?.ficha).titulo).toBe('Ficha de prueba')
    const q = await llamar(b2, 'GET', '/api/archivos', { query: { q: 'dolares' } })
    expect(lista(q.obj.archivos).map((x) => str(x.slug))).toEqual(['precios'])
    expect(sb2.llamadasConPrompt('Sos el bibliotecario')).toEqual([])
    const cat = leerTexto(carpeta + '/conocimiento/archivos.md')
    expect(cat).toContain('`precios`')
    expect(cat).not.toContain('contrato')
    // el chat funciona en la oficina importada
    const c = await llamar(b2, 'POST', '/api/chat', { body: { agent: 'betty', message: 'hola', session: U.a } })
    expect(c.status, JSON.stringify(c.obj)).toBe(200)
    expect(sinPrivate(sb2.cwds.at(-1) ?? '')).toBe(sinPrivate(carpeta))

    // importarla otra vez no pisa la primera
    const r2 = await importar(b2, zip)
    expect(r2.status).toBe(200)
    expect(str(r2.obj.carpeta)).toBe(ruta(sb2.oficinasDir, 'Taller_2'))
  }, 60_000)

  test('importar: un .zip hecho a mano con la carpeta (sin índice) también se abre, con aviso', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'betty', depto: 'direccion' }] })
    const zip = f.sb.root + '/a-mano.zip'
    expect(zipearCarpeta(f.carpeta, zip)).toBe(true)
    const sb2 = new Sandbox()
    const b2 = await sb2.backend({ oficina: false })
    const r = await importar(b2, zip)
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect((Array.isArray(r.obj.avisos) ? r.obj.avisos : []).some((a: string) => a.includes('índice de la biblioteca'))).toBe(true)
    expect(lista(dict(r.obj.oficina).agentes).map((a) => str(a.id))).toEqual(['betty'])
  })

  test('importar: avisa de agentes con rutas de otra compu y quita vínculos que no existen', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'betty', depto: 'direccion' }] })
    const md = f.ruta('.claude/agents/betty.md')
    escribir(leerTexto(md) + '\nLeé /Users/otra-persona/Documentos/plan.md antes de empezar.\n', md)
    const of = f.oficinaJSON()
    of.vinculos = [{ id: 'lejos', ruta: '/Users/otra-persona/Drive', alcance: 'oficina' }]
    fs.writeFileSync(f.ruta('oficina.json'), JSON.stringify(of))
    const zip = f.sb.root + '/a-mano.zip'
    expect(zipearCarpeta(f.carpeta, zip)).toBe(true)
    const sb2 = new Sandbox()
    const b2 = await sb2.backend({ oficina: false })
    const r = await importar(b2, zip)
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const avisos: string[] = Array.isArray(r.obj.avisos) ? r.obj.avisos : []
    // NFC: ditto/Foundation puede devolver textos en NFD; Swift compara por equivalencia canónica, JS no.
    const nfc = avisos.map((a) => a.normalize('NFC'))
    expect(nfc.some((a) => a.includes('«Betty»') && a.includes('/Users/otra-persona/Documentos/plan.md')), JSON.stringify(avisos)).toBe(true)
    expect(nfc.some((a) => a.includes('carpeta(s) vinculada(s)')), JSON.stringify(avisos)).toBe(true)
    expect(dict(r.obj.oficina).vinculos).toBeUndefined()
  })

  test('importar: rechaza zips peligrosos o que no son una oficina', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const zipDe = (nombre: string, armar: (dir: string) => void): string => {
      const dir = sb.root + `/z-${nombre}`
      fs.mkdirSync(dir + '/Oficina', { recursive: true })
      armar(dir + '/Oficina')
      const zip = sb.root + `/${nombre}.zip`
      expect(zipearCarpeta(dir + '/Oficina', zip)).toBe(true)
      return zip
    }
    // sin oficina.json
    const vacio = zipDe('vacio', (d) => escribir('hola', d + '/nota.txt'))
    expect((await importar(b, vacio)).status).toBe(400)
    // oficina.json inválido
    const malo = zipDe('malo', (d) => escribir('{no es json', d + '/oficina.json'))
    expect((await importar(b, malo)).status).toBe(400)
    // con un enlace simbólico
    const conEnlace = sb.root + '/enlace.zip'
    fs.writeFileSync(conEnlace, zipSync({
      'Oficina/oficina.json': strToU8(JSON.stringify({ version: 1, nombre: 'X', duenio: '', departamentos: [{ id: 'a', nombre: 'A', color: '#123456' }], agentes: [] })),
      'Oficina/afuera': [strToU8('/etc'), { ...unix(0o120755), level: 0 }],
    }))
    const r = await importar(b, conEnlace)
    expect(r.status).toBe(400)
    expect(str(r.obj.error)).toContain('enlaces simbólicos')
    // con rutas que salen de la carpeta (zip-slip)
    const slip = sb.root + '/slip.zip'
    fs.writeFileSync(slip, zipSync({ 'Oficina/oficina.json': strToU8('{}'), '../../afuera.txt': strToU8('x') }))
    {
      const s = await importar(b, slip)
      expect(s.status).toBe(400)
      expect(str(s.obj.error)).toContain('rutas inválidas')
      expect(existe(sb.root + '/../afuera.txt')).toBe(false)
    }
    // no es un zip / no existe / no es .zip / ruta relativa
    escribir('no soy un zip', sb.root + '/falso.zip')
    expect((await importar(b, sb.root + '/falso.zip')).status).toBe(400)
    expect((await importar(b, sb.root + '/no-existe.zip')).status).toBe(404)
    escribir('x', sb.root + '/otra.txt')
    expect((await importar(b, sb.root + '/otra.txt')).status).toBe(400)
    expect((await importar(b, 'relativa.zip')).status).toBe(400)
    expect((await llamar(b, 'POST', '/api/oficinas/importar', { body: {} })).status).toBe(400)
    expect((await llamar(b, 'GET', '/api/oficinas/importar')).status).toBe(405)
    // no quedó ninguna oficina a medias
    expect(listar(sb.oficinasDir)).toEqual([])
  })

  test('exportar: sin oficina 409; destino inválido 400/404; por defecto en Descargas', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    expect((await llamar(b, 'POST', '/api/oficina/exportar')).status).toBe(409)
    await b.cerrar()

    const f = await Fix.crear({ agentes: [{ id: 'betty', depto: 'direccion' }] })
    expect((await f.post('/api/oficina/exportar', { destino: 'relativa' })).status).toBe(400)
    expect((await f.post('/api/oficina/exportar', { destino: f.sb.root + '/no-existe' })).status).toBe(404)
    fs.mkdirSync(f.sb.home + '/Downloads', { recursive: true })
    const r = await f.post('/api/oficina/exportar')
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(str(r.obj.archivo)).toBe(ruta(f.sb.home, 'Downloads/Taller.oficina.zip'))
    expect(existe(f.sb.home + '/Downloads/Taller.oficina.zip')).toBe(true)
  })

  test('explorador: con archivos=zip lista los .zip de la carpeta', async () => {
    const f = await Fix.crear()
    const dir = f.sb.home + '/Descargas-prueba'
    fs.mkdirSync(dir + '/sub', { recursive: true })
    escribir('zip', dir + '/Taller.oficina.zip')
    escribir('txt', dir + '/nota.txt')
    const sin = await f.get('/api/fs/carpetas', { ruta: dir })
    expect(sin.obj.archivos).toBeUndefined()
    const con = await f.get('/api/fs/carpetas', { ruta: dir, archivos: 'zip' })
    expect(lista(con.obj.archivos).map((a) => str(a.nombre))).toEqual(['Taller.oficina.zip'])
    expect(lista(con.obj.carpetas).map((c) => str(c.nombre))).toEqual(['sub'])
  })

  // interno: PaqueteRouter.rutasAbsolutas y el tope de tamaño descomprimido, reescritos como unit tests en test/unit/paquete.test.ts
})
