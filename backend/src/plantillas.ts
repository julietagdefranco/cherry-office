// Carpetas y archivos de una oficina, y la plantilla fija de los `.md` de agente (Plantillas.swift).
// Los textos son idénticos a los de Swift: los leen los agentes y los tests comparan contenido.
import fs from 'node:fs'
import path from 'node:path'
import type { Oficina } from './oficina.js'

export const marcaMemoria = '## Memoria de la oficina'

/** Carpetas de la biblioteca: material compartido, entregables, texto extraído, papelera y fichas. */
export const carpetasBiblioteca = ['archivos/compartido', 'archivos/entregables', 'archivos/.texto', 'archivos/.papelera', 'conocimiento/fuentes']

const base = ['conocimiento/agentes', 'reuniones', 'archivos', '.claude/agents']

/** Crea la estructura de una oficina nueva. Nunca pisa un archivo que ya existe. */
export function crearEstructura(carpeta: string, oficina: Oficina) {
  for (const d of [...base, ...carpetasBiblioteca, ...oficina.departamentos.map((x) => `archivos/${x.id}`)]) {
    fs.mkdirSync(path.join(carpeta, d), { recursive: true })
  }
  escribirSiFalta(carpeta, 'conocimiento/archivos.md', archivosMD())
  escribirSiFalta(carpeta, 'conocimiento/oficina.md', oficinaMD(oficina.nombre, oficina.duenio))
  escribirSiFalta(carpeta, 'conocimiento/decisiones.md', decisionesMD(oficina.nombre))
}

/** Al abrir una oficina existente: recrea las carpetas que falten (sin tocar contenido). */
export function completarEstructura(carpeta: string) {
  for (const d of [...base, ...carpetasBiblioteca]) fs.mkdirSync(path.join(carpeta, d), { recursive: true })
  escribirSiFalta(carpeta, 'conocimiento/archivos.md', archivosMD())
}

export function escribirSiFalta(carpeta: string, rel: string, texto: string) {
  const p = path.join(carpeta, rel)
  if (fs.existsSync(p)) return
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, texto)
}

// MARK: textos

export function oficinaMD(nombre: string, duenio: string): string {
  return `# ${nombre}

Memoria común de la oficina. Todos los agentes la leen al empezar; la edita ${duenio === '' ? 'el dueño' : duenio} y se completa con las decisiones de las reuniones.

- **Oficina:** ${nombre}
- **Dueño:** ${duenio === '' ? '(sin completar)' : duenio}

## Qué hace el negocio
(Completá acá: a qué se dedica, a quién le vende, productos o servicios, tono de voz.)

## Estado actual
(Qué está en marcha, fechas importantes, prioridades de la semana.)

## Reglas permanentes
(Cosas que ningún agente debe olvidar ni contradecir.)
`
}

export function decisionesMD(nombre: string): string {
  return `# Decisiones de ${nombre}

Decisiones confirmadas. Solo se agregan al final (nunca se borran ni se reescriben), con fecha.

Formato: \`- AAAA-MM-DD: decisión (contexto breve si hace falta).\`
`
}

/** Catálogo vacío (lo regenera la biblioteca a medida que se agregan documentos). */
export function archivosMD(): string {
  return `# Archivos de la oficina

Catálogo de documentos: una línea por documento. Para el detalle, leé su ficha en \`conocimiento/fuentes/<slug>.md\` y, si hace falta, el texto completo en \`archivos/.texto/<slug>.md\`.

(Todavía no hay documentos.)
`
}

export function notasAgenteMD(nombre: string, rol: string): string {
  return `# ${nombre}: notas de trabajo

Rol: ${rol}

Acá ${nombre} anota lo que va aprendiendo: en qué está, qué entregó, qué espera de quién. Solo hechos, breve.
`
}

/** Documenta las herramientas del servidor MCP de la oficina. Su presencia marca una sección al día. */
export const lineaConsultas = 'Podés consultar a un colega con la herramienta consultar(colega, pregunta) cuando necesites su mirada; usá colegas() para ver quiénes son. Máximo 3 consultas por mensaje.'

