// Lógica interna de tareas programadas (sin servidor HTTP): Programacion (horarios, zonas, DST), validación y formato del
// modelo, tabla `ejecuciones` y el Programador con reloj inyectable. Reescribe los tests `interno` de TareasTests.swift.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, onTestFinished, test } from 'vitest'
import { createBackend, type Backend } from '../../src/backend.js'
import { Config } from '../../src/config.js'
import { ErrorAPI } from '../../src/errores.js'
import { OficinaStore, type Oficina } from '../../src/oficina.js'
import { Ejecuciones, Programador, nombreCorrida, programadorDe } from '../../src/programador.js'
import { Store } from '../../src/store.js'
import { Programacion, ValidarTareas, type TareaProgramada } from '../../src/tareas.js'
import { Sandbox, esperar } from '../support/sandbox.js'

const BA = 'America/Argentina/Buenos_Aires'
const NY = 'America/New_York'
const f = (s: string) => new Date(s)

/** La tarea de prueba de Swift: L-V 08:00 en Buenos Aires. 2026-11-13 es viernes (el 15 domingo, el 16 lunes). */
const tarea = (extra: Partial<TareaProgramada> = {}): TareaProgramada => ({
  id: 'informe', agente: 'marce', nombre: 'Informe', consigna: 'Armá el informe', dias: [1, 2, 3, 4, 5], hora: '08:00', zona: BA, activa: true, ...extra,
})
const iso = (d: Date | undefined) => (d ? d.toISOString() : undefined)

