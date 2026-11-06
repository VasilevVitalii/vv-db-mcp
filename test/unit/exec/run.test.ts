import { describe, it, expect } from 'vitest'
import type { DbConnection, TDbStreamEvent } from 'vv-db-connection'
import { runSql } from '../../../src/exec/run.js'
import type { ResolvedLimits } from '../../../src/config/schema.js'

const LIMITS: ResolvedLimits = {
  timeoutMs: 60000,
  maxTimeoutMs: 3600000,
  maxRows: 1000,
  maxRowsCap: 10000,
  maxCellChars: 65536,
  maxBinaryBytes: 4096,
}

function fakeDb(events: TDbStreamEvent[]): DbConnection {
  return {
    execStream: async (_sql: string, _params: unknown[], cb: (e: TDbStreamEvent) => void) => {
      for (const ev of events) cb(ev)
    },
  } as unknown as DbConnection
}

describe('runSql', () => {
  it('сериализует outParams: bigint → string, Date → ISO, Uint8Array → { $base64 }', async () => {
    const db = fakeDb([
      {
        kind: 'outParams',
        params: {
          id: 42n,
          at: new Date('2026-11-07T00:00:00Z'),
          raw: new Uint8Array([1, 2, 3]),
          nan: Number.NaN,
        },
      },
      { kind: 'finish' },
    ])
    const r = await runSql(db, 'CALL p(:id)', [], { timeoutMs: 5000, maxRows: 1000, limits: LIMITS })
    expect(r.outParams).toEqual({
      id: '42',
      at: '2026-11-07T00:00:00.000Z',
      raw: { $base64: 'AQID', bytes: 3, truncated: false },
      nan: 'NaN',
    })
  })

  it('outParams с bigint не падает на JSON.stringify (регрессия)', async () => {
    const db = fakeDb([
      { kind: 'outParams', params: { total: 9007199254740993n } },
      { kind: 'finish' },
    ])
    const r = await runSql(db, 'CALL p(:out)', [], { timeoutMs: 5000, maxRows: 1000, limits: LIMITS })
    expect(() => JSON.stringify(r)).not.toThrow()
    expect(r.outParams?.total).toBe('9007199254740993')
  })

  it('maxRows-обрыв без writes-хвоста → truncated + warning, не бросает', async () => {
    const db = fakeDb([
      { kind: 'schema', schema: [{ name: 'n', kind: 'int' }] },
      ...Array.from({ length: 6 }, (_, i) => ({ kind: 'row', row: { n: i } }) as TDbStreamEvent),
      { kind: 'finish', error: { kind: 'aborted', message: 'aborted by maxRows' } },
    ])
    const r = await runSql(db, 'SELECT n FROM t', [], { timeoutMs: 5000, maxRows: 5, limits: LIMITS })
    expect(r.resultSets[0].truncated).toBe(true)
    expect(r.resultSets[0].rows).toHaveLength(5)
    expect(r.warnings?.some((w) => w.includes('обрезан'))).toBe(true)
  })

  it('maxRows-обрыв с writes-хвостом → ошибка outcomeUnknown', async () => {
    const db = fakeDb([
      { kind: 'schema', schema: [{ name: 'n', kind: 'int' }] },
      ...Array.from({ length: 6 }, (_, i) => ({ kind: 'row', row: { n: i } }) as TDbStreamEvent),
      { kind: 'finish', error: { kind: 'aborted', message: 'aborted by maxRows' } },
    ])
    await expect(
      runSql(db, 'SELECT n FROM t; INSERT INTO x VALUES (1)', [], { timeoutMs: 5000, maxRows: 5, limits: LIMITS }),
    ).rejects.toMatchObject({ toolError: { error: { outcomeUnknown: true } } })
  })
})
