// Estructura de la memoria en disco (sin servidor): migración mecánica, temas, índice y decisiones por mes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  armarTema, carpetasMemoria, listarTemas, migrarMemoria, parsearTema, regenerarIndice, respaldar, tokensDe,
  type Tema,
} from '../../src/memoria-estructura.js'
import type { Oficina } from '../../src/oficina.js'
import { anexarDecisiones } from '../../src/plantillas.js'

const tmps: string[] = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-')); tmps.push(d); return d }
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

const escribir = (carpeta: string, rel: string, texto: string) => {
  const p = path.join(carpeta, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, texto)
}
const leer = (carpeta: string, rel: string) => { try { return fs.readFileSync(path.join(carpeta, rel), 'utf8') } catch { return '' } }
const existe = (carpeta: string, rel: string) => fs.existsSync(path.join(carpeta, rel))

const oficina: Oficina = {
  version: 1, nombre: 'Taller', duenio: 'Ana',
  departamentos: [{ id: 'dir', nombre: 'Dirección', color: '#111111' }],
  agentes: [
    { id: 'marce', nombre: 'Marce', rol: 'Creativa', departamento: 'dir' },
    { id: 'nico', nombre: 'Nico', rol: 'Ads', departamento: 'dir' },
  ],
}
const fecha = new Date(2026, 10, 19, 10, 0)

const decisiones = '# Decisiones de Taller\n\nFormato: x\n\n- 2026-10-03: Lanzar en diciembre.\n- 2026-10-20: Precio base 90.\n- 2026-11-02: Subir a 100.\n- Sin fecha.\n'
const notasMarce = '# Marce: notas de trabajo\n\nRol: Creativa\n\n- [ ] 2026-11-02 · reunión «X»: armar calendario\n'

function oficinaVieja() {
  const c = tmp()
  escribir(c, 'conocimiento/decisiones.md', decisiones)
  escribir(c, 'conocimiento/oficina.md', '# Taller\n')
  escribir(c, 'conocimiento/archivos.md', '# Archivos\n\n- **a.pdf**: algo\n- **b.pdf**: otro\n')
  escribir(c, 'conocimiento/agentes/marce.md', notasMarce)
  escribir(c, 'conocimiento/agentes/nico.md', '# Nico: notas de trabajo\n\nRol: Ads\n')
  escribir(c, 'conocimiento/.respaldo-x/viejo.md', 'respaldo viejo')
  return c
}

