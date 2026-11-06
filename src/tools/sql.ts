import { z } from 'zod'
import { defineTool, getEntry, clampTimeout, clampMaxRows, WRITE_ANNOTATIONS } from './define.js'
import { connSchema, paramSchema, resultSetSchema, warningsSchema } from './schemas.js'
import { runSql, runTx } from '../exec/run.js'

const timeoutMsSchema = z.number().int().min(1).optional()
const maxRowsSchema = z.number().int().min(1).optional()

/** 6.4 `execute_sql` — произвольный SQL (чтение, DML, DDL, вызов процедур). */
export const executeSqlTool = defineTool({
  name: 'execute_sql',
  title: 'execute_sql',
  description:
    'Выполняет произвольный SQL (чтение, DML, DDL, вызов процедур) на подключении. Параметры — :name (раздел 5). ' +
    'Результат: массив наборов resultSets; SELECT даёт columns + rows; DML — набор с пустыми columns и rowsAffected; DDL — пустой набор. ' +
    'Вендорные оговорки: несколько операторов в одном sql — MSSQL даёт по набору на оператор (автокоммит каждого), PostgreSQL — только без params ' +
    '(одна неявная транзакция, сбой откатывает всё сообщение), Oracle и Firebird — один оператор (PL/SQL-блок / EXECUTE BLOCK); DDL в Oracle неявно коммитит. ' +
    'Для гарантированной атомарности используй execute_transaction.',
  input: z.strictObject({
    connection: connSchema,
    sql: z.string().min(1),
    params: z.array(paramSchema).max(1000).optional(),
    timeoutMs: timeoutMsSchema,
    maxRows: maxRowsSchema,
  }),
  output: z.object({
    ok: z.literal(true),
    resultSets: z.array(resultSetSchema),
    outParams: z.record(z.string(), z.unknown()).optional(),
    warnings: warningsSchema.optional(),
    elapsedMs: z.number().int(),
  }),
  annotations: WRITE_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    const t = clampTimeout(args.timeoutMs ?? entry.limits.timeoutMs, entry.limits)
    const mr = clampMaxRows(args.maxRows ?? entry.limits.maxRows, entry.limits)
    const res = await runSql(entry.db, args.sql, args.params ?? [], {
      connection: entry.name,
      signal,
      timeoutMs: t,
      maxRows: mr,
      limits: entry.limits,
    })
    return {
      ok: true as const,
      resultSets: res.resultSets,
      ...(res.outParams !== undefined ? { outParams: res.outParams } : {}),
      ...(res.warnings !== undefined ? { warnings: res.warnings } : {}),
      elapsedMs: res.elapsedMs,
    }
  },
})

/** 6.5 `execute_transaction` — последовательность операторов в одной транзакции. */
export const executeTransactionTool = defineTool({
  name: 'execute_transaction',
  title: 'execute_transaction',
  description:
    'Выполняет последовательность операторов в одной транзакции (BEGIN → операторы → COMMIT, при ошибке — ROLLBACK). ' +
    'Атомарность «всё или ничего» гарантируется для DML без явного управления транзакцией в тексте SQL. ' +
    'DDL в Oracle неявно коммитит (включая ранее несохранённые изменения); Firebird работает в READ COMMITTED; SET NOCOUNT ON в MSSQL скрывает rowsAffected.',
  input: z.strictObject({
    connection: connSchema,
    statements: z
      .array(
        z.strictObject({
          sql: z.string().min(1),
          params: z.array(paramSchema).max(1000).optional(),
        }),
      )
      .min(1)
      .max(200),
    timeoutMs: timeoutMsSchema,
    maxRows: maxRowsSchema,
  }),
  output: z.object({
    ok: z.literal(true),
    committed: z.literal(true),
    statements: z.array(
      z.object({
        index: z.number().int(),
        rows: z.array(z.record(z.string(), z.unknown())),
        rowCount: z.number().int(),
        truncated: z.boolean(),
        rowsAffected: z.number().int().optional(),
        outParams: z.record(z.string(), z.unknown()).optional(),
        implicitResults: z.array(resultSetSchema).optional(),
      }),
    ),
    warnings: warningsSchema.optional(),
    elapsedMs: z.number().int(),
  }),
  annotations: WRITE_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    const t = clampTimeout(args.timeoutMs ?? entry.limits.timeoutMs, entry.limits)
    const mr = clampMaxRows(args.maxRows ?? entry.limits.maxRows, entry.limits)
    const res = await runTx(
      entry.db,
      args.statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })),
      { connection: entry.name, signal, timeoutMs: t, maxRows: mr, limits: entry.limits },
    )
    return {
      ok: true as const,
      committed: res.committed,
      statements: res.statements,
      ...(res.warnings !== undefined ? { warnings: res.warnings } : {}),
      elapsedMs: res.elapsedMs,
    }
  },
})
