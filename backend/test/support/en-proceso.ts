// Backend en proceso (createBackend + claude falso) para los unit tests de flujos, coordinador y parte.
import fs from 'node:fs'
import { createBackend, type Backend } from '../../src/backend.js'
import { Config } from '../../src/config.js'
import type { Sandbox } from './sandbox.js'

export type Resp = { status: number; obj: Record<string, any> }

/** Backend sin bucles de fondo (HQ_PROGRAMADOR=0) que se cierra solo al terminar el test. */
export function arrancar(sb: Sandbox, env: Record<string, string> = {}): Backend {
  const e = { ...process.env, HOME: sb.home, HQ_HOME: sb.home, HQ_DATA_DIR: sb.datos, HQ_OFICINAS_DIR: sb.oficinasDir, HQ_PROGRAMADOR: '0', ...env } as NodeJS.ProcessEnv
  fs.mkdirSync(sb.datos, { recursive: true })
  const b = createBackend({ config: Config.load(sb.home, e), claudePath: sb.bin, env: e })
  // lo cierra el sandbox antes de borrar su temporal (onTestFinished no garantiza el orden)
  sb.antesDeBorrar(() => b.shutdown())
  return b
}

export async function llamar(b: Backend, metodo: string, ruta: string, body?: unknown, query: Record<string, string> = {}): Promise<Resp> {
  const r = await b.router.handle(metodo, ruta, query, body === undefined ? undefined : Buffer.from(JSON.stringify(body)))
  return { status: r.status, obj: JSON.parse(r.json.toString('utf8')) }
}

/** Crea la oficina «Taller» (activa) con un departamento y los agentes dados; `permisos` por agente. Devuelve su carpeta. */
export async function oficina(b: Backend, agentes: (string | { id: string; permisos?: string[] })[] = ['marce']): Promise<string> {
  const r = await llamar(b, 'POST', '/api/oficinas', { nombre: 'Taller', duenio: 'Ana', departamentos: ['Dirección'] })
  if (r.status !== 200) throw new Error(JSON.stringify(r.obj))
  for (const a of agentes) {
    const { id, permisos } = typeof a === 'string' ? { id: a, permisos: undefined } : a
    const c = await llamar(b, 'POST', '/api/agentes', { id, nombre: id.charAt(0).toUpperCase() + id.slice(1), rol: `Rol de ${id}`, prompt: `Sos ${id}.`, departamento: 'direccion', ...(permisos ? { permisos } : {}) })
    if (c.status !== 200) throw new Error(JSON.stringify(c.obj))
  }
  return String(r.obj.carpeta)
}
