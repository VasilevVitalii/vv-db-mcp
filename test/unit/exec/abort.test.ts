import { describe, it, expect } from 'vitest'
import { linkSignals } from '../../../src/exec/abort.js'

describe('linkSignals', () => {
  it('аборт источника абортирует цель с тем же reason', () => {
    const src = new AbortController()
    const tgt = new AbortController()
    linkSignals(src.signal, tgt)
    src.abort('reason-x')
    expect(tgt.signal.aborted).toBe(true)
    expect(tgt.signal.reason).toBe('reason-x')
  })

  it('уже прерванный источник — цель прерывается сразу', () => {
    const src = new AbortController()
    src.abort('r')
    const tgt = new AbortController()
    linkSignals(src.signal, tgt)
    expect(tgt.signal.aborted).toBe(true)
    expect(tgt.signal.reason).toBe('r')
  })

  it('отписка отключает связь', () => {
    const src = new AbortController()
    const tgt = new AbortController()
    const unlink = linkSignals(src.signal, tgt)
    unlink()
    src.abort()
    expect(tgt.signal.aborted).toBe(false)
  })
})
