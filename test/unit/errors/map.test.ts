import { describe, it, expect } from 'vitest'
import {
  ServerError,
  ToolFailure,
  isServerError,
  createMasker,
  toToolErrorFromDbError,
  throwDbError,
  toToolError,
  formatErrorText,
} from '../../../src/errors/map.js'

describe('ServerError', () => {
  it('хранит kind/connection/statementIndex/outcomeUnknown', () => {
    const e = new ServerError('not_found', 'объект не найден', {
      connection: 'c',
      statementIndex: 2,
      outcomeUnknown: true,
    })
    expect(e.kind).toBe('not_found')
    expect(e.message).toBe('объект не найден')
    expect(e.connection).toBe('c')
    expect(e.statementIndex).toBe(2)
    expect(e.outcomeUnknown).toBe(true)
    expect(isServerError(e)).toBe(true)
    expect(isServerError(new Error('x'))).toBe(false)
  })
})

describe('createMasker', () => {
  it('пустой список — identity', () => {
    const m = createMasker([])
    expect(m('abc')).toBe('abc')
  })

  it('короткие значения (<4) не маскируются', () => {
    const m = createMasker(['ab', 'abc'])
    expect(m('ab abc')).toBe('ab abc')
  })

  it('дедупликация и замена', () => {
    const m = createMasker(['secret123', 'secret123'])
    expect(m('пароль secret123')).toBe('пароль ***')
  })

  it('заменяет по убыванию длины (длинный секрет раньше короткого)', () => {
    const m = createMasker(['abc', 'abcdef'])
    expect(m('abcdef')).toBe('***')
  })
})

describe('toToolErrorFromDbError', () => {
  it('маппит kind/code/message и опции', () => {
    const t = toToolErrorFromDbError(
      { kind: 'query', code: 'X42', message: 'bad sql' },
      { connection: 'c', statementIndex: 1, outcomeUnknown: true },
    )
    expect(t).toEqual({
      ok: false,
      error: { kind: 'query', code: 'X42', message: 'bad sql', connection: 'c', statementIndex: 1, outcomeUnknown: true },
    })
  })

  it('без опций — только kind/message/code', () => {
    const t = toToolErrorFromDbError({ kind: 'timeout', message: 'slow' })
    expect(t.error).toEqual({ kind: 'timeout', message: 'slow' })
  })
})

describe('throwDbError', () => {
  it('бросает ToolFailure с отображённой ошибкой', () => {
    expect(() => throwDbError({ kind: 'connect', message: 'no conn' }, {})).toThrow(ToolFailure)
    try {
      throwDbError({ kind: 'connect', message: 'no conn' }, {})
    } catch (e) {
      expect(e).toBeInstanceOf(ToolFailure)
      expect((e as ToolFailure).toolError.error.kind).toBe('connect')
    }
  })
})

describe('toToolError', () => {
  it('ServerError → маскированный ToolError', () => {
    const e = new ServerError('not_found', 'объект "secret123" не найден')
    const t = toToolError(e, ['secret123'])
    expect(t.ok).toBe(false)
    expect(t.error.kind).toBe('not_found')
    expect(t.error.message).toBe('объект "***" не найден')
  })

  it('ToolFailure → маскированный ToolError', () => {
    const tf = new ToolFailure({ ok: false, error: { kind: 'query', message: 'pwd=secret123' } })
    const t = toToolError(tf, ['secret123'])
    expect(t.error.kind).toBe('query')
    expect(t.error.message).toBe('pwd=***')
  })

  it('обычная Error → internal', () => {
    const t = toToolError(new Error('boom'), [])
    expect(t.error).toEqual({ kind: 'internal', message: 'boom' })
  })

  it('не-Error → internal со строковым сообщением', () => {
    const t = toToolError('oops', [])
    expect(t.error).toEqual({ kind: 'internal', message: 'oops' })
  })
})

describe('formatErrorText', () => {
  it('собирает строку с kind/code/statementIndex/outcomeUnknown/подсказкой', () => {
    const txt = formatErrorText({
      ok: false,
      error: { kind: 'query', code: 'X42', message: 'm', statementIndex: 0, outcomeUnknown: true },
    })
    expect(txt).toContain('[query] m')
    expect(txt).toContain('code: X42')
    expect(txt).toContain('statementIndex: 0')
    expect(txt).toContain('outcomeUnknown')
    expect(txt).toContain('Ошибка выполнения запроса')
  })

  it('минимальная строка — только [kind] message', () => {
    const txt = formatErrorText({ ok: false, error: { kind: 'aborted', message: 'отменено' } })
    expect(txt).toBe('[aborted] отменено\nЗапрос прерван клиентом.')
  })
})
