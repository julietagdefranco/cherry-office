// Port de app/Tests/BackendTests/OficinasTests.swift.
// Oficinas (crear, abrir, recientes, persistencia, PATCH, 409 sin oficina) y departamentos.
import fs from 'node:fs'
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, U, dict, escribir, existe, leerTexto, lista, listar, llamar, str, type Backend, type Obj, type Resp, ruta } from '../support/sandbox.js'

const nueva = (b: Backend, body?: Obj): Promise<Resp> => llamar(b, 'POST', '/api/oficinas', { body })
const claves = (o: Obj) => Object.keys(o).sort()
const leerJSON = (ruta: string): Obj => { try { return JSON.parse(fs.readFileSync(ruta, 'utf8')) } catch { return {} } }
const esDir = (ruta: string) => { try { return fs.statSync(ruta).isDirectory() } catch { return false } }

describe('Oficinas y departamentos', () => {
  // MARK: crear

  test('crear: estructura de carpetas, plantillas y departamentos por defecto', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const r = await nueva(b, { nombre: 'Taller', duenio: 'Ana' })
    expect(r.status).toBe(200)
    expect(claves(r.obj)).toEqual(['carpeta', 'oficina'])
    const carpeta = str(r.obj.carpeta)
    expect(carpeta).toBe(ruta(sb.oficinasDir, 'Taller'))
    for (const d of ['conocimiento/agentes', 'conocimiento/fuentes', 'reuniones', 'archivos', '.claude/agents', 'archivos/compartido',
      'archivos/entregables', 'archivos/.texto', 'archivos/.papelera', 'archivos/direccion', 'archivos/comunicacion',
      'archivos/operaciones']) {
      expect(esDir(carpeta + '/' + d), `falta la carpeta ${d}`).toBe(true)
    }
    for (const f of ['oficina.json', 'conocimiento/oficina.md', 'conocimiento/decisiones.md', 'conocimiento/archivos.md']) {
      expect(existe(carpeta + '/' + f), `falta ${f}`).toBe(true)
    }
    expect(leerTexto(carpeta + '/conocimiento/oficina.md')).toContain('# Taller')
    expect(leerTexto(carpeta + '/conocimiento/oficina.md')).toContain('**Dueño:** Ana')
    expect(leerTexto(carpeta + '/conocimiento/decisiones.md')).toContain('# Decisiones de Taller')
    expect(leerTexto(carpeta + '/conocimiento/archivos.md')).toContain('(Todavía no hay documentos.)')

    const of = dict(r.obj.oficina)
    expect(of.nombre).toBe('Taller')
    expect(of.duenio).toBe('Ana')
    expect(of.agentes).toEqual([])
    const deps = lista(of.departamentos)
    expect(deps.map((d) => str(d.nombre))).toEqual(['Dirección', 'Comunicación', 'Operaciones'])
    expect(deps.map((d) => str(d.id))).toEqual(['direccion', 'comunicacion', 'operaciones'])
    expect(deps.map((d) => str(d.color))).toEqual(['#ee6da6', '#a88bd6', '#f0a35b'])
    // oficina.json en disco = lo que devolvió la API
    expect(leerJSON(carpeta + '/oficina.json')).toEqual(of)
  })

  test('crear: queda activa (GET /api/oficina, /api/estado y recientes)', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const e0 = await llamar(b, 'GET', '/api/estado')
    expect(e0.obj.oficina).toBeNull()
    expect(e0.obj.agentes).toEqual([])
    const r = await nueva(b, { nombre: 'Taller', duenio: 'Ana' })
    const carpeta = str(r.obj.carpeta)
    const g = await llamar(b, 'GET', '/api/oficina')
    expect(g.status).toBe(200)
    expect(g.obj.carpeta).toBe(carpeta)
    const e = await llamar(b, 'GET', '/api/estado')
    expect(dict(e.obj.oficina).carpeta).toBe(carpeta)
    expect(dict(e.obj.oficina).nombre).toBe('Taller')
    const l = await llamar(b, 'GET', '/api/oficinas')
    expect(l.obj.activa).toBe(carpeta)
    expect(lista(l.obj.oficinas).map((o) => str(o.nombre))).toEqual(['Taller'])
    expect(lista(l.obj.oficinas)[0]?.activa).toBe(true)
  })

  test('crear: departamentos como texto u objeto {nombre, color, id}', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const r = await nueva(b, { nombre: 'Estudio', departamentos: ['Gestión de Ventas', { nombre: 'Arte', color: '#ABCDEF', id: 'arte-1' }, { nombre: 'Soporte' }] })
    expect(r.status).toBe(200)
    const deps = lista(dict(r.obj.oficina).departamentos)
    expect(deps.map((d) => str(d.id))).toEqual(['gestion-de-ventas', 'arte-1', 'soporte'])
    expect(deps.map((d) => str(d.color))).toEqual(['#ee6da6', '#abcdef', '#f0a35b']) // color en minúsculas; el resto sigue la paleta por posición
  })

  test('crear: validaciones de departamentos', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const casos: [unknown, number][] = [
      ['texto', 400], // no es lista
      [[{ color: '#ffffff' }], 400], // objeto sin nombre
      [[{ nombre: 'A', color: 'rojo' }], 400], // color inválido
      [[{ nombre: 'A', id: 'Mal Id' }], 400], // id inválido
      [[{ nombre: 'A', id: 'x' }, { nombre: 'B', id: 'x' }], 409], // id repetido
      [[42], 400], // ni texto ni objeto
      [Array(13).fill('D'), 400], // más de 12
      [['n'.repeat(61)], 400], // nombre largo
    ]
    for (const [deps, esperado] of casos) {
      const r = await nueva(b, { nombre: 'Estudio', departamentos: deps })
      expect(r.status, `departamentos=${JSON.stringify(deps)} -> ${r.status} ${JSON.stringify(r.obj)}`).toBe(esperado)
      expect(typeof r.obj.error).toBe('string')
    }
    // nada quedó creado ni activo
    expect(listar(sb.oficinasDir)).toEqual([])
    expect((await llamar(b, 'GET', '/api/oficinas')).obj.activa).toBeNull()
    // lista vacía o null: usa los de por defecto
    for (const v of [[], null]) {
      const r = await nueva(b, { nombre: `Vacía ${listar(sb.oficinasDir).length}`, departamentos: v })
      expect(r.status).toBe(200)
      expect(lista(dict(r.obj.oficina).departamentos).length).toBe(3)
    }
  })

  test('crear: validaciones del cuerpo y del nombre', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    expect((await nueva(b, {})).status).toBe(400)
    expect((await nueva(b, { nombre: '   ' })).status).toBe(400)
    expect((await nueva(b, { nombre: 5 })).status).toBe(400)
    expect((await nueva(b, { nombre: 'a'.repeat(81) })).status).toBe(400)
    expect((await nueva(b, { nombre: 'Ok', duenio: 'a'.repeat(81) })).status).toBe(400)
    expect((await llamar(b, 'POST', '/api/oficinas')).status).toBe(400)
    expect((await llamar(b, 'POST', '/api/oficinas', { body: '[1]' })).status).toBe(400)
    expect((await llamar(b, 'POST', '/api/oficinas', { body: 'no json' })).status).toBe(400)
    const grande = await llamar(b, 'POST', '/api/oficinas', { body: ' '.repeat(200_001) })
    expect(grande.status).toBe(413)
    expect(listar(sb.oficinasDir)).toEqual([])
    // espacios alrededor del nombre se recortan
    const r = await nueva(b, { nombre: '  Con espacios  ' })
    expect(dict(r.obj.oficina).nombre).toBe('Con espacios')
  })

  test('crear: nombre ocupado -> «Nombre 2», «Nombre 3»; caracteres de ruta en el nombre pasan a «-»', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const a = await nueva(b, { nombre: 'Taller' })
    const c = await nueva(b, { nombre: 'Taller' })
    const d = await nueva(b, { nombre: 'Taller' })
    expect([a, c, d].map((x) => str(x.obj.carpeta))).toEqual([ruta(sb.oficinasDir, 'Taller'), ruta(sb.oficinasDir, 'Taller 2'), ruta(sb.oficinasDir, 'Taller 3')])
    // el nombre de la oficina queda tal cual aunque la carpeta tenga sufijo
    expect(dict(c.obj.oficina).nombre).toBe('Taller')
    const raro = await nueva(b, { nombre: 'A/B:C' })
    expect(str(raro.obj.carpeta)).toBe(ruta(sb.oficinasDir, 'A-B-C'))
    const punto = await nueva(b, { nombre: '..oculta' })
    expect(str(punto.obj.carpeta)).toBe(ruta(sb.oficinasDir, 'oculta'))
    // la última creada es la activa
    expect((await llamar(b, 'GET', '/api/oficinas')).obj.activa).toBe(ruta(sb.oficinasDir, 'oculta'))
  })

  test('crear: carpeta explícita (absoluta, con ~ del HOME temporal), relativa -> 400, 409 si ya hay oficina.json', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const abs = sb.root + '/elegida/Mi Oficina'
    const r = await nueva(b, { nombre: 'X', carpeta: abs })
    expect(r.status).toBe(200)
    expect(str(r.obj.carpeta)).toBe(abs)
    expect(existe(abs + '/oficina.json')).toBe(true)

    const tilde = await nueva(b, { nombre: 'Y', carpeta: '~/Casa' })
    expect(tilde.status).toBe(200)
    expect(str(tilde.obj.carpeta)).toBe(ruta(sb.home, 'Casa'))
    expect(existe(sb.home + '/Casa/oficina.json')).toBe(true)

    expect((await nueva(b, { nombre: 'Z', carpeta: 'relativa/carpeta' })).status).toBe(400)

    // ya hay oficina.json: 409 y no se pisa
    const antes = leerTexto(abs + '/oficina.json')
    const dup = await nueva(b, { nombre: 'Otra', carpeta: abs })
    expect(dup.status).toBe(409)
    expect(leerTexto(abs + '/oficina.json')).toBe(antes)
    // la que sigue activa es la anterior (la del 409 no la cambió)
    expect((await llamar(b, 'GET', '/api/oficinas')).obj.activa).toBe(ruta(sb.home, 'Casa'))
  })

  test('crear sobre una carpeta que ya existe: no pisa el contenido del usuario', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const dir = sb.root + '/existente'
    escribir('MI MEMORIA', dir + '/conocimiento/oficina.md')
    escribir('otro', dir + '/nota.txt')
    const r = await nueva(b, { nombre: 'Existente', carpeta: dir })
    expect(r.status).toBe(200)
    expect(leerTexto(dir + '/conocimiento/oficina.md')).toBe('MI MEMORIA')
    expect(leerTexto(dir + '/nota.txt')).toBe('otro')
    expect(existe(dir + '/conocimiento/decisiones.md')).toBe(true)
  })

  // MARK: abrir

  test('abrir: 404 carpeta inexistente o sin oficina.json; 400 ruta relativa o falta de campo', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    // `c === undefined`: sin campo `carpeta`
    const abrir = (c?: unknown) => llamar(b, 'POST', '/api/oficinas/abrir', { body: c === undefined ? {} : { carpeta: c } })
    expect((await abrir(sb.root + '/no-existe')).status).toBe(404)
    fs.mkdirSync(sb.root + '/vacia', { recursive: true })
    const sin = await abrir(sb.root + '/vacia')
    expect(sin.status).toBe(404)
    expect(str(sin.obj.error)).toContain('oficina.json')
    expect((await abrir('relativa')).status).toBe(400)
    expect((await abrir()).status).toBe(400)
    expect((await abrir(7)).status).toBe(400)
    expect((await llamar(b, 'POST', '/api/oficinas/abrir')).status).toBe(400)
    // un archivo común no es una carpeta
    escribir('x', sb.root + '/archivo.txt')
    expect((await abrir(sb.root + '/archivo.txt')).status).toBe(404)
    expect((await llamar(b, 'GET', '/api/oficinas')).obj.activa).toBeNull()
  })

  test('abrir: oficina.json inválido -> 400 y no se activa', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const con = async (nombre: string, contenido: string) => {
      escribir(contenido, sb.root + `/${nombre}/oficina.json`)
      return llamar(b, 'POST', '/api/oficinas/abrir', { body: { carpeta: sb.root + '/' + nombre } })
    }
    expect((await con('a', 'esto no es json')).status).toBe(400)
    expect((await con('b', '{"version":2,"nombre":"X","departamentos":[],"agentes":[]}')).status).toBe(400)
    expect((await con('c', '{"nombre":"X","departamentos":[{"id":"d","nombre":"D","color":"#ffffff"}],"agentes":[{"id":"a","nombre":"A","rol":"r","departamento":"inexistente"}]}')).status).toBe(400)
    expect((await con('d', '{"nombre":"X","departamentos":[{"id":"Mal Id","nombre":"D","color":"#ffffff"}],"agentes":[]}')).status).toBe(400)
    expect((await con('e', '{"nombre":"X","departamentos":[{"id":"d","nombre":"D","color":"rojo"}],"agentes":[]}')).status).toBe(400)
    expect((await con('f', '{"nombre":"  ","departamentos":[],"agentes":[]}')).status).toBe(400)
    expect((await con('g', '{"nombre":"X","departamentos":[{"id":"d","nombre":"D","color":"#ffffff"}],"agentes":[{"id":"a","nombre":"A","rol":"r","departamento":"d"},{"id":"a","nombre":"B","rol":"r","departamento":"d"}]}')).status).toBe(400)
    expect((await llamar(b, 'GET', '/api/oficinas')).obj.activa).toBeNull()
    expect((await llamar(b, 'GET', '/api/oficina')).status).toBe(409)
  })

  test('abrir: una oficina válida queda activa y se completan las carpetas que falten (sin pisar nada)', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const dir = sb.root + '/mia'
    escribir('{"version":1,"nombre":"Mía","duenio":"Eva","departamentos":[{"id":"d","nombre":"D","color":"#ffffff"}],"agentes":[]}', dir + '/oficina.json')
    escribir('catálogo propio', dir + '/conocimiento/archivos.md')
    const r = await llamar(b, 'POST', '/api/oficinas/abrir', { body: { carpeta: dir } })
    expect(r.status).toBe(200)
    expect(r.obj.carpeta).toBe(dir)
    expect(dict(r.obj.oficina).nombre).toBe('Mía')
    for (const d of ['conocimiento/agentes', 'conocimiento/fuentes', 'reuniones', 'archivos', '.claude/agents', 'archivos/compartido',
      'archivos/entregables', 'archivos/.texto', 'archivos/.papelera']) {
      expect(existe(dir + '/' + d), `falta ${d}`).toBe(true)
    }
    expect(leerTexto(dir + '/conocimiento/archivos.md')).toBe('catálogo propio')
    expect((await llamar(b, 'GET', '/api/oficina')).obj.carpeta).toBe(dir)
    // con ~ del HOME temporal
    const tilde = await llamar(b, 'POST', '/api/oficinas/abrir', { body: { carpeta: '~/../mia' } })
    expect(tilde.status).toBe(200)
    expect(str(tilde.obj.carpeta)).toBe(dir)
  })

  // MARK: recientes y persistencia

  test('recientes: la más reciente primero, solo una activa, salta las borradas, máximo 10', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const carpetas: string[] = []
    for (let i = 1; i <= 12; i++) carpetas.push(str((await nueva(b, { nombre: `Of ${i}` })).obj.carpeta))
    let l = await llamar(b, 'GET', '/api/oficinas')
    let of = lista(l.obj.oficinas)
    expect(of.length).toBe(10)
    expect(of.map((o) => str(o.nombre))).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((n) => `Of ${n}`))
    expect(of.filter((o) => o.activa === true).length).toBe(1)
    expect(of[0]?.activa).toBe(true)
    // abrir una vieja la sube al principio y la hace activa
    await llamar(b, 'POST', '/api/oficinas/abrir', { body: { carpeta: carpetas[5] } })
    l = await llamar(b, 'GET', '/api/oficinas')
    of = lista(l.obj.oficinas)
    expect(str(of[0]?.nombre)).toBe('Of 6')
    expect(l.obj.activa).toBe(carpetas[5])
    expect(of.length).toBe(10)
    // borrar la carpeta de una reciente: se saltea
    fs.rmSync(carpetas[8]!, { recursive: true })
    of = lista((await llamar(b, 'GET', '/api/oficinas')).obj.oficinas)
    expect(of.length).toBe(9)
    expect(of.map((o) => str(o.carpeta))).not.toContain(carpetas[8])
  }, 30_000)

  test('persistencia: la oficina activa y los recientes sobreviven a recrear el Backend', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const a = str((await nueva(b, { nombre: 'Uno' })).obj.carpeta)
    const c = str((await nueva(b, { nombre: 'Dos' })).obj.carpeta)
    const cfg = leerJSON(sb.datos + '/config.json')
    expect(cfg.oficina_activa).toBe(c)
    expect(lista(cfg.oficinas_recientes).map((o) => str(o.carpeta))).toEqual([c, a])

    await b.cerrar()
    const b2 = await sb.backend({ oficina: false })
    const g = await llamar(b2, 'GET', '/api/oficina')
    expect(g.status).toBe(200)
    expect(g.obj.carpeta).toBe(c)
    const l = await llamar(b2, 'GET', '/api/oficinas')
    expect(lista(l.obj.oficinas).map((o) => str(o.nombre))).toEqual(['Dos', 'Uno'])
    expect(l.obj.activa).toBe(c)
    const e = await llamar(b2, 'GET', '/api/estado')
    expect(dict(e.obj.oficina).nombre).toBe('Dos')
  })

  test('persistencia: otras claves de config.json se conservan; un config.json ilegible no se pisa', async () => {
    const sb = new Sandbox()
    fs.mkdirSync(sb.datos, { recursive: true })
    escribir('{"otra_clave": 123}', sb.datos + '/config.json')
    const b = await sb.backend({ oficina: false })
    await nueva(b, { nombre: 'Uno' })
    const cfg = leerJSON(sb.datos + '/config.json')
    expect(cfg.otra_clave).toBe(123)
    expect(typeof cfg.oficina_activa).toBe('string')

    const sb2 = new Sandbox()
    fs.mkdirSync(sb2.datos, { recursive: true })
    escribir('{ esto no es json', sb2.datos + '/config.json')
    // OJO: el arnés (sb.backend) solo pisa config.json si `config` trae claves o no existe; acá existe y no se toca.
    const b2 = await sb2.backend({ oficina: false })
    const r = await nueva(b2, { nombre: 'Uno' })
    expect(r.status).toBe(200) // la oficina se crea igual
    expect(leerTexto(sb2.datos + '/config.json')).toBe('{ esto no es json') // y el archivo ilegible queda como estaba
  })

  test('si la oficina activa pierde su oficina.json: 409 y /api/oficinas ya no la marca activa', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const c = str((await nueva(b, { nombre: 'Uno' })).obj.carpeta)
    fs.rmSync(c + '/oficina.json')
    expect((await llamar(b, 'GET', '/api/oficina')).status).toBe(409)
    const l = await llamar(b, 'GET', '/api/oficinas')
    expect(lista(l.obj.oficinas)).toEqual([])
    expect(l.obj.activa).toBeNull()
    expect((await llamar(b, 'GET', '/api/estado')).obj.oficina).toBeNull()
  })

  // MARK: PATCH /api/oficina

  test('PATCH oficina: nombre y dueño (se guardan en oficina.json, se recortan y actualizan los recientes)', async () => {
    const f = await Fix.crear({ nombre: 'Viejo', duenio: 'Ana' })
    const r = await f.patch('/api/oficina', { nombre: '  Nuevo  ', duenio: 'Beto' })
    expect(r.status).toBe(200)
    expect(dict(r.obj.oficina).nombre).toBe('Nuevo')
    expect(dict(r.obj.oficina).duenio).toBe('Beto')
    expect(f.oficinaJSON().nombre).toBe('Nuevo')
    expect(f.oficinaJSON().duenio).toBe('Beto')
    expect(r.obj.carpeta).toBe(f.carpeta)
    expect(lista((await f.get('/api/oficinas')).obj.oficinas).map((o) => str(o.nombre))).toEqual(['Nuevo'])
    // solo el dueño: el nombre no cambia
    await f.patch('/api/oficina', { duenio: 'Cata' })
    expect(f.oficinaJSON().nombre).toBe('Nuevo')
    expect(f.oficinaJSON().duenio).toBe('Cata')
    // {} no cambia nada
    const vacio = await f.patch('/api/oficina', {})
    expect(vacio.status).toBe(200)
    expect(f.oficinaJSON().nombre).toBe('Nuevo')
    // el resto de oficina.json (departamentos) sigue igual
    expect(f.oficinaJSON().departamentos.length).toBe(2)
  })

  test('PATCH oficina: validaciones', async () => {
    const f = await Fix.crear()
    expect((await f.patch('/api/oficina', { nombre: 3 })).status).toBe(400)
    expect((await f.patch('/api/oficina', { nombre: 'x'.repeat(81) })).status).toBe(400)
    expect((await f.patch('/api/oficina', { duenio: 'x'.repeat(81) })).status).toBe(400)
    expect((await f.patch('/api/oficina')).status).toBe(400)
    expect((await llamar(f.b, 'PATCH', '/api/oficina', { body: '[]' })).status).toBe(400)
    expect(f.oficinaJSON().nombre).toBe('Taller')
    expect((await llamar(f.b, 'DELETE', '/api/oficina')).status).toBe(405)
  })

  // MARK: 409 sin oficina

  test('sin oficina abierta: las rutas que la exigen responden 409 «No hay una oficina abierta»', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const u = U.a
    const casos: [string, string, Obj | undefined][] = [
      ['GET', '/api/oficina', undefined], ['PATCH', '/api/oficina', { nombre: 'X' }],
      ['POST', '/api/departamentos', { nombre: 'X' }], ['PATCH', '/api/departamentos/x', { nombre: 'X' }],
      ['DELETE', '/api/departamentos/x', undefined],
      ['GET', '/api/agentes', undefined],
      ['POST', '/api/agentes', { nombre: 'N', rol: 'r', prompt: 'p', departamento: 'd' }],
      ['POST', '/api/agentes/borrador', { descripcion: 'algo', departamento: 'd' }],
      ['GET', '/api/agentes/x', undefined], ['PATCH', '/api/agentes/x', { nombre: 'X' }], ['DELETE', '/api/agentes/x', undefined],
      ['GET', '/api/agentes/x/conocimiento', undefined],
      ['POST', '/api/chat', { agent: 'x', message: 'hola', session: u }],
      ['GET', '/api/historial?agent=x', undefined],
      ['GET', '/api/reuniones', undefined], ['POST', '/api/reuniones', { tema: 't', agentes: ['x'] }],
      ['GET', `/api/reuniones/${u}`, undefined], ['POST', `/api/reuniones/${u}/cerrar`, undefined],
      ['GET', '/api/archivos', undefined], ['POST', '/api/archivos', { nombre: 'a.txt', base64: 'aG9sYQ==' }],
      ['GET', '/api/vinculos', undefined], ['POST', '/api/vinculos', { ruta: '/tmp' }],
      ['GET', '/api/biblioteca/estado', undefined], ['GET', '/api/biblioteca/config', undefined],
      ['GET', '/api/biblioteca/propuestas', undefined],
    ]
    for (const [m, p, body] of casos) {
      let query: Record<string, string> = {}
      let ruta = p
      const i = p.indexOf('?')
      if (i >= 0) {
        ruta = p.slice(0, i)
        query = Object.fromEntries(p.slice(i + 1).split('&').map((kv) => kv.split('=') as [string, string]))
      }
      const r = await llamar(b, m, ruta, { query, body })
      expect(r.status, `${m} ${p} -> ${r.status} ${JSON.stringify(r.obj)}`).toBe(409)
      expect(r.obj.error, `${m} ${p}`).toBe('No hay una oficina abierta')
    }
    // /api/estado y /api/oficinas funcionan sin oficina
    expect((await llamar(b, 'GET', '/api/estado')).status).toBe(200)
    const l = await llamar(b, 'GET', '/api/oficinas')
    expect(l.status).toBe(200)
    expect(l.obj.oficinas).toEqual([])
    // y no se lanzó ningún claude
    expect(sb.llamadas).toEqual([])
  })

  test('rutas desconocidas -> 404; método no permitido -> 405', async () => {
    const f = await Fix.crear()
    expect((await f.get('/api/nada')).status).toBe(404)
    expect((await f.get('/api/oficinas/otra')).status).toBe(404)
    expect((await f.get('/api/agentes/Mal_Id')).status).toBe(404)
    expect((await f.get('/api/departamentos/Mal_Id')).status).toBe(404)
    expect((await llamar(f.b, 'PUT', '/api/oficinas')).status).toBe(405)
    expect((await llamar(f.b, 'GET', '/api/departamentos')).status).toBe(405)
    expect((await llamar(f.b, 'DELETE', '/api/agentes')).status).toBe(405)
    expect((await llamar(f.b, 'POST', '/api/oficinas/abrir/x')).status).toBe(404)
  })

  // MARK: departamentos

  test('departamentos: crear (id desde el nombre, color de la paleta, ids únicos, id explícito, color en minúsculas)', async () => {
    const f = await Fix.crear({ deps: ['Dirección'] })
    const r = await f.post('/api/departamentos', { nombre: 'Compras y Ventas' })
    expect(r.status).toBe(200)
    expect(claves(r.obj)).toEqual(['departamento', 'oficina'])
    const d = dict(r.obj.departamento)
    expect(d.id).toBe('compras-y-ventas')
    expect(d.nombre).toBe('Compras y Ventas')
    expect(d.color).toBe('#a88bd6') // índice 1 de la paleta
    expect(lista(dict(r.obj.oficina).departamentos).length).toBe(2)
    // mismo nombre: id con -2
    const dup = await f.post('/api/departamentos', { nombre: 'Compras y Ventas' })
    expect(dict(dup.obj.departamento).id).toBe('compras-y-ventas-2')
    // acentos y mayúsculas
    expect(dict((await f.post('/api/departamentos', { nombre: 'GESTIÓN Ñandú' })).obj.departamento).id).toBe('gestion-nandu')
    // nombre sin letras: id de respaldo
    expect(dict((await f.post('/api/departamentos', { nombre: '★★★' })).obj.departamento).id).toBe('depto')
    // id y color explícitos
    const ex = await f.post('/api/departamentos', { nombre: 'Arte', id: 'arte', color: '#ABC123' })
    expect(dict(ex.obj.departamento).id).toBe('arte')
    expect(dict(ex.obj.departamento).color).toBe('#abc123')
    // persistido
    const ids = lista(f.oficinaJSON().departamentos).map((x) => str(x.id))
    expect(ids).toEqual(['direccion', 'compras-y-ventas', 'compras-y-ventas-2', 'gestion-nandu', 'depto', 'arte'])
  })

  test('departamentos: validaciones al crear (nombre, id, color, duplicado 409, máximo 12)', async () => {
    const f = await Fix.crear({ deps: ['Uno'] })
    expect((await f.post('/api/departamentos', {})).status).toBe(400)
    expect((await f.post('/api/departamentos', { nombre: ' ' })).status).toBe(400)
    expect((await f.post('/api/departamentos', { nombre: 'n'.repeat(61) })).status).toBe(400)
    expect((await f.post('/api/departamentos', { nombre: 'A', color: 'rojo' })).status).toBe(400)
    expect((await f.post('/api/departamentos', { nombre: 'A', color: '#fff' })).status).toBe(400)
    expect((await f.post('/api/departamentos', { nombre: 'A', id: 'Mal Id' })).status).toBe(400)
    expect((await f.post('/api/departamentos', { nombre: 'A', id: 'uno' })).status).toBe(409)
    expect((await f.post('/api/departamentos')).status).toBe(400)
    expect(lista(f.oficinaJSON().departamentos).length).toBe(1)
    for (let i = 2; i <= 12; i++) expect((await f.post('/api/departamentos', { nombre: `D${i}` })).status).toBe(200)
    const trece = await f.post('/api/departamentos', { nombre: 'D13' })
    expect(trece.status).toBe(400)
    expect(str(trece.obj.error)).toContain('12')
    expect(lista(f.oficinaJSON().departamentos).length).toBe(12)
  })

  test('departamentos: PATCH nombre y color; el id no cambia; 404 y validaciones', async () => {
    const f = await Fix.crear({ deps: ['Redes', 'Ads'] })
    const r = await f.patch('/api/departamentos/redes', { nombre: '  Redes sociales ', color: '#AABBCC' })
    expect(r.status).toBe(200)
    const d = dict(r.obj.departamento)
    expect(d.id).toBe('redes')
    expect(d.nombre).toBe('Redes sociales')
    expect(d.color).toBe('#aabbcc')
    expect(lista(f.oficinaJSON().departamentos).map((x) => str(x.nombre))).toEqual(['Redes sociales', 'Ads'])
    // solo color
    const c = await f.patch('/api/departamentos/ads', { color: '#112233' })
    expect(dict(c.obj.departamento).nombre).toBe('Ads')
    // errores
    expect((await f.patch('/api/departamentos/nada', { nombre: 'X' })).status).toBe(404)
    expect((await f.patch('/api/departamentos/Mal_Id', { nombre: 'X' })).status).toBe(404)
    expect((await f.patch('/api/departamentos/redes', { nombre: 'n'.repeat(61) })).status).toBe(400)
    expect((await f.patch('/api/departamentos/redes', { color: 'azul' })).status).toBe(400)
    expect((await f.patch('/api/departamentos/redes', { nombre: 4 })).status).toBe(400)
    expect((await f.patch('/api/departamentos/redes')).status).toBe(400)
    // {} no cambia
    expect((await f.patch('/api/departamentos/redes', {})).status).toBe(200)
    expect(lista(f.oficinaJSON().departamentos).map((x) => str(x.nombre))).toEqual(['Redes sociales', 'Ads'])
  })

  test('departamentos: borrar uno sin agentes', async () => {
    const f = await Fix.crear({ deps: ['Uno', 'Dos', 'Tres'] })
    const r = await f.delete('/api/departamentos/dos')
    expect(r.status).toBe(200)
    expect(r.obj.ok).toBe(true)
    expect(lista(dict(r.obj.oficina).departamentos).map((x) => str(x.id))).toEqual(['uno', 'tres'])
    expect(lista(f.oficinaJSON().departamentos).map((x) => str(x.id))).toEqual(['uno', 'tres'])
    expect((await f.delete('/api/departamentos/dos')).status).toBe(404)
    expect((await f.delete('/api/departamentos/Mal_Id')).status).toBe(404)
    // el borrado no toca archivos/<depto> (nada se borra)
    expect(f.existe('archivos/dos')).toBe(true)
  })

  test('departamentos: borrar con agentes exige moverA (cuerpo o query); destino inválido 400; los agentes se mueven', async () => {
    const f = await Fix.crear({ deps: ['Uno', 'Dos', 'Tres'], agentes: [{ id: 'a', depto: 'dos' }, { id: 'b', depto: 'dos' }, { id: 'c', depto: 'uno' }] })
    const sin = await f.delete('/api/departamentos/dos')
    expect(sin.status).toBe(409)
    expect(str(sin.obj.error)).toContain('2 agente(s)')
    expect((await f.delete('/api/departamentos/dos', { moverA: '' })).status).toBe(409)
    expect((await f.delete('/api/departamentos/dos', { moverA: 'inexistente' })).status).toBe(400)
    expect((await f.delete('/api/departamentos/dos', { moverA: 'dos' })).status).toBe(400)
    expect(lista(f.oficinaJSON().departamentos).length).toBe(3) // nada cambió
    const ok = await f.delete('/api/departamentos/dos', { moverA: 'tres' })
    expect(ok.status).toBe(200)
    const ags = lista(f.oficinaJSON().agentes)
    expect(ags.find((a) => str(a.id) === 'a')?.departamento).toBe('tres')
    expect(ags.find((a) => str(a.id) === 'b')?.departamento).toBe('tres')
    expect(ags.find((a) => str(a.id) === 'c')?.departamento).toBe('uno')
    expect(lista(dict(ok.obj.oficina).agentes).length).toBe(3)
    // moverA por query
    const q = await f.delete('/api/departamentos/uno', undefined, { moverA: 'tres' })
    expect(q.status).toBe(200)
    expect(lista(f.oficinaJSON().agentes).every((a) => str(a.departamento) === 'tres')).toBe(true)
    // los .md de los agentes no se tocaron
    expect(f.existe('.claude/agents/a.md') && f.existe('.claude/agents/b.md') && f.existe('.claude/agents/c.md')).toBe(true)
  })

  test('departamentos: no se puede borrar el último (409), ni siquiera con moverA', async () => {
    const f = await Fix.crear({ deps: ['Solo'], agentes: [{ id: 'a', depto: 'solo' }] })
    const r = await f.delete('/api/departamentos/solo')
    expect(r.status).toBe(409)
    expect(str(r.obj.error)).toContain('al menos un departamento')
    expect((await f.delete('/api/departamentos/solo', { moverA: 'solo' })).status).toBe(409)
    expect(lista(f.oficinaJSON().departamentos).length).toBe(1)
    // cuerpo que no es un objeto JSON
    expect((await llamar(f.b, 'DELETE', '/api/departamentos/solo', { body: '[1]' })).status).toBe(400)
  })
})