/** Sección fija con las rutas de memoria (relativas a la oficina). Sin salto de línea final. */
export function seccionMemoria(id: string): string {
  return `${marcaMemoria}
Tu carpeta de trabajo es la raíz de la oficina; todas las rutas son relativas a ella.
- Al empezar: leé \`conocimiento/oficina.md\` (contexto del negocio) y \`conocimiento/decisiones.md\` (decisiones confirmadas) y, si son relevantes para lo que te piden, las notas de otros agentes en \`conocimiento/agentes/<id>.md\`.
- Al terminar algo concreto (una entrega, un pedido que quedó esperando a alguien, un cambio de plan): actualizá con Edit o Write SOLO tu archivo \`conocimiento/agentes/${id}.md\`. Breve y solo hechos: en qué estás, qué entregaste, qué esperás de quién. Sin suposiciones.
- Conocimiento y archivos: \`conocimiento/archivos.md\` es el catálogo de documentos de la oficina (una línea por documento); leelo al empezar. Cada documento tiene su ficha en \`conocimiento/fuentes/<slug>.md\` y su texto en \`archivos/.texto/<slug>.md\`; el material original está en \`archivos/\` (\`compartido/\` es de todos, el resto por departamento). Para citar un documento, usá la ficha.
- Lo que produzcas para el usuario (informes, borradores, archivos) guardalo con Write en \`archivos/entregables/${id}/\`; esa es la única carpeta de archivos donde podés escribir.
- No podés escribir ningún otro archivo (el sistema lo impide igual). Si algo debería quedar como decisión, proponelo en una reunión o decile al usuario que lo registre.
- ${lineaConsultas}`
}

/** Al abrir una oficina: reescribe la sección de memoria de los `.md` de agente desactualizados (sin la línea de
 *  consultas). Solo toca desde la marca hasta el final. Idempotente. Devuelve cuántos reescribió. */
export function actualizarMemoria(carpeta: string, ids: string[]): number {
  let n = 0
  for (const id of ids) {
    const p = path.join(carpeta, '.claude/agents', `${id}.md`)
    let t: string
    try {
      t = fs.readFileSync(p, 'utf8')
    } catch {
      continue
    }
    const i = t.indexOf(marcaMemoria)
    if (i < 0 || t.includes(lineaConsultas)) continue
    try {
      const tmp = `${p}.tmp`
      fs.writeFileSync(tmp, t.slice(0, i) + seccionMemoria(id) + '\n')
      fs.renameSync(tmp, p)
      n++
    } catch {}
  }
  return n
}

// MARK: .md del agente

/** Valor YAML en una sola línea (entrecomillado y escapado si el valor plano no sería YAML válido o cambiaría de tipo). */
export function yamlLinea(s: string): string {
  const una = s.split(/[\n\r]/).map((x) => x.trim()).filter((x) => x !== '').join(' ')
  const reservadas = new Set(['null', '~', 'true', 'false', 'yes', 'no', 'on', 'off', 'y', 'n'])
  const sinControl = [...una].every((c) => { const u = c.codePointAt(0)!; return u >= 0x20 && u !== 0x7f })
  const peligroso = una === '' || '"\'[]{}&*!|>%@`#-?:,'.includes(una[0]!) || una.includes(' #') || una.includes(': ')
    || una.endsWith(':') || una.includes('"') || una.includes('\\') || !sinControl
    || reservadas.has(una.toLowerCase()) || esDoubleSwift(una)
  if (!peligroso) return una
  let esc = ''
  for (const c of una) {
    const u = c.codePointAt(0)!
    if (c === '\\') esc += '\\\\'
    else if (c === '"') esc += '\\"'
    else if (c === '\t') esc += '\\t'
    else if (u < 0x20 || u === 0x7f) esc += '\\u' + u.toString(16).toUpperCase().padStart(4, '0')
    else esc += c
  }
  return `"${esc}"`
}

/** Como `Double(s) != nil` de Swift: número decimal o hexadecimal, inf/infinity/nan, con signo opcional. */
function esDoubleSwift(s: string): boolean {
  return /^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|0[xX][0-9a-fA-F]+(\.[0-9a-fA-F]*)?([pP][+-]?\d+)?|inf|infinity|nan)$/i.test(s)
}

export function agenteMD(id: string, description: string, modelo: string, prompt: string): string {
  return `---
name: ${id}
description: ${yamlLinea(description)}
model: ${modelo}
---

${prompt.trim()}

${seccionMemoria(id)}
`
}

