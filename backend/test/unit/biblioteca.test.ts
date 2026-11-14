// Lógica interna de la biblioteca (sin servidor): recuperación al arrancar, extracción de texto, nombres, ficha y catálogo.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, test } from 'vitest'
import {
  BibliotecaDatos, catalogoMD, nuevaFila, normIndice, palabras, parsearFicha, recortar, tamTexto, type ArchivoFila,
} from '../../src/biblioteca.js'
import { nombreSeguro, rtfATexto, sha256, texto as extraerTexto } from '../../src/extraccion.js'
import type { Oficina } from '../../src/oficina.js'
import { SQLiteDB } from '../../src/sqlite.js'

const tmps: string[] = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bib-')); tmps.push(d); return d }
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

const oficina: Oficina = {
  version: 1, nombre: 'Taller', duenio: 'Ana',
  departamentos: [{ id: 'direccion', nombre: 'Dirección', color: '#111111' }, { id: 'redes', nombre: 'Redes', color: '#222222' }],
  agentes: [],
}

const fila = (slug: string, estado: string, extra: Partial<ArchivoFila> = {}) =>
  nuevaFila({ slug, oficina: '/of', nombre: `${slug}.txt`, departamento: 'compartido', ruta: `archivos/compartido/${slug}.txt`, origen: 'subido',
    tipo: 'txt', tam: 1, hash: 'h', estado, creado: 1, actualizado: 1, ...extra })

describe('arranque', () => {
  for (const sinFTS of [false, true]) {
    test(`lo que quedó a medio procesar (extrayendo o fichando) vuelve a pendiente (${sinFTS ? 'sin' : 'con'} FTS)`, () => {
      const db = new SQLiteDB(path.join(tmp(), 'hq.db'))
      const datos = new BibliotecaDatos(db)
      datos.preparar(sinFTS)
      expect(datos.indiceEsFTS()).toBe(!sinFTS)
      datos.archivoGuardar(fila('a', 'extrayendo'))
      datos.archivoGuardar(fila('b', 'fichando', { aviso: 'x' }))
      datos.archivoGuardar(fila('c', 'leyendo', { leer: ['betty'] }))
      datos.archivoGuardar(fila('d', 'listo'))
      datos.archivoGuardar(fila('e', 'error', { error: 'mal' }))
      // «reinicio»: se prepara de nuevo sobre la misma base
      new BibliotecaDatos(db).preparar(sinFTS)
      const est = (s: string) => datos.archivo(s, '/of')?.estado
      expect([est('a'), est('b'), est('c'), est('d'), est('e')]).toEqual(['pendiente', 'pendiente', 'leyendo', 'listo', 'error'])
      expect(datos.siguienteArchivo()?.slug).toBe('a')
      expect(datos.archivo('c', '/of')?.leer).toEqual(['betty'])
      db.close()
    })
  }

  test('una base con índice sin la columna norm la agrega y reindexa', () => {
    const db = new SQLiteDB(path.join(tmp(), 'hq.db'))
    db.exec('CREATE TABLE archivos_fts (slug TEXT, oficina TEXT, titulo TEXT, resumen TEXT, temas TEXT, texto TEXT)')
    db.run('INSERT INTO archivos_fts(slug,oficina,titulo,resumen,temas,texto) VALUES(?,?,?,?,?,?)', ['a', '/of', 'Título', '', '', 'Precio en dólares'])
    const datos = new BibliotecaDatos(db)
    datos.preparar(true)
    expect(datos.buscar('/of', 'dolares').map((x) => x.slug)).toEqual(['a'])
    db.close()
  })
})

describe('índice y búsqueda', () => {
  test('palabras y normalización ignoran acentos y mayúsculas', () => {
    expect(palabras('¡Dólares, AÑO 2026!')).toEqual(['dolares', 'ano', '2026'])
    expect(normIndice('Ñandú', 'ÁÉ')).toBe('nandu\nae')
  })
})

