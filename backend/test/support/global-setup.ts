// Prepara el backend contra el que corre la suite: compila el backend TypeScript (`backend/src/dev.ts` →
// `dist/src/dev.js`) y le pasa a los tests el comando para levantarlo. Cada test arranca su propio servidor de
// desarrollo contra un sandbox (ver sandbox.ts) y le habla por HTTP, como el front.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestProject } from 'vitest/node'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const raizBackend = path.resolve(aqui, '../..')

export type ComandoServidor = { exe: string; args: string[] }

declare module 'vitest' {
  export interface ProvidedContext {
    servidor: ComandoServidor
  }
}

export default function setup(project: TestProject) {
  execFileSync(process.execPath, [path.join(raizBackend, 'node_modules/typescript/bin/tsc')], {
    cwd: raizBackend,
    stdio: 'inherit',
  })
  project.provide('servidor', { exe: process.execPath, args: [path.join(raizBackend, 'dist/src/dev.js')] })
}
