import { describe, it, expect } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSecrets, loadSecretsFile } from '../../../src/config/secrets.js'

describe('parseSecrets', () => {
  it('базовый key=value', () => {
    expect(parseSecrets('A=1\nB=2')).toEqual(new Map([['A', '1'], ['B', '2']]))
  })

  it('значение может содержать =', () => {
    expect(parseSecrets('A=1=2')).toEqual(new Map([['A', '1=2']]))
  })

  it('комментарии и пустые строки пропускаются', () => {
    expect(parseSecrets('# comment\n\nA=1')).toEqual(new Map([['A', '1']]))
  })

  it('строка без = игнорируется', () => {
    expect(parseSecrets('noequals\nA=1')).toEqual(new Map([['A', '1']]))
  })

  it('повторяющийся ключ — last wins', () => {
    expect(parseSecrets('A=1\nA=2')).toEqual(new Map([['A', '2']]))
  })

  it('без обрезки пробелов', () => {
    expect(parseSecrets(' A =1')).toEqual(new Map([[' A ', '1']]))
  })

  it('CRLF-переводы строк', () => {
    expect(parseSecrets('A=1\r\nB=2')).toEqual(new Map([['A', '1'], ['B', '2']]))
  })

  it('BOM в начале отсекается', () => {
    expect(parseSecrets('\uFEFFA=1')).toEqual(new Map([['A', '1']]))
  })
})

describe('loadSecretsFile: предупреждение о правах', () => {
  const tmpFile = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'vvdbmcp-secrets-'))
    const p = join(dir, 'secrets.env')
    writeFileSync(p, content)
    return p
  }

  it('world-readable файл (0644) → предупреждение', async () => {
    const p = tmpFile('A=1')
    chmodSync(p, 0o644)
    const r = await loadSecretsFile(p)
    expect(r.map.get('A')).toBe('1')
    expect(r.warning).toMatch(/рекомендуется chmod 600/)
  })

  it('файл 0600 → предупреждения нет', async () => {
    const p = tmpFile('A=1')
    chmodSync(p, 0o600)
    const r = await loadSecretsFile(p)
    expect(r.warning).toBeUndefined()
  })

  it('на Windows предупреждение не выдаётся (ложное срабатывание)', async () => {
    const p = tmpFile('A=1')
    chmodSync(p, 0o644)
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const r = await loadSecretsFile(p)
      expect(r.warning).toBeUndefined()
    } finally {
      if (desc) Object.defineProperty(process, 'platform', desc)
    }
  })
})
