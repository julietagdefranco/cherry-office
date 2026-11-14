// El oficina.json que escribe el backend (Swift o TS) tiene que quedar byte a byte igual al que escribe
// OficinaStore.codificar del port: así pasar de una app a la otra no deja diffs en las carpetas de los usuarios.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import { OficinaStore } from '../../src/oficina.js'
import { Fix } from '../support/sandbox.js'

test('oficina.json: mismo formato byte a byte (claves ordenadas, " : ", listas vacías, unicode, opcionales)', async () => {
  const f = await Fix.crear({ nombre: 'Taller «Ñandú» 😀 a/b', duenio: 'Ana "la jefa" \\ x' })
  await f.post('/api/departamentos', { nombre: 'Diseño & Marca', color: '#ABCDEF', mision: 'Línea uno\nlínea dos\ttab' })
  await f.put('/api/perfil', { nombre: 'Ana', avatar: { pelo: 'corto', colorTorso: '#141414' } })
  const escrito = fs.readFileSync(path.join(f.carpeta, 'oficina.json'), 'utf8')
  expect(escrito.endsWith('\n')).toBe(false)
  expect(escrito).toContain('"agentes" : [\n\n  ]')
  expect(OficinaStore.codificar(OficinaStore.leer(f.carpeta))).toBe(escrito)
})