/** Partes de un `.md` de agente: líneas del frontmatter y cuerpo (lo que sigue a la línea de cierre `---`). */
export function partes(texto: string): { frontmatter: string[]; cuerpo: string } {
  const lineas = texto.split('\n')
  if (lineas[0]?.trim() !== '---') return { frontmatter: [], cuerpo: texto }
  const fin = lineas.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (fin < 0) return { frontmatter: [], cuerpo: texto }
  return { frontmatter: lineas.slice(1, fin), cuerpo: lineas.slice(fin + 1).join('\n') }
}

/** Valor de `clave:` en el frontmatter (una sola línea; sin comillas, desescapado). */
export function valorFrontmatter(fm: string[], clave: string): string | undefined {
  const l = fm.find((x) => x.startsWith(clave + ':'))
  if (l === undefined) return undefined
  const v = l.slice(clave.length + 1).trim()
  const f = v[0]
  if (f !== '"' && f !== "'") {
    const r = v.indexOf(' #')
    return r >= 0 ? v.slice(0, r).trim() : v
  }
  const c = [...v.slice(1)]
  let out = ''
  let i = 0
  while (i < c.length) {
    const u = c[i]!
    if (f === "'") {
      if (u === "'") {
        if (c[i + 1] === "'") { out += "'"; i += 2; continue }
        break
      }
      out += u; i++; continue
    }
    if (u === '"') break
    if (u !== '\\' || i + 1 >= c.length) { out += u; i++; continue }
    const e = c[i + 1]!
    i += 2
    switch (e) {
      case 'n': out += '\n'; break
      case 'r': out += '\r'; break
      case 't': out += '\t'; break
      case '0': out += '\0'; break
      case 'x': case 'u': case 'U': {
        const n = e === 'x' ? 2 : e === 'u' ? 4 : 8
        const hex = c.slice(i, i + n).join('')
        const code = /^[0-9a-fA-F]+$/.test(hex) && hex.length === n ? parseInt(hex, 16) : NaN
        if (Number.isFinite(code) && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) { out += String.fromCodePoint(code); i += n }
        else out += '\\' + e
        break
      }
      default: out += e
    }
  }
  return out
}

/** Reemplaza (o agrega) `clave: valor` en el frontmatter, descartando líneas de continuación del valor viejo. */
export function fijarFrontmatter(fm: string[], clave: string, valor: string): string[] {
  const out: string[] = []
  let puesto = false
  let saltando = false
  for (const l of fm) {
    if (l.startsWith(clave + ':')) { out.push(`${clave}: ${valor}`); puesto = true; saltando = true; continue }
    if (saltando && (l[0] === ' ' || l[0] === '\t')) continue
    saltando = false
    out.push(l)
  }
  if (!puesto) out.push(`${clave}: ${valor}`)
  return out
}

/** Prompt = cuerpo sin la sección fija de memoria (si la tiene). */
export function promptDe(cuerpo: string): string {
  const i = cuerpo.indexOf(marcaMemoria)
  return (i >= 0 ? cuerpo.slice(0, i) : cuerpo).trim()
}

// MARK: decisiones (para reuniones)

/** Agrega líneas `- AAAA-MM-DD: texto` al final de `conocimiento/decisiones.md` (append-only). */
export function anexarDecisiones(carpeta: string, decisiones: string[], fecha = new Date()) {
  if (decisiones.length === 0) return
  const p = path.join(carpeta, 'conocimiento/decisiones.md')
  const pad = (n: number) => String(n).padStart(2, '0')
  const dia = `${fecha.getFullYear()}-${pad(fecha.getMonth() + 1)}-${pad(fecha.getDate())}`
  let actual = ''
  try {
    actual = fs.readFileSync(p, 'utf8')
  } catch {}
  if (actual !== '' && !actual.endsWith('\n')) actual += '\n'
  for (const d of decisiones) {
    const una = d.split(/\r\n|[\n\r\u2028\u2029\u0085\u000b\u000c]/).filter((x) => x !== '').join(' ').trim()
    if (una !== '') actual += `- ${dia}: ${una}\n`
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, actual)
  fs.renameSync(tmp, p)
}
