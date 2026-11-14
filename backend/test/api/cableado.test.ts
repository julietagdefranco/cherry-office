// Port de app/Tests/BackendTests/CableadoTests.swift.
// Cableado de la ejecución: comando de claude, MCP por perfil, ganchos del programador y routers extra.
// Sin acceso a internals (Permisos, Programador, MCPTokens, HerramientasCompuestas, routers extra…): esos tests/aserciones quedan para los unit tests del port.
import fs from 'node:fs'
import { describe, expect, test } from 'vitest'
import { Fix, Sandbox, U, chat, contratar, escribir, leerTexto, lista, llamar } from '../support/sandbox.js'

const fix = () => Fix.crear({ deps: ['Dirección'], agentes: [{ id: 'marce', depto: 'direccion', rol: 'Directora' }], env: { HQ_PROGRAMADOR: '0' } })

describe('Cableado de ejecución', () => {
  // MARK: comando

  // interno (unit test del port): Permisos.argumentos con ContextoOficina completo (orden exacto de todos los argumentos)
  test.skip('argumentos de un agente de oficina: orden exacto con todos los campos', () => {})

  // interno (unit test del port): Permisos.argumentos sin mcpUrl/vedadas/instrucciones
  test.skip('sin mcpUrl no hay --mcp-config ni herramientas MCP; sin vedadas ni instrucciones no hay esas opciones', () => {})

  test('un agente común: dontAsk y la veda de los conectores de claude.ai', async () => {
    const f = await fix()
    await chat(f.b, { agent: 'marce', message: 'hola', session: U.a })
    const l = f.sb.llamadas.at(-1)!
    expect(l).toBeDefined()
    expect(Sandbox.valor(l, '--permission-mode')).toBe('dontAsk')
    expect(Sandbox.valor(l, '--disallowedTools')).toBe('mcp__claude_ai_*')
    expect(l.includes('--append-system-prompt')).toBe(false)
  })

  // interno (unit test del port): Permisos.entorno(ctx) según ctx.permitidas
  test.skip('entorno: MCP_CONNECTION_NONBLOCKING=false solo si hay conectores de claude.ai permitidos', () => {})

  test('entorno: MCP_CONNECTION_NONBLOCKING=false llega al proceso hijo de ejecutarChat (sin conectores no se toca)', async () => {
    const sb = new Sandbox()
    // claude falso mínimo que anota la variable (o «-») y responde bien
    const bin = `${sb.root}/bin/claude-env`
    const salida = `${sb.root}/bin/env.log`
    // (solo los turnos de agente: la llamada sin --agent es el resumen del título del chat, que no es ejecutarChat)
    escribir(`#!/bin/bash\n[[ " $* " == *" --agent "* ]] && echo "\${MCP_CONNECTION_NONBLOCKING:--}" >> "${salida}"\necho '{"result":"ok","is_error":false}'\n`, bin)
    fs.chmodSync(bin, 0o755)
    const b = await sb.backend({ oficina: false, claudePath: bin })
    const r = await llamar(b, 'POST', '/api/oficinas', { body: { nombre: 'Taller', duenio: 'Ana', departamentos: ['Dirección'] } })
    expect(r.status).toBe(200)
    expect((await contratar(b, { id: 'marce', depto: 'direccion' })).status).toBe(200)
    // un agente con un conector de claude.ai asignado (lo que vuelve «permitida» a una herramienta)
    const c = await contratar(b, {
      id: 'nico', depto: 'direccion',
      extra: { conectores: [{ servidor: 'Google Calendar', leer: ['mcp__claude_ai_Google_Calendar__list_events'], actuar: [] }] },
    })
    expect(c.status).toBe(200)
    expect((await chat(b, { agent: 'marce', message: 'x', session: U.a })).status).toBe(200)
    expect((await chat(b, { agent: 'nico', message: 'x', session: U.b })).status).toBe(200)
    const lineas = leerTexto(salida).split('\n').filter((l) => l !== '')
    // sin conectores no se toca lo heredado (el servidor de prueba no hereda la variable: «-»); con conectores, «false»
    expect(lineas).toEqual(['-', 'false'])
  })

  // interno: llamaba directo a runner.turnoSoloLectura (orden exacto de argumentos, con y sin instrucciones)
  test.skip('turnoSoloLectura: orden exacto, con y sin instrucciones', () => {})

  // MARK: programador

  // interno (unit test del port): Programador.origenEntrega / idFlujo / deFlujo
  test.skip('origenEntrega por prefijo y deFlujo / idFlujo', () => {})

  // interno: programador.encargarLibre y alEntregar (callbacks del programador)
  test.skip('encargarLibre con flujo:1:0:1: entrega con origen flujo y dispara alEntregar con la ejecución', () => {})

  // interno: programador.alTerminar (ganchos en lista)
  test.skip('alTerminar agrega ganchos (no reemplaza)', () => {})

  // interno: programador.encargarLibre + store.ejecucion + mcp.tokens.activos
  test.skip('una corrida del programador con MCP pasa --mcp-config y las herramientas del perfil, y revoca el token', () => {})

  // MARK: MCP

  // interno (unit test del port): MCPTokens (perfil y cupo genérico tomar(clave:max:))
  test.skip("tokens: perfil por defecto 'agente', perfil explícito y cupo genérico tomar(clave:max:)", () => {})

  // interno (unit test del port): HerramientasCompuestas / HerramientasVacias
  test.skip('HerramientasCompuestas: concatena definiciones y llama al primero que responde', () => {})

  // interno: mcp.consultas.herramientas(token:identidad:) por perfil
  test.skip('el servidor compone por perfil: agente -> hq; creador -> las del Creador', () => {})

  // interno (unit test del port): HerramientasMCPAgente.lista == Permisos.herramientasMCP
  test.skip('lista de herramientas MCP del agente: sin duplicados, empieza por las propias de hq', () => {})

  // MARK: router y API

  // interno: b.registrarExtra(SubRouter) (routers extra que atienden antes que los demás)
  test.skip('un router extra atiende antes que los demás', () => {})

  test('/api/actividad trae corridas y creadorVersion (con y sin oficina)', async () => {
    const f = await fix()
    const r = await f.get('/api/actividad')
    expect(lista(r.obj.corridas)).toEqual([])
    expect(r.obj.creadorVersion).toBe(0)
    // interno (unit test del port): VersionCreador.compartida.subir(carpeta) y que creadorVersion lo refleje (>= 1)
    // sin oficina activa
    const sb = new Sandbox({ proyecto: false })
    const b = await sb.backend({ oficina: false })
    const v = await llamar(b, 'GET', '/api/actividad')
    expect(Array.isArray(v.obj.corridas) && v.obj.corridas.length === 0 && v.obj.creadorVersion === 0).toBe(true)
  })

  // interno (unit test del port): VersionCreador y CatalogoConectores
  test.skip('VersionCreador sube por oficina; CatalogoConectores guarda y limpia', () => {})
})
