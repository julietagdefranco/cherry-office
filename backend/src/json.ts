// Cuerpos y respuestas JSON (Router.objeto / objetoOpcional / codificar de Swift).
import { ErrorAPI } from './errores.js'

export type Obj = Record<string, unknown>

/** Límite del cuerpo en el router (los routers con subidas tienen el suyo). */
export const maxBody = 200_000

/** JSON de respuesta. JS no escapa `/` (igual que `.withoutEscapingSlashes`). */
export function codificar(obj: unknown): Buffer {
  try {
    return Buffer.from(JSON.stringify(obj))
  } catch {
    return Buffer.from('{"error":"error interno"}')
  }
}

export const esObjeto = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Cuerpo JSON objeto (obligatorio). */
export function objeto(body: Buffer | undefined, max = maxBody): Obj {
  if (!body || body.length === 0) throw new ErrorAPI(400, 'pedido inválido')
  if (body.length > max) throw new ErrorAPI(413, 'pedido demasiado grande')
  let d: unknown
  try {
    d = JSON.parse(body.toString('utf8'))
  } catch {
    throw new ErrorAPI(400, 'pedido inválido')
  }
  if (!esObjeto(d)) throw new ErrorAPI(400, 'pedido inválido')
  return d
}

/** Cuerpo opcional: vacío = {}, pero si viene tiene que ser un objeto JSON. */
export function objetoOpcional(body: Buffer | undefined, max = maxBody): Obj {
  if (!body || body.length === 0) return {}
  return objeto(body, max)
}
