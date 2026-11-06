#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig, ConfigError, type LoadResult } from './config/load.js'
import { loadSecretsFile } from './config/secrets.js'
import { ConnectionRegistry } from './connections/registry.js'
import { createLogger, parseLogLevel, type Masker } from './log.js'
import { createMasker } from './errors/map.js'
import { createServer } from './server.js'

/**
 * stdout принадлежит протоколу JSON-RPC и не должен содержать ничего
 * постороннего: всё служебное — в stderr (раздел 8.2 ТЗ).
 */
const fmt = (a: unknown): string => {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack ?? a.message
  try {
    const s = JSON.stringify(a)
    return s === undefined ? String(a) : s
  } catch {
    return String(a)
  }
}

// Маскер наполняется после загрузки конфига (registry.secrets); до этого stderr
// пишется как есть. Все console.*/stderr проходят через него, чтобы секреты не
// просочились в журнал (раздел 7.4 ТЗ) — иначе любой console.log внутри кода
// вывел бы пароль без маскирования.
let maskSecrets: Masker = (text) => text
const setMasker = (m: Masker): void => {
  maskSecrets = m
}
const toStderr = (...args: unknown[]): void => {
  process.stderr.write(`${maskSecrets(args.map(fmt).join(' '))}\n`)
}
console.log = toStderr
console.info = toStderr
console.debug = toStderr
console.warn = toStderr
console.error = toStderr

function parseArgs(argv: string[]): { config?: string; secrets?: string } {
  const out: { config?: string; secrets?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') out.config = argv[++i]
    else if (a === '--secrets') out.secrets = argv[++i]
  }
  return out
}

async function main(): Promise<void> {
  const argv = parseArgs(process.argv.slice(2))
  const configPath = argv.config ?? process.env.VV_DB_MCP_CONFIG
  const secretsPath = argv.secrets ?? process.env.VV_DB_MCP_SECRETS

  if (configPath === undefined) {
    process.stderr.write('vv-db-mcp: не задан путь к конфигу (--config или VV_DB_MCP_CONFIG)\n')
    process.exit(2)
  }

  let secrets: Map<string, string> | null = null
  if (secretsPath !== undefined) {
    try {
      const r = await loadSecretsFile(secretsPath)
      secrets = r.map
      if (r.warning !== undefined) process.stderr.write(`vv-db-mcp: ${r.warning}\n`)
    } catch (e) {
      process.stderr.write(`vv-db-mcp: ${(e as Error).message}\n`)
      process.exit(2)
    }
  }

  let result: LoadResult
  try {
    result = await loadConfig(configPath, secrets)
  } catch (e) {
    const msg = e instanceof ConfigError ? e.message : (e as Error).message
    process.stderr.write(`vv-db-mcp: ${msg}\n`)
    process.exit(2)
  }

  const registry = new ConnectionRegistry(result.connections, result.maskSecrets)
  const masker = createMasker(registry.secrets)
  setMasker(masker)
  const log = createLogger(parseLogLevel(process.env.VV_DB_MCP_LOG_LEVEL), masker)

  const server = createServer({ registry, log })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log.info(`запущен: ${registry.list().length} подключений`)

  // Идемпотентное завершение: SIGINT, SIGTERM и закрытие stdin могут прийти
  // вместе — closeAll и таймер форса запускаются только один раз.
  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    const timer = setTimeout(() => {
      log.warn('закрытие подключений не уложилось в 5 с — принудительный выход')
      process.exit(0)
    }, 5000)
    try {
      await registry.closeAll()
    } finally {
      clearTimeout(timer)
    }
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  process.stdin.on('end', () => void shutdown())

  // Случайно отклонённый промис не должен ронять сервер: фиксируем и продолжаем.
  process.on('unhandledRejection', (reason) => {
    log.error(`unhandledRejection: ${fmt(reason)}`)
  })
  process.on('uncaughtException', (err) => {
    log.error(`uncaughtException: ${fmt(err)}`)
    if (shuttingDown) return
    shuttingDown = true
    const timer = setTimeout(() => {
      log.warn('закрытие подключений не уложилось в 5 с — принудительный выход')
      process.exit(1)
    }, 5000)
    void registry.closeAll().finally(() => {
      clearTimeout(timer)
      process.exit(1)
    })
  })
}

void main().catch((e) => {
  process.stderr.write(`${maskSecrets(String(e instanceof Error ? e.stack ?? e.message : e))}\n`)
  process.exit(1)
})
