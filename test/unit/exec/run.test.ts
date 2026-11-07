import { describe, it, expect } from 'vitest'
import type { DbConnection, TDbError, TDbRes, TDbStreamEvent, TDbTxCb, TDbTxExec } from 'vv-db-connection'
import { runSql, runTx } from '../../../src/exec/run.js'
import type { ResolvedLimits } from '../../../src/config/schema.js'

const LIMITS: ResolvedLimits = {
  timeoutMs: 60000,
  maxTimeoutMs: 3600000,
  maxRows: 1000,
  maxRowsCap: 10000,
  maxCellChars: 65536,
  maxBinaryBytes: 4096,
}

async function catchError(p: Promise<unknown>): Promise<{ toolError: { error: Record<string, unknown> } }> {
  try {
    await p
  } catch (e) {
    return e as { toolError: { error: Record<string, unknown> } }
  }
  throw new Error('ожидался reject')
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

  it('maxRows-обрыв одиночного оператора не упоминает последующие операторы', async () => {
    const db = fakeDb([
      { kind: 'schema', schema: [{ name: 'n', kind: 'int' }] },
      ...Array.from({ length: 6 }, (_, i) => ({ kind: 'row', row: { n: i } }) as TDbStreamEvent),
      { kind: 'finish', error: { kind: 'aborted', message: 'aborted by maxRows' } },
    ])
    const r = await runSql(db, 'SELECT n FROM t', [], { timeoutMs: 5000, maxRows: 5, limits: LIMITS })
    expect(r.resultSets[0].truncated).toBe(true)
    expect(r.warnings?.some((w) => w.includes('последующие операторы'))).toBe(false)
    expect(r.warnings?.some((w) => w.includes('результат обрезан по maxRows'))).toBe(true)
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

  it('клиентская отмена после maxRows-обрыва → ошибка aborted, а не успех', async () => {
    const db = fakeDb([
      { kind: 'schema', schema: [{ name: 'n', kind: 'int' }] },
      ...Array.from({ length: 6 }, (_, i) => ({ kind: 'row', row: { n: i } }) as TDbStreamEvent),
      { kind: 'finish', error: { kind: 'aborted', message: 'aborted' } },
    ])
    const err = await catchError(
      runSql(db, 'SELECT n FROM t', [], {
        signal: AbortSignal.abort(),
        timeoutMs: 5000,
        maxRows: 5,
        limits: LIMITS,
      }),
    )
    expect(err.toolError.error.kind).toBe('aborted')
    expect(err.toolError.error.outcomeUnknown).toBeUndefined()
  })
})

// fakeTxDb отдаёт транзакционному телу exec(), возвращающий implicitResults
// (Oracle DBMS_SQL.RETURN_RESULT), и пробрасывает результат тела наружу.
function fakeTxDb(implicitResults: TDbRes[]): DbConnection {
  return {
    execTxDynamic: async (cb: TDbTxCb<{ committed: true; statements: unknown[] }>) => {
      const exec: TDbTxExec = async () => ({ rows: [], implicitResults })
      const result = await cb(exec, new AbortController().signal)
      return { ok: true, result }
    },
  } as unknown as DbConnection
}

function fakeTxDbError(error: TDbError): DbConnection {
  return {
    execTxDynamic: async () => ({ ok: false, error }),
  } as unknown as DbConnection
}

// exec() бросает ошибку на операторе с индексом failIndex — драйвер пробрасывает
// её наружу как { ok: false, error }. Позволяет проверить statementIndex>0.
function fakeTxDbExecThrows(failIndex: number, error: TDbError): DbConnection {
  return {
    execTxDynamic: async (cb: TDbTxCb<{ committed: true; statements: unknown[] }>) => {
      let i = 0
      const exec: TDbTxExec = async () => {
        if (i++ === failIndex) throw error
        return { rows: [] }
      }
      try {
        const result = await cb(exec, new AbortController().signal)
        return { ok: true, result }
      } catch (e) {
        return { ok: false, error: e as TDbError }
      }
    },
  } as unknown as DbConnection
}

describe('runTx', () => {
  it('обрезает implicitResults по maxRows и ставит truncated (регрессия)', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ n: i }))
    const db = fakeTxDb([{ schema: [{ name: 'n', kind: 'int' }], rows: six }])
    const r = await runTx(db, [{ sql: 'CALL p()', params: [] }], { timeoutMs: 5000, maxRows: 5, limits: LIMITS })
    expect(r.committed).toBe(true)
    expect(r.statements).toHaveLength(1)
    const ir = r.statements[0].implicitResults!
    expect(ir).toHaveLength(1)
    expect(ir[0].truncated).toBe(true)
    expect(ir[0].rows).toHaveLength(5)
    expect(ir[0].rowCount).toBe(5)
  })

  it('tx NJS-040 (bind) не считается потерей связи → outcomeUnknown отсутствует', async () => {
    const db = fakeTxDbError({ kind: 'tx', code: 'NJS-040', message: 'bind error' })
    const err = await catchError(runTx(db, [{ sql: 'SELECT 1', params: [] }], { timeoutMs: 5000, maxRows: 5, limits: LIMITS }))
    expect(err.toolError.error.kind).toBe('tx')
    expect(err.toolError.error.code).toBe('NJS-040')
    expect(err.toolError.error.outcomeUnknown).toBeUndefined()
  })

  it('tx NJS-500 (сетевой) — потеря связи → outcomeUnknown true', async () => {
    const db = fakeTxDbError({ kind: 'tx', code: 'NJS-500', message: 'connection lost' })
    const err = await catchError(runTx(db, [{ sql: 'SELECT 1', params: [] }], { timeoutMs: 5000, maxRows: 5, limits: LIMITS }))
    expect(err.toolError.error.outcomeUnknown).toBe(true)
  })

  it('ошибка query до первого exec не содержит statementIndex', async () => {
    const db = fakeTxDbError({ kind: 'query', message: 'bad start' })
    const err = await catchError(runTx(db, [{ sql: 'SELECT 1', params: [] }], { timeoutMs: 5000, maxRows: 5, limits: LIMITS }))
    expect(err.toolError.error.kind).toBe('query')
    expect(err.toolError.error.statementIndex).toBeUndefined()
  })

  it('ошибка query на 2-м операторе → statementIndex: 1', async () => {
    const db = fakeTxDbExecThrows(1, { kind: 'query', message: 'bad sql' })
    const err = await catchError(
      runTx(
        db,
        [
          { sql: 'SELECT 1', params: [] },
          { sql: 'SELECT bad', params: [] },
        ],
        { timeoutMs: 5000, maxRows: 5, limits: LIMITS },
      ),
    )
    expect(err.toolError.error.kind).toBe('query')
    expect(err.toolError.error.statementIndex).toBe(1)
  })

  it('COMMIT_TIMEOUT → outcomeUnknown true', async () => {
    const db = fakeTxDbError({ kind: 'tx', code: 'COMMIT_TIMEOUT', message: 'commit timeout' })
    const err = await catchError(runTx(db, [{ sql: 'SELECT 1', params: [] }], { timeoutMs: 5000, maxRows: 5, limits: LIMITS }))
    expect(err.toolError.error.outcomeUnknown).toBe(true)
  })

  it('aborted → outcomeUnknown true', async () => {
    const db = fakeTxDbError({ kind: 'aborted', message: 'aborted' })
    const err = await catchError(runTx(db, [{ sql: 'SELECT 1', params: [] }], { timeoutMs: 5000, maxRows: 5, limits: LIMITS }))
    expect(err.toolError.error.outcomeUnknown).toBe(true)
  })
})
