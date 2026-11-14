// Port de app/Tests/BackendTests/BibliotecaTests.swift.
// Sin acceso a internals: el test de reinicio (que siembra filas con `b.store`) queda como skip para los unit tests del port.
// Los fixtures (PDF, .docx, .rtf) se generan/embeben aquí en vez de usar cupsfilter/textutil.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  Fix, Sandbox, U, dict, dormir, escribir, esperar, existe, historial, leerTexto, lista, listar, llamar, msgs, sinPrivate, str, ruta, regla,
  type Obj, type Resp,
} from '../support/sandbox.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
// textutil -convert docx de «Contrato de servicio. Duracion: 12 meses. Precio mensual: 90 dolares.»
const DOCX_B64 = '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'
const rtfContrato = (t: string) => Buffer.from(`{\\rtf1\\ansi\\ansicpg1252\\cocoartf2909\n{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\n\\pard\\f0\\fs24 \\cf0 ${t}}`)

/** PDF mínimo válido (una página, Helvetica) con una línea de texto por entrada; las posiciones del xref se calculan. */
function pdfConTexto(lineas: string[]): Buffer {
  const contenido = 'BT /F1 12 Tf 14 TL 72 720 Td ' + lineas.map((l) => `(${l}) Tj T*`).join(' ') + ' ET'
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

type Ag = { id: string; depto: string; rol?: string }

const bib = ({ env, agentes }: { env?: Record<string, string>; agentes?: Ag[] } = {}) =>
  Fix.crear({
    nombre: 'Taller', duenio: 'Ana', deps: ['Dirección', 'Redes'],
    agentes: agentes ?? [{ id: 'betty', depto: 'direccion' }, { id: 'marce', depto: 'redes' }], env,
  })

const sha = (d: Buffer) => createHash('sha256').update(d).digest('hex')

const subir = (f: Fix, nombre: string, data: Buffer, { depto, leer }: { depto?: string; leer?: boolean } = {}): Promise<Resp> => {
  const d: Obj = { nombre, base64: data.toString('base64') }
  if (depto !== undefined) d.departamento = depto
  if (leer !== undefined) d.leer = leer
  return f.post('/api/archivos', d)
}

const subirTexto = (f: Fix, nombre: string, texto: string, op: { depto?: string; leer?: boolean } = {}) =>
  subir(f, nombre, Buffer.from(texto, 'utf8'), op)

const archivo = (r: Resp): Obj => dict(r.obj.archivo)

/** Espera a que el archivo llegue a uno de esos estados y devuelve su ficha de API. */
async function aguardar(f: Fix, slug: string, estados: string[] = ['listo', 'error'], hasta = 15): Promise<Obj> {
  let ult: Obj = {}
  await esperar(async () => {
    ult = dict((await f.get(`/api/archivos/${slug}`)).obj.archivo)
    return estados.includes(str(ult.estado))
  }, hasta)
  return ult
}

/** Sube un texto y espera a que quede listo. */
async function subirYEsperar(f: Fix, nombre: string, texto: string, depto?: string): Promise<Obj> {
  const r = await subirTexto(f, nombre, texto, { depto })
  return aguardar(f, str(archivo(r).slug))
}

/** Espera a que no quede nada en la cola (para no dejar un claude corriendo al terminar el test). */
const reposo = (f: Fix) => esperar(async () => (await f.get('/api/biblioteca/estado')).obj.pendientes === 0, 15)

async function buscar(f: Fix, q: string, extra: Record<string, string> = {}): Promise<string[]> {
  return lista((await f.get('/api/archivos', { q, ...extra })).obj.archivos).map((a) => str(a.slug))
}

// macOS/Foundation pasa los argumentos del proceso en NFD y Swift compara por equivalencia canónica; JS no: se normaliza a NFC.
const nfc = (l: string[]) => l.map((x) => x.normalize('NFC'))
const conPrompt = (f: Fix, texto: string) => f.sb.llamadas.map(nfc).filter((a) => (a.at(-1) ?? '').includes(texto.normalize('NFC')))

const fichas = (f: Fix) => conPrompt(f, 'Sos el bibliotecario')

const fichaJSON = (c: Obj = {}): string =>
  JSON.stringify({
    titulo: 'Tarifario', resumen: 'Precios del taller.', datos_clave: ['150 dólares'], temas: ['finanzas'],
    util_para: ['direccion'], fechas: [], contradicciones: [], ...c,
  })

const uuidValido = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

/** cwd de una llamada concreta del claude falso (mismo orden que `llamadas`). */
function cwdDe(f: Fix, l: string[]): string {
  const clave = nfc(l).join('\u001f')
  const i = f.sb.llamadas.findIndex((x) => nfc(x).join('\u001f') === clave)
  expect(i).toBeGreaterThanOrEqual(0)
  return f.sb.cwds[i] ?? ''
}

const dia = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const contradiccion = (sug = 'El taller cuesta 150 dólares.') =>
  fichaJSON({
    contradicciones: [
      { actual: 'El taller cuesta 100 dólares', nuevo: 'El taller cuesta 150 dólares', sugerencia: sug },
      { actual: 'x', nuevo: 'y', sugerencia: '' },
    ],
  })

/** Dos documentos con fichas distintas para probar la búsqueda. */
async function prepararBusqueda(f: Fix) {
  f.sb.responder('ficha', fichaJSON({ titulo: 'Tarifario', temas: ['finanzas'], resumen: 'Precios del taller.' }))
  await subirYEsperar(f, 'precios.txt', 'El precio del taller de agosto es 150 dólares por persona.')
  f.sb.responder('ficha', fichaJSON({ titulo: 'Guion verano', temas: ['video'], resumen: 'Idea de reel.' }))
  await subirYEsperar(f, 'guion.txt', 'Guion del reel de verano con musica alegre.', 'redes')
}

/** Carpeta externa con material variado. */
function externa(f: Fix, nombre = 'externa'): string {
  const d = f.sb.root + '/' + nombre
  escribir('alfa uno', d + '/a.txt')
  escribir('beta dos', d + '/sub/b.md')
  escribir('oculto', d + '/.oculto.txt')
  escribir('oculto 2', d + '/.git/x.txt')
  escribir('binario', d + '/c.exe')
  // en Windows crear enlaces simbólicos pide permisos de administrador: sin enlace, lo que se verifica sigue valiendo
  try { fs.symlinkSync(d + '/a.txt', d + '/link.txt') } catch (e) { if (process.platform !== 'win32') throw e }
  return d
}

describe('Biblioteca', () => {
  // MARK: subir y fichar

  test('subir un .txt: se guarda, se extrae el texto, el bibliotecario lo ficha y queda en el catálogo', async () => {
    const f = await bib()
    const texto = 'Lista de precios 2026. El taller cuesta 150 dolares. Pedido minimo 12 unidades.'
    const data = Buffer.from(texto, 'utf8')
    const r = await subir(f, 'precios.txt', data)
    expect(r.status).toBe(200)
    const a = archivo(r)
    expect(a.slug).toBe('precios')
    expect(a.nombre).toBe('precios.txt')
    expect(a.departamento).toBe('compartido')
    expect(a.tipo).toBe('txt')
    expect(a.tam).toBe(data.length)
    expect(a.hash).toBe(sha(data))
    expect(a.origen).toBe('subido')
    expect(a.ruta).toBe('archivos/compartido/precios.txt')
    expect(a.estado).toBe('pendiente')
    expect(a.fichaRuta).toBe('conocimiento/fuentes/precios.md')
    expect(a.textoRuta).toBe('archivos/.texto/precios.md')
    expect(r.obj.duplicado).toBeUndefined()
    expect(fs.readFileSync(f.ruta('archivos/compartido/precios.txt')).equals(data)).toBe(true)

    const fin = await aguardar(f, 'precios')
    expect(fin.estado).toBe('listo')
    expect(fin.error).toBeUndefined()
    expect(f.leer('archivos/.texto/precios.md')).toBe(texto)
    const ficha = dict(fin.ficha)
    expect(ficha.titulo).toBe('Ficha de prueba')
    expect(ficha.resumen).toBe('Resumen de prueba del documento.')
    expect(ficha.util_para).toEqual(['direccion'])
    expect(fin.titulo).toBe('Ficha de prueba')
    const md = f.leer('conocimiento/fuentes/precios.md')
    expect(md.startsWith('# Ficha de prueba\n')).toBe(true)
    expect(md).toContain('- **Archivo:** precios.txt')
    expect(md).toContain(`- **Tipo:** txt · ${data.length} B`)
    expect(md).toContain('- **Carpeta:** Compartido')
    expect(md).toContain('- **Ubicación del original:** archivos/compartido/precios.txt')
    expect(md).toContain('- **Texto completo:** archivos/.texto/precios.md')
    expect(md).toContain(`- **Identificador:** precios (sha256 ${sha(data).slice(0, 12)})`)
    expect(md).toContain('- **Útil para:** Dirección')
    expect(md).toContain('## Resumen\n\nResumen de prueba del documento.')
    expect(md).toContain('## Datos clave\n\n- dato uno')
    expect(md).toContain('## Temas\n\npruebas')
    const cat = f.leer('conocimiento/archivos.md')
    expect(cat).toContain('- **Ficha de prueba** (`precios`, Compartido, txt): Resumen de prueba del documento. → `conocimiento/fuentes/precios.md`')
    expect(cat).not.toContain('(Todavía no hay documentos.)')
    // detalle
    const d = await f.get('/api/archivos/precios')
    expect(d.status).toBe(200)
    expect(d.obj.texto).toBe(texto)
    expect(dict(d.obj.archivo).rutaAbsoluta).toBe(ruta(f.carpeta, 'archivos/compartido/precios.txt'))
    // y un listado
    expect(lista((await f.get('/api/archivos')).obj.archivos).map((x) => str(x.slug))).toEqual(['precios'])
  })

  test('detalle: el texto se corta a 4000 caracteres con puntos suspensivos; el archivo de texto guarda todo', async () => {
    const f = await bib()
    const largo = 'abcdefghij'.repeat(500) // 5000
    await subirYEsperar(f, 'largo.txt', largo)
    const d = await f.get('/api/archivos/largo')
    expect(d.obj.texto).toBe(largo.slice(0, 4000) + '…')
    expect(f.leer('archivos/.texto/largo.md')).toBe(largo)
  })

  test('la ficha se pide a claude SIN agente y SIN herramientas, con cwd en la oficina y el contexto en el prompt', async () => {
    const f = await bib()
    escribir('# Taller\nMEMORIA_Z: precios en dólares', f.ruta('conocimiento/oficina.md'))
    escribir('- 2026-01-01: DECISION_Y', f.ruta('conocimiento/decisiones.md'))
    await subirYEsperar(f, 'precios.txt', 'TEXTO_DEL_DOCUMENTO uno dos tres', 'redes')
    const ll = fichas(f)
    expect(ll.length).toBe(1)
    const l = ll[0]!
    expect(l).not.toContain('--agent')
    expect(Sandbox.valor(l, '--tools')).toBe('')
    expect(Sandbox.valor(l, '--permission-mode')).toBe('dontAsk')
    expect(Sandbox.valor(l, '--disallowedTools')).toBe('mcp__claude_ai_*')
    expect(sinPrivate(cwdDe(f, l))).toBe(sinPrivate(f.carpeta))
    const p = l[l.length - 1]!
    expect(p).toContain('Sos el bibliotecario de la oficina «Taller»')
    expect(p).toContain('Documento: precios.txt (tipo: txt; carpeta: Redes)')
    expect(p).toContain('- direccion: Dirección\n- redes: Redes')
    expect(p).toContain('MEMORIA_Z: precios en dólares')
    expect(p).toContain('DECISION_Y')
    expect(p).toContain('<<<\nTEXTO_DEL_DOCUMENTO uno dos tres\n>>>')
  })

  test('el texto que va al prompt de la ficha se recorta a 12000 caracteres (el completo queda en archivos/.texto)', async () => {
    const f = await bib()
    const texto = 'x'.repeat(12_000) + 'FUERA_DEL_PROMPT'
    await subirYEsperar(f, 'largo.txt', texto)
    const p = fichas(f)[0]!.at(-1)!
    expect(p).toContain('x'.repeat(12_000))
    expect(p).not.toContain('FUERA_DEL_PROMPT')
    expect(f.leer('archivos/.texto/largo.md')).toBe(texto)
  })

  test('PDF: el texto sale con PDFKit', async () => {
    const f = await bib()
    const pdf = pdfConTexto(['Pedido minimo 12 unidades', 'Entrega en 5 dias habiles'])
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
    const r = await subir(f, 'condiciones.pdf', pdf)
    expect(r.status).toBe(200)
    expect(archivo(r).tipo).toBe('pdf')
    const fin = await aguardar(f, 'condiciones')
    expect(fin.estado).toBe('listo')
    const texto = f.leer('archivos/.texto/condiciones.md')
    expect(texto, `texto extraído: ${texto}`).toContain('Pedido minimo 12 unidades')
    expect(texto).toContain('Entrega en 5 dias habiles')
    expect(fichas(f)[0]!.at(-1)!).toContain('Pedido minimo 12 unidades')
    expect(await buscar(f, 'unidades')).toEqual(['condiciones'])
  })

  test('PDF roto: queda en error con aviso, sin ficha, pero buscable por su nombre', async () => {
    const f = await bib()
    const r = await subir(f, 'roto.pdf', Buffer.from('%PDF-1.4\nesto no es un pdf de verdad'))
    expect(r.status).toBe(200)
    const fin = await aguardar(f, 'roto')
    expect(fin.estado).toBe('error')
    expect(fin.aviso).toBe('No pude abrir el PDF.')
    expect(fin.error).toBe('No pude abrir el PDF.')
    expect(fin.ficha).toBeUndefined()
    expect(f.existe('conocimiento/fuentes/roto.md')).toBe(false)
    expect(fichas(f)).toEqual([])
    expect(f.leer('conocimiento/archivos.md')).toContain('- **roto.pdf** (`roto`, Compartido, pdf): todavía sin ficha (no se pudo fichar)')
    expect(await buscar(f, 'roto')).toEqual(['roto'])
  })

  test('.docx y .rtf: textutil extrae el texto', async () => {
    const f = await bib()
    const texto = 'Contrato de servicio. Duracion: 12 meses. Precio mensual: 90 dolares.'
    const docx = Buffer.from(DOCX_B64, 'base64')
    const rtf = rtfContrato(texto)
    for (const [nombre, data] of [['contrato.docx', docx], ['acuerdo.rtf', rtf]] as const) {
      const r = await subir(f, nombre, data)
      expect(r.status, `${nombre}: ${JSON.stringify(r.obj)}`).toBe(200)
      const slug = str(archivo(r).slug)
      const fin = await aguardar(f, slug)
      expect(fin.estado, `${nombre}: ${JSON.stringify(fin)}`).toBe('listo')
      expect(f.leer(`archivos/.texto/${slug}.md`), nombre).toContain('Duracion: 12 meses')
    }
    expect(new Set(await buscar(f, 'dolares'))).toEqual(new Set(['contrato', 'acuerdo']))
  })

  test('.docx que no se puede leer: error con aviso', async () => {
    const f = await bib()
    await subir(f, 'malo.docx', Buffer.from('PK\u0003\u0004garbagegarbagegarbage'))
    const fin = await aguardar(f, 'malo')
    expect(fin.estado).toBe('error')
    expect(str(fin.aviso)).not.toBe('')
    expect(f.existe('conocimiento/fuentes/malo.md')).toBe(false)
  })

  test('imagen .png: claude -p sin agente con Read la describe; la descripción es su texto y se ficha', async () => {
    const f = await bib()
    const r = await subir(f, 'foto.png', png)
    expect(r.status).toBe(200)
    expect(archivo(r).tipo).toBe('png')
    const fin = await aguardar(f, 'foto')
    expect(fin.estado).toBe('listo')
    const desc = conPrompt(f, 'Describí la imagen')
    expect(desc.length).toBe(1)
    const l = desc[0]!
    expect(l).not.toContain('--agent')
    expect(Sandbox.valor(l, '--tools')).toBe('Read')
    expect(Sandbox.valor(l, '--permission-mode')).toBe('dontAsk')
    expect(Sandbox.valor(l, '--allowedTools')).toBe('Read')
    expect(Sandbox.valor(l, '--disallowedTools')).toBe('mcp__claude_ai_*')
    expect(Sandbox.valores(l, '--add-dir')).toEqual([ruta(f.carpeta, 'archivos/compartido')])
    expect(l.at(-1)!).toContain(ruta(f.carpeta, 'archivos/compartido/foto.png'))
    expect(f.leer('archivos/.texto/foto.md')).toBe('Una imagen de prueba con el texto HOLA MUNDO.')
    expect(fichas(f)[0]!.at(-1)!).toContain('HOLA MUNDO')
    expect(await buscar(f, 'hola')).toEqual(['foto'])
    // el original se puede bajar tal cual
    const o = await f.get('/api/archivos/foto/original')
    expect(o.status).toBe(200)
    expect(o.obj.mime).toBe('image/png')
    expect(o.obj.nombre).toBe('foto.png')
    expect(o.obj.tam).toBe(png.length)
    expect(o.obj.base64).toBe(png.toString('base64'))
    expect(o.obj.ruta).toBe(ruta(f.carpeta, 'archivos/compartido/foto.png'))
  })

  test('imagen: si claude no puede describirla, queda en error con aviso y sin ficha', async () => {
    const f = await bib()
    f.sb.modo('imagen', 'error')
    await subir(f, 'foto.png', png)
    const fin = await aguardar(f, 'foto')
    expect(fin.estado).toBe('error')
    expect(str(fin.aviso).startsWith('No pude describir la imagen:')).toBe(true)
    expect(fichas(f)).toEqual([])
    expect(f.existe('archivos/.texto/foto.md')).toBe(false)
    // descripción vacía
    f.sb.modo('imagen', 'vacio')
    await subir(f, 'otra.png', Buffer.concat([png, Buffer.from([0])]))
    const v = await aguardar(f, 'otra')
    expect(v.estado).toBe('error')
    expect(v.aviso).toBe('Claude no devolvió una descripción de la imagen.')
  })

  // MARK: sanitización, tipos y tamaños

  test('el nombre se sanea: sin rutas, «..», caracteres de control ni «:»; no se escribe nada fuera de la oficina', async () => {
    const f = await bib()
    const casos: [string, string][] = [
      ['../../etc/pass:wd*.txt', 'pass-wd-.txt'],
      ['..\\..\\windows\\x.txt', 'x.txt'],
      ['.hidden.txt', 'hidden.txt'],
      ['con\u0007control.txt', 'con-control.txt'],
      ['a..b.txt', 'a.b.txt'],
      ['  espacios  .txt', 'espacios  .txt'],
      ['pregunta?.txt', 'pregunta-.txt'],
      ['n'.repeat(130) + '.txt', 'n'.repeat(116) + '.txt'],
      ['MAYUS.TXT', 'MAYUS.TXT'],
    ]
    let i = 0
    for (const [crudo, esperado] of casos) {
      const r = await subirTexto(f, crudo, `contenido de ${i++}`)
      expect(r.status, `${crudo} -> ${JSON.stringify(r.obj)}`).toBe(200)
      const a = archivo(r)
      expect(a.nombre, `${crudo} -> ${a.nombre}`).toBe(esperado)
      expect(f.existe(`archivos/compartido/${esperado}`), crudo).toBe(true)
      expect(a.ruta).toBe(`archivos/compartido/${esperado}`)
    }
    expect(archivo(await subirTexto(f, 'MAYUS2.TXT', 'x')).tipo).toBe('txt')
    // nada afuera: la carpeta de oficinas solo tiene la oficina, y la oficina no tiene carpetas nuevas por los «..»
    expect(listar(f.sb.oficinasDir)).toEqual(['Taller'])
    expect(!existe(f.sb.oficinasDir + '/Taller/etc') && !existe(f.sb.oficinasDir + '/etc') && !existe(f.sb.root + '/etc')).toBe(true)
    expect(existe(f.carpeta + '/archivos/etc')).toBe(false)
    await reposo(f)
  })

  test('subida: tipos no soportados, sin extensión, nombre o contenido inválidos -> 400', async () => {
    const f = await bib()
    const malo = async (d: Obj, contiene?: string) => {
      const r = await f.post('/api/archivos', d)
      expect(r.status, `${JSON.stringify(d)} -> ${r.status} ${JSON.stringify(r.obj)}`).toBe(400)
      if (contiene) expect(str(r.obj.error), `${JSON.stringify(d)} -> ${JSON.stringify(r.obj)}`).toContain(contiene)
    }
    const b = Buffer.from('hola').toString('base64')
    await malo({ nombre: 'virus.exe', base64: b }, '.exe')
    await malo({ nombre: 'sinextension', base64: b }, 'sin extensión')
    await malo({ nombre: '.txt', base64: b })
    await malo({ base64: b }, 'nombre')
    await malo({ nombre: '  ', base64: b })
    await malo({ nombre: 5, base64: b })
    await malo({ nombre: 'n'.repeat(256) + '.txt', base64: b })
    await malo({ nombre: 'a.txt' }, 'base64')
    await malo({ nombre: 'a.txt', base64: '' }, 'base64')
    await malo({ nombre: 'a.txt', base64: '%%%%' }, 'base64')
    await malo({ nombre: 'a.txt', base64: b, departamento: 'inexistente' }, 'no existe')
    expect((await f.post('/api/archivos')).status).toBe(400)
    // la lista de tipos soportados está en el mensaje
    const r = await f.post('/api/archivos', { nombre: 'x.zip', base64: b })
    const e = str(r.obj.error)
    expect(e.includes('.pdf') && e.includes('.docx') && e.includes('.png')).toBe(true)
    expect(listar(f.carpeta + '/archivos/compartido')).toEqual([])
    expect(lista((await f.get('/api/archivos')).obj.archivos)).toEqual([])
    // data: URL y departamento válido
    const ok = await f.post('/api/archivos', { nombre: 'ok.txt', base64: 'data:text/plain;base64,' + b, departamento: 'redes' })
    expect(ok.status).toBe(200)
    expect(archivo(ok).departamento).toBe('redes')
    expect(archivo(ok).ruta).toBe('archivos/redes/ok.txt')
    expect(f.leer('archivos/redes/ok.txt')).toBe('hola')
    const compartido = await f.post('/api/archivos', { nombre: 'ok2.txt', base64: b, departamento: 'compartido' })
    expect(archivo(compartido).departamento).toBe('compartido')
    await aguardar(f, 'ok'); await aguardar(f, 'ok2')
  })

  test('tamaño máximo: 413 por encima de maxMB (config de la oficina o HQ_BIBLIOTECA_MAX_MB) y nada se escribe', async () => {
    const f = await bib()
    const cfg = await f.patch('/api/biblioteca/config', { maxMB: 1 })
    expect(cfg.status).toBe(200)
    expect(cfg.obj.maxMB).toBe(1)
    const uno = 1_048_576
    const justo = await subir(f, 'justo.txt', Buffer.alloc(uno + 1, 0x61))
    expect(justo.status).toBe(413)
    expect(str(justo.obj.error)).toContain('1 MB')
    const enorme = await subir(f, 'enorme.txt', Buffer.alloc(3 * uno, 0x61))
    expect(enorme.status).toBe(413)
    expect(listar(f.carpeta + '/archivos/compartido')).toEqual([])
    expect(lista((await f.get('/api/archivos')).obj.archivos)).toEqual([])
    // en el límite exacto pasa
    const ok = await subir(f, 'limite.txt', Buffer.alloc(uno, 0x61))
    expect(ok.status).toBe(200)
    await aguardar(f, 'limite')
    // la variable de entorno rige cuando la oficina no define nada
    const g = await bib({ env: { HQ_BIBLIOTECA_MAX_MB: '1' } })
    expect((await g.get('/api/biblioteca/config')).obj.maxMB).toBe(1)
    expect((await subir(g, 'justo.txt', Buffer.alloc(uno + 1, 0x61))).status).toBe(413)
    // y lo de la oficina pisa al entorno
    await g.patch('/api/biblioteca/config', { maxMB: 2 })
    expect((await subir(g, 'justo.txt', Buffer.alloc(uno + 1, 0x61))).status).toBe(200)
    await aguardar(g, 'justo')
  })

  // MARK: duplicados y reemplazos

  test('duplicado: mismo contenido en la misma carpeta no se vuelve a procesar; en otra carpeta es otro archivo', async () => {
    const f = await bib()
    await subirYEsperar(f, 'precios.txt', 'contenido uno')
    expect(fichas(f).length).toBe(1)
    const d1 = await subirTexto(f, 'precios.txt', 'contenido uno')
    expect(d1.status).toBe(200)
    expect(d1.obj.duplicado).toBe(true)
    expect(archivo(d1).slug).toBe('precios')
    expect(archivo(d1).duplicado).toBe(true)
    // mismo contenido con otro nombre, misma carpeta: también es el mismo
    const d2 = await subirTexto(f, 'copia.txt', 'contenido uno')
    expect(d2.obj.duplicado).toBe(true)
    expect(archivo(d2).slug).toBe('precios')
    expect(f.existe('archivos/compartido/copia.txt')).toBe(false)
    expect(lista((await f.get('/api/archivos')).obj.archivos).length).toBe(1)
    // otra carpeta: archivo nuevo con slug distinto
    const otra = await subirTexto(f, 'precios.txt', 'contenido uno', { depto: 'redes' })
    expect(otra.obj.duplicado).toBeUndefined()
    expect(archivo(otra).slug).toBe('precios-2')
    expect(archivo(otra).ruta).toBe('archivos/redes/precios.txt')
    await aguardar(f, 'precios-2')
    expect(fichas(f).length).toBe(2)
  })

  test('mismo nombre con otro contenido en la misma carpeta: se reemplaza y se vuelve a procesar (reindexa por hash)', async () => {
    const f = await bib()
    const v1 = await subirYEsperar(f, 'precios.txt', 'version vieja con palabra_vieja')
    const h1 = str(v1.hash)
    const r = await subirTexto(f, 'precios.txt', 'version nueva con palabra_nueva')
    expect(r.status).toBe(200)
    expect(r.obj.reemplazado).toBe(true)
    const a = archivo(r)
    expect(a.slug).toBe('precios')
    expect(a.estado).toBe('pendiente')
    expect(a.hash).not.toBe(h1)
    expect(a.hash).toBe(sha(Buffer.from('version nueva con palabra_nueva')))
    const fin = await aguardar(f, 'precios')
    expect(fin.estado).toBe('listo')
    expect(f.leer('archivos/compartido/precios.txt')).toBe('version nueva con palabra_nueva')
    expect(f.leer('archivos/.texto/precios.md')).toBe('version nueva con palabra_nueva')
    expect(fichas(f).length).toBe(2)
    expect(await buscar(f, 'palabra_nueva')).toEqual(['precios'])
    expect(await buscar(f, 'palabra_vieja')).toEqual([])
    expect(lista((await f.get('/api/archivos')).obj.archivos).length).toBe(1)
    expect(f.leer('conocimiento/fuentes/precios.md')).toContain(`sha256 ${sha(Buffer.from('version nueva con palabra_nueva')).slice(0, 12)}`)
  })

  test('slugs: dos archivos con el mismo nombre base y distinta extensión no se pisan', async () => {
    const f = await bib()
    const a = await subirTexto(f, 'notas.txt', 'uno')
    const b = await subirTexto(f, 'notas.md', 'dos')
    expect(archivo(a).slug).toBe('notas')
    expect(archivo(b).slug).toBe('notas-2')
    expect(f.leer('archivos/compartido/notas.txt') === 'uno' && f.leer('archivos/compartido/notas.md') === 'dos').toBe(true)
    await aguardar(f, 'notas'); await aguardar(f, 'notas-2')
    expect(f.existe('conocimiento/fuentes/notas.md') && f.existe('conocimiento/fuentes/notas-2.md')).toBe(true)
    expect(f.leer('archivos/.texto/notas.md') === 'uno' && f.leer('archivos/.texto/notas-2.md') === 'dos').toBe(true)
  })

  // MARK: ficha: variantes y errores

  test('ficha: acepta ```json con texto, normaliza listas, mapea nombres de departamento a ids y usa el nombre si falta el título', async () => {
    const f = await bib()
    f.sb.responder('ficha', 'Claro, acá va:\n```json\n{"resumen": "Solo resumen", "datos_clave": "un dato", "temas": "tema suelto", "util_para": ["Redes", "redes", "inexistente", "Dirección"], "fechas": ["2026-12-01"]}\n```\nEspero que sirva.')
    const fin = await subirYEsperar(f, 'notas.txt', 'texto de notas')
    expect(fin.estado).toBe('listo')
    const ficha = dict(fin.ficha)
    expect(ficha.titulo).toBe('notas.txt')
    expect(ficha.datos_clave).toEqual(['un dato'])
    expect(ficha.temas).toEqual(['tema suelto'])
    expect(ficha.util_para).toEqual(['redes', 'direccion'])
    expect(ficha.fechas).toEqual(['2026-12-01'])
    expect(f.leer('conocimiento/fuentes/notas.md')).toContain('- **Fechas:** 2026-12-01')
    expect(f.leer('conocimiento/fuentes/notas.md')).toContain('- **Útil para:** Redes, Dirección')
  })

  test('ficha mal formada o con error de claude: el archivo queda en error pero su texto es buscable y está en el catálogo', async () => {
    const f = await bib()
    f.sb.responder('ficha', 'no puedo armar una ficha')
    const a = await subirYEsperar(f, 'primero.txt', 'contenido buscable alfa')
    expect(a.estado).toBe('error')
    expect(a.error).toBe('El bibliotecario no devolvió la ficha en el formato esperado.')
    expect(a.ficha).toBeUndefined()
    expect(f.existe('conocimiento/fuentes/primero.md')).toBe(false)
    expect(f.existe('archivos/.texto/primero.md')).toBe(true)
    expect(await buscar(f, 'alfa')).toEqual(['primero'])
    const linea = '- **primero.txt** (`primero`, Compartido, txt): todavía sin ficha'
    expect(f.leer('conocimiento/archivos.md')).toContain(linea)
    // BUG (Biblioteca.extraerYFichar): el catálogo se regenera antes de pasar el archivo a «error», así que la línea queda
    // para siempre en «(en proceso)» en vez de «(no se pudo fichar)».
    expect(f.leer('conocimiento/archivos.md')).toContain(linea + ' (no se pudo fichar)')
    f.sb.modo('ficha', 'error')
    const b = await subirYEsperar(f, 'segundo.txt', 'contenido buscable beta')
    expect(b.estado).toBe('error')
    expect(str(b.error)).not.toBe('')
    expect(await buscar(f, 'beta')).toEqual(['segundo'])
    // ficha con título y resumen vacíos: tampoco sirve
    f.sb.modo('ficha', null)
    f.sb.responder('ficha', '{"titulo": "", "resumen": ""}')
    const c = await subirYEsperar(f, 'tercero.txt', 'contenido gamma')
    expect(c.estado).toBe('error')
  })

  test('reprocesar: vuelve a extraer y fichar; 404 si no existe o si el original ya no está', async () => {
    const f = await bib()
    await subirYEsperar(f, 'precios.txt', 'contenido')
    escribir('contenido modificado a mano', f.ruta('archivos/compartido/precios.txt'))
    const r = await f.post('/api/archivos/precios/reprocesar')
    expect(r.status).toBe(200)
    expect(archivo(r).estado).toBe('pendiente')
    const fin = await aguardar(f, 'precios')
    expect(fin.estado).toBe('listo')
    expect(f.leer('archivos/.texto/precios.md')).toBe('contenido modificado a mano')
    expect(fichas(f).length).toBe(2)
    expect((await f.post('/api/archivos/nada/reprocesar')).status).toBe(404)
    fs.rmSync(f.ruta('archivos/compartido/precios.txt'))
    expect((await f.post('/api/archivos/precios/reprocesar')).status).toBe(404)
    expect((await f.get('/api/archivos/precios/original')).status).toBe(404)
  })

  test('catálogo: una línea por documento, ordenado por carpeta y nombre; el listado filtra por departamento', async () => {
    const f = await bib()
    f.sb.responder('ficha', fichaJSON({ titulo: 'Doc de redes' }))
    await subirYEsperar(f, 'zeta.txt', 'z', 'redes')
    f.sb.responder('ficha', fichaJSON({ titulo: 'Doc compartido B' }))
    await subirYEsperar(f, 'b.txt', 'b')
    f.sb.responder('ficha', fichaJSON({ titulo: 'Doc compartido A' }))
    await subirYEsperar(f, 'a.txt', 'a')
    const cat = f.leer('conocimiento/archivos.md')
    const lineas = cat.split('\n').filter((l) => l.startsWith('- '))
    expect(lineas.length).toBe(3)
    expect(lineas[0]!.startsWith('- **Doc compartido A** (`a`, Compartido, txt)')).toBe(true)
    expect(lineas[1]!.startsWith('- **Doc compartido B** (`b`, Compartido, txt)')).toBe(true)
    expect(lineas[2]!.startsWith('- **Doc de redes** (`zeta`, Redes, txt)')).toBe(true)
    expect(await buscar(f, '', { departamento: 'redes' })).toEqual(['zeta'])
    const todos = lista((await f.get('/api/archivos', { departamento: 'compartido' })).obj.archivos).map((x) => str(x.slug))
    expect(new Set(todos)).toEqual(new Set(['a', 'b']))
    expect(lista((await f.get('/api/archivos')).obj.archivos).length).toBe(3)
  })

  // MARK: búsqueda

  test('búsqueda FTS5: sin importar mayúsculas ni acentos, por prefijo, varias palabras (todas), en título, resumen, temas y texto', async () => {
    const f = await bib()
    await prepararBusqueda(f)
    expect((await f.get('/api/biblioteca/estado')).obj.fts).toBe(true)
    expect(await buscar(f, 'agosto')).toEqual(['precios'])
    expect(await buscar(f, 'AGOSTO')).toEqual(['precios'])
    expect(await buscar(f, 'dolares')).toEqual(['precios']) // el texto dice «dólares»
    expect(await buscar(f, 'dólares')).toEqual(['precios'])
    expect(await buscar(f, 'dolar')).toEqual(['precios']) // prefijo
    expect(await buscar(f, 'taller agosto')).toEqual(['precios'])
    expect(await buscar(f, 'taller reel')).toEqual([]) // todas las palabras
    expect(await buscar(f, 'guion')).toEqual(['guion']) // título/nombre
    expect(await buscar(f, 'finanzas')).toEqual(['precios']) // temas
    expect(await buscar(f, 'idea')).toEqual(['guion']) // resumen
    expect(await buscar(f, 'Tarifario')).toEqual(['precios'])
    expect(await buscar(f, 'nada de esto')).toEqual([])
    expect(await buscar(f, '!!!')).toEqual([])
    // sintaxis de FTS en la consulta no rompe nada
    const r = await f.get('/api/archivos', { q: '"agosto" OR * NEAR(' })
    expect(r.status).toBe(200)
    // snippet con la coincidencia entre corchetes
    const s = lista((await f.get('/api/archivos', { q: 'agosto' })).obj.archivos)
    expect(str(s[0]!.snippet)).toContain('[agosto]')
    expect((await f.get('/api/archivos', { q: 'agosto' })).obj.q).toBe('agosto')
    // sin q: todo, sin snippet; con q en blanco también
    const todos = lista((await f.get('/api/archivos', { q: '   ' })).obj.archivos)
    expect(todos.length === 2 && todos.every((x) => x.snippet === undefined)).toBe(true)
    expect((await f.get('/api/archivos', { q: '   ' })).obj.q).toBeUndefined()
    // se combina con el filtro por departamento
    expect(await buscar(f, 'reel', { departamento: 'redes' })).toEqual(['guion'])
    expect(await buscar(f, 'reel', { departamento: 'compartido' })).toEqual([])
  })

  test('búsqueda sin FTS5 (HQ_BIBLIOTECA_SIN_FTS=1): LIKE con los mismos resultados y fragmento con puntos suspensivos', async () => {
    const f = await bib({ env: { HQ_BIBLIOTECA_SIN_FTS: '1' } })
    await prepararBusqueda(f)
    expect((await f.get('/api/biblioteca/estado')).obj.fts).toBe(false)
    expect(await buscar(f, 'agosto')).toEqual(['precios'])
    expect(await buscar(f, 'AGOSTO')).toEqual(['precios'])
    expect(await buscar(f, 'taller agosto')).toEqual(['precios'])
    expect(await buscar(f, 'taller reel')).toEqual([])
    expect(await buscar(f, 'guion')).toEqual(['guion'])
    expect(await buscar(f, 'finanzas')).toEqual(['precios'])
    expect(await buscar(f, 'idea')).toEqual(['guion'])
    expect(await buscar(f, 'precio')).toEqual(['precios'])
    expect(await buscar(f, 'nada de esto')).toEqual([])
    expect((await f.get('/api/archivos', { q: '"agosto" OR * NEAR(' })).status).toBe(200)
    const s = lista((await f.get('/api/archivos', { q: 'agosto' })).obj.archivos)
    const snippet = str(s[0]!.snippet)
    expect(snippet.startsWith('…') && snippet.endsWith('…') && snippet.includes('agosto')).toBe(true)
    // la búsqueda ignora los acentos del texto: «dolares» tiene que encontrar «dólares» (FTS lo hace; LIKE no)
    expect(await buscar(f, 'dolares')).toEqual(['precios'])
  })

  test('búsqueda: separada por oficina y sin lo que está en la papelera', async () => {
    const f = await bib()
    await prepararBusqueda(f)
    expect(await buscar(f, 'agosto')).toEqual(['precios'])
    // otra oficina no lo ve
    await llamar(f.b, 'POST', '/api/oficinas', { body: { nombre: 'Otra' } })
    expect(await buscar(f, 'agosto')).toEqual([])
    expect(lista((await f.get('/api/archivos')).obj.archivos)).toEqual([])
    expect((await f.get('/api/archivos/precios')).status).toBe(404)
    await llamar(f.b, 'POST', '/api/oficinas/abrir', { body: { carpeta: f.carpeta } })
    expect(await buscar(f, 'agosto')).toEqual(['precios'])
    // papelera
    expect((await f.delete('/api/archivos/precios')).status).toBe(200)
    expect(await buscar(f, 'agosto')).toEqual([])
    expect(await buscar(f, 'taller')).toEqual([])
    expect(await buscar(f, 'guion')).toEqual(['guion'])
  })

  // MARK: lectura por rol

  test('lectura por rol al subir con leer:true: lee el agente de los departamentos «útil para», solo escribe su nota', async () => {
    const f = await bib()
    f.sb.responder('ficha', fichaJSON({ util_para: ['redes'] }))
    const r = await subirTexto(f, 'precios.txt', 'El taller cuesta 150 dolares', { leer: true })
    expect(r.status).toBe(200)
    const fin = await aguardar(f, 'precios')
    expect(fin.estado).toBe('listo')
    expect(fin.lectura).toEqual({ marce: 'ok' })
    expect(fin.leer).toBeUndefined()
    expect(f.leer('conocimiento/agentes/marce.md')).toContain('- leyó el documento (prueba)')
    expect(f.leer('conocimiento/agentes/betty.md')).not.toContain('leyó')
    // una sola lectura, de marce
    const lect = conPrompt(f, 'Se sumó un documento a la biblioteca')
    expect(lect.length).toBe(1)
    const l = lect[0]!
    expect(Sandbox.valor(l, '--agent')).toBe('marce')
    expect(uuidValido(Sandbox.valor(l, '--session-id') ?? '')).toBe(true)
    expect(Sandbox.valor(l, '--tools')).toBe('Read,Glob,Grep,Skill,Edit,Write')
    // permiso de escritura: SOLO su archivo de notas (ni entregables ni nada más)
    const notas = ruta(f.carpeta, 'conocimiento/agentes/marce.md')
    expect(Sandbox.reglas(l)).toEqual(['Read', 'Glob', 'Grep', 'Skill', regla('Edit', notas), regla('Write', notas), '--disallowedTools', 'mcp__claude_ai_*'])
    expect(l).not.toContain('--add-dir')
    expect(sinPrivate(cwdDe(f, l))).toBe(sinPrivate(f.carpeta))
    const p = l.at(-1)!
    expect(p).toContain('«Tarifario» (archivo precios.txt)')
    expect(p.includes('`conocimiento/fuentes/precios.md`') && p.includes('`archivos/.texto/precios.md`')).toBe(true)
    expect(p).toContain('`conocimiento/agentes/marce.md`, el único archivo que podés escribir')
    expect(p).toContain('desde tu rol de Rol de marce')
    // el catálogo, la ficha y el texto los escribió el backend, no el agente
    expect(f.existe('conocimiento/fuentes/precios.md')).toBe(true)
    // las lecturas no tocan el chat 1 a 1
    expect(msgs(await historial(f.b, { agent: 'marce' }))).toEqual([])
  })

  test('lectura por rol: sin «útil para» lee quien está en el departamento del archivo; sin nadie, no lee', async () => {
    const f = await bib()
    f.sb.responder('ficha', fichaJSON({ util_para: [] }))
    const en = await subirTexto(f, 'a.txt', 'uno', { depto: 'redes', leer: true })
    await aguardar(f, str(archivo(en).slug))
    expect(conPrompt(f, 'Se sumó un documento').flatMap((l) => Sandbox.valor(l, '--agent') ?? [])).toEqual(['marce'])
    // en «compartido» y sin «útil para» no hay a quién mandar: queda listo sin lecturas
    const sin = await subirTexto(f, 'b.txt', 'dos', { leer: true })
    const fin = await aguardar(f, str(archivo(sin).slug))
    expect(fin.estado).toBe('listo')
    expect(fin.lectura).toBeUndefined()
    expect(conPrompt(f, 'Se sumó un documento').length).toBe(1)
  })

  test('lectura por rol a pedido: POST /leer con o sin agentes; validaciones y 409', async () => {
    const f = await bib()
    await subirYEsperar(f, 'precios.txt', 'El taller cuesta 150 dolares') // util_para ["direccion"] (betty)
    const r = await f.post('/api/archivos/precios/leer', { agentes: ['marce'] })
    expect(r.status).toBe(200)
    expect(r.obj.agentes).toEqual(['marce'])
    const a = await aguardar(f, 'precios')
    expect(a.lectura).toEqual({ marce: 'ok' })
    // sin cuerpo: los de «útil para» (Dirección -> betty)
    const b = await f.post('/api/archivos/precios/leer')
    expect(b.status).toBe(200)
    expect(b.obj.agentes).toEqual(['betty'])
    const c = await aguardar(f, 'precios')
    expect(c.lectura).toEqual({ betty: 'ok' })
    expect(f.leer('conocimiento/agentes/betty.md')).toContain('leyó')
    // errores
    expect((await f.post('/api/archivos/precios/leer', { agentes: ['fantasma'] })).status).toBe(400)
    expect((await f.post('/api/archivos/precios/leer', { agentes: 'betty' })).status).toBe(400)
    expect((await f.post('/api/archivos/nada/leer')).status).toBe(404)
    expect((await llamar(f.b, 'GET', '/api/archivos/precios/leer')).status).toBe(405)
    // sin «útil para» ni departamento propio: 409
    f.sb.responder('ficha', fichaJSON({ util_para: [] }))
    await subirYEsperar(f, 'huerfano.txt', 'sin dueño')
    const v = await f.post('/api/archivos/huerfano/leer')
    expect(v.status).toBe(409)
    expect(str(v.obj.error)).toContain('No hay agentes')
  })

  test('lectura por rol: 409 mientras el archivo no tiene ficha (todavía procesándose)', async () => {
    const f = await bib()
    f.sb.modo('ficha', 'puerta')
    await subirTexto(f, 'precios.txt', 'texto')
    expect(await esperar(() => f.sb.eventos.includes('S '))).toBe(true)
    const r = await f.post('/api/archivos/precios/leer', { agentes: ['betty'] })
    expect(r.status).toBe(409)
    expect(str(r.obj.error)).toContain('ficha')
    f.sb.abrirPuerta()
    expect((await aguardar(f, 'precios')).estado).toBe('listo')
  })

  test('estado de la biblioteca: la cola, quién está leyendo y las propuestas; vacío cuando todo está listo', async () => {
    const f = await bib()
    const vacio = await f.get('/api/biblioteca/estado')
    expect(vacio.status).toBe(200)
    expect(new Set(Object.keys(vacio.obj))).toEqual(new Set(['cola', 'pendientes', 'total', 'leyendo', 'propuestas', 'fts']))
    expect(vacio.obj.total === 0 && vacio.obj.pendientes === 0).toBe(true)
    // mientras se ficha
    f.sb.modo('ficha', 'puerta')
    await subirTexto(f, 'uno.txt', 'texto uno')
    expect(await esperar(() => f.sb.eventos.includes('S '))).toBe(true)
    let e = await f.get('/api/biblioteca/estado')
    expect(e.obj.pendientes === 1 && e.obj.total === 1).toBe(true)
    expect(lista(e.obj.cola).map((x) => str(x.slug) + ':' + str(x.estado))).toEqual(['uno:fichando'])
    f.sb.abrirPuerta()
    await aguardar(f, 'uno')
    // mientras lee un agente
    f.sb.modo('ficha', null)
    f.sb.modo('marce', 'puerta')
    fs.rmSync(path.join(f.sb.binDir, 'go'), { force: true })
    f.sb.responder('ficha', fichaJSON({ util_para: ['redes'] }))
    await subirTexto(f, 'dos.txt', 'texto dos', { leer: true })
    expect(await esperar(() => f.sb.eventos.includes('S marce'))).toBe(true)
    e = await f.get('/api/biblioteca/estado')
    expect(e.obj.leyendo).toEqual(['marce'])
    const item = lista(e.obj.cola)[0]!
    expect(item).toBeDefined()
    expect(item.slug === 'dos' && item.estado === 'leyendo').toBe(true)
    expect(item.leer).toEqual(['marce'])
    f.sb.abrirPuerta()
    await aguardar(f, 'dos')
    e = await f.get('/api/biblioteca/estado')
    expect(e.obj.leyendo).toEqual([])
    expect(lista(e.obj.cola)).toEqual([])
    expect(e.obj.pendientes).toBe(0)
    expect(e.obj.total).toBe(2)
  })

  test('lectura por rol: si el agente falla queda registrado como error y el archivo igual termina listo', async () => {
    const f = await bib()
    f.sb.modo('marce', 'error')
    f.sb.responder('ficha', fichaJSON({ util_para: ['redes', 'direccion'] }))
    await subirTexto(f, 'precios.txt', 'texto', { leer: true })
    const fin = await aguardar(f, 'precios')
    expect(fin.estado).toBe('listo')
    const lectura = (fin.lectura ?? {}) as Record<string, string>
    expect(lectura.betty).toBe('ok')
    expect(lectura.marce?.startsWith('error: ')).toBe(true)
  })

  test('config de la biblioteca: lectura automática, límites y validaciones; se guarda en oficina.json', async () => {
    const f = await bib()
    const g = await f.get('/api/biblioteca/config')
    expect(g.status).toBe(200)
    expect(g.obj.lecturaAutomatica).toBe(false)
    expect(g.obj.maxMB === 25 && g.obj.maxArchivos === 200 && g.obj.maxTotalMB === 500).toBe(true)
    const ext: string[] = g.obj.extensiones ?? []
    expect(ext).toEqual([...ext].sort())
    for (const x of ['pdf', 'docx', 'txt', 'md', 'png', 'jpg', 'csv']) expect(ext).toContain(x)
    expect(f.oficinaJSON().biblioteca).toBeUndefined()
    const p = await f.patch('/api/biblioteca/config', { lecturaAutomatica: true, maxArchivos: 10 })
    expect(p.obj.lecturaAutomatica === true && p.obj.maxArchivos === 10 && p.obj.maxMB === 25).toBe(true)
    expect(dict(f.oficinaJSON().biblioteca).lecturaAutomatica).toBe(true)
    // parcial: lo demás se conserva
    const q = await f.patch('/api/biblioteca/config', { maxTotalMB: 100 })
    expect(q.obj.lecturaAutomatica === true && q.obj.maxArchivos === 10 && q.obj.maxTotalMB === 100).toBe(true)
    const malos: Obj[] = [{ maxMB: 0 }, { maxMB: 501 }, { maxMB: 'x' }, { maxMB: true }, { maxArchivos: 5001 }, { maxTotalMB: 20001 }, { lecturaAutomatica: 'si' }]
    for (const malo of malos) {
      expect((await f.patch('/api/biblioteca/config', malo)).status, JSON.stringify(malo)).toBe(400)
    }
    expect((await f.patch('/api/biblioteca/config')).status).toBe(400)
    expect((await llamar(f.b, 'DELETE', '/api/biblioteca/config')).status).toBe(405)
  })

  test('lectura automática (config): todo archivo nuevo se lee por rol sin pedirlo', async () => {
    const f = await bib()
    await f.patch('/api/biblioteca/config', { lecturaAutomatica: true })
    const fin = await subirYEsperar(f, 'precios.txt', 'texto') // util_para ["direccion"] por defecto -> betty
    expect(fin.lectura).toEqual({ betty: 'ok' })
    expect(conPrompt(f, 'Se sumó un documento').flatMap((l) => Sandbox.valor(l, '--agent') ?? [])).toEqual(['betty'])
    // sin la opción, no
    await f.patch('/api/biblioteca/config', { lecturaAutomatica: false })
    const otro = await subirYEsperar(f, 'otro.txt', 'otro texto')
    expect(otro.lectura).toBeUndefined()
    expect(conPrompt(f, 'Se sumó un documento').length).toBe(1)
  })

  // MARK: propuestas de cambio al conocimiento

  test('propuestas: las contradicciones quedan pendientes y NUNCA se aplican solas; aceptar anexa a oficina.md', async () => {
    const f = await bib()
    const antes = f.leer('conocimiento/oficina.md')
    f.sb.responder('ficha', contradiccion())
    await subirYEsperar(f, 'precios.txt', 'El taller cuesta 150 dolares')
    expect(f.leer('conocimiento/oficina.md')).toBe(antes)
    const l = lista((await f.get('/api/biblioteca/propuestas')).obj.propuestas)
    expect(l.length).toBe(1) // la que no tiene sugerencia se descarta
    const p = l[0]!
    expect(uuidValido(str(p.id))).toBe(true)
    expect(p.archivo === 'precios' && p.titulo === 'Tarifario').toBe(true)
    expect(p.actual === 'El taller cuesta 100 dólares' && p.nuevo === 'El taller cuesta 150 dólares').toBe(true)
    expect(p.sugerencia === 'El taller cuesta 150 dólares.' && p.estado === 'pendiente').toBe(true)
    expect(str(p.creada).endsWith('Z')).toBe(true)
    expect((await f.get('/api/biblioteca/estado')).obj.propuestas).toBe(1)
    const id = str(p.id)
    const r = await f.post(`/api/biblioteca/propuestas/${id}`, { aceptar: true })
    expect(r.status).toBe(200)
    const v = dict(r.obj.propuesta)
    expect(v.estado === 'aceptada' && v.aplicada === true && str(v.resuelta) !== '').toBe(true)
    const despues = f.leer('conocimiento/oficina.md')
    expect(despues.startsWith(antes)).toBe(true)
    expect(despues.endsWith(`\n## Actualizado ${dia()}\nEl taller cuesta 150 dólares.\n(Fuente: Tarifario, \`conocimiento/fuentes/precios.md\`)\n`)).toBe(true)
    // ya resuelta: 409 y no se anexa dos veces
    const otra = await f.post(`/api/biblioteca/propuestas/${id}`, { aceptar: true })
    expect(otra.status).toBe(409)
    expect(f.leer('conocimiento/oficina.md')).toBe(despues)
    expect(lista((await f.get('/api/biblioteca/propuestas')).obj.propuestas)).toEqual([])
    const todas = lista((await f.get('/api/biblioteca/propuestas', { todas: '1' })).obj.propuestas)
    expect(todas.map((x) => str(x.estado))).toEqual(['aceptada'])
    expect((await f.get('/api/biblioteca/estado')).obj.propuestas).toBe(0)
  })

  test('propuestas: rechazar la descarta sin tocar nada; validaciones y 404', async () => {
    const f = await bib()
    const antes = f.leer('conocimiento/oficina.md')
    f.sb.responder('ficha', contradiccion())
    await subirYEsperar(f, 'precios.txt', 'El taller cuesta 150 dolares')
    const id = str(lista((await f.get('/api/biblioteca/propuestas')).obj.propuestas)[0]!.id)
    expect((await f.post(`/api/biblioteca/propuestas/${id}`)).status).toBe(400)
    expect((await f.post(`/api/biblioteca/propuestas/${id}`, {})).status).toBe(400)
    expect((await f.post(`/api/biblioteca/propuestas/${id}`, { aceptar: 'true' })).status).toBe(400)
    expect((await f.post(`/api/biblioteca/propuestas/${U.a}`, { aceptar: true })).status).toBe(404)
    expect((await f.post('/api/biblioteca/propuestas/no-es-uuid', { aceptar: true })).status).toBe(404)
    expect((await llamar(f.b, 'GET', `/api/biblioteca/propuestas/${id}`)).status).toBe(405)
    const r = await f.post(`/api/biblioteca/propuestas/${id}`, { aceptar: false })
    expect(r.status).toBe(200)
    expect(dict(r.obj.propuesta).estado).toBe('rechazada')
    expect(dict(r.obj.propuesta).aplicada).toBe(false)
    expect(lista((await f.get('/api/biblioteca/propuestas')).obj.propuestas)).toEqual([])
    expect(lista((await f.get('/api/biblioteca/propuestas', { todas: '1' })).obj.propuestas).map((x) => str(x.estado))).toEqual(['rechazada'])
    expect(f.leer('conocimiento/oficina.md')).toBe(antes)
    expect((await f.post(`/api/biblioteca/propuestas/${id}`, { aceptar: true })).status).toBe(409)
  })

  test('propuestas: no se repite la misma sugerencia pendiente al reprocesar y hay un máximo de 5 por ficha', async () => {
    const f = await bib()
    f.sb.responder('ficha', contradiccion())
    await subirYEsperar(f, 'precios.txt', 'uno')
    await f.post('/api/archivos/precios/reprocesar')
    await aguardar(f, 'precios')
    expect(lista((await f.get('/api/biblioteca/propuestas')).obj.propuestas).length).toBe(1)
    const siete = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ actual: `a${n}`, nuevo: `n${n}`, sugerencia: `sugerencia ${n}` }))
    f.sb.responder('ficha', fichaJSON({ contradicciones: siete }))
    await subirYEsperar(f, 'otro.txt', 'dos')
    expect(lista((await f.get('/api/biblioteca/propuestas')).obj.propuestas).length).toBe(6) // 1 + 5
  })

  // MARK: vínculos

  test('vínculos: validaciones al crear', async () => {
    const f = await bib()
    const ext = externa(f)
    const crear = (d: Obj) => f.post('/api/vinculos', d)
    // demasiado amplias
    expect((await crear({ ruta: '/' })).status).toBe(400)
    expect((await crear({ ruta: '~' })).status).toBe(400)
    expect((await crear({ ruta: f.sb.home })).status).toBe(400)
    expect((await crear({ ruta: f.sb.home + '/' })).status).toBe(400)
    if (process.platform !== 'win32') { // en Windows crear enlaces simbólicos pide administrador
      fs.symlinkSync(f.sb.home, f.sb.root + '/atajo')
      expect((await crear({ ruta: f.sb.root + '/atajo' })).status).toBe(400) // enlace a la carpeta personal
    }
    // rutas inválidas
    expect((await crear({ ruta: 'relativa/carpeta' })).status).toBe(400)
    expect((await crear({})).status).toBe(400)
    expect((await crear({ ruta: 7 })).status).toBe(400)
    expect((await crear({ ruta: f.sb.root + '/no-existe' })).status).toBe(404)
    expect((await crear({ ruta: ext + '/a.txt' })).status).toBe(400) // es un archivo
    // ya es parte de la oficina
    expect((await crear({ ruta: f.carpeta })).status).toBe(400)
    expect((await crear({ ruta: f.carpeta + '/archivos' })).status).toBe(400)
    // alcance
    expect((await crear({ ruta: ext, alcance: 'todos' })).status).toBe(400)
    expect((await crear({ ruta: ext, alcance: 5 })).status).toBe(400)
    expect((await crear({ ruta: ext, alcance: {} })).status).toBe(400)
    expect((await crear({ ruta: ext, alcance: { departamentos: [] } })).status).toBe(400)
    expect((await crear({ ruta: ext, alcance: { departamentos: ['inexistente'] } })).status).toBe(400)
    expect((await crear({ ruta: ext, alcance: { agentes: ['fantasma'] } })).status).toBe(400)
    expect((await crear({ ruta: ext, alcance: { agentes: 'marce' } })).status).toBe(400)
    expect((await crear({ ruta: ext, id: 'Mal Id' })).status).toBe(400)
    expect((await f.get('/api/vinculos')).obj.vinculos).toEqual([])
    expect(f.oficinaJSON().vinculos).toBeUndefined()
    // bien, y duplicados
    const ok = await crear({ ruta: ext, id: 'mi-ext' })
    expect(ok.status).toBe(200)
    const v = dict(ok.obj.vinculo)
    expect(v.id === 'mi-ext' && v.ruta === ext && v.alcance === 'oficina').toBe(true)
    expect(v.archivos === 0 && v.pendientes === 0 && v.existe === true).toBe(true)
    expect((await crear({ ruta: ext })).status).toBe(409)
    expect((await crear({ ruta: ext + '/' })).status).toBe(409)
    const otra = externa(f, 'otra')
    expect((await crear({ ruta: otra, id: 'mi-ext' })).status).toBe(409)
    // el id sale del nombre de la carpeta
    const con = f.sb.root + '/Mi Carpeta Grande'
    fs.mkdirSync(con, { recursive: true })
    expect(dict((await crear({ ruta: con })).obj.vinculo).id).toBe('mi-carpeta-grande')
    // y se guarda en oficina.json
    const guardados = lista(f.oficinaJSON().vinculos)
    expect(guardados.map((x) => str(x.id))).toEqual(['mi-ext', 'mi-carpeta-grande'])
    // NO se escanea sola al vincular
    expect(lista((await f.get('/api/archivos')).obj.archivos)).toEqual([])
    expect(f.sb.llamadas).toEqual([])
  })

  test('vínculos: máximo 20 carpetas y alcances guardados tal cual en oficina.json', async () => {
    const f = await bib()
    for (let i = 0; i < 20; i++) {
      const d = f.sb.root + `/v${i}`
      fs.mkdirSync(d, { recursive: true })
      const alcance: unknown = i === 1 ? { departamentos: ['redes'] } : i === 2 ? { agentes: ['marce', 'betty'] } : 'oficina'
      expect((await f.post('/api/vinculos', { ruta: d, alcance })).status).toBe(200)
    }
    fs.mkdirSync(f.sb.root + '/v20', { recursive: true })
    const r = await f.post('/api/vinculos', { ruta: f.sb.root + '/v20' })
    expect(r.status).toBe(400)
    expect(str(r.obj.error)).toContain('20')
    const g = lista(f.oficinaJSON().vinculos)
    expect(g.length).toBe(20)
    expect(dict(g[1]!.alcance).departamentos).toEqual(['redes'])
    expect(dict(g[2]!.alcance).agentes).toEqual(['marce', 'betty'])
    expect(g[0]!.alcance).toBe('oficina')
    const l = lista((await f.get('/api/vinculos')).obj.vinculos)
    expect(l.length === 20 && l.every((x) => x.existe === true)).toBe(true)
  })

  test('escanear: sin copiar nada, solo extensiones soportadas, sin ocultos ni enlaces; se ficha en su lugar', async () => {
    const f = await bib()
    const ext = externa(f)
    await f.post('/api/vinculos', { ruta: ext, id: 'ext' })
    const e = await f.post('/api/vinculos/ext/escanear')
    expect(e.status).toBe(200)
    expect(e.obj.ok).toBe(true)
    expect(e.obj.nuevos === 2 && e.obj.actualizados === 0 && e.obj.sinCambios === 0).toBe(true)
    expect(e.obj.quitados === 0 && e.obj.omitidos === 0 && e.obj.tope === false).toBe(true)
    expect(e.obj.aviso).toBeUndefined()
    const l = lista((await f.get('/api/archivos')).obj.archivos)
    expect(new Set(l.map((x) => str(x.slug)))).toEqual(new Set(['a', 'b']))
    for (const a of l) {
      expect(a.origen === 'vinculo' && a.departamento === 'vinculo' && a.vinculo === 'ext').toBe(true)
      expect(path.isAbsolute(str(a.ruta))).toBe(true)
    }
    await aguardar(f, 'a'); await aguardar(f, 'b')
    // no se copió nada a la oficina
    expect(listar(f.carpeta + '/archivos/compartido')).toEqual([])
    expect(f.existe('archivos/vinculo')).toBe(false)
    // pero sí se extrajo y se ficho en su lugar
    expect(f.leer('archivos/.texto/a.md') === 'alfa uno' && f.leer('archivos/.texto/b.md') === 'beta dos').toBe(true)
    const md = f.leer('conocimiento/fuentes/a.md')
    expect(md).toContain('- **Origen:** carpeta vinculada «ext»')
    expect(md).toContain('- **Carpeta:** Carpeta vinculada')
    expect(md.includes('- **Ubicación del original:** /') && md.includes('/externa/a.txt')).toBe(true)
    const p = fichas(f)[0]!.at(-1)!
    expect(p).toContain('carpeta: Carpeta vinculada')
    // los originales no se tocaron
    expect(leerTexto(ext + '/a.txt') === 'alfa uno' && leerTexto(ext + '/sub/b.md') === 'beta dos').toBe(true)
    expect(await buscar(f, 'alfa')).toEqual(['a'])
    // el detalle muestra la ruta absoluta del original y la lista de vínculos cuenta sus archivos
    expect(str(dict((await f.get('/api/archivos/a')).obj.archivo).rutaAbsoluta).endsWith(path.join('/externa', 'a.txt'))).toBe(true)
    const v = dict(lista((await f.get('/api/vinculos')).obj.vinculos)[0])
    expect(v.archivos === 2 && v.pendientes === 0).toBe(true)
    expect(v.existe).toBe(true)
  })

  test('escanear de nuevo: sin cambios, cambió el contenido (reindexa por hash) y desapareció un archivo (va a la papelera)', async () => {
    const f = await bib()
    const ext = externa(f)
    await f.post('/api/vinculos', { ruta: ext, id: 'ext' })
    await f.post('/api/vinculos/ext/escanear')
    await aguardar(f, 'a'); await aguardar(f, 'b')
    const hashA = str(dict((await f.get('/api/archivos/a')).obj.archivo).hash)
    expect(fichas(f).length).toBe(2)
    const igual = await f.post('/api/vinculos/ext/escanear')
    expect(igual.obj.sinCambios === 2 && igual.obj.nuevos === 0 && igual.obj.actualizados === 0).toBe(true)
    expect(fichas(f).length).toBe(2) // no se reprocesó nada
    // cambia a.txt, se borra b.md, aparece c.txt
    escribir('alfa dos modificado', ext + '/a.txt')
    fs.rmSync(ext + '/sub/b.md')
    escribir('gamma tres', ext + '/c.txt')
    const r = await f.post('/api/vinculos/ext/escanear')
    expect(r.obj.actualizados === 1 && r.obj.quitados === 1 && r.obj.nuevos === 1 && r.obj.sinCambios === 0).toBe(true)
    await aguardar(f, 'a'); await aguardar(f, 'c')
    const a = dict((await f.get('/api/archivos/a')).obj.archivo)
    expect(a.hash).not.toBe(hashA)
    expect(f.leer('archivos/.texto/a.md')).toBe('alfa dos modificado')
    expect(fichas(f).length).toBe(4) // a de nuevo y c
    expect(await buscar(f, 'modificado')).toEqual(['a'])
    expect(await buscar(f, 'gamma')).toEqual(['c'])
    // b salió de la biblioteca
    expect((await f.get('/api/archivos/b')).status).toBe(404)
    expect(await buscar(f, 'beta')).toEqual([])
    expect(f.leer('conocimiento/archivos.md')).not.toContain('`b`')
    expect(new Set(lista((await f.get('/api/archivos')).obj.archivos).map((x) => str(x.slug)))).toEqual(new Set(['a', 'c']))
  })

  test('escanear: tope de archivos, de peso total y de tamaño por archivo; omitidos y aviso', async () => {
    const f = await bib()
    const d = f.sb.root + '/muchos'
    for (const n of ['a', 'b', 'c', 'd', 'e']) escribir(`texto ${n}`, d + `/${n}.txt`)
    await f.post('/api/vinculos', { ruta: d, id: 'muchos' })
    await f.patch('/api/biblioteca/config', { maxArchivos: 2 })
    const r = await f.post('/api/vinculos/muchos/escanear')
    expect(r.obj.nuevos === 2 && r.obj.omitidos === 3 && r.obj.tope === true).toBe(true)
    expect(str(r.obj.aviso)).toContain('tope')
    expect(new Set(lista((await f.get('/api/archivos')).obj.archivos).map((x) => str(x.slug)))).toEqual(new Set(['a', 'b'])) // por orden de ruta
    await aguardar(f, 'a'); await aguardar(f, 'b')
    // peso total: máximo 1 MB entre todos
    const g = f.sb.root + '/pesados'
    escribir('a'.repeat(600_000), g + '/a.txt')
    escribir('b'.repeat(600_000), g + '/b.txt')
    await f.post('/api/vinculos', { ruta: g, id: 'pesados' })
    await f.patch('/api/biblioteca/config', { maxArchivos: 50, maxTotalMB: 1 })
    const t = await f.post('/api/vinculos/pesados/escanear')
    expect(t.obj.nuevos === 1 && t.obj.omitidos === 1 && t.obj.tope === true).toBe(true)
    // un archivo más grande que maxMB se omite sin marcar tope
    const h = f.sb.root + '/grandes'
    escribir('chico', h + '/chico.txt')
    fs.writeFileSync(h + '/grande.txt', Buffer.alloc(1_100_000, 0x61))
    await f.post('/api/vinculos', { ruta: h, id: 'grandes' })
    await f.patch('/api/biblioteca/config', { maxMB: 1, maxTotalMB: 500 })
    const m = await f.post('/api/vinculos/grandes/escanear')
    expect(m.obj.nuevos === 1 && m.obj.omitidos === 1 && m.obj.tope === false).toBe(true)
    expect(m.obj.aviso).toBeUndefined()
    for (const s of ['a-2', 'chico']) await aguardar(f, s)
  })

  test('escanear: 404 si el vínculo no existe o si su carpeta ya no está; la lista marca existe:false', async () => {
    const f = await bib()
    const ext = externa(f)
    await f.post('/api/vinculos', { ruta: ext, id: 'ext' })
    expect((await f.post('/api/vinculos/nada/escanear')).status).toBe(404)
    expect((await f.post('/api/vinculos/Mal_Id/escanear')).status).toBe(404)
    expect((await llamar(f.b, 'GET', '/api/vinculos/ext/escanear')).status).toBe(405)
    fs.rmSync(ext, { recursive: true, force: true })
    const r = await f.post('/api/vinculos/ext/escanear')
    expect(r.status).toBe(404)
    expect(str(r.obj.error)).toContain('ya no existe')
    expect(dict(lista((await f.get('/api/vinculos')).obj.vinculos)[0]).existe).toBe(false)
  })

  test('quitar un vínculo: sus archivos salen de la biblioteca (papelera) y la carpeta del usuario no se toca', async () => {
    const f = await bib()
    const ext = externa(f)
    await f.post('/api/vinculos', { ruta: ext, id: 'ext' })
    await f.post('/api/vinculos/ext/escanear')
    await aguardar(f, 'a'); await aguardar(f, 'b')
    const r = await f.delete('/api/vinculos/ext')
    expect(r.status).toBe(200)
    expect(r.obj.ok === true && r.obj.quitados === 2).toBe(true)
    expect(leerTexto(ext + '/a.txt') === 'alfa uno' && leerTexto(ext + '/sub/b.md') === 'beta dos').toBe(true)
    expect(lista((await f.get('/api/archivos')).obj.archivos)).toEqual([])
    expect(await buscar(f, 'alfa')).toEqual([])
    expect(f.oficinaJSON().vinculos).toBeUndefined()
    expect((await f.get('/api/vinculos')).obj.vinculos).toEqual([])
    expect(f.leer('conocimiento/archivos.md')).toContain('(Todavía no hay documentos.)')
    expect(f.existe('conocimiento/fuentes/a.md')).toBe(false)
    expect((await f.delete('/api/vinculos/ext')).status).toBe(404)
    expect((await f.delete('/api/vinculos/Mal_Id')).status).toBe(404)
    // se puede volver a vincular y escanear: los slugs se reutilizan sin chocar con la papelera
    await f.post('/api/vinculos', { ruta: ext, id: 'ext' })
    const otra = await f.post('/api/vinculos/ext/escanear')
    expect(otra.obj.nuevos).toBe(2)
    await aguardar(f, 'a-2'); await aguardar(f, 'b-2')
  })

  test('quitar un archivo vinculado no toca el original; quitar uno subido lo mueve a la papelera con su ficha y su texto', async () => {
    const f = await bib()
    const ext = externa(f)
    await f.post('/api/vinculos', { ruta: ext, id: 'ext' })
    await f.post('/api/vinculos/ext/escanear')
    await aguardar(f, 'a'); await aguardar(f, 'b')
    const v = await f.delete('/api/archivos/a')
    expect(v.status).toBe(200)
    expect(str(v.obj.papelera).endsWith(path.join('/externa', 'a.txt'))).toBe(true)
    expect(leerTexto(ext + '/a.txt')).toBe('alfa uno')
    // subido
    await subirYEsperar(f, 'precios.txt', 'contenido de precios')
    const r = await f.delete('/api/archivos/precios')
    expect(r.status).toBe(200)
    expect(r.obj.ok).toBe(true)
    const rel = str(r.obj.papelera)
    expect(/^archivos\/\.papelera\/precios-\d{4}-\d{2}-\d{2}-\d+\/precios\.txt$/.test(rel), `papelera=${rel}`).toBe(true)
    expect(f.leer(rel)).toBe('contenido de precios')
    const dir = path.posix.dirname(rel)
    expect(f.leer(dir + '/texto.md')).toBe('contenido de precios')
    expect(f.leer(dir + '/ficha.md')).toContain('# Ficha de prueba')
    expect(f.existe('archivos/compartido/precios.txt') || f.existe('archivos/.texto/precios.md') || f.existe('conocimiento/fuentes/precios.md')).toBe(false)
    expect((await f.get('/api/archivos/precios')).status).toBe(404)
    expect((await f.delete('/api/archivos/precios')).status).toBe(404)
    expect((await f.delete('/api/archivos/Mal_Id')).status).toBe(404)
    expect(lista((await f.get('/api/archivos')).obj.archivos).some((x) => str(x.slug) === 'precios')).toBe(false)
    expect(f.leer('conocimiento/archivos.md')).not.toContain('`precios`')
    // se puede subir otro con el mismo nombre; el slug no choca con el de la papelera
    const otro = await subirTexto(f, 'precios.txt', 'otra version')
    expect(otro.status === 200 && otro.obj.reemplazado === undefined && otro.obj.duplicado === undefined).toBe(true)
    expect(archivo(otro).slug).toBe('precios-2')
    await aguardar(f, 'precios-2')
  })

  test('quitar un archivo mientras se está fichando: no queda ficha ni catálogo del archivo quitado', async () => {
    const f = await bib()
    f.sb.modo('ficha', 'puerta')
    await subirTexto(f, 'precios.txt', 'texto')
    expect(await esperar(() => f.sb.eventos.includes('S '))).toBe(true)
    expect((await f.delete('/api/archivos/precios')).status).toBe(200)
    f.sb.abrirPuerta()
    expect(await esperar(() => f.sb.eventos.at(-1) === 'E ')).toBe(true)
    await dormir(300)
    expect(f.existe('conocimiento/fuentes/precios.md')).toBe(false)
    expect(f.leer('conocimiento/archivos.md')).not.toContain('precios')
    expect(await buscar(f, 'texto')).toEqual([])
    expect((await f.get('/api/biblioteca/estado')).obj.pendientes).toBe(0)
  })

  // MARK: arranque

  test.skip('al arrancar, lo que quedó a medio procesar (extrayendo o fichando) vuelve a pendiente y se procesa', () => {
    // interno (unit test del port): siembra filas ArchivoFila en estado fichando/extrayendo con b.store.archivoGuardar,
    // reinicia el backend y comprueba que se reprocesan; no hay forma de sembrar la BD por HTTP.
  })

  // MARK: original y entregables

  test('entregables de un agente: listado ordenado, sin ocultos; el contenido se baja por ruta y no se sale de la carpeta', async () => {
    const f = await bib()
    escribir('informe', f.ruta('archivos/entregables/marce/informe.md'))
    escribir('deck', f.ruta('archivos/entregables/marce/sub/deck.txt'))
    escribir('oculto', f.ruta('archivos/entregables/marce/.oculto'))
    escribir('de otro', f.ruta('archivos/entregables/betty/ajeno.md'))
    // en Windows crear enlaces simbólicos pide administrador: sin enlace, el resto de la prueba sigue valiendo
    try { fs.symlinkSync(f.ruta('oficina.json'), f.ruta('archivos/entregables/marce/escape.md')) } catch (e) { if (process.platform !== 'win32') throw e }
    const r = await f.get('/api/biblioteca/entregables', { agente: 'marce' })
    expect(r.status).toBe(200)
    expect(r.obj.agente === 'marce' && r.obj.carpeta === 'archivos/entregables/marce').toBe(true)
    const l = lista(r.obj.entregables)
    const rutas = new Set(l.map((x) => str(x.ruta)))
    expect(rutas.has('informe.md') && rutas.has('sub/deck.txt')).toBe(true)
    expect(l.some((x) => str(x.nombre) === '.oculto' || str(x.nombre) === 'ajeno.md')).toBe(false)
    const inf = l.find((x) => str(x.ruta) === 'informe.md')!
    expect(inf).toBeDefined()
    expect(inf.tam === 7 && inf.tipo === 'md' && inf.nombre === 'informe.md' && str(inf.modificado).endsWith('Z')).toBe(true)
    const c = await f.get('/api/biblioteca/entregable', { agente: 'marce', ruta: 'informe.md' })
    expect(c.status).toBe(200)
    expect(c.obj.base64 === Buffer.from('informe').toString('base64') && c.obj.nombre === 'informe.md').toBe(true)
    expect((await f.get('/api/biblioteca/entregable', { agente: 'marce', ruta: 'sub/deck.txt' })).status).toBe(200)
    // fuera de la carpeta: ni con «..» ni con un enlace simbólico
    expect((await f.get('/api/biblioteca/entregable', { agente: 'marce', ruta: '../betty/ajeno.md' })).status).toBe(404)
    expect((await f.get('/api/biblioteca/entregable', { agente: 'marce', ruta: '../../../oficina.json' })).status).toBe(404)
    expect((await f.get('/api/biblioteca/entregable', { agente: 'marce', ruta: 'escape.md' })).status).toBe(404)
    expect((await f.get('/api/biblioteca/entregable', { agente: 'marce', ruta: 'no-existe.md' })).status).toBe(404)
    expect((await f.get('/api/biblioteca/entregable', { agente: 'marce' })).status).toBe(400)
    expect((await f.get('/api/biblioteca/entregable', { agente: 'Mal Id', ruta: 'x' })).status).toBe(400)
    expect((await f.get('/api/biblioteca/entregables')).status).toBe(400)
    // agente sin entregables: lista vacía
    const sin = await f.get('/api/biblioteca/entregables', { agente: 'nadie' })
    expect(sin.status === 200 && lista(sin.obj.entregables).length === 0).toBe(true)
  })

  test('original: base64 hasta 8 MB; más grande devuelve solo la ruta', async () => {
    const f = await bib()
    const grande = Buffer.alloc(8 * 1_048_576 + 1, 0x61)
    // por la API de entregables (el límite de subida es 25 MB, así que se prueba con la carpeta de un agente)
    fs.mkdirSync(f.ruta('archivos/entregables/marce'), { recursive: true })
    fs.writeFileSync(f.ruta('archivos/entregables/marce/grande.bin'), grande)
    fs.writeFileSync(f.ruta('archivos/entregables/marce/chico.txt'), 'chico')
    const g = await f.get('/api/biblioteca/entregable', { agente: 'marce', ruta: 'grande.bin' })
    expect(g.status).toBe(200)
    expect(g.obj.base64).toBeUndefined()
    expect(g.obj.tam).toBe(grande.length)
    expect(str(g.obj.ruta).endsWith(path.join('/entregables', 'marce', 'grande.bin'))).toBe(true)
    expect(g.obj.mime).toBe('application/octet-stream')
    expect((await f.get('/api/biblioteca/entregable', { agente: 'marce', ruta: 'chico.txt' })).obj.base64).toBe(Buffer.from('chico').toString('base64'))
  })

  test('rutas de la biblioteca: 404 para lo desconocido y 405 para métodos no permitidos', async () => {
    const f = await bib()
    expect((await f.get('/api/biblioteca/nada')).status).toBe(404)
    expect((await f.get('/api/archivos/a/b/c')).status).toBe(404)
    expect((await f.get('/api/archivos/Mal_Id')).status).toBe(404)
    expect((await f.get('/api/archivos/no-existe')).status).toBe(404)
    expect((await f.get('/api/archivos/no-existe/original')).status).toBe(404)
    expect((await llamar(f.b, 'PUT', '/api/archivos')).status).toBe(405)
    expect((await llamar(f.b, 'PATCH', '/api/archivos/x')).status).toBe(405)
    expect((await llamar(f.b, 'DELETE', '/api/vinculos')).status).toBe(405)
    expect((await llamar(f.b, 'POST', '/api/biblioteca/estado')).status).toBe(405)
  })
})
