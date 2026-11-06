import { describe, it, expect } from 'vitest'
import { ServerError } from '../../../src/errors/map.js'
import {
  quoteIdentifier,
  resolveName,
  matchesFilter,
  sortByName,
  applyLimit,
  baseTypeName,
  typeCategory,
} from '../../../src/catalog/common.js'

describe('typeCategory', () => {
  it('mssql', () => {
    expect(typeCategory('mssql', 'int')).toBe('integer')
    expect(typeCategory('mssql', 'nvarchar')).toBe('string')
    expect(typeCategory('mssql', 'decimal')).toBe('decimal')
    expect(typeCategory('mssql', 'bit')).toBe('boolean')
    expect(typeCategory('mssql', 'datetime2')).toBe('timestamp')
    expect(typeCategory('mssql', 'varbinary')).toBe('binary')
    expect(typeCategory('mssql', 'geometry')).toBe('other')
  })

  it('pg (включая массивы)', () => {
    expect(typeCategory('pg', 'integer')).toBe('integer')
    expect(typeCategory('pg', 'numeric')).toBe('decimal')
    expect(typeCategory('pg', 'text')).toBe('string')
    expect(typeCategory('pg', 'bytea')).toBe('binary')
    expect(typeCategory('pg', 'boolean')).toBe('boolean')
    expect(typeCategory('pg', 'timestamp with time zone')).toBe('timestamp')
    expect(typeCategory('pg', 'integer[]')).toBe('integer')
  })

  it('ora (NUMBER зависит от scale)', () => {
    expect(typeCategory('ora', 'number')).toBe('decimal')
    expect(typeCategory('ora', 'number', 0)).toBe('integer')
    expect(typeCategory('ora', 'number', 2)).toBe('decimal')
    expect(typeCategory('ora', 'number', null)).toBe('decimal')
    expect(typeCategory('ora', 'varchar2')).toBe('string')
    expect(typeCategory('ora', 'date')).toBe('timestamp')
    expect(typeCategory('ora', 'blob')).toBe('binary')
  })

  it('fb', () => {
    expect(typeCategory('fb', 'integer')).toBe('integer')
    expect(typeCategory('fb', 'numeric')).toBe('decimal')
    expect(typeCategory('fb', 'varchar')).toBe('string')
    expect(typeCategory('fb', 'blob sub_type text')).toBe('string')
    expect(typeCategory('fb', 'blob sub_type binary')).toBe('binary')
    expect(typeCategory('fb', 'boolean')).toBe('boolean')
    expect(typeCategory('fb', 'date')).toBe('date')
    expect(typeCategory('fb', 'timestamp')).toBe('timestamp')
  })
})

describe('quoteIdentifier', () => {
  it('mssql — квадратные скобки с экранированием ]', () => {
    expect(quoteIdentifier('mssql', 'abc')).toBe('[abc]')
    expect(quoteIdentifier('mssql', 'a]b')).toBe('[a]]b]')
  })

  it('остальные — двойные кавычки с экранированием "', () => {
    for (const kind of ['pg', 'ora', 'fb'] as const) {
      expect(quoteIdentifier(kind, 'abc')).toBe('"abc"')
      expect(quoteIdentifier(kind, 'a"b')).toBe('"a""b"')
    }
  })
})

describe('resolveName', () => {
  const cands = [
    { schema: 'public', name: 'Foo' },
    { schema: 'public', name: 'bar' },
    { schema: 'other', name: 'Foo' },
  ]

  it('точное совпадение', () => {
    expect(resolveName(cands, 'bar')).toEqual({ schema: 'public', name: 'bar' })
  })

  it('без учёта регистра', () => {
    expect(resolveName(cands, 'bar')).toEqual({ schema: 'public', name: 'bar' })
  })

  it('not_found', () => {
    expect(() => resolveName(cands, 'nope')).toThrow(ServerError)
    try {
      resolveName(cands, 'nope')
    } catch (e) {
      expect((e as ServerError).kind).toBe('not_found')
    }
  })

  it('ambiguous (один и тот же регистр в разных схемах)', () => {
    expect(() => resolveName(cands, 'foo')).toThrow(ServerError)
    try {
      resolveName(cands, 'foo')
    } catch (e) {
      expect((e as ServerError).kind).toBe('ambiguous')
    }
  })

  it('сужение по schema разрешает неоднозначность', () => {
    expect(resolveName(cands, 'foo', 'other')).toEqual({ schema: 'other', name: 'Foo' })
  })

  it('not_found в рамках schema — с указанием схемы в сообщении', () => {
    try {
      resolveName(cands, 'bar', 'other')
    } catch (e) {
      expect((e as ServerError).message).toContain('в схеме other')
    }
  })
})

describe('matchesFilter / sortByName / applyLimit / baseTypeName', () => {
  it('matchesFilter — регистронезависимая подстрока', () => {
    expect(matchesFilter('FooBar', 'foob')).toBe(true)
    expect(matchesFilter('FooBar', 'zzz')).toBe(false)
    expect(matchesFilter('FooBar')).toBe(true)
  })

  it('sortByName — по schema, затем name', () => {
    const items = [
      { schema: 'b', name: 'z' },
      { schema: 'a', name: 'y' },
      { schema: 'a', name: 'x' },
    ]
    sortByName(items)
    expect(items.map((i) => `${i.schema}.${i.name}`)).toEqual(['a.x', 'a.y', 'b.z'])
  })

  it('applyLimit', () => {
    expect(applyLimit([1, 2, 3], 2)).toEqual({ items: [1, 2], truncated: true })
    expect(applyLimit([1], 2)).toEqual({ items: [1], truncated: false })
  })

  it('baseTypeName — trim + lowercase, длина не обрезается', () => {
    expect(baseTypeName('  VARCHAR(10)  ')).toBe('varchar(10)')
  })
})
