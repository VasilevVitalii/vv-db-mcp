import type { DbConnection, TDbError, TDbParam, TDbRes } from 'vv-db-connection'
import type { ResolvedLimits } from '../config/schema.js'
import type { Column, Param, ResultSet } from '../tools/schemas.js'
import { throwDbError, ServerError } from '../errors/map.js'
import { toDbParams } from './params.js'
import { SerializeState, serializeRow } from './serialize.js'
import { linkSignals } from './abort.js'
import { firstStatementIsWrite, tailHasWrite } from './classify.js'

export interface RunSqlOpts {
  connection?: string
  signal?: AbortSignal
  timeoutMs: number
  maxRows: number
  limits: ResolvedLimits
}

export interface SqlResult {
  resultSets: ResultSet[]
  outParams?: Record<string, unknown>
  warnings?: string[]
  elapsedMs: number
}

export interface RunTxOpts {
  connection?: string
  signal?: AbortSignal
  timeoutMs: number
  maxRows: number
  limits: ResolvedLimits
}

export interface TxStatement {
  sql: string
  params: Param[]
}

export interface TxStatementResult {
  index: number
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  rowsAffected?: number
  outParams?: Record<string, unknown>
  implicitResults?: ResultSet[]
}

export interface TxResult {
  committed: true
  statements: TxStatementResult[]
  warnings?: string[]
  elapsedMs: number
}

function toColumn(c: { name: string; kind: string; len?: number; scale?: number; precision?: number }): Column {
  const col: Column = { name: c.name, type: c.kind }
  if (c.len !== undefined) col.length = c.len
  if (c.precision !== undefined) col.precision = c.precision
  if (c.scale !== undefined) col.scale = c.scale
  return col
}

function serializeOpts(limits: ResolvedLimits) {
  return { maxCellChars: limits.maxCellChars, maxBinaryBytes: limits.maxBinaryBytes }
}

/** Признаки потери соединения по драйверному коду (раздел 7.3 ТЗ). */
function isTxConnectionLost(code?: string): boolean {
  if (!code) return false
  if (code === 'COMMIT_TIMEOUT' || code === 'FB_CONN_LOST') return true
  if (/^08/.test(code)) return true // pg SQLSTATE class 08 — connection exception
  if (/^57P0[123]$/.test(code)) return true // pg admin_shutdown / crash_shutdown / cannot_connect_now
  if (/^NJS-/.test(code)) return true // oracledb network errors
  if (/^ORA-0311[345]$/.test(code) || code === 'ORA-12170') return true // oracle end-of-file / network timeout
  // tedious сетевые коды (потеря связи), без ELOGIN/EREQUEST (auth/протокол — не обрыв)
  if (/^E(SOCKET|CONNRESET|CONNREFUSED|TIMEOUT|CONNABORTED|NETUNREACH|HOSTUNREACH|NOTFOUND|CONNCLOSED)$/.test(code)) return true
  return false
}

/** outcomeUnknown для транзакции: COMMIT-таймер, aborted, потеря связи при commit. */
function computeTxOutcome(err: TDbError): boolean {
  if (err.code === 'COMMIT_TIMEOUT') return true
  if (err.kind === 'aborted') return true
  if (err.kind === 'tx' && isTxConnectionLost(err.code)) return true
  return false
}

export async function runSql(
  db: DbConnection,
  sql: string,
  params: Param[],
  opts: RunSqlOpts,
): Promise<SqlResult> {
  const start = Date.now()
  const dbParams = toDbParams(params)
  const controller = new AbortController()
  const unlink = opts.signal ? linkSignals(opts.signal, controller) : undefined
  const st = new SerializeState()
  const warnings: string[] = []

  const sets: ResultSet[] = []
  let cur: ResultSet | null = null
  let outParams: Record<string, unknown> | undefined
  let finishError: TDbError | undefined
  let abortedByMaxRows = false

  const newSet = (): ResultSet => ({ columns: [], rows: [], rowCount: 0, truncated: false })

  try {
    await db.execStream(
      sql,
      dbParams,
      (ev) => {
        switch (ev.kind) {
          case 'schema':
            cur = { columns: ev.schema.map(toColumn), rows: [], rowCount: 0, truncated: false }
            sets.push(cur)
            break
          case 'row':
            if (!cur) {
              cur = newSet()
              sets.push(cur)
            }
            if (cur.rows.length < opts.maxRows) {
              cur.rows.push(serializeRow(ev.row, serializeOpts(opts.limits), st))
            } else {
              cur.truncated = true
              abortedByMaxRows = true
              controller.abort()
            }
            break
          case 'rowsAffected':
            if (!cur) {
              cur = newSet()
              sets.push(cur)
            }
            cur.rowsAffected = ev.count
            break
          case 'outParams':
            outParams = serializeRow(ev.params, serializeOpts(opts.limits), st)
            break
          case 'finish':
            if (ev.error) finishError = ev.error
            break
        }
      },
      { signal: controller.signal, firstDataTimeoutMs: opts.timeoutMs, idleTimeoutMs: opts.timeoutMs },
    )
  } finally {
    unlink?.()
  }

  for (const s of sets) s.rowCount = s.rows.length

  if (st.truncatedCells > 0) {
    warnings.push(`${st.truncatedCells} ячеек обрезано до ${opts.limits.maxCellChars} символов`)
  }
  if (st.truncatedBinary > 0) {
    warnings.push(`${st.truncatedBinary} бинарных значений обрезано до ${opts.limits.maxBinaryBytes} байт`)
  }

  if (finishError) {
    // maxRows-обрыв с writes-хвостом — результат неоднозначен (раздел 7.3).
    // Проверка !opts.signal?.aborted отличает наш abort (maxRows) от отмены
    // клиентом: клиентская отмена должна уйти как ошибка, а не как «успех».
    if (abortedByMaxRows && finishError.kind === 'aborted' && !opts.signal?.aborted) {
      if (tailHasWrite(sql)) {
        throwDbError(
          {
            kind: 'aborted',
            code: finishError.code,
            message: 'результат обрезан по maxRows; последующие операторы DML/DDL могли не выполниться',
          },
          { connection: opts.connection, outcomeUnknown: true },
        )
      }
    } else {
      const outcomeUnknown =
        (finishError.kind === 'timeout' || finishError.kind === 'aborted') &&
        (firstStatementIsWrite(sql) || tailHasWrite(sql))
      throwDbError(finishError, { connection: opts.connection, outcomeUnknown: outcomeUnknown || undefined })
    }
  }

  if (abortedByMaxRows) {
    warnings.push('результат обрезан по maxRows; последующие операторы батча могли не выполниться')
  }

  return {
    resultSets: sets,
    outParams,
    warnings: warnings.length > 0 ? warnings : undefined,
    elapsedMs: Date.now() - start,
  }
}

