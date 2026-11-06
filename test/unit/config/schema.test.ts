import { describe, it, expect } from 'vitest'
import { resolveLimits, mergeLimits, LIMIT_DEFAULTS, configSchema } from '../../../src/config/schema.js'

describe('resolveLimits / mergeLimits', () => {
  it('resolveLimits(undefined) → дефолты', () => {
    expect(resolveLimits(undefined)).toEqual(LIMIT_DEFAULTS)
  })

  it('resolveLimits переопределяет только заданные', () => {
    const r = resolveLimits({ timeoutMs: 100 })
    expect(r.timeoutMs).toBe(100)
    expect(r.maxRows).toBe(LIMIT_DEFAULTS.maxRows)
    expect(r.maxRowsCap).toBe(LIMIT_DEFAULTS.maxRowsCap)
  })

  it('mergeLimits: local поверх global', () => {
    const g = resolveLimits(undefined)
    const m = mergeLimits(g, { maxRows: 5 })
    expect(m.maxRows).toBe(5)
    expect(m.timeoutMs).toBe(g.timeoutMs)
  })

  it('mergeLimits(global, undefined) → global', () => {
    const g = resolveLimits(undefined)
    expect(mergeLimits(g, undefined)).toEqual(g)
  })
})

describe('configSchema', () => {
  const pg = { kind: 'pg', name: 'db1', host: 'h', database: 'd', user: 'u', password: 'p' }

  it('валидный pg проходит', () => {
    expect(configSchema.safeParse({ connections: [pg] }).success).toBe(true)
  })

  it('пустой connections → ошибка', () => {
    expect(configSchema.safeParse({ connections: [] }).success).toBe(false)
  })

  it('порт вне диапазона → ошибка', () => {
    const r = configSchema.safeParse({ connections: [{ ...pg, port: 70000 }] })
    expect(r.success).toBe(false)
  })

  it('неизвестный kind → ошибка', () => {
    const r = configSchema.safeParse({ connections: [{ ...pg, kind: 'bogus' }] })
    expect(r.success).toBe(false)
  })

  it('name не по формату → ошибка', () => {
    const r = configSchema.safeParse({ connections: [{ ...pg, name: '1bad name!' }] })
    expect(r.success).toBe(false)
  })

  it('глобальные limits применяются', () => {
    const r = configSchema.safeParse({ limits: { maxRows: 42 }, connections: [pg] })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.limits?.maxRows).toBe(42)
  })
})
