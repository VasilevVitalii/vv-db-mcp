import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DbConnection, TDbStreamEvent } from 'vv-db-connection'
import type { ConnectionRegistry, Entry } from '../../../src/connections/registry.js'
import type { ResolvedLimits } from '../../../src/config/schema.js'
import type { ToolCtx } from '../../../src/tools/define.js'
import { sampleRowsTool } from '../../../src/tools/meta.js'

// Фейковый каталог подменяет getCatalog: handler получает предсказуемые
// listTables/listViews/describeTable/buildSampleSql без живой СУБД.
const holders = vi.hoisted(() => ({ catalog: null as unknown }))

vi.mock('../../../src/catalog/index.js', () => ({
  getCatalog: () => holders.catalog,
}))

const LIMITS: ResolvedLimits = {
  timeoutMs: 60000,
  maxTimeoutMs: 3600000,
  maxRows: 1000,
  maxRowsCap: 10000,
  maxCellChars: 65536,
  maxBinaryBytes: 4096,
}

function makeDb(rowCount: number, onSql?: (sql: string) => void): DbConnection {
  return {
    execStream: async (sql: string, _params: unknown[], cb: (ev: TDbStreamEvent) => void) => {
      onSql?.(sql)
      cb({ kind: 'schema', schema: [{ name: 'ID', kind: 'int' }] } as TDbStreamEvent)
      for (let i = 0; i < rowCount; i++) cb({ kind: 'row', row: { ID: i } } as TDbStreamEvent)
      cb({ kind: 'finish' } as TDbStreamEvent)
    },
  } as unknown as DbConnection
}

function makeEntry(db: DbConnection): Entry {
  return { name: 'c', kind: 'pg', db, title: 'T', user: 'u', limits: LIMITS }
}

function makeCtx(entry: Entry): ToolCtx {
  const registry = {
    get: (name: string) => {
      if (name !== entry.name) throw new Error(`unknown connection: ${name}`)
      return entry
    },
    list: () => [entry],
    secrets: [],
  } as unknown as ConnectionRegistry
  return { registry, log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } }
}

let lastSampleOpts: { schema: string | null; table: string; columns: string[]; limit: number } | undefined

function makeCatalog(columnNames: string[] = ['ID', 'NAME']): unknown {
  return {
    listTables: async () => [{ schema: 'public', name: 'T', comment: null }],
    listViews: async () => [],
    describeTable: async () => ({
      schema: 'public',
      name: 'T',
      objectType: 'table',
      comment: null,
      columns: columnNames.map((name, i) => ({
        position: i + 1,
        name,
        dataType: 'int',
        typeCategory: 'integer',
        length: null,
        precision: null,
        scale: null,
        nullable: false,
        defaultValue: null,
        isPrimaryKey: i === 0,
        comment: null,
      })),
      primaryKey: columnNames.slice(0, 1),
    }),
    buildSampleSql: (o: { schema: string | null; table: string; columns: string[]; limit: number }) => {
      lastSampleOpts = o
      const cols = o.columns.length > 0 ? o.columns.join(', ') : '*'
      return `SELECT ${cols} FROM ${o.table} LIMIT ${o.limit}`
    },
  }
}

const signal = new AbortController().signal

describe('sample_rows', () => {
  beforeEach(() => {
    lastSampleOpts = undefined
    holders.catalog = makeCatalog()
  })

  it('columns валидируются регистронезависимо; в SQL уходит каталожное имя', async () => {
    const entry = makeEntry(makeDb(1))
    const res = await sampleRowsTool.handler(
      { connection: 'c', table: 'T', columns: ['id'], limit: 10 },
      makeCtx(entry),
      signal,
    )
    expect(lastSampleOpts?.columns).toEqual(['ID'])
    expect(res.rows).toHaveLength(1)
  })

  it('несуществующий столбец → invalid_argument с именем столбца', async () => {
    const entry = makeEntry(makeDb(1))
    let caught: unknown
    try {
      await sampleRowsTool.handler(
        { connection: 'c', table: 'T', columns: ['nope'], limit: 10 },
        makeCtx(entry),
        signal,
      )
    } catch (e) {
      caught = e
    }
    expect((caught as { kind?: string }).kind).toBe('invalid_argument')
    expect((caught as Error).message).toContain('nope')
  })

  it('truncated: запрос cap+1 строки, ответ обрезан до cap', async () => {
    const entry = makeEntry(makeDb(3))
    const res = await sampleRowsTool.handler(
      { connection: 'c', table: 'T', limit: 2 },
      makeCtx(entry),
      signal,
    )
    expect(lastSampleOpts?.limit).toBe(3)
    expect(res.truncated).toBe(true)
    expect(res.rowCount).toBe(2)
    expect(res.rows).toHaveLength(2)
  })

  it('truncated=false, если строк не больше cap', async () => {
    const entry = makeEntry(makeDb(2))
    const res = await sampleRowsTool.handler(
      { connection: 'c', table: 'T', limit: 5 },
      makeCtx(entry),
      signal,
    )
    expect(res.truncated).toBe(false)
    expect(res.rowCount).toBe(2)
  })
})
