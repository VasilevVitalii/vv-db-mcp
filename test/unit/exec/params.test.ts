import { describe, it, expect } from 'vitest'
import { toDbParams } from '../../../src/exec/params.js'

describe('toDbParams', () => {
  it('as=date → Date', () => {
    const [p] = toDbParams([{ name: 'd', value: '2024-01-01T00:00:00Z', as: 'date' }])
    expect(p.value).toBeInstanceOf(Date)
  })

  it('as=bigint → bigint', () => {
    const [p] = toDbParams([{ name: 'b', value: '12345678901234567890', as: 'bigint' }])
    expect(typeof p.value).toBe('bigint')
    expect(p.value!.toString()).toBe('12345678901234567890')
  })

  it('as=binary_base64 → Buffer', () => {
    const [p] = toDbParams([{ name: 'b', value: 'aGVsbG8=', as: 'binary_base64' }])
    expect(Buffer.isBuffer(p.value)).toBe(true)
    expect((p.value as Buffer).toString('utf8')).toBe('hello')
  })

  it('base64 без паддинга принимается', () => {
    const [p] = toDbParams([{ name: 'b', value: 'aGVsbG8', as: 'binary_base64' }])
    expect((p.value as Buffer).toString('utf8')).toBe('hello')
  })

  it('url-safe base64 (-_ → +/) принимается', () => {
    const [p] = toDbParams([{ name: 'b', value: '___', as: 'binary_base64' }])
    expect(Buffer.isBuffer(p.value)).toBe(true)
  })

  it('base64 длины 4k+1 отвергается', () => {
    expect(() => toDbParams([{ name: 'b', value: 'a', as: 'binary_base64' }])).toThrow()
  })

  it('без as — value прозрачно', () => {
    const [p] = toDbParams([{ name: 'x', value: 42 }])
    expect(p.value).toBe(42)
    expect(p).not.toHaveProperty('as')
  })

  it('type и direction переносятся', () => {
    const [p] = toDbParams([{ name: 'x', type: 'int', direction: 'inout' }])
    expect(p.type).toBe('int')
    expect(p.direction).toBe('inout')
  })

  it('только name — без value/type/direction', () => {
    const [p] = toDbParams([{ name: 'x' }])
    expect(p).toEqual({ name: 'x' })
  })
})
