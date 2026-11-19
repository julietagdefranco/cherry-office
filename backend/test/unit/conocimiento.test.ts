// Lógica interna del conocimiento compartido (sin servidor): texto, índice de búsqueda, obsoletos, preguntas frecuentes,
// sugerencias para el «sabe de» y quién sabe de un tema.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  ConocimientoDatos, analizar, claves, esHistorico, fuentes, quienSabe, similitud, trozos, venceDefecto,
} from '../../src/conocimiento.js'
import { sabeDeValido } from '../../src/agentes.js'
import { validarOficina, type AgenteDef, type Oficina } from '../../src/oficina.js'
import { SQLiteDB } from '../../src/sqlite.js'

const tmps: string[] = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'con-')); tmps.push(d); return d }
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

const escribir = (carpeta: string, rel: string, texto: string, mtime?: Date) => {
  const p = path.join(carpeta, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, texto)
  if (mtime) fs.utimesSync(p, mtime, mtime)
}

const DIA = 86400
const agentes: AgenteDef[] = [
  { id: 'marce', nombre: 'Marce', rol: 'Directora creativa', departamento: 'redes', sabeDe: ['métricas de Instagram', 'Reels'] },
  { id: 'nico', nombre: 'Nico', rol: 'Especialista en anuncios', departamento: 'ads' },
  { id: 'betty', nombre: 'Betty', rol: 'PM del equipo', departamento: 'direccion', sabeDe: ['precios del curso'] },
]
const oficina: Oficina = {
  version: 1, nombre: 'Taller', duenio: 'Ana', agentes,
  departamentos: [{ id: 'direccion', nombre: 'Dirección', color: '#111111' }, { id: 'redes', nombre: 'Redes', color: '#222222' }, { id: 'ads', nombre: 'Ads', color: '#333333' }],
}

function datos(sinFTS = false, ahora = { t: 1_800_000_000 }) {
  const d = new ConocimientoDatos(new SQLiteDB(path.join(tmp(), 'hq.db')), () => ahora.t)
  d.preparar(sinFTS)
  return { d, ahora }
}

