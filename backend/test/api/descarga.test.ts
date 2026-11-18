// GET /api/oficina/descarga: el archivo entero para bajarlo desde el navegador (otra compu no abre la ruta local).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { Fix, str } from '../support/sandbox.js'

describe('descarga de archivos de la oficina', () => {
  test('baja cualquier tipo entero, con nombre y mime; mismas reglas de ruta', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'charly', depto: 'direccion' }] })
    fs.mkdirSync(f.ruta('archivos'), { recursive: true })
    const bin = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 255])
    fs.writeFileSync(f.ruta('archivos/informe.docx'), bin)
    const largo = 'x'.repeat(600 * 1024) // pasa el tope de la vista previa (512 KB) pero baja entero
    fs.writeFileSync(f.ruta('archivos/largo.md'), largo)

    const d = await f.get('/api/oficina/descarga', { ruta: 'archivos/informe.docx' })
    expect(d.status, JSON.stringify(d.obj)).toBe(200)
    expect(d.obj).toMatchObject({ nombre: 'informe.docx', tam: bin.length, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    expect(Buffer.from(str(d.obj.base64), 'base64').equals(bin)).toBe(true)

    const m = await f.get('/api/oficina/descarga', { ruta: 'archivos/largo.md' })
    expect(Buffer.from(str(m.obj.base64), 'base64').toString('utf8')).toBe(largo)
    expect(m.obj.mime).toBe('text/markdown')

    expect((await f.get('/api/oficina/descarga', { ruta: 'archivos' })).status).toBe(400)
    expect((await f.get('/api/oficina/descarga', { ruta: '' })).status).toBe(400)
    expect((await f.get('/api/oficina/descarga', { ruta: 'archivos/nada.pdf' })).status).toBe(404)
    expect((await f.get('/api/oficina/descarga', { ruta: '../afuera.txt' })).status).toBe(403)
    expect((await f.get('/api/oficina/descarga', { ruta: path.join(path.dirname(f.carpeta), 'x.txt') })).status).toBe(403)
  })
})
