import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../../../src/server.js'
import { ConnectionRegistry } from '../../../src/connections/registry.js'

const EXPECTED = [
  'list_connections',
  'ping',
  'version',
  'execute_sql',
  'execute_transaction',
  'list_schemas',
  'list_tables',
  'list_views',
  'describe_table',
  'list_foreign_keys',
  'list_indexes',
  'list_constraints',
  'list_routines',
  'list_triggers',
  'list_sequences',
  'get_definition',
  'sample_rows',
]

describe('регистрация инструментов', () => {
  it('tools/list возвращает ровно 17 инструментов раздела 6', async () => {
    const registry = new ConnectionRegistry([], [])
    const log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
    const server = createServer({ registry, log })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)

    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(clientTransport)

    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()

    expect(names).toHaveLength(17)
    expect(names).toEqual([...EXPECTED].sort())

    // каждый инструмент обязан иметь outputSchema (контракт раздела 6)
    for (const t of tools) {
      expect(t.outputSchema, `outputSchema у ${t.name}`).toBeDefined()
    }

    await client.close()
    await server.close()
  })
})
