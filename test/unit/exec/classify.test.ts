import { describe, it, expect } from 'vitest'
import { isReadOnlyStatement, splitStatements, firstStatementIsWrite, tailHasWrite } from '../../../src/exec/classify.js'

describe('isReadOnlyStatement', () => {
  it('SELECT → true', () => {
    expect(isReadOnlyStatement('SELECT 1')).toBe(true)
  })

  it('WITH → true', () => {
    expect(isReadOnlyStatement('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true)
  })

  it('SELECT … INTO → false (пишет)', () => {
    expect(isReadOnlyStatement('SELECT * INTO new_t FROM src')).toBe(false)
  })

  it('WITH data-modifying CTE → false (пишет)', () => {
    expect(isReadOnlyStatement('WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT 1 FROM x)')).toBe(false)
    expect(isReadOnlyStatement('WITH x AS (SELECT 1) UPDATE t SET a = 1')).toBe(false)
  })

  it('ведущие комментарии пропускаются', () => {
    expect(isReadOnlyStatement('  -- comment\nSELECT 1')).toBe(true)
    expect(isReadOnlyStatement('/* c */ SELECT 1')).toBe(true)
  })

  it('EXPLAIN → true (только план)', () => {
    expect(isReadOnlyStatement('EXPLAIN SELECT * FROM t')).toBe(true)
  })

  it('EXPLAIN ANALYZE DML → false (реально выполняет)', () => {
    expect(isReadOnlyStatement('EXPLAIN ANALYZE DELETE FROM t')).toBe(false)
    expect(isReadOnlyStatement('EXPLAIN ANALYZE UPDATE t SET a = 1')).toBe(false)
  })

  it('INSERT → false', () => {
    expect(isReadOnlyStatement('INSERT INTO t VALUES (1)')).toBe(false)
  })

  it('пусто / только комментарии → true (не пишет)', () => {
    expect(isReadOnlyStatement('')).toBe(true)
    expect(isReadOnlyStatement('  -- nothing')).toBe(true)
  })
})

describe('splitStatements', () => {
  it('разбивает по ;', () => {
    expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', ' SELECT 2'])
  })

  it('не разбивает ; внутри строкового литерала', () => {
    expect(splitStatements("SELECT 'a;b'; SELECT 2")).toEqual(["SELECT 'a;b'", ' SELECT 2'])
  })

  it('не разбивает ; внутри -- комментария (до конца строки)', () => {
    expect(splitStatements('SELECT 1 -- ;\n; SELECT 2')).toEqual(['SELECT 1 -- ;\n', ' SELECT 2'])
  })

  it('пустые хвосты отбрасываются', () => {
    expect(splitStatements('SELECT 1; ')).toEqual(['SELECT 1'])
  })
})

describe('firstStatementIsWrite / tailHasWrite', () => {
  it('firstStatementIsWrite', () => {
    expect(firstStatementIsWrite('INSERT INTO t VALUES (1)')).toBe(true)
    expect(firstStatementIsWrite('SELECT 1')).toBe(false)
  })

  it('tailHasWrite: SELECT; INSERT → true', () => {
    expect(tailHasWrite('SELECT 1; INSERT INTO t VALUES (1)')).toBe(true)
  })

  it('tailHasWrite: SELECT; SELECT → false', () => {
    expect(tailHasWrite('SELECT 1; SELECT 2')).toBe(false)
  })

  it('tailHasWrite: один оператор → false', () => {
    expect(tailHasWrite('INSERT INTO t VALUES (1)')).toBe(false)
  })
})
