import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('vv-db-connection', () => {
  class DbConnection {
    title(): string {
      return 'MockDB'
    }
    user(): string {
      return 'mockuser'
    }
    close(): Promise<void> {
      return Promise.resolve()
    }
  }
  return { DbConnection }
})

import { loadConfig, ConfigError } from '../../../src/config/load.js'

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvdbmcp-'))
  const p = join(dir, 'config.json')
  writeFileSync(p, content)
  return p
}

const pg = (password: string) =>
  JSON.stringify({ connections: [{ kind: 'pg', name: 'db1', host: 'h', database: 'd', user: 'u', password }] })

describe('loadConfig: подстановка секретов (раздел 3.4)', () => {
  it('${KEY} подставляется, password маскируется и попадает в secrets', async () => {
    const r = await loadConfig(tmpFile(pg('${DB_PASS}')), new Map([['DB_PASS', 's3cret']]))
    expect(r.config.connections[0].password).toBe('s3cret')
    expect(r.maskSecrets).toContain('s3cret')
    expect(r.connections[0].secrets).toContain('s3cret')
  })

  it('$${ экранирует литерал — подстановки нет', async () => {
    const r = await loadConfig(tmpFile(pg('$${DB_PASS}')), new Map([['DB_PASS', 's3cret']]))
    expect(r.config.connections[0].password).toBe('${DB_PASS}')
    expect(r.maskSecrets).toEqual([])
  })

  it('подстановка в не-password поле не маскируется', async () => {
    const c = JSON.stringify({
      connections: [{ kind: 'pg', name: 'db1', host: 'h', database: 'd', user: 'u', password: 'p', description: '${D}' }],
    })
    const r = await loadConfig(tmpFile(c), new Map([['D', 'descval']]))
    expect(r.config.connections[0].description).toBe('descval')
    expect(r.maskSecrets).toEqual([])
  })

  it('${KEY} без файла секретов → ConfigError', async () => {
    await expect(loadConfig(tmpFile(pg('${DB_PASS}')), null)).rejects.toThrow(ConfigError)
  })

  it('отсутствующий ключ → ConfigError с именем ключа', async () => {
    await expect(loadConfig(tmpFile(pg('${NOPE}')), new Map())).rejects.toThrow(/ключ секрета не найден: NOPE/)
  })
})

describe('loadConfig: валидация конфига', () => {
  it('дубликат имени без учёта регистра → ConfigError', async () => {
    const c = JSON.stringify({
      connections: [
        { kind: 'pg', name: 'Foo', host: 'h', database: 'd', user: 'u', password: 'p' },
        { kind: 'pg', name: 'foo', host: 'h', database: 'd', user: 'u', password: 'p' },
      ],
    })
    await expect(loadConfig(tmpFile(c), new Map())).rejects.toThrow(/уникальны без учёта регистра/)
  })

  it('невалидный JSON → ConfigError', async () => {
    await expect(loadConfig(tmpFile('{'), new Map())).rejects.toThrow(ConfigError)
  })

  it('корректный конфиг даёт connections с title/user из DbConnection', async () => {
    const r = await loadConfig(tmpFile(pg('p')), new Map())
    expect(r.connections).toHaveLength(1)
    expect(r.connections[0].name).toBe('db1')
    expect(r.connections[0].title).toBe('MockDB')
    expect(r.connections[0].user).toBe('mockuser')
  })
})
