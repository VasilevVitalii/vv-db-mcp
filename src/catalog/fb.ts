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
// Значения RDB$ — CHAR с пробелами справа; обрезаем.
// Драйвер Firebird возвращает имена колонок в верхнем регистре, поэтому поиск ключа — без учёта регистра.
const ci = (r: Record<string, unknown>, k: string): unknown => r[k] ?? r[k.toUpperCase()] ?? r[k.toLowerCase()]
const FS = (r: Record<string, unknown>, k: string): string | null => {
  const v = ci(r, k)
  return v == null ? null : toText(v)?.trim() ?? null
}
const N = (r: Record<string, unknown>, k: string): number | null => {
  const v = ci(r, k)
  return v == null || v === '' ? null : Number(v)
}

/** DEFAULT_SOURCE хранит префикс `DEFAULT ` — срезаем. */
const stripDefault = (s: string | null): string | null =>
  s && /^DEFAULT\s+/i.test(s) ? s.replace(/^DEFAULT\s+/i, '') : s

function toText(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8')
  return String(v)
}

function fbDataType(fieldType: number | null, subType: number | null): string {
  switch (fieldType) {
    case 7:
    case 8:
    case 16:
      if (subType === 1) return 'numeric'
      if (subType === 2) return 'decimal'
      return fieldType === 7 ? 'smallint' : fieldType === 8 ? 'integer' : 'bigint'
    case 10:
      return 'float'
    case 27:
      return 'double precision'
    case 14:
      return 'char'
    case 37:
      return 'varchar'
    case 12:
      return 'date'
    case 13:
      return 'time'
    case 35:
      return 'timestamp'
    case 23:
      return 'boolean'
    case 26:
      if (subType === 1) return 'numeric'
      if (subType === 2) return 'decimal'
      return 'int128'
    case 28:
      return 'time with time zone'
    case 29:
      return 'timestamp with time zone'
    case 24:
      return 'decfloat16'
    case 25:
      return 'decfloat34'
    case 261:
      return subType === 1 ? 'blob sub_type text' : subType === 0 ? 'blob sub_type binary' : 'blob'
    default:
      return fieldType == null ? 'unknown' : `type_${fieldType}`
  }
}

/**
 * Декодирует RDB$TRIGGER_TYPE по битовой схеме Firebird 3.0+ (universal_triggers.txt):
 * бит 0 — BEFORE(0)/AFTER(1), далее три слота событий по 2 бита (1=INSERT, 2=UPDATE,
 * 3=DELETE); значение = битовое поле − 1. Кодирование зависит от порядка событий
 * в DDL (BEFORE UPDATE OR INSERT ≠ BEFORE INSERT OR UPDATE), поэтому таблица не
 * покрывает все комбинации — декодируем по формуле.
 */
function fbTrigger(type: number): { timing: 'before' | 'after'; events: Array<'insert' | 'update' | 'delete'> } {
  const v = type + 1
  const timing: 'before' | 'after' = (v & 1) === 0 ? 'before' : 'after'
  const ev = (slot: number): 'insert' | 'update' | 'delete' | null =>
    slot === 1 ? 'insert' : slot === 2 ? 'update' : slot === 3 ? 'delete' : null
  const events = [
    ...new Set(
      [ev((v >> 1) & 3), ev((v >> 3) & 3), ev((v >> 5) & 3)].filter(
        (x): x is 'insert' | 'update' | 'delete' => x !== null,
      ),
    ),
  ]
  return { timing, events }
}

function refAction(rule: string | null): ReferentialAction {
  const r = (rule ?? '').trim().toUpperCase()
  if (r === 'CASCADE') return 'CASCADE'
  if (r === 'SET NULL') return 'SET NULL'
  if (r === 'SET DEFAULT') return 'SET DEFAULT'
  if (r === 'RESTRICT') return 'RESTRICT'
  return 'NO ACTION'
}

