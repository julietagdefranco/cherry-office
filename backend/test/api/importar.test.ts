// Port de app/Tests/BackendTests/ImportarTests.swift.
// Importar Próspera desde el repo (agentes/ y contexto/ del repo como origen; HOME y oficinas temporales).
// Sin acceso a internals (b.store): los tests de chats anteriores quedan para los unit tests del port.
import fs from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  Sandbox, U, chat, dict, escribir, existe, leerTexto, lista, listar, llamar, raizRepo, sinPrivate, str,
  type Backend,
} from '../support/sandbox.js'

const ids = ['betty', 'don-armando', 'mario', 'marce', 'catalina', 'patricia', 'sofia', 'nicolas']

const importar = (b: Backend, origen: string | null = raizRepo) =>
  llamar(b, 'POST', '/api/oficinas/importar-prospera', { body: origen === null ? undefined : { origen } })

describe('Importar Próspera', () => {
  test('desde el repo: 5 departamentos, 8 agentes, estructura y respuesta completa', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const r = await importar(b)
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    expect(new Set(Object.keys(r.obj))).toEqual(new Set(['carpeta', 'oficina', 'yaExistia', 'agentesImportados', 'faltantes', 'copiados']))
    const carpeta = str(r.obj.carpeta)
    expect(carpeta).toBe(sb.oficinasDir + '/Próspera HQ')
    expect(r.obj.yaExistia).toBe(false)
    expect(r.obj.agentesImportados).toEqual(ids)
    expect(r.obj.faltantes).toEqual([])
    const of = dict(r.obj.oficina)
    expect(of.nombre).toBe('Próspera HQ')
    expect(of.duenio).toBe('Juli')
    const deps = lista(of.departamentos)
    expect(deps.map((d) => str(d.id))).toEqual(['dir', 'redes', 'ads', 'clases', 'video'])
    expect(deps.map((d) => str(d.nombre))).toEqual(['Dirección', 'Redes y estrategia digital', 'Ads', 'Clases de PRÓSPERAS', 'Edición de video'])
    const ags = lista(of.agentes)
    expect(ags.map((a) => str(a.id))).toEqual(ids)
    const depDe = Object.fromEntries(ags.map((a) => [str(a.id), str(a.departamento)]))
    expect(depDe).toEqual({
      betty: 'dir', 'don-armando': 'video', mario: 'video', marce: 'redes', catalina: 'redes',
      patricia: 'redes', sofia: 'clases', nicolas: 'ads',
    })
    for (const a of ags) {
      expect(str(a.rol) === '').toBe(false)
      expect(Array.isArray(a.chips) && a.chips.length > 0).toBe(true)
      expect(dict(a.avatar).semilla).toBe(str(a.id))
      expect(str(dict(a.avatar).colorTorso).startsWith('#')).toBe(true)
    }
    // betty puede escribir además la memoria común y las decisiones
    const betty = ags.find((a) => str(a.id) === 'betty')!
    expect(betty).toBeDefined()
    expect(betty.escritura).toEqual(['conocimiento/oficina.md', 'conocimiento/decisiones.md'])
    expect(ags.filter((a) => a.escritura !== undefined).length).toBe(1)
    // carpetas y archivos
    for (const id of ids) {
      const md = leerTexto(`${carpeta}/.claude/agents/${id}.md`)
      expect(md.startsWith('---'), `${id}.md sin frontmatter`).toBe(true)
      expect(md.includes(`name: ${id}`), `${id}.md sin name`).toBe(true)
      expect(existe(`${carpeta}/conocimiento/agentes/${id}.md`), `faltan las notas de ${id}`).toBe(true)
    }
    for (const d of ['archivos/compartido', 'archivos/entregables', 'archivos/dir', 'archivos/video', 'conocimiento/fuentes', 'reuniones']) {
      expect(existe(`${carpeta}/${d}`), `falta ${d}`).toBe(true)
    }
    expect(existe(`${carpeta}/.importada-prospera`)).toBe(true)
    // el contexto del repo se copió
    const copiados = (r.obj.copiados as string[] | undefined) ?? []
    expect(copiados.includes('conocimiento/contexto-maestro.md')).toBe(true)
    expect(copiados.includes('conocimiento/decisiones.md')).toBe(true)
    expect(leerTexto(`${carpeta}/conocimiento/contexto-maestro.md`)).toBe(leerTexto(`${raizRepo}/contexto/contexto-maestro.md`))
    expect(leerTexto(`${carpeta}/conocimiento/decisiones.md`)).toBe(leerTexto(`${raizRepo}/contexto/equipo/decisiones.md`))
    // queda activa
    expect((await llamar(b, 'GET', '/api/oficina')).obj.carpeta).toBe(carpeta)
    expect((await llamar(b, 'GET', '/api/estado')).obj.agentes).toEqual([...ids].sort())
    // los datos originales del repo no se tocaron
    expect(existe(`${raizRepo}/agentes/betty.md`) && existe(`${raizRepo}/contexto/contexto-maestro.md`)).toBe(true)
  })

  test('las rutas de la instalación de Juli pasan a rutas relativas a la oficina', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const r = await importar(b)
    const carpeta = str(r.obj.carpeta)
    // lo que cuenta como «memoria»: el estado, el contexto maestro y _equipo (las tres rutas absolutas que adapta el importador)
    const memoria = [
      /\/Users\/[^/\s`]+\/Pr(ó|ó)spera\/_betty\/estado-actual\.md/u,
      /\/Users\/[^/\s`]+\/\.claude\/betty\/contexto-maestro\.md/u,
      /\/Users\/[^/\s`]+\/Pr(ó|ó)spera\/_equipo\//u,
    ]
    const restos: string[] = []
    for (const id of ids) {
      const md = leerTexto(`${carpeta}/.claude/agents/${id}.md`)
      for (const patron of memoria) {
        expect(patron.test(md), `${id}.md conserva una ruta de memoria absoluta (${patron})`).toBe(false)
      }
      for (const l of md.split('\n')) if (l.includes('/Users/')) restos.push(`${id}: ${l.trim()}`)
    }
    expect(leerTexto(`${carpeta}/.claude/agents/betty.md`).includes('conocimiento/oficina.md')).toBe(true)
    expect(leerTexto(`${carpeta}/.claude/agents/betty.md`).includes('conocimiento/contexto-maestro.md')).toBe(true)
    expect(leerTexto(`${carpeta}/.claude/agents/marce.md`).includes('conocimiento/agentes/')).toBe(true)
    // Ninguna ruta /Users/<alguien> debería sobrevivir en los agentes importados (la oficina tiene que andar en otra Mac).
    // Swift: withKnownIssue(isIntermittent: true) — el importador solo adapta 3 patrones de ruta; quedan «/Users/julietadefranco/Próspera…»
    // sueltas en los .md. Es un problema conocido e intermitente (depende del contenido del repo): se acepta tanto que falle como que pase.
    try { expect(restos, `rutas absolutas que sobreviven: ${restos.slice(0, 6)}`).toEqual([]) } catch { /* known issue */ }
  })

  test('copia, sin mover, el estado, el contexto maestro y _equipo de la instalación real (con HOME temporal)', async () => {
    const sb = new Sandbox()
    escribir('ESTADO REAL', sb.proyecto + '/_betty/estado-actual.md')
    escribir('DECISIONES REALES', sb.proyecto + '/_equipo/decisiones.md')
    escribir('NOTAS DE BETTY', sb.proyecto + '/_equipo/agentes/betty.md')
    escribir('plantilla', sb.proyecto + '/_equipo/agentes/PLANTILLA.md')
    escribir('oculto', sb.proyecto + '/_equipo/.git/config.md')
    escribir('MAESTRO DEL HOME', sb.home + '/.claude/betty/contexto-maestro.md')
    const b = await sb.backend({ oficina: false })
    const r = await importar(b)
    expect(r.status).toBe(200)
    const carpeta = str(r.obj.carpeta)
    expect(leerTexto(carpeta + '/conocimiento/oficina.md')).toBe('ESTADO REAL')
    expect(leerTexto(carpeta + '/conocimiento/decisiones.md')).toBe('DECISIONES REALES')
    expect(leerTexto(carpeta + '/conocimiento/agentes/betty.md')).toBe('NOTAS DE BETTY')
    expect(leerTexto(carpeta + '/conocimiento/contexto-maestro.md')).toBe('MAESTRO DEL HOME')  // el de ~/.claude gana al del repo
    expect(existe(carpeta + '/conocimiento/agentes/PLANTILLA.md')).toBe(false)
    expect(existe(carpeta + '/conocimiento/.git')).toBe(false)
    const copiados = new Set((r.obj.copiados as string[] | undefined) ?? [])
    for (const c of ['conocimiento/oficina.md', 'conocimiento/decisiones.md', 'conocimiento/agentes/betty.md', 'conocimiento/contexto-maestro.md']) {
      expect(copiados.has(c), c).toBe(true)
    }
    // el resto de los agentes tiene sus notas de plantilla
    expect(leerTexto(carpeta + '/conocimiento/agentes/marce.md').includes('# Marce: notas de trabajo')).toBe(true)
    // los originales siguen donde estaban
    expect(leerTexto(sb.proyecto + '/_betty/estado-actual.md')).toBe('ESTADO REAL')
    expect(leerTexto(sb.proyecto + '/_equipo/decisiones.md')).toBe('DECISIONES REALES')
    expect(leerTexto(sb.home + '/.claude/betty/contexto-maestro.md')).toBe('MAESTRO DEL HOME')
  })

  test('idempotente: la segunda vez dice yaExistia y no toca nada, ni siquiera lo que el usuario editó', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const a = await importar(b)
    const carpeta = str(a.obj.carpeta)
    escribir('EDITADO POR EL USUARIO', carpeta + '/conocimiento/oficina.md')
    escribir('MARCE EDITADA', carpeta + '/.claude/agents/marce.md')
    const oficinaAntes = leerTexto(carpeta + '/oficina.json')
    // en el medio se abre otra oficina: importar de nuevo la vuelve a activar
    await llamar(b, 'POST', '/api/oficinas', { body: { nombre: 'Otra' } })
    expect((await llamar(b, 'GET', '/api/oficina')).obj.carpeta).not.toBe(carpeta)
    const c = await importar(b)
    expect(c.status).toBe(200)
    expect(c.obj.yaExistia).toBe(true)
    expect(c.obj.carpeta).toBe(carpeta)
    expect(c.obj.agentesImportados).toEqual(ids)
    expect(c.obj.copiados).toEqual([])
    expect(c.obj.faltantes).toEqual([])
    expect(leerTexto(carpeta + '/oficina.json')).toBe(oficinaAntes)
    expect(leerTexto(carpeta + '/conocimiento/oficina.md')).toBe('EDITADO POR EL USUARIO')
    expect(leerTexto(carpeta + '/.claude/agents/marce.md')).toBe('MARCE EDITADA')
    expect((await llamar(b, 'GET', '/api/oficina')).obj.carpeta).toBe(carpeta)
    expect(listar(sb.oficinasDir).map((n) => n.normalize('NFC'))).toEqual(['Otra', 'Próspera HQ'])
    // sin cuerpo también (el origen es opcional)
    expect((await importar(b, null)).obj.yaExistia).toBe(true)
  })

  test('origen sin todos los agentes: importa los que hay y lista los faltantes', async () => {
    const sb = new Sandbox()
    const origen = sb.root + '/origen'
    for (const id of ['betty', 'marce']) {
      escribir(`---\nname: ${id}\nmodel: opus\n---\nSos ${id}.`, `${origen}/agentes/${id}.md`)
    }
    const b = await sb.backend({ oficina: false })
    const r = await importar(b, origen)
    expect(r.status).toBe(200)
    expect(r.obj.agentesImportados).toEqual(['betty', 'marce'])
    const quitar = new Set(['betty', 'marce'])
    expect(new Set((r.obj.faltantes as string[] | undefined) ?? [])).toEqual(new Set(ids.filter((i) => !quitar.has(i))))
    const ags = lista(dict(r.obj.oficina).agentes)
    expect(ags.map((a) => str(a.modelo))).toEqual(['opus', 'opus'])  // el modelo sale del frontmatter
    // el departamento de los agentes que faltan igual existe (los 5 departamentos se crean siempre)
    expect(lista(dict(r.obj.oficina).departamentos).length).toBe(5)
  })

  test('origen: carpeta inexistente 404; sin agentes en ningún lado 404; sin origen busca en ~/.claude/agents del HOME temporal', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const no = await importar(b, sb.root + '/no-existe')
    expect(no.status).toBe(404)
    expect(str(no.obj.error).includes('origen')).toBe(true)
    const vacio = sb.root + '/vacio'
    fs.mkdirSync(vacio, { recursive: true })
    const sin = await importar(b, vacio)
    expect(sin.status).toBe(404)
    expect(str(sin.obj.error).includes('agentes/*.md')).toBe(true)
    expect((await importar(b, null)).status).toBe(404)  // HOME temporal: nada que importar
    expect(listar(sb.oficinasDir)).toEqual([])           // y no quedó una oficina a medias
    expect((await llamar(b, 'GET', '/api/oficinas')).obj.activa).toBeNull()
    // ahora con 3 agentes en ~/.claude/agents
    for (const id of ['betty', 'nicolas', 'sofia']) escribir(`---\nname: ${id}\n---\nSos ${id}.`, `${sb.home}/.claude/agents/${id}.md`)
    const r = await importar(b, null)
    expect(r.status).toBe(200)
    expect(r.obj.agentesImportados).toEqual(['betty', 'sofia', 'nicolas'])
    expect((r.obj.faltantes as string[] | undefined)?.length).toBe(5)
  })

  test('el chat de Betty importada puede escribir oficina.md y decisiones.md además de sus notas', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    const r = await importar(b)
    const carpeta = str(r.obj.carpeta)
    expect((await chat(b, { agent: 'betty', session: U.a })).status).toBe(200)
    // NFC: Swift compara cadenas por equivalencia canónica (el nombre de carpeta puede venir en NFD)
    const reglas = Sandbox.reglas(sb.llamadas.at(-1)!).map((x) => x.normalize('NFC'))
    const nfc = carpeta.normalize('NFC')
    for (const rel of ['conocimiento/oficina.md', 'conocimiento/decisiones.md', 'conocimiento/agentes/betty.md']) {
      expect(reglas.includes(`Edit(/${nfc}/${rel})`), `falta ${rel}: ${reglas}`).toBe(true)
    }
    expect(sinPrivate(sb.cwds.at(-1)!).normalize('NFC')).toBe(sinPrivate(carpeta).normalize('NFC'))
    // otro agente: solo lo suyo
    expect((await chat(b, { agent: 'marce', session: U.b })).status).toBe(200)
    const rm = Sandbox.reglas(sb.llamadas.at(-1)!)
    expect(rm.some((x) => x.includes('decisiones.md') || x.includes('oficina.md'))).toBe(false)
  })

  // interno: sembraba un chat viejo con store.asegurarSesion/agregar (oficina vacía) y comprobaba store.oficinaDe tras importar
  test.skip('chats anteriores a las oficinas: se asignan a Próspera HQ al importarla (y no a otras oficinas)', () => {})

  // interno: sembraba un chat viejo con store.asegurarSesion/agregar y comprobaba store.oficinaDe tras abrir/importar
  test.skip('abrir una carpeta con la marca .importada-prospera también reclama los chats anteriores; una oficina común no', () => {})
})
