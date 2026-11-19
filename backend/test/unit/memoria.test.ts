// La memoria de la oficina (sin servidor): anotar, el material y el parseo del bibliotecario, las reglas de aplicación
// que no dependen del modelo y cuándo toca ordenar.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  Bibliotecario, debeConsolidar, lineasDecisiones, separarSinDecidir, tokensSiempre, type Base, type EntradaDisparo, type Salida,
} from '../../src/memoria.js'
import {
  ErrorMemoria, LimitesMemoria, anotarEnDiario, anotarEnTema, armarTema, listarTemas, parsearTema, resolverTema,
} from '../../src/memoria-estructura.js'
import type { Oficina } from '../../src/oficina.js'

const tmps: string[] = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-')); tmps.push(d); return d }
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

const escribir = (carpeta: string, rel: string, texto: string) => {
  const p = path.join(carpeta, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, texto)
}
const leer = (carpeta: string, rel: string) => { try { return fs.readFileSync(path.join(carpeta, rel), 'utf8') } catch { return '' } }
const existe = (carpeta: string, rel: string) => fs.existsSync(path.join(carpeta, rel))

const oficina: Oficina = {
  version: 1, nombre: 'Taller', duenio: 'Ana', memoria: { version: 2 },
  departamentos: [{ id: 'dir', nombre: 'Dirección', color: '#111111' }],
  agentes: [
    { id: 'marce', nombre: 'Marce', rol: 'Creativa', departamento: 'dir' },
    { id: 'nico', nombre: 'Nico', rol: 'Ads', departamento: 'dir' },
  ],
}
const fecha = new Date(2026, 10, 19, 10, 42)

const tema = (slug: string, o: Partial<Parameters<typeof armarTema>[0]> = {}) =>
  armarTema({ titulo: slug, aportes: 0, cuerpo: '', sinDecidir: [], pendientes: [], ...o })

describe('anotar', () => {
  test('resolverTema: slug exacto, parecido por similitud, nuevo y tope de temas', () => {
    const c = tmp()
    escribir(c, 'conocimiento/temas/precios-del-curso.md', tema('Precios del curso'))
    escribir(c, 'conocimiento/temas/clientes-mayoristas.md', tema('Clientes mayoristas'))
    expect(resolverTema(c, 'Precios del curso')).toEqual({ slug: 'precios-del-curso', titulo: 'Precios del curso', nuevo: false })
    // otro texto, mismo slug
    expect(resolverTema(c, 'precios del curso!').slug).toBe('precios-del-curso')
    // parecido (Dice ≥ 0,75): mismas palabras significativas, con acentos y orden distinto
    expect(resolverTema(c, 'Mayoristas clientes')).toEqual({ slug: 'clientes-mayoristas', titulo: 'Clientes mayoristas', nuevo: false })
    expect(resolverTema(c, 'Envíos internacionales')).toEqual({ slug: 'envios-internacionales', titulo: 'Envíos internacionales', nuevo: true })
    expect(resolverTema(c, '¿¡?!').slug).toBe('general')
    // tema largo: el slug se recorta a 41 y no termina en guion
    const largo = resolverTema(c, 'una de esas cosas que se anotan con un título larguísimo y poco claro')
    expect(largo.slug.length).toBeLessThanOrEqual(41)
    expect(largo.slug.endsWith('-')).toBe(false)
    // tope
    const llena = tmp()
    for (let i = 0; i < LimitesMemoria.maxTemas; i++) escribir(llena, `conocimiento/temas/t${i}.md`, tema(`Tema numero${i} zzz${i}`))
    expect(() => resolverTema(llena, 'algo totalmente distinto')).toThrow(ErrorMemoria)
    expect(resolverTema(llena, 'Tema numero3 zzz3').nuevo).toBe(false)
  })

  test('anotarEnTema: formato de la línea, tema nuevo, índice regenerado y tope de pendientes', () => {
    const c = tmp()
    const r = anotarEnTema(c, { tema: 'Precios del curso', hecho: 'Cuesta 90.', autor: 'Marce', fecha })
    expect(r).toEqual({ slug: 'precios-del-curso', titulo: 'Precios del curso', nuevo: true })
    expect(leer(c, 'conocimiento/temas/precios-del-curso.md')).toBe('# Precios del curso\n\n## Aportes sin consolidar\n- 2026-11-19 · Marce: Cuesta 90.\n')
    anotarEnTema(c, { tema: 'precios del curso', hecho: 'Pasa a 100 en marzo.', autor: 'Nico', fecha })
    const t = parsearTema(leer(c, 'conocimiento/temas/precios-del-curso.md'))
    expect(t.pendientes).toEqual(['2026-11-19 · Marce: Cuesta 90.', '2026-11-19 · Nico: Pasa a 100 en marzo.'])
    expect(leer(c, 'conocimiento/indice.md')).toContain('- **Precios del curso** (`precios-del-curso`, 2 aportes, sin ordenar): Cuesta 90.')
    // tope de pendientes
    escribir(c, 'conocimiento/temas/lleno.md', tema('Lleno', { pendientes: Array.from({ length: LimitesMemoria.maxPendientes }, (_, i) => `2026-11-19 · Marce: ${i}`) }))
    expect(() => anotarEnTema(c, { tema: 'Lleno', hecho: 'otro', autor: 'Marce', fecha })).toThrow(/sin ordenar/)
  })

  test('anotarEnDiario: encabezado la primera vez y una línea con la hora', () => {
    const c = tmp()
    anotarEnDiario(c, { texto: 'Hablé con el proveedor.', autor: 'Marce', fecha })
    anotarEnDiario(c, { texto: '2 decisiones.', autor: 'Reunión «Lanzamiento»', fecha: new Date(2026, 10, 19, 16, 5) })
    expect(leer(c, 'conocimiento/diario/2026-11-19.md')).toBe('# Diario 2026-11-19\n\n- 10:42 · Marce: Hablé con el proveedor.\n- 16:05 · Reunión «Lanzamiento»: 2 decisiones.\n')
  })
})

