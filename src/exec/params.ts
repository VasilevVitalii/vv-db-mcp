import type { TDbParam } from 'vv-db-connection'
import type { Param } from '../tools/schemas.js'
import { ServerError } from '../errors/map.js'

/**
 * Входные `Param` → `TDbParam[]` пакета (раздел 5 ТЗ).
 * `as` превращает JSON-значение в JS-значение до отправки; неверное значение
 * даёт `invalid_argument`, а не `internal` (SyntaxError/Invalid Date не уходят в драйвер).
 */
export function toDbParams(params: Param[]): TDbParam[] {
  return params.map((p) => {
    const out: TDbParam = { name: p.name }
    if (p.type !== undefined) out.type = p.type
    if (p.direction !== undefined) out.direction = p.direction
    if (p.as !== undefined) out.value = convertValue(p.as, p.value, p.name)
    else if (p.value !== undefined) out.value = p.value
    return out
  })
}

function convertValue(as: 'date' | 'bigint' | 'binary_base64', value: unknown, name: string): unknown {
  if (value === undefined || value === null) {
    throw new ServerError('invalid_argument', `параметр "${name}": as="${as}" требует value`)
  }
  switch (as) {
    case 'date': {
      const d = new Date(value as string | number)
      if (Number.isNaN(d.getTime())) {
        throw new ServerError('invalid_argument', `параметр "${name}": неверная дата "${String(value)}"`)
      }
      return d
    }
    case 'bigint': {
      try {
        return BigInt(value as string | number | bigint)
      } catch {
        throw new ServerError('invalid_argument', `параметр "${name}": неверное целое "${String(value)}"`)
      }
    }
    case 'binary_base64': {
      if (typeof value !== 'string') {
        throw new ServerError('invalid_argument', `параметр "${name}": as="binary_base64" требует строку base64`)
      }
      // Buffer.from не бросает на мусоре — проверяем round-trip.
      const b = Buffer.from(value, 'base64')
      if (b.toString('base64') !== value.replace(/\s/g, '')) {
        throw new ServerError('invalid_argument', `параметр "${name}": неверный base64`)
      }
      return b
    }
  }
}
