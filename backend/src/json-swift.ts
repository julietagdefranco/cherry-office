// JSON con el mismo formato que JSONEncoder de Swift con [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]:
//   - indentado de 2, `"clave" : valor` (espacio antes de los dos puntos), claves ordenadas;
//   - listas y objetos vacíos en dos líneas (`[\n\n  ]`), sin salto de línea al final;
//   - `undefined` se omite (como un opcional nil), `/` sin escapar, no ASCII tal cual.
// Así `oficina.json` y `config.json` quedan byte a byte como los escribe la app Swift (sin diffs al pasar de una a otra).
// Los números usan el formato de JS: coincide con Swift salvo exponentes grandes (≥ 1e21), que no aparecen en estos archivos.

export function jsonSwift(v: unknown, nivel = 0): string {
  const sangria = '  '.repeat(nivel)
  const adentro = '  '.repeat(nivel + 1)
  if (v === null) return 'null'
  if (Array.isArray(v)) {
    const items = v.map((x) => (x === undefined ? 'null' : jsonSwift(x, nivel + 1)))
    if (items.length === 0) return `[\n\n${sangria}]`
    return `[\n${items.map((i) => adentro + i).join(',\n')}\n${sangria}]`
  }
  if (typeof v === 'object') {
    const claves = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort(compararClaves)
    if (claves.length === 0) return `{\n\n${sangria}}`
    const pares = claves.map((k) => `${adentro}${JSON.stringify(k)} : ${jsonSwift((v as Record<string, unknown>)[k], nivel + 1)}`)
    return `{\n${pares.join(',\n')}\n${sangria}}`
  }
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null'
  return JSON.stringify(v) ?? 'null'
}

/** JSON en una línea con claves ordenadas (JSONSerialization con [.sortedKeys, .withoutEscapingSlashes]). */
export function jsonCompacto(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : jsonCompacto(x))).join(',')}]`
  const o = v as Record<string, unknown>
  const claves = Object.keys(o).filter((k) => o[k] !== undefined).sort(compararClaves)
  return `{${claves.map((k) => `${JSON.stringify(k)}:${jsonCompacto(o[k])}`).join(',')}}`
}

/** Orden de `.sortedKeys` (comparación de String de Swift: por escalares Unicode, que para claves ASCII es el orden byte a byte). */
function compararClaves(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!
    if (d !== 0) return d
  }
  return x.length - y.length
}
