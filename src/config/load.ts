import { readFile } from 'node:fs/promises'
import { DbConnection } from 'vv-db-connection'
import type { TConnectionParam } from 'vv-db-connection'
import { configSchema, resolveLimits, mergeLimits } from './schema.js'
import type { TConfig, TConnection, ResolvedLimits } from './schema.js'

export class ConfigError extends Error {
  constructor(public messages: string[]) {
    super(messages.join('\n'))
    this.name = 'ConfigError'
  }
}

export interface LoadedConnection {
  name: string
  kind: TConnection['kind']
  description?: string
  limits: ResolvedLimits
  secrets: string[]
  db: DbConnection
  title: string
  user: string
}

export interface LoadResult {
  config: TConfig
  connections: LoadedConnection[]
  /** Значения секретов (подставленные в password/auth.password) для маскирования. */
  maskSecrets: string[]
}

interface SubstituteCtx {
  secrets: Map<string, string> | null
  maskSecrets: Set<string>
  connSecrets: Map<number, Set<string>>
  connIndex: number
}

function substituteString(s: string, ctx: SubstituteCtx, _fieldName: string): string {
  let result = ''
  let i = 0
  let changed = false
  while (i < s.length) {
    const c = s[i]
    if (c === '$' && s[i + 1] === '$' && s[i + 2] === '{') {
      result += '${'
      i += 3
      changed = true
      continue
    }
    if (c === '$' && s[i + 1] === '{') {
      const end = s.indexOf('}', i + 2)
      if (end === -1) {
        result += s.slice(i)
        break
      }
      const key = s.slice(i + 2, end)
      if (ctx.secrets === null) {
        throw new ConfigError([
          `конфиг содержит подстановку \${${key}}, но файл секретов не задан (--secrets или VV_DB_MCP_SECRETS)`,
        ])
      }
      const value = ctx.secrets.get(key)
      if (value === undefined) {
        throw new ConfigError([`ключ секрета не найден: ${key}`])
      }
      result += value
      i = end + 1
      changed = true
      continue
    }
    result += c
    i++
  }
  return changed ? result : s
}

function substitute(node: unknown, ctx: SubstituteCtx, fieldName: string): unknown {
  if (typeof node === 'string') {
    // в name и kind подстановка не выполняется (раздел 3.4 ТЗ)
    if (fieldName === 'name' || fieldName === 'kind') return node
    const res = substituteString(node, ctx, fieldName)
    // Пароль маскируется целиком — и подставленный (${KEY}), и литеральный:
    // маскер не должен зависеть от способа записи секрета в конфиг.
    if (fieldName === 'password') {
      ctx.maskSecrets.add(res)
      let set = ctx.connSecrets.get(ctx.connIndex)
      if (!set) {
        set = new Set()
        ctx.connSecrets.set(ctx.connIndex, set)
      }
      set.add(res)
    }
    return res
  }
  if (Array.isArray(node)) {
    return node.map((v, i) => {
      const saved = ctx.connIndex
      ctx.connIndex = i
      const r = substitute(v, ctx, String(i))
      ctx.connIndex = saved
      return r
    })
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
      out[k] = substitute(v, ctx, k)
    }
    return out
  }
  return node
}

function formatPath(path: PropertyKey[]): string {
  let out = ''
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`
    else out += out === '' ? String(seg) : `.${String(seg)}`
  }
  return out
}

export async function loadConfig(
  cfgPath: string,
  secrets: Map<string, string> | null,
): Promise<LoadResult> {
  let raw: string
  try {
    raw = await readFile(cfgPath, 'utf8')
  } catch (e) {
    throw new ConfigError([`не удалось прочитать файл конфига ${cfgPath}: ${(e as Error).message}`])
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new ConfigError([`файл конфига ${cfgPath} не является корректным JSON: ${(e as Error).message}`])
  }

  const ctx: SubstituteCtx = { secrets, maskSecrets: new Set(), connSecrets: new Map(), connIndex: -1 }
  let substituted: unknown
  try {
    substituted = substitute(parsed, ctx, '')
  } catch (e) {
    if (e instanceof ConfigError) throw e
    throw new ConfigError([(e as Error).message])
  }

  const r = configSchema.safeParse(substituted)
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((issue) => `${formatPath(issue.path) || '(root)'}: ${issue.message}`))
  }

  const config = r.data
  const errors: string[] = []

  // уникальность name без учёта регистра
  const seen = new Map<string, number>()
  config.connections.forEach((c, i) => {
    const key = c.name.toLowerCase()
    if (seen.has(key)) {
      errors.push(
        `connections[${i}].name: имя "${c.name}" уже используется (connections[${seen.get(key)}].name); имена уникальны без учёта регистра`,
      )
    } else {
      seen.set(key, i)
    }
  })

  const globalLimits = resolveLimits(config.limits)

  // Инварианты лимитов: инверсия (timeoutMs > maxTimeoutMs, maxRows > maxRowsCap)
  // молча клампилась бы вниз в рантайме — ловим на загрузке.
  const limitsErrors: string[] = []
  const checkLimits = (scope: string, l: ResolvedLimits): void => {
    if (l.timeoutMs > l.maxTimeoutMs) {
      limitsErrors.push(`${scope}: timeoutMs (${l.timeoutMs}) > maxTimeoutMs (${l.maxTimeoutMs})`)
    }
    if (l.maxRows > l.maxRowsCap) {
      limitsErrors.push(`${scope}: maxRows (${l.maxRows}) > maxRowsCap (${l.maxRowsCap})`)
    }
  }
  checkLimits('limits', globalLimits)

  // создание DbConnection (без ввода-вывода); TypeError -> ошибка конфига
  const built: Array<{ c: TConnection; i: number; db: DbConnection }> = []
  config.connections.forEach((c, i) => {
    const { name, description, limits, ...param } = c
    try {
      const db = new DbConnection(param as TConnectionParam)
      built.push({ c, i, db })
    } catch (e) {
      if (e instanceof TypeError) {
        errors.push(`connections[${i}] (${name}): ${e.message}`)
      } else {
        throw e
      }
    }
  })

  if (errors.length > 0) throw new ConfigError(errors)

  const connections: LoadedConnection[] = built.map(({ c, i, db }) => {
    const limits = mergeLimits(globalLimits, c.limits)
    checkLimits(`connections[${i}].limits`, limits)
    return {
      name: c.name,
      kind: c.kind,
      description: c.description,
      limits,
      secrets: [...(ctx.connSecrets.get(i) ?? [])],
      db,
      title: db.title(),
      user: db.user(),
    }
  })

  if (limitsErrors.length > 0) throw new ConfigError(limitsErrors)

  return { config, connections, maskSecrets: [...ctx.maskSecrets] }
}
