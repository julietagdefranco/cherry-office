// Port de app/Tests/BackendTests/PendientesTests.swift.
// Sin acceso a internals: `PendientesReunion.agente(de:en:)` queda como skip para los unit tests del port.
import { describe, expect, test } from 'vitest'
import { Fix, esperar, lista, str } from '../support/sandbox.js'

/** Caso real (reunión de Betty y Don Armando): los que el agente no puede hacer vienen marcados. */
const sintesis = `
{"resumen":"Se acordó una prueba visual.","decisiones":["Probar con un fragmento"],"pendientes":[
 {"quien":"Betty","que":"Leer oficina.md y decisiones.md para saber qué clase sigue","necesita_usuario":false},
 {"quien":"Betty","que":"Mandarle a Ana un mensaje con la decisión","necesita_usuario":true},
 {"quien":"Don Armando","que":"Probar transcribir.py con el fragmento limpio","necesita_usuario":true},
 {"quien":"Don Armando","que":"Pasarle a Betty capturas con y sin texto"},
 {"quien":"Ana","que":"Revisar el Calendar"}]}
`

describe('Pendientes de reunión', () => {
  test('al cerrar, cada pendiente llega a las notas de su agente; lo que necesita a la persona queda marcado y deja un aviso', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'betty', depto: 'direccion', rol: 'Asistente' }, { id: 'armando', depto: 'direccion', rol: 'Editor' }] })
    await f.patch('/api/agentes/armando', { nombre: 'Don Armando' })
    f.sb.responder('acta', sintesis)
    const r = await f.post('/api/reuniones', { tema: 'prueba visual', agentes: ['betty', 'armando'] })
    const id = str(r.obj.id)
    await esperar(async () => str((await f.get(`/api/reuniones/${id}`)).obj.estado) === 'esperando', 15)
    expect((await f.post(`/api/reuniones/${id}/cerrar`)).status).toBe(200)
    await esperar(async () => str((await f.get(`/api/reuniones/${id}`)).obj.estado) === 'cerrada', 15)

    const betty = f.leer('conocimiento/agentes/betty.md')
    expect(betty).toContain('## Pendientes de reuniones')
    expect(betty).toContain('reunión «prueba visual»: Leer oficina.md')
    expect(betty).toContain('Mandarle a Ana un mensaje con la decisión (necesita a la persona')
    expect(betty).not.toContain('transcribir.py')
    const arm = f.leer('conocimiento/agentes/armando.md')
    expect(arm).toContain('Probar transcribir.py con el fragmento limpio (necesita a la persona')
    expect(arm.includes('Pasarle a Betty capturas con y sin texto\n') || arm.endsWith('Pasarle a Betty capturas con y sin texto')).toBe(true)
    // 2 marcados + 1 asignado a la persona (Ana, la dueña) = 3 para vos
    const av = lista((await f.get('/api/avisos')).obj.avisos).find((a) => str(a.tipo) === 'pendiente') ?? {}
    expect(str(av.texto)).toContain('Quedaron 3 pendientes')
    expect(str(av.ref)).toBe(id)
    // el secretario recibe la consigna sobre lo que los agentes no pueden hacer
    expect(f.sb.prompts.map((p) => p.normalize('NFC')).some((p) => p.includes('necesita_usuario') && p.includes('asignalo a Ana'))).toBe(true)
    // una segunda reunión agrega a la misma sección, no la duplica
    const r2 = await f.post('/api/reuniones', { tema: 'otra', agentes: ['betty'] })
    const id2 = str(r2.obj.id)
    await esperar(async () => str((await f.get(`/api/reuniones/${id2}`)).obj.estado) === 'esperando', 15)
    await f.post(`/api/reuniones/${id2}/cerrar`)
    await esperar(async () => str((await f.get(`/api/reuniones/${id2}`)).obj.estado) === 'cerrada', 15)
    const b2 = f.leer('conocimiento/agentes/betty.md')
    expect(b2.split('## Pendientes de reuniones').length).toBe(2)
    expect(b2).toContain('reunión «otra»')
  })

  test.skip('responsable: por id, nombre o primera palabra única; la persona o un nombre ambiguo no son agentes', () => {
    // interno (unit test del port): PendientesReunion.agente(de:en:) sobre una Oficina en memoria (id, nombre, sin acentos, ambiguo, vacío).
  })
})
