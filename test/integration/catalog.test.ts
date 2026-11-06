import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { runSql } from '../../src/exec/run.js'
import {
  buildHarness,
  connectAvailable,
  createFixture,
  dropFixture,
  hasName,
  KINDS,
  PARENT,
  CHILD,
  VIEW,
  SEQ,
  TRG,
  PROC,
  FUNC,
  IDX,
  DESC_IDX,
  MV,
  DEFAULT_SCHEMA,
  type Harness,
} from './helpers.js'

describe.skipIf(!connectAvailable())('интеграционные: каталог метаданных', () => {
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
    const cat = () => h.catalogs[kind]
    const schema = () => DEFAULT_SCHEMA[kind]
    const opts = () => ({ timeoutMs: 30000, connection: kind })

    describe(kind, () => {
      it('list_schemas', async () => {
        const schemas = await cat().listSchemas(db(), opts())
        if (kind === 'fb') {
          expect(schemas).toEqual([])
        } else {
          expect(schemas.length).toBeGreaterThan(0)
          if (kind === 'pg' || kind === 'mssql') {
            expect(schemas.map((s) => s.toLowerCase())).toContain(schema()!.toLowerCase())
          }
        }
      })

      it('list_tables находит фикстуру', async () => {
        const tables = await cat().listTables(db(), { ...opts(), schema: schema() ?? undefined })
        expect(hasName(tables, PARENT)).toBe(true)
        expect(hasName(tables, CHILD)).toBe(true)
      })

      it('list_views находит представление', async () => {
        const views = await cat().listViews(db(), { ...opts(), schema: schema() ?? undefined })
        expect(hasName(views, VIEW)).toBe(true)
      })

      it('describe_table: колонки и первичный ключ', async () => {
        const d = await cat().describeTable(db(), { ...opts(), schema: schema(), table: PARENT })
        expect(d.primaryKey.some((c) => c.toLowerCase() === 'id')).toBe(true)
        const nameCol = d.columns.find((c) => c.name.toLowerCase() === 'name')
        expect(nameCol).toBeDefined()
        expect(nameCol!.nullable).toBe(false)
        const idCol = d.columns.find((c) => c.name.toLowerCase() === 'id')
        expect(idCol!.isPrimaryKey).toBe(true)
      })

      if (kind === 'pg') {
        it('describe_table: materialized view имеет колонки', async () => {
          const d = await cat().describeTable(db(), { ...opts(), schema: schema(), table: MV })
          expect(d.objectType).toBe('view')
          expect(d.columns.length).toBeGreaterThan(0)
        })
      }

      it('list_foreign_keys: child → parent', async () => {
        const fks = await cat().listForeignKeys(db(), { ...opts(), table: CHILD, schema: schema() ?? undefined })
        const fk = fks.find(
          (f) => f.referencedTable.toLowerCase() === PARENT.toLowerCase() &&
                 f.columns.some((c) => c.toLowerCase() === 'parent_id'),
        )
        expect(fk, 'FK child.parent_id → parent.id').toBeDefined()
      })

      it('list_indexes: ПК и составной индекс', async () => {
        const idx = await cat().listIndexes(db(), { ...opts(), schema: schema(), table: CHILD })
        expect(idx.some((i) => i.primary)).toBe(true)
        const composite = idx.find((i) => i.name.toLowerCase() === IDX.toLowerCase())
        expect(composite).toBeDefined()
        expect(composite!.columns.length).toBeGreaterThanOrEqual(2)
        if (kind === 'pg') {
          const desc = idx.find((i) => i.name.toLowerCase() === DESC_IDX.toLowerCase())
          expect(desc).toBeDefined()
          expect(desc!.columns.some((c) => c.descending)).toBe(true)
        }
      })

      it('list_constraints: PK, UNIQUE, CHECK', async () => {
        const pc = await cat().listConstraints(db(), { ...opts(), schema: schema(), table: PARENT })
        const pt = pc.map((c) => c.type)
        expect(pt).toContain('primary_key')
        expect(pt).toContain('unique')

        const cc = await cat().listConstraints(db(), { ...opts(), schema: schema(), table: CHILD })
        expect(cc.map((c) => c.type)).toContain('check')
      })

      it('list_sequences находит последовательность', async () => {
        const seqs = await cat().listSequences(db(), { ...opts(), schema: schema() ?? undefined })
        expect(hasName(seqs, SEQ)).toBe(true)
      })

      it('list_routines: процедура и функция', async () => {
        const routines = await cat().listRoutines(db(), { ...opts(), schema: schema() ?? undefined })
        const proc = routines.find((r) => r.name.toLowerCase() === PROC.toLowerCase())
        const func = routines.find((r) => r.name.toLowerCase() === FUNC.toLowerCase())
        expect(proc).toBeDefined()
        expect(func).toBeDefined()
        expect(proc!.kind).toBe('procedure')
        expect(func!.kind).toBe('function')
      })

      it('list_triggers находит триггер', async () => {
        const trigs = await cat().listTriggers(db(), { ...opts(), table: CHILD, schema: schema() ?? undefined })
        const t = trigs.find((x) => x.name.toLowerCase() === TRG.toLowerCase())
        expect(t).toBeDefined()
        expect(t!.table.toLowerCase()).toBe(CHILD.toLowerCase())
      })

      it('get_definition возвращает определение представления', async () => {
        const defs = await cat().getDefinitions(db(), { ...opts(), schema: schema() ?? undefined, name: VIEW, objectType: 'view' })
        expect(defs.length).toBeGreaterThan(0)
        const d = defs.find((x) => x.name.toLowerCase() === VIEW.toLowerCase())
        expect(d).toBeDefined()
        expect(d?.definition?.length).toBeGreaterThan(0)
      })

      it('get_definition не падает для процедуры/функции/триггера', async () => {
        for (const t of ['procedure', 'function', 'trigger'] as const) {
          const name = t === 'procedure' ? PROC : t === 'function' ? FUNC : TRG
          const defs = await cat().getDefinitions(db(), { ...opts(), schema: schema() ?? undefined, name, objectType: t, table: t === 'trigger' ? CHILD : undefined })
          expect(Array.isArray(defs)).toBe(true)
        }
      })

      it('buildSampleSql даёт выполнимый SELECT', async () => {
        await runSql(entry()!.db, `INSERT INTO ${PARENT}(id, name) VALUES (900, 'sample')`, [], {
          timeoutMs: 30000, maxRows: 100, limits: entry()!.limits, connection: kind,
        })
        // ora/fb хранят некавыченные имена в UPPERCASE; quoted-идентификаторы чувствительны к регистру
        const upper = kind === 'ora' || kind === 'fb'
        const tableName = upper ? PARENT.toUpperCase() : PARENT
        const sql = cat().buildSampleSql({
          schema: schema(),
          table: tableName,
          columns: upper ? ['ID', 'NAME'] : ['id', 'name'],
          limit: 5,
        })
        expect(sql.length).toBeGreaterThan(0)
        const r = await runSql(entry()!.db, sql, [], {
          timeoutMs: 30000, maxRows: 100, limits: entry()!.limits, connection: kind,
        })
        expect(r.resultSets[0].rows.length).toBeGreaterThan(0)
      })
    })
  }
})
