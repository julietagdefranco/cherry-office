// Lógica interna de reuniones y pendientes (sin servidor): ReunionPatron, ReunionTexto, PendientesReunion y los ids de
// encargo. Reescribe los tests `interno` de ReunionesTests.swift, PendientesTests.swift y PendientesAccionesTests.swift.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, onTestFinished, test } from 'vitest'
import type { Oficina } from '../../src/oficina.js'
import { Programador } from '../../src/programador.js'
import { PendientesReunion, ReunionPatron, ReunionTexto, parsearSintesis, type TurnoReunion } from '../../src/reuniones.js'
import { OrigenTarea, ValidarTareas } from '../../src/tareas.js'

const U = { a: '0b8f0c1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e' }

describe('ReunionPatron: lógica pura', () => {
  test('plan, visibles, validación y sufijo de la salida', () => {
    const bandos = { a: ['x', 'z'], b: ['y'] }
    expect(ReunionPatron.plan('debate', ['x', 'y', 'z']).map((p) => p.agente)).toEqual(['x', 'y', 'z'])
    const l = ReunionPatron.plan('lider', ['x', 'y', 'z'], 'y')
    expect(l.map((p) => p.agente)).toEqual(['y', 'x', 'z', 'y'])
    expect(l.map((p) => p.fase)).toEqual(['abre', 'opina', 'opina', 'cierra'])
    const r = ReunionPatron.plan('redblue', ['x', 'y', 'z', 'w'], undefined, { a: ['x', 'z'], b: ['y', 'w'] })
    expect(r.map((p) => p.agente)).toEqual(['x', 'y', 'z', 'w'])
    expect(r.map((p) => p.fase)).toEqual(['defiende', 'critica', 'defiende', 'critica'])
    // bandos desparejos: alterna mientras haya de ambos lados
    expect(ReunionPatron.plan('redblue', ['x', 'y', 'z'], undefined, bandos).map((p) => p.agente)).toEqual(['x', 'y', 'z'])
    expect(ReunionPatron.plan('revision', ['x', 'y']).map((p) => p.fase)).toEqual(['revisa', 'revisa'])
    expect(ReunionPatron.plan('lider', ['x', 'y'], 'nadie').map((p) => p.fase)).toEqual(['libre', 'libre'])

    const t: TurnoReunion[] = [
      { ronda: 1, agente: 'x', texto: 'a', error: false, ts: 0 },
      { ronda: 2, agente: 'y', texto: 'b', error: false, ts: 0 },
      { ronda: 2, agente: 'usuario', texto: 'c', error: false, ts: 0 },
    ]
    expect(ReunionPatron.visibles('mapreduce', t, 2).map((x) => x.texto)).toEqual(['a', 'c'])
    expect(ReunionPatron.visibles('debate', t, 2).length).toBe(3)

    for (const bien of ['archivos/a.md', 'archivos/entregables/reuniones/2026-01-01-x.md', 'archivos/A.MD']) expect(ReunionPatron.errorDeSalida(bien), bien).toBeUndefined()
    for (const mal of ['', '/etc/x.md', 'archivos/../x.md', 'archivos/a/../../x.md', '../archivos/x.md', 'archivos/x.txt', 'archivos/.md', 'x.md', 'archivos',
      'otra/x.md', 'archivos//x.md', 'archivos/.texto/x.md', 'archivos/a\\b.md', '~/x.md', 'archivos/x.md/']) {
      expect(ReunionPatron.errorDeSalida(mal), mal).toBeDefined()
    }
    const existe = new Set(['archivos/a.md', 'archivos/a-2.md'])
    expect(ReunionPatron.rutaLibre('archivos/a.md', (r) => existe.has(r))).toBe('archivos/a-3.md')
    expect(ReunionPatron.rutaLibre('archivos/b.md', (r) => existe.has(r))).toBe('archivos/b.md')
    expect(ReunionPatron.salidaPorDefecto('¿Cómo lanzamos?', new Date(2023, 10, 14, 12))).toBe('archivos/entregables/reuniones/2023-11-14-como-lanzamos.md')
  })
})

describe('ReunionTexto', () => {
  test('parsearSintesis: con bloque de código, pendientes como texto y vacío', () => {
    const s = parsearSintesis('Acá va:\n```json\n{"resumen":" R ","decisiones":["a","",3],"pendientes":["suelto",{"quien":"Marce","que":"Hacer","necesita_usuario":true},{"quien":"x","que":""}]}\n```')!
    expect(s.resumen).toBe('R')
    expect(s.decisiones).toEqual(['a'])
    expect(s.pendientes).toEqual([{ quien: '', que: 'suelto', usuario: false }, { quien: 'Marce', que: 'Hacer', usuario: true }])
    expect(parsearSintesis('sin json')).toBeUndefined()
    expect(parsearSintesis('{"resumen":"","decisiones":[],"pendientes":[]}')).toBeUndefined()
  })

  test('palabras, coincide y sinPuntoFinal', () => {
    expect(ReunionTexto.palabras('Campaña de ANUNCIOS pagos, ¡ya!')).toEqual(['campana', 'de', 'anuncios', 'pagos', 'ya'])
    expect(ReunionTexto.coincide('anuncios', 'anuncio')).toBe(true)
    expect(ReunionTexto.coincide('pago', 'pagos')).toBe(false)
    expect(ReunionTexto.sinPuntoFinal('  Tardó demasiado… ')).toBe('Tardó demasiado')
  })
})