describe('extracción de texto', () => {
  const archivo = (nombre: string, data: Buffer | string) => { const p = path.join(tmp(), nombre); fs.writeFileSync(p, data); return p }

  test('txt: UTF-8, latin1 de respaldo y vacío', async () => {
    expect((await extraerTexto(archivo('a.txt', '  hola ñandú \n'), 'txt')).texto).toBe('hola ñandú')
    expect((await extraerTexto(archivo('b.txt', Buffer.from('caf\xe9', 'latin1')), 'txt')).texto).toBe('café')
    expect((await extraerTexto(archivo('c.txt', ' \n'), 'txt')).aviso).toBe('El archivo está vacío.')
  })

  test('rtf: ignora tablas, decodifica \\\'hh y \\uN', async () => {
    const rtf = "{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}{\\colortbl;\\red0\\green0\\blue0;}\\pard\\f0 Precio: 90 d\\'f3lares\\par Segunda l\\u237?nea\\tab fin}"
    expect(rtfATexto(Buffer.from(rtf, 'latin1')).trim()).toBe('Precio: 90 dólares\nSegunda línea\tfin')
    const r = await extraerTexto(archivo('a.rtf', rtf), 'rtf')
    expect(r.texto).toContain('Precio: 90 dólares')
    expect((await extraerTexto(archivo('b.rtf', 'no es rtf'), 'rtf')).aviso).toBeDefined()
  })

  test('odt: content.xml sin etiquetas, con párrafos y entidades', async () => {
    const xml = '<office:text><text:p>Contrato &amp; anexo</text:p><text:p>Precio<text:tab/>90<text:line-break/>fin</text:p></office:text>'
    const zip = zipSync({ 'content.xml': new TextEncoder().encode(xml), mimetype: new TextEncoder().encode('application/vnd.oasis.opendocument.text') })
    const r = await extraerTexto(archivo('a.odt', Buffer.from(zip)), 'odt')
    expect(r.texto).toBe('Contrato & anexo\nPrecio\t90\nfin')
    expect((await extraerTexto(archivo('b.odt', 'garbage'), 'odt')).aviso).toBeDefined()
  })

  test('pdf roto y docx roto dan aviso; doc/pages sin textutil dan el aviso de Swift fuera de macOS', async () => {
    expect((await extraerTexto(archivo('a.pdf', '%PDF-1.4\nbasura'), 'pdf')).aviso).toBe('No pude abrir el PDF.')
    expect((await extraerTexto(archivo('a.docx', 'PK\u0003\u0004basura'), 'docx')).aviso).toBeDefined()
    const doc = await extraerTexto(archivo('a.doc', 'basura'), 'doc')
    if (process.platform !== 'darwin') expect(doc.aviso).toBe('No encuentro textutil para leer este tipo de documento.')
    else expect(doc.texto ?? doc.aviso).toBeDefined()
  })

  test('imagen: pide visión y no lee nada', async () => {
    expect((await extraerTexto(archivo('a.png', 'x'), 'png')).necesitaVision).toBe(true)
  })

  test('sha256 hexadecimal', () => {
    expect(sha256(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('nombres', () => {
  test('nombreSeguro', () => {
    expect(nombreSeguro('../../etc/pass:wd*.txt')).toBe('pass-wd-.txt')
    expect(nombreSeguro('..\\..\\windows\\x.txt')).toBe('x.txt')
    expect(nombreSeguro('.hidden.txt')).toBe('hidden.txt')
    expect(nombreSeguro('a..b.txt')).toBe('a.b.txt')
    expect(nombreSeguro('n'.repeat(130) + '.txt')).toBe('n'.repeat(116) + '.txt')
    expect(nombreSeguro('   ')).toBe('archivo')
  })
  test('recortar y tamTexto', () => {
    expect(recortar('abcdef', 3)).toBe('abc…')
    expect(recortar('abc', 3)).toBe('abc')
    expect(tamTexto(10)).toBe('10 B')
    expect(tamTexto(2048)).toBe('2 KB')
    expect(tamTexto(1_572_864)).toBe('1.5 MB')
  })
})

describe('ficha y catálogo', () => {
  test('parsearFicha: con ```json, listas sueltas, departamentos por nombre y contradicciones (máx. 5, sin sugerencia vacía)', () => {
    const cs = Array.from({ length: 7 }, (_, i) => ({ actual: `a${i}`, nuevo: `n${i}`, sugerencia: `s${i}` }))
    const t = 'Claro:\n```json\n' + JSON.stringify({ resumen: 'R', temas: 'uno', util_para: ['Redes', 'redes', 'x', 'Dirección'], contradicciones: [{ sugerencia: '' }, ...cs] }) + '\n```'
    const [f, c] = parsearFicha(t, 'doc.txt', oficina)!
    expect(f.titulo).toBe('doc.txt')
    expect(f.temas).toEqual(['uno'])
    expect(f.utilPara).toEqual(['redes', 'direccion'])
    expect(c.length).toBe(5)
    expect(parsearFicha('nada', 'x', oficina)).toBeUndefined()
    expect(parsearFicha('{"titulo":"","resumen":""}', 'x', oficina)).toBeUndefined()
  })

  test('catalogoMD: vacío, con y sin ficha, ordenado por carpeta y nombre, sin papelera', () => {
    expect(catalogoMD([], oficina)).toContain('\n(Todavía no hay documentos.)\n')
    const ficha = { titulo: 'T', resumen: 'Resumen\nen dos líneas', datosClave: [], temas: [], utilPara: [], fechas: [] }
    const md = catalogoMD([
      fila('z', 'listo', { departamento: 'redes', ficha }), fila('b', 'error'), fila('a', 'pendiente'), fila('p', 'listo', { papelera: true }),
    ], oficina)
    const l = md.split('\n').filter((x) => x.startsWith('- '))
    expect(l).toEqual([
      '- **a.txt** (`a`, Compartido, txt): todavía sin ficha (en proceso) → texto en `archivos/.texto/a.md`',
      '- **b.txt** (`b`, Compartido, txt): todavía sin ficha (no se pudo fichar) → texto en `archivos/.texto/b.md`',
      '- **T** (`z`, Redes, txt): Resumen en dos líneas → `conocimiento/fuentes/z.md`',
    ])
  })
})