describe('migrarMemoria', () => {
  test('oficina v1: respaldo exacto, carpetas, decisiones por mes, historial de cada agente e índice', () => {
    const c = oficinaVieja()
    const r = migrarMemoria(c, oficina, fecha)
    expect(r.migrada).toBe(true)
    expect(r.respaldo).toBe('conocimiento/.respaldo-2026-11-19')
    expect(r.oficina.memoria).toEqual({ version: 2, migrada: '2026-11-19' })
    // respaldo: copia exacta, sin la .respaldo-x de adentro
    expect(leer(c, `${r.respaldo}/decisiones.md`)).toBe(decisiones)
    expect(leer(c, `${r.respaldo}/agentes/marce.md`)).toBe(notasMarce)
    expect(existe(c, `${r.respaldo}/.respaldo-x`)).toBe(false)
    expect(existe(c, 'conocimiento/.respaldo-x/viejo.md')).toBe(true)
    for (const d of carpetasMemoria) expect(fs.statSync(path.join(c, d)).isDirectory()).toBe(true)
    expect(leer(c, 'conocimiento/decisiones/2026-10.md')).toBe(
      '# Decisiones de Taller — 2026-10\n\nHistórico: solo se agregan líneas. Las vigentes están en `conocimiento/decisiones.md`.\n\n- 2026-10-03: Lanzar en diciembre.\n- 2026-10-20: Precio base 90.\n')
    expect(leer(c, 'conocimiento/decisiones/2026-11.md')).toContain('- 2026-11-02: Subir a 100.\n- Sin fecha.\n')
    const hist = leer(c, 'conocimiento/agentes/marce/2026-11.md')
    expect(hist).toContain('# Marce: historial 2026-11')
    expect(hist).toContain('## 2026-11-19 (migración: notas completas hasta hoy)')
    expect(hist).toContain(notasMarce.trimEnd())
    expect(existe(c, 'conocimiento/agentes/nico/2026-11.md')).toBe(true)
    expect(leer(c, 'conocimiento/indice.md')).toContain('(Todavía no hay temas.)')
    expect(leer(c, 'conocimiento/indice.md')).toContain('Documentos de la biblioteca: 2')
    // lo vigente y las notas actuales quedan como estaban
    expect(leer(c, 'conocimiento/decisiones.md')).toBe(decisiones)
    expect(leer(c, 'conocimiento/agentes/marce.md')).toBe(notasMarce)
  })

  test('correrla dos veces (sin la marca, para forzar) no duplica líneas ni encabezados de migración', () => {
    const c = oficinaVieja()
    migrarMemoria(c, oficina, fecha)
    const antes = ['conocimiento/decisiones/2026-10.md', 'conocimiento/decisiones/2026-11.md', 'conocimiento/agentes/marce/2026-11.md'].map((r) => leer(c, r))
    const r2 = migrarMemoria(c, oficina, fecha)
    expect(r2.migrada).toBe(true)
    expect(r2.respaldo).toBe('conocimiento/.respaldo-2026-11-19-2')
    expect(['conocimiento/decisiones/2026-10.md', 'conocimiento/decisiones/2026-11.md', 'conocimiento/agentes/marce/2026-11.md'].map((r) => leer(c, r))).toEqual(antes)
    // el segundo respaldo tampoco se mete el primero adentro
    expect(existe(c, 'conocimiento/.respaldo-2026-11-19-2/.respaldo-2026-11-19')).toBe(false)
  })

  test('con la oficina ya en v2 no crea respaldo (solo carpetas e índice si faltan)', () => {
    const c = oficinaVieja()
    const v2: Oficina = { ...oficina, memoria: { version: 2 } }
    const r = migrarMemoria(c, v2, fecha)
    expect(r.migrada).toBe(false)
    expect(r.respaldo).toBeUndefined()
    expect(r.oficina).toBe(v2)
    expect(fs.readdirSync(path.join(c, 'conocimiento')).filter((n) => n.startsWith('.respaldo-'))).toEqual(['.respaldo-x'])
    expect(existe(c, 'conocimiento/indice.md')).toBe(true)
    expect(existe(c, 'conocimiento/temas')).toBe(true)
    expect(existe(c, 'conocimiento/decisiones/2026-10.md')).toBe(false)
  })

  test('si el respaldo falla, no marca la versión ni toca nada', () => {
    const c = oficinaVieja()
    const r = migrarMemoria(c, oficina, fecha, { respaldar: () => { throw new Error('sin permiso') } })
    expect(r.migrada).toBe(false)
    expect(r.fallo).toBe(true)
    expect(r.oficina.memoria).toBeUndefined()
    expect(existe(c, 'conocimiento/decisiones')).toBe(false)
    expect(existe(c, 'conocimiento/indice.md')).toBe(false)
  })

  test('respaldar borra lo que alcanzó a copiar si falla', () => {
    const c = tmp()
    escribir(c, 'conocimiento', 'esto es un archivo, no una carpeta')
    expect(() => respaldar(c, fecha)).toThrow()
    expect(leer(c, 'conocimiento')).toBe('esto es un archivo, no una carpeta')
  })
})

