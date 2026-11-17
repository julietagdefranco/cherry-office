// Del chat a las tareas (docs/plan-chat-a-tareas.md): `POST /api/chat/tareas` lee una charla con un agente y propone el
// trabajo que quedó por hacer, como pendientes con responsable y una consigna que se entiende sola. No guarda nada: la
// persona revisa la propuesta en la interfaz y recién ahí se crean las tareas (con `POST /api/tareas`, origen `{chat}`).
//
// La extracción va aparte (`correrSinAgente`, como la síntesis de una reunión): no usa ni ensucia la sesión del agente.
import { ClaudeError } from './claude-runner.js'
import { esObjeto, objeto, type Obj } from './json.js'
import type { AgenteDef, Oficina } from './oficina.js'
import { maxTranscripcionActa, parsearPendientes, PendientesReunion, type Pendiente } from './reuniones.js'
import { atrapar, no405, type Query, type SubRouter } from './router.js'
import { registrarModulo, type Servicios } from './servicios.js'
import type { Mensaje } from './store.js'
import { CajaCosto } from './stream.js'
import { ValidarTareas } from './tareas.js'
import { largo, uuidValido } from './validar.js'

/** Una tarea propuesta, ya resuelta contra la oficina. */
export type TareaPropuesta = {
  quien: string
  /** Agente que la hace; undefined = la persona. */
  agente?: string
  nombre: string
  consigna: string
  /** La hace (o la termina) la persona: no se crea como tarea. */
  usuario: boolean
  /** Índices (0-based) de otras propuestas que tienen que estar hechas antes. */
  dependeDe: number[]
}

export const ChatTareas = {
  /** Tope de propuestas por charla (las que sobran se descartan). */
  maxPropuestas: 20,
  marca: 'Sos quien ordena el trabajo de la oficina',

  /** Transcripción «Nombre: texto», sin los mensajes de error; si pasa de `max` se queda con lo más reciente. */
  transcripcion(mensajes: Mensaje[], oficina: Oficina, agente: AgenteDef, max = maxTranscripcionActa): string {
    const persona = oficina.duenio === '' ? 'Persona' : oficina.duenio
    const out = mensajes.filter((m) => !m.e).map((m) => `${m.r === 'u' ? persona : agente.nombre}: ${m.t}`).join('\n\n')
    return largo(out) > max ? '[…]\n' + Array.from(out).slice(-max).join('') : out
  },

  prompt(p: { oficina: Oficina; agente: AgenteDef; mensajes: Mensaje[] }): string {
    const { oficina: of, agente: a } = p
    const persona = of.duenio === '' ? 'la persona dueña de la oficina' : of.duenio
    const equipo = of.agentes.map((x) => `- ${x.nombre} (${x.rol})`).join('\n')
    return `${ChatTareas.marca} «${of.nombre}». ${persona} charló con ${a.nombre} (${a.rol}) y quiere convertir esa charla en tareas.

Equipo de la oficina:
${equipo}

Charla:
${ChatTareas.transcripcion(p.mensajes, of, a)}

Devolvé SOLO un objeto JSON estricto (sin texto antes ni después, sin bloques de código) con esta forma:
{"pendientes": [{"quien": "nombre de quien se encarga", "nombre": "título corto", "consigna": "qué hay que hacer", "necesita_usuario": false, "depende_de": []}]}
Reglas:
- Solo el trabajo que quedó por hacer en la charla: no inventes tareas ni repitas lo que ya se hizo. Si no queda nada, lista vacía.
- "consigna": quien la lea NO vio la charla. Escribila completa: qué hacer, para qué, con qué datos, decisiones o archivos que se mencionaron, y qué entregar. Máximo ${ValidarTareas.maxConsigna} caracteres.
- "nombre": título de 3 a 8 palabras (máximo ${ValidarTareas.maxNombre} caracteres).
- "quien": por defecto ${a.nombre}. Si otra persona del equipo es claramente mejor para esa tarea, o la charla dice que la haga otro, usá su nombre exacto.
- En "depende_de" poné los números (empezando en 1, en el orden de la lista) de otras tareas que tienen que estar hechas antes; si no depende de ninguna, lista vacía.${PendientesReunion.consignaSecretario(of.duenio)}`
  },

  /** Respuesta del modelo → propuestas resueltas contra la oficina. undefined si no se puede leer. */
  parsear(t: string, oficina: Oficina, agente: AgenteDef, descartado?: (motivo: string) => void): TareaPropuesta[] | undefined {
    const a = t.indexOf('{')
    const b = t.lastIndexOf('}')
    if (a < 0 || b < 0 || a >= b) return undefined
    let o: unknown
    try { o = JSON.parse(t.slice(a, b + 1)) } catch { return undefined }
    if (!esObjeto(o) || !Array.isArray(o.pendientes)) return undefined
    const pend = parsearPendientes(o.pendientes.slice(0, ChatTareas.maxPropuestas), 1, descartado)
    return pend.map((p) => ChatTareas.resolver(p, oficina, agente))
  },

  resolver(p: Pendiente, oficina: Oficina, agente: AgenteDef): TareaPropuesta {
    const def = p.quien === '' ? (p.usuario ? undefined : agente) : PendientesReunion.agente(p.quien, oficina)
    const consigna = recortar(p.que, ValidarTareas.maxConsigna)
    const r: TareaPropuesta = {
      quien: def?.nombre ?? (p.quien || (oficina.duenio === '' ? 'Vos' : oficina.duenio)),
      nombre: recortar(p.nombre ?? nombreDe(consigna), ValidarTareas.maxNombre),
      consigna,
      usuario: p.usuario || def === undefined,
      dependeDe: p.dependeDe ?? [],
    }
    if (def) r.agente = def.id
    return r
  },

  json(p: TareaPropuesta): Obj {
    return { quien: p.quien, agente: p.agente ?? null, nombre: p.nombre, consigna: p.consigna, usuario: p.usuario, dependeDe: p.dependeDe }
  },
}

