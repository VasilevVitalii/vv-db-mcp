import { describe, it, expect } from 'vitest'
import { serializeValue, serializeRow, SerializeState } from '../../../src/exec/serialize.js'

const opts = { maxCellChars: 10, maxBinaryBytes: 4 }

describe('serializeValue', () => {
  it('null/undefined → null', () => {
    expect(serializeValue(null, opts, new SerializeState())).toBeNull()
    expect(serializeValue(undefined, opts, new SerializeState())).toBeNull()
  })

  it('bigint → строка', () => {
    expect(serializeValue(123n, opts, new SerializeState())).toBe('123')
  })

  it('NaN/Infinity → строки', () => {
    expect(serializeValue(NaN, opts, new SerializeState())).toBe('NaN')
    expect(serializeValue(Infinity, opts, new SerializeState())).toBe('Infinity')
    expect(serializeValue(-Infinity, opts, new SerializeState())).toBe('-Infinity')
  })

  it('number/boolean прозрачно', () => {
    expect(serializeValue(42, opts, new SerializeState())).toBe(42)
    expect(serializeValue(3.14, opts, new SerializeState())).toBe(3.14)
    expect(serializeValue(true, opts, new SerializeState())).toBe(true)
  })

  it('короткая строка — как есть', () => {
    expect(serializeValue('abc', opts, new SerializeState())).toBe('abc')
  })

  it('длинная строка обрезается и инкрементирует счётчик', () => {
    const st = new SerializeState()
    const out = serializeValue('abcdefghijklmnop', opts, st)
    expect(out).toBe('abcdefghij')
    expect(st.truncatedCells).toBe(1)
  })

  it('валидный Date → ISO', () => {
    const d = new Date('2024-01-01T00:00:00.000Z')
    expect(serializeValue(d, opts, new SerializeState())).toBe('2024-01-01T00:00:00.000Z')
  })

  it('невалидный Date → null', () => {
    expect(serializeValue(new Date('nope'), opts, new SerializeState())).toBeNull()
  })

  it('Uint8Array с обрезкой', () => {
    const st = new SerializeState()
    const out = serializeValue(new Uint8Array([1, 2, 3, 4, 5, 6]), opts, st)
    expect(out).toEqual({ $base64: 'AQIDBA==', bytes: 6, truncated: true })
    expect(st.truncatedBinary).toBe(1)
  })

  it('Uint8Array без обрезки', () => {
    const st = new SerializeState()
    const out = serializeValue(new Uint8Array([1, 2, 3]), opts, st)
    expect(out).toEqual({ $base64: 'AQID', bytes: 3, truncated: false })
    expect(st.truncatedBinary).toBe(0)
  })

  it('массив — рекурсивно', () => {
    const out = serializeValue([1n, 'x'], opts, new SerializeState())
    expect(out).toEqual(['1', 'x'])
  })

  it('объект — рекурсивно', () => {
    const out = serializeValue({ a: 1n, b: null }, opts, new SerializeState())
    expect(out).toEqual({ a: '1', b: null })
  })

  it('Map → объект', () => {
    const out = serializeValue(new Map([['a', 1n], ['b', 'x']]), opts, new SerializeState())
    expect(out).toEqual({ a: '1', b: 'x' })
  })

  it('Set → массив', () => {
    const out = serializeValue(new Set([1n, 'x']), opts, new SerializeState())
    expect(out).toEqual(['1', 'x'])
  })

  it('объект с toJSON — сериализуется через него', () => {
    const v = { toJSON: () => 'decoded' }
    expect(serializeValue(v, opts, new SerializeState())).toBe('decoded')
  })

  it('циклическая ссылка → [Circular]', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    const out = serializeValue(a, opts, new SerializeState()) as Record<string, unknown>
    expect(out.self).toBe('[Circular]')
  })
})

describe('serializeRow', () => {
  it('сериализует каждое значение строки', () => {
    const out = serializeRow({ id: 1n, name: 'abc' }, opts, new SerializeState())
    expect(out).toEqual({ id: '1', name: 'abc' })
  })
})
