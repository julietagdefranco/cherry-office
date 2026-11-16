// Medidor de uso del plan (src/uso-claude.ts): parseo de la cuenta, caché, caída a los rate_limit_event de las corridas.
import { describe, expect, test } from 'vitest'
import { MedidorUso, parsearUso, URL_USO } from '../../src/uso-claude.js'

const T0 = Date.parse('2026-11-16T12:00:00Z')
const respuesta = {
  five_hour: { utilization: 42.04, resets_at: '2026-11-16T14:13:00Z' },
  seven_day: { utilization: 61, resets_at: '2026-11-19T14:00:00+00:00' },
  seven_day_opus: null,
}

function medidor({ status = 200, cuerpo = respuesta as unknown, cred = { token: 'tk', vence: T0 + 3600_000 } as { token: string; vence?: number } | null } = {}) {
  let t = T0
  const pedidos: { url: string; headers: Record<string, string> }[] = []
  const m = new MedidorUso({
    home: '/no',
    ahora: () => t,
    leerCredencial: async () => cred ?? undefined,
    fetch: async (url, init) => { pedidos.push({ url, headers: init.headers }); return { status, json: async () => cuerpo } },
  })
  return { m, pedidos, avanzar: (ms: number) => { t += ms } }
}

describe('parsearUso', () => {
  test('ventanas de 5 h y semanal; Opus nulo se omite; estado según el porcentaje', () => {
    const u = parsearUso(respuesta, T0)!
    expect(u).toEqual({
      disponible: true, fuente: 'cuenta', actualizado: '2026-11-16T12:00:00.000Z',
      cinco_horas: { pct: 42, estado: 'ok', reinicia: '2026-11-16T14:13:00.000Z' },
      semana: { pct: 61, estado: 'ok', reinicia: '2026-11-19T14:00:00.000Z' },
    })
    expect(parsearUso({ five_hour: { utilization: 85 }, seven_day: { utilization: 100 } }, T0)).toMatchObject({ cinco_horas: { estado: 'cerca' }, semana: { estado: 'limite' } })
  })
  test('sin ventanas reconocibles: undefined', () => {
    expect(parsearUso({}, T0)).toBeUndefined()
    expect(parsearUso({ five_hour: { utilization: 'x' } }, T0)).toBeUndefined()
    expect(parsearUso(null, T0)).toBeUndefined()
  })
})

describe('MedidorUso', () => {
  test('pide a la cuenta con el token y el beta de OAuth, y cachea 90 s', async () => {
    const { m, pedidos, avanzar } = medidor()
    expect((await m.leer()).semana?.pct).toBe(61)
    expect(pedidos).toHaveLength(1)
    expect(pedidos[0]).toEqual({ url: URL_USO, headers: expect.objectContaining({ Authorization: 'Bearer tk', 'anthropic-beta': 'oauth-2025-04-20' }) })
    avanzar(60_000); await m.leer()
    expect(pedidos).toHaveLength(1)
    avanzar(31_000); await m.leer()
    expect(pedidos).toHaveLength(2)
  })
  test('forzar saltea la caché, pero no más de una vez cada 30 s', async () => {
    const { m, pedidos, avanzar } = medidor()
    await m.leer(); await m.leer(true)
    expect(pedidos).toHaveLength(1)
    avanzar(30_000); await m.leer(true)
    expect(pedidos).toHaveLength(2)
  })
  test('el token nunca aparece en la respuesta', async () => {
    const { m } = medidor()
    expect(JSON.stringify(await m.leer())).not.toContain('tk')
  })
  test('sin sesión, vencido o con error: no disponible y el motivo', async () => {
    expect(await medidor({ cred: null }).m.leer()).toEqual({ disponible: false, motivo: 'sin_sesion' })
    expect(await medidor({ cred: { token: 'tk', vence: T0 - 1 } }).m.leer()).toEqual({ disponible: false, motivo: 'vencido' })
    expect(await medidor({ status: 401 }).m.leer()).toEqual({ disponible: false, motivo: 'vencido' })
    expect(await medidor({ status: 500 }).m.leer()).toEqual({ disponible: false, motivo: 'error' })
    expect(await medidor({ cuerpo: { otra: 1 } }).m.leer()).toEqual({ disponible: false, motivo: 'error' })
  })
  test('si la cuenta no responde, usa los rate_limit_event de las corridas (utilization en fracción, resetsAt en segundos)', async () => {
    const { m, avanzar } = medidor({ status: 500 })
    m.registrarLimite({ status: 'allowed_warning', rateLimitType: 'seven_day', resetsAt: T0 / 1000 + 3600, utilization: 0.834 })
    m.registrarLimite({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: T0 / 1000 + 600 })
    const u = await m.leer()
    expect(u).toMatchObject({
      disponible: true, fuente: 'corridas', motivo: 'error',
      semana: { pct: 83.4, estado: 'cerca', reinicia: new Date(T0 + 3600_000).toISOString() },
      cinco_horas: { pct: 100, estado: 'limite' },
    })
    // pasado el reinicio, lo de la corrida ya no vale
    avanzar(601_000)
    const d = await m.leer(true)
    expect(d.cinco_horas).toBeUndefined()
    expect(d.semana?.pct).toBe(83.4)
  })
  test('con datos de la cuenta, los de las corridas no pisan nada', async () => {
    const { m } = medidor()
    m.registrarLimite({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.1 })
    expect((await m.leer()).semana?.pct).toBe(61)
  })
})
