// Lógica interna del paquete (sin servidor): rutas de otra compu, revisión del zip (zip-slip, enlaces, tamaño) y lectura/escritura de zips.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, test } from 'vitest'
import { ErrorAPI } from '../../src/errores.js'
import {
  buscarRaiz, filaDesde, nombreInvalido, normalizarNombre, revisarZipArchivo, rutaDocumentoValida, rutasAbsolutas, slugValido,
} from '../../src/paquete.js'
import { ErrorZip, escribirZip, extraerEntrada, leerDirectorio } from '../../src/zip.js'

const tmps: string[] = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'paq-')); tmps.push(d); return d }
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

const unix = (modo: number) => ({ os: 3, attrs: (modo << 16) >>> 0 })

function error(f: () => unknown): ErrorAPI {
  try { f() } catch (e) { if (e instanceof ErrorAPI) return e; throw e }
  throw new Error('no falló')
}

describe('rutas de otra compu', () => {
  test('rutas absolutas /Users/... en un texto', () => {
    expect(rutasAbsolutas('Leé /Users/ana/Documentos/plan.md, y también "/Users/ana/x y" (ver /Users/ana/z).'))
      .toEqual(['/Users/ana/Documentos/plan.md', '/Users/ana/x', '/Users/ana/z'])
    expect(rutasAbsolutas('sin rutas acá, ni algo/Users/raro')).toEqual([])
    expect(rutasAbsolutas('repetida /Users/ana/a y /Users/ana/a. Y /Users/')).toEqual(['/Users/ana/a'])
  })

  test('rutas de Windows de otra compu', () => {
    expect(rutasAbsolutas('Abrí C:\\Users\\ana\\Docs\\plan.md, y listo')).toEqual(['C:\\Users\\ana\\Docs\\plan.md'])
    expect(rutasAbsolutas('nada: XC:\\Users\\x')).toEqual([])
  })

  test('nombres y rutas de documentos válidos', () => {
    expect(rutaDocumentoValida('archivos/compartido/a.txt')).toBe(true)
    for (const r of ['archivos/.papelera/a.txt', 'otra/a.txt', 'archivos/../x', 'archivos\\a', 'archivos/a\0']) expect(rutaDocumentoValida(r), r).toBe(false)
    expect(slugValido('precios')).toBe(true)
    for (const s of ['', '.oculto', 'a/b', 'a\\b']) expect(slugValido(s), s).toBe(false)
  })

  test('filaDesde: sin ficha queda pendiente; slug o ruta inválidos se descartan', () => {
    const f = filaDesde({ slug: 'a', ruta: 'archivos/compartido/a.TXT', tam: 3.7, hash: 'h' }, '/of', 5)!
    expect(f).toMatchObject({ slug: 'a', nombre: 'a.TXT', tipo: 'txt', tam: 3, hash: 'h', departamento: 'compartido', origen: 'subido', estado: 'pendiente', creado: 5 })
    expect(f.ficha).toBeUndefined()
    expect(filaDesde({ slug: '../a', ruta: 'archivos/a.txt' }, '/of', 5)).toBeUndefined()
    expect(filaDesde({ slug: 'a', ruta: '/etc/passwd' }, '/of', 5)).toBeUndefined()
  })
})

