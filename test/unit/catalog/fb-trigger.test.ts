import { describe, it, expect } from 'vitest'
import { fbTrigger } from '../../../src/catalog/fb.js'

describe('fbTrigger (декодирование RDB$TRIGGER_TYPE, Firebird 3+)', () => {
  it('одиночные события: before/after insert/update/delete', () => {
    expect(fbTrigger(1)).toEqual({ timing: 'before', events: ['insert'] })
    expect(fbTrigger(2)).toEqual({ timing: 'after', events: ['insert'] })
    expect(fbTrigger(3)).toEqual({ timing: 'before', events: ['update'] })
    expect(fbTrigger(4)).toEqual({ timing: 'after', events: ['update'] })
    expect(fbTrigger(5)).toEqual({ timing: 'before', events: ['delete'] })
    expect(fbTrigger(6)).toEqual({ timing: 'after', events: ['delete'] })
  })

  it('INSERT OR UPDATE: 17 before, 18 after', () => {
    expect(fbTrigger(17)).toEqual({ timing: 'before', events: ['insert', 'update'] })
    expect(fbTrigger(18)).toEqual({ timing: 'after', events: ['insert', 'update'] })
  })

  it('порядок событий важен: UPDATE OR INSERT (11) ≠ INSERT OR UPDATE (17)', () => {
    expect(fbTrigger(11)).toEqual({ timing: 'before', events: ['update', 'insert'] })
    expect(fbTrigger(17)).toEqual({ timing: 'before', events: ['insert', 'update'] })
  })

  it('INSERT OR DELETE: 25 before, 26 after', () => {
    expect(fbTrigger(25)).toEqual({ timing: 'before', events: ['insert', 'delete'] })
    expect(fbTrigger(26)).toEqual({ timing: 'after', events: ['insert', 'delete'] })
  })

  it('все три события: 113 before, 114 after', () => {
    expect(fbTrigger(113)).toEqual({ timing: 'before', events: ['insert', 'update', 'delete'] })
    expect(fbTrigger(114)).toEqual({ timing: 'after', events: ['insert', 'update', 'delete'] })
  })

  it('неизвестное значение (type=0) даёт безопасный fallback: after + пустые events', () => {
    // Согласовано с решением владельца 13: неизвестный тип не ломает разбор.
    expect(fbTrigger(0)).toEqual({ timing: 'after', events: [] })
  })
})
