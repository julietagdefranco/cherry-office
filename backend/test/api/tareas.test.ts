// Port de app/Tests/BackendTests/TareasTests.swift.
// Tareas programadas (Fase 5): lógica pura de horarios, validación del modelo, rutas, ejecución y programador.
//
// Sin acceso a internals: la lógica pura (Programacion.*, Validar.oficina, decodificación de Oficina) y todo lo que usa el
// reloj del programador (`programador.revisar()` / `fijarReloj`), los ganchos (`alTerminar`, `avisos.alCrear`) y el store
// directo quedan como `test.skip` con `// interno` para reescribirlos como unit tests del port.
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, esperar, dict, historial, lista, llamar, msgs, sinPrivate, str, type Obj } from '../support/sandbox.js'

const ba = 'America/Argentina/Buenos_Aires'
const ny = 'America/New_York'
const zonaDelSistema = Intl.DateTimeFormat().resolvedOptions().timeZone
// Swift (`TimeZone.current.identifier`) puede dar un alias («America/Buenos_Aires») y Node el nombre canónico: se compara la zona canónica.
const canonica = (z: string) => { try { return Intl.DateTimeFormat('en', { timeZone: z }).resolvedOptions().timeZone } catch { return z } }
const esUUID = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
const fecha = (s: string) => { const t = Date.parse(s); return Number.isNaN(t) ? null : t }

// Tarea de prueba de los tests puros (Swift `tarea(...)`): id «informe», agente marce, nombre «Informe», consigna «Armá el informe»,
// dias [1,2,3,4,5], hora «08:00», zona Buenos Aires, activa; 2026-11-13 es viernes (el 15 domingo, el 16 lunes).