export const fbCatalog: CatalogAdapter = {
  async listSchemas() {
    return [] // у Firebird схем нет (раздел 4.1 ТЗ)
  },

  async listTables(db, o) {
    const rows = await queryRows(
      db,
      `SELECT r.RDB$RELATION_NAME AS name, r.RDB$DESCRIPTION AS comment
       FROM RDB$RELATIONS r
       WHERE r.RDB$VIEW_BLR IS NULL AND (r.RDB$SYSTEM_FLAG IS NULL OR r.RDB$SYSTEM_FLAG = 0)`,
      [],
      o,
    )
    const out: TableRef[] = []
    for (const r of rows) out.push({ schema: null, name: FS(r, 'name')!, comment: FS(r, 'comment') })
    return out
  },

  async listViews(db, o) {
    const rows = await queryRows(
      db,
      `SELECT r.RDB$RELATION_NAME AS name, r.RDB$DESCRIPTION AS comment
       FROM RDB$RELATIONS r
       WHERE r.RDB$VIEW_BLR IS NOT NULL AND (r.RDB$SYSTEM_FLAG IS NULL OR r.RDB$SYSTEM_FLAG = 0)`,
      [],
      o,
    )
    const out: TableRef[] = []
    for (const r of rows) out.push({ schema: null, name: FS(r, 'name')!, comment: FS(r, 'comment') })
    return out
  },

  async describeTable(db, o) {
    const [head, cols, pk] = await Promise.all([
      queryRows(
        db,
        `SELECT r.RDB$VIEW_BLR AS view_blr, r.RDB$DESCRIPTION AS comment
         FROM RDB$RELATIONS r WHERE UPPER(r.RDB$RELATION_NAME) = UPPER(:table)`,
        [p('table', o.table)],
        o,
      ),
      queryRows(
        db,
        `SELECT rf.RDB$FIELD_POSITION AS field_position, rf.RDB$FIELD_NAME AS name,
                f.RDB$FIELD_TYPE AS field_type, f.RDB$FIELD_SUB_TYPE AS field_sub_type,
                f.RDB$CHARACTER_LENGTH AS char_len, f.RDB$FIELD_PRECISION AS field_precision,
                f.RDB$FIELD_SCALE AS scale,
                COALESCE(rf.RDB$NULL_FLAG, f.RDB$NULL_FLAG) AS null_flag,
                COALESCE(rf.RDB$DEFAULT_SOURCE, f.RDB$DEFAULT_SOURCE) AS default_source,
                rf.RDB$DESCRIPTION AS comment
         FROM RDB$RELATION_FIELDS rf
         JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
         WHERE UPPER(rf.RDB$RELATION_NAME) = UPPER(:table)
         ORDER BY rf.RDB$FIELD_POSITION`,
        [p('table', o.table)],
        o,
      ),
      queryRows(
        db,
        `SELECT iseg.RDB$FIELD_NAME AS name
         FROM RDB$RELATION_CONSTRAINTS rc
         JOIN RDB$INDEX_SEGMENTS iseg ON iseg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
         WHERE UPPER(rc.RDB$RELATION_NAME) = UPPER(:table) AND rc.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'
         ORDER BY iseg.RDB$FIELD_POSITION`,
        [p('table', o.table)],
        o,
      ),
    ])

    const objectType: 'table' | 'view' = head.length > 0 && FS(head[0]!, 'view_blr') !== null ? 'view' : 'table'
    const comment = head.length > 0 ? FS(head[0]!, 'comment') : null
    const pkNames = pk.map((r) => FS(r, 'name')!)

    const columns: ColumnInfo[] = cols.map((r) => {
      const dataType = fbDataType(N(r, 'field_type'), N(r, 'field_sub_type'))
      const cat = typeCategory('fb', dataType)
      const fieldScale = N(r, 'scale')
      const isChar = dataType === 'char' || dataType === 'varchar'
      return {
        position: (N(r, 'field_position') ?? 0) + 1,
        name: FS(r, 'name')!,
        dataType,
        typeCategory: cat,
        length: isChar ? N(r, 'char_len') : null,
        precision: cat === 'decimal' ? N(r, 'field_precision') : null,
        scale: cat === 'decimal' && fieldScale != null ? -fieldScale : null,
        nullable: N(r, 'null_flag') === null || N(r, 'null_flag') === 0,
        defaultValue: stripDefault(FS(r, 'default_source')),
        isPrimaryKey: pkNames.includes(FS(r, 'name')!),
        comment: FS(r, 'comment'),
      }
    })

    const desc: TableDescription = {
      schema: null,
      name: o.table,
      objectType,
      comment,
      columns,
      primaryKey: pkNames,
    }
    return desc
  },

  async listForeignKeys(db, o) {
    const tableClause =
      o.table !== undefined ? 'AND (UPPER(rc.RDB$RELATION_NAME) = UPPER(:table) OR UPPER(ref.RDB$RELATION_NAME) = UPPER(:table))' : ''
    const params: TDbParam[] = o.table !== undefined ? [p('table', o.table)] : []

    const [meta, cols, refs] = await Promise.all([
      queryRows(
        db,
        `SELECT rc.RDB$CONSTRAINT_NAME AS name, rc.RDB$RELATION_NAME AS table_name,
                ref.RDB$RELATION_NAME AS referenced_table,
                refc.RDB$DELETE_RULE AS delete_rule, refc.RDB$UPDATE_RULE AS update_rule
         FROM RDB$RELATION_CONSTRAINTS rc
         JOIN RDB$REF_CONSTRAINTS refc ON refc.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
         JOIN RDB$RELATION_CONSTRAINTS ref ON ref.RDB$CONSTRAINT_NAME = refc.RDB$CONST_NAME_UQ
         WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' ${tableClause}`,
        params,
        o,
      ),
      queryRows(
        db,
        `SELECT rc.RDB$CONSTRAINT_NAME AS name, iseg.RDB$FIELD_NAME AS column_name
         FROM RDB$RELATION_CONSTRAINTS rc
         JOIN RDB$REF_CONSTRAINTS refc ON refc.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
         JOIN RDB$RELATION_CONSTRAINTS ref ON ref.RDB$CONSTRAINT_NAME = refc.RDB$CONST_NAME_UQ
         JOIN RDB$INDEX_SEGMENTS iseg ON iseg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
         WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' ${tableClause}
         ORDER BY rc.RDB$CONSTRAINT_NAME, iseg.RDB$FIELD_POSITION`,
        params,
        o,
      ),
      queryRows(
        db,
        `SELECT refc.RDB$CONSTRAINT_NAME AS name, iseg.RDB$FIELD_NAME AS referenced_column
         FROM RDB$REF_CONSTRAINTS refc
         JOIN RDB$RELATION_CONSTRAINTS rc ON rc.RDB$CONSTRAINT_NAME = refc.RDB$CONSTRAINT_NAME
         JOIN RDB$RELATION_CONSTRAINTS ref ON ref.RDB$CONSTRAINT_NAME = refc.RDB$CONST_NAME_UQ
         JOIN RDB$INDEX_SEGMENTS iseg ON iseg.RDB$INDEX_NAME = ref.RDB$INDEX_NAME
         WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' ${tableClause}
         ORDER BY refc.RDB$CONSTRAINT_NAME, iseg.RDB$FIELD_POSITION`,
        params,
        o,
      ),
    ])

    const colMap = new Map<string, { columns: string[]; referencedColumns: string[] }>()
    for (const r of cols) {
      const name = FS(r, 'name')!
      let e = colMap.get(name)
      if (!e) {
        e = { columns: [], referencedColumns: [] }
        colMap.set(name, e)
      }
      e.columns.push(FS(r, 'column_name')!)
    }
    for (const r of refs) {
      const name = FS(r, 'name')!
      let e = colMap.get(name)
      if (!e) {
        e = { columns: [], referencedColumns: [] }
        colMap.set(name, e)
      }
      e.referencedColumns.push(FS(r, 'referenced_column')!)
    }

    const out: ForeignKey[] = []
    for (const r of meta) {
      const name = FS(r, 'name')!
      const c = colMap.get(name) ?? { columns: [], referencedColumns: [] }
      out.push({
        name,
        schema: null,
        table: FS(r, 'table_name')!,
        columns: c.columns,
        referencedSchema: null,
        referencedTable: FS(r, 'referenced_table')!,
        referencedColumns: c.referencedColumns,
        onDelete: refAction(FS(r, 'delete_rule')),
        onUpdate: refAction(FS(r, 'update_rule')),
      })
    }
    return out
  },

  async listIndexes(db, o) {
    const [rows, pkIdx] = await Promise.all([
      queryRows(
        db,
        `SELECT idx.RDB$INDEX_NAME AS name, idx.RDB$UNIQUE_FLAG AS unique_flag,
                idx.RDB$INDEX_TYPE AS index_type,
                iseg.RDB$FIELD_NAME AS column_name
         FROM RDB$INDICES idx
         LEFT JOIN RDB$INDEX_SEGMENTS iseg ON iseg.RDB$INDEX_NAME = idx.RDB$INDEX_NAME
         WHERE UPPER(idx.RDB$RELATION_NAME) = UPPER(:table)
         ORDER BY idx.RDB$INDEX_NAME, iseg.RDB$FIELD_POSITION`,
        [p('table', o.table)],
        o,
      ),
      queryRows(
        db,
        `SELECT rc.RDB$INDEX_NAME AS index_name
         FROM RDB$RELATION_CONSTRAINTS rc
         WHERE UPPER(rc.RDB$RELATION_NAME) = UPPER(:table) AND rc.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'`,
        [p('table', o.table)],
        o,
      ),
    ])

    const pkIndexes = new Set(pkIdx.map((r) => FS(r, 'index_name')!))
    const map = new Map<string, IndexInfo>()
    for (const r of rows) {
      const name = FS(r, 'name')!
      let idx = map.get(name)
      if (!idx) {
        idx = { name, unique: N(r, 'unique_flag') === 1, primary: pkIndexes.has(name), columns: [] }
        map.set(name, idx)
      }
      idx.columns.push({ name: FS(r, 'column_name'), descending: N(r, 'index_type') === 1 })
    }
    return [...map.values()]
  },

  async listConstraints(db, o) {
    const out: ConstraintInfo[] = []
    const want = o.type

    if (want === undefined || want === 'primary_key' || want === 'unique') {
      const rows = await queryRows(
        db,
        `SELECT rc.RDB$CONSTRAINT_NAME AS name, rc.RDB$CONSTRAINT_TYPE AS type,
                iseg.RDB$FIELD_NAME AS column_name
         FROM RDB$RELATION_CONSTRAINTS rc
         JOIN RDB$INDEX_SEGMENTS iseg ON iseg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
         WHERE UPPER(rc.RDB$RELATION_NAME) = UPPER(:table) AND rc.RDB$CONSTRAINT_TYPE IN ('PRIMARY KEY','UNIQUE')
         ORDER BY rc.RDB$CONSTRAINT_NAME, iseg.RDB$FIELD_POSITION`,
        [p('table', o.table)],
        o,
      )
      const map = new Map<string, ConstraintInfo>()
      for (const r of rows) {
        const name = FS(r, 'name')!
        const type = FS(r, 'type') === 'PRIMARY KEY' ? ('primary_key' as const) : ('unique' as const)
        let c = map.get(name)
        if (!c) {
          c = { name, type, columns: [], expression: null }
          map.set(name, c)
        }
        c.columns.push(FS(r, 'column_name')!)
      }
      out.push(...map.values())
    }

    if (want === undefined || want === 'check') {
      const rows = await queryRows(
        db,
        `SELECT cc.RDB$CONSTRAINT_NAME AS name, tr.RDB$TRIGGER_SOURCE AS expression
         FROM RDB$CHECK_CONSTRAINTS cc
         JOIN RDB$TRIGGERS tr ON tr.RDB$TRIGGER_NAME = cc.RDB$TRIGGER_NAME
         WHERE UPPER(tr.RDB$RELATION_NAME) = UPPER(:table) AND tr.RDB$TRIGGER_TYPE = 1`,
        [p('table', o.table)],
        o,
      )
      for (const r of rows) {
        out.push({ name: FS(r, 'name')!, type: 'check', columns: [], expression: FS(r, 'expression') })
      }
    }

    return out
  },

  async listRoutines(db, o) {
    const out: RoutineRef[] = []
    if (o.kind === undefined || o.kind === 'procedure') {
      const rows = await queryRows(
        db,
        `SELECT p.RDB$PROCEDURE_NAME AS name FROM RDB$PROCEDURES p
         WHERE p.RDB$PACKAGE_NAME IS NULL AND (p.RDB$SYSTEM_FLAG IS NULL OR p.RDB$SYSTEM_FLAG = 0)`,
        [],
        o,
      )
      for (const r of rows) out.push({ schema: null, name: FS(r, 'name')!, kind: 'procedure' })
    }
    if (o.kind === undefined || o.kind === 'function') {
      const rows = await queryRows(
        db,
        `SELECT f.RDB$FUNCTION_NAME AS name FROM RDB$FUNCTIONS f
         WHERE f.RDB$PACKAGE_NAME IS NULL AND f.RDB$MODULE_NAME IS NULL
           AND (f.RDB$SYSTEM_FLAG IS NULL OR f.RDB$SYSTEM_FLAG = 0)`,
        [],
        o,
      )
      for (const r of rows) out.push({ schema: null, name: FS(r, 'name')!, kind: 'function' })
    }
    return out
  },

  async listTriggers(db, o) {
    const tableClause = o.table !== undefined ? 'AND UPPER(t.RDB$RELATION_NAME) = UPPER(:table)' : ''
    const rows = await queryRows(
      db,
      `SELECT t.RDB$TRIGGER_NAME AS name, t.RDB$RELATION_NAME AS table_name,
              t.RDB$TRIGGER_TYPE AS trigger_type, t.RDB$TRIGGER_INACTIVE AS inactive
       FROM RDB$TRIGGERS t
       WHERE t.RDB$RELATION_NAME IS NOT NULL
         AND (t.RDB$SYSTEM_FLAG IS NULL OR t.RDB$SYSTEM_FLAG = 0) ${tableClause}`,
      o.table !== undefined ? [p('table', o.table)] : [],
      o,
    )

    const out: TriggerInfo[] = []
    for (const r of rows) {
      const t = N(r, 'trigger_type') ?? 0
      const spec = fbTrigger(t)
      out.push({
        schema: null,
        name: FS(r, 'name')!,
        table: FS(r, 'table_name')!,
        timing: spec.timing,
        events: spec.events,
        enabled: N(r, 'inactive') === null || N(r, 'inactive') === 0,
      })
    }
    return out
  },

  async listSequences(db, o) {
    const rows = await queryRows(
      db,
      `SELECT g.RDB$GENERATOR_NAME AS name FROM RDB$GENERATORS g
       WHERE g.RDB$SYSTEM_FLAG IS NULL OR g.RDB$SYSTEM_FLAG = 0`,
      [],
      o,
    )
    const out: SequenceRef[] = []
    for (const r of rows) out.push({ schema: null, name: FS(r, 'name')! })
    return out
  },

  async getDefinitions(db, o) {
    const params: TDbParam[] = [p('name', o.name)]
    let sql: string
    switch (o.objectType) {
      case 'view':
        sql = `SELECT r.RDB$RELATION_NAME AS name, r.RDB$VIEW_SOURCE AS definition
               FROM RDB$RELATIONS r WHERE UPPER(r.RDB$RELATION_NAME) = UPPER(:name) AND r.RDB$VIEW_BLR IS NOT NULL`
        break
      case 'procedure':
        sql = `SELECT p.RDB$PROCEDURE_NAME AS name, p.RDB$PROCEDURE_SOURCE AS definition
               FROM RDB$PROCEDURES p
               WHERE UPPER(p.RDB$PROCEDURE_NAME) = UPPER(:name)
                 AND p.RDB$PACKAGE_NAME IS NULL
                 AND (p.RDB$SYSTEM_FLAG IS NULL OR p.RDB$SYSTEM_FLAG = 0)`
        break
      case 'function':
        sql = `SELECT f.RDB$FUNCTION_NAME AS name, f.RDB$FUNCTION_SOURCE AS definition
               FROM RDB$FUNCTIONS f
               WHERE UPPER(f.RDB$FUNCTION_NAME) = UPPER(:name)
                 AND f.RDB$PACKAGE_NAME IS NULL
                 AND f.RDB$MODULE_NAME IS NULL
                 AND (f.RDB$SYSTEM_FLAG IS NULL OR f.RDB$SYSTEM_FLAG = 0)`
        break
      case 'trigger': {
        const tableClause = o.table !== undefined ? 'AND UPPER(t.RDB$RELATION_NAME) = UPPER(:table)' : ''
        if (o.table !== undefined) params.push(p('table', o.table))
        sql = `SELECT t.RDB$TRIGGER_NAME AS name, t.RDB$RELATION_NAME AS table_name,
                      t.RDB$TRIGGER_SOURCE AS definition
               FROM RDB$TRIGGERS t
               WHERE UPPER(t.RDB$TRIGGER_NAME) = UPPER(:name)
                 AND t.RDB$RELATION_NAME IS NOT NULL
                 AND (t.RDB$SYSTEM_FLAG IS NULL OR t.RDB$SYSTEM_FLAG = 0) ${tableClause}`
        break
      }
    }

    const rows = await queryRows(db, sql, params, o)
    const out: DefinitionInfo[] = []
    for (const r of rows) {
      out.push({
        schema: null,
        name: FS(r, 'name')!,
        table: FS(r, 'table_name'),
        objectType: o.objectType,
        definition: toText(ci(r, 'definition')),
        definitionKind: 'body',
      })
    }
    return out
  },

  buildSampleSql(o) {
    const cols = o.columns.length > 0 ? o.columns.map((c) => quoteIdentifier('fb', c)).join(', ') : '*'
    const qual = quoteIdentifier('fb', o.table)
    return `SELECT FIRST ${o.limit} ${cols} FROM ${qual}`
  },
}
