// Lógica pura de los permisos pendientes de las tareas (permisos-tareas.ts) y la lectura de `permission_denials`.
import { describe, expect, test } from 'vitest'
import { denegaciones } from '../../src/claude-runner.js'
import { mensajeContinuar, pedidosDe, reglasUnaVez, maxPedidosPorVuelta, type PedidoTarea } from '../../src/permisos-tareas.js'

const base = { ejecucion: 7, oficina: '/of', agente: 'marce' }

describe('permisos de tareas (lógica pura)', () => {
  test('denegaciones: lee permission_denials; ignora lo que no tiene forma', () => {
    expect(denegaciones(undefined)).toEqual([])
    expect(denegaciones({ permission_denials: 'x' })).toEqual([])
    expect(denegaciones({ permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'ls' } }, { tool_name: '' }, 3, { tool_name: 'Edit' }] }))
      .toEqual([{ herramienta: 'Bash', input: { command: 'ls' } }, { herramienta: 'Edit', input: {} }])
  })

  test('pedidosDe: solo Bash/Edit/Write…, sin repetir, con reglas sugeridas y tope por vuelta', () => {
    const ps = pedidosDe([
      { herramienta: 'Bash', input: { command: 'git pull', description: 'Traer cambios' } },
      { herramienta: 'Bash', input: { command: 'git pull' } },
      { herramienta: 'mcp__claude_ai_Gmail__send', input: {} },
      { herramienta: 'Write', input: { file_path: '/repo/a.md' } },
    ], base)
    expect(ps.map((p) => [p.herramienta, p.detalle, p.reglas])).toEqual([
      ['Bash', 'git pull', ['Bash(git pull:*)']],
      ['Write', '/repo/a.md', ['Edit(//repo/**)', 'Write(//repo/**)']],
    ])
    expect(ps[0]!.descripcion).toBe('Traer cambios')
    expect(ps.every((p) => p.ejecucion === 7 && p.agente === 'marce' && p.decision === undefined)).toBe(true)
    const muchos = pedidosDe(Array.from({ length: 30 }, (_, i) => ({ herramienta: 'Bash', input: { command: `p${i}` } })), base)
    expect(muchos.length).toBe(maxPedidosPorVuelta)
  })

  test('reglasUnaVez: el archivo exacto para Edit/Write; las del comando para Bash', () => {
    const [b, w] = pedidosDe([{ herramienta: 'Bash', input: { command: 'npm test' } }, { herramienta: 'Edit', input: { file_path: '/repo/src/a.ts' } }], base)
    expect(reglasUnaVez(b!)).toEqual(['Bash(npm test:*)'])
    expect(reglasUnaVez(w!)).toEqual(['Edit(//repo/src/a.ts)', 'Write(//repo/src/a.ts)'])
  })

  test('mensajeContinuar: lo permitido, lo rechazado y qué hacer', () => {
    const ps = pedidosDe([{ herramienta: 'Bash', input: { command: 'git pull' } }, { herramienta: 'Bash', input: { command: 'rm -rf x' } }], base)
    const [a, b] = ps as [PedidoTarea, PedidoTarea]
    a.decision = 'una_vez'; b.decision = 'rechazar'
    const m = mensajeContinuar(ps, 'Ana')
    expect(m.startsWith('Ana respondió')).toBe(true)
    expect(m).toContain('Ahora tenés permiso para:\n- Bash: git pull')
    expect(m).toContain('No te dio permiso para')
    expect(m).toContain('- Bash: rm -rf x')
    a.decision = 'rechazar'
    const solo = mensajeContinuar(ps, '')
    expect(solo.startsWith('La persona')).toBe(true)
    expect(solo).not.toContain('Ahora tenés permiso')
    expect(solo).toContain('Seguí la tarea sin eso')
  })
})
