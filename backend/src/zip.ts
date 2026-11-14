// Leer y escribir .zip sin programas del sistema (en Swift: /usr/bin/ditto y zipinfo). Usa `fflate` para el deflate.
//   - leerDirectorio: lista las entradas leyendo el directorio central, SIN descomprimir nada (para revisar el zip antes).
//   - extraerEntrada: descomprime de a pedazos al disco, sin pasarse del tamaño declarado.
//   - escribirZip: arma el .zip de a pedazos desde una lista de carpetas y archivos.
import fs from 'node:fs'
import { Inflate, Zip, ZipDeflate } from 'fflate'

export class ErrorZip extends Error {
  constructor(readonly causa: 'invalido' | 'demasiadas' | 'tam', m: string) {
    super(m)
    this.name = 'ErrorZip'
  }
}

export type EntradaZip = {
  /** Nombre tal cual está en el zip (con `/` o `\`). */
  nombre: string
  tam: number
  comprimido: number
  metodo: number
  cifrado: boolean
  enlace: boolean
  /** Posición del encabezado local. */
  offset: number
}

const FIRMA_FIN = 0x06054b50
const FIRMA_FIN64 = 0x06064b50
const FIRMA_LOC64 = 0x07064b50
const FIRMA_CD = 0x02014b50
const FIRMA_LOCAL = 0x04034b50
const maxDirectorio = 256 * 1024 * 1024

function leer(fd: number, pos: number, n: number): Buffer {
  const b = Buffer.alloc(n)
  let hecho = 0
  while (hecho < n) {
    const r = fs.readSync(fd, b, hecho, n - hecho, pos + hecho)
    if (r <= 0) throw new ErrorZip('invalido', 'zip truncado')
    hecho += r
  }
  return b
}

const u64 = (b: Buffer, o: number) => Number(b.readBigUInt64LE(o))

/** Entradas del zip (directorio central). `maxEntradas`: tope de cantidad (lanza `demasiadas`). */
export function leerDirectorio(fd: number, tamArchivo: number, maxEntradas: number): EntradaZip[] {
  if (tamArchivo < 22) throw new ErrorZip('invalido', 'no es un zip')
  const cola = Math.min(tamArchivo, 22 + 0xffff)
  const fin = leer(fd, tamArchivo - cola, cola)
  let i = cola - 22
  while (i >= 0 && fin.readUInt32LE(i) !== FIRMA_FIN) i--
  if (i < 0) throw new ErrorZip('invalido', 'no es un zip')
  let total = fin.readUInt16LE(i + 10)
  let tamCD = fin.readUInt32LE(i + 12)
  let offCD = fin.readUInt32LE(i + 16)
  const posFin = tamArchivo - cola + i
  if (total === 0xffff || tamCD === 0xffffffff || offCD === 0xffffffff) {
    if (posFin < 20) throw new ErrorZip('invalido', 'zip64 roto')
    const loc = leer(fd, posFin - 20, 20)
    if (loc.readUInt32LE(0) !== FIRMA_LOC64) throw new ErrorZip('invalido', 'zip64 roto')
    const e64 = leer(fd, u64(loc, 8), 56)
    if (e64.readUInt32LE(0) !== FIRMA_FIN64) throw new ErrorZip('invalido', 'zip64 roto')
    total = u64(e64, 32)
    tamCD = u64(e64, 40)
    offCD = u64(e64, 48)
  }
  if (total > maxEntradas) throw new ErrorZip('demasiadas', 'demasiadas entradas')
  if (tamCD > maxDirectorio || offCD + tamCD > tamArchivo) throw new ErrorZip('invalido', 'directorio central inválido')
  const cd = leer(fd, offCD, tamCD)
  const out: EntradaZip[] = []
  let p = 0
  for (let n = 0; n < total; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== FIRMA_CD) throw new ErrorZip('invalido', 'directorio central inválido')
    const hecha = cd.readUInt16LE(p + 4)
    const flags = cd.readUInt16LE(p + 8)
    const metodo = cd.readUInt16LE(p + 10)
    let comprimido = cd.readUInt32LE(p + 20)
    let tam = cd.readUInt32LE(p + 24)
    const largoNombre = cd.readUInt16LE(p + 28)
    const largoExtra = cd.readUInt16LE(p + 30)
    const largoComentario = cd.readUInt16LE(p + 32)
    const externos = cd.readUInt32LE(p + 38)
    let offset = cd.readUInt32LE(p + 42)
    const sigue = p + 46 + largoNombre + largoExtra + largoComentario
    if (sigue > cd.length) throw new ErrorZip('invalido', 'directorio central inválido')
    const nombre = cd.toString('utf8', p + 46, p + 46 + largoNombre)
    // campo extra zip64 (0x0001): los valores que valían 0xFFFFFFFF, en orden tam, comprimido, offset
    let e = p + 46 + largoNombre
    const finExtra = e + largoExtra
    while (e + 4 <= finExtra) {
      const id = cd.readUInt16LE(e)
      const largo = cd.readUInt16LE(e + 2)
      if (id === 0x0001) {
        let q = e + 4
        const lee64 = () => { const v = q + 8 <= e + 4 + largo ? u64(cd, q) : 0; q += 8; return v }
        if (tam === 0xffffffff) tam = lee64()
        if (comprimido === 0xffffffff) comprimido = lee64()
        if (offset === 0xffffffff) offset = lee64()
      }
      e += 4 + largo
    }
    const enlace = hecha >> 8 === 3 && ((externos >>> 16) & 0o170000) === 0o120000
    out.push({ nombre, tam, comprimido, metodo, cifrado: (flags & 1) !== 0, enlace, offset })
    p = sigue
  }
  return out
}