describe('revisión del zip', () => {
  test('nombres: barras invertidas se normalizan; absolutos, unidades y .. se rechazan', () => {
    expect(normalizarNombre('Oficina\\conocimiento\\a.md')).toBe('Oficina/conocimiento/a.md')
    expect(nombreInvalido('Oficina\\conocimiento\\a.md')).toBe(false)
    for (const n of ['/etc/x', '\\x', 'C:\\x', 'C:/x', '../x', 'a/../../x', 'a\\..\\x', 'a\0b']) expect(nombreInvalido(n), n).toBe(true)
    expect(nombreInvalido('a/b..c/d')).toBe(false)
  })

  test('zip-slip, enlaces simbólicos, vacío y no-zip', () => {
    const d = tmp()
    const z = (nombre: string, datos: Parameters<typeof zipSync>[0]) => { const p = path.join(d, nombre); fs.writeFileSync(p, zipSync(datos)); return p }
    expect(error(() => revisarZipArchivo(z('slip.zip', { 'Oficina/oficina.json': strToU8('{}'), '../../afuera.txt': strToU8('x') }))).mensaje).toContain('rutas inválidas')
    expect(error(() => revisarZipArchivo(z('slip2.zip', { 'Oficina\\..\\..\\afuera.txt': strToU8('x') }))).mensaje).toContain('rutas inválidas')
    expect(error(() => revisarZipArchivo(z('abs.zip', { '/etc/passwd': strToU8('x') }))).mensaje).toContain('rutas inválidas')
    const enlace = error(() => revisarZipArchivo(z('enlace.zip', { 'Oficina/x': [strToU8('/etc'), { ...unix(0o120777), level: 0 }] })))
    expect([enlace.status, enlace.mensaje]).toEqual([400, 'El .zip trae enlaces simbólicos; no lo importo.'])
    // un archivo común con atributos unix NO es un enlace
    expect(revisarZipArchivo(z('ok.zip', { 'Oficina/x': [strToU8('x'), unix(0o100644)] }))).toHaveLength(1)
    const vacio = path.join(d, 'vacio.zip')
    fs.writeFileSync(vacio, zipSync({}))
    expect(error(() => revisarZipArchivo(vacio)).mensaje).toBe('El .zip está vacío.')
    const falso = path.join(d, 'falso.zip')
    fs.writeFileSync(falso, 'no soy un zip, ni de lejos, ni un poquito')
    expect([error(() => revisarZipArchivo(falso)).status]).toEqual([400])
  })

  test('tope del total descomprimido (según el directorio central) y de entradas', () => {
    const d = tmp()
    const grande = path.join(d, 'bomba.zip')
    const buf = Buffer.from(zipSync({ 'a/1': strToU8('x'), 'a/2': strToU8('x'), 'a/3': strToU8('x') }))
    // directorio central: firma 0x02014b50, tamaño sin comprimir en +24
    let n = 0
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf.readUInt32LE(i) === 0x02014b50) { buf.writeUInt32LE(0x7fffffff, i + 24); n++ }
    }
    expect(n).toBe(3)
    fs.writeFileSync(grande, buf)
    const e = error(() => revisarZipArchivo(grande))
    expect([e.status, e.mensaje]).toEqual([413, 'El .zip descomprimido pesa demasiado (máximo 4 GB).'])
    // con dos entradas de 2 GB todavía entra
    const dos = Buffer.from(zipSync({ 'a/1': strToU8('x'), 'a/2': strToU8('x') }))
    for (let i = 0; i + 4 <= dos.length; i++) if (dos.readUInt32LE(i) === 0x02014b50) dos.writeUInt32LE(0x7fffffff, i + 24)
    const ok = path.join(d, 'dos.zip')
    fs.writeFileSync(ok, dos)
    expect(revisarZipArchivo(ok)).toHaveLength(2)
  })

  test('buscarRaiz: la raíz, su única carpeta, o nada (sin contar __MACOSX ni ocultos)', () => {
    const d = tmp()
    expect(buscarRaiz(d)).toBeUndefined()
    fs.mkdirSync(path.join(d, '__MACOSX'))
    fs.mkdirSync(path.join(d, '.oculta'))
    fs.mkdirSync(path.join(d, 'Taller'))
    fs.writeFileSync(path.join(d, 'Taller', 'oficina.json'), '{}')
    expect(buscarRaiz(d)).toBe(path.join(d, 'Taller'))
    fs.mkdirSync(path.join(d, 'Otra'))
    expect(buscarRaiz(d)).toBeUndefined()
    fs.writeFileSync(path.join(d, 'oficina.json'), '{}')
    expect(buscarRaiz(d)).toBe(d)
  })
})

