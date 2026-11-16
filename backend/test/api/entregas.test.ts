// Port de app/Tests/BackendTests/EntregasTests.swift.
// Sin acceso a internals: la suite de lógica pura (ArchivosEntrega, TextoEntrega) está en test/unit/entregas.test.ts
// (EventoClaude.parsear y CajaArchivos viven en el runner), y el callback `avisos.alCrear` (notificación nativa) se omite en «un chat que solo responde…».
import fs from 'node:fs'
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, U, chat, esperar, llamar, lista, str, type Obj } from '../support/sandbox.js'

const entregas = async (f: Fix, q: Record<string, string> = {}): Promise<Obj[]> => lista((await f.get('/api/entregas', q)).obj.entregas)
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

describe('Entregas (API)', () => {
  test('un chat que solo responde no deja entrega; uno que escribe en archivos/entregables sí, con sus archivos de adentro', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }] })
    await chat(f.b, { agent: 'marce', message: 'hola', session: U.a })
    expect(await entregas(f)).toEqual([])
    const r = await chat(f.b, { agent: 'marce', message: 'Armá el informe ENTREGA:archivos/entregables/informe.md', session: U.b })
    expect(r.status).toBe(200)
    expect(str(r.obj.entrega)).not.toBe('')
    const es = await entregas(f)
    expect(es.length).toBe(1)
    expect(str(es[0]!.origen)).toBe('chat')
    expect(str(es[0]!.agente)).toBe('marce')
    expect(str(es[0]!.sid)).toBe(U.b)
    expect(es[0]!.archivos, JSON.stringify(es[0]!.archivos)).toEqual(['archivos/entregables/informe.md'])
    expect(str(es[0]!.estado)).toBe('sin_revisar')
    const titulo = str(es[0]!.titulo)
    expect(titulo.startsWith('Armá el informe')).toBe(true)
    // interno (unit test del port): el aviso nativo `entrega:Marce` vía avisos.alCrear
    // un chat que escribe fuera de archivos/entregables no cuenta
    await chat(f.b, { agent: 'marce', message: 'ENTREGA:archivos/borrador.md', session: U.c })
    expect((await entregas(f)).length).toBe(1)
  })

  test('revisada / sin-revisar: el contador baja y sube, también en /api/actividad; detalle con texto; 404 y 400', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }] })
    await chat(f.b, { agent: 'marce', message: 'ENTREGA:archivos/entregables/a.md', session: U.a })
    await chat(f.b, { agent: 'marce', message: 'ENTREGA:archivos/entregables/b.md', session: U.b })
    expect((await f.get('/api/entregas')).obj.sinRevisar).toBe(2)
    expect((await f.get('/api/actividad')).obj.entregasSinRevisar).toBe(2)
    const es = await entregas(f)
    const id = num(es[0]!.id)
    const det = await f.get(`/api/entregas/${id}`)
    const texto = str((det.obj.entrega as Obj | undefined)?.texto)
    expect(texto.startsWith('Listo, dejé')).toBe(true)
    const rev = await f.post(`/api/entregas/${id}/revisada`)
    expect(rev.obj.sinRevisar).toBe(1)
    const estado = str((rev.obj.entrega as Obj | undefined)?.estado)
    expect(estado).toBe('revisada')
    expect((await entregas(f, { estado: 'sin_revisar' })).length).toBe(1)
    expect((await entregas(f, { estado: 'revisada' })).length).toBe(1)
    expect((await f.post(`/api/entregas/${id}/sin-revisar`)).obj.sinRevisar).toBe(2)
    expect((await f.get('/api/entregas/9999')).status).toBe(404)
    expect((await f.get('/api/entregas/abc')).status).toBe(404)
    expect((await f.get('/api/entregas', { estado: 'raro' })).status).toBe(400)
    expect((await f.get(`/api/entregas/${id}/revisada`)).status).toBe(405)
    expect(await entregas(f, { agente: 'otro' })).toEqual([])
    expect((await entregas(f, { origen: 'chat' })).length).toBe(2)
  })

  test('el acta de una reunión cerrada queda como entrega sin agente', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }, { id: 'pato', depto: 'direccion' }] })
    const r = await f.post('/api/reuniones', { tema: 'lanzamiento', agentes: ['marce', 'pato'] })
    const id = str(r.obj.id)
    const lista1 = await esperar(async () => str((await f.get(`/api/reuniones/${id}`)).obj.estado) === 'esperando', 15)
    expect(lista1).toBe(true)
    await f.post(`/api/reuniones/${id}/cerrar`)
    const ok = await esperar(async () => (await entregas(f, { origen: 'reunion' })).length > 0, 15)
    expect(ok).toBe(true)
    const e = (await entregas(f, { origen: 'reunion' }))[0] ?? {}
    expect(str(e.agente)).toBe('')
    expect(str(e.ref)).toBe(id)
    expect(str(e.titulo)).toBe('Acta: lanzamiento')
    const primero = (e.archivos as string[] | undefined)?.[0] ?? ''
    expect(primero.startsWith('reuniones/')).toBe(true)
  })

  test('pedir cambios: retoma la conversación, crea la versión nueva (padre) y la anterior queda reemplazada', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }] })
    await chat(f.b, { agent: 'marce', message: 'Informe ENTREGA:archivos/entregables/informe.md', session: U.a })
    const vieja = num((await entregas(f))[0]?.id)
    expect((await f.post(`/api/entregas/${vieja}/cambios`, { texto: '' })).status).toBe(400)
    expect((await llamar(f.b, 'POST', `/api/entregas/${vieja}/cambios`)).status).toBe(400)
    const r = await f.post(`/api/entregas/${vieja}/cambios`, { texto: 'Hacelo más corto' })
    expect(r.status, JSON.stringify(r.obj)).toBe(202)
    const ok = await esperar(async () => (await entregas(f)).length === 2, 15)
    expect(ok).toBe(true)
    const es = await entregas(f)
    expect(str(es[0]!.origen)).toBe('cambios')
    expect(es[0]!.padre).toBe(vieja)
    expect(str(es[0]!.sid)).toBe(U.a)
    expect(str(es[0]!.estado)).toBe('sin_revisar')
    expect(es[0]!.archivos, JSON.stringify(es[0]!.archivos)).toEqual(['archivos/entregables/informe.md'])
    expect(str(es[1]!.estado)).toBe('cambios')
    expect((await f.get('/api/entregas')).obj.sinRevisar).toBe(1)
    // retomó la misma conversación, con el pedido
    // NFC: Foundation pasa los argumentos en NFD en macOS; Swift compara por equivalencia canónica, JS no.
    const ult = (f.sb.llamadas.findLast((l) => l.includes('--agent')) ?? []).map((x) => x.normalize('NFC'))
    expect(ult.includes('--resume') && ult.includes(U.a)).toBe(true)
    expect(ult.at(-1) ?? '').toContain('Hacelo más corto')
    // la reemplazada no se puede volver a cambiar ni marcar sin revisar
    expect((await f.post(`/api/entregas/${vieja}/cambios`, { texto: 'otra' })).status).toBe(409)
    expect((await f.post(`/api/entregas/${vieja}/sin-revisar`)).status).toBe(409)
    const det = await f.get(`/api/entregas/${vieja}`)
    expect((det.obj.entrega as Obj | undefined)?.enCambios).toBe(false)
  })

  test('pedir cambios a un acta (sin conversación) da 409', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }, { id: 'pato', depto: 'direccion' }] })
    const r = await f.post('/api/reuniones', { tema: 'lanzamiento', agentes: ['marce', 'pato'] })
    const id = str(r.obj.id)
    await esperar(async () => str((await f.get(`/api/reuniones/${id}`)).obj.estado) === 'esperando', 15)
    await f.post(`/api/reuniones/${id}/cerrar`)
    const acta = num((await entregas(f, { origen: 'reunion' }))[0]?.id)
    expect((await f.post(`/api/entregas/${acta}/cambios`, { texto: 'x' })).status).toBe(409)
  })

  test('guardar en la biblioteca: copia fija con ficha, marca de qué entrega viene y no la da por revisada', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }] })
    const rel = 'archivos/entregables/marce/hipotesis.md'
    await chat(f.b, { agent: 'marce', message: `Hipótesis de cliente ENTREGA:${rel}`, session: U.a })
    const id = num((await entregas(f))[0]?.id)
    const det0 = (await f.get(`/api/entregas/${id}`)).obj.entrega as Obj
    expect(det0.guardables).toEqual([rel])
    expect(det0.enBiblioteca).toEqual([])

    const r = await f.post(`/api/entregas/${id}/biblioteca`, { departamento: 'redes' })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const a = (r.obj.archivos as Obj[])[0]!
    expect(a.departamento).toBe('redes')
    expect(str(a.ruta)).toBe('archivos/redes/hipotesis.md')
    expect(a.entrega).toEqual({ id, agente: 'marce', ruta: rel })
    expect(str((r.obj.entrega as Obj).estado)).toBe('sin_revisar')
    expect(r.obj.sinRevisar).toBe(1)
    expect(fs.readFileSync(f.ruta('archivos/redes/hipotesis.md'), 'utf8')).toBe('entregado por marce\n')
    // queda en la biblioteca con su marca y se ficha como cualquier subida
    const slug = str(a.slug)
    const listo = await esperar(async () => ['listo', 'error'].includes(str(((await f.get(`/api/archivos/${slug}`)).obj.archivo as Obj).estado)), 15)
    expect(listo).toBe(true)
    const enLista = lista((await f.get('/api/archivos')).obj.archivos).find((x) => x.slug === slug)
    expect(enLista?.entrega).toEqual({ id, agente: 'marce', ruta: rel })
    const det1 = (await f.get(`/api/entregas/${id}`)).obj.entrega as Obj
    expect(lista(det1.enBiblioteca).map((x) => x.slug)).toEqual([slug])
    // la copia es fija: si el agente cambia el original, la de la biblioteca no se toca
    fs.writeFileSync(f.ruta(rel), 'versión 2\n')
    expect(fs.readFileSync(f.ruta('archivos/redes/hipotesis.md'), 'utf8')).toBe('entregado por marce\n')
    // guardar dos veces lo mismo no duplica
    fs.writeFileSync(f.ruta(rel), 'entregado por marce\n')
    const otra = await f.post(`/api/entregas/${id}/biblioteca`, { departamento: 'redes' })
    expect((otra.obj.archivos as Obj[])[0]!.duplicado).toBe(true)
    expect(lista((await f.get('/api/archivos')).obj.archivos).length).toBe(1)
  })

  test('guardar en la biblioteca: errores (archivo ajeno, departamento, tipo no soportado, sin entrega)', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion' }] })
    await chat(f.b, { agent: 'marce', message: 'ENTREGA:archivos/entregables/marce/a.md', session: U.a })
    await chat(f.b, { agent: 'marce', message: 'ENTREGA:archivos/entregables/marce/datos.zzz', session: U.b })
    const [rara, buena] = (await entregas(f)).map((e) => num(e.id))
    expect((await f.post(`/api/entregas/${buena}/biblioteca`, { archivos: ['archivos/compartido/otro.md'] })).status).toBe(400)
    expect((await f.post(`/api/entregas/${buena}/biblioteca`, { archivos: ['../../etc/hosts'] })).status).toBe(400)
    expect((await f.post(`/api/entregas/${buena}/biblioteca`, { archivos: 'a.md' })).status).toBe(400)
    expect((await f.post(`/api/entregas/${buena}/biblioteca`, { archivos: [] })).status).toBe(409)
    expect((await f.post(`/api/entregas/${buena}/biblioteca`, { departamento: 'nada' })).status).toBe(400)
    expect(((await f.get(`/api/entregas/${rara}`)).obj.entrega as Obj).guardables).toEqual([])
    expect((await f.post(`/api/entregas/${rara}/biblioteca`)).status).toBe(409)
    expect((await f.post(`/api/entregas/${rara}/biblioteca`, { archivos: ['archivos/entregables/marce/datos.zzz'] })).status).toBe(400)
    // si el archivo ya no está, no se ofrece y no se guarda
    fs.rmSync(f.ruta('archivos/entregables/marce/a.md'))
    expect(((await f.get(`/api/entregas/${buena}`)).obj.entrega as Obj).guardables).toEqual([])
    expect((await f.post(`/api/entregas/${buena}/biblioteca`, { archivos: ['archivos/entregables/marce/a.md'] })).status).toBe(404)
    expect((await f.post('/api/entregas/9999/biblioteca')).status).toBe(404)
    expect((await f.get(`/api/entregas/${buena}/biblioteca`)).status).toBe(405)
    expect(lista((await f.get('/api/archivos')).obj.archivos)).toEqual([])
  })

  test('sin oficina: /api/entregas 409 y /api/actividad trae el contador en 0', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    expect((await llamar(b, 'GET', '/api/entregas')).status).toBe(409)
    expect((await llamar(b, 'GET', '/api/actividad')).obj.entregasSinRevisar).toBe(0)
  })
})
