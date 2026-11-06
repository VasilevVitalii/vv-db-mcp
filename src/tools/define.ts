import type { z } from 'zod'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { Entry, ConnectionRegistry } from '../connections/registry.js'
import type { ResolvedLimits } from '../config/schema.js'
import type { Logger } from '../log.js'

/** Контекст, доступный каждому обработчику инструмента (раздел 8.4 ТЗ). */
export interface ToolCtx {
  registry: ConnectionRegistry
  log: Logger
}

/**
 * Описание одного инструмента. `input`/`output` — zod-схемы (вход strict,
 * выход — объект с `ok: true`). `handler` бросает `ServerError`/`ToolFailure`,
 * а успешный результат возвращает уже готовый объект с `ok: true`.
 */
export interface ToolDef<In extends z.ZodType, Out extends z.ZodType> {
  name: string
  title: string
  description: string
  input: In
  output: Out
  annotations: ToolAnnotations
  handler: (args: z.infer<In>, ctx: ToolCtx, signal: AbortSignal) => Promise<z.infer<Out>>
}

/** Аннотации MCP: чтение (раздел 4.1 ТЗ). */
export const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}

/** Аннотации MCP: изменение данных (раздел 4.1 ТЗ). */
export const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

/** Сохраняет inferred-типы input/output при описании инструмента. */
export function defineTool<In extends z.ZodType, Out extends z.ZodType>(def: ToolDef<In, Out>): ToolDef<In, Out> {
  return def
}

/** Подключение по имени; бросает `unknown_connection` (registry.get). */
export function getEntry(ctx: ToolCtx, connection: string): Entry {
  return ctx.registry.get(connection)
}

/** Ограничение timeoutMs потолком maxTimeoutMs. */
export function clampTimeout(ms: number, limits: ResolvedLimits): number {
  return Math.min(Math.max(1, ms), limits.maxTimeoutMs)
}

/** Ограничение maxRows потолком maxRowsCap. */
export function clampMaxRows(ms: number, limits: ResolvedLimits): number {
  return Math.min(Math.max(1, ms), limits.maxRowsCap)
}