describe('lectura y escritura de zips', () => {
  test('escribirZip → leerDirectorio → extraerEntrada devuelve lo mismo (carpetas, vacíos, no ASCII)', async () => {
    const d = tmp()
    const origen = path.join(d, 'o')
    fs.mkdirSync(path.join(origen, 'sub'), { recursive: true })
    const grande = Buffer.alloc(3 * 1024 * 1024 + 7)
    for (let i = 0; i < grande.length; i++) grande[i] = (i * 31) & 0xff
    fs.writeFileSync(path.join(origen, 'sub', 'grande.bin'), grande)
    fs.writeFileSync(path.join(origen, 'vacio.txt'), '')
    fs.writeFileSync(path.join(origen, 'ñandú ✓.md'), 'hola\n')
    const zip = path.join(d, 'x.zip')
    await escribirZip(zip, [
      { nombre: 'Raiz', dir: true }, { nombre: 'Raiz/sub', dir: true },
      { nombre: 'Raiz/sub/grande.bin', ruta: path.join(origen, 'sub', 'grande.bin') },
      { nombre: 'Raiz/vacio.txt', ruta: path.join(origen, 'vacio.txt') },
      { nombre: 'Raiz/ñandú ✓.md', ruta: path.join(origen, 'ñandú ✓.md') },
    ])
    const fd = fs.openSync(zip, 'r')
    try {
      const es = leerDirectorio(fd, fs.fstatSync(fd).size, 100)
      expect(es.map((e) => e.nombre)).toEqual(['Raiz/', 'Raiz/sub/', 'Raiz/sub/grande.bin', 'Raiz/vacio.txt', 'Raiz/ñandú ✓.md'])
      expect(es.some((e) => e.enlace || e.cifrado)).toBe(false)
      const sal = path.join(d, 'sal')
      fs.mkdirSync(sal)
      for (const [i, nombre] of ['sub-grande', 'vacio', 'nombre'].entries()) {
        const e = es[i + 2]!
        await extraerEntrada(fd, e, path.join(sal, nombre), 1 << 30)
      }
      expect(fs.readFileSync(path.join(sal, 'sub-grande')).equals(grande)).toBe(true)
      expect(fs.readFileSync(path.join(sal, 'vacio')).length).toBe(0)
      expect(fs.readFileSync(path.join(sal, 'nombre'), 'utf8')).toBe('hola\n')
      expect(() => leerDirectorio(fd, fs.fstatSync(fd).size, 3)).toThrow(ErrorZip)
    } finally {
      fs.closeSync(fd)
    }
  })

  test('extraerEntrada: si el contenido real pasa de lo declarado o del tope, corta', async () => {
    const d = tmp()
    const zip = path.join(d, 'mentira.zip')
    const buf = Buffer.from(zipSync({ 'a': strToU8('x'.repeat(10_000)) }))
    for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === 0x02014b50) buf.writeUInt32LE(100, i + 24)
    fs.writeFileSync(zip, buf)
    const fd = fs.openSync(zip, 'r')
    try {
      const [e] = leerDirectorio(fd, buf.length, 10)
      await expect(extraerEntrada(fd, e!, path.join(d, 'a'), 1 << 30)).rejects.toMatchObject({ causa: 'tam' })
    } finally {
      fs.closeSync(fd)
    }
    const ok = path.join(d, 'ok.zip')
    fs.writeFileSync(ok, zipSync({ a: strToU8('x'.repeat(10_000)) }))
    const fd2 = fs.openSync(ok, 'r')
    try {
      const [e] = leerDirectorio(fd2, fs.fstatSync(fd2).size, 10)
      await expect(extraerEntrada(fd2, e!, path.join(d, 'b'), 5_000)).rejects.toMatchObject({ causa: 'tam' })
    } finally {
      fs.closeSync(fd2)
    }
  })
})