describe('Programacion: lógica pura de horarios', () => {
  test('próxima: horario de su zona, en los días marcados, estrictamente posterior', () => {
    const t = tarea()
    expect(iso(Programacion.proxima(t, f('2026-11-13T07:00:00-03:00'), 'UTC'))).toBe(iso(f('2026-11-13T08:00:00-03:00')))
    expect(iso(Programacion.proxima(t, f('2026-11-13T08:00:00-03:00'), 'UTC'))).toBe(iso(f('2026-11-16T08:00:00-03:00')))
    expect(iso(Programacion.proxima(t, f('2026-11-14T09:00:00-03:00'), 'UTC'))).toBe(iso(f('2026-11-16T08:00:00-03:00')))
    expect(iso(Programacion.proxima(t, f('2026-11-13T00:00:00Z'), 'UTC'))).toBe(iso(f('2026-11-13T11:00:00Z')))
  })

  test('días ISO: 1 = lunes … 7 = domingo', () => {
    const desde = f('2026-11-13T07:00:00-03:00')
    const p = (dias: number[]) => iso(Programacion.proxima(tarea({ dias }), desde, 'UTC'))
    expect(p([7])).toBe(iso(f('2026-11-15T08:00:00-03:00')))
    expect(p([1])).toBe(iso(f('2026-11-16T08:00:00-03:00')))
    expect(p([6, 7])).toBe(iso(f('2026-11-14T08:00:00-03:00')))
    expect(p([])).toBeUndefined()
  })

  test('sin zona usa la del sistema', () => {
    const t = tarea({ zona: undefined })
    const desde = f('2026-11-13T00:00:00Z')
    expect(iso(Programacion.proxima(t, desde, NY))).toBe(iso(f('2026-11-13T08:00:00-05:00')))
    expect(iso(Programacion.proxima(t, desde, 'UTC'))).toBe(iso(f('2026-11-13T08:00:00Z')))
  })

  test('DST (Nueva York): sigue siendo la misma hora de pared al cambiar el horario', () => {
    const t = tarea({ dias: [1, 2, 3, 4, 5, 6, 7], hora: '09:00', zona: NY })
    const primavera = Programacion.proxima(t, f('2026-03-07T09:00:00-05:00'), 'UTC')!
    expect(iso(primavera)).toBe(iso(f('2026-03-08T09:00:00-04:00')))
    expect((primavera.getTime() - f('2026-03-07T09:00:00-05:00').getTime()) / 1000).toBe(23 * 3600)
    const otono = Programacion.proxima(t, f('2026-10-31T09:00:00-04:00'), 'UTC')!
    expect(iso(otono)).toBe(iso(f('2026-11-01T09:00:00-05:00')))
    expect((otono.getTime() - f('2026-10-31T09:00:00-04:00').getTime()) / 1000).toBe(25 * 3600)
  })

  test('DST: una hora que no existe ese día corre una sola vez, corrida hacia adelante', () => {
    const t = tarea({ dias: [1, 2, 3, 4, 5, 6, 7], hora: '02:30', zona: NY })
    const a = Programacion.proxima(t, f('2026-03-08T00:00:00-05:00'), 'UTC')!
    expect(iso(a)).toBe(iso(f('2026-03-08T03:30:00-04:00')))
    expect(iso(Programacion.proxima(t, a, 'UTC'))).toBe(iso(f('2026-03-09T02:30:00-04:00')))
  })

  test('DST: una hora que existe dos veces toma la primera', () => {
    const t = tarea({ dias: [1, 2, 3, 4, 5, 6, 7], hora: '01:30', zona: NY })
    expect(iso(Programacion.proxima(t, f('2026-11-01T00:00:00-04:00'), 'UTC'))).toBe(iso(f('2026-11-01T01:30:00-04:00')))
  })

  test('debeCorrer: en su horario, una vez, y solo en días marcados', () => {
    const t = tarea()
    const vie8 = f('2026-11-13T08:00:00-03:00')
    const d = (ahora: string, ultima?: Date, tt = t) => iso(Programacion.debeCorrer(tt, f(ahora), ultima, 'UTC'))
    expect(d('2026-11-13T07:59:00-03:00')).toBeUndefined()
    expect(d('2026-11-13T08:00:10-03:00')).toBe(iso(vie8))
    expect(d('2026-11-13T08:00:40-03:00', vie8)).toBeUndefined()
    expect(d('2026-11-13T15:00:00-03:00', vie8)).toBeUndefined()
    expect(d('2026-11-14T09:00:00-03:00', vie8)).toBeUndefined()
    expect(d('2026-11-15T09:00:00-03:00')).toBeUndefined()
    expect(d('2026-11-13T08:00:10-03:00', undefined, tarea({ activa: false }))).toBeUndefined()
  })

  test('puesta al día: una vez si pasaron menos de 12 h; más, no', () => {
    const t = tarea()
    const vie8 = f('2026-11-13T08:00:00-03:00')
    const jue8 = f('2026-11-12T08:00:00-03:00')
    const mie8 = f('2026-11-11T08:00:00-03:00')
    expect(iso(Programacion.debeCorrer(t, f('2026-11-13T19:59:00-03:00'), jue8, 'UTC'))).toBe(iso(vie8))
    expect(Programacion.debeCorrer(t, f('2026-11-13T20:00:00-03:00'), jue8, 'UTC')).toBeUndefined()
    expect(Programacion.debeCorrer(t, f('2026-11-13T20:01:00-03:00'), jue8, 'UTC')).toBeUndefined()
    expect(iso(Programacion.debeCorrer(t, f('2026-11-13T09:00:00-03:00'), mie8, 'UTC'))).toBe(iso(vie8))
    const noche = tarea({ dias: [1, 2, 3, 4, 5, 6, 7], hora: '23:00' })
    expect(iso(Programacion.debeCorrer(noche, f('2026-11-14T05:00:00-03:00'), undefined, 'UTC'))).toBe(iso(f('2026-11-13T23:00:00-03:00')))
  })

  test('una tarea nueva o movida no se pone al día con un horario anterior a su creación', () => {
    const ahora = f('2026-11-13T10:00:00-03:00')
    const d = (extra: Partial<TareaProgramada>) => Programacion.debeCorrer(tarea(extra), ahora, undefined, 'UTC')
    expect(iso(d({}))).toBe(iso(f('2026-11-13T08:00:00-03:00')))
    expect(d({ creada: '2026-11-13T12:50:00Z' })).toBeUndefined()
    expect(d({ creada: '2026-11-01T00:00:00Z', desde: '2026-11-13T12:50:00Z' })).toBeUndefined()
    expect(d({ creada: '2026-11-12T00:00:00Z' })).toBeDefined()
  })

  test('simulación minuto a minuto: una sola corrida por horario (cada 30 s, con DST y todo)', () => {
    for (const [zona, dia] of [[BA, '2026-11-13'], [NY, '2026-03-08'], [NY, '2026-11-01']] as const) {
      const t = tarea({ dias: [1, 2, 3, 4, 5, 6, 7], hora: '09:00', zona })
      const corridas: number[] = []
      let ultima: Date | undefined
      let cuando = f(`${dia}T00:00:00Z`).getTime() - 12 * 3600_000
      const fin = cuando + 3 * 86_400_000
      for (; cuando < fin; cuando += 30_000) {
        const p = Programacion.debeCorrer(t, new Date(cuando), ultima, 'UTC')
        if (p) {
          corridas.push(p.getTime())
          ultima = p
        }
      }
      expect([3, 4], `${zona} ${dia}: ${corridas.length}`).toContain(corridas.length)
      expect(new Set(corridas).size).toBe(corridas.length)
    }
  })

  test('una sola vez: corre una vez cuando llega su fecha y hora, aunque sea tarde; no si está hecha, en pausa o ya corrió', () => {
    const t = tarea({ dias: [], hora: '10:30', fecha: '2026-11-20' })
    const i = f('2026-11-20T10:30:00-03:00')
    expect(iso(Programacion.instanteUnica(t, 'UTC'))).toBe(iso(i))
    expect(iso(Programacion.proxima(t, f('2026-11-13T09:00:00-03:00'), 'UTC'))).toBe(iso(i))
    expect(Programacion.proxima(t, i, 'UTC')).toBeUndefined()
    expect(Programacion.debeCorrer(t, f('2026-11-20T10:29:00-03:00'), undefined, 'UTC')).toBeUndefined()
    expect(iso(Programacion.debeCorrer(t, f('2026-11-20T10:30:05-03:00'), undefined, 'UTC'))).toBe(iso(i))
    expect(iso(Programacion.debeCorrer(t, f('2026-11-23T10:30:00-03:00'), undefined, 'UTC'))).toBe(iso(i))
    const creada = tarea({ dias: [], hora: '10:30', fecha: '2026-11-20', creada: '2026-11-21T00:00:00Z' })
    expect(iso(Programacion.debeCorrer(creada, f('2026-11-21T09:00:00-03:00'), undefined, 'UTC'))).toBe(iso(i))
    expect(Programacion.debeCorrer(creada, f('2026-11-21T09:00:00-03:00'), i, 'UTC')).toBeUndefined()
    const hecha = tarea({ dias: [], hora: '10:30', fecha: '2026-11-20', hecha: '2026-11-20T13:31:00Z' })
    expect(Programacion.debeCorrer(hecha, f('2026-11-21T09:00:00-03:00'), undefined, 'UTC')).toBeUndefined()
    expect(Programacion.proxima(hecha, f('2026-11-13T09:00:00-03:00'), 'UTC')).toBeUndefined()
    const pausa = tarea({ dias: [], hora: '10:30', fecha: '2026-11-20', activa: false })
    expect(Programacion.debeCorrer(pausa, f('2026-11-21T09:00:00-03:00'), undefined, 'UTC')).toBeUndefined()

    expect(Programacion.diaCalendario('2026-02-28')).toEqual([2026, 2, 28])
    expect(Programacion.diaCalendario('2028-02-29')).toBeDefined()
    for (const malo of ['2026-02-29', '2026-13-01', '2026-1-01', '26-01-01', '2026/01/01', '2026-01-32', 'abcd-ef-gh', '']) {
      expect(Programacion.diaCalendario(malo), malo).toBeUndefined()
    }
  })

  test('fechas ISO: iso() sin fracción, fecha() acepta Z, desfase y fracción; textoDia/textoHora', () => {
    expect(Programacion.iso(f('2026-11-13T11:00:00.789Z'))).toBe('2026-11-13T11:00:00Z')
    expect(iso(Programacion.fecha('2026-11-13T11:00:00Z'))).toBe('2026-11-13T11:00:00.000Z')
    expect(iso(Programacion.fecha('2026-11-13T08:00:00-03:00'))).toBe('2026-11-13T11:00:00.000Z')
    expect(iso(Programacion.fecha('2026-11-13T11:00:00.5Z'))).toBe('2026-11-13T11:00:00.500Z')
    for (const malo of ['ayer', '2026-11-13', '2026-02-30T00:00:00Z', '2026-11-13 11:00:00Z', '']) expect(Programacion.fecha(malo), malo).toBeUndefined()
    expect(Programacion.textoDia(f('2026-11-13T01:30:00Z'), BA)).toBe('2026-11-12')
    expect(Programacion.textoHora(f('2026-11-13T01:30:00Z'), BA)).toBe('22:30')
    expect(Programacion.textoHora(f('2026-11-13T05:00:00Z'), 'UTC')).toBe('05:00')
  })

  test('horaMinuto es estricta', () => {
    expect(Programacion.horaMinuto('08:00')).toEqual([8, 0])
    expect(Programacion.horaMinuto('23:59')).toEqual([23, 59])
    for (const malo of ['8:00', '24:00', '08:60', '0800', '08:0', '08:000', 'aa:bb', '', '٠٨:٠٠']) expect(Programacion.horaMinuto(malo), malo).toBeUndefined()
  })
})

