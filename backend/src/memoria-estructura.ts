// Estructura en disco de la memoria de una oficina (plan-memoria.md): temas, histórico por mes, diario, índice y la
// migración mecánica de las oficinas viejas. Funciones de disco puras, sin `Servicios`: las usa el núcleo (`oficinas.ts`,
// `plantillas.ts`), así que no importa de `reuniones.ts` ni de `conocimiento.ts` para no armar ciclos.
import fs from 'node:fs'
import path from 'node:path'
import { escribirAtomico, type Oficina } from './oficina.js'
import { Slug, largo, prefijo } from './validar.js'

export const LimitesMemoria = {
  oficinaTokens: 1500,
  notasTokens: 1000,
  presupuestoTokens: 6000,
  maxTemas: 300,
  maxPendientes: 200,
  maxHecho: 600,
  maxTema: 80,
  maxResumen: 120,
}

/** Tokens ≈ caracteres / 4: alcanza para topes y avisos. */
export const tokensDe = (texto: string): number => Math.ceil(largo(texto) / 4)

const pad = (n: number) => String(n).padStart(2, '0')
/** `AAAA-MM-DD` en hora local (igual que `anexarDecisiones`). */
export const diaLocal = (f: Date = new Date()): string => `${f.getFullYear()}-${pad(f.getMonth() + 1)}-${pad(f.getDate())}`
/** `AAAA-MM` en hora local. */
export const mesLocal = (f: Date = new Date()): string => `${f.getFullYear()}-${pad(f.getMonth() + 1)}`
/** `HH:MM` en hora local. */
export const horaLocal = (f: Date = new Date()): string => `${pad(f.getHours())}:${pad(f.getMinutes())}`

export const carpetasMemoria = ['conocimiento/temas', 'conocimiento/decisiones', 'conocimiento/diario']

const ruta = (carpeta: string, rel: string) => path.join(carpeta, ...rel.split('/'))

function leer(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n')
  } catch {
    return ''
  }
}

// MARK: temas

export type Tema = {
  titulo: string
  resumen?: string
  consolidado?: string
  /** Aportes ya consolidados (el del comentario). El total que muestra la app es `aportes + pendientes.length`. */
  aportes: number
  cuerpo: string
  /** Choques pendientes, sin el `- ` del principio. */
  sinDecidir: string[]
  /** Aportes sin consolidar, sin el `- ` del principio: `AAAA-MM-DD · Autor: hecho`. */
  pendientes: string[]
}

const marcaSinDecidir = '## Sin decidir'
const marcaPendientes = '## Aportes sin consolidar'
const reComentario = /^<!--\s*consolidado:\s*(\S+)\s*·\s*aportes:\s*(\d+)\s*-->$/

