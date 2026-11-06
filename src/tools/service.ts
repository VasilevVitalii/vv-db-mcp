import { z } from 'zod'
import { defineTool, getEntry, clampTimeout, READ_ANNOTATIONS } from './define.js'
import { connSchema } from './schemas.js'
import { throwDbError } from '../errors/map.js'

/** 6.1 `list_connections` — список подключений из конфига, БД не опрашивается. */
export const listConnectionsTool = defineTool({
  name: 'list_connections',
  title: 'list_connections',
  description:
    'Список подключений из конфигурации сервера. База данных не опрашивается, соединения не открываются. ' +
    'Возвращает имя, тип СУБД, заголовок и пользователя каждого подключения; пароли и прочие секреты не выдаются. ' +
    'Используй имя из этого списка в поле connection других инструментов.',
  input: z.strictObject({}),
  output: z.object({
    ok: z.literal(true),
    connections: z.array(
      z.object({
        name: z.string(),
        kind: z.enum(['mssql', 'pg', 'ora', 'fb'] as const),
        title: z.string(),
        user: z.string(),
        description: z.string().optional(),
      }),
    ),
  }),
  annotations: READ_ANNOTATIONS,
  handler: async (_args, ctx) => {
    const connections = ctx.registry.list().map((e) => ({
      name: e.name,
      kind: e.kind,
      title: e.title,
      user: e.user,
      ...(e.description !== undefined ? { description: e.description } : {}),
    }))
    return { ok: true as const, connections }
  },
})

/** 6.2 `ping` — живость подключения минимальным read-only запросом. */
export const pingTool = defineTool({
  name: 'ping',
  title: 'ping',
  description:
    'Проверка живости подключения: минимальный read-only запрос без требований к привилегиям. ' +
    'Неудача — ошибка connect, timeout или query. Для Firebird недоступный хост отсекается меньшим из connectTimeout подключения и timeoutMs вызова.',
  input: z.strictObject({
    connection: connSchema,
    timeoutMs: z.number().int().min(1).default(10000),
  }),
  output: z.object({
    ok: z.literal(true),
    connection: z.string(),
    elapsedMs: z.number().int(),
  }),
  annotations: READ_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    const t = clampTimeout(args.timeoutMs, entry.limits)
    const start = Date.now()
    const r = await entry.db.ping({ signal, firstDataTimeoutMs: t, idleTimeoutMs: t })
    if (!r.ok) throwDbError(r.error, { connection: entry.name })
    return { ok: true as const, connection: entry.name, elapsedMs: Date.now() - start }
  },
})

/** 6.3 `version` — строка версии сервера БД (вендорный формат). */
export const versionTool = defineTool({
  name: 'version',
  title: 'version',
  description:
    'Строка версии сервера БД как её вернул сервер (формат вендорный, парсинг не выполняется). ' +
    'Fallback Oracle (v$version → PRODUCT_COMPONENT_VERSION) выполняет пакет; если версию получить нельзя — code: NO_VERSION.',
  input: z.strictObject({
    connection: connSchema,
    timeoutMs: z.number().int().min(1).optional(),
  }),
  output: z.object({
    ok: z.literal(true),
    connection: z.string(),
    version: z.string(),
  }),
  annotations: READ_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    const t = clampTimeout(args.timeoutMs ?? entry.limits.timeoutMs, entry.limits)
    const r = await entry.db.version({ signal, firstDataTimeoutMs: t, idleTimeoutMs: t })
    if (!r.ok) throwDbError(r.error, { connection: entry.name })
    return { ok: true as const, connection: entry.name, version: r.result }
  },
})
