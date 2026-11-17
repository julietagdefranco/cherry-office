// Vista previa, notas en «Pedir cambios» y retoques a mano (docs/plan-vista-previa.md).
import fs from 'node:fs'
import { describe, expect, test } from 'vitest'
import { Fix, U, chat, esperar, lista, str, type Obj } from '../support/sandbox.js'

const num = (v: unknown) => (typeof v === 'number' ? v : 0)
const entregas = async (f: Fix): Promise<Obj[]> => lista((await f.get('/api/entregas')).obj.entregas)

async function conEntrega(rel: string) {
  const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }] })
  await chat(f.b, { agent: 'marce', message: `Armá la página ENTREGA:${rel}`, session: U.a })
  const id = num((await entregas(f))[0]?.id)
  return { f, id }
}

describe('Vista previa de entregas (API)', () => {
  test('vista de una página: empaqueta su CSS; solo archivos de la entrega; 404 si ya no está', async () => {
    const rel = 'archivos/entregables/marce/landing.html'
    const { f, id } = await conEntrega(rel)
    fs.writeFileSync(f.ruta('archivos/entregables/marce/estilos.css'), 'h1{color:green}')
    fs.writeFileSync(f.ruta(rel), '<html><head><link rel="stylesheet" href="estilos.css"></head><body><h1>Hola</h1><img src="falta.png"></body></html>')
    const r = await f.get(`/api/entregas/${id}/vista`, { ruta: rel })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const v = r.obj.vista as Obj
    expect(v.tipo).toBe('html')
    expect(v.retocable).toBe(true)
    expect(str(v.html)).toContain('<style>h1{color:green}</style>')
    expect(v.avisos).toEqual(['No encontré «falta.png».'])
    expect((await f.get(`/api/entregas/${id}/vista`, { ruta: 'archivos/entregables/marce/estilos.css' })).status).toBe(400)
    expect((await f.get(`/api/entregas/${id}/vista`, { ruta: '../../etc/hosts' })).status).toBe(400)
    expect((await f.get(`/api/entregas/${id}/vista`)).status).toBe(400)
    expect((await f.post(`/api/entregas/${id}/vista`, {})).status).toBe(405)
    fs.rmSync(f.ruta(rel))
    expect((await f.get(`/api/entregas/${id}/vista`, { ruta: rel })).status).toBe(404)
  })

  test('/api/oficina/vista: cualquier página de la oficina, empaquetada; nada de afuera ni ocultos', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }] })
    fs.mkdirSync(f.ruta('landings/prosperas/img'), { recursive: true })
    fs.writeFileSync(f.ruta('landings/prosperas/estilos.css'), 'body{background:url(img/fondo.png)}')
    fs.writeFileSync(f.ruta('landings/prosperas/img/fondo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    fs.writeFileSync(f.ruta('landings/prosperas/index.html'), '<html><head><link rel="stylesheet" href="estilos.css"></head><body><img src="../../../afuera.png"></body></html>')
    const r = await f.get('/api/oficina/vista', { ruta: 'landings/prosperas/index.html' })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const v = r.obj.vista as Obj
    expect(v.tipo).toBe('html')
    expect(str(v.html)).toContain('<style>body{background:url(data:image/png;base64,')
    expect(str(v.html)).toContain('src="../../../afuera.png"')   // sale de la oficina: queda como estaba, con aviso
    expect((v.avisos as string[]).length).toBe(1)
    expect((await f.get('/api/oficina/vista', { ruta: '../afuera.html' })).status).toBe(403)
    expect((await f.get('/api/oficina/vista', { ruta: '/etc/hosts' })).status).toBe(403)
    expect((await f.get('/api/oficina/vista', { ruta: '.git/config' })).status).toBe(403)
    expect((await f.get('/api/oficina/vista', { ruta: 'landings' })).status).toBe(400)
    expect((await f.get('/api/oficina/vista', { ruta: 'landings/nada.html' })).status).toBe(404)
    expect((await f.post('/api/oficina/vista', {})).status).toBe(405)
  })

  test('vista de markdown y CSV', async () => {
    const { f, id } = await conEntrega('archivos/entregables/marce/datos.csv')
    fs.writeFileSync(f.ruta('archivos/entregables/marce/datos.csv'), 'nombre,precio\n"Remera, azul",100\n')
    const v = (await f.get(`/api/entregas/${id}/vista`, { ruta: 'archivos/entregables/marce/datos.csv' })).obj.vista as Obj
    expect(v.tipo).toBe('csv')
    expect(v.filas).toEqual([['nombre', 'precio'], ['Remera, azul', '100']])
    const md = await conEntrega('archivos/entregables/marce/informe.md')
    const vm = (await md.f.get(`/api/entregas/${md.id}/vista`, { ruta: 'archivos/entregables/marce/informe.md' })).obj.vista as Obj
    expect(vm.tipo).toBe('markdown')
    expect(vm.texto).toBe('entregado por marce\n')
    expect(typeof vm.mod).toBe('number')
  })

  test('pedir cambios con notas: arma el pedido por archivo y las guarda en la entrega vieja', async () => {
    const rel = 'archivos/entregables/marce/landing.html'
    const { f, id } = await conEntrega(rel)
    expect((await f.post(`/api/entregas/${id}/cambios`, { notas: [{ archivo: 'otro.html', texto: 'x' }] })).status).toBe(400)
    expect((await f.post(`/api/entregas/${id}/cambios`, { notas: [{ archivo: rel, texto: '' }] })).status).toBe(400)
    expect((await f.post(`/api/entregas/${id}/cambios`, { notas: 'x' })).status).toBe(400)
    expect((await f.post(`/api/entregas/${id}/cambios`, { notas: Array.from({ length: 31 }, () => ({ texto: 'x' })) })).status).toBe(400)
    const r = await f.post(`/api/entregas/${id}/cambios`, {
      texto: 'Que se lea bien en el teléfono',
      notas: [
        { archivo: rel, ancla: { cita: 'Nuestra colección', selector: 'section.coleccion > h2' }, texto: 'Achicá el título' },
        { archivo: rel, ancla: { x: 33.7, y: 150 }, texto: 'Acá va el logo' },
        { texto: 'Usá los colores de la marca' },
      ],
    })
    expect(r.status, JSON.stringify(r.obj)).toBe(202)
    const notas = (r.obj.entrega as Obj).notas as Obj[]
    expect(notas.length).toBe(3)
    expect(notas[1]!.ancla).toEqual({ x: 34, y: 100 })
    expect(await esperar(async () => (await entregas(f)).length === 2, 15)).toBe(true)
    const pedido = (f.sb.llamadas.findLast((l) => l.includes('--agent')) ?? []).at(-1)?.normalize('NFC') ?? ''
    expect(pedido).toContain(`En ${rel}:\n1. En «Nuestra colección» (section.coleccion > h2): Achicá el título\n2. En el punto a 34 % del ancho y 100 % del alto: Acá va el logo`)
    expect(pedido).toContain('En general:\n3. Usá los colores de la marca')
    expect(pedido).toContain('Además: Que se lea bien en el teléfono')
    const vieja = (await f.get(`/api/entregas/${id}`)).obj.entrega as Obj
    expect(lista(vieja.notas).map((n) => n.texto)).toEqual(['Achicá el título', 'Acá va el logo', 'Usá los colores de la marca'])
  })

  test('retoque de HTML: cambia un texto único, deja foto, avisa al agente en el próximo pedido y se deshace', async () => {
    const rel = 'archivos/entregables/marce/landing.html'
    const { f, id } = await conEntrega(rel)
    const original = '<h1>Nuestra colección</h1><p>Hola</p><p>Hola</p>'
    fs.writeFileSync(f.ruta(rel), original)
    expect((await f.post(`/api/entregas/${id}/retoque`, { archivo: rel, antes: 'Hola', despues: 'Chau' })).status).toBe(409)
    expect((await f.post(`/api/entregas/${id}/retoque`, { archivo: rel, antes: '', despues: 'x' })).status).toBe(400)
    const r = await f.post(`/api/entregas/${id}/retoque`, { archivo: rel, antes: 'Nuestra colección', despues: 'Otoño & invierno' })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(fs.readFileSync(f.ruta(rel), 'utf8')).toBe('<h1>Otoño &amp; invierno</h1><p>Hola</p><p>Hola</p>')
    expect(str((r.obj.vista as Obj).html)).toContain('Otoño &amp; invierno')
    expect(lista((r.obj.entrega as Obj).retoques).map((x) => x.archivo)).toEqual([rel])
    const fotos = fs.readdirSync(f.ruta(`archivos/.papelera/retoques/${id}`))
    expect(fotos.length).toBe(1)
    expect(fs.readFileSync(f.ruta(`archivos/.papelera/retoques/${id}/${fotos[0]}`), 'utf8')).toBe(original)
    // deshacer vuelve al original y vacía la lista
    const d = await f.post(`/api/entregas/${id}/deshacer-retoque`)
    expect(d.status, JSON.stringify(d.obj)).toBe(200)
    expect(fs.readFileSync(f.ruta(rel), 'utf8')).toBe(original)
    expect((d.obj.entrega as Obj).retoques).toEqual([])
    expect((await f.post(`/api/entregas/${id}/deshacer-retoque`)).status).toBe(409)
    // con un retoque hecho, el próximo pedido de cambios se lo cuenta al agente
    await f.post(`/api/entregas/${id}/retoque`, { archivo: rel, antes: 'Nuestra colección', despues: 'Otoño' })
    expect((await f.post(`/api/entregas/${id}/cambios`, { texto: 'Sumá un pie' })).status).toBe(202)
    expect(await esperar(async () => (await entregas(f)).length === 2, 15)).toBe(true)
    const pedido = (f.sb.llamadas.findLast((l) => l.includes('--agent')) ?? []).at(-1)?.normalize('NFC') ?? ''
    expect(pedido).toContain(`Ojo: retoqué a mano ${rel}`)
    // la reemplazada ya no se retoca
    expect((await f.post(`/api/entregas/${id}/retoque`, { archivo: rel, antes: 'Otoño', despues: 'x' })).status).toBe(409)
  })

  test('retoque de markdown: reemplaza el texto; con mod viejo da 409; un tipo sin retoque da 400', async () => {
    const rel = 'archivos/entregables/marce/informe.md'
    const { f, id } = await conEntrega(rel)
    const v = (await f.get(`/api/entregas/${id}/vista`, { ruta: rel })).obj.vista as Obj
    const r = await f.post(`/api/entregas/${id}/retoque`, { archivo: rel, texto: '# Informe\n\nCorregido.\n', mod: v.mod })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(fs.readFileSync(f.ruta(rel), 'utf8')).toBe('# Informe\n\nCorregido.\n')
    expect((await f.post(`/api/entregas/${id}/retoque`, { archivo: rel, texto: 'otra', mod: num(v.mod) - 100 })).status).toBe(409)
    const img = await conEntrega('archivos/entregables/marce/foto.png')
    expect((await img.f.post(`/api/entregas/${img.id}/retoque`, { archivo: 'archivos/entregables/marce/foto.png', texto: 'x' })).status).toBe(400)
  })
})
