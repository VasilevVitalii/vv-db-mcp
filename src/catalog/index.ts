import type { TDbKind } from 'vv-db-connection'
import type { CatalogAdapter } from './types.js'
import { mssqlCatalog } from './mssql.js'
import { pgCatalog } from './pg.js'
import { oraCatalog } from './ora.js'
import { fbCatalog } from './fb.js'

const catalogs: Record<TDbKind, CatalogAdapter> = {
  mssql: mssqlCatalog,
  pg: pgCatalog,
  ora: oraCatalog,
  fb: fbCatalog,
}

export function getCatalog(kind: TDbKind): CatalogAdapter {
  return catalogs[kind]
}