describe('Tareas: lógica pura de horarios', () => {
  test.skip('próxima: horario de su zona, en los días marcados, estrictamente posterior', () => {
    // interno (unit test del port): Programacion.proxima(tarea(), desde:, sistema: UTC) con la tarea de prueba (L-V 08:00 BA):
    //   desde 2026-11-13T07:00-03:00 → 2026-11-13T08:00-03:00
    //   desde 2026-11-13T08:00-03:00 (justo en el horario ya es pasado) → 2026-11-16T08:00-03:00
    //   desde 2026-11-14T09:00-03:00 (sábado salta al lunes: el domingo 7 no está marcado) → 2026-11-16T08:00-03:00
    //   desde 2026-11-13T00:00Z (vista desde UTC sigue siendo las 08:00 de BA) → 2026-11-13T11:00Z
  })

  test.skip('días ISO: 1 = lunes … 7 = domingo', () => {
    // interno (unit test del port): proxima(...) desde 2026-11-13T07:00-03:00 (viernes), hora 08:00, zona BA:
    //   dias [7] → 2026-11-15T08:00-03:00 · dias [1] → 2026-11-16T08:00-03:00 · dias [6,7] → 2026-11-14T08:00-03:00 · dias [] → nil
  })

  test.skip('sin zona usa la del sistema', () => {
    // interno (unit test del port): tarea con zona nil, desde 2026-11-13T00:00Z:
    //   sistema New_York → 2026-11-13T08:00-05:00 · sistema UTC → 2026-11-13T08:00Z
  })

  test.skip('DST (Nueva York): sigue siendo la misma hora de pared al cambiar el horario', () => {
    // interno (unit test del port): tarea todos los días (1..7) 09:00 zona New_York.
    //   primavera: desde 2026-03-07T09:00-05:00 → 2026-03-08T09:00-04:00, y la diferencia es 23*3600 s
    //   otoño: desde 2026-10-31T09:00-04:00 → 2026-11-01T09:00-05:00, y la diferencia es 25*3600 s
  })

  test.skip('DST: una hora que no existe ese día corre una sola vez, corrida hacia adelante', () => {
    // interno (unit test del port): tarea todos los días 02:30 New_York.
    //   proxima desde 2026-03-08T00:00-05:00 → 2026-03-08T03:30-04:00; proxima desde ese instante → 2026-03-09T02:30-04:00
  })

  test.skip('debeCorrer: en su horario, una vez, y solo en días marcados', () => {
    // interno (unit test del port): Programacion.debeCorrer(tarea L-V 08:00 BA, ahora:, ultimaProgramada:, sistema: UTC); vie8 = 2026-11-13T08:00-03:00
    //   ahora 07:59 (ultima nil) → nil · ahora 08:00:10 (nil) → vie8
    //   ahora 08:00:40 con ultima vie8 → nil · ahora 15:00 con ultima vie8 → nil
    //   sábado 2026-11-14T09:00 con ultima vie8 → nil · domingo 2026-11-15T09:00 (nil) → nil (la del viernes pasó hace más de 12 h)
    //   tarea inactiva ahora 2026-11-13T08:00:10-03:00 → nil
  })

  test.skip('puesta al día: una vez si pasaron menos de 12 h; más, no', () => {
    // interno (unit test del port): tarea L-V 08:00 BA; vie8 = 2026-11-13T08:00-03:00, jue8 = 2026-11-12T08:00-03:00
    //   ahora 2026-11-13T19:59-03:00 con ultima jue8 → vie8 (11 h 59 min después)
    //   ahora 20:00 y 20:01 con ultima jue8 → nil (12 h exactas o más se pierde)
    //   cerrada varios días: ahora 2026-11-13T09:00 con ultima mie8 (2026-11-11T08:00-03:00) → vie8 (solo la última)
    //   tarea de las 23:00 todos los días, ahora 2026-11-14T05:00-03:00, ultima nil → 2026-11-13T23:00-03:00
  })

  test.skip('una tarea nueva o movida no se pone al día con un horario anterior a su creación', () => {
    // interno (unit test del port): ahora = 2026-11-13T10:00-03:00, ultima nil, tarea L-V 08:00 BA:
    //   sin creada → 2026-11-13T08:00-03:00
    //   creada "2026-11-13T12:50:00Z" (10:50 BA, después de las 08:00) → nil
    //   creada "2026-11-01T00:00:00Z" con desde "2026-11-13T12:50:00Z" → nil
    //   creada "2026-11-12T00:00:00Z" → no nil
  })

  test.skip('simulación minuto a minuto: una sola corrida por horario (cada 30 s, con DST y todo)', () => {
    // interno (unit test del port): tarea todos los días 09:00; para (BA, 2026-11-13), (NY, 2026-03-08), (NY, 2026-11-01):
    //   cuando arranca en dia T00:00Z - 12 h, avanza de a 30 s durante 3 días llamando debeCorrer(t, ahora: cuando, ultimaProgramada: ultima, sistema: UTC);
    //   cada vez que devuelve p la registra y ultima = p. Esperado: corridas.count es 3 o 4, y todas distintas.
  })

  test.skip('una sola vez: corre una vez cuando llega su fecha y hora, aunque sea tarde; no si está hecha, en pausa o ya corrió', () => {
    // interno (unit test del port): tarea dias [] hora 10:30 zona BA con fecha "2026-11-20" (t.unica == true); i = instanteUnica = 2026-11-20T10:30-03:00 (zona de la tarea)
    //   proxima desde 2026-11-13T09:00-03:00 → i; proxima desde i → nil (después de su hora no hay próxima)
    //   debeCorrer ahora 2026-11-20T10:29-03:00 → nil; ahora 10:30:05 → i; tres días tarde (2026-11-23T10:30) → i
    //   con creada "2026-11-21T00:00:00Z": ahora 2026-11-21T09:00-03:00 → i (se hace enseguida); con ultima i → nil (ya tuvo su corrida)
    //   con hecha "2026-11-20T13:31:00Z": debeCorrer → nil y proxima → nil; con activa false: debeCorrer → nil
    //   Programacion.diaCalendario("2026-02-28") == (2026,2,28); "2028-02-29" válido; inválidos (nil): "2026-02-29","2026-13-01","2026-1-01","26-01-01","2026/01/01","2026-01-32","abcd-ef-gh",""
  })

  test.skip('validación del modelo: hora, días, zona, consigna, id, agente y máximo', () => {
    // interno (unit test del port): Validar.oficina(oficina con depto «d», agente «marce» y las tareas dadas) acepta [tarea()] y [], y lanza ErrorAPI para:
    //   hora "8:00", "24:00", "08:60"; dias [] ; dias [0]; dias [8]; dias [1,1]; zona "Marte/Base"; consigna "  " (vacía); consigna de 4001 'x';
    //   id "Mal Id"; agente "nadie" (activa); id repetido (dos tareas iguales); 51 tareas (50 sí vale)
    //   Válidas: tarea desactivada (activa false) de un agente que ya no está (así se conservan al despedir)
    //   Una sola vez: dias [] con fecha "2026-11-20" válida, con o sin hecha "2026-11-20T11:00:00Z";
    //   inválidas: hecha "ayer", fecha "2026-02-30", y `hecha` en una repetida.
    // (Por HTTP lo ve parte de crearValidaciones/editar, pero Validar.oficina se prueba directo.)
  })

  test.skip('oficina.json sin `tareas` se lee igual y no la escribe; con `tareas` va y vuelve', () => {
    // interno (unit test del port): decodificar {"version":1,"nombre":"O","duenio":"","departamentos":[],"agentes":[]} → tareas == nil y json["tareas"] ausente.
    //   Con "tareas":[{"id":"a","agente":"x","nombre":"N","consigna":"C","dias":[1],"hora":"08:00"}] → tareas[0].activa == true, zona == nil, json["tareas"] presente.
  })
})