describe('texto', () => {
  test('analizar saca la marca del principio y el TEMA del final', () => {
    expect(analizar('[VIGENTE] Sigue en 100.\nTEMA: precios del curso')).toEqual({ texto: 'Sigue en 100.', marca: 'vigente', tema: 'precios del curso' })
    expect(analizar('\n[actualizada]: Ahora 120.\n\n**Tema:** «Precios»\n')).toEqual({ texto: 'Ahora 120.', marca: 'actualizada', tema: 'Precios' })
    expect(analizar('Respuesta sin marcas.')).toEqual({ texto: 'Respuesta sin marcas.', marca: undefined, tema: '' })
    // el TEMA solo cuenta en la última línea con texto
    expect(analizar('TEMA: no\nResto.').tema).toBe('')
  })

  test('claves y similitud ignoran acentos, mayúsculas y palabras vacías', () => {
    expect(claves('¿Cuánto cuesta el curso de Reels?')).toEqual(['cuanto', 'cuesta', 'curso', 'reels'])
    expect(similitud('¿Cuánto cuesta el curso?', 'cuanto cuesta el CURSO')).toBe(1)
    expect(similitud('¿Cuánto cuesta el curso?', '¿Qué reels publicamos?')).toBe(0)
    expect(similitud('', 'algo')).toBe(0)
  })

  test('venceDefecto: los temas que cambian rápido vencen a los 60 días', () => {
    expect(venceDefecto('¿Cuál es el precio del curso?')).toBe(60)
    expect(venceDefecto('¿Qué tono usamos en redes?')).toBeUndefined()
  })

  test('trozos: decisiones de a una (con su fecha) y el resto por sección', () => {
    const ds = trozos('# Decisiones\n\n- 2026-11-02: Lanzar en diciembre\n- 2026-11-05: Priorizar reels\ntexto suelto', 'decision')
    expect(ds.map((t) => t.texto)).toEqual(['2026-11-02: Lanzar en diciembre', '2026-11-05: Priorizar reels'])
    expect(ds[0]!.ts).toBe(Date.UTC(2026, 10, 2, 12) / 1000)
    const ns = trozos('# Marce\n\nIntro.\n\n## En qué estoy\n- calendario\n\n## Qué entregué\n- guion', 'notas')
    expect(ns).toEqual([{ titulo: 'Marce', texto: 'Intro.' }, { titulo: 'En qué estoy', texto: '- calendario' }, { titulo: 'Qué entregué', texto: '- guion' }])
  })

  test('fuentes: memoria, decisiones, notas, fichas, actas y entregables de texto (no otros archivos)', () => {
    const c = tmp()
    escribir(c, 'conocimiento/oficina.md', '# Taller')
    escribir(c, 'conocimiento/decisiones.md', '# Decisiones')
    escribir(c, 'conocimiento/agentes/marce.md', '# Marce')
    escribir(c, 'conocimiento/agentes/No Valido.md', 'x')
    escribir(c, 'conocimiento/fuentes/precios.md', '# Precios')
    escribir(c, 'reuniones/2026-11-02-lanzamiento.md', '# Acta')
    escribir(c, 'archivos/entregables/marce/plan.md', '# Plan')
    escribir(c, 'archivos/entregables/marce/sub/datos.csv', 'a,b')
    escribir(c, 'archivos/entregables/marce/foto.png', 'png')
    escribir(c, 'archivos/compartido/otro.md', 'no')
    expect(fuentes(c).map((f) => `${f.tipo}:${f.autor}:${f.ruta}`)).toEqual([
      'oficina::conocimiento/oficina.md', 'decision::conocimiento/decisiones.md', 'notas:marce:conocimiento/agentes/marce.md',
      'ficha::conocimiento/fuentes/precios.md', 'acta::reuniones/2026-11-02-lanzamiento.md',
      'entregable:marce:archivos/entregables/marce/plan.md', 'entregable:marce:archivos/entregables/marce/sub/datos.csv',
    ])
  })
})

describe('memoria por capas', () => {
  test('fuentes: temas, diario, decisiones por mes e historial del agente; no .respaldo-*, .fusionados ni indice.md', () => {
    const c = tmp()
    escribir(c, 'conocimiento/oficina.md', '# Taller')
    escribir(c, 'conocimiento/indice.md', '# Índice')
    escribir(c, 'conocimiento/temas/precios.md', '# Precios')
    escribir(c, 'conocimiento/temas/.fusionados/viejo-2026-11-19.md', '# Viejo')
    escribir(c, 'conocimiento/diario/2026-11-19.md', '# Diario')
    escribir(c, 'conocimiento/decisiones/2026-11.md', '# Mes')
    escribir(c, 'conocimiento/agentes/marce/2026-11.md', '# Historial')
    escribir(c, 'conocimiento/agentes/No Valido/2026-11.md', 'x')
    escribir(c, 'conocimiento/.respaldo-2026-11-19/oficina.md', '# Respaldo')
    escribir(c, 'conocimiento/.respaldo-2026-11-19/agentes/marce.md', '# Respaldo')
    expect(fuentes(c).map((f) => `${f.tipo}:${f.autor}:${f.ruta}`)).toEqual([
      'oficina::conocimiento/oficina.md', 'notas:marce:conocimiento/agentes/marce/2026-11.md',
      'tema::conocimiento/temas/precios.md', 'diario::conocimiento/diario/2026-11-19.md', 'decision::conocimiento/decisiones/2026-11.md',
    ])
  })

  test('esHistorico: solo decisiones por mes e historial del agente', () => {
    expect(esHistorico('conocimiento/decisiones/2026-11.md')).toBe(true)
    expect(esHistorico('conocimiento/agentes/marce/2026-11.md')).toBe(true)
    for (const r of ['conocimiento/decisiones.md', 'conocimiento/agentes/marce.md', 'conocimiento/temas/2026-11.md', 'conocimiento/diario/2026-11-19.md']) expect(esHistorico(r)).toBe(false)
  })

  test('buscar: deduplica por hash (queda la vigente), baja lo histórico y lo marca; el diario toma la fecha del nombre', () => {
    for (const sinFTS of [false, true]) {
      const { d, ahora } = datos(sinFTS)
      ahora.t = Date.now() / 1000
      const c = tmp()
      escribir(c, 'conocimiento/decisiones.md', '- 2026-11-02: El curso Glow cuesta 100 dólares.')
      escribir(c, 'conocimiento/decisiones/2026-11.md', '# Decisiones\n\n- 2026-11-02: El curso Glow cuesta 100 dólares.\n- 2026-11-05: La entrega del curso Glow es en enero.')
      escribir(c, 'conocimiento/diario/2026-11-19.md', '# Diario 2026-11-19\n\n- 10:42 · Marce: El proveedor del curso Glow se atrasa.')
      d.sincronizar(c, true)
      const r = d.buscar(c, 'curso Glow')
      const cuesta = r.filter((x) => x.fragmento.includes('100'))
      expect(cuesta).toHaveLength(1)
      expect(cuesta[0]!.ruta).toBe('conocimiento/decisiones.md')
      expect(cuesta[0]!.historico).toBeUndefined()
      const entrega = r.find((x) => x.fragmento.includes('enero'))!
      expect(entrega.ruta).toBe('conocimiento/decisiones/2026-11.md')
      expect(entrega.historico).toBe(true)
      const diario = r.find((x) => x.tipo === 'diario')!
      expect(diario.ts).toBe(Date.UTC(2026, 10, 19, 12) / 1000)
    }
  })
})

