import type { TDbError } from 'vv-db-connection'
import type { Masker } from '../log.js'

/** kind из пакета + собственные ошибки сервера (раздел 7.2 ТЗ). */
export type ToolErrorKind =
  | 'connect'
  | 'query'
  | 'tx'
  | 'user'
  | 'timeout'
  | 'aborted'
  | 'unknown_connection'
  | 'invalid_argument'
  | 'not_found'
  | 'ambiguous'
  | 'internal'

/** Контракт ошибки инструмента (раздел 4.3 ТЗ). */
export interface ToolError {
  ok: false
  error: {
    kind: ToolErrorKind
    code?: string
    message: string
    connection?: string
    statementIndex?: number
    outcomeUnknown?: boolean
  }
}

/** Ошибка, которую обработчик бросает явно (не сбой СУБД). */
export class ServerError extends Error {
  readonly kind: ToolErrorKind
  readonly connection?: string
  readonly statementIndex?: number
  readonly outcomeUnknown?: boolean

  constructor(
    kind: ToolErrorKind,
    message: string,
    opts: { connection?: string; statementIndex?: number; outcomeUnknown?: boolean } = {},
  ) {
    super(message)
    this.name = 'ServerError'
    this.kind = kind
    this.connection = opts.connection
    this.statementIndex = opts.statementIndex
    this.outcomeUnknown = opts.outcomeUnknown
  }
}

export function isServerError(e: unknown): e is ServerError {
  return e instanceof ServerError
}

/** Обёртка готового ToolError, чтобы пробросить его через throw. */
export class ToolFailure extends Error {
  readonly toolError: ToolError
  constructor(toolError: ToolError) {
    super(toolError.error.message)
    this.name = 'ToolFailure'
    this.toolError = toolError
  }
}

/**
 * Маскирование секретов (раздел 7.4 ТЗ): только непустые значения длиной
 * не менее 4 символов, подставленные в поля password/auth.password.
 */
export function createMasker(secrets: readonly string[]): Masker {
  const sorted = [...new Set(secrets)]
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length)
  if (sorted.length === 0) return (text) => text
  return (text: string): string => {
    let out = text
    for (const s of sorted) out = out.split(s).join('***')
    return out
  }
}

const HINTS: Partial<Record<ToolErrorKind, string>> = {
  connect: 'Нет соединения с базой: проверьте доступность и параметры подключения, затем повторите.',
  query: 'Ошибка выполнения запроса: исправьте SQL или параметры.',
  tx: 'Сбой транзакции (BEGIN/COMMIT): изменения не применены, если нет outcomeUnknown.',
  user: 'Ошибка в логике вызова (не сбой СУБД): повтор без изменений бессмыслен.',
  timeout: 'Превышено время ожидания: увеличьте timeoutMs или упростите запрос.',
  aborted: 'Запрос прерван клиентом.',
}

const OUTCOME_UNKNOWN_TEXT =
  'outcomeUnknown: итог операции не определён — проверьте состояние данных перед повтором; повтор должен быть идемпотентным.'

/** `TDbError` пакета → `ToolError` (раздел 7.2 ТЗ). */
export function toToolErrorFromDbError(
  error: TDbError,
  opts: { connection?: string; statementIndex?: number; outcomeUnknown?: boolean } = {},
): ToolError {
  const e: ToolError['error'] = {
    kind: error.kind,
    message: error.message,
  }
  if (error.code !== undefined) e.code = error.code
  if (opts.connection !== undefined) e.connection = opts.connection
  if (opts.statementIndex !== undefined) e.statementIndex = opts.statementIndex
  if (opts.outcomeUnknown !== undefined) e.outcomeUnknown = opts.outcomeUnknown
  return { ok: false, error: e }
}

/** Бросает ToolFailure с отображённым TDbError. */
export function throwDbError(
  error: TDbError,
  opts: { connection?: string; statementIndex?: number; outcomeUnknown?: boolean } = {},
): never {
  throw new ToolFailure(toToolErrorFromDbError(error, opts))
}

/**
 * Разбор любого брошенного значения в ToolError с маскированием message.
 * `secrets` — значения для маскирования (из registry).
 */
export function toToolError(e: unknown, secrets: readonly string[]): ToolError {
  const mask = createMasker(secrets)
  if (e instanceof ToolFailure) {
    return maskToolError(e.toolError, mask)
  }
  if (e instanceof ServerError) {
    const err: ToolError['error'] = { kind: e.kind, message: mask(e.message) }
    if (e.connection !== undefined) err.connection = e.connection
    if (e.statementIndex !== undefined) err.statementIndex = e.statementIndex
    if (e.outcomeUnknown !== undefined) err.outcomeUnknown = e.outcomeUnknown
    return { ok: false, error: err }
  }
  const message = e instanceof Error ? e.message || 'unknown error' : String(e)
  return { ok: false, error: { kind: 'internal', message: mask(message) } }
}

function maskToolError(toolError: ToolError, mask: Masker): ToolError {
  return {
    ok: false,
    error: { ...toolError.error, message: mask(toolError.error.message) },
  }
}

/** Текст ошибки для `content` (раздел 7.4 ТЗ). */
export function formatErrorText(err: ToolError): string {
  const e = err.error
  const lines: string[] = [`[${e.kind}] ${e.message}`]
  if (e.code !== undefined) lines.push(`code: ${e.code}`)
  if (e.statementIndex !== undefined) lines.push(`statementIndex: ${e.statementIndex}`)
  if (e.outcomeUnknown) lines.push(OUTCOME_UNKNOWN_TEXT)
  const hint = HINTS[e.kind]
  if (hint !== undefined) lines.push(hint)
  return lines.join('\n')
}
