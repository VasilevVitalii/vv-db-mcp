import { readFile, stat } from 'node:fs/promises'

/**
 * Разбор файла секретов `key=value` (раздел 3.4 ТЗ):
 * - всё до первого `=` — ключ, остаток (включая дальнейшие `=`) — значение;
 * - строка, начинающаяся с `#`, — комментарий;
 * - строка без `=` — игнорируется; пустые строки пропускаются;
 * - имена и значения не обрезаются; повторяющийся ключ — last-wins.
 */
export function parseSecrets(content: string): Map<string, string> {
  // UTF-8 BOM в начале файла срезается: иначе первый ключ получает U+FEFF
  // и не совпадает ни с одним ожидаемым именем.
  const src = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  const map = new Map<string, string>()
  for (const line of src.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    map.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return map
}

/** true, если файл читается группой или всеми (read-биты group/other). */
function isWorldReadable(mode: number): boolean {
  return (mode & 0o044) !== 0
}

export interface SecretsLoadResult {
  map: Map<string, string>
  /** Предупреждение о правах доступа; undefined — всё в порядке. */
  warning?: string
}

export async function loadSecretsFile(path: string): Promise<SecretsLoadResult> {
  const [content, st] = await Promise.all([readFile(path, 'utf8'), stat(path)])
  const map = parseSecrets(content)
  let warning: string | undefined
  // На Windows нет POSIX-прав: stat().mode всегда содержит group/other read-биты,
  // поэтому предупреждение было бы ложным почти всегда (см. .ai/.agreed.md п.14).
  if (process.platform !== 'win32' && isWorldReadable(st.mode)) {
    warning = `файл секретов ${path} читается группой или всеми; рекомендуется chmod 600`
  }
  return { map, warning }
}
