import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * src использует NodeNext (относительные импорты с расширением .js, указывающие
 * на .ts-источники). Vite их не резолвит сам — плагин переписывает такой импорт
 * в абсолютный путь к .ts, если файл существует.
 */
function jsToTs(): Plugin {
  return {
    name: 'vv-db-mcp:js-to-ts',
    enforce: 'pre',
    resolveId(source, importer) {
      if ((source.startsWith('./') || source.startsWith('../')) && source.endsWith('.js')) {
        const base = importer ? dirname(importer) : process.cwd()
        const ts = source.slice(0, -3) + '.ts'
        const resolved = resolve(base, ts)
        if (existsSync(resolved)) return resolved
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [jsToTs()],
  test: {
    include: ['test/**/*.test.ts'],
    // интеграционные тесты делят одну фикстуру с фиксированными именами объектов;
    // файлы выполняются последовательно, чтобы beforeAll/afterAll не конфликтовали
    fileParallelism: false,
  },
})
