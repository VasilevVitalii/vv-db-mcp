import { describe, it, expect } from 'vitest'
import type { DbConnection } from 'vv-db-connection'
import { ConnectionRegistry } from '../../../src/connections/registry.js'
import type { LoadedConnection } from '../../../src/config/load.js'
import type { ResolvedLimits } from '../../../src/config/schema.js'

const LIMITS: ResolvedLimits = {
  timeoutMs: 60000,
  maxTimeoutMs: 3600000,
  maxRows: 1000,
  maxRowsCap: 10000,
  maxCellChars: 65536,
  maxBinaryBytes: 4096,
}

function loaded(name: string): LoadedConnection {
  return {
    name,
    kind: 'pg',
    db: { close: async () => {} } as unknown as DbConnection,
    title: 'PG',
    user: 'u',
    limits: LIMITS,
    secrets: [],
  }
}

describe('ConnectionRegistry.get', () => {
  it('точное имя', () => {
    const r = new ConnectionRegistry([loaded('Prod'), loaded('dev')], [])
    expect(r.get('Prod').name).toBe('Prod')
  })

  it('ci-fallback: единственное совпадение без учёта регистра', () => {
    const r = new ConnectionRegistry([loaded('Prod'), loaded('dev')], [])
    expect(r.get('prod').name).toBe('Prod')
  })

  it('ci-fallback: несколько совпадений — не угадываем, unknown_connection', () => {
    const r = new ConnectionRegistry([loaded('Prod'), loaded('PROD')], [])
    expect(() => r.get('prod')).toThrow(/неизвестное подключение/)
  })

  it('нет совпадения — unknown_connection со списком доступных', () => {
    const r = new ConnectionRegistry([loaded('a'), loaded('b')], [])
    expect(() => r.get('c')).toThrow(/неизвестное подключение: c; доступны: a, b/)
  })
})
