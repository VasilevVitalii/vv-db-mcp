import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAll } from './tools/index.js'
import type { ToolCtx } from './tools/define.js'

const NAME = 'vv-db-mcp'
// Версия берётся из package.json, а не дублируется — рассинхронизация при релизе
// исключена (package.json всегда рядом с dist/ и src/).
const require = createRequire(import.meta.url)
const VERSION = (require('../package.json') as { version: string }).version

/** McpServer с зарегистрированными инструментами (раздел 8.2 ТЗ). */
export function createServer(ctx: ToolCtx): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION })
  registerAll(server, ctx)
  return server
}
