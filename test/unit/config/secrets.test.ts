import { describe, it, expect } from 'vitest'
import { parseSecrets } from '../../../src/config/secrets.js'

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
})