/** Descomprime la entrada en `destino` (de a pedazos). Lanza ErrorZip('tam') si pasa de `maxBytes` o de lo que declaró. */
export async function extraerEntrada(fd: number, e: EntradaZip, destino: string, maxBytes: number): Promise<number> {
  if (e.cifrado || (e.metodo !== 0 && e.metodo !== 8)) throw new ErrorZip('invalido', 'método no soportado')
  const loc = leer(fd, e.offset, 30)
  if (loc.readUInt32LE(0) !== FIRMA_LOCAL) throw new ErrorZip('invalido', 'encabezado local inválido')
  let pos = e.offset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28)
  const limite = Math.min(e.tam, maxBytes)
  let escrito = 0
  const sal = await fs.promises.open(destino, 'w')
  try {
    let pendientes: Uint8Array[] = []
    const inf = e.metodo === 8 ? new Inflate((chunk) => { pendientes.push(chunk) }) : undefined
    const vaciar = async () => {
      const lote = pendientes
      pendientes = []
      for (const c of lote) {
        escrito += c.length
        if (escrito > limite) throw new ErrorZip('tam', 'pasa del tamaño declarado')
        await sal.write(c)
      }
    }
    let falta = e.comprimido
    if (falta === 0 && inf) inf.push(new Uint8Array(0), true)
    while (falta > 0) {
      const n = Math.min(falta, 1 << 20)
      const trozo = leer(fd, pos, n)
      pos += n
      falta -= n
      if (inf) {
        try {
          inf.push(trozo, falta === 0)
        } catch {
          throw new ErrorZip('invalido', 'datos corruptos')
        }
      } else {
        pendientes.push(trozo)
      }
      await vaciar()
    }
    await vaciar()
    if (escrito !== e.tam) throw new ErrorZip('invalido', 'el tamaño no coincide')
  } finally {
    await sal.close()
  }
  return escrito
}

/** Una entrada a escribir: carpeta (`dir`) o archivo con su ruta en el disco. */
export type ParaZip = { nombre: string; dir: true } | { nombre: string; dir?: false; ruta: string }

/** Arma el .zip de a pedazos. Los nombres usan `/`; las carpetas llevan `/` al final. */
export async function escribirZip(destino: string, entradas: ParaZip[]): Promise<void> {
  const sal = await fs.promises.open(destino, 'w')
  try {
    let pendientes: Uint8Array[] = []
    let error: Error | undefined
    const zip = new Zip((err, chunk) => {
      if (err) error = err
      else pendientes.push(chunk)
    })
    const vaciar = async () => {
      if (error) throw error
      const lote = pendientes
      pendientes = []
      for (const c of lote) await sal.write(c)
    }
    const agregar = (nombre: string, esDir: boolean) => {
      const f = new ZipDeflate(nombre, { level: esDir ? 0 : 6 })
      f.os = 3
      f.attrs = esDir ? ((0o040755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0
      zip.add(f)
      return f
    }
    for (const e of entradas) {
      if (e.dir) {
        agregar(e.nombre.endsWith('/') ? e.nombre : e.nombre + '/', true).push(new Uint8Array(0), true)
        await vaciar()
        continue
      }
      const f = agregar(e.nombre, false)
      const ent = await fs.promises.open(e.ruta, 'r')
      try {
        const buf = Buffer.alloc(1 << 20)
        for (;;) {
          const { bytesRead } = await ent.read(buf, 0, buf.length, null)
          if (bytesRead === 0) break
          f.push(Uint8Array.prototype.slice.call(buf, 0, bytesRead), false)
          await vaciar()
        }
        f.push(new Uint8Array(0), true)
      } finally {
        await ent.close()
      }
      await vaciar()
    }
    zip.end()
    await vaciar()
  } finally {
    await sal.close()
  }
}