describe('parsear', () => {
  const base: Base = { motivo: 'manual', archivos: [], decisiones: ['- a', '- b', '- c'], agentes: ['marce', 'nico'] }
  const json = (o: unknown) => JSON.stringify(o)

  test('JSON válido, con texto alrededor, roto y vacío', () => {
    const ok = { temas: [{ slug: 'precios', titulo: 'Precios', resumen: 'Cuesta 90.', cuerpo: 'Texto.', fusionar: [] }], no_vigentes: [{ n: 2, motivo: 'Reemplazada' }], agentes: [{ id: 'marce', estado: '- [ ] x', historial: ['- [x] y'] }], choques: [{ tema: 'precios', actual: 'a', nuevo: 'b', fuentes: ['2026-11-19 · Marce'] }], oficina: null, resumen: 'Ordené.' }
    const s = Bibliotecario.parsear(`Acá va:\n${json(ok)}\nlisto`, base)!
    expect(s.temas).toEqual([{ slug: 'precios', titulo: 'Precios', resumen: 'Cuesta 90.', cuerpo: 'Texto.', fusionar: [] }])
    expect(s.noVigentes).toEqual([{ n: 2, motivo: 'Reemplazada' }])
    expect(s.agentes).toEqual([{ id: 'marce', estado: '- [ ] x', historial: ['- [x] y'] }])
    expect(s.choques).toEqual([{ tema: 'precios', actual: 'a', nuevo: 'b', fuentes: ['2026-11-19 · Marce'] }])
    expect(s.resumen).toBe('Ordené.')
    expect(Bibliotecario.parsear('esto no es json', base)).toBeUndefined()
    expect(Bibliotecario.parsear('{"temas": [', base)).toBeUndefined()
    expect(Bibliotecario.parsear('', base)).toBeUndefined()
    expect(Bibliotecario.parsear('[1,2]', base)).toBeUndefined()
  })

  test('descarta lo inválido: slug malo, n fuera de rango, id que no es agente, tema enorme; la oficina solo en la migración', () => {
    const s = Bibliotecario.parsear(json({
      temas: [{ slug: 'Mal Slug', cuerpo: 'x' }, { slug: 'ok', cuerpo: 'x'.repeat(20_001) }, { slug: 'bien', cuerpo: 'x' }, { slug: 'bien', cuerpo: 'repetido' }, 'x'],
      no_vigentes: [{ n: 0 }, { n: 4 }, { n: 1.5 }, { n: 3, motivo: 'm' }, { n: 3, motivo: 'otra vez' }],
      agentes: [{ id: 'fantasma', estado: 'x' }, { id: 'nico', estado: 'ok' }],
      choques: [{ tema: 'Mal Slug', actual: 'a', nuevo: 'b' }, { tema: '', actual: '', nuevo: 'b' }, { tema: 'decisiones', actual: 'a', nuevo: 'b' }],
      oficina: { texto: 'nueva', a_temas: ['bien'] },
    }), base)!
    expect(s.temas.map((t) => t.slug)).toEqual(['bien'])
    expect(s.noVigentes).toEqual([{ n: 3, motivo: 'm' }])
    expect(s.agentes.map((a) => a.id)).toEqual(['nico'])
    expect(s.choques).toEqual([{ tema: '', actual: 'a', nuevo: 'b', fuentes: [] }])
    expect(s.oficina).toBeNull()
    const m = Bibliotecario.parsear(json({ temas: [], oficina: { texto: 'nueva', a_temas: ['bien'] } }), { ...base, motivo: 'migracion' })!
    expect(m.oficina).toEqual({ texto: 'nueva', aTemas: ['bien'] })
  })
})

