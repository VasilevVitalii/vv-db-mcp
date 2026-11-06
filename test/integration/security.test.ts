import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DbConnection } from 'vv-db-connection'
import { runSql } from '../../src/exec/run.js'
import { ToolFailure, toToolError, formatErrorText } from '../../src/errors/map.js'
import { buildHarness, connectAvailable, hasKind, type Harness } from './helpers.js'

describe.skipIf(!connectAvailable())('интеграционные: безопасность и отказоустойчивость', () => {
  let h: Harness
  const pg = () => h.entries.pg

  beforeAll(async () => {
    h = await buildHarness()
  })

  afterAll(async () => {
    await h.registry.closeAll()
  })

  it.skipIf(!hasKind('pg'))('недоступное подключение даёт ошибку без утечки пароля', async () => {
    const bad = new DbConnection({
      kind: 'pg',
      host: '127.0.0.1',
      port: 1,
      database: 'test',
      user: 'x',
      password: 'secretpw',
    })
    try {
      await expect(runSql(bad, 'SELECT 1', [], { timeoutMs: 5000, maxRows: 10, limits: { timeoutMs: 60000, maxTimeoutMs: 3600000, maxRows: 1000, maxRowsCap: 10000, maxCellChars: 65536, maxBinaryBytes: 4096 } }))
        .rejects.toBeInstanceOf(ToolFailure)
      // живое подключение при этом доступно
      const ok = await runSql(pg()!.db, 'SELECT 1 AS n', [], { timeoutMs: 30000, maxRows: 10, limits: pg()!.limits, connection: 'pg' })
      expect(Number(ok.resultSets[0].rows[0].n)).toBe(1)
    } finally {
      await bad.close()
    }
  }, 15000)

  it.skipIf(!hasKind('pg'))('пароли не попадают в текст ошибки и list_connections', async () => {
    const passwords = h.passwords
    expect(passwords.length).toBeGreaterThan(0)

    // ошибка запроса на живом подключении
    let thrown: unknown
    try {
      await runSql(pg()!.db, 'SELECT * FROM vvdbmcp_definitely_missing', [], {
        timeoutMs: 30000, maxRows: 10, limits: pg()!.limits, connection: 'pg',
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ToolFailure)
    const text = formatErrorText(toToolError(thrown, passwords))
    for (const p of passwords) expect(text).not.toContain(p)

    // list_connections (данные, которые отдаёт инструмент) не содержит паролей
    const view = h.registry.list().map((e) => ({
      name: e.name, kind: e.kind, title: e.title, user: e.user, description: e.description,
    }))
    const json = JSON.stringify(view)
    for (const p of passwords) expect(json).not.toContain(p)
  })

  it.skipIf(!hasKind('pg'))('timeout на pg', async () => {
    await expect(runSql(pg()!.db, 'SELECT pg_sleep(5)', [], {
      timeoutMs: 1000, maxRows: 10, limits: pg()!.limits, connection: 'pg',
    })).rejects.toSatisfy((e: unknown) => (e as ToolFailure).toolError.error.kind === 'timeout')
  })

  it.skipIf(!hasKind('pg'))('aborted на pg', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 200)
    try {
      await expect(runSql(pg()!.db, 'SELECT pg_sleep(5)', [], {
        timeoutMs: 60000, maxRows: 10, limits: pg()!.limits, connection: 'pg', signal: controller.signal,
      })).rejects.toSatisfy((e: unknown) => (e as ToolFailure).toolError.error.kind === 'aborted')
    } finally {
      clearTimeout(timer)
    }
  })
})
