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
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new ServerError('invalid_argument', `параметр "${name}": as="date" требует строку или число`)
      }
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) {
        throw new ServerError('invalid_argument', `параметр "${name}": неверная дата "${String(value)}"`)
      }
      return d
    }
    case 'bigint': {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
        throw new ServerError('invalid_argument', `параметр "${name}": as="bigint" требует строку, число или bigint`)
      }
      try {
        return BigInt(value)
      } catch {
        throw new ServerError('invalid_argument', `параметр "${name}": неверное целое "${String(value)}"`)
      }
    }
    case 'binary_base64': {
      if (typeof value !== 'string') {
        throw new ServerError('invalid_argument', `параметр "${name}": as="binary_base64" требует строку base64`)
      }
      // Нормализуем url-safe и допускаем отсутствие паддинга; валидируем уже
      // дополненную строку, чтобы отсечь остаточные случаи «a=» / «==».
      const norm = value.trim().replace(/-/g, '+').replace(/_/g, '/')
      const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4)
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) {
        throw new ServerError('invalid_argument', `параметр "${name}": неверный base64`)
      }
      return Buffer.from(padded, 'base64')
    }
  }
}