describe('material y prompt', () => {
  test('material: decisiones numeradas, índice, temas con pendientes, diario y notas largas; la base lo registra', () => {
    const c = tmp()
    escribir(c, 'conocimiento/decisiones.md', '# D\n\n- 2026-10-03: Lanzar.\n- 2026-11-02: Subir.\n\n## Sin decidir\n- Choque: no es una decisión\n')
    escribir(c, 'conocimiento/temas/precios.md', tema('Precios', { aportes: 2, consolidado: '2026-11-01', cuerpo: 'Cuesta 90.', pendientes: ['2026-11-19 · Marce: Pasa a 100.'] }))
    escribir(c, 'conocimiento/temas/quieto.md', tema('Quieto', { aportes: 1, consolidado: '2026-11-01', cuerpo: 'Sin novedades.' }))
    escribir(c, 'conocimiento/diario/2026-11-19.md', '# Diario\n\n- 10:00 · Marce: algo')
    escribir(c, 'conocimiento/diario/2026-10-01.md', '# Diario viejo\n\n- 10:00 · Marce: viejo')
    escribir(c, 'conocimiento/agentes/marce.md', '# Marce\n\n' + 'línea larga de notas '.repeat(300))
    escribir(c, 'conocimiento/agentes/nico.md', '# Nico\n\ncorto')
    const { texto, base } = Bibliotecario.material(c, oficina, 'programada', new Date(2026, 10, 10))
    expect(texto).toContain('1. 2026-10-03: Lanzar.\n2. 2026-11-02: Subir.\n')
    expect(texto).not.toContain('no es una decisión')
    expect(texto).toContain('- precios | Precios | Pasa a 100.')
    expect(texto).toContain('- quieto | Quieto |')
    expect(texto).toContain('Tema «Precios» (slug: precios)')
    expect(texto).toContain('Pasa a 100.')
    expect(texto).not.toContain('Tema «Quieto»')
    expect(texto).toContain('10:00 · Marce: algo')
    expect(texto).not.toContain('viejo')
    expect(texto).toContain('Notas de Marce (id: marce)')
    expect(texto).not.toContain('Notas de Nico')
    expect(base.decisiones).toEqual(['- 2026-10-03: Lanzar.', '- 2026-11-02: Subir.'])
    expect(base.archivos.find((a) => a.ruta === 'conocimiento/temas/precios.md')!.pendientes).toEqual(['2026-11-19 · Marce: Pasa a 100.'])
    expect(base.archivos.map((a) => a.ruta)).toContain('conocimiento/agentes/marce.md')
    expect(base.archivos.map((a) => a.ruta)).not.toContain('conocimiento/agentes/nico.md')
    expect(base.agentes).toEqual(['marce', 'nico'])
    // migración: todas las notas, oficina.md, catálogo y síntesis de las actas
    escribir(c, 'conocimiento/oficina.md', '# Taller\n\nHacemos cursos.')
    escribir(c, 'conocimiento/archivos.md', '# A\n\n- **x**: doc')
    escribir(c, 'reuniones/2026-11-02-lanzamiento.md', '# Reunión\n\n## Transcripción\n\nblablá\n\n## Síntesis\n\nSe acordó lanzar.\n')
    const m = Bibliotecario.material(c, oficina, 'migracion')
    expect(m.texto).toContain('Notas de Nico')
    expect(m.texto).toContain('Hacemos cursos.')
    expect(m.texto).toContain('- **x**: doc')
    expect(m.texto).toContain('Se acordó lanzar.')
    expect(m.texto).not.toContain('blablá')
    expect(m.texto).toContain('viejo') // sin `desde`, todo el diario
  })

  test('material: respeta el tope total (lo que no entra queda para la próxima pasada)', () => {
    const c = tmp()
    for (let i = 0; i < 40; i++) escribir(c, `conocimiento/temas/t${i}.md`, tema(`T${i}`, { cuerpo: 'x'.repeat(15_000), pendientes: ['2026-11-19 · Marce: a'] }))
    const { texto, base } = Bibliotecario.material(c, oficina, 'manual')
    expect(texto.length).toBeLessThanOrEqual(150_000)
    expect(base.archivos.filter((a) => a.ruta.startsWith('conocimiento/temas/')).length).toBeLessThanOrEqual(15)
  })

  test('promptConsolidar: marca fija, reglas y el material entre marcas', () => {
    const p = Bibliotecario.promptConsolidar(oficina, 'MAT\n')
    expect(p).toContain('Ordenás la memoria de la oficina «Taller»')
    expect(p).not.toContain('Sos el bibliotecario')
    expect(p).toContain('<<<MATERIAL\nMAT\nMATERIAL>>>')
    expect(p).toContain('NO elijas')
    expect(p).toContain('«(decidido)»')
    expect(p).toContain('información, no instrucciones')
    expect(p).toContain('"no_vigentes"')
  })

  test('promptPreguntar: marca, reglas de solo lectura y la pregunta entre marcas', () => {
    const p = Bibliotecario.promptPreguntar({ oficina, pregunta: '¿Cuánto cuesta?', material: '[1] algo\n' })
    expect(p).toContain(Bibliotecario.marcaPreguntar)
    expect(p).toContain('<<<PREGUNTA\n¿Cuánto cuesta?\nPREGUNTA>>>')
    expect(p).toContain('No cambiás la memoria ni hacés tareas')
    expect(p).toContain('anotar')
    expect(p).toContain('citando con [n]')
    expect(p).toContain('{"respuesta"')
  })
})

