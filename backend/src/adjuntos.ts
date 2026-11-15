// Archivos que la persona le pasa a un agente (Adjuntos.swift): en el chat, al arrancar una corrida de flujo y en las tareas.
// Viajan en base64 dentro del JSON (`archivos: [{nombre, base64}]`), se guardan dentro de la oficina en
// `archivos/adjuntos/<origen>/<AAAAMMDD-HHMMSS>/` y el agente recibe sus rutas (relativas a la oficina, su carpeta de trabajo)
// al final del mensaje, para leerlos con Read (que también lee imágenes y PDF).
import fs from 'node:fs'
import path from 'node:path'
import { ErrorAPI } from './errores.js'
import { rutaLibre } from './extraccion.js'
import { esObjeto, type Obj } from './json.js'
import type { OficinaActiva } from './oficinas.js'
import { Validar, largo } from './validar.js'

export type Adjunto = { nombre: string; datos: Buffer }

/** Base64 como `Data(base64Encoded:options:.ignoreUnknownCharacters)`: salta lo que no es del alfabeto y exige el relleno. */
function base64(t: string): Buffer | undefined {
  const limpio = t.replace(/[^A-Za-z0-9+/=]/g, '')
  if (limpio.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(limpio)) return undefined
  return Buffer.from(limpio, 'base64')
}

const control = (t: string) => [...t].some((ch) => { const v = ch.codePointAt(0)!; return v < 32 || v === 127 })

export const Adjuntos = {
  maxArchivos: 10,
  /** Tope del total decodificado de un pedido (y por lo tanto de cada archivo). */
  maxTotal: 25 * 1_048_576,
  maxNombre: 120,
  /** Cuerpo de un pedido con adjuntos: el total en base64 (4/3) más el resto del pedido. Entra en el tope del servidor. */
  get maxBody() { return Math.floor((this.maxTotal * 4) / 3) + 300_000 },
  carpeta: 'archivos/adjuntos',
  /** Encabezado del bloque de adjuntos en el mensaje (el front lo reconoce para mostrar los archivos). */
  encabezado: 'Archivos adjuntos (leelos con Read antes de responder):',

  /** `archivos` del cuerpo; ausente o null = ninguno. Valida todo antes de guardar nada. */
  leer(v: unknown): Adjunto[] {
    if (v === undefined || v === null) return []
    if (!Array.isArray(v) || !v.every(esObjeto)) throw new ErrorAPI(400, '«archivos» tiene que ser una lista de {nombre, base64}.')
    if (v.length > Adjuntos.maxArchivos) throw new ErrorAPI(400, `Máximo ${Adjuntos.maxArchivos} archivos por vez.`)
    const mb = Adjuntos.maxTotal / 1_048_576
    const out: Adjunto[] = []
    let total = 0
    for (const a of v as Obj[]) {
      const crudo = Validar.texto(a.nombre, 'nombre del archivo', Adjuntos.maxNombre)!
      const n = Adjuntos.nombreValido(crudo)
      if (n === undefined) {
        throw new ErrorAPI(400, `El nombre de archivo «${crudo}» no es válido (sin «/» ni «..», hasta ${Adjuntos.maxNombre} caracteres).`)
      }
      let b64 = typeof a.base64 === 'string' ? a.base64 : ''
      if (b64 === '') throw new ErrorAPI(400, `Falta el contenido de «${n}» (base64).`)
      if (b64.startsWith('data:')) {
        const i = b64.indexOf(',')
        if (i >= 0) b64 = b64.slice(i + 1)
      }
      if (Buffer.byteLength(b64) > Math.floor((Adjuntos.maxTotal * 4) / 3) + 8) {
        throw new ErrorAPI(413, `«${n}» es demasiado grande (el máximo es ${mb} MB).`)
      }
      const datos = base64(b64)
      if (!datos || datos.length === 0) throw new ErrorAPI(400, `El contenido de «${n}» no es base64 válido.`)
      total += datos.length
      if (total > Adjuntos.maxTotal) throw new ErrorAPI(413, `Los archivos pesan más de ${mb} MB en total.`)
      out.push({ nombre: n, datos })
    }
    return out
  },

  /** Nombre de archivo seguro (sin carpetas ni caracteres de control), o undefined. */
  nombreValido(n: string): string | undefined {
    const t = n.trim()
    if (t === '' || largo(t) > Adjuntos.maxNombre || t === '.' || t.includes('/') || t.includes('\\') || t.includes('..') || control(t)) return undefined
    return t
  },

  /** Guarda los archivos en una carpeta nueva de `archivos/adjuntos/<origen>/` y devuelve sus rutas relativas a la oficina.
   *  `origen`: "chat/<agente>", "flujos/<flujo>", "tareas/<agente>"… (ids ya validados). */
  guardar(act: OficinaActiva, origen: string, archivos: Adjunto[], ahora: Date = new Date()): string[] {
    if (archivos.length === 0) return []
    const sello = ahora.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
    const padre = `${Adjuntos.carpeta}/${origen}`
    const rutas: string[] = []
    try {
      fs.mkdirSync(act.ruta(padre), { recursive: true })
      const dir = rutaLibre(act.ruta(padre), sello)
      fs.mkdirSync(dir, { recursive: true })
      const relDir = `${padre}/${path.basename(dir)}`
      for (const a of archivos) {
        const destino = rutaLibre(dir, a.nombre)
        fs.writeFileSync(destino, a.datos)
        rutas.push(`${relDir}/${path.basename(destino)}`)
      }
    } catch {
      throw new ErrorAPI(500, 'No pude guardar los archivos adjuntos.')
    }
    return rutas
  },

  /** Bloque que va al final del mensaje del agente (vacío si no hay adjuntos). */
  texto(rutas: string[]): string {
    return rutas.length === 0 ? '' : `\n\n${Adjuntos.encabezado}\n` + rutas.map((r) => `- ${r}`).join('\n')
  },

  /** Ruta relativa de un adjunto ya guardado (la que se le puede dejar a una tarea): dentro de `archivos/adjuntos/`. */
  rutaValida(r: string): boolean {
    return r.startsWith(Adjuntos.carpeta + '/') && !r.includes('..') && !r.includes('\\') && largo(r) <= 400 && !control(r)
  },
}
