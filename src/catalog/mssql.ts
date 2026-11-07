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
import { baseTypeName, queryRows, quoteIdentifier, typeCategory } from './common.js'

const p = (name: string, value: unknown): TDbParam => ({ name, value })
const S = (r: Record<string, unknown>, k: string): string | null => (r[k] == null ? null : String(r[k]))
const B = (r: Record<string, unknown>, k: string): boolean => r[k] === true || r[k] === 1 || r[k] === '1'
const N = (r: Record<string, unknown>, k: string): number | null => (r[k] == null ? null : Number(r[k]))

const NON_SYSTEM = `(s.name NOT IN ('sys','INFORMATION_SCHEMA') AND s.name NOT LIKE 'db[_]%')`

/** Длина строкового/бинарного столбца: null для LOB/max; для n*-типов — символы. */
function mssqlLength(dataType: string, maxLength: number | null): number | null {
  if (maxLength == null || maxLength === -1) return null
  if (['text', 'ntext', 'image'].includes(dataType)) return null
  if (dataType === 'nchar' || dataType === 'nvarchar') return Math.floor(maxLength / 2)
  return maxLength
}

function refAction(desc: string | null): ReferentialAction {
  switch (desc) {
    case 'CASCADE':
      return 'CASCADE'
    case 'SET_NULL':
      return 'SET NULL'
    case 'SET_DEFAULT':
      return 'SET DEFAULT'
    default:
      return 'NO ACTION'
  }
}

