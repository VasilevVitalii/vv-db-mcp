import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAll } from './tools/index.js'
import type { ToolCtx } from './tools/define.js'

const NAME = 'vv-db-mcp'
const VERSION = '0.0.1'

/** McpServer с зарегистрированными инструментами (раздел 8.2 ТЗ). */
export function createServer(ctx: ToolCtx): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION })
  registerAll(server, ctx)
  return server
}
