import type { TDbParam } from 'vv-db-connection'
import type {
  CatalogAdapter,
  ColumnInfo,
  ConstraintInfo,
  DefinitionInfo,
  ForeignKey,
  IndexInfo,
  ReferentialAction,
  RoutineRef,
  SequenceRef,
  TableDescription,
  TableRef,
  TriggerInfo,
} from './types.js'
import { queryRows, quoteIdentifier, typeCategory } from './common.js'

const p = (name: string, value: unknown): TDbParam => ({ name, value })
const S = (r: Record<string, unknown>, k: string): string | null => (r[k] == null ? null : String(r[k]))
const B = (r: Record<string, unknown>, k: string): boolean => r[k] === true || r[k] === 1 || r[k] === '1'
const N = (r: Record<string, unknown>, k: string): number | null => (r[k] == null ? null : Number(r[k]))

const NON_SYSTEM = `(n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg[_]%')`

function refAction(code: string | null): ReferentialAction {
  switch (code) {
    case 'c':
      return 'CASCADE'
    case 'n':
      return 'SET NULL'
    case 'd':
      return 'SET DEFAULT'
    case 'r':
      return 'RESTRICT'
    default:
      return 'NO ACTION'
  }
}

/** Имя типа из information_schema: ARRAY/USER-DEFINED → udt_name. */
function pgDataType(dataType: string, udtName: string | null): string {
  const t = dataType.toLowerCase()
  if (t === 'array' || t === 'user-defined') return (udtName ?? dataType).toLowerCase()
  return t
}

