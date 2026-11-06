import type { DbConnection, TDbKind } from 'vv-db-connection'
import type { ResolvedLimits } from '../config/schema.js'
import type { LoadedConnection } from '../config/load.js'
import { ServerError } from '../errors/map.js'

export interface Entry {
  name: string
  kind: TDbKind
  db: DbConnection
  title: string
  user: string
  description?: string
  limits: ResolvedLimits
}

export class ConnectionRegistry {
  private readonly entries: Entry[]
  /** Глобальный список значений секретов для маскирования в ошибках/логах. */
  readonly secrets: readonly string[]

  constructor(loaded: LoadedConnection[], maskSecrets: readonly string[]) {
    this.entries = loaded.map((c) => ({
      name: c.name,
      kind: c.kind,
      db: c.db,
      title: c.title,
      user: c.user,
      description: c.description,
      limits: c.limits,
    }))
    this.secrets = maskSecrets
  }

  get(name: string): Entry {
    let found = this.entries.find((e) => e.name === name)
    if (!found) {
      // Регистронезависимый fallback для удобства: 'prod' находит 'Prod'.
      // При нескольких ci-совпадениях не угадываем — остаётся unknown_connection.
      const ci = this.entries.filter((e) => e.name.toLowerCase() === name.toLowerCase())
      if (ci.length === 1) found = ci[0]
    }
    if (!found) {
      const names = this.entries.map((e) => e.name).join(', ')
      throw new ServerError('unknown_connection', `неизвестное подключение: ${name}; доступны: ${names}`)
    }
    return found
  }

  list(): Entry[] {
    return this.entries
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(this.entries.map((e) => e.db.close()))
  }
}
