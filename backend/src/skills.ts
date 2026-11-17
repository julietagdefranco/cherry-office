// Skills de Claude Code en las corridas de los agentes. La herramienta Skill le muestra al modelo la lista de skills y
// plugins de la persona en cada llamada, y eso pesa (medido con el claude real: ~7 mil tokens con 40 skills). Modos:
// - `resumidas`: todas, con la descripción recortada (`skillListingMaxDescChars`): menos de la mitad y las sigue eligiendo
//   bien (probado pidiendo una presentación y una planilla).
// - `completas`: todas, tal cual (como era antes).
// - `agente`: solo las que el agente tiene elegidas en su ficha (`skillOverrides: off` para las demás); sin ninguna, sin Skill.
// - `ninguna`: sin la herramienta Skill.
// Las reglas `--disallowedTools Skill(x)` NO achican la lista (probado): por eso va con `--settings`.
import fs from 'node:fs'
import path from 'node:path'
import { esObjeto } from './json.js'

export type ModoSkills = 'resumidas' | 'completas' | 'agente' | 'ninguna'
export const modosSkills: ModoSkills[] = ['resumidas', 'completas', 'agente', 'ninguna']
export const esModoSkills = (v: unknown): v is ModoSkills => typeof v === 'string' && (modosSkills as string[]).includes(v)
/** Los booleanos de la primera versión de «Consumo de IA»: prendidas = completas, apagadas = ninguna. */
export function modoSkillsDe(v: unknown): ModoSkills | undefined {
  if (esModoSkills(v)) return v
  if (v === true) return 'completas'
  if (v === false) return 'ninguna'
  return undefined
}

/** Caracteres de la descripción de cada skill en modo `resumidas`. */
export const largoResumido = 150

/** Skills instaladas que vio la última corrida (`skills` del `system/init`), guardadas en `skills.json` de la carpeta de
 *  datos. Hacen falta para apagar las que no eligió un agente (skillOverrides va por nombre). */
export class CatalogoSkills {
  private nombres?: string[]
  constructor(private readonly archivo?: string) {
    if (!archivo) return
    try {
      const o: unknown = JSON.parse(fs.readFileSync(archivo, 'utf8'))
      if (esObjeto(o) && Array.isArray(o.skills) && o.skills.every((x) => typeof x === 'string')) this.nombres = o.skills as string[]
    } catch {}
  }
  get lista(): string[] | undefined { return this.nombres ? [...this.nombres] : undefined }
  fijar(l: string[]) {
    const n = [...new Set(l.filter((x) => typeof x === 'string' && x !== ''))].sort()
    if (this.nombres && n.length === this.nombres.length && n.every((x, i) => x === this.nombres![i])) return
    this.nombres = n
    if (!this.archivo) return
    try {
      fs.mkdirSync(path.dirname(this.archivo), { recursive: true })
      fs.writeFileSync(this.archivo, JSON.stringify({ skills: n }))
    } catch {}
  }
}

/** `--settings` de una corrida según el modo, o undefined si no hace falta (completas, ninguna, o sin datos). `undefined`
 *  en `elegidas` + modo `agente` no pasa: el llamador ya sacó la herramienta Skill. */
export function settingsSkills(modo: ModoSkills, elegidas: string[], catalogo: string[] | undefined): Record<string, unknown> | undefined {
  if (modo === 'resumidas') return { skillListingMaxDescChars: largoResumido }
  if (modo !== 'agente') return undefined
  // sin catálogo todavía (primera corrida): resumidas, y la próxima ya sabe cuáles apagar
  if (!catalogo) return { skillListingMaxDescChars: largoResumido }
  const off: Record<string, string> = {}
  for (const s of catalogo) if (!elegidas.includes(s)) off[s] = 'off'
  return { skillOverrides: off }
}