describe('Tareas programadas (API y programador)', () => {
  /** Oficina con Marce y Nico; el bucle del programador apagado. */
  const fix = () => Fix.crear({ deps: ['Dirección'], agentes: [{ id: 'marce', depto: 'direccion', rol: 'Directora' }, { id: 'nico', depto: 'direccion', rol: 'Ads' }], env: { HQ_PROGRAMADOR: '0' } })

  const nueva = (f: Fix, extra: Obj = {}) =>
    f.post('/api/tareas', { agente: 'marce', nombre: 'Informe diario', consigna: 'Armá el informe de ayer', dias: [1, 2, 3, 4, 5], hora: '08:00', zona: ba, ...extra })

  const ejecuciones = async (f: Fix, id: string): Promise<Obj[]> => lista((await f.get(`/api/tareas/${id}/ejecuciones`)).obj.ejecuciones)

  /** Espera a que la última ejecución de la tarea deje de estar «corriendo» y la devuelve. */
  async function terminada(f: Fix, id: string, cuantas = 1): Promise<Obj> {
    await esperar(async () => {
      const e = await ejecuciones(f, id)
      return e.length >= cuantas && e[0] !== undefined && str(e[0].estado) !== 'corriendo'
    }, 15)
    return (await ejecuciones(f, id))[0] ?? {}
  }

  // MARK: CRUD

  test('crear: guarda en oficina.json, devuelve proxima y zona; sin zona toma la del sistema', async () => {
    const f = await fix()
    const r = await nueva(f)
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const t = dict(r.obj.tarea)
    expect(str(t.id)).toBe('informe-diario')
    expect(t.dias).toEqual([1, 2, 3, 4, 5])
    expect(str(t.zona)).toBe(ba)
    expect(t.activa).toBe(true)
    expect(fecha(str(t.proxima))).not.toBeNull()
    expect(t.ultima).toBeNull()
    expect(str(t.creada)).not.toBe('')
    const enDisco = lista(f.oficinaJSON().tareas)
    expect(enDisco.length).toBe(1)
    expect(str(enDisco[0]!.consigna)).toBe('Armá el informe de ayer')

    const sinZona = await f.post('/api/tareas', { agente: 'nico', nombre: 'Otra', consigna: 'x', dias: [7], hora: '21:30' })
    expect(sinZona.status).toBe(200)
    expect(canonica(str(dict(sinZona.obj.tarea).zona))).toBe(canonica(zonaDelSistema))

    const l = await f.get('/api/tareas')
    expect(l.status).toBe(200)
    expect(lista(l.obj.tareas).map((x) => str(x.id))).toEqual(['informe-diario', 'otra'])
    // mismo nombre: id distinto
    expect(str(dict((await nueva(f)).obj.tarea).id)).toBe('informe-diario-2')
  })

  test('crear: validaciones (400), agente inexistente (404), id repetido (409), tope de 50', async () => {
    const f = await fix()
    const malo = async (extra: Obj, estado = 400) => {
      const r = await nueva(f, extra)
      expect(r.status, `${JSON.stringify(extra)} -> ${r.status} ${JSON.stringify(r.obj)}`).toBe(estado)
      expect(str(r.obj.error)).not.toBe('')
    }
    await malo({ dias: [] })
    await malo({ dias: [0] })
    await malo({ dias: [8] })
    await malo({ dias: [1, 1] })
    await malo({ dias: 'lunes' })
    await malo({ dias: [true] })
    await malo({ hora: '8:00' })
    await malo({ hora: '24:00' })
    await malo({ hora: '07:75' })
    await malo({ hora: 800 })
    await malo({ zona: 'Marte/Base' })
    await malo({ consigna: '' })
    await malo({ consigna: 'x'.repeat(4001) })
    await malo({ nombre: ' ' })
    await malo({ activa: 'si' })
    await malo({ id: 'Con Espacios' })
    await malo({ agente: 'nadie' }, 404)
    expect((await f.post('/api/tareas', { agente: 'marce' })).status).toBe(400)
    expect((await llamar(f.b, 'POST', '/api/tareas', { body: 'no json' })).status).toBe(400)
    expect((await llamar(f.b, 'POST', '/api/tareas')).status).toBe(400)
    expect((await nueva(f, { id: 'fija' })).status).toBe(200)
    await malo({ id: 'fija' }, 409)
    for (let i = 1; i < 50; i++) expect((await nueva(f, { nombre: `T${i}` })).status).toBe(200)
    expect(lista(f.oficinaJSON().tareas).length).toBe(50)
    await malo({})
    expect(lista(f.oficinaJSON().tareas).length).toBe(50)
  })

  test('editar: parcial, valida igual, 404 si no existe; el horario o reactivar fijan «desde»', async () => {
    const f = await fix()
    await nueva(f)
    const r = await f.patch('/api/tareas/informe-diario', { nombre: 'Informe de la mañana', hora: '09:15', dias: [1, 3, 5], activa: false })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const t = dict(r.obj.tarea)
    expect(str(t.nombre)).toBe('Informe de la mañana')
    expect(str(t.hora)).toBe('09:15')
    expect(t.dias).toEqual([1, 3, 5])
    expect(t.activa).toBe(false)
    expect(t.proxima, 'una tarea en pausa no tiene próxima corrida').toBeNull()
    expect(str(lista(f.oficinaJSON().tareas)[0]!.consigna), 'lo que no se manda no cambia').toBe('Armá el informe de ayer')
    const react = await f.patch('/api/tareas/informe-diario', { activa: true, zona: ny })
    expect(react.status).toBe(200)
    expect(fecha(str(dict(react.obj.tarea).proxima))).not.toBeNull()
    expect(str(dict(react.obj.tarea).zona)).toBe(ny)
    expect(lista(f.oficinaJSON().tareas)[0]!.desde).toBeDefined()
    expect((await f.patch('/api/tareas/informe-diario', { hora: '99:00' })).status).toBe(400)
    expect((await f.patch('/api/tareas/informe-diario', { zona: 'x/y' })).status).toBe(400)
    expect((await f.patch('/api/tareas/informe-diario', { dias: [] })).status).toBe(400)
    expect((await f.patch('/api/tareas/informe-diario', { consigna: 'x'.repeat(4001) })).status).toBe(400)
    expect((await f.patch('/api/tareas/no-existe', { nombre: 'x' })).status).toBe(404)
    expect((await f.patch('/api/tareas/Mal Id', { nombre: 'x' })).status).toBe(404)
    expect((await llamar(f.b, 'PATCH', '/api/tareas/informe-diario')).status).toBe(400)
    expect((await llamar(f.b, 'PUT', '/api/tareas/informe-diario')).status).toBe(405)
  })

  test('una tarea que termina bien deja una entrega sin revisar (no un aviso) y avisa al canal de notificaciones', async () => {
    const f = await fix()
    // interno (unit test del port): el callback `avisos.alCrear` (canal de notificaciones nativas) recibe "entrega:Marce" (aviso tipo «entrega», nombre del agente).
    await nueva(f)
    expect((await f.post('/api/tareas/informe-diario/correr')).status).toBe(202)
    await terminada(f, 'informe-diario')
    const ok = await esperar(async () => lista((await f.get('/api/entregas')).obj.entregas).length > 0)
    expect(ok).toBe(true)
    const e = lista((await f.get('/api/entregas')).obj.entregas)[0] ?? {}
    expect(str(e.agente)).toBe('marce')
    expect(str(e.origen)).toBe('tarea')
    expect(str(e.ref)).toBe('informe-diario')
    expect(str(e.estado)).toBe('sin_revisar')
    expect(str(e.sid)).not.toBe('')
    expect(lista((await f.get('/api/avisos')).obj.avisos).some((a) => str(a.tipo) === 'tarea')).toBe(false)
  })

  test('borrar: saca la tarea y sus ejecuciones; 404 si no existe', async () => {
    const f = await fix()
    await nueva(f)
    const c = await f.post('/api/tareas/informe-diario/correr')
    expect(c.status).toBe(202)
    await terminada(f, 'informe-diario')
    const d = await f.delete('/api/tareas/informe-diario')
    expect(d.status).toBe(200)
    expect(d.obj.ok).toBe(true)
    expect(lista((await f.get('/api/tareas')).obj.tareas)).toEqual([])
    expect(f.oficinaJSON().tareas).toBeUndefined()
    expect((await f.get('/api/tareas/informe-diario/ejecuciones')).status).toBe(404)
    expect((await f.delete('/api/tareas/informe-diario')).status).toBe(404)
    // si se vuelve a crear con el mismo id no hereda historial
    await nueva(f)
    expect(await ejecuciones(f, 'informe-diario')).toEqual([])
  })

  test('despedir al agente desactiva sus tareas (no las borra) y no se pueden reactivar', async () => {
    const f = await fix()
    await nueva(f)
    await nueva(f, { agente: 'nico', nombre: 'De Nico' })
    expect((await f.delete('/api/agentes/marce')).status).toBe(200)
    const ts = lista((await f.get('/api/tareas')).obj.tareas)
    expect(ts.length).toBe(2)
    const marce = ts.find((x) => str(x.id) === 'informe-diario')!
    expect(marce).toBeDefined()
    expect(marce.activa).toBe(false)
    expect(marce.proxima).toBeNull()
    expect(ts.find((x) => str(x.id) === 'de-nico')?.activa).toBe(true)
    expect((await f.patch('/api/tareas/informe-diario', { activa: true })).status).toBe(409)
    expect((await f.post('/api/tareas/informe-diario/correr')).status).toBe(409)
    // oficina.json sigue siendo válido y se puede volver a leer
    expect((await f.get('/api/oficina')).status).toBe(200)
  })

  test('sin oficina abierta: 409', async () => {
    const sin = await new Sandbox().backend({ env: { HQ_PROGRAMADOR: '0' }, oficina: false })
    expect((await llamar(sin, 'GET', '/api/tareas')).status).toBe(409)
    const cuerpo = { agente: 'a', nombre: 'n', consigna: 'c', dias: [1], hora: '08:00' }
    expect((await llamar(sin, 'POST', '/api/tareas', { body: cuerpo })).status).toBe(409)
    expect((await llamar(sin, 'POST', '/api/tareas/x/correr')).status).toBe(409)
  })

  // MARK: ejecución

  test('probar ahora: 202 con la ejecución; corre al agente con sus permisos en una sesión nueva; queda ok con costo', async () => {
    const f = await fix()
    await nueva(f, { consigna: 'Armá el informe' })
    // interno (unit test del port): el gancho `programador.alTerminar` se llama una vez con la ejecución (estado «ok», tarea «informe-diario»).
    const r = await f.post('/api/tareas/informe-diario/correr')
    expect(r.status, JSON.stringify(r.obj)).toBe(202)
    const ej = dict(r.obj.ejecucion)
    expect(str(ej.estado)).toBe('corriendo')
    expect(ej.manual).toBe(true)
    expect(str(ej.agente)).toBe('marce')
    expect(str(ej.tarea)).toBe('informe-diario')
    const sid = str(ej.sid)
    expect(esUUID(sid)).toBe(true)

    const fin = await terminada(f, 'informe-diario')
    expect(str(fin.estado), JSON.stringify(fin)).toBe('ok')
    expect(str(fin.resultado)).toBe('hola marce')
    expect(Math.abs(((fin.costo as number) ?? 0) - 0.01)).toBeLessThan(1e-9)
    expect(fin.fin).not.toBeNull()
    expect(fin.error).toBeNull()
    expect(str(fin.sid)).toBe(sid)

    // el pedido y la respuesta quedaron como un chat más
    const h = await historial(f.b, { agent: 'marce', session: sid })
    expect(msgs(h).map((m) => str(m.r))).toEqual(['u', 'a'])
    expect(msgs(h).map((m) => str(m.t))).toEqual(['Armá el informe', 'hola marce'])
    expect(str((await historial(f.b, { agent: 'marce' })).obj.session), 'es la última sesión del agente').toBe(sid)
    // con los permisos y la carpeta del agente
    const l = f.sb.llamadas.at(-1)!
    expect(l).toBeDefined()
    expect(Sandbox.valor(l, '--agent')).toBe('marce')
    expect(Sandbox.valor(l, '--session-id')).toBe(sid)
    expect(Sandbox.reglas(l)).toContain(`Edit(/${f.carpeta}/conocimiento/agentes/marce.md)`)
    expect(sinPrivate(f.sb.cwds.at(-1)!)).toBe(sinPrivate(f.carpeta))
    // costo con origen «tarea» y la tarea como referencia
    const c = await f.get('/api/costos')
    expect(Math.abs(((dict(c.obj.origenes).tarea as number) ?? 0) - 0.01)).toBeLessThan(1e-9)
    expect(Math.abs(((dict(c.obj.agentes).marce as number) ?? 0) - 0.01)).toBeLessThan(1e-9)
    // en la lista aparece como última
    const t = dict(lista((await f.get('/api/tareas')).obj.tareas)[0])
    expect(str(dict(t.ultima).estado)).toBe('ok')
    expect(t.corriendo).toBe(false)
  })

  test('probar ahora: la actividad muestra origen «tarea» con el nombre; no se puede lanzar ni borrar mientras corre (409)', async () => {
    const f = await fix()
    await nueva(f, { consigna: 'STREAM PAUSA informe' })
    const r = await f.post('/api/tareas/informe-diario/correr')
    expect(r.status).toBe(202)
    const viendo = await esperar(async () => {
      const a = await f.get('/api/actividad')
      return dict(dict(a.obj.agentes).marce).origen === 'tarea'
    })
    expect(viendo).toBe(true)
    const m = dict(dict((await f.get('/api/actividad')).obj.agentes).marce)
    expect(str(m.tarea)).toBe('Informe diario')
    expect((await f.post('/api/tareas/informe-diario/correr')).status).toBe(409)
    expect((await f.delete('/api/tareas/informe-diario')).status).toBe(409)
    expect(dict(lista((await f.get('/api/tareas')).obj.tareas)[0]).corriendo).toBe(true)
    f.sb.abrirPuerta()
    const fin = await terminada(f, 'informe-diario')
    expect(str(fin.estado)).toBe('ok')
    expect(str(fin.resultado)).toBe('stream marce')
    expect(Math.abs(((fin.costo as number) ?? 0) - 0.25)).toBeLessThan(1e-9)
    expect(dict((await f.get('/api/actividad')).obj.agentes)).toEqual({})
  })

  test('una corrida que falla queda en error con el motivo, y el chat guarda el error', async () => {
    const f = await fix()
    await nueva(f, { consigna: 'ISERR por favor' })
    // interno (unit test del port): el gancho `programador.alTerminar` se llama una vez con la ejecución (estado «error»).
    expect((await f.post('/api/tareas/informe-diario/correr')).status).toBe(202)
    const fin = await terminada(f, 'informe-diario')
    expect(str(fin.estado), JSON.stringify(fin)).toBe('error')
    expect(str(fin.error)).not.toBe('')
    const m = msgs(await historial(f.b, { agent: 'marce', session: str(fin.sid) }))
    expect(m.length).toBe(2)
    expect(m[1]!.e).toBe(true)
  })

  test.skip('el resultado se recorta a 2000 caracteres', () => {
    // interno (unit test del port): store.nuevaEjecucion(tarea «informe-diario», agente marce, programada 1, inicio 1, sid U.a, manual true) +
    //   terminarEjecucion(id, estado «ok», resultado = 5000 × «ñ») → store.ejecucion(id).resultado.count == 2000 (cuenta caracteres, no bytes).
  })

  // MARK: una sola vez

  const nuevaUnica = (f: Fix, extra: Obj = {}) =>
    f.post('/api/tareas', { agente: 'marce', nombre: 'Propuesta', consigna: 'Armá la propuesta', tipo: 'unica', fecha: '2099-03-10', hora: '09:00', zona: ba, ...extra })

  test('una sola vez: se crea con fecha (sin días), tiene próxima y «cuando»; valida fecha y tipo', async () => {
    const f = await fix()
    const r = await nuevaUnica(f)
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const t = dict(r.obj.tarea)
    expect(str(t.tipo)).toBe('unica')
    expect(str(t.fecha)).toBe('2099-03-10')
    expect(t.dias).toEqual([])
    expect(t.hecha).toBeNull()
    expect(fecha(str(t.proxima))).toBe(fecha(str(t.cuando)))
    expect(fecha(str(t.cuando))).toBe(fecha('2099-03-10T09:00:00-03:00'))
    expect(str(lista(f.oficinaJSON().tareas)[0]!.fecha)).toBe('2099-03-10')
    // las repetidas siguen igual y dicen su tipo
    expect(str(dict((await nueva(f)).obj.tarea).tipo)).toBe('repetida')
    for (const malo of [{ fecha: '2099-02-30' }, { fecha: 'mañana' }, { fecha: null }, { tipo: 'a veces' }, { hora: '9' }, { ahora: 'si' }, { tipo: 'repetida', ahora: true, dias: [1] }]) {
      const m = await nuevaUnica(f, malo)
      expect(m.status, `${JSON.stringify(malo)} -> ${m.status} ${JSON.stringify(m.obj)}`).toBe(400)
    }
    // sin «tipo», la fecha alcanza
    const sinTipo = await f.post('/api/tareas', { agente: 'marce', nombre: 'X', consigna: 'c', fecha: '2099-01-01', hora: '10:00' })
    expect(str(dict(sinTipo.obj.tarea).tipo)).toBe('unica')
  })

  test('una sola vez «ahora»: arranca enseguida como su corrida programada, deja una entrega y queda hecha y en pausa', async () => {
    const f = await fix()
    const r = await f.post('/api/tareas', { agente: 'marce', nombre: 'Propuesta', consigna: 'Armá la propuesta', tipo: 'unica', ahora: true })
    expect(r.status, JSON.stringify(r.obj)).toBe(200)
    const id = str(dict(r.obj.tarea).id)
    const fin = await terminada(f, id)
    expect(str(fin.estado)).toBe('ok')
    expect(fin.manual).toBe(false)
    const hecha = await esperar(async () => typeof dict((await f.get(`/api/tareas/${id}`)).obj.tarea).hecha === 'string')
    expect(hecha).toBe(true)
    const t = dict((await f.get(`/api/tareas/${id}`)).obj.tarea)
    expect(t.activa).toBe(false)
    expect(t.proxima).toBeNull()
    const es = lista((await f.get('/api/entregas')).obj.entregas).filter((e) => str(e.ref) === id)
    expect(es.length).toBe(1)
    expect(str(es[0]!.origen)).toBe('tarea')
    // el programador no la vuelve a correr
    // interno (unit test del port): Swift llamaba antes a `programador.revisar()` (un tick a mano); aquí el bucle está apagado, así que solo se comprueba que sigue en 1.
    expect((await ejecuciones(f, id)).length).toBe(1)
    // reactivarla sin cambiar la fecha: 409; cambiando la hora vuelve a estar pendiente
    expect((await f.patch(`/api/tareas/${id}`, { activa: true })).status).toBe(409)
    const mov = await f.patch(`/api/tareas/${id}`, { fecha: '2099-05-01', hora: '10:00' })
    expect(mov.status, JSON.stringify(mov.obj)).toBe(200)
    const m = dict(mov.obj.tarea)
    expect(m.hecha).toBeNull()
    expect(m.activa).toBe(true)
    expect(fecha(str(m.proxima))).not.toBeNull()
  })

  test.skip('una sola vez: el programador la corre al llegar su hora (o días después) una sola vez; si falla no se reintenta sola', () => {
    // interno (unit test del port): usa `programador.fijarReloj` y `programador.revisar()` con un reloj propio (Reloj.poner).
    // Tarea única «Propuesta» (fecha 2099-03-10 09:00 BA, i = 2099-03-10T09:00-03:00); reloj = i-60 s → revisar → 0 ejecuciones.
    //   reloj = i + 3 días → revisar → una ejecución terminada ok con `programada` == i; esperar hecha (String); revisar de nuevo → sigue 1 ejecución.
    //   Otra única «Mala» con consigna «ISERR»: revisar → ejecución en error; revisar otra vez → sigue en 1; la tarea queda con hecha null y activa true.
    //   Tras dormir 1.1 s (el «desde» va en segundos) y PATCH {hora «09:05», consigna «ahora sí»}, reloj = i + 3 días + 60 s → revisar → 2 ejecuciones y la última ok.
  })

  test('editar: pasar de repetida a una sola vez y al revés pide fecha o días', async () => {
    const f = await fix()
    await nueva(f)
    expect((await f.patch('/api/tareas/informe-diario', { tipo: 'unica' })).status).toBe(400)
    expect((await f.patch('/api/tareas/informe-diario', { fecha: '2099-01-01', dias: [1] })).status).toBe(400)
    const u = await f.patch('/api/tareas/informe-diario', { tipo: 'unica', fecha: '2099-01-01' })
    expect(u.status).toBe(200)
    expect(str(dict(u.obj.tarea).tipo)).toBe('unica')
    expect(dict(u.obj.tarea).dias).toEqual([])
    expect((await f.patch('/api/tareas/informe-diario', { dias: [1, 2] })).status, 'con días vuelve a repetirse').toBe(200)
    const r = dict((await f.get('/api/tareas/informe-diario')).obj.tarea)
    expect(str(r.tipo)).toBe('repetida')
    expect(r.fecha).toBeUndefined()
    expect(r.dias).toEqual([1, 2])
    expect((await f.patch('/api/tareas/informe-diario', { tipo: 'repetida' })).status, 'ya era repetida').toBe(200)
    expect((await f.patch('/api/tareas/informe-diario', { tipo: 'repetida', fecha: '2099-01-01' })).status).toBe(400)
  })

  // MARK: programador

  test.skip('programador: corre lo que toca, una sola vez por horario, y se pone al día una vez si pasaron menos de 12 h', () => {
    // interno (unit test del port): usa `programador.fijarReloj`/`revisar()`/`alTerminar` y Programacion.proxima.
    // Tarea «informe-diario» todos los días 08:00 BA; p1 = proxima(desde: ahora + 2 días); reloj = p1 - 30 s → revisar → 0 ejecuciones («todavía no es la hora»).
    //   reloj = p1 + 5 s → revisar → 1 ejecución, manual false, programada == p1; terminar; revisar; reloj = p1 + 35 s; revisar → sigue 1 (nunca dos veces la misma) y el claude falso se llamó 1 vez; el gancho alTerminar se llamó 1 vez.
    //   p2 = proxima(desde: p1); reloj = p2 + 10 s → revisar → 2 ejecuciones.
    //   app cerrada dos días: p4 = proxima(desde: p2 + 2 días); reloj = p4 + 11 h → revisar → 3 ejecuciones, la última con programada == p4 (una sola vez, la de ese día); revisar de nuevo → sigue 3.
    //   más de 12 h tarde: p5 = proxima(desde: p4); reloj = p5 + 13 h → revisar → sigue 3 (se perdió).
  })

  test.skip('programador: no corre tareas en pausa, de agentes que no están, ni de una tarea recién creada con la hora ya pasada', () => {
    // interno (unit test del port): usa `programador.fijarReloj`/`revisar()` y Programacion.anterior.
    // Se crean (API): «Informe diario» marce todos los días con activa false; «De Nico» (nico) todos los días y luego se despide a nico; «Nueva» marce todos los días, activa.
    //   p = Programacion.anterior(tarea todos los días 08:00 BA, hasta: ahora); reloj = p + 1 h (a propósito detrás de «desde» de la recién creada) → revisar →
    //   el claude falso no recibió llamadas y las ejecuciones de «informe-diario», «de-nico» y la de «Nueva» están vacías.
  })

  test.skip('reinicio: lo que quedó «corriendo» pasa a «error» (interrumpida)', () => {
    // interno (unit test del port): siembra con store.nuevaEjecucion(tarea «informe-diario», agente marce, programada 1, inicio 2, sid U.a, manual false) (estado «corriendo»),
    //   hace `b.shutdown()` y levanta otro backend sobre la misma base y la misma oficina activa (env HQ_PROGRAMADOR 0, oficina false).
    //   GET /api/tareas/informe-diario/ejecuciones → 200; la primera tiene estado «error», error que contiene «Interrumpida» y fin no nulo.
  })

  test.skip('el bucle automático arranca solo y corre lo que toca (intervalo corto)', () => {
    // interno (unit test del port): Fix.crear con env HQ_PROGRAMADOR_INTERVALO=0.1 (bucle encendido); crea la tarea «informe-diario» todos los días 08:00 BA;
    //   p = proxima(desde: ahora + 1 día); `programador.fijarReloj { p + 1 s }` (reloj inyectado, no se puede por HTTP); esperar hasta 15 s a que haya 1 ejecución y que termine.
  })
})