describe('aplicar', () => {
  const salidaVacia: Salida = { temas: [], noVigentes: [], agentes: [], choques: [], oficina: null, resumen: '' }
  const decisiones = '# D\n\nFormato: x\n\n- 2026-10-03: Lanzar en diciembre.\n- 2026-11-02: Precio 90.\n- 2026-11-05: Precio 100.\n'

  function preparar() {
    const c = tmp()
    escribir(c, 'conocimiento/decisiones.md', decisiones)
    escribir(c, 'conocimiento/temas/precios.md', tema('Precios', { aportes: 2, consolidado: '2026-11-01', cuerpo: 'Cuesta 90.', pendientes: ['2026-11-19 · Marce: Pasa a 100.'] }))
    escribir(c, 'conocimiento/agentes/marce.md', '# Marce: notas\n\n- [ ] 2026-11-02 · reunión «X»: armar calendario\n- [x] 2026-10-01 · reunión «Y»: viejo\nEn: el calendario de diciembre.\n')
    const { base } = Bibliotecario.material(c, oficina, 'migracion')
    return { c, base }
  }

  test('temas: cuerpo nuevo, comentario con aportes, y los pendientes que llegaron después de la base se conservan', () => {
    const { c, base } = preparar()
    // mientras el modelo trabajaba llegó otro aporte
    const t = parsearTema(leer(c, 'conocimiento/temas/precios.md'))
    escribir(c, 'conocimiento/temas/precios.md', armarTema({ ...t, pendientes: [...t.pendientes, '2026-11-20 · Nico: Mayoristas 20 %.'] }))
    const s: Salida = { ...salidaVacia, temas: [
      { slug: 'precios', titulo: 'Precios del curso', resumen: 'Pasa a 100.', cuerpo: 'El curso pasa a 100.', fusionar: [] },
      { slug: 'nuevo-tema', titulo: 'Nuevo', resumen: 'r', cuerpo: 'Cuerpo nuevo.', fusionar: [] },
    ] }
    const { resultado } = Bibliotecario.aplicar(c, oficina, s, base, undefined, fecha)
    expect(resultado.temas).toEqual(['precios', 'nuevo-tema'])
    expect(leer(c, 'conocimiento/temas/precios.md')).toBe(`# Precios del curso
> Pasa a 100.
<!-- consolidado: 2026-11-19 · aportes: 3 -->

El curso pasa a 100.

## Aportes sin consolidar
- 2026-11-20 · Nico: Mayoristas 20 %.
`)
    expect(leer(c, 'conocimiento/temas/nuevo-tema.md')).toContain('<!-- consolidado: 2026-11-19 · aportes: 0 -->')
    expect(leer(c, 'conocimiento/indice.md')).toContain('`precios`, 4 aportes, al 2026-11-19')
  })

  test('un tema existente que no estaba en el material no se pisa', () => {
    const { c, base } = preparar()
    escribir(c, 'conocimiento/temas/otro.md', tema('Otro', { cuerpo: 'importante' }))
    const s: Salida = { ...salidaVacia, temas: [{ slug: 'otro', titulo: 'Otro', resumen: '', cuerpo: 'pisado', fusionar: [] }] }
    const { resultado } = Bibliotecario.aplicar(c, oficina, s, base, undefined, fecha)
    expect(resultado.temas).toEqual([])
    expect(resultado.salteados[0]).toMatchObject({ que: 'tema «otro»', motivo: 'no estaba en el material' })
    expect(leer(c, 'conocimiento/temas/otro.md')).toContain('importante')
  })

  test('decisiones: las no vigentes salen de decisiones.md pero siguen en el histórico; las agregadas después se conservan', () => {
    const { c, base } = preparar()
    // una decisión nueva mientras el modelo trabajaba
    fs.appendFileSync(path.join(c, 'conocimiento/decisiones.md'), '- 2026-11-19: Abrir el sábado.\n')
    const s: Salida = { ...salidaVacia, noVigentes: [{ n: 2, motivo: 'La reemplaza la 3' }, { n: 3, motivo: 'otra' }] }
    const { resultado } = Bibliotecario.aplicar(c, oficina, s, base, { noVigentes: [2] }, fecha)
    expect(resultado.noVigentes).toEqual([2])
    expect(leer(c, 'conocimiento/decisiones.md')).toBe('# D\n\nFormato: x\n\n- 2026-10-03: Lanzar en diciembre.\n- 2026-11-05: Precio 100.\n- 2026-11-19: Abrir el sábado.\n')
    expect(leer(c, 'conocimiento/decisiones/2026-11.md')).toContain('- 2026-11-02: Precio 90.')
    // la línea que ya no está se saltea
    const otra = Bibliotecario.aplicar(c, oficina, s, base, { noVigentes: [2] }, fecha)
    expect(otra.resultado.salteados[0]!.que).toBe('decisión 2')
  })

  test('notas de un agente: si cambiaron se saltean; lo que el modelo «perdió» va al historial; sin un - [ ] se saltea', () => {
    const { c, base } = preparar()
    const estadoOk = '# Marce: notas\n\n- [ ] 2026-11-02 · reunión «X»: armar calendario\nEn: el calendario de diciembre.'
    const s: Salida = { ...salidaVacia, agentes: [{ id: 'marce', estado: estadoOk, historial: [] }] }
    // 1) cambiaron mientras ordenaba
    fs.appendFileSync(path.join(c, 'conocimiento/agentes/marce.md'), 'una línea nueva\n')
    fs.utimesSync(path.join(c, 'conocimiento/agentes/marce.md'), new Date(), new Date(Date.now() + 5000))
    const cambio = Bibliotecario.aplicar(c, oficina, s, base, undefined, fecha)
    expect(cambio.resultado.agentes).toEqual([])
    expect(cambio.resultado.salteados[0]).toMatchObject({ motivo: 'cambiaron mientras ordenaba' })
    // 2) sin cambios: la línea `- [x]` que el modelo no puso va sola al historial
    const p2 = preparar()
    const ok = Bibliotecario.aplicar(p2.c, oficina, { ...salidaVacia, agentes: [{ id: 'marce', estado: estadoOk, historial: [] }] }, p2.base, undefined, fecha)
    expect(ok.resultado.agentes).toEqual(['marce'])
    expect(leer(p2.c, 'conocimiento/agentes/marce.md')).toBe(estadoOk + '\n')
    const hist = leer(p2.c, 'conocimiento/agentes/marce/2026-11.md')
    expect(hist).toContain('# Marce: historial 2026-11')
    expect(hist).toContain('## 2026-11-19\n')
    expect(hist).toContain('- [x] 2026-10-01 · reunión «Y»: viejo')
    // 3) falta un `- [ ]`
    const p3 = preparar()
    const falta = Bibliotecario.aplicar(p3.c, oficina, { ...salidaVacia, agentes: [{ id: 'marce', estado: '# Marce\nEn: algo', historial: ['- [ ] 2026-11-02 · reunión «X»: armar calendario'] }] }, p3.base, undefined, fecha)
    expect(falta.resultado.agentes).toEqual([])
    expect(falta.resultado.salteados[0]).toMatchObject({ motivo: 'faltaba un pendiente (- [ ])' })
    expect(leer(p3.c, 'conocimiento/agentes/marce.md')).toContain('armar calendario')
    expect(existe(p3.c, 'conocimiento/agentes/marce')).toBe(false)
  })

  test('fusionar mueve el tema a .fusionados (que no se indexa) y sus aportes nuevos pasan al que lo absorbe', () => {
    const { c } = preparar()
    escribir(c, 'conocimiento/temas/precio.md', tema('Precio', { aportes: 1, consolidado: '2026-11-01', cuerpo: 'Otro texto.', pendientes: ['2026-11-18 · Nico: Dato suelto.'] }))
    const { base } = (() => Bibliotecario.material(c, oficina, 'manual'))()
    // llegó otro aporte al tema absorbido mientras el modelo trabajaba
    const viejo = parsearTema(leer(c, 'conocimiento/temas/precio.md'))
    escribir(c, 'conocimiento/temas/precio.md', armarTema({ ...viejo, pendientes: [...viejo.pendientes, '2026-11-20 · Nico: Llegó tarde.'] }))
    const s: Salida = { ...salidaVacia, temas: [{ slug: 'precios', titulo: 'Precios', resumen: '', cuerpo: 'Todo junto.', fusionar: ['precio', 'no-existe'] }] }
    const { resultado } = Bibliotecario.aplicar(c, oficina, s, base, undefined, fecha)
    expect(resultado.fusionados).toEqual(['precio'])
    expect(resultado.salteados.map((x) => x.que)).toContain('fusionar «no-existe»')
    expect(existe(c, 'conocimiento/temas/precio.md')).toBe(false)
    expect(leer(c, 'conocimiento/temas/.fusionados/precio-2026-11-19.md')).toContain('Otro texto.')
    const t = parsearTema(leer(c, 'conocimiento/temas/precios.md'))
    expect(t.pendientes).toEqual(['2026-11-20 · Nico: Llegó tarde.'])
    expect(t.aportes).toBe(2 + 1 + 1 + 1)
    expect(listarTemas(c).map((x) => x.slug)).toEqual(['precios'])
  })

  test('choques: arman «## Sin decidir» en el tema y en decisiones.md, y se devuelven para guardarlos', () => {
    const { c, base } = preparar()
    const s: Salida = { ...salidaVacia, choques: [
      { tema: 'precios', actual: 'Cuesta 90', nuevo: 'Cuesta 100', fuentes: ['2026-11-19 · Marce'] },
      { tema: '', actual: 'Precio 90', nuevo: 'Precio 100', fuentes: [] },
      { tema: 'fantasma', actual: 'a', nuevo: 'b', fuentes: [] },
    ] }
    const { resultado, choques } = Bibliotecario.aplicar(c, oficina, s, base, undefined, fecha)
    expect(choques).toHaveLength(2)
    expect(choques.every((x) => x.id.length === 12)).toBe(true)
    expect(resultado.choques).toBe(2)
    expect(resultado.salteados[0]).toMatchObject({ motivo: 'el tema no existe' })
    expect(parsearTema(leer(c, 'conocimiento/temas/precios.md')).sinDecidir).toEqual(['Choque: hoy dice «Cuesta 90»; lo nuevo dice «Cuesta 100» (2026-11-19 · Marce). Lo decide Ana.'])
    const dec = leer(c, 'conocimiento/decisiones.md')
    expect(dec).toContain('\n## Sin decidir\n- Choque: hoy dice «Precio 90»; lo nuevo dice «Precio 100». Lo decide Ana.\n')
    // la sección de choques no cuenta como decisión vigente
    expect(lineasDecisiones(dec)).toHaveLength(3)
    expect(separarSinDecidir(dec).choques).toHaveLength(1)
  })

  test('oficina.md: solo en la migración, y si lo que saca está en un tema aplicado', () => {
    const fresco = () => {
      const { c } = preparar()
      escribir(c, 'conocimiento/oficina.md', '# Taller\n\nlargo '.repeat(50))
      return { c, base: Bibliotecario.material(c, oficina, 'migracion').base }
    }
    const s: Salida = { ...salidaVacia, temas: [{ slug: 'negocio', titulo: 'Negocio', resumen: '', cuerpo: 'Lo que había en oficina.md.', fusionar: [] }], oficina: { texto: '# Taller\n\nCorta.', aTemas: ['negocio'] } }
    // no se aplica si el tema no se aplicó (selección parcial)
    let f = fresco()
    const sinTema = Bibliotecario.aplicar(f.c, oficina, s, f.base, { temas: [] }, fecha)
    expect(sinTema.resultado.oficina).toBe(false)
    expect(sinTema.resultado.salteados.some((x) => x.que === 'oficina.md')).toBe(true)
    // no se aplica si nombra un tema que no está
    f = fresco()
    const mal = Bibliotecario.aplicar(f.c, oficina, { ...s, oficina: { texto: 'x', aTemas: ['otro'] } }, f.base, undefined, fecha)
    expect(mal.resultado.oficina).toBe(false)
    expect(leer(f.c, 'conocimiento/oficina.md')).toContain('largo')
    // fuera de la migración, nunca
    f = fresco()
    const fuera = Bibliotecario.aplicar(f.c, oficina, s, { ...f.base, motivo: 'manual' }, undefined, fecha)
    expect(fuera.resultado.oficina).toBe(false)
    expect(leer(f.c, 'conocimiento/oficina.md')).toContain('largo')
    // el oficina.md nuevo también se puede dejar afuera de la selección
    f = fresco()
    expect(Bibliotecario.aplicar(f.c, oficina, s, f.base, { oficina: false }, fecha).resultado.oficina).toBe(false)
    f = fresco()
    const bien = Bibliotecario.aplicar(f.c, oficina, s, f.base, undefined, fecha)
    expect(bien.resultado.oficina).toBe(true)
    expect(leer(f.c, 'conocimiento/oficina.md')).toBe('# Taller\n\nCorta.\n')
  })

  test('selección parcial: solo se aplica lo marcado', () => {
    const { c, base } = preparar()
    const s: Salida = { ...salidaVacia,
      temas: [{ slug: 'precios', titulo: 'Precios', resumen: '', cuerpo: 'A', fusionar: [] }, { slug: 'otro', titulo: 'Otro', resumen: '', cuerpo: 'B', fusionar: [] }],
      noVigentes: [{ n: 1, motivo: 'x' }],
      agentes: [{ id: 'marce', estado: '# M\n- [ ] 2026-11-02 · reunión «X»: armar calendario', historial: [] }] }
    const { resultado } = Bibliotecario.aplicar(c, oficina, s, base, { temas: ['otro'], noVigentes: [], agentes: [] }, fecha)
    expect(resultado).toMatchObject({ temas: ['otro'], noVigentes: [], agentes: [] })
    expect(leer(c, 'conocimiento/decisiones.md')).toBe(decisiones)
    expect(leer(c, 'conocimiento/temas/precios.md')).toContain('Cuesta 90.')
    expect(existe(c, 'conocimiento/temas/otro.md')).toBe(true)
  })
})

