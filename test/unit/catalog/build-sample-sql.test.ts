import { describe, it, expect } from 'vitest'
import { mssqlCatalog } from '../../../src/catalog/mssql.js'
import { pgCatalog } from '../../../src/catalog/pg.js'
import { oraCatalog } from '../../../src/catalog/ora.js'
import { fbCatalog } from '../../../src/catalog/fb.js'

describe('buildSampleSql', () => {
  it('mssql — TOP (N), []-квотирование, schema', () => {
    expect(mssqlCatalog.buildSampleSql({ schema: 'dbo', table: 'T', columns: [], limit: 10 })).toBe(
      'SELECT TOP (10) * FROM [dbo].[T]',
    )
    expect(mssqlCatalog.buildSampleSql({ schema: null, table: 'T', columns: ['a', 'b'], limit: 5 })).toBe(
      'SELECT TOP (5) [a], [b] FROM [T]',
    )
  })

  it('pg — LIMIT, "-квотирование', () => {
    expect(pgCatalog.buildSampleSql({ schema: 'public', table: 'T', columns: [], limit: 10 })).toBe(
      'SELECT * FROM "public"."T" LIMIT 10',
    )
    expect(pgCatalog.buildSampleSql({ schema: null, table: 'T', columns: ['a'], limit: 3 })).toBe(
      'SELECT "a" FROM "T" LIMIT 3',
    )
  })

  it('ora — FETCH FIRST', () => {
    expect(oraCatalog.buildSampleSql({ schema: 'SC', table: 'T', columns: [], limit: 10 })).toBe(
      'SELECT * FROM "SC"."T" FETCH FIRST 10 ROWS ONLY',
    )
  })

  it('fb — FIRST, schema игнорируется', () => {
    expect(fbCatalog.buildSampleSql({ schema: 'ignored', table: 'T', columns: [], limit: 10 })).toBe(
      'SELECT FIRST 10 * FROM "T"',
    )
    expect(fbCatalog.buildSampleSql({ schema: null, table: 'T', columns: ['a'], limit: 5 })).toBe(
      'SELECT FIRST 5 "a" FROM "T"',
    )
  })
})