describe('Tareas: validación y formato del modelo', () => {
  const oficina = (tareas: TareaProgramada[]): Oficina => ({
    version: 1, nombre: 'O', duenio: '', departamentos: [{ id: 'd', nombre: 'D', color: '#aabbcc' }],
    agentes: [{ id: 'marce', nombre: 'Marce', rol: 'r', departamento: 'd' }], tareas,
  })
  const valida = (...ts: TareaProgramada[]) => { try { ValidarTareas.validar(oficina(ts)); return true } catch (e) { if (e instanceof ErrorAPI) return false; throw e } }

  test('validación del modelo: hora, días, zona, consigna, id, agente y máximo', () => {
    expect(valida(tarea())).toBe(true)
    expect(valida()).toBe(true)
    for (const hora of ['8:00', '24:00', '08:60']) expect(valida(tarea({ hora })), hora).toBe(false)
    for (const dias of [[], [0], [8], [1, 1]]) expect(valida(tarea({ dias })), JSON.stringify(dias)).toBe(false)
    expect(valida(tarea({ zona: 'Marte/Base' }))).toBe(false)
    expect(valida(tarea({ consigna: '  ' }))).toBe(false)
    expect(valida(tarea({ consigna: 'x'.repeat(4001) }))).toBe(false)
    expect(valida(tarea({ id: 'Mal Id' }))).toBe(false)
    expect(valida(tarea({ agente: 'nadie' }))).toBe(false)
    expect(valida(tarea(), tarea())).toBe(false)
    const muchas = (n: number) => Array.from({ length: n }, (_, i) => tarea({ id: `t${i}` }))
    expect(valida(...muchas(50))).toBe(true)
    expect(valida(...muchas(51))).toBe(false)
    // las únicas hechas no cuentan para las 50 por hacer, pero sí para el total guardado (500)
    const hechas = (n: number) => Array.from({ length: n }, (_, i) => tarea({ id: `h${i}`, dias: [], fecha: '2026-11-20', hecha: '2026-11-20T11:00:00Z', activa: false }))
    expect(valida(...muchas(50), ...hechas(100))).toBe(true)
    expect(valida(...muchas(50), ...hechas(450))).toBe(true)
    expect(valida(...muchas(50), ...hechas(451))).toBe(false)
    expect(valida(...muchas(10), ...hechas(491))).toBe(false)
    // una tarea desactivada de un agente que ya no está se conserva (así se guardan al despedir)
    expect(valida(tarea({ agente: 'nadie', activa: false }))).toBe(true)
    // una sola vez
    expect(valida(tarea({ dias: [], fecha: '2026-11-20' }))).toBe(true)
    expect(valida(tarea({ dias: [], fecha: '2026-11-20', hecha: '2026-11-20T11:00:00Z' }))).toBe(true)
    expect(valida(tarea({ dias: [], fecha: '2026-11-20', hecha: 'ayer' }))).toBe(false)
    expect(valida(tarea({ dias: [], fecha: '2026-02-30' }))).toBe(false)
    expect(valida(tarea({ hecha: '2026-11-20T11:00:00Z' }))).toBe(false)
  })

  test('oficina.json sin `tareas` se lee igual y no la escribe; con `tareas` va y vuelve (y el formato es el de Swift)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tareas-modelo-'))
    try {
      const base = { version: 1, nombre: 'O', duenio: '', departamentos: [], agentes: [] }
      fs.writeFileSync(path.join(dir, 'oficina.json'), JSON.stringify(base))
      const sin = OficinaStore.leer(dir)
      expect(sin.tareas).toBeUndefined()
      expect(OficinaStore.codificar(sin)).not.toContain('"tareas"')

      const conAgente = {
        ...base, departamentos: [{ id: 'd', nombre: 'D', color: '#aabbcc' }], agentes: [{ id: 'x', nombre: 'X', rol: 'r', departamento: 'd' }],
        tareas: [{ id: 'a', agente: 'x', nombre: 'N', consigna: 'C', dias: [1], hora: '08:00', desconocida: 1 }],
      }
      fs.writeFileSync(path.join(dir, 'oficina.json'), JSON.stringify(conAgente))
      const con = OficinaStore.leer(dir)
      expect(con.tareas![0]!.activa).toBe(true)
      expect(con.tareas![0]!.zona).toBeUndefined()
      const texto = OficinaStore.codificar(con)
      expect(texto).toContain('"tareas"')
      expect(texto).not.toContain('desconocida')
      expect(texto).not.toContain('zona')
      expect(texto).toContain('"activa" : true')
      // ida y vuelta idéntica
      fs.writeFileSync(path.join(dir, 'oficina.json'), texto)
      expect(OficinaStore.codificar(OficinaStore.leer(dir))).toBe(texto)

      // tipos equivocados = oficina.json inválido (como Codable)
      for (const malo of [{ id: 'a', agente: 'x', dias: 'lunes' }, { id: 1, agente: 'x' }, { id: 'a', agente: 'x', activa: 'si' }, { id: 'a', agente: 'x', origen: { reunion: 'r' } }]) {
        fs.writeFileSync(path.join(dir, 'oficina.json'), JSON.stringify({ ...conAgente, tareas: [malo] }))
        expect(() => OficinaStore.leer(dir), JSON.stringify(malo)).toThrow(ErrorAPI)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Programador: ids y prefijos', () => {
  test('encargo, flujo, origen y nombre de corrida', () => {
    expect(Programador.idEncargo('abc', 3)).toBe('encargo:abc:3')
    expect(Programador.deEncargo('encargo:abc:3')).toEqual(['abc', 3])
    expect(Programador.deEncargo('encargo:abc')).toBeUndefined()
    expect(Programador.deEncargo('encargo:a:b')).toBeUndefined()
    expect(Programador.deEncargo('flujo:1:2:3')).toBeUndefined()
    expect(Programador.idFlujo({ corrida: 7, paso: 2, intento: 1 })).toBe('flujo:7:2:1')
    expect(Programador.deFlujo('flujo:7:2:1')).toEqual([7, 2, 1])
    expect(Programador.deFlujo('flujo:7:2')).toBeUndefined()
    expect(Programador.deFlujo('flujo:x:2:1')).toBeUndefined()
    expect(Programador.origenEntrega('encargo:a:1')).toBe('encargo')
    expect(Programador.origenEntrega('coord:x')).toBe('encargo')
    expect(Programador.origenEntrega('flujo:1:0:1')).toBe('flujo')
    expect(Programador.origenEntrega('accion:5')).toBe('accion')
    expect(Programador.origenEntrega('parte:2026-11-13')).toBe('parte')
    expect(Programador.origenEntrega('informe')).toBe('tarea')
    expect(nombreCorrida('encargo:a:1')).toBe('Pendiente de reunión')
    expect(nombreCorrida('flujo:1:0:1')).toBe('Paso de flujo')
    expect(nombreCorrida('accion:5')).toBe('Acción aprobada')
    expect(nombreCorrida('coord:x')).toBe('Encargo del coordinador')
    expect(nombreCorrida('parte:x')).toBe('Parte del día')
    expect(nombreCorrida('informe')).toBe('informe')
  })
})

describe('Ejecuciones (tabla)', () => {
  test('el resultado se recorta a 2000 caracteres (grafemas, no bytes)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tareas-ejec-'))
    const store = new Store(path.join(dir, 'hq.db'))
    try {
      const ej = new Ejecuciones(store.db)
      ej.preparar()
      const id = ej.nueva({ oficina: '/o', tarea: 'informe-diario', agente: 'marce', programada: 1, inicio: 1, sid: '11111111-1111-4111-8111-111111111111', manual: true })
      ej.terminar(id, 'ok', 'ñ'.repeat(5000), undefined, undefined)
      const r = ej.una(id)!
      expect([...r.resultado].length).toBe(2000)
      expect(r.estado).toBe('ok')
      expect(r.manual).toBe(true)
      expect(r.fin).toBeDefined()
      expect(r.error).toBeUndefined()
      // lo que quedó «corriendo» pasa a «error» al preparar de nuevo
      const id2 = ej.nueva({ oficina: '/o', tarea: 'informe-diario', agente: 'marce', programada: 1, inicio: 2, sid: '', manual: false })
      ej.preparar()
      const r2 = ej.una(id2)!
      expect(r2.estado).toBe('error')
      expect(r2.error).toContain('Interrumpida')
      expect(r2.fin).toBeDefined()
      expect(ej.ultimaProgramada('/o', 'informe-diario')).toBe(1)
      expect(ej.ultimaProgramadaDesde('/o', 'informe-diario', 3)).toBeUndefined()
      expect(ej.ultimaProgramadaDesde('/o', 'informe-diario', 2)).toBe(1)
    } finally {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// MARK: - Programador con backend en proceso, reloj inyectado y claude falso

type Resp = { status: number; obj: Record<string, any> }

function arrancar(sb: Sandbox, env: Record<string, string> = {}): Backend {
  const e = {
    ...process.env, HOME: sb.home, HQ_HOME: sb.home, HQ_DATA_DIR: sb.datos, HQ_OFICINAS_DIR: sb.oficinasDir, HQ_PROGRAMADOR: '0', ...env,
  } as NodeJS.ProcessEnv
  if (e.HQ_PROGRAMADOR_INTERVALO !== undefined) delete e.HQ_PROGRAMADOR
  fs.mkdirSync(sb.datos, { recursive: true })
  return createBackend({ config: Config.load(sb.home, e), claudePath: sb.bin, env: e })
}

async function llamar(b: Backend, metodo: string, ruta: string, body?: unknown): Promise<Resp> {
  const r = await b.router.handle(metodo, ruta, {}, body === undefined ? undefined : Buffer.from(JSON.stringify(body)))
  return { status: r.status, obj: JSON.parse(r.json.toString('utf8')) }
}

async function oficina(b: Backend, agentes = ['marce', 'nico']) {
  const r = await llamar(b, 'POST', '/api/oficinas', { nombre: 'Taller', duenio: 'Ana', departamentos: ['Dirección'] })
  if (r.status !== 200) throw new Error(JSON.stringify(r.obj))
  for (const id of agentes) {
    const c = await llamar(b, 'POST', '/api/agentes', { id, nombre: id, rol: `Rol de ${id}`, prompt: `Sos ${id}.`, departamento: 'direccion' })
    if (c.status !== 200) throw new Error(JSON.stringify(c.obj))
  }
  return String(r.obj.carpeta)
}

describe('Programador: reloj inyectable y revisar()', () => {
  const nueva = (b: Backend, extra: Record<string, unknown> = {}) =>
    llamar(b, 'POST', '/api/tareas', { agente: 'marce', nombre: 'Informe diario', consigna: 'Armá el informe de ayer', dias: [1, 2, 3, 4, 5, 6, 7], hora: '08:00', zona: BA, ...extra })
  const tareaDe = (b: Backend, id: string) => b.oficinas.activa()!.oficina.tareas!.find((t) => t.id === id)!
  const ejecs = (b: Backend, carpeta: string, id: string) => programadorDe(b.servicios)!.ejecuciones.lista(carpeta, id)
  async function terminadas(b: Backend, carpeta: string, id: string, n: number) {
    const ok = await esperar(() => { const e = ejecs(b, carpeta, id); return e.length >= n && e.every((x) => x.estado !== 'corriendo') }, 15)
    expect(ok, 'las ejecuciones terminan').toBe(true)
    return ejecs(b, carpeta, id)
  }

  test('corre lo que toca, una sola vez por horario, y se pone al día una vez si pasaron menos de 12 h', async () => {
    const sb = new Sandbox()
    const b = arrancar(sb)
    onTestFinished(() => b.shutdown())
    const carpeta = await oficina(b)
    const prog = programadorDe(b.servicios)!
    let terminadasHook = 0
    prog.alTerminar((e) => { if (e.estado === 'ok' && e.tarea === 'informe-diario') terminadasHook++ })
    expect((await nueva(b)).status).toBe(200)
    const t = tareaDe(b, 'informe-diario')
    const sis = prog.sistema
    const p1 = Programacion.proxima(t, new Date(Date.now() + 2 * 86_400_000), sis)!
    prog.fijarReloj(() => new Date(p1.getTime() - 30_000))
    await prog.revisar()
    expect(ejecs(b, carpeta, 'informe-diario').length, 'todavía no es la hora').toBe(0)

    prog.fijarReloj(() => new Date(p1.getTime() + 5000))
    await prog.revisar()
    let es = await terminadas(b, carpeta, 'informe-diario', 1)
    expect(es.length).toBe(1)
    expect(es[0]!.manual).toBe(false)
    expect(es[0]!.estado).toBe('ok')
    expect(es[0]!.programada).toBe(p1.getTime() / 1000)
    prog.fijarReloj(() => new Date(p1.getTime() + 35_000))
    await prog.revisar()
    es = await terminadas(b, carpeta, 'informe-diario', 1)
    expect(es.length, 'nunca dos veces la misma').toBe(1)
    expect(sb.llamadas.length).toBe(1)
    expect(await esperar(() => terminadasHook === 1)).toBe(true)

    const p2 = Programacion.proxima(t, p1, sis)!
    prog.fijarReloj(() => new Date(p2.getTime() + 10_000))
    await prog.revisar()
    expect((await terminadas(b, carpeta, 'informe-diario', 2)).length).toBe(2)

    // app cerrada dos días: se pone al día solo la última, una vez
    const p4 = Programacion.proxima(t, new Date(p2.getTime() + 2 * 86_400_000), sis)!
    prog.fijarReloj(() => new Date(p4.getTime() + 11 * 3600_000))
    await prog.revisar()
    es = await terminadas(b, carpeta, 'informe-diario', 3)
    expect(es.length).toBe(3)
    expect(es[0]!.programada).toBe(p4.getTime() / 1000)
    await prog.revisar()
    expect((await terminadas(b, carpeta, 'informe-diario', 3)).length).toBe(3)

    // más de 12 h tarde se pierde
    const p5 = Programacion.proxima(t, p4, sis)!
    prog.fijarReloj(() => new Date(p5.getTime() + 13 * 3600_000))
    await prog.revisar()
    expect((await terminadas(b, carpeta, 'informe-diario', 3)).length).toBe(3)
  })

  test('no corre tareas en pausa, de agentes que no están, ni de una tarea recién creada con la hora ya pasada', async () => {
    const sb = new Sandbox()
    const b = arrancar(sb)
    onTestFinished(() => b.shutdown())
    const carpeta = await oficina(b)
    const prog = programadorDe(b.servicios)!
    expect((await nueva(b, { activa: false })).status).toBe(200)
    expect((await nueva(b, { agente: 'nico', nombre: 'De Nico' })).status).toBe(200)
    expect((await llamar(b, 'DELETE', '/api/agentes/nico')).status).toBe(200)
    expect((await nueva(b, { nombre: 'Nueva' })).status).toBe(200)
    const p = Programacion.anterior(tarea({ dias: [1, 2, 3, 4, 5, 6, 7] }), new Date(), prog.sistema)!
    prog.fijarReloj(() => new Date(p.getTime() + 3600_000))
    await prog.revisar()
    expect(sb.llamadas.length).toBe(0)
    for (const id of ['informe-diario', 'de-nico', 'nueva']) expect(ejecs(b, carpeta, id), id).toEqual([])
  })

  test('una sola vez: el programador la corre al llegar su hora (o días después) una sola vez; si falla no se reintenta sola', async () => {
    const sb = new Sandbox()
    const b = arrancar(sb)
    onTestFinished(() => b.shutdown())
    const carpeta = await oficina(b)
    const prog = programadorDe(b.servicios)!
    const unica = (extra: Record<string, unknown>) => llamar(b, 'POST', '/api/tareas', { agente: 'marce', nombre: 'Propuesta', consigna: 'Armá la propuesta', tipo: 'unica', fecha: '2099-03-10', hora: '09:00', zona: BA, ...extra })
    expect((await unica({})).status).toBe(200)
    const i = Programacion.instanteUnica(tareaDe(b, 'propuesta'), prog.sistema)!
    expect(iso(i)).toBe(iso(f('2099-03-10T09:00:00-03:00')))

    prog.fijarReloj(() => new Date(i.getTime() - 60_000))
    await prog.revisar()
    expect(ejecs(b, carpeta, 'propuesta').length).toBe(0)

    prog.fijarReloj(() => new Date(i.getTime() + 3 * 86_400_000))
    await prog.revisar()
    const es = await terminadas(b, carpeta, 'propuesta', 1)
    expect(es[0]!.estado).toBe('ok')
    expect(es[0]!.programada).toBe(i.getTime() / 1000)
    expect(await esperar(() => typeof tareaDe(b, 'propuesta').hecha === 'string')).toBe(true)
    expect(tareaDe(b, 'propuesta').activa).toBe(false)
    await prog.revisar()
    expect((await terminadas(b, carpeta, 'propuesta', 1)).length).toBe(1)

    // una que falla no se reintenta sola
    expect((await unica({ nombre: 'Mala', consigna: 'ISERR esto' })).status).toBe(200)
    await prog.revisar()
    expect((await terminadas(b, carpeta, 'mala', 1))[0]!.estado).toBe('error')
    await prog.revisar()
    expect((await terminadas(b, carpeta, 'mala', 1)).length).toBe(1)
    expect(tareaDe(b, 'mala').hecha).toBeUndefined()
    expect(tareaDe(b, 'mala').activa).toBe(true)

    // cambiarle el horario la vuelve a habilitar (el «desde» va en segundos)
    await new Promise((r) => setTimeout(r, 1100))
    expect((await llamar(b, 'PATCH', '/api/tareas/mala', { hora: '09:05', consigna: 'ahora sí' })).status).toBe(200)
    prog.fijarReloj(() => new Date(i.getTime() + 3 * 86_400_000 + 60_000))
    await prog.revisar()
    const dos = await terminadas(b, carpeta, 'mala', 2)
    expect(dos.length).toBe(2)
    expect(dos[0]!.estado).toBe('ok')
  })

  test('reinicio: lo que quedó «corriendo» pasa a «error» (interrumpida)', async () => {
    const sb = new Sandbox()
    const b = arrancar(sb)
    const carpeta = await oficina(b)
    expect((await nueva(b)).status).toBe(200)
    programadorDe(b.servicios)!.ejecuciones.nueva({ oficina: carpeta, tarea: 'informe-diario', agente: 'marce', programada: 1, inicio: 2, sid: '11111111-1111-4111-8111-111111111111', manual: false })
    await b.shutdown()
    const b2 = arrancar(sb)
    onTestFinished(() => b2.shutdown())
    const r = await llamar(b2, 'GET', '/api/tareas/informe-diario/ejecuciones')
    expect(r.status).toBe(200)
    const e = r.obj.ejecuciones[0]
    expect(e.estado).toBe('error')
    expect(e.error).toContain('Interrumpida')
    expect(e.fin).not.toBeNull()
  })

  test('el bucle automático arranca solo y corre lo que toca (intervalo corto)', async () => {
    const sb = new Sandbox()
    const b = arrancar(sb, { HQ_PROGRAMADOR_INTERVALO: '0.1' })
    onTestFinished(() => b.shutdown())
    const carpeta = await oficina(b)
    const prog = programadorDe(b.servicios)!
    expect((await nueva(b)).status).toBe(200)
    const p = Programacion.proxima(tareaDe(b, 'informe-diario'), new Date(Date.now() + 86_400_000), prog.sistema)!
    prog.fijarReloj(() => new Date(p.getTime() + 1000))
    expect(await esperar(() => ejecs(b, carpeta, 'informe-diario').length >= 1, 15)).toBe(true)
    expect((await terminadas(b, carpeta, 'informe-diario', 1))[0]!.estado).toBe('ok')
  })
})