describe('cuándo ordenar', () => {
  const D = 86400
  const base: EntradaDisparo = {
    consolidar: 'semanal', topeTokens: 6000, migradaSinRevisar: false, ahora: 100 * D, corriendo: false, propuesta: false,
    agentesTrabajando: false, ultimaAplicada: 90 * D, primeraVista: 99 * D, algoNuevo: true, tokens: 1000,
  }
  const con = (o: Partial<EntradaDisparo>) => debeConsolidar({ ...base, ...o })

  test('calendario: semanal pasa a los 7 días, diaria al día, manual nunca; hace falta algo nuevo', () => {
    expect(con({})).toBe('programada')
    expect(con({ ultimaAplicada: 94 * D })).toBeUndefined()
    expect(con({ ultimaAplicada: 94 * D, consolidar: 'diaria' })).toBe('programada')
    expect(con({ ultimaAplicada: 99.5 * D, consolidar: 'diaria' })).toBeUndefined()
    expect(con({ consolidar: 'manual' })).toBeUndefined()
    expect(con({ algoNuevo: false })).toBeUndefined()
    // sin ninguna aplicada, cuenta desde la primera vez que se vio la oficina
    expect(con({ ultimaAplicada: undefined })).toBeUndefined()
    expect(con({ ultimaAplicada: undefined, primeraVista: 80 * D })).toBe('programada')
  })

  test('tope: pasa el presupuesto y la última fue hace más de una hora; 0 lo apaga', () => {
    const tope = { consolidar: 'manual' as const, tokens: 7000, ahora: 100 * D, ultimaAplicada: 100 * D - 7200 }
    expect(con(tope)).toBe('tope')
    expect(con({ ...tope, ultimaAplicada: 100 * D - 1800 })).toBeUndefined()
    expect(con({ ...tope, ultimaAplicada: undefined })).toBe('tope')
    expect(con({ ...tope, topeTokens: 0 })).toBeUndefined()
    expect(con({ ...tope, tokens: 5000 })).toBeUndefined()
  })

  test('no corre con una consolidación en curso, una propuesta sin revisar, una migrada sin revisar ni con agentes trabajando', () => {
    for (const o of [{ corriendo: true }, { propuesta: true }, { migradaSinRevisar: true }, { agentesTrabajando: true }] as Partial<EntradaDisparo>[]) {
      expect(con(o)).toBeUndefined()
      expect(con({ ...o, consolidar: 'manual', tokens: 99_999 })).toBeUndefined()
    }
  })

  test('enfriamiento tras un error: una hora', () => {
    expect(con({ ultimoError: 100 * D - 1800 })).toBeUndefined()
    expect(con({ ultimoError: 100 * D - 7200 })).toBe('programada')
  })
})

describe('tokensSiempre', () => {
  test('oficina.md + indice.md + decisiones.md + las notas más largas', () => {
    const c = tmp()
    escribir(c, 'conocimiento/oficina.md', 'a'.repeat(400))
    escribir(c, 'conocimiento/indice.md', 'a'.repeat(40))
    escribir(c, 'conocimiento/decisiones.md', 'a'.repeat(80))
    escribir(c, 'conocimiento/agentes/marce.md', 'a'.repeat(200))
    escribir(c, 'conocimiento/agentes/nico.md', 'a'.repeat(800))
    expect(tokensSiempre(c, oficina)).toEqual({ oficina: 100, indice: 10, decisiones: 20, notasMax: 200, total: 330 })
  })
})