export const pgCatalog: CatalogAdapter = {
  async listSchemas(db, o) {
    const rows = await queryRows(
      db,
      `SELECT n.nspname AS name FROM pg_namespace n WHERE ${NON_SYSTEM} ORDER BY n.nspname`,
      [],
      o,
    )
    return rows.map((r) => String(r.name))
  },

  async listTables(db, o) {
    const schemaClause = o.schema !== undefined ? 'AND n.nspname = :schema' : `AND ${NON_SYSTEM}`
    const rows = await queryRows(
      db,
      `SELECT n.nspname AS schema_name, c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p') ${schemaClause}`,
      o.schema !== undefined ? [p('schema', o.schema)] : [],
      o,
    )
    const out: TableRef[] = []
    for (const r of rows) out.push({ schema: S(r, 'schema_name'), name: String(r.name), comment: S(r, 'comment') })
    return out
  },

  async listViews(db, o) {
    const schemaClause = o.schema !== undefined ? 'AND n.nspname = :schema' : `AND ${NON_SYSTEM}`
    const rows = await queryRows(
      db,
      `SELECT n.nspname AS schema_name, c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('v','m') ${schemaClause}`,
      o.schema !== undefined ? [p('schema', o.schema)] : [],
      o,
    )
    const out: TableRef[] = []
    for (const r of rows) out.push({ schema: S(r, 'schema_name'), name: String(r.name), comment: S(r, 'comment') })
    return out
  },

  async describeTable(db, o) {
    const schema = o.schema ?? 'public'
    const [head, cols, pk, comments] = await Promise.all([
      queryRows(
        db,
        `SELECT c.relkind AS relkind, obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = :table AND n.nspname = :schema`,
        [p('table', o.table), p('schema', schema)],
        o,
      ),
      queryRows(
        db,
        `SELECT a.attnum AS position, a.attname AS name,
                CASE
                  WHEN t.typcategory = 'A' THEN 'ARRAY'
                  WHEN t.typtype IN ('d', 'e') OR t.typcategory = 'C' THEN 'USER-DEFINED'
                  ELSE CASE t.typname
                         WHEN 'varchar' THEN 'character varying'
                         WHEN 'bpchar' THEN 'character'
                         WHEN 'int2' THEN 'smallint'
                         WHEN 'int4' THEN 'integer'
                         WHEN 'int8' THEN 'bigint'
                         WHEN 'float4' THEN 'real'
                         WHEN 'float8' THEN 'double precision'
                         WHEN 'bool' THEN 'boolean'
                         WHEN 'timestamptz' THEN 'timestamp with time zone'
                         WHEN 'timestamp' THEN 'timestamp without time zone'
                         WHEN 'timetz' THEN 'time with time zone'
                         WHEN 'time' THEN 'time without time zone'
                         ELSE t.typname
                       END
                END AS data_type,
                t.typname AS udt_name,
                information_schema._pg_char_max_length(a.atttypid, a.atttypmod) AS char_len,
                information_schema._pg_numeric_precision(a.atttypid, a.atttypmod) AS num_precision,
                information_schema._pg_numeric_scale(a.atttypid, a.atttypmod) AS num_scale,
                CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default_value
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE c.relname = :table AND n.nspname = :schema AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [p('table', o.table), p('schema', schema)],
        o,
      ),
      queryRows(
        db,
        `SELECT a.attname AS name
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
         WHERE c.relname = :table AND n.nspname = :schema AND i.indisprimary
         ORDER BY array_position(i.indkey, a.attnum)`,
        [p('table', o.table), p('schema', schema)],
        o,
      ),
      queryRows(
        db,
        `SELECT a.attname AS name, col_description(a.attrelid, a.attnum) AS comment
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = :table AND n.nspname = :schema AND a.attnum > 0 AND NOT a.attisdropped`,
        [p('table', o.table), p('schema', schema)],
        o,
      ),
    ])

    const relkind = head.length > 0 ? String(head[0]!.relkind) : 'r'
    const objectType: 'table' | 'view' = relkind === 'v' || relkind === 'm' ? 'view' : 'table'
    const comment = head.length > 0 ? S(head[0]!, 'comment') : null
    const pkNames = pk.map((r) => String(r.name))
    const commentMap = new Map<string, string | null>()
    for (const r of comments) commentMap.set(String(r.name), S(r, 'comment'))

    const columns: ColumnInfo[] = cols.map((r) => {
      const dataType = pgDataType(String(r.data_type), S(r, 'udt_name'))
      const cat = typeCategory('pg', dataType)
      return {
        position: N(r, 'position') ?? 0,
        name: String(r.name),
        dataType,
        typeCategory: cat,
        length: cat === 'string' ? N(r, 'char_len') : null,
        precision: cat === 'decimal' ? N(r, 'num_precision') : null,
        scale: cat === 'decimal' ? N(r, 'num_scale') : null,
        nullable: String(r.is_nullable).toUpperCase() === 'YES',
        defaultValue: S(r, 'default_value'),
        isPrimaryKey: pkNames.includes(String(r.name)),
        comment: commentMap.get(String(r.name)) ?? null,
      }
    })

    const desc: TableDescription = {
      schema: o.schema,
      name: o.table,
      objectType,
      comment,
      columns,
      primaryKey: pkNames,
    }
    return desc
  },

  async listForeignKeys(db, o) {
    const filters: string[] = []
    const params: TDbParam[] = []
    if (o.schema !== undefined) {
      filters.push('(n1.nspname = :schema OR n2.nspname = :schema)')
      params.push(p('schema', o.schema))
    }
    if (o.table !== undefined) {
      filters.push('(c1.relname = :table OR c2.relname = :table)')
      params.push(p('table', o.table))
    }
    const fkWhere = `con.contype = 'f'${filters.length > 0 ? ` AND ${filters.join(' AND ')}` : ''}`

    const [meta, cols] = await Promise.all([
      queryRows(
        db,
        `SELECT con.conname AS name,
                n1.nspname AS schema_name, c1.relname AS table_name,
                n2.nspname AS referenced_schema, c2.relname AS referenced_table,
                con.confdeltype AS on_delete, con.confupdtype AS on_update
         FROM pg_constraint con
         JOIN pg_class c1 ON c1.oid = con.conrelid
         JOIN pg_namespace n1 ON n1.oid = c1.relnamespace
         JOIN pg_class c2 ON c2.oid = con.confrelid
         JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
         WHERE ${fkWhere}`,
        params,
        o,
      ),
      queryRows(
        db,
        `SELECT con.conname AS name, n1.nspname AS schema_name, c1.relname AS table_name,
                a1.attname AS column_name, a2.attname AS referenced_column
         FROM pg_constraint con
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(col, refcol, ord)
         JOIN pg_class c1 ON c1.oid = con.conrelid
         JOIN pg_namespace n1 ON n1.oid = c1.relnamespace
         JOIN pg_class c2 ON c2.oid = con.confrelid
         JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
         JOIN pg_attribute a1 ON a1.attrelid = con.conrelid AND a1.attnum = u.col
         JOIN pg_attribute a2 ON a2.attrelid = con.confrelid AND a2.attnum = u.refcol
         WHERE ${fkWhere}
         ORDER BY con.conname, u.ord`,
        params,
        o,
      ),
    ])

    const colMap = new Map<string, { columns: string[]; referencedColumns: string[] }>()
    for (const r of cols) {
      const key = `${String(r.schema_name)}.${String(r.table_name)}.${String(r.name)}`
      let e = colMap.get(key)
      if (!e) {
        e = { columns: [], referencedColumns: [] }
        colMap.set(key, e)
      }
      e.columns.push(String(r.column_name))
      e.referencedColumns.push(String(r.referenced_column))
    }

    const out: ForeignKey[] = []
    for (const r of meta) {
      const name = String(r.name)
      const key = `${String(r.schema_name)}.${String(r.table_name)}.${name}`
      const c = colMap.get(key) ?? { columns: [], referencedColumns: [] }
      out.push({
        name,
        schema: S(r, 'schema_name'),
        table: String(r.table_name),
        columns: c.columns,
        referencedSchema: S(r, 'referenced_schema'),
        referencedTable: String(r.referenced_table),
        referencedColumns: c.referencedColumns,
        onDelete: refAction(S(r, 'on_delete')),
        onUpdate: refAction(S(r, 'on_update')),
      })
    }
    return out
  },

  async listIndexes(db, o) {
    const schema = o.schema ?? 'public'
    const rows = await queryRows(
      db,
      `SELECT i.relname AS name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
              a.attname AS column_name,
              ((u.opt::int & 1) = 1) AS is_desc
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       CROSS JOIN LATERAL unnest(ix.indkey::int2[], ix.indoption::int2[]) WITH ORDINALITY AS u(attnum, opt, ord)
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = u.attnum
       WHERE t.relname = :table AND n.nspname = :schema
       ORDER BY i.relname, u.ord`,
      [p('table', o.table), p('schema', schema)],
      o,
    )

    const map = new Map<string, IndexInfo>()
    for (const r of rows) {
      const name = String(r.name)
      let idx = map.get(name)
      if (!idx) {
        idx = { name, unique: B(r, 'is_unique'), primary: B(r, 'is_primary'), columns: [] }
        map.set(name, idx)
      }
      idx.columns.push({ name: S(r, 'column_name'), descending: B(r, 'is_desc') })
    }
    return [...map.values()]
  },

  async listConstraints(db, o) {
    const schema = o.schema ?? 'public'
    const out: ConstraintInfo[] = []
    const want = o.type

    if (want === undefined || want === 'primary_key' || want === 'unique') {
      const rows = await queryRows(
        db,
        `SELECT con.conname AS name, con.contype AS type, a.attname AS column_name
         FROM pg_constraint con
         JOIN pg_class t ON t.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(col, ord)
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = u.col
         WHERE t.relname = :table AND n.nspname = :schema AND con.contype IN ('p','u')
         ORDER BY con.conname, u.ord`,
        [p('table', o.table), p('schema', schema)],
        o,
      )
      const map = new Map<string, ConstraintInfo>()
      for (const r of rows) {
        const name = String(r.name)
        const type = String(r.type) === 'p' ? ('primary_key' as const) : ('unique' as const)
        let c = map.get(name)
        if (!c) {
          c = { name, type, columns: [], expression: null }
          map.set(name, c)
        }
        c.columns.push(String(r.column_name))
      }
      out.push(...map.values())
    }

    if (want === undefined || want === 'check') {
      const rows = await queryRows(
        db,
        `SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS expression
         FROM pg_constraint con
         JOIN pg_class t ON t.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE t.relname = :table AND n.nspname = :schema AND con.contype = 'c'
         ORDER BY con.conname`,
        [p('table', o.table), p('schema', schema)],
        o,
      )
      for (const r of rows) {
        out.push({
          name: String(r.name),
          type: 'check',
          columns: [],
          expression: S(r, 'expression'),
        })
      }
    }

    return out
  },

  async listRoutines(db, o) {
    const kindClause =
      o.kind === 'procedure'
        ? "AND p.prokind = 'p'"
        : o.kind === 'function'
          ? "AND p.prokind = 'f'"
          : "AND p.prokind IN ('p','f')"
    const schemaClause = o.schema !== undefined ? 'AND n.nspname = :schema' : `AND ${NON_SYSTEM}`
    const rows = await queryRows(
      db,
      `SELECT n.nspname AS schema_name, p.proname AS name, p.prokind AS prokind
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE 1=1 ${kindClause} ${schemaClause}`,
      o.schema !== undefined ? [p('schema', o.schema)] : [],
      o,
    )
    const out: RoutineRef[] = []
    for (const r of rows) {
      out.push({
        schema: S(r, 'schema_name'),
        name: String(r.name),
        kind: String(r.prokind) === 'p' ? 'procedure' : 'function',
      })
    }
    return out
  },

  async listTriggers(db, o) {
    const schemaClause = o.schema !== undefined ? 'AND n.nspname = :schema' : ''
    const tableClause = o.table !== undefined ? 'AND c.relname = :table' : ''
    const params: TDbParam[] = []
    if (o.schema !== undefined) params.push(p('schema', o.schema))
    if (o.table !== undefined) params.push(p('table', o.table))

    const rows = await queryRows(
      db,
      `SELECT n.nspname AS schema_name, t.tgname AS name, c.relname AS table_name,
              t.tgtype AS tgtype, t.tgenabled AS tgenabled
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT t.tgisinternal ${schemaClause} ${tableClause}`,
      params,
      o,
    )

    const out: TriggerInfo[] = []
    for (const r of rows) {
      const tg = Number(r.tgtype)
      const timing = (tg & 2) !== 0 ? ('before' as const) : (tg & 64) !== 0 ? ('instead_of' as const) : ('after' as const)
      const events: Array<'insert' | 'update' | 'delete'> = []
      if ((tg & 4) !== 0) events.push('insert')
      if ((tg & 16) !== 0) events.push('update')
      if ((tg & 8) !== 0) events.push('delete')
      out.push({
        schema: S(r, 'schema_name'),
        name: String(r.name),
        table: String(r.table_name),
        timing,
        events,
        enabled: String(r.tgenabled) !== 'D',
      })
    }
    return out
  },

  async listSequences(db, o) {
    const schemaClause = o.schema !== undefined ? 'AND n.nspname = :schema' : `AND ${NON_SYSTEM}`
    const rows = await queryRows(
      db,
      `SELECT n.nspname AS schema_name, c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'S' ${schemaClause}`,
      o.schema !== undefined ? [p('schema', o.schema)] : [],
      o,
    )
    const out: SequenceRef[] = []
    for (const r of rows) out.push({ schema: S(r, 'schema_name'), name: String(r.name) })
    return out
  },

  async getDefinitions(db, o) {
    let sql: string
    const params: TDbParam[] = [p('name', o.name)]
    if (o.schema !== undefined) params.push(p('schema', o.schema))
    const schemaClause = o.schema !== undefined ? 'AND n.nspname = :schema' : ''

    switch (o.objectType) {
      case 'view':
        sql = `SELECT n.nspname AS schema_name, c.relname AS name, pg_get_viewdef(c.oid, true) AS definition
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.relkind IN ('v','m') AND c.relname = :name ${schemaClause}`
        break
      case 'procedure':
      case 'function': {
        const kindClause = o.objectType === 'procedure' ? "p.prokind = 'p'" : "p.prokind = 'f'"
        sql = `SELECT n.nspname AS schema_name, p.proname AS name, pg_get_functiondef(p.oid) AS definition
               FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE ${kindClause} AND p.proname = :name ${schemaClause}`
        break
      }
      case 'trigger': {
        const tableClause = o.table !== undefined ? 'AND c.relname = :table' : ''
        if (o.table !== undefined) params.push(p('table', o.table))
        sql = `SELECT n.nspname AS schema_name, t.tgname AS name, c.relname AS table_name,
                      pg_get_triggerdef(t.oid) AS definition
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE NOT t.tgisinternal AND t.tgname = :name ${schemaClause} ${tableClause}`
        break
      }
    }

    const rows = await queryRows(db, sql, params, o)
    const out: DefinitionInfo[] = []
    for (const r of rows) {
      out.push({
        schema: S(r, 'schema_name'),
        name: String(r.name),
        table: S(r, 'table_name'),
        objectType: o.objectType,
        definition: S(r, 'definition'),
        definitionKind: o.objectType === 'view' ? 'body' : 'full',
      })
    }
    return out
  },

  buildSampleSql(o) {
    const cols = o.columns.length > 0 ? o.columns.map((c) => quoteIdentifier('pg', c)).join(', ') : '*'
    const qual = o.schema
      ? `${quoteIdentifier('pg', o.schema)}.${quoteIdentifier('pg', o.table)}`
      : quoteIdentifier('pg', o.table)
    return `SELECT ${cols} FROM ${qual} LIMIT ${o.limit}`
  },
}