describe('índice y búsqueda', () => {
  for (const sinFTS of [false, true]) {
    const etq = sinFTS ? 'sin FTS' : 'con FTS'

    test(`encuentra por palabras sin acentos, con autor, y se pone al día solo (${etq})`, () => {
      const { d } = datos(sinFTS)
      expect(d.esFTS).toBe(!sinFTS)
      const c = tmp()
      escribir(c, 'conocimiento/agentes/marce.md', '# Marce: notas\n\n## Qué entregué\n- El calendario de publicaciones de diciembre.')
      escribir(c, 'conocimiento/decisiones.md', '- 2026-11-02: El curso Glow cuesta 100 dólares.')
      d.sincronizar(c, true)
      const r = d.buscar(c, '¿Cuánto cuesta el curso?')
      expect(r[0]).toMatchObject({ tipo: 'decision', ref: 'conocimiento/decisiones.md#0' })
      expect(r[0]!.fragmento.toLowerCase()).toContain('cuesta')
      const n = d.buscar(c, 'calendario publicaciones')
      expect(n[0]).toMatchObject({ tipo: 'notas', autor: 'marce', titulo: 'Marce: notas · Qué entregué' })
      // cambia el archivo: se reindexa; se borra: desaparece
      escribir(c, 'conocimiento/agentes/marce.md', '# Marce: notas\n\nAhora armo el plan de anuncios.', new Date(Date.now() + 5000))
      d.sincronizar(c, true)
      expect(d.buscar(c, 'calendario publicaciones')).toEqual([])
      expect(d.buscar(c, 'anuncios')[0]!.autor).toBe('marce')
      fs.rmSync(path.join(c, 'conocimiento/agentes/marce.md'))
      d.sincronizar(c, true)
      expect(d.buscar(c, 'anuncios')).toEqual([])
      // otra oficina no ve lo de esta
      expect(d.buscar(tmp(), 'curso')).toEqual([])
    })

    test(`a igual relevancia gana lo más nuevo; lo obsoleto baja y la marca sobrevive a reindexar (${etq})`, () => {
      const { d, ahora } = datos(sinFTS)
      ahora.t = Date.now() / 1000
      const c = tmp()
      escribir(c, 'conocimiento/agentes/marce.md', '# Notas\n\nEl taller de anuncios es el sábado.', new Date(Date.now() - 400 * DIA * 1000))
      escribir(c, 'conocimiento/agentes/nico.md', '# Notas\n\nEl taller de anuncios es el domingo.')
      d.sincronizar(c, true)
      let r = d.buscar(c, 'taller anuncios')
      expect(r.map((x) => x.autor)).toEqual(['nico', 'marce'])
      expect(d.marcarObsoleto(c, r[0]!.ref, 'Se pasó al sábado', 'betty')).toBe(true)
      expect(d.marcarObsoleto(c, 'no/existe.md#0', 'x', '')).toBe(false)
      r = d.buscar(c, 'taller anuncios')
      expect(r.map((x) => x.autor)).toEqual(['marce', 'nico'])
      expect(r[1]!.obsoleto).toMatchObject({ motivo: 'Se pasó al sábado', por: 'betty' })
      expect(d.obsoletos(c)).toHaveLength(1)
      // tocar otro archivo no saca la marca
      escribir(c, 'conocimiento/agentes/marce.md', '# Notas\n\nEl taller de anuncios es el sábado. Confirmado.')
      d.sincronizar(c, true)
      expect(d.buscar(c, 'taller anuncios').find((x) => x.autor === 'nico')!.obsoleto).toBeDefined()
      // si el texto marcado cambia, la marca deja de aplicar (es otro fragmento)
      escribir(c, 'conocimiento/agentes/nico.md', '# Notas\n\nEl taller de anuncios es el sábado a las 10.', new Date(Date.now() + 5000))
      d.sincronizar(c, true)
      expect(d.buscar(c, 'taller anuncios').every((x) => x.obsoleto === undefined)).toBe(true)
      expect(d.desmarcarObsoleto(c, d.obsoletos(c)[0]!.ref as string)).toBe(1)
    })
  }
})

