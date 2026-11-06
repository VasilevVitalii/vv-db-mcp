import type { TDbParam } from 'vv-db-connection'
import type { Param } from '../tools/schemas.js'

/**
 * Входные `Param` → `TDbParam[]` пакета (раздел 5 ТЗ).
 * `as` превращает JSON-значение в JS-значение до отправки.
 */
export function toDbParams(params: Param[]): TDbParam[] {
  return params.map((p) => {
    const out: TDbParam = { name: p.name }
    if (p.type !== undefined) out.type = p.type
    if (p.direction !== undefined) out.direction = p.direction
    if (p.as !== undefined) out.value = convertValue(p.as, p.value)
    else if (p.value !== undefined) out.value = p.value
    return out
  })
}

function convertValue(as: 'date' | 'bigint' | 'binary_base64', value: unknown): unknown {
  switch (as) {
    case 'date':
      return new Date(value as string | number)
    case 'bigint':
      return BigInt(value as string | number)
    case 'binary_base64':
      return Buffer.from(value as string, 'base64')
  }
}
