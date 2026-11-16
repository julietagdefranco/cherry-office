// /api/uso-claude: en el sandbox no hay sesión de Claude Code (HOME temporal, sin llavero), así que solo quedan
// los rate_limit_event que mandan las corridas.
import { describe, expect, test } from 'vitest'
import { Fix, U, chat, llamar } from '../support/sandbox.js'

describe('Uso de Claude (API)', () => {
  test('sin sesión: no disponible; después de una corrida, el uso semanal que avisó claude', async () => {
    const f = await Fix.crear({ agentes: [{ id: 'marce', depto: 'direccion', rol: 'Directora' }] })
    const antes = await llamar(f.b, 'GET', '/api/uso-claude')
    expect(antes.status).toBe(200)
    expect(antes.obj).toEqual({ disponible: false, motivo: 'sin_sesion' })

    const r = await chat(f.b, { agent: 'marce', message: 'STREAM hola', session: U.a })
    expect(r.status).toBe(200)
    const d = await llamar(f.b, 'GET', '/api/uso-claude')
    expect(d.obj).toMatchObject({ disponible: true, fuente: 'corridas', semana: { pct: 83, estado: 'cerca' } })
    expect(typeof d.obj.semana.reinicia).toBe('string')
    expect((await llamar(f.b, 'POST', '/api/uso-claude')).status).toBe(405)
  })
})