const oficina = (): Oficina => ({
  version: 1, nombre: 'T', duenio: 'Ana', departamentos: [],
  agentes: [
    { id: 'armando', nombre: 'Don Armando', rol: 'x', departamento: 'd' },
    { id: 'sofia', nombre: 'Doña Sofía', rol: 'x', departamento: 'd' },
    { id: 'betty', nombre: 'Betty', rol: 'x', departamento: 'd' },
  ],
})

describe('PendientesReunion', () => {
  test('responsable: por id, nombre o primera palabra única; la persona o un nombre ambiguo no son agentes', () => {
    const of = oficina()
    expect(PendientesReunion.agente('don armando', of)?.id).toBe('armando')
    expect(PendientesReunion.agente('BETTY', of)?.id).toBe('betty')
    expect(PendientesReunion.agente('Dona Sofia', of)?.id).toBe('sofia')
    expect(PendientesReunion.agente('Ana', of)).toBeUndefined()
    expect(PendientesReunion.agente('', of)).toBeUndefined()
    of.agentes.push({ id: 'betty2', nombre: 'Betty Dos', rol: 'x', departamento: 'd' })
    expect(PendientesReunion.agente('Betty', of)?.id).toBe('betty')   // nombre completo exacto
    of.agentes.push({ id: 'don2', nombre: 'Don Pepe', rol: 'x', departamento: 'd' })
    expect(PendientesReunion.agente('Don', of)).toBeUndefined()        // primera palabra ambigua
  })

  test('id de encargo: ida y vuelta; ids que no son encargos dan undefined', () => {
    const id = Programador.idEncargo(U.a, 3)
    expect(id).toBe(`encargo:${U.a}:3`)
    expect(Programador.deEncargo(id)).toEqual([U.a, 3])
    expect(Programador.deEncargo('informe-diario')).toBeUndefined()
    expect(Programador.deEncargo('encargo:x')).toBeUndefined()
  })

  test('tildar marca la primera línea exacta y deja el resto igual', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reuniones-'))
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
    fs.mkdirSync(path.join(dir, 'conocimiento/agentes'), { recursive: true })
    const l = '- [ ] 2026-11-13 · reunión «plan»: Armar el calendario'
    const ruta = path.join(dir, 'conocimiento/agentes/marce.md')
    fs.writeFileSync(ruta, `# Marce\n\n## Pendientes de reuniones\n${l}\n- [ ] otra cosa\n`)
    expect(PendientesReunion.tildar(dir, 'marce', l)).toBe(true)
    expect(fs.readFileSync(ruta, 'utf8')).toBe('# Marce\n\n## Pendientes de reuniones\n- [x] 2026-11-13 · reunión «plan»: Armar el calendario\n- [ ] otra cosa\n')
    expect(PendientesReunion.tildar(dir, 'marce', l)).toBe(false)
    expect(PendientesReunion.tildar(dir, 'nadie', l)).toBe(false)
  })

  test('repartir: crea la sección una vez y agrega al final de la suya', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reuniones-'))
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
    const of = oficina()
    const ruta = path.join(dir, 'conocimiento/agentes/betty.md')
    fs.mkdirSync(path.dirname(ruta), { recursive: true })
    fs.writeFileSync(ruta, '# Betty\n\n## Pendientes de reuniones\n- [ ] viejo\n\n## Otra\ntexto\n')
    const n = PendientesReunion.repartir(dir, of, 'tema', [{ quien: 'Betty', que: 'a\nb', usuario: true }, { quien: 'Ana', que: 'x', usuario: false }], new Date(2026, 10, 13))
    expect(n).toEqual({ betty: 1 })
    expect(fs.readFileSync(ruta, 'utf8')).toBe('# Betty\n\n## Pendientes de reuniones\n- [ ] viejo\n- [ ] 2026-11-13 · reunión «tema»: a b (necesita a la persona: avisale qué hace falta)\n\n## Otra\ntexto\n')
  })

  test('origen de tarea: uuid en minúsculas y posición en rango', () => {
    const ok = (o: OrigenTarea) => ValidarTareas.origenValido(o)
    expect(ok({ reunion: U.a, pendiente: 0 })).toBe(true)
    expect(ok({ reunion: 'x', pendiente: 0 })).toBe(false)
    expect(ok({ reunion: U.a, pendiente: -1 })).toBe(false)
    expect(ok({ reunion: U.a, pendiente: 200 })).toBe(false)
  })
})
