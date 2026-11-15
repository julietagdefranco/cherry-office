// Paridad (corre contra Swift y TS; no hay port en app/Tests).
// Archivos que la persona le pasa a un agente: chat, corrida de flujo y tareas. Se guardan en archivos/adjuntos/ y el agente
// recibe sus rutas al final del mensaje.
import { describe, expect, test } from 'vitest'
import { Fix, dict, esperar, historial, lista, msgs, str, type Obj } from '../support/sandbox.js'

const U1 = '11111111-1111-4111-8111-111111111111'
const b64 = (s: string) => Buffer.from(s).toString('base64')
const encabezado = 'Archivos adjuntos (leelos con Read antes de responder):'
const rutas = (texto: string): string[] => texto.split('\n').filter((l) => l.startsWith('- archivos/adjuntos/')).map((l) => l.slice(2))

const fix = () => Fix.crear({
  deps: ['Dirección'],
  agentes: [{ id: 'sofia', depto: 'direccion', rol: 'Directora' }],
  env: { HQ_PROGRAMADOR: '0' },
})

const chatear = (f: Fix, body: Obj) => f.post('/api/chat', { agent: 'sofia', session: U1, message: 'hola', ...body })

describe('Adjuntos', () => {
  test('chat: guarda los archivos en la oficina y el agente recibe sus rutas; el historial las conserva', async () => {
    const f = await fix()
    const r = await chatear(f, { message: 'Mirá esta foto', archivos: [{ nombre: 'foto.png', base64: b64('png') }, { nombre: 'nota.txt', base64: 'data:text/plain;base64,' + b64('hola') }] })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const prompt = f.sb.prompts.at(-1)!.normalize('NFC')
    expect(prompt.startsWith('Mirá esta foto\n\n' + encabezado + '\n')).toBe(true)
    const rs = rutas(prompt)
    expect(rs.length).toBe(2)
    expect(rs.every((x) => /^archivos\/adjuntos\/chat\/sofia\/\d{8}-\d{6}\//.test(x))).toBe(true)
    expect(rs.map((x) => x.split('/').at(-1))).toEqual(['foto.png', 'nota.txt'])
    expect(f.leer(rs[0]!)).toBe('png')
    expect(f.leer(rs[1]!)).toBe('hola')
    const h = msgs(await historial(f.b, { agent: 'sofia', session: U1 }))
    expect(h[0]?.t.normalize('NFC')).toBe(prompt)
  })

  test('chat: solo archivos, sin texto, sale igual; mismo nombre dos veces no se pisa', async () => {
    const f = await fix()
    const r = await chatear(f, { message: '  ', archivos: [{ nombre: 'a.txt', base64: b64('uno') }, { nombre: 'a.txt', base64: b64('dos') }] })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const prompt = f.sb.prompts.at(-1)!
    expect(prompt.startsWith('Te paso estos archivos.\n\n' + encabezado)).toBe(true)
    const rs = rutas(prompt)
    expect(rs.map((x) => x.split('/').at(-1))).toEqual(['a.txt', 'a-2.txt'])
    expect(f.leer(rs[1]!)).toBe('dos')
  })

  test('chat: adjuntos inválidos -> error claro, sin lanzar claude ni guardar nada', async () => {
    const f = await fix()
    const casos: [unknown, number, string][] = [
      ['x', 400, '«archivos» tiene que ser una lista de {nombre, base64}.'],
      [['x'], 400, '«archivos» tiene que ser una lista de {nombre, base64}.'],
      [Array.from({ length: 11 }, (_, i) => ({ nombre: `${i}.txt`, base64: b64('x') })), 400, 'Máximo 10 archivos por vez.'],
      [[{ base64: b64('x') }], 400, 'Falta «nombre del archivo».'],
      [[{ nombre: '../x.txt', base64: b64('x') }], 400, 'El nombre de archivo «../x.txt» no es válido (sin «/» ni «..», hasta 120 caracteres).'],
      [[{ nombre: 'a/b.txt', base64: b64('x') }], 400, 'El nombre de archivo «a/b.txt» no es válido (sin «/» ni «..», hasta 120 caracteres).'],
      [[{ nombre: 'x.txt' }], 400, 'Falta el contenido de «x.txt» (base64).'],
      [[{ nombre: 'x.txt', base64: '%%%no' }], 400, 'El contenido de «x.txt» no es base64 válido.'],
    ]
    for (const [archivos, status, error] of casos) {
      const r = await chatear(f, { archivos })
      expect(r.status, JSON.stringify(archivos).slice(0, 80)).toBe(status)
      expect(r.obj.error).toBe(error)
    }
    expect(f.sb.llamadas).toEqual([])
    expect(f.existe('archivos/adjuntos')).toBe(false)
  })

  test('chat: un cuerpo grande sin adjuntos sigue siendo 413; con adjuntos pasa', async () => {
    const f = await fix()
    const grande = await chatear(f, { message: 'a'.repeat(100_000), relleno: 'x'.repeat(150_000) })
    expect(grande.status).toBe(413)
    const conArchivo = await chatear(f, { message: 'mirá', archivos: [{ nombre: 'grande.bin', base64: Buffer.alloc(300_000, 7).toString('base64') }] })
    expect(conArchivo.status, JSON.stringify(conArchivo.obj)).toBe(200)
  })

  test('flujo: los adjuntos de la corrida van al contexto y los recibe el primer paso', async () => {
    const f = await fix()
    const d = await f.post('/api/flujos', { nombre: 'Revisión', pasos: [{ id: 'mirar', nombre: 'Mirar', quien: 'sofia', entrega: 'Comentarios' }] })
    expect(d.status, JSON.stringify(d.obj)).toBe(200)
    const flujo = str(dict(d.obj.flujo).id)
    const r = await f.post(`/api/flujos/${flujo}/correr`, { nombre: 'Foto 1', contexto: 'Revisá la foto', archivos: [{ nombre: 'foto.jpg', base64: b64('jpg') }] })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const ctx = str(dict(r.obj.corrida).contexto)
    expect(ctx.startsWith('Revisá la foto\n\n' + encabezado + '\n- archivos/adjuntos/flujos/' + flujo + '/')).toBe(true)
    const [ruta] = rutas(ctx)
    expect(f.leer(ruta!)).toBe('jpg')
    expect(await esperar(async () => f.sb.prompts.some((p) => p.includes(ruta!)))).toBe(true)
    const malo = await f.post(`/api/flujos/${flujo}/correr`, { nombre: 'Foto 2', archivos: [{ nombre: '..', base64: b64('x') }] })
    expect(malo.status).toBe(400)
  })

  test('tarea: guarda los adjuntos, los muestra y se los pasa al agente con la consigna; se pueden agregar y quitar', async () => {
    const f = await fix()
    const r = await f.post('/api/tareas', { agente: 'sofia', nombre: 'Informe', consigna: 'Resumí el PDF', dias: [1], hora: '08:00',
      archivos: [{ nombre: 'informe.pdf', base64: b64('pdf') }] })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const t = dict(r.obj.tarea)
    const archivos = (t.archivos ?? []) as string[]
    expect(archivos.length).toBe(1)
    expect(archivos[0]!.startsWith('archivos/adjuntos/tareas/sofia/') && archivos[0]!.endsWith('/informe.pdf')).toBe(true)
    expect(str(t.consigna)).toBe('Resumí el PDF')
    expect(f.leer(archivos[0]!)).toBe('pdf')
    expect(lista(f.oficinaJSON().tareas)[0]!.archivos).toEqual(archivos)

    // correr: el agente recibe la consigna con los adjuntos
    expect((await f.post('/api/tareas/informe/correr')).status).toBe(202)
    expect(await esperar(async () => f.sb.prompts.some((p) => p.normalize('NFC') === 'Resumí el PDF\n\n' + encabezado + '\n- ' + archivos[0]))).toBe(true)

    // agregar uno y quitar el anterior
    const e = await f.patch('/api/tareas/informe', { archivos: [{ nombre: 'otro.txt', base64: b64('otro') }], quitarArchivos: archivos })
    expect(e.status, JSON.stringify(e.obj)).toBe(200)
    const nuevos = (dict(e.obj.tarea).archivos ?? []) as string[]
    expect(nuevos.length).toBe(1)
    expect(nuevos[0]!.endsWith('/otro.txt')).toBe(true)
    // quitar todos: la tarea deja de llevar la clave
    const q = await f.patch('/api/tareas/informe', { quitarArchivos: nuevos })
    expect(q.status).toBe(200)
    expect(dict(q.obj.tarea).archivos).toBeUndefined()
    expect(lista(f.oficinaJSON().tareas)[0]!.archivos).toBeUndefined()
    expect((await f.patch('/api/tareas/informe', { quitarArchivos: 'x' })).status).toBe(400)
    // de un agente que no existe: 404 y no guarda nada
    const n = await f.post('/api/tareas', { agente: 'nadie', nombre: 'X', consigna: 'x', dias: [1], hora: '08:00', archivos: [{ nombre: 'a.txt', base64: b64('a') }] })
    expect(n.status).toBe(404)
    expect(f.existe('archivos/adjuntos/tareas/nadie')).toBe(false)
  })
})
