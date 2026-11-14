// Prepara el backend contra el que corre la suite de paridad.
//   HQ_BACKEND=swift (default mientras no exista el port): compila `oficina-dev` del backend Swift.
//   HQ_BACKEND=ts: compila el backend TypeScript (`backend/src/dev.ts` → `dist/src/dev.js`).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestProject } from 'vitest/node'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const raizBackend = path.resolve(aqui, '../..')
const raizRepo = path.resolve(raizBackend, '..')

export type ComandoServidor = { exe: string; args: string[]; nombre: 'swift' | 'ts' }

declare module 'vitest' {
  export interface ProvidedContext {
    servidor: ComandoServidor
  }
}

export default function setup(project: TestProject) {
  const cual = (process.env.HQ_BACKEND ?? 'swift').toLowerCase()
  let cmd: ComandoServidor
  if (cual === 'swift') {
    const app = path.join(raizRepo, 'app')
    execFileSync('swift', ['build', '--product', 'oficina-dev'], { cwd: app, stdio: ['ignore', 'ignore', 'inherit'] })
    const bin = execFileSync('swift', ['build', '--show-bin-path'], { cwd: app, encoding: 'utf8' }).trim()
    cmd = { nombre: 'swift', exe: path.join(bin, 'oficina-dev'), args: [] }
  } else if (cual === 'ts') {
    if (!existsSync(path.join(raizBackend, 'src/dev.ts'))) {
      throw new Error('HQ_BACKEND=ts: todavía no existe backend/src/dev.ts')
    }
    execFileSync(process.execPath, [path.join(raizBackend, 'node_modules/typescript/bin/tsc')], {
      cwd: raizBackend,
      stdio: 'inherit',
    })
    cmd = { nombre: 'ts', exe: process.execPath, args: [path.join(raizBackend, 'dist/src/dev.js')] }
  } else {
    throw new Error(`HQ_BACKEND desconocido: ${cual} (swift | ts)`)
  }
  project.provide('servidor', cmd)
}
