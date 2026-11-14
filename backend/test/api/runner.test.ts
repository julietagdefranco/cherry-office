// Port de app/Tests/BackendTests/RunnerTests.swift.
// Sin acceso a internals: procesosVivos, ClaudeRunner/ClaudeLocator/parsearJSON/clasificar quedan para los unit tests del port.
// `shutdown()` se dispara con SIGTERM al servidor (`b.cerrar()`).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { Sandbox, U, chat, esperar, historial, llamar, msgs, sinPrivate, vivo } from '../support/sandbox.js'

const mensajeLogin = "Claude Code todavía no tiene la sesión iniciada. Usá «Iniciar sesión» en la app o corré 'claude auth login' en la Terminal."

/** Posición del valor que sigue a `flag` en los argumentos. */
const valor = (args: string[], tras: string) => Sandbox.valor(args, tras)

describe('ClaudeRunner', () => {
  test('primer mensaje usa --session-id y los siguientes --resume', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    expect((await chat(b, { message: 'uno' })).status).toBe(200)
    expect((await chat(b, { message: 'dos' })).status).toBe(200)
    expect((await chat(b, { message: 'tres' })).status).toBe(200)
    const ll = sb.llamadas
    expect(ll.length).toBe(3)
    expect(valor(ll[0]!, '--session-id')).toBe(U.a)
    expect(ll[0]!.includes('--resume')).toBe(false)
    for (const i of [1, 2]) {
      expect(valor(ll[i]!, '--resume')).toBe(U.a)
      expect(ll[i]!.includes('--session-id')).toBe(false)
    }
    expect(ll.map((a) => a.at(-1))).toEqual(['uno', 'dos', 'tres'])
  })

  test('sesiones distintas del mismo agente arrancan cada una con --session-id', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    await chat(b, { message: 'a', session: U.a })
    await chat(b, { message: 'b', session: U.b })
    expect(sb.llamadas.every((a) => a.includes('--session-id'))).toBe(true)
  })

  test('la sesión activa sobrevive a una nueva instancia (--resume tras reiniciar la app)', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    await chat(b, { message: 'uno' })
    await b.cerrar()
    const b2 = await sb.backend()
    await chat(b2, { message: 'dos' })
    expect(valor(sb.llamadas[1]!, '--resume')).toBe(U.a)
  })

  test("'already in use' con --session-id reintenta con --resume y responde bien", async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    const r = await chat(b, { message: 'USADA' })
    expect(r.status).toBe(200)
    expect(r.obj.reply).toBe('hola betty')
    const ll = sb.llamadas
    expect(ll.length).toBe(2)
    expect(ll[0]!.includes('--session-id') && !ll[0]!.includes('--resume')).toBe(true)
    expect(ll[1]!.includes('--resume') && !ll[1]!.includes('--session-id')).toBe(true)
    // un solo par de mensajes guardado, sin error
    const h = msgs(await historial(b, { session: U.a }))
    expect(h.length).toBe(2)
    expect(h.every((m) => m.e == null)).toBe(true)
  })

  test.each(['NOCONV', 'NOTFOUND'])("'No conversation' / 'not found' con --resume reintenta con --session-id", async (clave) => {
    const sb = new Sandbox()
    const b = await sb.backend()
    expect((await chat(b, { message: 'primero' })).status).toBe(200) // marca la sesión activa
    const r = await chat(b, { message: clave })
    expect(r.status).toBe(200)
    const ll = sb.llamadas
    expect(ll.length).toBe(3)
    expect(ll[1]!.includes('--resume')).toBe(true)
    expect(ll[2]!.includes('--session-id') && !ll[2]!.includes('--resume')).toBe(true)
  })

  test('el reintento no se encadena: si la segunda forma también falla, error', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    // USADA falla con --session-id; el reintento con --resume funciona. Con NOCONV+USADA:
    // 1) --session-id -> USADA falla, 2) --resume -> NOCONV falla -> error final (no hay 3er intento)
    const r = await chat(b, { message: 'USADA NOCONV' })
    expect(r.status).toBe(500)
    expect(sb.llamadas.length).toBe(2)
    expect(String(r.obj.error).includes('No conversation')).toBe(true)
  })

  test('error de login -> mensaje amigable, 500, sin reintento y guardado como error', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    const r = await chat(b, { message: 'LOGINERR' })
    expect(r.status).toBe(500)
    expect(r.obj.error).toBe(mensajeLogin)
    expect(sb.llamadas.length).toBe(1)
    const h = msgs(await historial(b, { session: U.a }))
    expect(h.length).toBe(2)
    expect(h[1]!.e).toBe(true)
    expect(h[1]!.t).toBe('No pude responder: ' + mensajeLogin)
    // un chat fallido no marca la sesión como activa: el siguiente vuelve a --session-id
    await chat(b, { message: 'bien' })
    expect(sb.llamadas.at(-1)?.includes('--session-id')).toBe(true)
  })

  test('rc != 0 sin JSON -> 500 con el stderr', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    const r = await chat(b, { message: 'SALE3' })
    expect(r.status).toBe(500)
    expect(String(r.obj.error).includes('boom')).toBe(true)
  })

  test('is_error=true con rc 0 también es error', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    const r = await chat(b, { message: 'ISERR' })
    expect(r.status).toBe(500)
    expect(r.obj.error).toBe('fallo raro')
  })

  test('salida que no es JSON (rc 0) se devuelve como texto', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    const r = await chat(b, { message: 'NOJSON' })
    expect(r.status).toBe(200)
    expect(r.obj.reply).toBe('esto no es json')
  })

  // interno: llama a ClaudeRunner.parsearJSON directamente (unit test del port).
  test.skip('parsearJSON: objeto completo, ruido previo y basura', () => {})

  // interno: llama a ClaudeError.clasificar / .status directamente (unit test del port).
  test.skip("clasificar: 'login' (sin importar mayúsculas) es error de login; lo demás, error de claude", () => {})

  test('timeout -> 504, error guardado y ningún proceso huérfano (ni el hijo del claude)', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ config: { timeout: 1 } })
    const t0 = Date.now()
    const r = await chat(b, { message: 'LENTO' })
    expect(r.status).toBe(504)
    expect(r.obj.error).toBe('Tardó demasiado en responder.')
    expect(Date.now() - t0).toBeLessThan(8000)
    // interno (unit test del port): runner.procesosVivos == 0
    const pid = sb.childPid
    expect(pid).toBeDefined()
    expect(await esperar(() => !vivo(pid!), 3), 'el hijo del claude falso sigue vivo').toBe(true)
    const h = msgs(await historial(b, { session: U.a }))
    expect(h.at(-1)?.e).toBe(true)
    expect(h.at(-1)?.t).toBe('No pude responder: Tardó demasiado en responder.')
    // la app sigue usable después de un timeout
    const r2 = await chat(b, { message: 'ok', session: U.b })
    expect(r2.status).toBe(200)
  })

  test('el timeout de un agente no bloquea a otro, y su carril se libera', async () => {
    const sb = new Sandbox()
    const b = await sb.backend({ config: { timeout: 1 } })
    await chat(b, { message: 'LENTO' })
    const r = await chat(b, { message: 'siguiente', session: U.b }) // mismo agente, mismo carril
    expect(r.status).toBe(200)
  })

  test("shutdown() en pleno chat termina el proceso, el chat devuelve 'cerrando' y no queda huérfano", async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    const tarea = chat(b, { message: 'LENTO' }).then((r) => ({ r }), (e) => ({ e }))
    expect(await esperar(() => sb.childPid !== undefined)).toBe(true)
    const pid = sb.childPid!
    expect(vivo(pid)).toBe(true)
    const t0 = Date.now()
    await b.cerrar()
    expect(Date.now() - t0).toBeLessThan(6000)
    const res = await tarea
    // El servidor dev cierra el socket antes de apagar el backend: la respuesta 500 'cerrando' puede no llegar.
    if ('r' in res) {
      expect(res.r.status).toBe(500)
      expect(res.r.obj.error).toBe('La app se está cerrando.')
    }
    // interno (unit test del port): runner.procesosVivos == 0
    expect(await esperar(() => !vivo(pid), 3), 'el hijo del claude falso sigue vivo tras shutdown').toBe(true)
  })

  test('después de shutdown() un chat nuevo no lanza claude', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    await b.cerrar()
    // El servidor ya no escucha: no hay respuesta 500 'cerrando'; lo que se verifica es que no se lanza claude.
    const r = await chat(b).then((x) => x, () => undefined)
    if (r) expect(r.status).toBe(500)
    expect(sb.llamadas).toEqual([])
  })

  // interno: llama a runner.shutdown() dos veces y mira procesosVivos (unit test del port).
  test.skip('shutdown() sin procesos en curso es inmediato e idempotente', () => {})

  test('shutdown() mata el proceso que ignora SIGTERM (kill tras la gracia)', async () => {
    const sb = new Sandbox()
    // claude falso que ignora SIGTERM
    const terco = path.join(sb.root, 'bin', 'terco')
    fs.writeFileSync(terco, '#!/bin/bash\ntrap \'\' TERM\necho $$ > "$(dirname "$0")/terco.pid"\nwhile true; do sleep 0.1; done\n', { mode: 0o755 })
    const b = await sb.backend({ claudePath: terco })
    const tarea = chat(b, { message: 'x' }).then(() => undefined, () => undefined)
    const pidPath = path.join(sb.root, 'bin', 'terco.pid')
    expect(await esperar(() => fs.existsSync(pidPath))).toBe(true)
    const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10)
    expect(vivo(pid)).toBe(true)
    await b.cerrar()
    expect(await esperar(() => !vivo(pid), 3)).toBe(true)
    await tarea
  })

  test('un mismo agente se serializa: S,E,S,E (nunca dos a la vez)', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    const rs = await Promise.all([
      chat(b, { agent: 'betty', message: 'DORMIR 1', session: U.a }),
      chat(b, { agent: 'betty', message: 'DORMIR 2', session: U.b }),
      chat(b, { agent: 'betty', message: 'DORMIR 3', session: U.c }),
    ])
    expect(rs.every((r) => r.status === 200)).toBe(true)
    expect(sb.eventos).toEqual(['S betty', 'E betty', 'S betty', 'E betty', 'S betty', 'E betty'])
  })

  test('agentes distintos corren en paralelo', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    const t0 = Date.now()
    const rs = await Promise.all([
      chat(b, { agent: 'betty', message: 'DORMIR', session: U.a }),
      chat(b, { agent: 'marce', message: 'DORMIR', session: U.b }),
      chat(b, { agent: 'sofia', message: 'DORMIR', session: U.c }),
    ])
    const dt = (Date.now() - t0) / 1000
    expect(rs.every((r) => r.status === 200)).toBe(true)
    const ev = sb.eventos
    expect(ev.length).toBe(6)
    // los tres arrancan antes de que termine el primero
    expect(ev.slice(0, 3).every((e) => e.startsWith('S '))).toBe(true)
    expect(new Set(ev.slice(0, 3))).toEqual(new Set(['S betty', 'S marce', 'S sofia']))
    expect(dt, `tardó ${dt}s: parece secuencial`).toBeLessThan(2.6)
  })

  test('dos mensajes seguidos al mismo agente: el segundo ya usa --resume (carril cubre guardar+ejecutar)', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    const r1 = chat(b, { message: 'DORMIR uno', session: U.a })
    await new Promise((r) => setTimeout(r, 200))
    const r2 = chat(b, { message: 'dos', session: U.a })
    await Promise.all([r1, r2])
    const ll = sb.llamadas
    expect(ll.length).toBe(2)
    expect(ll[0]!.includes('--session-id')).toBe(true)
    expect(ll[1]!.includes('--resume')).toBe(true)
    // orden en el historial: u, a, u, a
    expect(msgs(await historial(b, { session: U.a })).map((m) => m.r)).toEqual(['u', 'a', 'u', 'a'])
  })

  test('el claude hijo corre con cwd = carpeta del proyecto', async () => {
    const sb = new Sandbox()
    const pwdBin = path.join(sb.root, 'bin', 'pwdclaude')
    fs.writeFileSync(pwdBin, '#!/bin/bash\npwd -P > "$(dirname "$0")/cwd.txt"\necho \'{"result":"ok","is_error":false}\'\n', { mode: 0o755 })
    const b = await sb.backend({ claudePath: pwdBin })
    await chat(b)
    const cwd = fs.readFileSync(path.join(sb.root, 'bin', 'cwd.txt'), 'utf8').trim()
    expect(sinPrivate(cwd)).toBe(sinPrivate(sb.proyecto))
  })

  // runner.authStatus se observa por HTTP como el campo `auth` de /api/estado (true/false; null sin claude).
  test('authStatus: true/false según rc; nil sin claude', async () => {
    const sb = new Sandbox()
    const b = await sb.backend()
    expect((await llamar(b, 'GET', '/api/estado')).obj.auth).toBe(true)
    // /api/estado cachea el estado de auth del servidor ya levantado: se mira con uno nuevo tras cambiar el rc.
    sb.setAuth(false)
    const b2 = await sb.backend()
    expect((await llamar(b2, 'GET', '/api/estado')).obj.auth).toBe(false)
    const sin = await sb.backend({ claudePath: path.join(sb.root, 'nada', 'claude') })
    expect((await llamar(sin, 'GET', '/api/estado')).obj.auth).toBeNull()
  })

  // interno: ClaudeLocator.locate con env/home inyectados (unit test del port).
  test.skip('ClaudeLocator: sin nada, nil; CLAUDE_BIN y config pisan; orden de rutas conocidas', () => {})

  // interno: ClaudeLocator.childEnvironment (unit test del port).
  test.skip('childEnvironment: PATH incluye el dir de claude y se quita CLAUDECODE', () => {})

  // interno: ClaudeLocator.childEnvironment (unit test del port).
  test.skip('childEnvironment: quita lo que inyecta una sesión de Claude Code y conserva la config del usuario', () => {})

  // interno: ClaudeLocator.argumentosShell / rutaDeSalida (unit test del port).
  test.skip('desdeShell: shell de login interactivo y ruta entre marcadores aunque el rc imprima ruido', () => {})
})