export function parsearTema(texto: string): Tema {
  const lineas = texto.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  const salteaVacias = () => { while (i < lineas.length && lineas[i]!.trim() === '') i++ }
  salteaVacias()
  let titulo = ''
  if (i < lineas.length && /^#\s+/.test(lineas[i]!)) titulo = lineas[i++]!.replace(/^#\s+/, '').trim()
  const t: Tema = { titulo, aportes: 0, cuerpo: '', sinDecidir: [], pendientes: [] }
  if (i < lineas.length && lineas[i]!.startsWith('> ')) t.resumen = lineas[i++]!.slice(2).trim()
  if (i < lineas.length) {
    const m = reComentario.exec(lineas[i]!.trim())
    if (m) {
      t.consolidado = m[1]!
      t.aportes = Number(m[2])
      i++
    }
  }
  const cuerpo: string[] = []
  let seccion: 'cuerpo' | 'sin' | 'pend' = 'cuerpo'
  for (; i < lineas.length; i++) {
    const l = lineas[i]!
    if (l.trim() === marcaSinDecidir) { seccion = 'sin'; continue }
    if (l.trim() === marcaPendientes) { seccion = 'pend'; continue }
    if (seccion === 'cuerpo') cuerpo.push(l)
    else if (l.startsWith('- ')) (seccion === 'sin' ? t.sinDecidir : t.pendientes).push(l.slice(2).trim())
  }
  t.cuerpo = cuerpo.join('\n').trim()
  return t
}

export function armarTema(t: Tema): string {
  const cab = [`# ${t.titulo}`]
  if (t.resumen !== undefined && t.resumen !== '') cab.push(`> ${t.resumen}`)
  if (t.consolidado !== undefined) cab.push(`<!-- consolidado: ${t.consolidado} · aportes: ${t.aportes} -->`)
  const partes = [cab.join('\n')]
  if (t.cuerpo.trim() !== '') partes.push(t.cuerpo.trim())
  if (t.sinDecidir.length > 0) partes.push(`${marcaSinDecidir}\n${t.sinDecidir.map((x) => `- ${x}`).join('\n')}`)
  if (t.pendientes.length > 0) partes.push(`${marcaPendientes}\n${t.pendientes.map((x) => `- ${x}`).join('\n')}`)
  return partes.join('\n\n') + '\n'
}

export type InfoTema = {
  slug: string
  titulo: string
  resumen: string
  consolidado?: string
  aportes: number
  pendientes: number
  /** Fecha (`AAAA-MM-DD`) del último aporte; si no hay, la de la última consolidación o la del archivo. */
  ultimo: string
  choques: number
}

const reAutor = /^\d{4}-\d{2}-\d{2} · [^:]*: /

/** Resumen de un tema para el índice: la línea `> `, o el primer aporte recortado. */
export function resumenDe(t: Tema): string {
  if (t.resumen !== undefined && t.resumen !== '') return prefijo(t.resumen, LimitesMemoria.maxResumen)
  const p = t.pendientes[0]
  if (p !== undefined) return prefijo(p.replace(reAutor, ''), LimitesMemoria.maxResumen)
  const c = t.cuerpo.split('\n').map((x) => x.trim()).find((x) => x !== '' && !x.startsWith('#'))
  return c === undefined ? '' : prefijo(c, LimitesMemoria.maxResumen)
}

const reFecha = /^(\d{4}-\d{2}-\d{2}) · /

export function infoTema(slug: string, t: Tema, mtimeMs: number): InfoTema {
  let ultimo = ''
  for (const p of t.pendientes) {
    const m = reFecha.exec(p)
    if (m && m[1]! > ultimo) ultimo = m[1]!
  }
  if (ultimo === '') ultimo = t.consolidado ?? diaLocal(new Date(mtimeMs))
  return { slug, titulo: t.titulo === '' ? slug : t.titulo, resumen: resumenDe(t), consolidado: t.consolidado, aportes: t.aportes, pendientes: t.pendientes.length, ultimo, choques: t.sinDecidir.length }
}

export function listarTemas(carpeta: string): InfoTema[] {
  const dir = ruta(carpeta, 'conocimiento/temas')
  let nombres: string[]
  try {
    nombres = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: InfoTema[] = []
  for (const n of nombres) {
    if (n.startsWith('.') || !n.endsWith('.md')) continue
    const slug = n.slice(0, -3)
    if (!Slug.valido(slug)) continue
    let st: fs.Stats
    try { st = fs.statSync(path.join(dir, n)) } catch { continue }
    if (!st.isFile()) continue
    out.push(infoTema(slug, parsearTema(leer(path.join(dir, n))), st.mtimeMs))
  }
  return out.sort((a, b) => (a.ultimo === b.ultimo ? a.slug.localeCompare(b.slug) : a.ultimo < b.ultimo ? 1 : -1))
}

// MARK: índice

export function contarDocumentos(carpeta: string): number {
  return leer(ruta(carpeta, 'conocimiento/archivos.md')).split('\n').filter((l) => l.startsWith('- **')).length
}

export function textoIndice(carpeta: string): string {
  const temas = listarTemas(carpeta)
  const lineas = temas.map((t) => {
    const n = t.aportes + t.pendientes
    const cuando = t.consolidado ? `al ${t.consolidado}` : 'sin ordenar'
    return `- **${t.titulo}** (\`${t.slug}\`, ${n} ${n === 1 ? 'aporte' : 'aportes'}, ${cuando})${t.resumen === '' ? '' : `: ${t.resumen}`}`
  })
  return `# Índice de la memoria

Temas que la oficina tiene escritos. Leé un tema solo si tiene que ver con lo que te piden: \`conocimiento/temas/<slug>.md\`.

${lineas.length === 0 ? '(Todavía no hay temas.)' : lineas.join('\n')}

Documentos de la biblioteca: ${contarDocumentos(carpeta)} (catálogo en \`conocimiento/archivos.md\`).
El histórico no se lee entero: buscalo con buscar(pregunta) (decisiones viejas, diario, historial de cada agente).
`
}

/** Escribe `conocimiento/indice.md` (sin IA), solo si cambió. Devuelve si lo escribió. */
export function regenerarIndice(carpeta: string): boolean {
  const p = ruta(carpeta, 'conocimiento/indice.md')
  const nuevo = textoIndice(carpeta)
  if (fs.existsSync(p) && leer(p) === nuevo) return false
  fs.mkdirSync(path.dirname(p), { recursive: true })
  escribirAtomico(nuevo, p)
  return true
}

// MARK: respaldo

function copiarSinRespaldos(origen: string, destino: string) {
  fs.mkdirSync(destino, { recursive: true })
  for (const e of fs.readdirSync(origen, { withFileTypes: true })) {
    if (e.name.startsWith('.respaldo-')) continue
    const o = path.join(origen, e.name)
    const d = path.join(destino, e.name)
    if (e.isDirectory()) copiarSinRespaldos(o, d)
    else if (e.isFile()) fs.copyFileSync(o, d)
  }
}

/** Copia `conocimiento/` a `conocimiento/.respaldo-AAAA-MM-DD/` (con `-2`, `-3`… si ya existe), salteando los
 *  `.respaldo-*` de adentro. Devuelve la ruta relativa. Si falla, borra lo que alcanzó a copiar y lanza. */
export function respaldar(carpeta: string, fecha: Date = new Date()): string {
  const base = `conocimiento/.respaldo-${diaLocal(fecha)}`
  let rel = base
  for (let n = 2; fs.existsSync(ruta(carpeta, rel)); n++) rel = `${base}-${n}`
  try {
    copiarSinRespaldos(ruta(carpeta, 'conocimiento'), ruta(carpeta, rel))
  } catch (e) {
    try { fs.rmSync(ruta(carpeta, rel), { recursive: true, force: true }) } catch {}
    throw e
  }
  return rel
}

// MARK: decisiones por mes

const encabezadoMes = (nombre: string, mes: string) =>
  `# Decisiones de ${nombre} — ${mes}\n\nHistórico: solo se agregan líneas. Las vigentes están en \`conocimiento/decisiones.md\`.\n\n`

/** Agrega `lineas` (`- AAAA-MM-DD: …`) al `decisiones/AAAA-MM.md` de `mes`, salteando las que ya están. */
export function agregarAlMes(carpeta: string, nombre: string, mes: string, lineas: string[]) {
  if (lineas.length === 0) return
  const p = ruta(carpeta, `conocimiento/decisiones/${mes}.md`)
  let actual = leer(p)
  const ya = new Set(actual.split('\n').map((l) => l.trim()))
  const nuevas = lineas.filter((l) => !ya.has(l.trim()))
  if (nuevas.length === 0) return
  if (actual === '') actual = encabezadoMes(nombre, mes)
  else if (!actual.endsWith('\n')) actual += '\n'
  actual += nuevas.join('\n') + '\n'
  fs.mkdirSync(path.dirname(p), { recursive: true })
  escribirAtomico(actual, p)
}

/** Parte `decisiones.md` por mes en `decisiones/AAAA-MM.md` (idempotente). No toca `decisiones.md`. Las líneas sin
 *  fecha van al mes de `fecha`. */
export function partirDecisiones(carpeta: string, nombreOficina: string, fecha: Date = new Date()) {
  const porMes = new Map<string, string[]>()
  for (const l of leer(ruta(carpeta, 'conocimiento/decisiones.md')).split('\n')) {
    if (!l.startsWith('- ') || l.trim() === '-') continue
    const m = /^- (\d{4}-\d{2})-\d{2}:/.exec(l)
    const mes = m ? m[1]! : mesLocal(fecha)
    porMes.set(mes, [...(porMes.get(mes) ?? []), l.trimEnd()])
  }
  for (const [mes, ls] of [...porMes].sort((a, b) => a[0].localeCompare(b[0]))) agregarAlMes(carpeta, nombreOficina, mes, ls)
}

// MARK: notas de agentes

const marcaMigracion = '(migración'

/** Copia las notas actuales de un agente al historial del mes (una sola vez: si ya hay un encabezado de migración, no). */
export function archivarNotas(carpeta: string, id: string, nombre: string, fecha: Date = new Date()) {
  const texto = leer(ruta(carpeta, `conocimiento/agentes/${id}.md`))
  if (texto.trim() === '') return
  const dir = ruta(carpeta, `conocimiento/agentes/${id}`)
  try {
    for (const n of fs.readdirSync(dir)) if (n.endsWith('.md') && leer(path.join(dir, n)).includes(marcaMigracion)) return
  } catch {}
  const mes = mesLocal(fecha)
  const p = path.join(dir, `${mes}.md`)
  let actual = leer(p)
  if (actual === '') actual = `# ${nombre}: historial ${mes}\n\n`
  else if (!actual.endsWith('\n')) actual += '\n'
  actual += `${actual.endsWith('\n\n') ? '' : '\n'}## ${diaLocal(fecha)} (migración: notas completas hasta hoy)\n\n${texto.trimEnd()}\n`
  fs.mkdirSync(dir, { recursive: true })
  escribirAtomico(actual, p)
}

// MARK: migración

export type ResultadoMigracion = { oficina: Oficina; migrada: boolean; respaldo?: string; fallo?: true }

function crearCarpetas(carpeta: string) {
  for (const d of carpetasMemoria) fs.mkdirSync(ruta(carpeta, d), { recursive: true })
}

/** Pasa una oficina de la estructura vieja (`memoria.version` ausente = 1) a la nueva: respaldo, carpetas, decisiones
 *  por mes, historial de cada agente e índice. Sin IA. Si la oficina ya está en v2 solo crea lo que falte. Si el
 *  respaldo falla no marca nada (se reintenta la próxima vez que se abra). Quien llama escribe `oficina.json`. */
export function migrarMemoria(
  carpeta: string, oficina: Oficina, fecha: Date = new Date(),
  hacer: { respaldar?: (carpeta: string, fecha: Date) => string } = {},
): ResultadoMigracion {
  if ((oficina.memoria?.version ?? 1) >= 2) {
    crearCarpetas(carpeta)
    if (!fs.existsSync(ruta(carpeta, 'conocimiento/indice.md'))) regenerarIndice(carpeta)
    return { oficina, migrada: false }
  }
  let respaldo: string
  try {
    respaldo = (hacer.respaldar ?? respaldar)(carpeta, fecha)
  } catch {
    return { oficina, migrada: false, fallo: true }
  }
  crearCarpetas(carpeta)
  partirDecisiones(carpeta, oficina.nombre, fecha)
  for (const a of oficina.agentes) archivarNotas(carpeta, a.id, a.nombre, fecha)
  regenerarIndice(carpeta)
  return { oficina: { ...oficina, memoria: { ...oficina.memoria, version: 2, migrada: diaLocal(fecha) } }, migrada: true, respaldo }
}
