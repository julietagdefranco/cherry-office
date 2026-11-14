// Encuentra el binario de `claude` y arma el entorno para los procesos hijos (ClaudeLocator.swift), en Mac, Linux y Windows.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const esWindows = process.platform === 'win32'

export function ejecutable(p: string): boolean {
  try {
    const s = fs.statSync(p)
    if (!s.isFile()) return false
    if (esWindows) return true
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Valor de una variable sin importar mayúsculas (en Windows `Path` y `PATH` son la misma). */
export function variable(env: NodeJS.ProcessEnv, nombre: string): string | undefined {
  if (!esWindows) return env[nombre]
  const k = Object.keys(env).find((x) => x.toUpperCase() === nombre.toUpperCase())
  return k === undefined ? undefined : env[k]
}

/** Orden: CLAUDE_BIN, `explicito` (config), rutas conocidas, app de Claude (la más nueva) y, último recurso,
 *  el shell de login (`$SHELL -ilc 'command -v claude'`) o `where claude` en Windows. */
export function locate({ explicito, env = process.env, home = os.homedir(), usarShell = true }: {
  explicito?: string; env?: NodeJS.ProcessEnv; home?: string; usarShell?: boolean
} = {}): string | undefined {
  const b = variable(env, 'CLAUDE_BIN')
  if (b) return b
  if (explicito) return explicito
  for (const p of rutasFijas(home, env)) if (ejecutable(p)) return p
  const app = appBundled(home)
  if (app) return app
  if (usarShell) return esWindows ? desdeWhere(env) : desdeShell(env)
  return undefined
}

function rutasFijas(home: string, env: NodeJS.ProcessEnv): string[] {
  if (esWindows) {
    const appdata = variable(env, 'APPDATA') ?? path.join(home, 'AppData', 'Roaming')
    const local = variable(env, 'LOCALAPPDATA') ?? path.join(home, 'AppData', 'Local')
    // Preferimos el .exe nativo: un shim .cmd obliga a pasar por cmd.exe (ver claude-runner.ts).
    return [path.join(home, '.local', 'bin', 'claude.exe'), path.join(local, 'Programs', 'claude', 'claude.exe'),
      path.join(home, '.claude', 'local', 'claude.exe'), path.join(appdata, 'npm', 'claude.cmd')]
  }
  return ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude')]
}

/** macOS: ~/Library/Application Support/Claude/claude-code/<a>/<b>/claude.app/Contents/MacOS/claude, el más nuevo. */
function appBundled(home: string): string | undefined {
  if (process.platform !== 'darwin') return undefined
  const base = path.join(home, 'Library/Application Support/Claude/claude-code')
  let mejor: [string, number] | undefined
  const leer = (d: string) => { try { return fs.readdirSync(d) } catch { return [] } }
  for (const a of leer(base)) {
    for (const b of leer(path.join(base, a))) {
      const p = path.join(base, a, b, 'claude.app/Contents/MacOS/claude')
      if (!ejecutable(p)) continue
      const m = fs.statSync(p).mtimeMs
      if (!mejor || m > mejor[1]) mejor = [p, m]
    }
  }
  return mejor?.[0]
}

export const marcaInicio = '__HQ_CLAUDE_S__'
export const marcaFin = '__HQ_CLAUDE_E__'

/** Shell de login interactivo (`-ilc`): el PATH de nvm o del instalador suele estar en `.zshrc`. La ruta va entre
 *  marcadores porque los rc interactivos imprimen ruido. */
export function argumentosShell(): string[] {
  return ['-ilc', `printf '${marcaInicio}%s${marcaFin}' "$(command -v claude)"`]
}

/** Lo que está entre los marcadores, si es absoluto. */
export function rutaDeSalida(s: string): string | undefined {
  const a = s.indexOf(marcaInicio)
  if (a < 0) return undefined
  const b = s.indexOf(marcaFin, a + marcaInicio.length)
  if (b < 0) return undefined
  const ruta = s.slice(a + marcaInicio.length, b).trim()
  return path.isAbsolute(ruta) ? ruta : undefined
}

function desdeShell(env: NodeJS.ProcessEnv, timeout = 5000): string | undefined {
  const shell = env.SHELL && ejecutable(env.SHELL) ? env.SHELL : '/bin/zsh'
  const r = spawnSync(shell, argumentosShell(), { stdio: ['ignore', 'pipe', 'ignore'], timeout, killSignal: 'SIGKILL', encoding: 'utf8' })
  const ruta = rutaDeSalida(r.stdout ?? '')
  return ruta && ejecutable(ruta) ? ruta : undefined
}

function desdeWhere(env: NodeJS.ProcessEnv, timeout = 5000): string | undefined {
  const r = spawnSync('where.exe', ['claude'], { stdio: ['ignore', 'pipe', 'ignore'], timeout, encoding: 'utf8', env })
  const rutas = (r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && ejecutable(l))
  return rutas.find((l) => l.toLowerCase().endsWith('.exe')) ?? rutas[0]
}

/** PATH razonable para el hijo: dir de claude, node (nvm/volta/asdf/fnm), homebrew, sistema y el PATH heredado. */
export function childPath(claude: string | undefined, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const dirs: string[] = []
  if (claude) dirs.push(path.dirname(claude))
  if (esWindows) {
    const appdata = variable(env, 'APPDATA') ?? path.join(home, 'AppData', 'Roaming')
    dirs.push(path.join(home, '.local', 'bin'), path.join(appdata, 'npm'))
  } else {
    dirs.push(path.join(home, '.local/bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin')
    const nvm = path.join(home, '.nvm/versions/node')
    let versiones: string[] = []
    try {
      versiones = fs.readdirSync(nvm)
    } catch {}
    versiones.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    dirs.push(...versiones.map((v) => path.join(nvm, v, 'bin')))
    dirs.push(path.join(home, '.volta/bin'), path.join(home, '.asdf/shims'), path.join(home, '.fnm/aliases/default/bin'),
      '/usr/bin', '/bin', '/usr/sbin', '/sbin')
  }
  dirs.push(...(variable(env, 'PATH') ?? '').split(path.delimiter))
  const visto = new Set<string>()
  return dirs.filter((d) => d !== '' && !visto.has(d) && (visto.add(d), true)).join(path.delimiter)
}

/** Variables `CLAUDE_CODE_*` que el usuario pone a propósito (proveedor, auth, límites): se conservan. */
const configDeUsuario = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_SUBAGENT_MODEL',
])

/** ¿Variable que inyecta una sesión de Claude Code a sus hijos? Un claude hijo que las hereda se cree anidado. */
export function heredadaDeSesion(k: string): boolean {
  if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_AGENT_SDK_')) return true
  if (!k.startsWith('CLAUDE_CODE_')) return false
  if (k.startsWith('CLAUDE_CODE_USE_') || k.startsWith('CLAUDE_CODE_SKIP_')) return false
  return !configDeUsuario.has(k)
}

/** Entorno del hijo: el heredado con PATH ampliado y sin variables que confundan a un claude anidado. */
export function childEnvironment(claude: string | undefined, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Record<string, string> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || heredadaDeSesion(k)) continue
    if (esWindows && k.toUpperCase() === 'PATH') continue // una sola clave PATH
    e[k] = v
  }
  e.PATH = childPath(claude, env, home)
  if (variable(e, 'HOME') === undefined && !esWindows) e.HOME = home
  return e
}

/** Resuelve (y cachea) la ruta de claude. Si no está, reintenta barato en cada consulta (el usuario puede
 *  instalarlo con la app abierta) y el shell de login como máximo cada 30 s. */
export class ClaudePathResolver {
  private cache?: string
  private ultimoShell = 0

  /** `fijo`: ruta forzada (tests/inyección), sin búsqueda. */
  constructor(private readonly op: { fijo?: string; explicito?: string; env?: NodeJS.ProcessEnv; home?: string } = {}) {}

  path(): string | undefined {
    if (this.op.fijo) return this.op.fijo
    const env = this.op.env ?? process.env
    if (this.cache && (ejecutable(this.cache) || variable(env, 'CLAUDE_BIN'))) return this.cache
    const shell = Date.now() - this.ultimoShell > 30_000
    if (shell) this.ultimoShell = Date.now()
    this.cache = locate({ explicito: this.op.explicito, env, home: this.op.home, usarShell: shell })
    return this.cache
  }
}
