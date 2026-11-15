// Tests internos de los permisos en vivo (port de la lógica pura de app/Tests/BackendTests/PermisosVivosTests.swift).
import { describe, expect, test } from 'vitest'
import { PermisosVivos, partirComando } from '../../src/permisos-vivos.js'
import { ValidarAgenteExtra } from '../../src/oficina.js'

const ident = { oficina: '/of', agente: 'marce', sid: '11111111-1111-4111-8111-111111111111', perfil: 'agente', interactivo: true }
const esperar = async (c: () => boolean, ms = 2000) => { const fin = Date.now() + ms; while (Date.now() < fin && !c()) await new Promise((r) => setTimeout(r, 10)); return c() }

describe('PermisosVivos (lógica pura)', () => {
  test('reglas sugeridas: programa (y subcomando conocido) por cada parte para Bash; carpeta del archivo para Edit/Write; nada para el resto', () => {
    const bash = (c: string) => PermisosVivos.reglasSugeridas('Bash', { command: c })
    expect(bash('git pull origin main')).toEqual(['Bash(git pull:*)'])
    expect(bash('  npm install  ')).toEqual(['Bash(npm install:*)'])
    expect(bash('git --version')).toEqual(['Bash(git:*)'])
    expect(bash('ls -la /tmp')).toEqual(['Bash(ls:*)'])
    // compuestos: una regla por parte, sin repetir
    expect(bash('git pull && rm -rf x')).toEqual(['Bash(git pull:*)', 'Bash(rm:*)'])
    expect(bash('cat a | grep b')).toEqual(['Bash(cat:*)', 'Bash(grep:*)'])
    expect(bash('ls; ls -la')).toEqual(['Bash(ls:*)'])
    expect(bash('cd /repo && npm test 2>&1 | tail -5')).toEqual(['Bash(cd:*)', 'Bash(npm test:*)', 'Bash(tail:*)'])
    expect(bash('echo hola > x')).toEqual(['Bash(echo:*)'])
    expect(bash('rm *')).toEqual(['Bash(rm:*)'])
    expect(bash("git commit -m 'arreglo && listo'")).toEqual(['Bash(git commit:*)'])
    expect(bash('echo "a; b" || true')).toEqual(['Bash(echo:*)', 'Bash(true:*)'])
    // lo que no se puede partir: el comando exacto (si no tiene paréntesis ni saltos de línea)
    expect(bash('FOO=1 make')).toEqual(['Bash(FOO=1 make)'])
    expect(bash('echo `whoami`')).toEqual(['Bash(echo `whoami`)'])
    expect(bash("echo 'sin cerrar")).toEqual(["Bash(echo 'sin cerrar)"])
    for (const c of ['echo $(whoami)', '(cd x && ls)', '', 'ls\nrm $(a)']) expect(bash(c), c).toEqual([])
    expect(PermisosVivos.reglasSugeridas('Edit', { file_path: '/Users/ana/repo/src/a.ts' })).toEqual(['Edit(//Users/ana/repo/src/**)', 'Write(//Users/ana/repo/src/**)'])
    expect(PermisosVivos.reglasSugeridas('Write', { file_path: '/tmp/x.md' })).toEqual(['Edit(//tmp/**)', 'Write(//tmp/**)'])
    expect(PermisosVivos.reglasSugeridas('Write', { file_path: '/raiz.md' })).toEqual(['Edit(//raiz.md)', 'Write(//raiz.md)'])
    expect(PermisosVivos.reglasSugeridas('Write', { file_path: 'relativo/x.md' })).toEqual([])
    expect(PermisosVivos.reglasSugeridas('Write', { file_path: '/a/../b.md' })).toEqual([])
    expect(PermisosVivos.reglasSugeridas('WebFetch', { url: 'https://x.com' })).toEqual([])
    // todo lo sugerido pasa la validación de reglas guardadas
    for (const c of ['git pull && rm -rf x', 'FOO=1 make', 'echo `whoami`', 'cd /repo && npm test 2>&1 | tail -5']) ValidarAgenteExtra.reglas(bash(c))
    expect(ValidarAgenteExtra.reglaValida('Bash(git pull:*)') && ValidarAgenteExtra.reglaValida('Edit(//tmp/**)')).toBe(true)
  })

  test('partirComando: separadores fuera de comillas; undefined con sustituciones o subshells', () => {
    expect(partirComando('a b && c | d; e & f')).toEqual([['a', 'b'], ['c'], ['d'], ['e'], ['f']])
    expect(partirComando('echo "x && y" \'z|w\'')).toEqual([['echo', 'x && y', 'z|w']])
    expect(partirComando('make 2>&1 >/dev/null')).toEqual([['make', '2>&1', '>/dev/null']])
    expect(partirComando('echo ""')).toEqual([['echo', '']])
    for (const c of ['echo $(a)', 'echo "$(a)"', 'echo `a`', '(ls)', 'diff <(a) b', "echo 'x"]) expect(partirComando(c), c).toBeUndefined()
  })

  test('detalle: el comando, la ruta o la URL; si no, el input como JSON; saneado y recortado', () => {
    expect(PermisosVivos.detalle('Bash', { command: 'git pull\u0007' })).toBe('git pull')
    expect(PermisosVivos.detalle('Edit', { file_path: '/a/b.md', old_string: 'x' })).toBe('/a/b.md')
    expect(PermisosVivos.detalle('WebFetch', { url: 'https://x.com' })).toBe('https://x.com')
    expect(PermisosVivos.detalle('Otra', { b: 1, a: 'x' })).toBe('{"a":"x","b":1}')
    expect(PermisosVivos.detalle('Bash', { command: 'a'.repeat(5000) }).length).toBe(PermisosVivos.maxDetalle)
  })

  test('respuesta para claude: allow con el input tal cual, o deny con un mensaje', () => {
    for (const d of ['una_vez', 'siempre'] as const) {
      const o = JSON.parse(PermisosVivos.respuesta(d, { command: 'ls' }))
      expect(o.behavior).toBe('allow'); expect(o.updatedInput.command).toBe('ls')
    }
    const no = JSON.parse(PermisosVivos.respuesta('rechazar', { command: 'ls' }))
    expect(no.behavior).toBe('deny'); expect(no.message).toContain('no dio permiso')
    const nadie = JSON.parse(PermisosVivos.respuesta(undefined, { command: 'ls' }))
    expect(nadie.behavior).toBe('deny'); expect(nadie.message).toContain('Nadie respondió')
  })

  test('validación de reglas guardadas', () => {
    ValidarAgenteExtra.reglas(['Bash(git pull:*)', 'Edit(//a/**)', 'Write(/a/b.md)'])
    for (const r of ['Bash', 'Bash()', 'Bash( )', 'Edit(relativo/**)', 'Write(//a/../b)', 'Bash(ls\n)', 'Read(//a)', 'mcp__x__y', 'Bash(ls']) {
      expect(() => ValidarAgenteExtra.reglas([r]), r).toThrow()
    }
    expect(() => ValidarAgenteExtra.reglas(['Bash(ls:*)', 'Bash(ls:*)'])).toThrow()
    expect(() => ValidarAgenteExtra.reglas(Array.from({ length: 41 }, (_, i) => `Bash(p${i}:*)`))).toThrow()
  })

  test('registro: pedir espera; pendientes por oficina; responder, vencer y cancelar', async () => {
    let cambios = 0
    const v = new PermisosVivos({ timeout: 5 })
    v.alCambiar(() => { cambios++ })
    const espera = v.pedir({ token: 't1', identidad: ident, herramienta: 'Bash', input: { command: 'git pull' } })
    expect(await esperar(() => v.pendientes('/of').length === 1)).toBe(true)
    expect(v.pendientes('/otra')).toEqual([])
    const p = v.pendientes('/of')[0]!
    expect([p.agente, p.herramienta, p.detalle]).toEqual(['marce', 'Bash', 'git pull'])
    expect(p.reglas).toEqual(['Bash(git pull:*)'])
    expect(v.responder('/otra', p.id, 'una_vez')).toBeUndefined()
    expect(v.responder('/of', p.id, 'siempre')?.id).toBe(p.id)
    expect(await espera).toBe('siempre')
    expect(v.pendientes('/of')).toEqual([])
    expect(v.responder('/of', p.id, 'una_vez')).toBeUndefined()
    expect(cambios).toBeGreaterThanOrEqual(2)

    const corto = new PermisosVivos({ timeout: 0.2 })
    expect(await corto.pedir({ token: 't', identidad: ident, herramienta: 'Bash', input: { command: 'ls' } })).toBeUndefined()

    const w = new PermisosVivos({ timeout: 5 })
    const a = w.pedir({ token: 'ta', identidad: ident, herramienta: 'Bash', input: { command: 'ls' } })
    const b = w.pedir({ token: 'tb', identidad: ident, herramienta: 'Bash', input: { command: 'pwd' } })
    expect(await esperar(() => w.pendientes('/of').length === 2)).toBe(true)
    w.cancelar('ta')
    expect(await a).toBeUndefined()
    expect(w.pendientes('/of').map((x) => x.detalle)).toEqual(['pwd'])
    w.responder('/of', w.pendientes('/of')[0]!.id, 'rechazar')
    expect(await b).toBe('rechazar')
  })
})
