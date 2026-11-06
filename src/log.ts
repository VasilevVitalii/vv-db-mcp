export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export interface Logger {
  error(msg: string): void
  warn(msg: string): void
  info(msg: string): void
  debug(msg: string): void
}

/** Заменяет секреты в тексте (см. errors/map.ts createMasker). */
export type Masker = (text: string) => string

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

export function parseLogLevel(value: string | undefined): LogLevel {
  if (value === 'error' || value === 'warn' || value === 'info' || value === 'debug') return value
  return 'warn'
}

/**
 * Логгер в stderr. stdout принадлежит протоколу MCP и не должен содержать
 * ничего постороннего. `mask` применяется к каждому сообщению.
 */
export function createLogger(level: LogLevel, mask: Masker = (s) => s): Logger {
  const write = (lvl: LogLevel, msg: string): void => {
    if (ORDER[lvl] > ORDER[level]) return
    process.stderr.write(`[vv-db-mcp][${lvl}] ${mask(msg)}\n`)
  }
  return {
    error: (m) => write('error', m),
    warn: (m) => write('warn', m),
    info: (m) => write('info', m),
    debug: (m) => write('debug', m),
  }
}
