// Carpetas de trabajo (trabajo.ts): dónde trabajan los agentes además de la oficina y desde dónde la app muestra archivos.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { regla } from '../../src/permisos.js'
import { Fix, Sandbox, U, chat, lista, str, type Obj } from '../support/sandbox.js'

/** Una carpeta «repo» al lado de la oficina (afuera de ella), con una página y su CSS. */
function repo(f: Fix, nombre = 'repo'): string {
  const r = path.join(path.dirname(f.carpeta), nombre)
  fs.mkdirSync(path.join(r, 'web'), { recursive: true })
  fs.mkdirSync(path.join(r, '.git'), { recursive: true })
  fs.writeFileSync(path.join(r, '.git', 'config'), '[core]')
  fs.writeFileSync(path.join(r, 'web', 'estilos.css'), 'h1{color:red}')
  fs.writeFileSync(path.join(r, 'web', 'index.html'), '<html><head><link rel="stylesheet" href="estilos.css"></head><body><h1>Hola</h1></body></html>')
  return r
}

describe('carpetas de trabajo', () => {
  test('alta, alcance y baja; rechaza rutas que no sirven', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'charly', depto: 'direccion' }, { id: 'marce', depto: 'direccion' }] })
    const r = repo(f)
    expect((await f.post('/api/carpetas-trabajo', { ruta: 'relativa' })).status).toBe(400)
    expect((await f.post('/api/carpetas-trabajo', { ruta: '/' })).status).toBe(400)
    expect((await f.post('/api/carpetas-trabajo', { ruta: r + '-no-existe' })).status).toBe(404)
    expect((await f.post('/api/carpetas-trabajo', { ruta: f.ruta('archivos') })).status).toBe(400) // ya es de la oficina
    expect((await f.post('/api/carpetas-trabajo', { ruta: path.dirname(f.carpeta) })).status).toBe(400) // contiene a la oficina
    expect((await f.post('/api/carpetas-trabajo', { ruta: r, alcance: { agentes: ['nadie'] } })).status).toBe(400)

    const c = await f.post('/api/carpetas-trabajo', { ruta: r, alcance: { agentes: ['charly'] } })
    expect(c.status, JSON.stringify(c.obj)).toBe(200)
    expect(c.obj.carpeta).toMatchObject({ id: 'repo', ruta: r, alcance: { agentes: ['charly'] }, existe: true })
    expect(lista(f.oficinaJSON().carpetasTrabajo)).toEqual([{ id: 'repo', ruta: r, alcance: { agentes: ['charly'] } }])
    expect((await f.post('/api/carpetas-trabajo', { ruta: r })).status).toBe(409)
    expect((await f.post('/api/carpetas-trabajo', { ruta: path.join(r, 'web') })).status).toBe(409) // se pisa

    expect((await f.patch('/api/carpetas-trabajo/repo', { alcance: 'oficina' })).obj.carpeta).toMatchObject({ alcance: 'oficina' })
    expect(lista((await f.get('/api/carpetas-trabajo')).obj.carpetas).length).toBe(1)
    expect((await f.delete('/api/carpetas-trabajo/repo')).status).toBe(200)
    expect(f.oficinaJSON().carpetasTrabajo).toBeUndefined()
    expect(fs.existsSync(path.join(r, 'web', 'index.html'))).toBe(true) // la carpeta no se toca
    expect((await f.delete('/api/carpetas-trabajo/repo')).status).toBe(404)
  })

  test('chat: el agente del alcance recibe --add-dir y escritura ahí; el resto no', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'charly', depto: 'direccion' }, { id: 'marce', depto: 'direccion' }] })
    const r = repo(f)
    await f.post('/api/carpetas-trabajo', { ruta: r, alcance: { agentes: ['charly'] } })
    await chat(f.b, { agent: 'charly', message: 'hola', session: U.a })
    const l = f.sb.llamadas.at(-1)!
    expect(Sandbox.valores(l, '--add-dir')).toEqual([r])
    expect(Sandbox.reglas(l)).toContain(regla('Edit', r + '/**'))
    expect(Sandbox.reglas(l)).toContain(regla('Write', r + '/**'))
    expect(str(Sandbox.valor(l, '--append-system-prompt'))).toContain('## Carpetas de trabajo')
    await chat(f.b, { agent: 'marce', message: 'hola', session: U.b })
    const l2 = f.sb.llamadas.at(-1)!
    expect(l2).not.toContain('--add-dir')
    expect(Sandbox.reglas(l2).some((x) => x.includes(r))).toBe(false)
  })

  test('la app muestra archivos de ahí (con su CSS), pero no lo oculto ni lo de afuera', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'charly', depto: 'direccion' }] })
    const r = repo(f)
    const pagina = path.join(r, 'web', 'index.html')
    expect((await f.get('/api/oficina/vista', { ruta: pagina })).status).toBe(403) // todavía no es de trabajo
    await f.post('/api/carpetas-trabajo', { ruta: r })
    const v = await f.get('/api/oficina/vista', { ruta: pagina })
    expect(v.status, JSON.stringify(v.obj)).toBe(200)
    expect(str((v.obj.vista as Obj).html)).toContain('<style>h1{color:red}</style>')
    const a = await f.get('/api/oficina/archivo', { ruta: pagina })
    expect(a.obj).toMatchObject({ rel: pagina.split(path.sep).join('/'), nombre: 'index.html' })
    const ls = await f.get('/api/oficina/archivos', { ruta: r })
    expect(lista(ls.obj.archivos).map((x) => x.nombre)).toEqual(['web']) // sin .git
    expect((await f.get('/api/oficina/archivo', { ruta: path.join(r, '.git', 'config') })).status).toBe(403)
    expect((await f.get('/api/oficina/archivo', { ruta: path.join(r, '..', 'otra', 'x.md') })).status).toBe(403)
    expect((await f.get('/api/oficina/archivo', { ruta: path.join(r, 'web', 'nada.md') })).status).toBe(404)
  })

  test('tarjetas del chat: un archivo escrito en la carpeta de trabajo va con su ruta absoluta; afuera, con ruta para sumarla', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'charly', depto: 'direccion' }] })
    const r = repo(f)
    await f.post('/api/carpetas-trabajo', { ruta: r })
    const res = await chat(f.b, { agent: 'charly', message: 'Armá la página ENTREGA:../repo/web/nueva.html', session: U.a })
    const pasos = lista(res.obj.pasos)
    const real = fs.realpathSync.native(r)
    expect(pasos).toContainEqual({ t: 'archivo', rel: path.join(real, 'web', 'nueva.html').split(path.sep).join('/'), nombre: 'nueva.html' })
    expect(pasos).toContainEqual({ t: 'archivo', nombre: 'oficina.md', ruta: '/fuera/de/la/oficina.md' })
  })
})
