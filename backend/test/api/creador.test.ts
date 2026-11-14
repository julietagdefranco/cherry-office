// Port de app/Tests/BackendTests/CreadorTests.swift.
// El Creador (plan §6 y §11): herramientas `proponer_*`, anti-invento, faltantes, aplicar y el chat de fondo.
// Todo con el claude falso (CREADOR_LLAMAR); nunca el real.
//
// Swift llamaba a las herramientas MCP en proceso (`MCPHerramientas.llamar`, con un token emitido a mano). Por HTTP el
// «banco» las llama como lo hace el Creador de verdad: un mensaje de chat con CREADOR_LLAMAR hace que el claude falso
// invoque la herramienta contra el servidor MCP con el token del chat (`sb.llamadasCreador` + `sb.salidasCreador`).
// El texto de la persona (de donde salen las citas) va en ese mismo mensaje.
// Sin acceso a internals: store.tarjetas/tarjetaGuardar, VersionCreador, CatalogoConectores, `oficinas.modificar`,
// `mcp.tokens`, `Plantillas.creadorMD` y `MCPHerramientas.definiciones` quedan como `// interno` (o test.skip).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, U, chat, dict, esperar, lista, llamar, sinPrivate, str, type Obj } from '../support/sandbox.js'

/** Lo que dijo la persona en la sesión: de acá salen las citas (`origen`). */
const texto = 'Quiero un departamento de Ventas. Hay una Analista que mira los números. La regla es no inventar datos. '
  + 'Cada lunes a las 08:00 arma la agenda. Cada mes revisa las métricas.'

/** Creador.nombresMCP (10 herramientas, en el orden de la tabla de §6). */
const nombresMCP = ['ver_oficina', 'listar_conectores', 'proponer_departamento', 'proponer_agente', 'proponer_flujo', 'proponer_regla',
  'proponer_conector', 'proponer_tarea', 'marcar_faltante', 'descartar_tarjeta'].map((n) => `mcp__hq__${n}`)

type Res = { texto: string; error: boolean }
type Prop = { t: Obj; error: boolean; texto: string }

class Banco {
  constructor(readonly f: Fix, readonly sid: string = U.a) {}

  /** Hace las llamadas (en un solo mensaje del chat del Creador) y devuelve sus resultados, en orden. */
  async llamarVarias(llamadas: Obj[]): Promise<Res[]> {
    const antes = this.f.sb.salidasCreador.length
    this.f.sb.llamadasCreador(llamadas)
    // un mensaje a la vez: el chat da 409 mientras el anterior corre
    expect(await esperar(async () => (await this.f.get('/api/creador/estado', { session: this.sid })).obj.corriendo !== true, 20)).toBe(true)
    const r = await this.f.post('/api/creador/chat', { message: `CREADOR_LLAMAR ${texto}`, session: this.sid })
    expect(r.status, JSON.stringify(r.obj)).toBe(202)
    expect(await esperar(() => this.f.sb.salidasCreador.length >= antes + llamadas.length, 30)).toBe(true)
    expect(await esperar(async () => (await this.f.get('/api/creador/estado', { session: this.sid })).obj.corriendo === false, 20)).toBe(true)
    return this.f.sb.salidasCreador.slice(antes, antes + llamadas.length).map((o) => {
      const res = dict(o.result)
      if (o.result === undefined) return { texto: '(no existe)', error: true }
      const c = lista(res.content)[0]
      return { texto: str(c?.text), error: res.isError === true }
    })
  }

  async llamar(nombre: string, args: Obj = {}): Promise<Res> { return (await this.llamarVarias([{ name: nombre, arguments: args }]))[0]! }

  tarjeta(r: Res): Obj { try { return dict(JSON.parse(r.texto)) } catch { return {} } }

  /** Propone y devuelve (tarjeta, error). */
  async proponer(tipo: string, accion: string, { origen, datos = {}, ref, objetivo }: { origen: string; datos?: Obj; ref?: string; objetivo?: string }): Promise<Prop> {
    const a: Obj = { accion, origen, datos }
    if (ref !== undefined) a.ref = ref
    if (objetivo !== undefined) a.objetivo = objetivo
    const r = await this.llamar(`proponer_${tipo}`, a)
    return { t: this.tarjeta(r), error: r.error, texto: r.texto }
  }
  crear(tipo: string, origen: string, datos: Obj = {}, ref?: string) { return this.proponer(tipo, 'crear', { origen, datos, ref }) }

  pregunta(t: Obj): string { return str(lista(t.faltantes)[0]?.pregunta) }
  faltantes(t: Obj): string[] { return lista(t.faltantes).map((x) => str(x.campo)) }
  /** Tarjetas de la API del borrador (no trae las descartadas). */
  async tarjetas(): Promise<Obj[]> { return lista((await this.f.get('/api/creador/borrador')).obj.tarjetas) }
  async version(): Promise<number> { return (await this.f.get('/api/creador/borrador')).obj.version as number }
}

