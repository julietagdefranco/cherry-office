// Lógica interna de agentes (sin servidor): plantilla del .md, YAML de una línea y borrador de Claude.
import { describe, expect, test } from 'vitest'
import { Borrador, chipsValidos, modeloValido, nuevoAgenteDesde } from '../../src/agentes.js'
import { agenteMD, fijarFrontmatter, partes, promptDe, valorFrontmatter, yamlLinea } from '../../src/plantillas.js'

const especiales = [
  'Simple', 'Con: dos puntos', 'Termina en:', 'Con # numeral', '#empieza', '- guion', '? duda', '[lista]', '{mapa}', '&ancla',
  '*alias', '!etiqueta', '|bloque', '>plegado', '%dir', '@arroba', '`tilde', 'dice "hola"', "it's", 'back\\slash', 'null', '~',
  'true', 'No', 'ON', '123', '1e5', '0x1F', '.5', 'inf', 'NaN', 'con\ttab', 'ñandú 😀 «x»', 'a, b', 'x:y',
]

describe('yamlLinea / valorFrontmatter', () => {
  test('ida y vuelta con caracteres especiales', () => {
    for (const v of especiales) {
      const fm = ['name: x', `description: ${yamlLinea(v)}`, 'model: sonnet']
      expect(valorFrontmatter(fm, 'description'), v).toBe(v)
    }
  })

  test('los saltos de línea se aplastan en una sola línea', () => {
    const linea = yamlLinea('uno\ndos\r\n\r\n  tres  ')
    expect(linea).not.toMatch(/[\n\r]/)
    expect(valorFrontmatter([`description: ${linea}`], 'description')).toBe('uno dos tres')
  })

  test('N cambios seguidos del frontmatter son idempotentes y no duplican líneas', () => {
    let md = agenteMD('marce', 'Inicial', 'sonnet', 'Sos marce.')
    for (let i = 0; i < 8; i++) {
      const p = partes(md)
      let fm = p.frontmatter
      fm = i % 2 === 0 ? fijarFrontmatter(fm, 'description', yamlLinea(`Desc ${i}: x`)) : fijarFrontmatter(fm, 'model', i % 4 === 1 ? 'haiku' : 'opus')
      md = '---\n' + fm.join('\n') + '\n---\n' + p.cuerpo
    }
    expect(md.split('\n---\n').length).toBe(2)
    const p = partes(md)
    expect(p.frontmatter.filter((l) => l.startsWith('description:')).length).toBe(1)
    expect(valorFrontmatter(p.frontmatter, 'description')).toBe('Desc 6: x')
    expect(valorFrontmatter(p.frontmatter, 'model')).toBe('opus')
    expect(promptDe(p.cuerpo)).toBe('Sos marce.')
  })
})

describe('Borrador.parsear', () => {
  const json = '{"id":"Doña Pepa","nombre":"Pepa","rol":"Cocinera","description":"Línea 1\\nlínea 2","prompt":"Sos Pepa.","chips":["a"," ","b","c","d"],"modelo":"OPUS"}'

  test('JSON puro, normaliza id, aplasta description, recorta chips y modelo', () => {
    const b = Borrador.parsear(json, new Set())!
    expect(b.id).toBe('dona-pepa')
    expect(b.description).toBe('Línea 1 línea 2')
    expect(b.chips).toEqual(['a', 'b', 'c'])
    expect(b.modelo).toBe('opus')
  })

  test('dentro de bloque de código o rodeado de texto', () => {
    expect(Borrador.parsear('Acá va:\n```json\n' + json + '\n```\nListo', new Set())?.nombre).toBe('Pepa')
    expect(Borrador.parsear('Mirá: ' + json + ' fin', new Set())?.nombre).toBe('Pepa')
  })

  test('ids ocupados o reservados reciben sufijo; sin id sale del nombre', () => {
    expect(Borrador.parsear(json, new Set(['dona-pepa']))!.id).toBe('dona-pepa-2')
    expect(Borrador.parsear('{"id":"explore","nombre":"X","rol":"r","prompt":"p"}', new Set())!.id).toBe('explore-2')
    expect(Borrador.parsear('{"nombre":"Don Armando","rol":"r","prompt":"p"}', new Set())!.id).toBe('don-armando')
  })

  test('sin description usa «nombre, rol.»; modelo inválido cae a sonnet; límites de largo', () => {
    const b = Borrador.parsear(JSON.stringify({ nombre: 'N'.repeat(100), rol: 'r', prompt: 'p', modelo: 'gpt' }), new Set())!
    expect(b.nombre.length).toBe(80)
    expect(b.description).toBe(`${'N'.repeat(100)}, r.`)
    expect(b.modelo).toBe('sonnet')
  })

  test('respuestas inválidas dan undefined', () => {
    for (const t of ['no tengo JSON', '{"nombre":"X"}', '{"nombre":"X","rol":"R","prompt":""}', '[1,2]', '{ roto']) {
      expect(Borrador.parsear(t, new Set()), t).toBeUndefined()
    }
  })
})

describe('validaciones del cuerpo', () => {
  test('modelo y chips', () => {
    expect(modeloValido(undefined)).toBe('sonnet')
    expect(modeloValido(' Opus ')).toBe('opus')
    expect(() => modeloValido('gpt')).toThrow()
    expect(() => chipsValidos(['x'.repeat(201)])).toThrow()
    expect(() => chipsValidos(['1', '2', '3', '4', '5', '6', '7'])).toThrow()
    expect(chipsValidos([' a ', '', 'b'])).toEqual(['a', 'b'])
  })

  test('nuevoAgenteDesde: description por defecto es el rol', () => {
    const n = nuevoAgenteDesde({ nombre: 'N', rol: 'Rol', prompt: 'p', departamento: 'd' })
    expect(n.description).toBe('Rol')
    expect(n.modelo).toBe('sonnet')
    expect(n.chips).toEqual([])
  })
})