describe('temas', () => {
  const completo: Tema = {
    titulo: 'Precios del curso', resumen: 'El curso cuesta 90.', consolidado: '2026-11-18', aportes: 12,
    cuerpo: 'Texto limpio.\n\n### Mayoristas\n20 % de descuento.',
    sinDecidir: ['Choque: Marce anotó «100» y el tema dice 90.'], pendientes: ['2026-11-19 · Marce: El curso pasa a 100.'],
  }

  test('parsearTema/armarTema: ida y vuelta (con y sin resumen, comentario, sin decidir y pendientes)', () => {
    const casos: Tema[] = [
      completo,
      { titulo: 'Solo título', aportes: 0, cuerpo: '', sinDecidir: [], pendientes: [] },
      { titulo: 'Con pendientes', aportes: 0, cuerpo: '', sinDecidir: [], pendientes: ['2026-11-19 · Marce: a', '2026-11-19 · Nico: b'] },
      { titulo: 'Sin resumen', consolidado: '2026-11-01', aportes: 3, cuerpo: 'Cuerpo.', sinDecidir: [], pendientes: [] },
    ]
    for (const t of casos) {
      const texto = armarTema(t)
      expect(parsearTema(texto)).toEqual(t)
      expect(armarTema(parsearTema(texto))).toBe(texto)
    }
    expect(armarTema(completo)).toBe(`# Precios del curso
> El curso cuesta 90.
<!-- consolidado: 2026-11-18 · aportes: 12 -->

Texto limpio.

### Mayoristas
20 % de descuento.

## Sin decidir
- Choque: Marce anotó «100» y el tema dice 90.

## Aportes sin consolidar
- 2026-11-19 · Marce: El curso pasa a 100.
`)
    expect(armarTema(casos[1]!)).not.toContain('## ')
  })

  test('regenerarIndice: orden por último aporte, «sin ordenar», resumen del primer aporte, documentos y sin temas', () => {
    const c = tmp()
    escribir(c, 'conocimiento/archivos.md', '# A\n\n- **x**: 1\n- **y**: 2\n- **z**: 3\n')
    expect(regenerarIndice(c)).toBe(true)
    expect(leer(c, 'conocimiento/indice.md')).toContain('(Todavía no hay temas.)')
    expect(regenerarIndice(c)).toBe(false) // sin cambios, no reescribe
    escribir(c, 'conocimiento/temas/precios-del-curso.md', armarTema({ ...completo, pendientes: [] }))
    escribir(c, 'conocimiento/temas/clientes-mayoristas.md', armarTema({
      titulo: 'Clientes mayoristas', aportes: 0, cuerpo: '', sinDecidir: [],
      pendientes: ['2026-11-19 · Marce: Juan pide factura A.', '2026-11-19 · Nico: Otro dato.'] }))
    escribir(c, 'conocimiento/temas/viejo.md', armarTema({ titulo: 'Viejo', consolidado: '2026-01-05', aportes: 1, cuerpo: 'x', sinDecidir: [], pendientes: [] }))
    escribir(c, 'conocimiento/temas/.fusionados/otro.md', '# no entra')
    regenerarIndice(c)
    const t = leer(c, 'conocimiento/indice.md')
    expect(t).toContain('- **Clientes mayoristas** (`clientes-mayoristas`, 2 aportes, sin ordenar): Juan pide factura A.')
    expect(t).toContain('- **Precios del curso** (`precios-del-curso`, 12 aportes, al 2026-11-18): El curso cuesta 90.')
    expect(t.indexOf('Clientes mayoristas')).toBeLessThan(t.indexOf('Precios del curso'))
    expect(t.indexOf('Precios del curso')).toBeLessThan(t.indexOf('**Viejo**'))
    expect(t).not.toContain('otro')
    expect(t).toContain('Documentos de la biblioteca: 3 (catálogo en `conocimiento/archivos.md`).')
    expect(listarTemas(c).map((x) => x.slug)).toEqual(['clientes-mayoristas', 'precios-del-curso', 'viejo'])
  })

  test('tokensDe ≈ caracteres / 4', () => {
    expect(tokensDe('')).toBe(0)
    expect(tokensDe('abcd')).toBe(1)
    expect(tokensDe('abcde')).toBe(2)
  })
})

describe('anexarDecisiones', () => {
  test('con decisiones/ presente escribe en decisiones.md y en el mes; sin la carpeta, solo en decisiones.md', () => {
    const c = tmp()
    escribir(c, 'conocimiento/decisiones.md', '# D\n')
    anexarDecisiones(c, ['Una cosa'], fecha, 'Taller')
    expect(leer(c, 'conocimiento/decisiones.md')).toBe('# D\n- 2026-11-19: Una cosa\n')
    expect(existe(c, 'conocimiento/decisiones')).toBe(false)
    fs.mkdirSync(path.join(c, 'conocimiento/decisiones'))
    anexarDecisiones(c, ['Otra\ncosa', 'Tercera'], fecha, 'Taller')
    expect(leer(c, 'conocimiento/decisiones.md')).toBe('# D\n- 2026-11-19: Una cosa\n- 2026-11-19: Otra cosa\n- 2026-11-19: Tercera\n')
    expect(leer(c, 'conocimiento/decisiones/2026-11.md')).toBe(
      '# Decisiones de Taller — 2026-11\n\nHistórico: solo se agregan líneas. Las vigentes están en `conocimiento/decisiones.md`.\n\n- 2026-11-19: Otra cosa\n- 2026-11-19: Tercera\n')
  })
})
