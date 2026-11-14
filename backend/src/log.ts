// Log de la app: archivo rotativo hq.log (1 MB, 3 copias), como HQLog de Swift. Nunca recibe contenido de mensajes.
// Escritura sincrónica: líneas cortas y pocas; así no hay que esperar una cola al cerrar.
import fs from 'node:fs'
import path from 'node:path'

const copias = 3

function fecha(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export class HQLog {
  private readonly archivo?: string
  private tam = -1

  /** `dir` undefined -> no escribe (tests). */
  constructor(dir?: string, private readonly maxBytes = 1_000_000) {
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch {}
      this.archivo = path.join(dir, 'hq.log')
    }
  }

  info(m: string) { this.escribir('INFO', m) }
  warn(m: string) { this.escribir('WARNING', m) }
  error(m: string) { this.escribir('ERROR', m) }
  /** Compatibilidad con HQLog.flush (la escritura ya es sincrónica). */
  flush() {}

  private escribir(nivel: string, m: string) {
    if (!this.archivo) return
    const linea = Buffer.from(`${fecha()} ${nivel} ${m}\n`)
    try {
      if (this.tam < 0) this.tam = fs.existsSync(this.archivo) ? fs.statSync(this.archivo).size : 0
      if (this.tam + linea.length > this.maxBytes) this.rotar()
      fs.appendFileSync(this.archivo, linea)
      this.tam += linea.length
    } catch {}
  }

  private rotar() {
    const a = this.archivo!
    fs.rmSync(`${a}.${copias}`, { force: true })
    for (let i = copias - 1; i >= 1; i--) {
      if (fs.existsSync(`${a}.${i}`)) fs.renameSync(`${a}.${i}`, `${a}.${i + 1}`)
    }
    if (fs.existsSync(a)) fs.renameSync(a, `${a}.1`)
    this.tam = 0
  }
}
