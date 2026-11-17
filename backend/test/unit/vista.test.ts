// Vista previa de entregas: empaquetado de páginas, CSV y retoques de texto (docs/plan-vista-previa.md).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { parsearCSV, tipoVista, Vista } from '../../src/vista.js'

let carpeta = ''
const escribir = (rel: string, contenido: string | Buffer) => {
  const p = path.join(carpeta, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, contenido)
}
beforeEach(() => { carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-vista-')) })
afterEach(() => { fs.rmSync(carpeta, { recursive: true, force: true }) })

test('tipos de vista por extensión', () => {
  expect(tipoVista('a/landing.HTML')).toBe('html')
  expect(tipoVista('a/b.md')).toBe('markdown')
  expect(tipoVista('a/b.csv')).toBe('csv')
  expect(tipoVista('a/b.svg')).toBe('imagen')
  expect(tipoVista('a/b.pdf')).toBe('pdf')
  expect(tipoVista('a/b.json')).toBe('texto')
  expect(tipoVista('a/b.docx')).toBe('otro')
})

test('empaquetar: CSS, JS e imágenes relativas quedan adentro; https y anclas intactos', () => {
  escribir('archivos/entregables/d/estilos.css', 'body{background:url("img/fondo.png")} h1{color:red}')
  escribir('archivos/entregables/d/app.js', 'console.log("</script>")')
  escribir('archivos/entregables/d/img/fondo.png', Buffer.from([1, 2, 3]))
  escribir('archivos/entregables/d/img/logo.png', Buffer.from([4, 5, 6]))
  const html = '<html><head><link rel="stylesheet" href="estilos.css"><link rel="stylesheet" href="https://cdn.x/y.css">' +
    '<script src="app.js"></script></head><body><img src="img/logo.png" alt="l"><img src="https://x/y.png">' +
    '<a href="#arriba">arriba</a><div style="background:url(\'img/logo.png\')"></div></body></html>'
  const r = Vista.empaquetar(carpeta, 'archivos/entregables/d/index.html', html)
  expect(r.avisos).toEqual([])
  expect(r.html).toContain('<style>body{background:url("data:image/png;base64,AQID")} h1{color:red}</style>')
  expect(r.html).toContain('href="https://cdn.x/y.css"')
  expect(r.html).toContain('<script>console.log("<\\/script>")</script>')
  expect(r.html).toContain('src="data:image/png;base64,BAUG"')
  expect(r.html).toContain('src="https://x/y.png"')
  expect(r.html).toContain('href="#arriba"')
  expect(r.html).toContain("url('data:image/png;base64,BAUG')")
})

test('empaquetar: faltantes y rutas fuera de la oficina van a avisos y no se leen', () => {
  fs.writeFileSync(path.join(os.tmpdir(), 'hq-vista-secreto.txt'), 'secreto')
  const html = '<img src="no-esta.png"><img src="../../../../../hq-vista-secreto.txt"><link rel="stylesheet" href="../../../../x.css">'
  const r = Vista.empaquetar(carpeta, 'archivos/entregables/d/index.html', html)
  expect(r.html).toBe(html)
  expect(r.avisos.some((a) => a.includes('No encontré «no-esta.png»'))).toBe(true)
  expect(r.avisos.some((a) => a.includes('fuera de la oficina'))).toBe(true)
  expect(r.html).not.toContain('c2VjcmV0bw')
})

test('CSV con comillas, punto y coma y tope de filas', () => {
  expect(parsearCSV('a,b\n"c, d","e ""f"""\n')).toEqual([['a', 'b'], ['c, d', 'e "f"']])
  expect(parsearCSV('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
  expect(parsearCSV('x\ty\n1\t2', '\t')).toEqual([['x', 'y'], ['1', '2']])
})

test('retocar HTML: texto único se cambia (escapado); repetido, ausente o dentro de una etiqueta da 409', () => {
  const src = '<h1 class="Comprar">Nuestra colección</h1><p>Precios &amp; envíos</p><p>Hola</p><p>Hola</p>'
  expect(Vista.retocarHTML(src, 'Nuestra colección', 'Colección de otoño <2026>'))
    .toBe('<h1 class="Comprar">Colección de otoño &lt;2026&gt;</h1><p>Precios &amp; envíos</p><p>Hola</p><p>Hola</p>')
  expect(Vista.retocarHTML(src, 'Precios & envíos', 'Precios y envíos')).toContain('<p>Precios y envíos</p>')
  const codigo = (f: () => unknown) => { try { f(); return 0 } catch (e) { return (e as { status?: number }).status ?? -1 } }
  expect(codigo(() => Vista.retocarHTML(src, 'Hola', 'Chau'))).toBe(409)
  expect(codigo(() => Vista.retocarHTML(src, 'No está', 'x'))).toBe(409)
  expect(codigo(() => Vista.retocarHTML(src, 'Comprar', 'x'))).toBe(409)
})
