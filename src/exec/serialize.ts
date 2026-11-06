/** Настройки сериализации ячеек (лимиты maxCellChars/maxBinaryBytes). */
export interface SerializeOptions {
  maxCellChars: number
  maxBinaryBytes: number
}

/** Счётчики обрезок для итоговых warnings. */
export class SerializeState {
  truncatedCells = 0
  truncatedBinary = 0
}

/** Сериализация одного значения по разделу 4.4 ТЗ. */
export function serializeValue(v: unknown, opts: SerializeOptions, st: SerializeState): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN'
    if (v === Infinity) return 'Infinity'
    if (v === -Infinity) return '-Infinity'
    return v
  }
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    if (v.length > opts.maxCellChars) {
      st.truncatedCells++
      return v.slice(0, opts.maxCellChars)
    }
    return v
  }
  if (v instanceof Date) {
    const t = v.getTime()
    return Number.isNaN(t) ? null : v.toISOString()
  }
  if (v instanceof Uint8Array) {
    const bytes = v.length
    const keep = Math.min(bytes, opts.maxBinaryBytes)
    const buf = Buffer.isBuffer(v) ? v : Buffer.from(v)
    const base64 = buf.subarray(0, keep).toString('base64')
    if (bytes > keep) st.truncatedBinary++
    return { $base64: base64, bytes, truncated: bytes > keep }
  }
  if (Array.isArray(v)) return v.map((x) => serializeValue(x, opts, st))
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[k] = serializeValue(val, opts, st)
    return out
  }
  return v
}

/** Сериализация строки-объекта `{ имя_столбца: значение }`. */
export function serializeRow(
  row: Record<string, unknown>,
  opts: SerializeOptions,
  st: SerializeState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[k] = serializeValue(v, opts, st)
  return out
}
