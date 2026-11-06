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
// oracledb возвращает имена колонок в верхнем регистре — поиск ключа без учёта регистра.
const ci = (r: Record<string, unknown>, k: string): unknown => r[k] ?? r[k.toUpperCase()] ?? r[k.toLowerCase()]
const S = (r: Record<string, unknown>, k: string): string | null => {
  const v = ci(r, k)
  return v == null ? null : String(v)
}
const N = (r: Record<string, unknown>, k: string): number | null => {
  const v = ci(r, k)
  return v == null ? null : Number(v)
}

const LOB = new Set(['clob', 'nclob', 'blob', 'bfile', 'long', 'long raw', 'xmltype'])

function refAction(rule: string | null): ReferentialAction {
  const r = (rule ?? '').trim().toUpperCase()
  if (r === 'CASCADE') return 'CASCADE'
  if (r === 'SET NULL') return 'SET NULL'
  return 'NO ACTION'
}

function oraLength(dataType: string, cat: string, charLen: number | null, dataLen: number | null): number | null {
  if (LOB.has(dataType)) return null
  if (cat === 'string') return charLen ?? dataLen
  if (cat === 'binary') return dataLen
  return null
}

export const oraCatalog: CatalogAdapter = {
  async listSchemas(db, o) {
    const rows = await queryRows(
      db,
      `SELECT username AS name FROM all_users WHERE oracle_maintained = 'N' ORDER BY username`,
      [],
      o,
    )
    return rows.map((r) => S(r, 'name')!)
  },

  async listTables(db, o) {
    const schemaClause = o.schema !== undefined ? 'AND UPPER(t.owner) = UPPER(:schema)' : ''
    const rows = await queryRows(
      db,
      `SELECT t.owner AS schema_name, t.table_name AS name, c.comments AS obj_comment
       FROM all_tables t
       JOIN all_users u ON u.username = t.owner AND u.oracle_maintained = 'N'
       LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name
       WHERE 1=1 ${schemaClause}
         AND t.dropped = 'NO'
         AND NOT EXISTS (SELECT 1 FROM all_mviews m WHERE m.owner = t.owner AND m.mview_name = t.table_name)`,
      o.schema !== undefined ? [p('schema', o.schema)] : [],
      o,
    )
    const out: TableRef[] = []
    for (const r of rows) out.push({ schema: S(r, 'schema_name'), name: S(r, 'name')!, comment: S(r, 'obj_comment') })
    return out
  },

  async listViews(db, o) {
    const schemaClause = o.schema !== undefined ? 'AND UPPER(v.owner) = UPPER(:schema)' : ''
    const rows = await queryRows(
      db,
      `SELECT v.owner AS schema_name, v.view_name AS name, c.comments AS obj_comment
       FROM all_views v
       JOIN all_users u ON u.username = v.owner AND u.oracle_maintained = 'N'
       LEFT JOIN all_tab_comments c ON c.owner = v.owner AND c.table_name = v.view_name
       WHERE 1=1 ${schemaClause}`,
      o.schema !== undefined ? [p('schema', o.schema)] : [],
      o,
    )
    const out: TableRef[] = []
    for (const r of rows) out.push({ schema: S(r, 'schema_name'), name: S(r, 'name')!, comment: S(r, 'obj_comment') })
    return out
  },

  async describeTable(db, o) {
    const schema = o.schema ?? null
    const [head, cols, pk] = await Promise.all([
      queryRows(
        db,
        `SELECT o.object_type AS object_type, c.comments AS obj_comment
         FROM all_objects o
         LEFT JOIN all_tab_comments c ON c.owner = o.owner AND c.table_name = o.object_name
         WHERE (UPPER(o.owner) = UPPER(:schema) OR :schema IS NULL) AND UPPER(o.object_name) = UPPER(:table_name) AND o.object_type IN ('TABLE','VIEW')`,
        [p('schema', schema), p('table_name', o.table)],
        o,
      ),
      queryRows(
        db,
        `SELECT c.column_id AS position, c.column_name AS name,
                c.data_type AS data_type, c.char_length AS char_len, c.data_length AS data_length,
                c.data_precision AS num_precision, c.data_scale AS num_scale,
                c.nullable AS nullable, c.data_default AS default_value,
                cc.comments AS obj_comment
         FROM all_tab_columns c
         LEFT JOIN all_col_comments cc
           ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
         WHERE (UPPER(c.owner) = UPPER(:schema) OR :schema IS NULL) AND UPPER(c.table_name) = UPPER(:table_name)
         ORDER BY c.column_id`,
        [p('schema', schema), p('table_name', o.table)],
        o,
      ),
      queryRows(
        db,
        `SELECT col.column_name AS name
         FROM all_constraints con
         JOIN all_cons_columns col ON col.owner = con.owner AND col.constraint_name = con.constraint_name
         WHERE (UPPER(con.owner) = UPPER(:schema) OR :schema IS NULL) AND UPPER(con.table_name) = UPPER(:table_name) AND con.constraint_type = 'P'
         ORDER BY col.position`,
        [p('schema', schema), p('table_name', o.table)],
        o,
      ),
    ])

    const objectType: 'table' | 'view' = head.length > 0 && S(head[0]!, 'object_type') === 'VIEW' ? 'view' : 'table'
    const comment = head.length > 0 ? S(head[0]!, 'obj_comment') : null
    const pkNames = pk.map((r) => S(r, 'name')!)

    const columns: ColumnInfo[] = cols.map((r) => {
      const dataType = (S(r, 'data_type') ?? '').toLowerCase()
      const scale = N(r, 'num_scale')
      const cat = typeCategory('ora', dataType, scale)
      return {
        position: N(r, 'position') ?? 0,
        name: S(r, 'name')!,
        dataType,
        typeCategory: cat,
        length: oraLength(dataType, cat, N(r, 'char_len'), N(r, 'data_length')),
        precision: cat === 'decimal' ? N(r, 'num_precision') : null,
        scale: cat === 'decimal' ? scale : null,
        nullable: S(r, 'nullable')!.toUpperCase() === 'Y',
        defaultValue: S(r, 'default_value')?.trimEnd() ?? null,
        isPrimaryKey: pkNames.includes(S(r, 'name')!),
        comment: S(r, 'obj_comment'),
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
    if (o.schema !== undefined && o.table !== undefined) {
      // Пара сторон: иначе FK для A.X вернёт и FK между B.X и A.Y (кросс-схемное ложное срабатывание).
      filters.push(
        '((UPPER(con.owner) = UPPER(:schema) AND UPPER(con.table_name) = UPPER(:table_name)) OR (UPPER(rcon.owner) = UPPER(:schema) AND UPPER(rcon.table_name) = UPPER(:table_name)))',
      )
      params.push(p('schema', o.schema), p('table_name', o.table))
    } else if (o.schema !== undefined) {
      filters.push('(UPPER(con.owner) = UPPER(:schema) OR UPPER(rcon.owner) = UPPER(:schema))')
      params.push(p('schema', o.schema))
    } else if (o.table !== undefined) {
      filters.push('(UPPER(con.table_name) = UPPER(:table_name) OR UPPER(rcon.table_name) = UPPER(:table_name))')
      params.push(p('table_name', o.table))
    }
    const where = filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''

    const [meta, cols] = await Promise.all([
      queryRows(
        db,
        `SELECT con.constraint_name AS name, con.owner AS schema_name, con.table_name AS table_name,
                rcon.owner AS referenced_schema, rcon.table_name AS referenced_table,
                con.delete_rule AS on_delete
         FROM all_constraints con
         JOIN all_constraints rcon ON rcon.owner = con.r_owner AND rcon.constraint_name = con.r_constraint_name
         WHERE con.constraint_type = 'R' ${where}`,
        params,
        o,
      ),
      queryRows(
        db,
        `SELECT con.constraint_name AS name, con.owner AS schema_name, con.table_name AS table_name,
                cc.column_name AS column_name, rcc.column_name AS referenced_column
         FROM all_constraints con
         JOIN all_constraints rcon ON rcon.owner = con.r_owner AND rcon.constraint_name = con.r_constraint_name
         JOIN all_cons_columns cc ON cc.owner = con.owner AND cc.constraint_name = con.constraint_name
         JOIN all_cons_columns rcc
           ON rcc.owner = con.r_owner AND rcc.constraint_name = con.r_constraint_name AND rcc.position = cc.position
         WHERE con.constraint_type = 'R' ${where}
         ORDER BY con.constraint_name, cc.position`,
        params,
        o,
      ),
    ])

    const colMap = new Map<string, { columns: string[]; referencedColumns: string[] }>()
    for (const r of cols) {
      const key = `${S(r, 'schema_name')}.${S(r, 'table_name')}.${S(r, 'name')}`
      let e = colMap.get(key)
      if (!e) {
        e = { columns: [], referencedColumns: [] }
        colMap.set(key, e)
      }
      e.columns.push(S(r, 'column_name')!)
      e.referencedColumns.push(S(r, 'referenced_column')!)
    }

    const out: ForeignKey[] = []
    for (const r of meta) {
      const name = S(r, 'name')!
      const key = `${S(r, 'schema_name')}.${S(r, 'table_name')}.${name}`
      const c = colMap.get(key) ?? { columns: [], referencedColumns: [] }
      out.push({
        name,
        schema: S(r, 'schema_name'),
        table: S(r, 'table_name')!,
        columns: c.columns,
        referencedSchema: S(r, 'referenced_schema'),
        referencedTable: S(r, 'referenced_table')!,
        referencedColumns: c.referencedColumns,
        onDelete: refAction(S(r, 'on_delete')),
        onUpdate: 'NO ACTION',
      })
    }
    return out
  },

  async listIndexes(db, o) {
    const schema = o.schema ?? null
    const [rows, pkIdx] = await Promise.all([
      queryRows(
        db,
        `SELECT i.index_name AS name, i.uniqueness AS uniqueness,
                ic.column_name AS column_name, ic.descend AS descend
         FROM all_indexes i
         JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
         WHERE (UPPER(i.table_owner) = UPPER(:schema) OR :schema IS NULL) AND UPPER(i.table_name) = UPPER(:table_name)
         ORDER BY i.index_name, ic.column_position`,
        [p('schema', schema), p('table_name', o.table)],
        o,
      ),
      queryRows(
        db,
        `SELECT c.index_name AS index_name FROM all_constraints c
         WHERE (UPPER(c.owner) = UPPER(:schema) OR :schema IS NULL) AND UPPER(c.table_name) = UPPER(:table_name)
           AND c.constraint_type = 'P' AND c.index_name IS NOT NULL`,
        [p('schema', schema), p('table_name', o.table)],
        o,
      ),
    ])

    const pkIndexes = new Set(pkIdx.map((r) => S(r, 'index_name')!))
    const map = new Map<string, IndexInfo>()
    for (const r of rows) {
      const name = S(r, 'name')!
      let idx = map.get(name)
      if (!idx) {
        idx = {
          name,
          unique: S(r, 'uniqueness')!.toUpperCase() === 'UNIQUE',
          primary: pkIndexes.has(name),
          columns: [],
        }
        map.set(name, idx)
      }
      idx.columns.push({ name: S(r, 'column_name'), descending: S(r, 'descend')!.toUpperCase() === 'DESC' })
    }
    return [...map.values()]
  },

  async listConstraints(db, o) {
    const schema = o.schema ?? null
    const out: ConstraintInfo[] = []
    const want = o.type

    if (want === undefined || want === 'primary_key' || want === 'unique') {
      const rows = await queryRows(
        db,
        `SELECT con.constraint_name AS name, con.constraint_type AS type, col.column_name AS column_name
         FROM all_constraints con
         JOIN all_cons_columns col ON col.owner = con.owner AND col.constraint_name = con.constraint_name
         WHERE (UPPER(con.owner) = UPPER(:schema) OR :schema IS NULL) AND UPPER(con.table_name) = UPPER(:table_name) AND con.constraint_type IN ('P','U')
         ORDER BY con.constraint_name, col.position`,
        [p('schema', schema), p('table_name', o.table)],
        o,
      )
      const map = new Map<string, ConstraintInfo>()
      for (const r of rows) {
        const name = S(r, 'name')!
        const type = S(r, 'type')! === 'P' ? ('primary_key' as const) : ('unique' as const)
        let c = map.get(name)
        if (!c) {
          c = { name, type, columns: [], expression: null }
          map.set(name, c)
        }
        c.columns.push(S(r, 'column_name')!)
      }
      out.push(...map.values())
    }

    if (want === undefined || want === 'check') {
      const rows = await queryRows(
        db,
        `SELECT con.constraint_name AS name, con.search_condition AS expression, con.generated AS generated
         FROM all_constraints con
         WHERE (UPPER(con.owner) = UPPER(:schema) OR :schema IS NULL) AND UPPER(con.table_name) = UPPER(:table_name) AND con.constraint_type = 'C'
         ORDER BY con.constraint_name`,
        [p('schema', schema), p('table_name', o.table)],
        o,
      )
      for (const r of rows) {
        const expr = S(r, 'expression') ?? ''
        // Отбрасываем только автоматически сгенерированные Oracle NOT NULL-чеки;
        // пользовательский CHECK "COL IS NOT NULL" (generated = 'USER NAME') сохраняем.
        if (S(r, 'generated') === 'GENERATED NAME' && /^\s*"?[A-Z0-9_$#]+"?\s+IS\s+NOT\s+NULL\s*$/i.test(expr)) continue
        out.push({ name: S(r, 'name')!, type: 'check', columns: [], expression: S(r, 'expression') })
      }
    }

    return out
  },

  async listRoutines(db, o) {
    const kindClause =
      o.kind === 'procedure'
        ? "AND o.object_type = 'PROCEDURE'"
        : o.kind === 'function'
          ? "AND o.object_type = 'FUNCTION'"
          : "AND o.object_type IN ('PROCEDURE','FUNCTION')"
    const schemaClause = o.schema !== undefined ? 'AND UPPER(o.owner) = UPPER(:schema)' : ''
    const rows = await queryRows(
      db,
      `SELECT o.owner AS schema_name, o.object_name AS name, o.object_type AS object_type
       FROM all_objects o
       JOIN all_users u ON u.username = o.owner AND u.oracle_maintained = 'N'
       WHERE 1=1 ${kindClause} ${schemaClause}`,
      o.schema !== undefined ? [p('schema', o.schema)] : [],
      o,
    )
    const out: RoutineRef[] = []
    for (const r of rows) {
      out.push({
        schema: S(r, 'schema_name'),
        name: S(r, 'name')!,
        kind: S(r, 'object_type')! === 'PROCEDURE' ? 'procedure' : 'function',
      })
    }
    return out
  },

  async listTriggers(db, o) {
    const schemaClause = o.schema !== undefined ? 'AND UPPER(t.owner) = UPPER(:schema)' : ''
    const tableClause = o.table !== undefined ? 'AND UPPER(t.table_name) = UPPER(:table_name)' : ''
    const params: TDbParam[] = []
    if (o.schema !== undefined) params.push(p('schema', o.schema))
    if (o.table !== undefined) params.push(p('table_name', o.table))

    const rows = await queryRows(
      db,
      `SELECT t.owner AS schema_name, t.trigger_name AS name, t.table_name AS table_name,
              t.trigger_type AS trigger_type, t.status AS status, t.triggering_event AS triggering_event
       FROM all_triggers t
       JOIN all_users u ON u.username = t.owner AND u.oracle_maintained = 'N'
       WHERE 1=1 AND t.table_name IS NOT NULL ${schemaClause} ${tableClause}`,
      params,
      o,
    )

    const out: TriggerInfo[] = []
    for (const r of rows) {
      const tt = S(r, 'trigger_type')!.toUpperCase()
      const timing = tt.startsWith('BEFORE')
        ? ('before' as const)
        : tt.startsWith('INSTEAD')
          ? ('instead_of' as const)
          : ('after' as const)
      const events = S(r, 'triggering_event')!
        .split(' OR ')
        .map((e) => e.trim().toLowerCase())
        .filter((e): e is 'insert' | 'update' | 'delete' => e === 'insert' || e === 'update' || e === 'delete')
      out.push({
        schema: S(r, 'schema_name'),
        name: S(r, 'name')!,
        table: S(r, 'table_name')!,
        timing,
        events,
        enabled: S(r, 'status')!.toUpperCase() === 'ENABLED',
      })
    }
    return out
  },

  async listSequences(db, o) {
    const schemaClause = o.schema !== undefined ? 'AND UPPER(s.sequence_owner) = UPPER(:schema)' : ''
    const rows = await queryRows(
      db,
      `SELECT s.sequence_owner AS schema_name, s.sequence_name AS name
       FROM all_sequences s
       JOIN all_users u ON u.username = s.sequence_owner AND u.oracle_maintained = 'N'
       WHERE 1=1 ${schemaClause}`,
      o.schema !== undefined ? [p('schema', o.schema)] : [],
      o,
    )
    const out: SequenceRef[] = []
    for (const r of rows) out.push({ schema: S(r, 'schema_name'), name: S(r, 'name')! })
    return out
  },

  async getDefinitions(db, o) {
    const params: TDbParam[] = [p('name', o.name)]
    if (o.schema !== undefined) params.push(p('schema', o.schema))
    const schemaClause = o.schema !== undefined ? 'AND UPPER(owner) = UPPER(:schema)' : ''

    const out: DefinitionInfo[] = []
    switch (o.objectType) {
      case 'view': {
        const rows = await queryRows(
          db,
          `SELECT v.owner AS schema_name, v.view_name AS name, v.text AS definition
           FROM all_views v
           WHERE UPPER(v.view_name) = UPPER(:name) ${schemaClause}`,
          params,
          o,
        )
        for (const r of rows) {
          out.push({
            schema: S(r, 'schema_name'),
            name: S(r, 'name')!,
            table: null,
            objectType: 'view',
            definition: S(r, 'definition'),
            definitionKind: 'body',
          })
        }
        break
      }
      case 'procedure':
      case 'function': {
        const type = o.objectType === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
        const rows = await queryRows(
          db,
          `SELECT s.owner AS schema_name, s.name AS name, s.text AS text, s.line AS line
           FROM all_source s
           WHERE UPPER(s.name) = UPPER(:name) AND s.type = :src_type ${schemaClause}
           ORDER BY s.line`,
          [...params, p('src_type', type)],
          o,
        )
        const byName = new Map<string, { schema: string | null; name: string; lines: string[] }>()
        for (const r of rows) {
          const schema = S(r, 'schema_name')
          const name = S(r, 'name')!
          const key = `${schema}\u0000${name}`
          let e = byName.get(key)
          if (!e) {
            e = { schema, name, lines: [] }
            byName.set(key, e)
          }
          e.lines.push(S(r, 'text')!)
        }
        for (const e of byName.values()) {
          out.push({
            schema: e.schema,
            name: e.name,
            table: null,
            objectType: o.objectType,
            definition: `CREATE OR REPLACE ${e.lines.join('')}`,
            definitionKind: 'full',
          })
        }
        break
      }
      case 'trigger': {
        const tableClause = o.table !== undefined ? 'AND UPPER(t.table_name) = UPPER(:table_name)' : ''
        if (o.table !== undefined) params.push(p('table_name', o.table))
        const rows = await queryRows(
          db,
          `SELECT t.owner AS schema_name, t.trigger_name AS name, t.table_name AS table_name,
                  t.trigger_body AS definition
           FROM all_triggers t
           WHERE UPPER(t.trigger_name) = UPPER(:name) ${schemaClause} ${tableClause}`,
          params,
          o,
        )
        for (const r of rows) {
          out.push({
            schema: S(r, 'schema_name'),
            name: S(r, 'name')!,
            table: S(r, 'table_name'),
            objectType: 'trigger',
            definition: S(r, 'definition'),
            definitionKind: 'body',
          })
        }
        break
      }
    }
    return out
  },

  buildSampleSql(o) {
    const cols = o.columns.length > 0 ? o.columns.map((c) => quoteIdentifier('ora', c)).join(', ') : '*'
    const qual = o.schema
      ? `${quoteIdentifier('ora', o.schema)}.${quoteIdentifier('ora', o.table)}`
      : quoteIdentifier('ora', o.table)
    return `SELECT ${cols} FROM ${qual} FETCH FIRST ${o.limit} ROWS ONLY`
  },
}
