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

/** Сериализация одного значения по разделу 4.4 ТЗ.
 *  `seen` защищает от циклических ссылок (иначе рекурсия дала бы переполнение стека). */
export function serializeValue(
  v: unknown,
  opts: SerializeOptions,
  st: SerializeState,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
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
      // Обрезка по UTF-16 code units может разрезать суррогатную пару (эмодзи и т.п.)
      // — убираем «хвостовой» высокий суррогат, чтобы не выдать битый символ.
      const cut = v.slice(0, opts.maxCellChars)
      return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
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
  if (v instanceof Map) {
    if (seen.has(v)) return '[Circular]'
    seen.add(v)
    try {
      const out: Record<string, unknown> = {}
      for (const [k, val] of v) out[String(k)] = serializeValue(val, opts, st, seen)
      return out
    } finally {
      seen.delete(v)
    }
  }
  if (v instanceof Set) {
    if (seen.has(v)) return '[Circular]'
    seen.add(v)
    try {
      return [...v].map((x) => serializeValue(x, opts, st, seen))
    } finally {
      seen.delete(v)
    }
  }
  if (typeof v === 'object' && v !== null && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
    // Decimal-подобные типы драйверов: сериализуем через toJSON, а не дамп внутренних полей.
    // seen-проверка до вызова: toJSON() может вернуть this (защита от зацикливания).
    if (seen.has(v)) return '[Circular]'
    seen.add(v)
    try {
      return serializeValue((v as { toJSON: () => unknown }).toJSON(), opts, st, seen)
    } finally {
      seen.delete(v)
    }
  }
  if (Array.isArray(v)) {
    if (seen.has(v)) return '[Circular]'
    seen.add(v)
    try {
      return v.map((x) => serializeValue(x, opts, st, seen))
    } finally {
      seen.delete(v)
    }
  }
  if (typeof v === 'object') {
    if (seen.has(v)) return '[Circular]'
    seen.add(v)
    try {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) out[k] = serializeValue(val, opts, st, seen)
      return out
    } finally {
      seen.delete(v)
    }
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