async function banco(agentes: { id: string; depto: string; rol?: string }[] = []): Promise<Banco> {
  const f = await Fix.crear({ nombre: 'Taller', duenio: 'Ana', deps: ['Dirección', 'Redes'], agentes })
  return new Banco(f)
}

const agenteDatos = (): Obj => ({ nombre: 'Valeria', rol: 'Analista', departamento: 'redes', prompt: 'Sos Valeria, analista de números.' })
const ANALISTA = 'Hay una Analista que mira los números'
const AGENDA = 'Cada lunes a las 08:00 arma la agenda'
const VENTAS = 'Quiero un departamento de Ventas'

describe('El Creador', () => {
  // MARK: herramientas

  test.skip('las 10 herramientas, con prefijo mcp__hq__ y su esquema', () => {
    // interno (unit test del port): MCPHerramientas.definiciones (lo que devuelve tools/list del servidor MCP) →
    //   names con prefijo «mcp__hq__» == Creador.nombresMCP (10: ver_oficina, listar_conectores, proponer_{departamento,agente,flujo,regla,conector,tarea}, marcar_faltante, descartar_tarjeta);
    //   cada inputSchema.type == "object"; proponer_agente.inputSchema.required == ["accion","origen"].
  })

  test('un origen inventado da isError y no guarda nada', async () => {
    const b = await banco()
    const r = await b.crear('departamento', 'Quiero un departamento de Piratas', { nombre: 'Piratas' })
    expect(r.error).toBe(true)
    expect(r.texto).toContain('Citá textual')
    expect(await b.tarjetas()).toEqual([])
    // sin origen
    const r2 = await b.llamar('proponer_departamento', { accion: 'crear', datos: { nombre: 'X' } })
    expect(r2.error).toBe(true)
    // la cita vale con otras mayúsculas, acentos, comillas y blancos
    const ok = await b.crear('departamento', '«quiero  un DEPARTAMENTO de ventas»', { nombre: 'Ventas' })
    expect(ok.error).toBe(false)
  })

  test('un agente sin prompt queda en borrador con su pregunta', async () => {
    const b = await banco()
    const d = agenteDatos(); delete d.prompt
    const r = await b.crear('agente', ANALISTA, d)
    expect(r.error).toBe(false)
    expect(str(r.t.estado)).toBe('borrador')
    expect(b.faltantes(r.t)).toEqual(['prompt'])
    expect(b.pregunta(r.t)).not.toBe('')
    expect(str(r.t.id)).toBe('t1')
    expect(str(r.t.tipo)).toBe('agente')
    expect(str(r.t.accion)).toBe('crear')
    const completo = await b.crear('agente', ANALISTA, agenteDatos())
    expect(str(completo.t.estado)).toBe('lista')
    expect(b.faltantes(completo.t)).toEqual([])
  })

  test('tarjeta:t1 resuelve; una referencia que no existe es un faltante', async () => {
    const b = await banco()
    const dep = await b.crear('departamento', VENTAS, { nombre: 'Ventas' })
    expect(str(dep.t.id)).toBe('t1')
    expect(str(dep.t.estado)).toBe('lista')
    const d = agenteDatos(); d.departamento = 'tarjeta:t1'
    const ok = await b.crear('agente', ANALISTA, d)
    expect(str(ok.t.estado), ok.texto).toBe('lista')
    d.departamento = 'tarjeta:t9'
    const mal = await b.crear('agente', ANALISTA, d)
    expect(str(mal.t.estado)).toBe('borrador')
    expect(b.faltantes(mal.t)).toEqual(['departamento'])
    d.departamento = 'no-existe'
    const mal2 = await b.crear('agente', ANALISTA, d)
    expect(b.faltantes(mal2.t)).toEqual(['departamento'])
    // el tipo tiene que ser el correcto: t2 es un agente, no un departamento
    d.departamento = 'tarjeta:t2'
    const mal3 = await b.crear('agente', ANALISTA, d)
    expect(b.faltantes(mal3.t)).toEqual(['departamento'])
    // un departamento descartado ya no vale
    await b.llamar('descartar_tarjeta', { id: 't1' })
    d.departamento = 'tarjeta:t1'
    const mal4 = await b.crear('agente', ANALISTA, d)
    expect(b.faltantes(mal4.t)).toEqual(['departamento'])
    // uno de la oficina sí
    d.departamento = 'redes'
    expect(str((await b.crear('agente', ANALISTA, d)).t.estado)).toBe('lista')
  })

  test('un paso sin aprobacion queda en borrador; con todo explícito, lista', async () => {
    const b = await banco([{ id: 'val', depto: 'redes', rol: 'Analista' }])
    const paso1: Obj = { nombre: 'Armar', quien: 'val', entrega: 'La agenda', aprobacion: true }
    const sin: Obj = { nombre: 'Grabar', quien: 'persona', entrega: 'El video' }
    const r = await b.crear('flujo', AGENDA, { nombre: 'Semana', pasos: [paso1, sin] })
    expect(r.error, r.texto).toBe(false)
    expect(str(r.t.estado)).toBe('borrador')
    expect(b.faltantes(r.t)).toEqual(['pasos[1].aprobacion'])
    const con = { ...sin, aprobacion: false }
    const ok = await b.crear('flujo', AGENDA, { nombre: 'Semana', pasos: [paso1, con] }, str(r.t.id))
    expect(str(ok.t.estado), ok.texto).toBe('lista')
    expect(str(ok.t.id)).toBe(str(r.t.id))
    // un valor que no es booleano es un error de formato
    const mal = { ...sin, aprobacion: 'si' }
    expect((await b.crear('flujo', AGENDA, { nombre: 'X', pasos: [mal] })).error).toBe(true)
    // quien que no existe: faltante
    const raro = { ...con, quien: 'fantasma' }
    const q = await b.crear('flujo', AGENDA, { nombre: 'Y', pasos: [raro] })
    expect(b.faltantes(q.t)).toEqual(['pasos[0].quien'])
    // recibeDe hacia un paso que no es anterior: error de formato
    const adelante = { ...con, recibeDe: ['no-hay'] }
    expect((await b.crear('flujo', AGENDA, { nombre: 'Z', pasos: [adelante] })).error).toBe(true)
  })

  test.skip('un conector no disponible queda en borrador con «Conectá X en claude.ai»', () => {
    // interno (unit test del port): fija el catálogo global `CatalogoConectores.compartido.fijar([...])`, que no se puede tocar por HTTP:
    //   [Google Calendar (prefijo mcp__claude_ai_Google_Calendar, connected, herramientas [mcp__claude_ai_Google_Calendar__list_events]), Notion (mcp__claude_ai_Notion, needs-auth)]
    //   banco con agente val (redes, Analista); proponer_conector con origen «Hay una Analista que mira los números»:
    //   · {agente val, servidor «Google Calendar», leer [mcp__claude_ai_Google_Calendar__list_events]} → estado «lista»
    //   · {servidor «Notion», leer [mcp__claude_ai_Notion__search]} → «borrador» y la pregunta contiene «Conectá Notion en claude.ai»
    //   · {servidor «Instagram», leer [mcp__claude_ai_Instagram__feed]} → «borrador», pregunta contiene «Conectá Instagram en claude.ai»
    //   · {servidor «Google Calendar», leer [«list_events»]} (herramienta mal escrita) → isError
    //   · sin catálogo detectado (limpiar()): Google Calendar con su herramienta → «borrador» (no se puede dar por disponible)
  })

  test('una tarea semanal queda lista; mensual, en borrador con su pregunta; formato malo, isError', async () => {
    const b = await banco([{ id: 'val', depto: 'redes', rol: 'Analista' }])
    const semanal = await b.crear('tarea', AGENDA, { agente: 'val', nombre: 'Agenda', consigna: 'Armá la agenda', dias: [1], hora: '08:00' })
    expect(str(semanal.t.estado), semanal.texto).toBe('lista')
    const mensual = await b.crear('tarea', 'Cada mes revisa las métricas', { agente: 'val', nombre: 'Métricas', consigna: 'Revisá las métricas', hora: '09:00', periodicidad: 'mensual' })
    expect(str(mensual.t.estado)).toBe('borrador')
    expect(b.faltantes(mensual.t)).toContain('periodicidad')
    const horaMala = await b.crear('tarea', AGENDA, { agente: 'val', nombre: 'A', consigna: 'B', dias: [1], hora: '8' })
    expect(horaMala.error).toBe(true)
    const diasMalos = await b.crear('tarea', AGENDA, { agente: 'val', nombre: 'A', consigna: 'B', dias: [9], hora: '08:00' })
    expect(diasMalos.error).toBe(true)
  })

  test('ref actualiza la tarjeta en vez de duplicar; un null borra un campo', async () => {
    const b = await banco()
    const d = agenteDatos(); delete d.prompt
    const a = await b.crear('agente', ANALISTA, d)
    const b2 = await b.crear('agente', ANALISTA, { prompt: 'Sos Valeria.' }, str(a.t.id))
    expect(str(b2.t.id)).toBe(str(a.t.id))
    expect(str(b2.t.estado)).toBe('lista')
    expect(dict(b2.t.datos).nombre).toBe('Valeria') // lo anterior se conserva
    expect((await b.tarjetas()).length).toBe(1)
    // otro tipo con ese ref: error
    expect((await b.crear('regla', 'La regla es no inventar datos', { texto: 'No inventes.' }, str(a.t.id))).error).toBe(true)
    // ref que no existe
    expect((await b.crear('agente', ANALISTA, d, 't99')).error).toBe(true)
    const n = await b.crear('agente', ANALISTA, { prompt: null }, str(a.t.id))
    expect(str(n.t.estado)).toBe('borrador')
  })

  test('marcar_faltante deja la tarjeta en borrador y descartar_tarjeta la saca', async () => {
    const b = await banco()
    const dep = await b.crear('departamento', VENTAS, { nombre: 'Ventas' })
    expect(str(dep.t.estado)).toBe('lista')
    const m = b.tarjeta(await b.llamar('marcar_faltante', { ref: str(dep.t.id), campo: 'mision', pregunta: '¿Para qué existe?' }))
    expect(str(m.estado)).toBe('borrador')
    expect(b.faltantes(m)).toEqual(['mision'])
    // si se completa el campo, el faltante manual se va
    const c = await b.crear('departamento', VENTAS, { mision: 'Vender más.' }, str(dep.t.id))
    expect(str(c.t.estado)).toBe('lista')
    expect((await b.llamar('marcar_faltante', { ref: 't99', campo: 'x', pregunta: 'y' })).error).toBe(true)

    const d = b.tarjeta(await b.llamar('descartar_tarjeta', { id: str(dep.t.id) }))
    expect(str(d.estado)).toBe('descartada')
    const api = await b.f.get('/api/creador/borrador')
    expect(lista(api.obj.tarjetas)).toEqual([])
    expect((await b.llamar('descartar_tarjeta', { id: 't99' })).error).toBe(true)
  })

  test('VersionCreador sube con cada cambio', async () => {
    const b = await banco()
    // interno (unit test del port): Swift leía `VersionCreador.compartida.valor(carpeta)` llamando a las herramientas en proceso.
    // Por HTTP cada llamada es un mensaje de chat, y el mensaje mismo sube la versión (se ve en /api/creador/borrador y /api/actividad):
    // se mide cuánto sube un mensaje sin llamadas (`base`) y se compara con el de los mensajes con la llamada.
    let v = await b.version()
    await b.llamarVarias([])
    const base = (await b.version()) - v
    expect(base).toBeGreaterThanOrEqual(0)
    v = await b.version()
    const r = await b.crear('departamento', VENTAS, { nombre: 'Ventas' })
    const v1 = await b.version()
    expect(v1 - v).toBeGreaterThan(base)
    await b.llamar('descartar_tarjeta', { id: str(r.t.id) })
    const v2 = await b.version()
    expect(v2 - v1).toBeGreaterThan(base)
    // un intento que falla no la sube (más allá de lo que sube el mensaje)
    await b.crear('departamento', 'inventado', { nombre: 'X' })
    const v3 = await b.version()
    expect(v3 - v2).toBe(base)
    const act = await b.f.get('/api/actividad')
    expect(act.obj.creadorVersion).toBe(v3)
  })

  test('el cupo de escrituras por mensaje es de 80', async () => {
    const b = await banco()
    const max = 80 // Creador.maxEscrituras
    // las 81 llamadas van en un solo mensaje (el cupo es por mensaje de la persona)
    const rs = await b.llamarVarias([
      ...Array.from({ length: max + 1 }, () => ({ name: 'descartar_tarjeta', arguments: { id: 't1' } })),
      { name: 'ver_oficina', arguments: {} },
    ])
    const r = rs[max]!
    expect(r.error).toBe(true)
    expect(r.texto).toContain(String(max))
    // leer no gasta cupo
    expect(rs[max + 1]!.error).toBe(false)
  })

  test('modificar y quitar piden un objetivo que exista', async () => {
    const b = await banco([{ id: 'val', depto: 'redes', rol: 'Analista' }])
    expect((await b.proponer('agente', 'modificar', { origen: ANALISTA, datos: { rol: 'Jefa' } })).error).toBe(true)
    expect((await b.proponer('agente', 'modificar', { origen: ANALISTA, datos: { rol: 'Jefa' }, objetivo: 'nadie' })).error).toBe(true)
    const ok = await b.proponer('agente', 'modificar', { origen: ANALISTA, datos: { rol: 'Jefa' }, objetivo: 'val' })
    expect(str(ok.t.estado), ok.texto).toBe('lista')
    expect(str(ok.t.objetivo)).toBe('val')
  })

  test('ver_oficina y listar_conectores', async () => {
    const b = await banco([{ id: 'val', depto: 'redes', rol: 'Analista' }])
    await b.crear('departamento', VENTAS, { nombre: 'Ventas' })
    const v = b.tarjeta(await b.llamar('ver_oficina'))
    expect(lista(v.agentes).map((a) => str(a.id))).toEqual(['val'])
    expect(lista(v.departamentos).map((d) => str(d.id))).toEqual(['direccion', 'redes'])
    expect(lista(v.tarjetas).map((t) => str(t.id))).toEqual(['t1'])
    const sin = b.tarjeta(await b.llamar('listar_conectores'))
    expect(sin.detectado).toBe(false)
    expect(str(sin.nota)).not.toBe('')
    // interno (unit test del port): con `CatalogoConectores.compartido.fijar([Gmail (mcp__claude_ai_Gmail, connected, [mcp__claude_ai_Gmail__search_threads])])`
    //   listar_conectores devuelve servidores.map(nombre) == ["Gmail"] (el catálogo global no se puede fijar por HTTP).
  })

  // MARK: aplicar

  /** oficina.json en disco (Swift: `OficinaStore.leer`, que además valida). */
  const leerOficina = (f: Fix): Obj => f.oficinaJSON()
  const agenteDe = (o: Obj, id: string): Obj | undefined => lista(o.agentes).find((a) => str(a.id) === id)
  const deptoDe = (o: Obj, id: string): Obj | undefined => lista(o.departamentos).find((d) => str(d.id) === id)

  test('aplicar: departamento + agente con tarjeta:x + regla + flujo con persona + tarea dejan un oficina.json válido', async () => {
    const b = await banco()
    const dep = await b.crear('departamento', VENTAS, { nombre: 'Ventas', mision: 'Vender.' })
    const d = agenteDatos(); d.departamento = 'tarjeta:' + str(dep.t.id); d.id = 'valeria'
    d.limites = { proponer: ['Cambiar precios'] }; d.permisos = ['coordinador']
    const ag = await b.crear('agente', ANALISTA, d)
    const regla = await b.crear('regla', 'La regla es no inventar datos', { texto: 'No inventes datos.' })
    const paso1: Obj = { nombre: 'Armar', quien: 'tarjeta:' + str(ag.t.id), entrega: 'La agenda', aprobacion: true }
    const paso2: Obj = { nombre: 'Revisar', quien: 'persona', entrega: 'El visto bueno', aprobacion: false }
    const flujo = await b.crear('flujo', AGENDA, { nombre: 'Agenda semanal', pasos: [paso1, paso2] })
    const tarea = await b.crear('tarea', AGENDA, { agente: 'tarjeta:' + str(ag.t.id), nombre: 'Agenda', consigna: 'Armá la agenda', dias: [1], hora: '08:00' })
    for (const t of [dep, ag, regla, flujo, tarea]) expect(str(t.t.estado), t.texto).toBe('lista')

    // en el orden «al revés» a propósito: aplicar los ordena por tipo
    const ids = [str(tarea.t.id), str(flujo.t.id), str(regla.t.id), str(ag.t.id), str(dep.t.id)]
    const r = await b.f.post('/api/creador/aplicar', { ids })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const res = lista(r.obj.resultados)
    expect(res.map((x) => str(x.id))).toEqual(ids)
    expect(res.every((x) => x.ok === true), JSON.stringify(res)).toBe(true)
    expect(str(res.at(-1)?.creadaId)).toBe('ventas')
    expect(str(res[3]!.creadaId)).toBe('valeria')

    const o = leerOficina(b.f)
    expect(deptoDe(o, 'ventas')?.mision).toBe('Vender.')
    expect(agenteDe(o, 'valeria')?.departamento).toBe('ventas')
    expect(agenteDe(o, 'valeria')?.permisos).toContain('coordinador')
    expect(dict(agenteDe(o, 'valeria')?.limites).proponer).toEqual(['Cambiar precios'])
    expect(lista(o.reglas).map((x) => str(x.texto))).toEqual(['No inventes datos.'])
    expect(str(lista(o.reglas)[0]?.origen)).toBe('La regla es no inventar datos')
    const fl = lista(o.flujos)[0]!
    expect(fl).toBeDefined()
    expect(lista(fl.pasos).map((p) => str(p.quien))).toEqual(['valeria', 'persona'])
    expect(lista(fl.pasos).map((p) => p.aprobacion)).toEqual([true, false])
    const ta = lista(o.tareas)[0]
    expect(str(ta?.agente)).toBe('valeria')
    expect(ta?.dias).toEqual([1])
    expect(str(ta?.hora)).toBe('08:00')
    expect(b.f.existe('.claude/agents/valeria.md')).toBe(true)
    expect(str(dict(r.obj.oficina).nombre)).toBe('Taller')

    // las tarjetas quedan creadas, con su creadaId
    const creadas = await b.tarjetas()
    expect(creadas.every((t) => str(t.estado) === 'creada' && t.creadaId !== null && t.creadaId !== undefined)).toBe(true)
    expect(str(creadas.find((t) => str(t.tipo) === 'agente')?.creadaId)).toBe('valeria')
    // aplicar de nuevo no duplica nada
    const otra = await b.f.post('/api/creador/aplicar', { ids })
    expect(lista(otra.obj.resultados).every((x) => x.ok === true)).toBe(true)
    expect(lista(leerOficina(b.f).agentes).length).toBe(1)
  })

  test('aplicar: una tarjeta en borrador da 409 con sus faltantes y no aplica nada', async () => {
    const b = await banco()
    const ok = await b.crear('departamento', VENTAS, { nombre: 'Ventas' })
    const d = agenteDatos(); delete d.prompt
    const mal = await b.crear('agente', ANALISTA, d)
    const r = await b.f.post('/api/creador/aplicar', { ids: [str(ok.t.id), str(mal.t.id)] })
    expect(r.status).toBe(409)
    const faltan = lista(r.obj.borradores)
    expect(faltan.map((x) => str(x.id))).toEqual([str(mal.t.id)])
    expect(lista(faltan[0]?.faltantes).map((x) => str(x.campo))).toEqual(['prompt'])
    expect(deptoDe(leerOficina(b.f), 'ventas')).toBeUndefined()
    expect((await b.tarjetas()).every((t) => str(t.estado) !== 'creada')).toBe(true)
    // sin ids: aplica todas las listas; el borrador sigue en 409 solo si se lo nombra
    const sinIds = await b.f.post('/api/creador/aplicar', {})
    expect(sinIds.status).toBe(200)
    expect(deptoDe(leerOficina(b.f), 'ventas')).toBeDefined()
    expect((await b.f.post('/api/creador/aplicar', { ids: ['t99'] })).status).toBe(404)
  })

  test.skip('aplicar: una tarjeta que falla queda en error y las demás siguen; una que depende de ella también falla', () => {
    // interno (unit test del port): fuerza el fallo editando la tabla con store.tarjeta/tarjetaGuardar (no hay API que deje una tarjeta «lista» inválida).
    //   banco con agente val (redes); tarjetas listas: departamento «Ventas», regla «No inventes datos.», agente (datos de Valeria con departamento «redes») y tarea
    //   (agente «tarjeta:<id del agente>», «Agenda», consigna «Armá», dias [1], 08:00). Luego a la tarjeta del agente se le pone datos.departamento = "ya-no-existe" directo en el store.
    //   POST /api/creador/aplicar {ids: [dep, regla, agente, tarea]} → 200; resultados ok == [true, true, false, false]; resultados[2].error no vacío;
    //   resultados[3].error contiene el id de la tarjeta del agente; tarjeta del agente: estado «error» con error != nil; la del departamento: «creada»;
    //   oficina: departamento «ventas» existe, reglas.count == 1 y no existe agente «valeria».
  })

  test('quitar sin confirmación da error; con confirmarQuitar despide al agente', async () => {
    const b = await banco([{ id: 'val', depto: 'redes', rol: 'Analista' }, { id: 'otro', depto: 'redes', rol: 'Otro' }])
    const q = await b.proponer('agente', 'quitar', { origen: ANALISTA, objetivo: 'val' })
    expect(str(q.t.estado), q.texto).toBe('lista')
    const sin = await b.f.post('/api/creador/aplicar', { ids: [str(q.t.id)] })
    const r0 = lista(sin.obj.resultados)[0]!
    expect(r0.ok).toBe(false)
    expect(str(r0.error)).toContain('confirm')
    expect(agenteDe(leerOficina(b.f), 'val')).toBeDefined()
    const con = await b.f.post('/api/creador/aplicar', { ids: [str(q.t.id)], confirmarQuitar: true })
    expect(lista(con.obj.resultados)[0]?.ok, JSON.stringify(con.obj)).toBe(true)
    const o = leerOficina(b.f)
    expect(agenteDe(o, 'val')).toBeUndefined()
    expect(agenteDe(o, 'otro')).toBeDefined()
    expect(str((await b.tarjetas())[0]?.estado)).toBe('creada')
  })

  test('modificar cambia lo que existe: departamento, agente, regla, flujo y tarea', async () => {
    const b = await banco([{ id: 'val', depto: 'redes', rol: 'Analista' }])
    // algo para modificar (Swift: `oficinas.modificar`; aquí se escribe oficina.json directo, el servidor lo lee de disco)
    const base = b.f.oficinaJSON()
    base.reglas = [{ id: 'r1', texto: 'Vieja.' }]
    base.flujos = [{ id: 'f1', nombre: 'Viejo', pasos: [{ id: 'p1', nombre: 'Uno', quien: 'val', entrega: 'Algo' }] }]
    base.tareas = [{ id: 'ta', agente: 'val', nombre: 'Vieja', consigna: 'Hacé', dias: [2], hora: '10:00' }]
    fs.writeFileSync(path.join(b.f.carpeta, 'oficina.json'), JSON.stringify(base, null, 2))
    const t1 = await b.proponer('departamento', 'modificar', { origen: VENTAS, datos: { mision: 'Nueva misión.' }, objetivo: 'redes' })
    const t2 = await b.proponer('agente', 'modificar', { origen: ANALISTA, datos: { rol: 'Jefa de datos' }, objetivo: 'val' })
    const t3 = await b.proponer('regla', 'modificar', { origen: 'La regla es no inventar datos', datos: { texto: 'Nueva.' }, objetivo: 'r1' })
    const t4 = await b.proponer('flujo', 'modificar', { origen: AGENDA, datos: { nombre: 'Nuevo', pasos: [{ nombre: 'Uno', quien: 'val', entrega: 'Algo', aprobacion: true }] }, objetivo: 'f1' })
    const t5 = await b.proponer('tarea', 'modificar', { origen: AGENDA, datos: { hora: '07:30', dias: [1, 3] }, objetivo: 'ta' })
    for (const t of [t1, t2, t3, t4, t5]) expect(str(t.t.estado), t.texto).toBe('lista')
    const r = await b.f.post('/api/creador/aplicar', {})
    expect(lista(r.obj.resultados).every((x) => x.ok === true), JSON.stringify(r.obj)).toBe(true)
    const o = leerOficina(b.f)
    expect(deptoDe(o, 'redes')?.mision).toBe('Nueva misión.')
    expect(agenteDe(o, 'val')?.rol).toBe('Jefa de datos')
    expect(str(lista(o.reglas)[0]?.texto)).toBe('Nueva.')
    expect(str(lista(o.flujos)[0]?.nombre)).toBe('Nuevo')
    expect(lista(lista(o.flujos)[0]?.pasos)[0]?.aprobacion).toBe(true)
    expect(str(lista(o.tareas)[0]?.hora)).toBe('07:30')
    expect(lista(o.tareas)[0]?.dias).toEqual([1, 3])
  })

  test('PATCH revalida sin pedir la cita; DELETE descarta; creada no se toca', async () => {
    const b = await banco()
    const d = agenteDatos(); delete d.prompt
    const a = await b.crear('agente', ANALISTA, d)
    const id = str(a.t.id)
    const p = await b.f.patch(`/api/creador/tarjetas/${id}`, { datos: { prompt: 'Sos Valeria.' } })
    expect(p.status, JSON.stringify(p.obj)).toBe(200)
    expect(str(dict(p.obj.tarjeta).estado)).toBe('lista')
    expect(str(dict(dict(p.obj.tarjeta).datos).prompt)).toBe('Sos Valeria.')
    const mal = await b.f.patch(`/api/creador/tarjetas/${id}`, { datos: { modelo: 'gpt' } })
    expect(mal.status).toBe(400)
    expect((await b.f.patch('/api/creador/tarjetas/t99', { datos: {} })).status).toBe(404)
    expect((await b.f.patch(`/api/creador/tarjetas/${id}`, { otra: 1 })).status).toBe(400)
    const bor = await b.f.get('/api/creador/borrador')
    expect(bor.status).toBe(200)
    expect(lista(bor.obj.tarjetas).length).toBe(1)
    expect(dict(bor.obj.resumen).lista).toBe(1)
    // interno (unit test del port): bor.version == VersionCreador.compartida.valor(carpeta) (el valor interno de la versión; por HTTP solo se ve el mismo número en la API).
    expect(typeof bor.obj.version).toBe('number')
    const del = await b.f.delete(`/api/creador/tarjetas/${id}`)
    expect(del.status).toBe(200)
    expect(str(dict(del.obj.tarjeta).estado)).toBe('descartada')
    expect(lista((await b.f.get('/api/creador/borrador')).obj.tarjetas)).toEqual([])
    expect((await b.f.delete('/api/creador/tarjetas/t99')).status).toBe(404)
    // una creada no se descarta ni se edita
    const dep = await b.crear('departamento', VENTAS, { nombre: 'Ventas' })
    await b.f.post('/api/creador/aplicar', {})
    expect((await b.f.delete(`/api/creador/tarjetas/${str(dep.t.id)}`)).status).toBe(409)
    expect((await b.f.patch(`/api/creador/tarjetas/${str(dep.t.id)}`, { datos: { nombre: 'X' } })).status).toBe(409)
  })

  test.skip('el prompt del Creador es genérico y pide proponer, citar y preguntar', () => {
    // interno (unit test del port): Plantillas.creadorMD(Oficina(nombre «Taller», duenio «Ana»)) →
    //   empieza con "---\nname: creador\n" y contiene "model: sonnet"; contiene cada una de: «ver_oficina», «marcar_faltante», «tarjeta:<id>», «TEXTUAL», «3 preguntas», «nunca creás»;
    //   no contiene «Betty» ni «Próspera».
  })

  // MARK: chat de fondo

  test('punta a punta: el chat llama a las herramientas, deja dos tarjetas listas y corre con la veda y sin Edit ni Write', async () => {
    const f = await Fix.crear({ nombre: 'Taller', duenio: 'Ana', deps: ['Dirección', 'Redes'] })
    f.sb.llamadasCreador([
      { name: 'proponer_departamento', arguments: { accion: 'crear', origen: 'un departamento de ventas', datos: { nombre: 'Ventas' } } },
      { name: 'proponer_regla', arguments: { accion: 'crear', origen: 'la regla es no inventar', datos: { texto: 'No inventes datos.' } } },
    ])
    const r = await f.post('/api/creador/chat', { message: 'CREADOR_LLAMAR quiero un departamento de ventas y la regla es no inventar', session: U.a })
    expect(r.status, JSON.stringify(r.obj)).toBe(202)
    expect(r.obj.ok).toBe(true)
    expect(str(r.obj.session)).toBe(U.a)
    // el chat no es de otro agente: la sesión es del creador y está en las tablas de mensajes
    const fin = await esperar(async () => {
      const e = await f.get('/api/creador/estado', { session: U.a })
      return e.obj.corriendo === false && lista(e.obj.mensajes).some((m) => str(m.rol) === 'a')
    }, 20)
    expect(fin).toBe(true)
    const e = await f.get('/api/creador/estado', { session: U.a })
    const ms = lista(e.obj.mensajes)
    expect(ms.map((m) => str(m.rol))).toEqual(['u', 'a'])
    expect(str(ms.at(-1)?.texto)).toContain('armé las tarjetas')
    expect(str(ms[0]?.ts)).not.toBe('')
    // interno (unit test del port): e.version == VersionCreador.compartida.valor(carpeta); store.agenteDe(U.a) == "creador"
    //   (la sesión es del agente «creador»: por HTTP se ve en que /api/creador/chat la acepta y en el --agent creador de la llamada de abajo).

    const bor = await f.get('/api/creador/borrador')
    const ts = lista(bor.obj.tarjetas)
    expect(ts.map((t) => str(t.tipo)), `${JSON.stringify(ts)} ${JSON.stringify(f.sb.salidasCreador)}`).toEqual(['departamento', 'regla'])
    expect(ts.every((t) => str(t.estado) === 'lista')).toBe(true)
    expect(dict(bor.obj.resumen).lista).toBe(2)
    expect(f.sb.salidasCreador.length).toBe(2)
    expect(f.sb.salidasCreador.every((o) => dict(o.result).isError === undefined)).toBe(true)

    // el comando: agente creador, solo lectura, veda de conectores y herramientas MCP del Creador
    const llamada = f.sb.llamadas.find((l) => Sandbox.valor(l, '--agent') === 'creador')!
    expect(llamada).toBeDefined()
    const tools = (Sandbox.valor(llamada, '--tools') ?? '').split(',')
    expect(tools.slice(0, 3)).toEqual(['Read', 'Glob', 'Grep'])
    expect(tools).not.toContain('Edit')
    expect(tools).not.toContain('Write')
    for (const n of nombresMCP) expect(tools).toContain(n)
    const reglas = Sandbox.reglas(llamada)
    expect(reglas.some((x) => x.startsWith('Edit') || x.startsWith('Write'))).toBe(false)
    for (const n of nombresMCP) expect(reglas).toContain(n)
    const i = llamada.indexOf('--disallowedTools')
    const veda: string[] = []
    if (i >= 0) for (const x of llamada.slice(i + 1)) { if (x === '--') break; veda.push(x) }
    expect(veda).toContain('mcp__claude_ai_*')
    expect(Sandbox.valor(llamada, '--permission-mode')).toBe('dontAsk')
    expect(f.sb.cwds.some((c) => sinPrivate(c) === sinPrivate(f.carpeta))).toBe(true)
    // el archivo del agente se regeneró
    expect(f.leer('.claude/agents/creador.md')).toContain('name: creador')
    // interno (unit test del port): el token MCP se revocó al terminar (`mcp.tokens.activos == 0`).
    // la actividad vuelve a quedar libre (Swift: `runner.actividad.vista(oficina)["creador"] == nil`; la API la expone en /api/actividad)
    expect(dict((await f.get('/api/actividad')).obj.agentes).creador).toBeUndefined()
  })

  test('una sesión que ya está corriendo da 409; el pedido se valida', async () => {
    const f = await Fix.crear({ nombre: 'Taller', duenio: 'Ana' })
    f.sb.modo('creador', 'puerta')
    const r = await f.post('/api/creador/chat', { message: 'hola', session: U.b })
    expect(r.status).toBe(202)
    expect((await f.post('/api/creador/chat', { message: 'otra vez', session: U.b })).status).toBe(409)
    const e = await f.get('/api/creador/estado', { session: U.b })
    expect(e.obj.corriendo).toBe(true)
    f.sb.abrirPuerta()
    expect(await esperar(async () => (await f.get('/api/creador/estado', { session: U.b })).obj.corriendo === false, 15)).toBe(true)
    // después de terminar se puede seguir en la misma sesión
    expect((await f.post('/api/creador/chat', { message: 'seguimos', session: U.b })).status).toBe(202)
    expect(await esperar(async () => (await f.get('/api/creador/estado', { session: U.b })).obj.corriendo === false, 15)).toBe(true)

    expect((await f.post('/api/creador/chat', { message: 'hola', session: 'no-es-uuid' })).status).toBe(400)
    expect((await f.post('/api/creador/chat', { message: '   ', session: U.c })).status).toBe(400)
    expect((await f.post('/api/creador/chat', { session: U.c })).status).toBe(400)
    expect((await f.get('/api/creador/estado', { session: 'x' })).status).toBe(400)
    // una sesión de un agente común no sirve
    const g = await Fix.crear({ nombre: 'Otra', duenio: 'Ana', agentes: [{ id: 'marce', depto: 'direccion' }] })
    await chat(g.b, { agent: 'marce', message: 'hola', session: U.d })
    expect((await g.post('/api/creador/chat', { message: 'hola', session: U.d })).status).toBe(400)
    // sin oficina, 409
    const sb = new Sandbox()
    const b = await sb.backend({ oficina: false })
    expect((await llamar(b, 'POST', '/api/creador/chat', { body: { message: 'hola', session: U.a } })).status).toBe(409)
    expect((await llamar(b, 'GET', '/api/creador/borrador')).status).toBe(409)
  })
})
