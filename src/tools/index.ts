import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { toToolError, formatErrorText } from '../errors/map.js'
import type { ToolCtx } from './define.js'
import { listConnectionsTool, pingTool, versionTool } from './service.js'
import { executeSqlTool, executeTransactionTool } from './sql.js'
import {
  listSchemasTool,
  listTablesTool,
  listViewsTool,
  describeTableTool,
  listForeignKeysTool,
  listIndexesTool,
  listConstraintsTool,
  listRoutinesTool,
  listTriggersTool,
  listSequencesTool,
  getDefinitionTool,
  sampleRowsTool,
} from './meta.js'

const allTools = [
  listConnectionsTool,
  pingTool,
  versionTool,
  executeSqlTool,
  executeTransactionTool,
  listSchemasTool,
  listTablesTool,
  listViewsTool,
  describeTableTool,
  listForeignKeysTool,
  listIndexesTool,
  listConstraintsTool,
  listRoutinesTool,
  listTriggersTool,
  listSequencesTool,
  getDefinitionTool,
  sampleRowsTool,
]

/** Свёрнутая сигнатура регистрации: конкретные zod-схемы в `unknown`, колбэк типизирован. */
type ToolRegister = (
  name: string,
  config: {
    title?: string
    description?: string
    inputSchema?: unknown
    outputSchema?: unknown
    annotations?: ToolAnnotations
  },
  cb: (args: unknown, extra: { signal: AbortSignal }) => Promise<CallToolResult>,
) => void

/**
 * Регистрирует все инструменты (раздел 8.4 ТЗ). Ни один обработчик не
 * формирует ошибку сам — он бросает ServerError/ToolFailure, а единая
 * обёртка здесь превращает исключение в { isError: true } с маскированием.
 * Валидация входа/выхода выполняется самим SDK по inputSchema/outputSchema.
 */
export function registerAll(server: McpServer, ctx: ToolCtx): void {
  const register = server.registerTool.bind(server) as unknown as ToolRegister
  for (const t of allTools) {
    register(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        outputSchema: t.output,
        annotations: t.annotations,
      },
      async (args, extra) => {
        try {
          const handler = t.handler as unknown as (a: unknown, c: ToolCtx, s: AbortSignal) => Promise<unknown>
          const data = await handler(args, ctx, extra.signal)
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data) }],
            structuredContent: data as Record<string, unknown>,
          }
        } catch (e) {
          const err = toToolError(e, ctx.registry.secrets)
          const text = formatErrorText(err)
          ctx.log.debug(`${t.name}: ${text}`)
          return {
            isError: true as const,
            content: [{ type: 'text' as const, text }],
            structuredContent: err as unknown as Record<string, unknown>,
          }
        }
      },
    )
  }
}