describe('preguntas frecuentes', () => {
  test('versiones, historial, búsqueda y vencimiento', () => {
    const { d, ahora } = datos()
    const c = '/of'
    const p1 = d.insertar({ oficina: c, agente: 'betty', de: 'marce', pregunta: '¿Cuánto cuesta el curso?', respuesta: '100 dólares.', tema: 'precios', estado: 'vigente', origen: 'consulta', venceDias: 60 })
    expect(p1.grupo).toBe(p1.id)
    expect(d.previa(c, 'betty', 'cuanto cuesta el curso glow').mismo?.id).toBe(p1.id)
    expect(d.previa(c, 'nico', 'cuanto cuesta el curso glow')).toEqual({ mismo: undefined, otro: expect.objectContaining({ id: p1.id }) })
    expect(d.previa(c, 'betty', 'qué reels publicamos')).toEqual({ mismo: undefined, otro: undefined })
    expect(d.buscar(c, 'cuesta curso')[0]).toMatchObject({ tipo: 'pregunta', autor: 'betty', ref: `preguntas/${p1.grupo}#0` })

    const p2 = d.nuevaVersion(p1, { respuesta: '120 dólares.', origen: 'consulta' })
    expect(p2.grupo).toBe(p1.grupo)
    expect(p2.venceDias).toBe(60)
    expect(d.historial(c, p1.grupo).map((x) => `${x.estado}:${x.respuesta}`)).toEqual(['vigente:120 dólares.', 'reemplazada:100 dólares.'])
    expect(d.buscar(c, 'cuesta curso')[0]!.fragmento).toContain('120')

    expect(d.vencida(p2)).toBe(false)
    ahora.t += 61 * DIA
    expect(d.vencida(d.pregunta(c, p2.id)!)).toBe(true)
    d.confirmar(d.pregunta(c, p2.id)!)
    expect(d.vencida(d.pregunta(c, p2.id)!)).toBe(false)

    d.borrar(p2)
    expect(d.preguntas(c, { estado: 'vigente' })).toEqual([])
    expect(d.buscar(c, 'cuesta curso')).toEqual([])
    expect(d.historial(c, p1.grupo)).toHaveLength(2)
  })

  test('sugerencias: agregar temas que responde seguido, quitar los que nadie pregunta, y descartar', () => {
    const { d, ahora } = datos()
    const c = '/of'
    const ins = (agente: string, tema: string, pregunta = `¿Algo de ${tema}?`) =>
      d.insertar({ oficina: c, agente, de: 'x', pregunta, respuesta: 'r', tema, estado: 'vigente', origen: 'consulta' })
    ins('nico', 'Presupuesto de anuncios'); ins('nico', 'presupuesto de anuncios'); ins('nico', 'Presupuesto de anuncios')
    ins('marce', 'métricas de instagram'); ins('marce', 'Métricas de Instagram'); ins('marce', 'metricas de instagram')
    ins('betty', 'agenda'); ins('betty', 'agenda')
    // marce ya lo tiene en su «sabe de»; betty no llega a 3
    expect(d.sugerencias(c, agentes)).toEqual([{ agente: 'nico', tema: 'Presupuesto de anuncios', tipo: 'agregar', veces: 3 }])
    d.descartarSugerencia(c, 'nico', 'presupuesto de ANUNCIOS', 'agregar')
    expect(d.sugerencias(c, agentes)).toEqual([])
    // 130 días después, con preguntas viejas: lo que nadie le preguntó a cada uno se propone quitar
    ahora.t += 130 * DIA
    ins('marce', 'Reels', '¿Cuántos reels por semana?')
    expect(d.sugerencias(c, agentes)).toEqual([
      { agente: 'marce', tema: 'métricas de Instagram', tipo: 'quitar', veces: 0 },
      { agente: 'betty', tema: 'precios del curso', tipo: 'quitar', veces: 0 },
    ])
  })
})