const recortar = (s: string, n: number) => (largo(s) > n ? Array.from(s).slice(0, n - 1).join('').trimEnd() + '…' : s)

/** Si el modelo no puso título: las primeras palabras de la consigna, sin el punto final. */
function nombreDe(consigna: string): string {
  const primera = consigna.split(/[.\n]/)[0] ?? consigna
  const palabras = primera.split(/\s+/).filter((x) => x !== '')
  return palabras.slice(0, 8).join(' ') + (palabras.length > 8 ? '…' : '')
}

/** `/api/chat/tareas`. */
export class ChatTareasRouter implements SubRouter {
  private readonly timeout: number
  /** Charlas que se están leyendo ahora (oficina + sesión): una sola a la vez por charla. */
  private readonly enCurso = new Set<string>()

  constructor(private readonly s: Servicios) {
    const n = Number(s.env.HQ_CHAT_TAREAS_TIMEOUT)
    this.timeout = s.env.HQ_CHAT_TAREAS_TIMEOUT !== undefined && s.env.HQ_CHAT_TAREAS_TIMEOUT !== '' && Number.isFinite(n) ? n : 180
  }

  async handle(method: string, path: string, _q: Query, body?: Buffer) {
    if (path !== '/api/chat/tareas') return null
    return atrapar(async () => {
      if (method !== 'POST') return no405
      const { store, runner, oficinas, log } = this.s
      const act = oficinas.requerirActiva()
      const b = objeto(body)
      const def = typeof b.agent === 'string' ? act.oficina.agentes.find((a) => a.id === b.agent) : undefined
      if (!def || typeof b.session !== 'string' || !uuidValido(b.session)) return [400, { error: 'pedido inválido' }]
      const sid = b.session.toLowerCase()
      if (store.agenteDe(sid) !== def.id || store.oficinaDe(sid) !== act.carpeta) return [404, { error: 'No encontré esa charla.' }]
      const mensajes = store.mensajes(sid).filter((m) => !m.e)
      if (!mensajes.some((m) => m.r === 'u')) return [200, { pendientes: [] }]
      const clave = act.carpeta + '\u001f' + sid
      if (this.enCurso.has(clave)) return [409, { error: 'Ya estoy leyendo esta charla.' }]
      this.enCurso.add(clave)
      const caja = new CajaCosto()
      const t0 = Date.now()
      try {
        let t: string
        try {
          t = await runner.correrSinAgente(ChatTareas.prompt({ oficina: act.oficina, agente: def, mensajes }), { timeout: this.timeout, cwd: act.carpeta, obs: caja.observador() })
        } catch (e) {
          if (e instanceof ClaudeError) return [502, { error: e.mensaje }]
          throw e
        }
        const ps = ChatTareas.parsear(t, act.oficina, def, (m) => log.info(`chat-tareas: dependencia descartada: ${m}`))
        if (!ps) return [502, { error: 'No pude leer la propuesta de tareas. Probá de nuevo.' }]
        log.info(`chat-tareas agente=${def.id} sid=${sid.slice(0, 8)} propuestas=${ps.length} seg=${((Date.now() - t0) / 1000).toFixed(1)}`)
        return [200, { pendientes: ps.map(ChatTareas.json) }]
      } finally {
        this.enCurso.delete(clave)
        store.registrarCosto({ oficina: act.carpeta, agente: def.id, origen: 'chat-tareas', ref: sid, costo: caja.valor })
      }
    })
  }
}

registrarModulo('chat-tareas', 76, (s) => {
  s.router.registrarExtra(new ChatTareasRouter(s))
})
