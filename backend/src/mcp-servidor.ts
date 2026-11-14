// Servidor MCP de la oficina (MCPServidor.swift): HTTP en 127.0.0.1, puerto efímero, solo `POST /mcp`, respuestas JSON.
// Lo consumen los `claude` de los chats con `--mcp-config` y un token Bearer por corrida (MCPTokens).
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HQLog } from './log.js'
import { procesarMCP, type IdentidadMCP, type MCPHerramientas, type MCPTokens } from './mcp-protocolo.js'

export const maxCuerpoMCP = 1_000_000

export type HerramientasDe = (token: string, identidad: IdentidadMCP) => MCPHerramientas

type Resp = { status: number; tipo?: string; cabeceras?: Record<string, string>; cuerpo?: string }

export class MCPServidor {
  private readonly server = http.createServer((req, res) => void this.atender(req, res))
  private puerto?: Promise<number | undefined>
  private cerrado = false

  constructor(private readonly tokens: MCPTokens, private readonly herramientas: HerramientasDe, private readonly log: HQLog) {
    // un pedido por conexión, sin keep-alive; las conexiones colgadas se cortan a los 30 s
    this.server.keepAliveTimeout = 1
    this.server.headersTimeout = 30_000
    this.server.requestTimeout = 30_000
    this.puerto = new Promise<number | undefined>((resolve) => {
      this.server.once('error', (e) => {
        this.log.error(`mcp: ${e.message}`)
        resolve(undefined)
      })
      this.server.listen(0, '127.0.0.1', () => {
        const p = (this.server.address() as AddressInfo).port
        this.log.info(`mcp escuchando en 127.0.0.1:${p}`)
        resolve(p)
      })
    })
  }

  /** `http://127.0.0.1:PUERTO/mcp`, o undefined si el servidor no arrancó (el chat sigue sin consultas). */
  async url(): Promise<string | undefined> {
    if (this.cerrado) return undefined
    const p = await this.puerto
    return p === undefined || this.cerrado ? undefined : `http://127.0.0.1:${p}/mcp`
  }

  async cerrar(): Promise<void> {
    if (this.cerrado) return
    this.cerrado = true
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
      if (!this.server.listening) resolve()
    })
  }

  private async atender(req: http.IncomingMessage, res: http.ServerResponse) {
    let r: Resp
    try {
      const cuerpo = await leerCuerpo(req)
      r = cuerpo === undefined ? { status: 413 } : await this.manejar(req, cuerpo)
    } catch {
      r = { status: 500 }
    }
    const cab: Record<string, string> = { 'Content-Length': String(Buffer.byteLength(r.cuerpo ?? '')), Connection: 'close', ...r.cabeceras }
    if (r.tipo) cab['Content-Type'] = r.tipo
    res.writeHead(r.status, cab)
    res.end(r.cuerpo ?? '')
  }

  /** Un pedido HTTP completo -> la respuesta (lógica sin red, salvo la consulta a `claude`). */
  private async manejar(req: http.IncomingMessage, cuerpo: Buffer): Promise<Resp> {
    // contra DNS rebinding: solo se atiende con Host de loopback
    const host = (req.headers.host ?? '').toLowerCase()
    const sinPuerto = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1 || host.length) : (host.split(':')[0] ?? '')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(sinPuerto)) return { status: 403 }
    const ruta = (req.url ?? '').split('?')[0]
    if (ruta !== '/mcp') return { status: 404 }
    if (req.method !== 'POST') return { status: 405, cabeceras: { Allow: 'POST' } }
    // identidad: solo el token Bearer (sin cabecera o con un token revocado, 401)
    const auth = req.headers.authorization ?? ''
    if (!auth.toLowerCase().startsWith('bearer ')) return sinAutorizar()
    const token = auth.slice('bearer '.length).trim()
    const id = this.tokens.identidad(token)
    if (!id) return sinAutorizar()
    const r = await procesarMCP(cuerpo, this.herramientas(token, id))
    if (r === undefined) return { status: 202 }
    return { status: 200, tipo: 'application/json', cuerpo: r }
  }
}

const sinAutorizar = (): Resp => ({ status: 401, tipo: 'application/json', cabeceras: { 'WWW-Authenticate': 'Bearer' }, cuerpo: '{"error":"no autorizado"}' })

/** undefined = el cuerpo pasa del máximo. */
function leerCuerpo(req: http.IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = []
    let n = 0
    let excedido = false
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > maxCuerpoMCP) excedido = true
      else partes.push(c)
    })
    req.on('end', () => resolve(excedido ? undefined : Buffer.concat(partes)))
    req.on('error', reject)
  })
}