describe('quién sabe', () => {
  test('pesa el «sabe de», el rol y lo que ya respondió; excluye a quien pregunta', () => {
    const { d } = datos()
    d.insertar({ oficina: '/of', agente: 'nico', de: 'x', pregunta: '¿Cuánto invertimos en anuncios de Instagram?', respuesta: 'r', tema: 'presupuesto', estado: 'vigente', origen: 'consulta' })
    const ex = quienSabe(oficina, 'métricas de Instagram', d.respuestasSobre('/of', 'métricas de Instagram'))
    expect(ex.map((e) => e.agente.id)).toEqual(['marce', 'nico'])
    expect(ex[0]!.motivos).toEqual(['sabe de métricas de Instagram'])
    expect(ex[1]!.motivos).toEqual(['ya respondió una pregunta sobre esto'])
    expect(quienSabe(oficina, 'anuncios', new Map()).map((e) => [e.agente.id, e.motivos])).toEqual([['nico', ['por su rol (Especialista en anuncios)']]])
    expect(quienSabe(oficina, 'métricas de Instagram', new Map(), 'marce')).toEqual([])
    expect(quienSabe(oficina, 'de la', new Map())).toEqual([])
  })
})

describe('«sabe de» en la ficha del agente', () => {
  test('se recorta, se sacan repetidos y se valida el tope', () => {
    expect(sabeDeValido(['  Reels ', 'reels', 'Métricas', ''])).toEqual(['Reels', 'Métricas'])
    expect(sabeDeValido(undefined)).toBeUndefined()
    expect(() => sabeDeValido('Reels')).toThrow('lista de textos')
    expect(() => sabeDeValido(Array.from({ length: 13 }, (_, i) => `tema ${i}`))).toThrow('hasta 12')
    expect(() => sabeDeValido(['x'.repeat(61)])).toThrow('entre 1 y 60')
    // oficina.json con repetidos (sin importar acentos) no es válida
    expect(() => validarOficina({ ...oficina, agentes: [{ ...agentes[0]!, sabeDe: ['Métricas', 'metricas'] }] })).toThrow('repetido')
  })
})
