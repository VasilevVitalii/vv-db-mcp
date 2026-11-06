import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { runSql, runTx } from '../../src/exec/run.js'
import type { ToolFailure } from '../../src/errors/map.js'
import {
  buildHarness,
  connectAvailable,
  createFixture,
  dropFixture,
  hasKind,
  KINDS,
  PARENT,
  CHILD,
  cell,
  type Harness,
} from './helpers.js'

describe.skipIf(!connectAvailable())('интеграционные: execute_sql / execute_transaction', () => {
  let h: Harness

  beforeAll(async () => {
    h = await buildHarness()
    for (const kind of KINDS) {
      const e = h.entries[kind]
      if (e) await createFixture(e)
    }
  })

  afterAll(async () => {
    for (const kind of KINDS) {
      const e = h.entries[kind]
      if (e) await dropFixture(e)
    }
    await h.registry.closeAll()
  })

  for (const kind of KINDS) {
    const entry = () => h.entries[kind]
    const db = () => entry()!.db
    const opts = () => ({ timeoutMs: 30000, maxRows: 100, limits: entry()!.limits, connection: kind })

    describe.skipIf(!hasKind(kind))(kind, () => {
      it('DML с rowsAffected', async () => {
        const r = await runSql(db(), `INSERT INTO ${PARENT}(id, name) VALUES (:id, :name)`, [
          { name: 'id', value: 1 },
          { name: 'name', value: 'alpha' },
        ], opts())
        expect(r.resultSets.length).toBeGreaterThanOrEqual(1)
        const affected = r.resultSets[0].rowsAffected
        expect(affected ?? 1).toBeGreaterThanOrEqual(1)
      })

      it('чтение с параметрами', async () => {
        const r = await runSql(db(), `SELECT id, name FROM ${PARENT} WHERE id = :id`, [
          { name: 'id', value: 1 },
        ], opts())
        expect(r.resultSets).toHaveLength(1)
        expect(r.resultSets[0].rows).toHaveLength(1)
        const row = r.resultSets[0].rows[0]
        // id может прийти числом или строкой (bigint); сравним по приведению
        expect(String(cell(row, 'id'))).toBe('1')
        expect(cell(row, 'name')).toBe('alpha')
      })

      it('DDL: создание и удаление таблицы', async () => {
        const t = `vvdbmcp_tmp_${kind}`
        await runSql(db(), `CREATE TABLE ${t} (x ${kind === 'ora' ? 'NUMBER(10)' : 'integer'})`, [], opts())
        // таблица видна в списке таблиц
        const seen = await h.catalogs[kind].listTables(db(), { ...opts() })
        expect(seen.some((x) => x.name.toLowerCase() === t)).toBe(true)
        await runSql(db(), `DROP TABLE ${t}`, [], opts())
      })

      it('транзакция: commit', async () => {
        const r = await runTx(db(), [
          { sql: `INSERT INTO ${PARENT}(id, name) VALUES (:id, :name)`, params: [{ name: 'id', value: 10 }, { name: 'name', value: 'tx-a' }] },
          { sql: `INSERT INTO ${PARENT}(id, name) VALUES (:id, :name)`, params: [{ name: 'id', value: 11 }, { name: 'name', value: 'tx-b' }] },
        ], opts())
        expect(r.committed).toBe(true)
        expect(r.statements).toHaveLength(2)
        const chk = await runSql(db(), `SELECT count(*) AS n FROM ${PARENT} WHERE id IN (10, 11)`, [], opts())
        expect(Number(cell(chk.resultSets[0].rows[0], 'n'))).toBe(2)
      })

      it('транзакция: откат и statementIndex', async () => {
        await expect(runTx(db(), [
          { sql: `INSERT INTO ${PARENT}(id, name) VALUES (:id, :name)`, params: [{ name: 'id', value: 20 }, { name: 'name', value: 'tx-c' }] },
          { sql: `INSERT INTO ${PARENT}(id, name) VALUES (30, NULL)`, params: [] }, // name NOT NULL → ошибка
        ], opts())).rejects.toSatisfy((e: unknown) => {
          const f = e as ToolFailure
          return f.toolError !== undefined && f.toolError.error.statementIndex === 1
        })
        // откат: строка 20 не должна была сохраниться
        const chk = await runSql(db(), `SELECT count(*) AS n FROM ${PARENT} WHERE id = 20`, [], opts())
        expect(Number(cell(chk.resultSets[0].rows[0], 'n'))).toBe(0)
      })

      it('CHECK-ограничение применяется на живой базе', async () => {
        await expect(runSql(db(), `INSERT INTO ${CHILD}(id, parent_id, code) VALUES (1, 1, -5)`, [], opts()))
          .rejects.toBeTruthy()
      })
    })
  }
})