function toResultSet(res: TDbRes, limits: ResolvedLimits, st: SerializeState): ResultSet {
  const set: ResultSet = {
    columns: res.schema.map(toColumn),
    rows: res.rows.map((r) => serializeRow(r, serializeOpts(limits), st)),
    rowCount: 0,
    truncated: false,
  }
  set.rowCount = set.rows.length
  if (res.rowsAffected !== undefined) set.rowsAffected = res.rowsAffected
  return set
}

export async function runTx(
  db: DbConnection,
  statements: TxStatement[],
  opts: RunTxOpts,
): Promise<TxResult> {
  const start = Date.now()
  const st = new SerializeState()
  const warnings: string[] = []
  let currentIndex = -1

  // Параметры преобразуем до открытия транзакции: ошибка валидации (дата, base64,
  // bigint) должна вернуться как invalid_argument со своим statementIndex, а не
  // всплыть внутри колбэка драйвера, где она переупаковывается в 'tx' и теряет
  // признак неверного аргумента (BEGIN при этом открывается и откатывается впустую).
  const prepared: Array<{ sql: string; params: TDbParam[] }> = []
  for (let i = 0; i < statements.length; i++) {
    try {
      prepared.push({ sql: statements[i].sql, params: toDbParams(statements[i].params) })
    } catch (e) {
      if (e instanceof ServerError && e.kind === 'invalid_argument') {
        throw new ServerError(e.kind, e.message, { statementIndex: i })
      }
      throw e
    }
  }

  const result = await db.execTxDynamic(
    async (exec, _signal) => {
      const out: TxStatementResult[] = []
      for (let i = 0; i < prepared.length; i++) {
        currentIndex = i
        const stmt = prepared[i]
        // При отмене (timeout/клиент) exec() сам бросает структурированный
        // abortError (kind 'aborted'/'timeout'), который computeTxOutcome верно
        // классифицирует как неоднозначный исход; бросать здесь bare Error нельзя —
        // драйвер пометил бы его kind 'tx' и отмена потеряла бы признак.
        const r = await exec(stmt.sql, stmt.params)
        const rows = r.rows.slice(0, opts.maxRows).map((row) => serializeRow(row, serializeOpts(opts.limits), st))
        const item: TxStatementResult = {
          index: i,
          rows,
          rowCount: rows.length,
          truncated: r.rows.length > opts.maxRows,
        }
        if (r.rowsAffected !== undefined) item.rowsAffected = r.rowsAffected
        if (r.outParams !== undefined) item.outParams = serializeRow(r.outParams, serializeOpts(opts.limits), st)
        if (r.implicitResults && r.implicitResults.length > 0) {
          item.implicitResults = r.implicitResults.map((res) => toResultSet(res, opts.limits, st))
        }
        out.push(item)
      }
      return { committed: true as const, statements: out }
    },
    { timeoutMs: opts.timeoutMs, signal: opts.signal },
  )

  if (!result.ok) {
    const err = result.error
    const statementIndex = err.kind === 'query' || err.kind === 'user' ? currentIndex : undefined
    throwDbError(err, {
      connection: opts.connection,
      statementIndex,
      outcomeUnknown: computeTxOutcome(err) || undefined,
    })
  }

  if (st.truncatedCells > 0) {
    warnings.push(`${st.truncatedCells} ячеек обрезано до ${opts.limits.maxCellChars} символов`)
  }
  if (st.truncatedBinary > 0) {
    warnings.push(`${st.truncatedBinary} бинарных значений обрезано до ${opts.limits.maxBinaryBytes} байт`)
  }

  const { committed, statements: resultStatements } = result.result
  return {
    committed,
    statements: resultStatements,
    warnings: warnings.length > 0 ? warnings : undefined,
    elapsedMs: Date.now() - start,
  }
}
