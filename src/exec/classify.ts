/**
 * Эвристики для outcomeUnknown: является ли оператор чисто читающим
 * и есть ли в хвосте батча операторы записи. Без гарантии при
 * комментариях/литералах — при неуверенности склоняемся к "пишет".
 */

const READONLY = new Set([
  'SELECT',
  'WITH',
  'VALUES',
  'SHOW',
  'EXPLAIN',
  'DESCRIBE',
  'DESC',
  'PRAGMA',
  'ANALYZE',
  'ANALYSE',
])

function stripLeading(sql: string): string {
  let s = sql
  for (;;) {
    const t = s.trimStart()
    if (t.startsWith('--')) {
      const nl = t.indexOf('\n')
      s = nl === -1 ? '' : t.slice(nl + 1)
      continue
    }
    if (t.startsWith('/*')) {
      const end = t.indexOf('*/')
      s = end === -1 ? '' : t.slice(end + 2)
      continue
    }
    return t
  }
}

export function isReadOnlyStatement(sql: string): boolean {
  const s = stripLeading(sql)
  const m = /^[A-Za-z]+/.exec(s)
  if (!m) return true // пусто / только комментарии — не пишет
  const kw = m[0].toUpperCase()
  if (kw === 'SELECT') {
    // `SELECT … INTO` пишет (создаёт/заполняет таблицу). Ложное «пишет» при
    // литерале 'INTO' безопасно: эвристика склоняется к пишущему исходу.
    return !/\bINTO\b/i.test(s)
  }
  if (kw === 'WITH') {
    // Data-modifying CTE (INSERT/UPDATE/DELETE/MERGE после WITH-клаузы) пишет.
    return !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(s)
  }
  if (kw === 'EXPLAIN') {
    // `EXPLAIN ANALYZE <DML>` в PostgreSQL реально выполняет оператор записи.
    const analyze = /\bANALY[ZS]E\b/i.test(s)
    const dml = /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(s)
    return !(analyze && dml)
  }
  return READONLY.has(kw)
}

/** Разбиение батча по `;` вне строковых литералов и комментариев (приближённо).
 *  Не понимает dollar-quoting PG (`$$…;$$`), `q'…'` Oracle и `[…]` MSSQL: `;`
 *  внутри них разобьёт батч раньше времени. Ошибка направлена в безопасную
 *  сторону — лишний «пишет»/`outcomeUnknown`, но не пропуск DML. */
export function splitStatements(sql: string): string[] {
  const parts: string[] = []
  let cur = ''
  let i = 0
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inLine = false
  let inBlock = false

  while (i < sql.length) {
    const c = sql[i]
    const n = sql[i + 1]

    if (inLine) {
      cur += c
      if (c === '\n') inLine = false
      i++
      continue
    }
    if (inBlock) {
      cur += c
      if (c === '*' && n === '/') {
        cur += '/'
        inBlock = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (inSingle) {
      cur += c
      if (c === "'" && n === "'") {
        cur += "'"
        i += 2
        continue
      }
      if (c === "'") inSingle = false
      i++
      continue
    }
    if (inDouble) {
      cur += c
      if (c === '"') inDouble = false
      i++
      continue
    }
    if (inBacktick) {
      cur += c
      if (c === '`') inBacktick = false
      i++
      continue
    }
    if (c === '-' && n === '-') {
      inLine = true
      cur += '--'
      i += 2
      continue
    }
    if (c === '/' && n === '*') {
      inBlock = true
      cur += '/*'
      i += 2
      continue
    }
    if (c === "'") {
      inSingle = true
      cur += c
      i++
      continue
    }
    if (c === '"') {
      inDouble = true
      cur += c
      i++
      continue
    }
    if (c === '`') {
      inBacktick = true
      cur += c
      i++
      continue
    }
    if (c === ';') {
      parts.push(cur)
      cur = ''
      i++
      continue
    }
    cur += c
    i++
  }

  if (cur.trim().length > 0) parts.push(cur)
  return parts
}

/** Первый оператор батча потенциально пишет (не чистое чтение). */
export function firstStatementIsWrite(sql: string): boolean {
  return !isReadOnlyStatement(sql)
}

/** Есть ли после первого оператора хотя бы один потенциально пишущий. */
export function tailHasWrite(sql: string): boolean {
  const stmts = splitStatements(sql)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (stmts.length <= 1) return false
  return stmts.slice(1).some((s) => !isReadOnlyStatement(s))
}