export const mssqlCatalog: CatalogAdapter = {
  async listSchemas(db, o) {
    const rows = await queryRows(
      db,
      `SELECT s.name AS name FROM sys.schemas s WHERE ${NON_SYSTEM} ORDER BY s.name`,
      [],
      o,
    )
    return rows.map((r) => String(r.name))
  },

  async listTables(db, o) {
    const schemaClause = o.schema !== undefined ? 'AND s.name = :schema' : `AND ${NON_SYSTEM}`
    const rows = await queryRows(
      db,
      `SELECT s.name AS schema_name, t.name AS name,
              CAST(ep.value AS nvarchar(4000)) AS comment
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       LEFT JOIN sys.extended_properties ep
         ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
       WHERE 1=1 ${schemaClause}`,
      o.schema !== undefined ? [p('schema', o.schema)] : [],
      o,
    )
    const out: TableRef[] = []
    for (const r of rows) out.push({ schema: S(r, 'schema_name'), name: String(r.name), comment: S(r, 'comment') })
    return out
  },

  async listViews(db, o) {
    const schemaClause = o.schema !== undefined ? 'AND s.name = :schema' : `AND ${NON_SYSTEM}`
    const rows = await queryRows(
      db,
      `SELECT s.name AS schema_name, v.name AS name,
              CAST(ep.value AS nvarchar(4000)) AS comment
       FROM sys.views v
       JOIN sys.schemas s ON s.schema_id = v.schema_id
       LEFT JOIN sys.extended_properties ep
         ON ep.major_id = v.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
       WHERE 1=1 ${schemaClause}`,
      o.schema !== undefined ? [p('schema', o.schema)] : [],
      o,
    )
    const out: TableRef[] = []
    for (const r of rows) out.push({ schema: S(r, 'schema_name'), name: String(r.name), comment: S(r, 'comment') })
    return out
  },

  async describeTable(db, o) {
    const schema = o.schema ?? 'dbo'
    const [head, cols, pk] = await Promise.all([
      queryRows(
        db,
        `SELECT o.type AS object_type, CAST(ep.value AS nvarchar(4000)) AS comment
         FROM sys.objects o
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         LEFT JOIN sys.extended_properties ep
           ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
         WHERE o.name = :table AND s.name = :schema`,
        [p('table', o.table), p('schema', schema)],
        o,
      ),
      queryRows(
        db,
        `SELECT c.column_id AS position, c.name AS name, ty.name AS data_type,
                c.max_length AS max_length, c.precision AS precision, c.scale AS scale,
                c.is_nullable AS is_nullable, dc.definition AS default_value,
                CAST(ep.value AS nvarchar(4000)) AS comment
         FROM sys.columns c
         JOIN sys.types ty ON ty.user_type_id = c.user_type_id
         JOIN sys.objects o ON o.object_id = c.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
         LEFT JOIN sys.extended_properties ep
           ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
         WHERE o.name = :table AND s.name = :schema
         ORDER BY c.column_id`,
        [p('table', o.table), p('schema', schema)],
        o,
      ),
      queryRows(
        db,
        `SELECT c.name AS name
         FROM sys.index_columns ic
         JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         JOIN sys.objects o ON o.object_id = ic.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE i.is_primary_key = 1 AND o.name = :table AND s.name = :schema
         ORDER BY ic.key_ordinal`,
        [p('table', o.table), p('schema', schema)],
        o,
      ),
    ])

    const objType = head.length > 0 ? S(head[0]!, 'object_type') : null
    const objectType: 'table' | 'view' = objType === 'V' ? 'view' : 'table'
    const comment = head.length > 0 ? S(head[0]!, 'comment') : null
    const pkNames = pk.map((r) => String(r.name))

    const columns: ColumnInfo[] = cols.map((r) => {
      const dataType = baseTypeName(String(r.data_type))
      const cat = typeCategory('mssql', dataType)
      const isStrBin = cat === 'string' || cat === 'binary'
      return {
        position: N(r, 'position') ?? 0,
        name: String(r.name),
        dataType,
        typeCategory: cat,
        length: isStrBin ? mssqlLength(dataType, N(r, 'max_length')) : null,
        precision: cat === 'decimal' ? N(r, 'precision') : null,
        scale: cat === 'decimal' ? N(r, 'scale') : null,
        nullable: B(r, 'is_nullable'),
        defaultValue: S(r, 'default_value'),
        isPrimaryKey: pkNames.includes(String(r.name)),
        comment: S(r, 'comment'),
      }
    })

    const desc: TableDescription = {
      // Возвращаем фактически прочитанную схему (o.schema ?? 'dbo'), а не входной
      // аргумент: при schema = null запрос читал 'dbo', и ответ не должен говорить null.
      schema,
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
    if (o.schema !== undefined && o.table !== undefined) {
      // Пара сторон: иначе FK для A.X вернёт и FK между B.X и A.Y (кросс-схемное ложное срабатывание).
      filters.push('((s1.name = :schema AND t1.name = :table) OR (s2.name = :schema AND t2.name = :table))')
      params.push(p('schema', o.schema), p('table', o.table))
    } else if (o.schema !== undefined) {
      filters.push('(s1.name = :schema OR s2.name = :schema)')
      params.push(p('schema', o.schema))
    } else if (o.table !== undefined) {
      filters.push('(t1.name = :table OR t2.name = :table)')
      params.push(p('table', o.table))
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''

    const [meta, cols] = await Promise.all([
      queryRows(
        db,
        `SELECT fk.name AS name, s1.name AS schema_name, t1.name AS table_name,
                s2.name AS referenced_schema, t2.name AS referenced_table,
                fk.delete_referential_action_desc AS on_delete,
                fk.update_referential_action_desc AS on_update
         FROM sys.foreign_keys fk
         JOIN sys.tables t1 ON t1.object_id = fk.parent_object_id
         JOIN sys.schemas s1 ON s1.schema_id = t1.schema_id
         JOIN sys.tables t2 ON t2.object_id = fk.referenced_object_id
         JOIN sys.schemas s2 ON s2.schema_id = t2.schema_id
         ${where}`,
        params,
        o,
      ),
      queryRows(
        db,
        `SELECT fk.name AS name, s1.name AS schema_name, t1.name AS table_name,
                pc.name AS column_name, rc.name AS referenced_column
         FROM sys.foreign_key_columns fkc
         JOIN sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
         JOIN sys.tables t1 ON t1.object_id = fkc.parent_object_id
         JOIN sys.schemas s1 ON s1.schema_id = t1.schema_id
         JOIN sys.tables t2 ON t2.object_id = fkc.referenced_object_id
         JOIN sys.schemas s2 ON s2.schema_id = t2.schema_id
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
         ${where}
         ORDER BY fkc.constraint_column_id`,
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
    const schema = o.schema ?? 'dbo'
    const rows = await queryRows(
      db,
      `SELECT i.name AS name, i.is_unique AS is_unique, i.is_primary_key AS is_primary,
              c.name AS column_name, ic.is_descending_key AS is_descending
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       LEFT JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       JOIN sys.objects o ON o.object_id = i.object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.name = :table AND s.name = :schema AND ic.is_included_column = 0
       ORDER BY i.name, ic.key_ordinal`,
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
      idx.columns.push({ name: S(r, 'column_name'), descending: B(r, 'is_descending') })
    }
    return [...map.values()]
  },

  async listConstraints(db, o) {
    const schema = o.schema ?? 'dbo'
    const out: ConstraintInfo[] = []
    const want = o.type

    if (want === undefined || want === 'primary_key' || want === 'unique') {
      const rows = await queryRows(
        db,
        `SELECT kc.name AS name, kc.type AS type, c.name AS column_name
         FROM sys.key_constraints kc
         JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         JOIN sys.objects o ON o.object_id = kc.parent_object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE o.name = :table AND s.name = :schema AND kc.type IN ('PK','UQ')
         ORDER BY kc.name, ic.key_ordinal`,
        [p('table', o.table), p('schema', schema)],
        o,
      )
      const map = new Map<string, ConstraintInfo>()
      for (const r of rows) {
        const name = String(r.name)
        const type = String(r.type) === 'PK' ? ('primary_key' as const) : ('unique' as const)
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
        `SELECT cc.name AS name, cc.definition AS expression
         FROM sys.check_constraints cc
         JOIN sys.objects o ON o.object_id = cc.parent_object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE o.name = :table AND s.name = :schema
         ORDER BY cc.name`,
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
        ? "AND o.type = 'P'"
        : o.kind === 'function'
          ? "AND o.type IN ('FN','IF','TF')"
          : "AND o.type IN ('P','FN','IF','TF')"
    const schemaClause = o.schema !== undefined ? 'AND s.name = :schema' : `AND ${NON_SYSTEM}`
    const rows = await queryRows(
      db,
      `SELECT s.name AS schema_name, o.name AS name, o.type AS type
       FROM sys.objects o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE 1=1 ${kindClause} ${schemaClause} AND o.is_ms_shipped = 0`,
      o.schema !== undefined ? [p('schema', o.schema)] : [],
      o,
    )
    const out: RoutineRef[] = []
    for (const r of rows) {
      const type = String(r.type).trim()
      out.push({
        schema: S(r, 'schema_name'),
        name: String(r.name),
        kind: type === 'P' ? 'procedure' : 'function',
      })
    }
    return out
  },

  async listTriggers(db, o) {
    const schemaClause = o.schema !== undefined ? 'AND s.name = :schema' : ''
    const tableClause = o.table !== undefined ? 'AND t.name = :table' : ''
    const params: TDbParam[] = []
    if (o.schema !== undefined) params.push(p('schema', o.schema))
    if (o.table !== undefined) params.push(p('table', o.table))

    const [meta, events] = await Promise.all([
      queryRows(
        db,
        `SELECT s.name AS schema_name, tr.name AS name, t.name AS table_name,
                tr.is_disabled AS is_disabled, tr.is_instead_of_trigger AS is_instead_of
         FROM sys.triggers tr
         JOIN sys.tables t ON t.object_id = tr.parent_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         WHERE 1=1 ${schemaClause} ${tableClause}`,
        params,
        o,
      ),
      queryRows(
        db,
        `SELECT s.name AS schema_name, tr.name AS name, te.type AS event_type
         FROM sys.trigger_events te
         JOIN sys.triggers tr ON tr.object_id = te.object_id
         JOIN sys.tables t ON t.object_id = tr.parent_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         WHERE 1=1 ${schemaClause} ${tableClause}`,
        params,
        o,
      ),
    ])

    const evMap = new Map<string, Array<'insert' | 'update' | 'delete'>>()
    for (const r of events) {
      const key = `${String(r.schema_name)}.${String(r.name)}`
      const t = Number(r.event_type)
      let arr = evMap.get(key)
      if (!arr) {
        arr = []
        evMap.set(key, arr)
      }
      if (t === 1) arr.push('insert')
      else if (t === 2) arr.push('update')
      else if (t === 3) arr.push('delete')
    }

    const out: TriggerInfo[] = []
    for (const r of meta) {
      const name = String(r.name)
      const key = `${String(r.schema_name)}.${name}`
      out.push({
        schema: S(r, 'schema_name'),
        name,
        table: String(r.table_name),
        timing: B(r, 'is_instead_of') ? 'instead_of' : 'after',
        events: evMap.get(key) ?? [],
        enabled: !B(r, 'is_disabled'),
      })
    }
    return out
  },

  async listSequences(db, o) {
    const schemaClause = o.schema !== undefined ? 'AND s.name = :schema' : `AND ${NON_SYSTEM}`
    const rows = await queryRows(
      db,
      `SELECT s.name AS schema_name, seq.name AS name
       FROM sys.sequences seq
       JOIN sys.schemas s ON s.schema_id = seq.schema_id
       WHERE 1=1 ${schemaClause}`,
      o.schema !== undefined ? [p('schema', o.schema)] : [],
      o,
    )
    const out: SequenceRef[] = []
    for (const r of rows) out.push({ schema: S(r, 'schema_name'), name: String(r.name) })
    return out
  },

  async getDefinitions(db, o) {
    const typeClause: Record<string, string> = {
      view: "o.type = 'V'",
      procedure: "o.type = 'P'",
      function: "o.type IN ('FN','IF','TF')",
      trigger: "o.type = 'TR'",
    }
    const tableClause = o.objectType === 'trigger' && o.table !== undefined ? 'AND t.name = :table' : ''
    const schemaClause = o.schema !== undefined ? 'AND s.name = :schema' : `AND ${NON_SYSTEM}`
    const params: TDbParam[] = [p('name', o.name)]
    if (o.schema !== undefined) params.push(p('schema', o.schema))
    if (o.objectType === 'trigger' && o.table !== undefined) params.push(p('table', o.table))

    const rows = await queryRows(
      db,
      `SELECT s.name AS schema_name, o.name AS name, o.type AS type,
              m.definition AS definition, t.name AS table_name
       FROM sys.objects o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id
       LEFT JOIN sys.tables t ON t.object_id = o.parent_object_id
       WHERE ${typeClause[o.objectType]} AND o.name = :name ${schemaClause} ${tableClause}`,
      params,
      o,
    )
    const out: DefinitionInfo[] = []
    for (const r of rows) {
      out.push({
        schema: S(r, 'schema_name'),
        name: String(r.name),
        table: S(r, 'table_name'),
        objectType: o.objectType,
        definition: S(r, 'definition'),
        definitionKind: 'full',
      })
    }
    return out
  },

  buildSampleSql(o) {
    const cols = o.columns.length > 0 ? o.columns.map((c) => quoteIdentifier('mssql', c)).join(', ') : '*'
    const qual = o.schema
      ? `${quoteIdentifier('mssql', o.schema)}.${quoteIdentifier('mssql', o.table)}`
      : quoteIdentifier('mssql', o.table)
    return `SELECT TOP (${o.limit}) ${cols} FROM ${qual}`
  },
}
