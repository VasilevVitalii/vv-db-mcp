import type { DbConnection, TDbKind, TDbParam } from 'vv-db-connection'
import { throwDbError, ServerError } from '../errors/map.js'
import type { Opts, TypeCategory } from './types.js'

/** Выполняет SELECT каталога и возвращает строки первого набора. */
export async function queryRows(
  db: DbConnection,
  sql: string,
  params: TDbParam[],
  o: Opts,
): Promise<Record<string, unknown>[]> {
  const r = await db.exec(sql, params, {
    signal: o.signal,
    firstDataTimeoutMs: o.timeoutMs,
    idleTimeoutMs: o.timeoutMs,
  })
  if (!r.ok) throwDbError(r.error, {})
  return r.result[0]?.rows ?? []
}

/** Экранирование идентификатора по диалекту (раздел 6.16 ТЗ). */
export function quoteIdentifier(kind: TDbKind, name: string): string {
  if (kind === 'mssql') return `[${name.replace(/]/g, ']]')}]`
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Разрешение имени объекта по каталогу (раздел 4.2 ТЗ):
 * точное совпадение в области schema, затем без учёта регистра;
 * иначе not_found / ambiguous.
 */
export function resolveName(
  candidates: Array<{ schema: string | null; name: string }>,
  requested: string,
  schemaScope?: string,
): { schema: string | null; name: string } {
  const inScope =
    schemaScope === undefined
      ? candidates
      : candidates.filter((c) => (c.schema ?? null)?.toLowerCase() === schemaScope.toLowerCase())

  const exact = inScope.filter((c) => c.name === requested)
  if (exact.length === 1) return { schema: exact[0]!.schema, name: exact[0]!.name }
  if (exact.length > 1) throw ambiguous(requested, exact)

  const ci = inScope.filter((c) => c.name.toLowerCase() === requested.toLowerCase())
  if (ci.length === 1) return { schema: ci[0]!.schema, name: ci[0]!.name }
  if (ci.length > 1) throw ambiguous(requested, ci)

  throw new ServerError(
    'not_found',
    `объект "${requested}" не найден${schemaScope !== undefined ? ` в схеме ${schemaScope}` : ''}`,
  )
}

function ambiguous(
  requested: string,
  hits: Array<{ schema: string | null; name: string }>,
): ServerError {
  const list = hits.map((c) => `${c.schema ?? '(без схемы)'}.${c.name}`).join(', ')
  return new ServerError(
    'ambiguous',
    `имя "${requested}" неоднозначно; кандидаты: ${list}; укажите schema`,
  )
}

export function matchesFilter(name: string, filter?: string): boolean {
  if (filter === undefined) return true
  return name.toLowerCase().includes(filter.toLowerCase())
}

export function sortByName<T extends { schema: string | null; name: string }>(items: T[]): T[] {
  return items.sort((a, b) => {
    const sa = a.schema ?? ''
    const sb = b.schema ?? ''
    if (sa !== sb) return sa < sb ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

export function applyLimit<T>(items: T[], limit: number): { items: T[]; truncated: boolean } {
  if (items.length > limit) return { items: items.slice(0, limit), truncated: true }
  return { items, truncated: false }
}

/** Обрезка родного имени типа до нижнего регистра без длины (раздел 6.8 ТЗ). */
export function baseTypeName(raw: string): string {
  return raw.trim().toLowerCase()
}

/** Единая классификация типов (приложение B ТЗ). */
export function typeCategory(kind: TDbKind, dataType: string, scale?: number | null): TypeCategory {
  const t = dataType.trim().toLowerCase()

  switch (kind) {
    case 'mssql':
      return mssqlCategory(t)
    case 'pg':
      return pgCategory(t)
    case 'ora':
      return oraCategory(t, scale)
    case 'fb':
      return fbCategory(t)
  }
}

function mssqlCategory(t: string): TypeCategory {
  if (['tinyint', 'smallint', 'int', 'bigint'].includes(t)) return 'integer'
  if (['decimal', 'numeric', 'money', 'smallmoney'].includes(t)) return 'decimal'
  if (['float', 'real'].includes(t)) return 'float'
  if (['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext', 'xml'].includes(t)) return 'string'
  if (['binary', 'varbinary', 'image'].includes(t)) return 'binary'
  if (t === 'bit') return 'boolean'
  if (t === 'date') return 'date'
  if (t === 'time') return 'time'
  if (['datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'].includes(t)) return 'timestamp'
  return 'other'
}

function pgCategory(t: string): TypeCategory {
  const base = t.replace(/\[\]$/, '').replace(/\(\d+(,\d+)?\)/, '')
  if (['smallint', 'integer', 'bigint'].includes(base)) return 'integer'
  if (['numeric', 'money'].includes(base)) return 'decimal'
  if (['real', 'double precision'].includes(base)) return 'float'
  if (['char', 'character', 'character varying', 'varchar', 'text'].includes(base)) return 'string'
  if (base === 'bytea') return 'binary'
  if (base === 'boolean') return 'boolean'
  if (base === 'date') return 'date'
  if (base === 'time' || base === 'time without time zone' || base === 'time with time zone') return 'time'
  if (base === 'timestamp' || base === 'timestamp without time zone' || base === 'timestamp with time zone')
    return 'timestamp'
  return 'other'
}

function oraCategory(t: string, scale?: number | null): TypeCategory {
  if (t === 'number') return scale == null ? 'decimal' : scale <= 0 ? 'integer' : 'decimal'
  if (['float', 'binary_float', 'binary_double'].includes(t)) return 'float'
  if (['char', 'varchar2', 'nchar', 'nvarchar2', 'clob', 'long'].includes(t)) return 'string'
  if (['raw', 'blob', 'bfile'].includes(t)) return 'binary'
  if (t === 'boolean') return 'boolean'
  // Oracle DATE содержит время (приложение B)
  if (t === 'date' || t.startsWith('timestamp') || t.startsWith('interval')) return 'timestamp'
  return 'other'
}

function fbCategory(t: string): TypeCategory {
  if (['smallint', 'integer', 'bigint', 'int128'].includes(t)) return 'integer'
  if (['numeric', 'decimal'].includes(t)) return 'decimal'
  if (['float', 'double precision', 'decfloat16', 'decfloat34'].includes(t)) return 'float'
  if (['char', 'varchar', 'blob sub_type text'].includes(t)) return 'string'
  if (t === 'blob sub_type binary') return 'binary'
  if (t === 'boolean') return 'boolean'
  if (t === 'date') return 'date'
  if (['time', 'time with time zone'].includes(t)) return 'time'
  if (['timestamp', 'timestamp with time zone'].includes(t)) return 'timestamp'
  return 'other'
}
