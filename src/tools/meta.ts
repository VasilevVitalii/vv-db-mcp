import { z } from 'zod'
import type { TDbKind } from 'vv-db-connection'
import { defineTool, getEntry, clampTimeout, READ_ANNOTATIONS } from './define.js'
import { connSchema, schemaParamSchema, filterParamSchema, limitSchema, warningsSchema, columnSchema } from './schemas.js'
import { getCatalog } from '../catalog/index.js'
import type { CatalogAdapter, TableRef } from '../catalog/types.js'
import { resolveName, matchesFilter, sortByName, applyLimit } from '../catalog/common.js'
import { ServerError } from '../errors/map.js'
import { runSql } from '../exec/run.js'
import type { Entry } from '../connections/registry.js'

// --- zod-схемы результатов каталога (раздел 6 ТЗ) ---

const tableRefSchema = z.object({
  schema: z.string().nullable(),
  name: z.string(),
  comment: z.string().nullable(),
})

const typeCategorySchema = z.enum([
  'integer',
  'decimal',
  'float',
  'string',
  'binary',
  'boolean',
  'date',
  'time',
  'timestamp',
  'other',
] as const)

const columnInfoSchema = z.object({
  position: z.number().int(),
  name: z.string(),
  dataType: z.string(),
  typeCategory: typeCategorySchema,
  length: z.number().int().nullable(),
  precision: z.number().int().nullable(),
  scale: z.number().int().nullable(),
  nullable: z.boolean(),
  defaultValue: z.string().nullable(),
  isPrimaryKey: z.boolean(),
  comment: z.string().nullable(),
})

const referentialActionSchema = z.enum(['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT'] as const)

const foreignKeySchema = z.object({
  name: z.string(),
  schema: z.string().nullable(),
  table: z.string(),
  columns: z.array(z.string()),
  referencedSchema: z.string().nullable(),
  referencedTable: z.string(),
  referencedColumns: z.array(z.string()),
  onDelete: referentialActionSchema,
  onUpdate: referentialActionSchema,
})

const indexColumnSchema = z.object({
  name: z.string().nullable(),
  descending: z.boolean(),
})

const indexSchema = z.object({
  name: z.string(),
  unique: z.boolean(),
  primary: z.boolean(),
  columns: z.array(indexColumnSchema),
})

const constraintSchema = z.object({
  name: z.string(),
  type: z.enum(['primary_key', 'unique', 'check'] as const),
  columns: z.array(z.string()),
  expression: z.string().nullable(),
})

const routineSchema = z.object({
  schema: z.string().nullable(),
  name: z.string(),
  kind: z.enum(['procedure', 'function'] as const),
})

const triggerSchema = z.object({
  schema: z.string().nullable(),
  name: z.string(),
  table: z.string(),
  timing: z.enum(['before', 'after', 'instead_of'] as const),
  events: z.array(z.enum(['insert', 'update', 'delete'] as const)),
  enabled: z.boolean(),
})

const sequenceSchema = z.object({
  schema: z.string().nullable(),
  name: z.string(),
})

const definitionSchema = z.object({
  schema: z.string().nullable(),
  name: z.string(),
  table: z.string().nullable(),
  objectType: z.enum(['view', 'procedure', 'function', 'trigger'] as const),
  definition: z.string().nullable(),
  definitionKind: z.enum(['full', 'body'] as const),
})

// --- общие хелперы meta-инструментов ---

/** Firebird не имеет схем: переданный schema — ошибка invalid_argument (раздел 4.1). */
function assertSchemaAllowed(kind: TDbKind, schema: string | undefined): void {
  if (kind === 'fb' && schema !== undefined) {
    throw new ServerError('invalid_argument', 'Firebird не имеет схем; параметр schema недопустим')
  }
}

/** Разрешение table по каталогу (раздел 4.2); includeViews включает представления. */
async function resolveTableRef(
  entry: Entry,
  cat: CatalogAdapter,
  table: string,
  schema: string | undefined,
  includeViews: boolean,
  signal: AbortSignal,
): Promise<{ schema: string | null; name: string }> {
  const o = { signal, timeoutMs: entry.limits.timeoutMs, schema }
  const tables = await cat.listTables(entry.db, o)
  const refs = includeViews ? tables.concat(await cat.listViews(entry.db, o)) : tables
  return resolveName(refs, table, schema)
}

/** nameContains-фильтр + сортировка по schema/name + limit/truncated. */
function filterSortLimit<T extends { schema: string | null; name: string }>(
  items: T[],
  nameContains: string | undefined,
  limit: number,
): { items: T[]; truncated: boolean } {
  const filtered = items.filter((i) => matchesFilter(i.name, nameContains))
  sortByName(filtered)
  return applyLimit(filtered, limit)
}

const catalogOpts = (entry: Entry, signal: AbortSignal) => ({ signal, timeoutMs: entry.limits.timeoutMs })

/** Потолок листинга: серверный maxRowsCap капает клиентский limit. */
function capLimit(entry: Entry, limit: number): number {
  return Math.min(limit, entry.limits.maxRowsCap)
}

// --- 6.6 list_schemas ---

export const listSchemasTool = defineTool({
  name: 'list_schemas',
  title: 'list_schemas',
  description:
    'Схемы подключения (несистемные): MSSQL schema, PostgreSQL schema, Oracle owner. ' +
    'Возвращаются все несистемные схемы. На Firebird схем нет: возвращается пустой список и warnings ["Firebird не имеет схем"].',
  input: z.strictObject({ connection: connSchema }),
  output: z.object({
    ok: z.literal(true),
    schemas: z.array(z.string()),
    warnings: warningsSchema.optional(),
  }),
  annotations: READ_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    const cat = getCatalog(entry.kind)
    const schemas = await cat.listSchemas(entry.db, catalogOpts(entry, signal))
    const warnings = entry.kind === 'fb' ? ['Firebird не имеет схем'] : undefined
    return { ok: true as const, schemas, ...(warnings !== undefined ? { warnings } : {}) }
  },
})

// --- 6.7 list_tables / list_views ---

const listRelationInput = z.strictObject({
  connection: connSchema,
  schema: schemaParamSchema.optional(),
  nameContains: filterParamSchema.optional(),
  limit: limitSchema,
})

function listRelationTool(opts: { name: 'list_tables' | 'list_views'; field: 'tables' | 'views'; fn: 'listTables' | 'listViews' }) {
  return defineTool({
    name: opts.name,
    title: opts.name,
    description:
      opts.name === 'list_tables'
        ? 'Базовые таблицы подключения (системные и материализованные объекты исключены). Сортировка по schema, затем name; nameContains — регистронезависимая подстрока.'
        : 'Представления подключения (системные исключены; в PostgreSQL также материализованные; материализованные представления Oracle не включены). Сортировка по schema, затем name; nameContains — регистронезависимая подстрока.',
    input: listRelationInput,
    output: z.object({
      ok: z.literal(true),
      truncated: z.boolean(),
      [opts.field]: z.array(tableRefSchema),
    }),
    annotations: READ_ANNOTATIONS,
    handler: async (args, ctx, signal) => {
      const entry = getEntry(ctx, args.connection)
      assertSchemaAllowed(entry.kind, args.schema)
      const cat = getCatalog(entry.kind)
      const refs: TableRef[] = await cat[opts.fn](entry.db, {
        ...catalogOpts(entry, signal),
        schema: args.schema,
      })
      const { items, truncated } = filterSortLimit(refs, args.nameContains, capLimit(entry, args.limit))
      return { ok: true as const, truncated, [opts.field]: items }
    },
  })
}

export const listTablesTool = listRelationTool({ name: 'list_tables', field: 'tables', fn: 'listTables' })
export const listViewsTool = listRelationTool({ name: 'list_views', field: 'views', fn: 'listViews' })

// --- 6.8 describe_table ---

export const describeTableTool = defineTool({
  name: 'describe_table',
  title: 'describe_table',
  description:
    'Структура таблицы или представления: столбцы (позиция, тип, категория typeCategory, длина, точность, шкала, nullable, default, признак ПК, комментарий) и первичный ключ. ' +
    'typeCategory — единая классификация типов для переноса данных между СУБД (приложение B); массивы PostgreSQL классифицируются по типу элемента, а в dataType сохраняется суффикс [].',
  input: z.strictObject({
    connection: connSchema,
    table: z.string().min(1),
    schema: schemaParamSchema.optional(),
  }),
  output: z.object({
    ok: z.literal(true),
    schema: z.string().nullable(),
    name: z.string(),
    objectType: z.enum(['table', 'view'] as const),
    comment: z.string().nullable(),
    columns: z.array(columnInfoSchema),
    primaryKey: z.array(z.string()),
  }),
  annotations: READ_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    assertSchemaAllowed(entry.kind, args.schema)
    const cat = getCatalog(entry.kind)
    const resolved = await resolveTableRef(entry, cat, args.table, args.schema, true, signal)
    const desc = await cat.describeTable(entry.db, {
      ...catalogOpts(entry, signal),
      schema: resolved.schema,
      table: resolved.name,
    })
    return { ok: true as const, ...desc }
  },
})

// --- 6.9 list_foreign_keys ---

export const listForeignKeysTool = defineTool({
  name: 'list_foreign_keys',
  title: 'list_foreign_keys',
  description:
    'Внешние ключи (связи между таблицами). Если указан table — ключи, где эта таблица дочерняя или родительская; каждая запись содержит обе стороны. ' +
    'schema сужает по любой из сторон. Многостолбцовые ключи — массивы columns ↔ referencedColumns в одинаковом порядке.',
  input: z.strictObject({
    connection: connSchema,
    schema: schemaParamSchema.optional(),
    table: z.string().min(1).optional(),
    limit: limitSchema,
  }),
  output: z.object({
    ok: z.literal(true),
    truncated: z.boolean(),
    foreignKeys: z.array(foreignKeySchema),
  }),
  annotations: READ_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    assertSchemaAllowed(entry.kind, args.schema)
    const cat = getCatalog(entry.kind)
    let table: string | undefined
    let schema: string | undefined = args.schema
    if (args.table !== undefined) {
      const r = await resolveTableRef(entry, cat, args.table, args.schema, false, signal)
      table = r.name
      schema = r.schema ?? undefined
    }
    const fks = await cat.listForeignKeys(entry.db, {
      ...catalogOpts(entry, signal),
      schema,
      table,
    })
    const { items, truncated } = applyLimit(sortByName(fks), capLimit(entry, args.limit))
    return { ok: true as const, truncated, foreignKeys: items }
  },
})

// --- 6.10 list_indexes ---

export const listIndexesTool = defineTool({
  name: 'list_indexes',
  title: 'list_indexes',
  description:
    'Индексы таблицы. Индексы, обслуживающие ограничения, включаются с признаками unique/primary. ' +
    'INCLUDE-столбцы (MSSQL, PostgreSQL) и частичные условия PostgreSQL в контракт не входят.',
  input: z.strictObject({
    connection: connSchema,
    table: z.string().min(1),
    schema: schemaParamSchema.optional(),
  }),
  output: z.object({
    ok: z.literal(true),
    schema: z.string().nullable(),
    table: z.string(),
    indexes: z.array(indexSchema),
  }),
  annotations: READ_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    assertSchemaAllowed(entry.kind, args.schema)
    const cat = getCatalog(entry.kind)
    const resolved = await resolveTableRef(entry, cat, args.table, args.schema, true, signal)
    const indexes = await cat.listIndexes(entry.db, {
      ...catalogOpts(entry, signal),
      schema: resolved.schema,
      table: resolved.name,
    })
    return { ok: true as const, schema: resolved.schema, table: resolved.name, indexes }
  },
})

// --- 6.11 list_constraints ---

export const listConstraintsTool = defineTool({
  name: 'list_constraints',
  title: 'list_constraints',
  description:
    'Ограничения таблицы: первичный ключ, уникальные, проверочные (check). Внешние ключи — в list_foreign_keys; NOT NULL — в nullable у describe_table. ' +
    'Для check columns — пустой массив, текст условия — в expression.',
  input: z.strictObject({
    connection: connSchema,
    table: z.string().min(1),
    schema: schemaParamSchema.optional(),
    type: z.enum(['primary_key', 'unique', 'check'] as const).optional(),
  }),
  output: z.object({
    ok: z.literal(true),
    schema: z.string().nullable(),
    table: z.string(),
    constraints: z.array(constraintSchema),
  }),
  annotations: READ_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    assertSchemaAllowed(entry.kind, args.schema)
    const cat = getCatalog(entry.kind)
    const resolved = await resolveTableRef(entry, cat, args.table, args.schema, true, signal)
    const constraints = await cat.listConstraints(entry.db, {
      ...catalogOpts(entry, signal),
      schema: resolved.schema,
      table: resolved.name,
      type: args.type,
    })
    return { ok: true as const, schema: resolved.schema, table: resolved.name, constraints }
  },
})

// --- 6.12 list_routines ---

export const listRoutinesTool = defineTool({
  name: 'list_routines',
  title: 'list_routines',
  description:
    'Хранимые процедуры и функции (автономные объекты; пакеты Oracle, UDF Firebird и CLR-объекты MSSQL не входят).',
  input: z.strictObject({
    connection: connSchema,
    schema: schemaParamSchema.optional(),
    kind: z.enum(['procedure', 'function'] as const).optional(),
    nameContains: filterParamSchema.optional(),
    limit: limitSchema,
  }),
  output: z.object({
    ok: z.literal(true),
    truncated: z.boolean(),
    routines: z.array(routineSchema),
  }),
  annotations: READ_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    assertSchemaAllowed(entry.kind, args.schema)
    const cat = getCatalog(entry.kind)
    const routines = await cat.listRoutines(entry.db, {
      ...catalogOpts(entry, signal),
      schema: args.schema,
      kind: args.kind,
    })
    const { items, truncated } = filterSortLimit(routines, args.nameContains, capLimit(entry, args.limit))
    return { ok: true as const, truncated, routines: items }
  },
})

// --- 6.13 list_triggers ---

export const listTriggersTool = defineTool({
  name: 'list_triggers',
  title: 'list_triggers',
  description:
    'Триггеры таблиц и представлений (в MSSQL — только таблиц; триггеры уровня базы Firebird и DDL-триггеры исключены). timing отражает реальность СУБД (в MSSQL нет before). Триггеры PostgreSQL только на TRUNCATE отдаются с events: [] — схема events не включает truncate.',
  input: z.strictObject({
    connection: connSchema,
    schema: schemaParamSchema.optional(),
    table: z.string().min(1).optional(),
    limit: limitSchema,
  }),
  output: z.object({
    ok: z.literal(true),
    truncated: z.boolean(),
    triggers: z.array(triggerSchema),
  }),
  annotations: READ_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    assertSchemaAllowed(entry.kind, args.schema)
    const cat = getCatalog(entry.kind)
    let table: string | undefined
    let schema: string | undefined = args.schema
    if (args.table !== undefined) {
      // includeViews=true: INSTEAD OF-триггеры на представлениях (Oracle/PG) тоже
      // находятся по table, иначе resolveTableRef дал бы not_found.
      const r = await resolveTableRef(entry, cat, args.table, args.schema, true, signal)
      table = r.name
      schema = r.schema ?? undefined
    }
    const triggers = await cat.listTriggers(entry.db, {
      ...catalogOpts(entry, signal),
      schema,
      table,
    })
    const { items, truncated } = applyLimit(sortByName(triggers), capLimit(entry, args.limit))
    return { ok: true as const, truncated, triggers: items }
  },
})

// --- 6.14 list_sequences ---

export const listSequencesTool = defineTool({
  name: 'list_sequences',
  title: 'list_sequences',
  description:
    'Последовательности (MSSQL SEQUENCE, PostgreSQL SEQUENCE, Oracle SEQUENCE, Firebird генераторы). Текущее значение и шаг не входят.',
  input: z.strictObject({
    connection: connSchema,
    schema: schemaParamSchema.optional(),
    nameContains: filterParamSchema.optional(),
    limit: limitSchema,
  }),
  output: z.object({
    ok: z.literal(true),
    truncated: z.boolean(),
    sequences: z.array(sequenceSchema),
  }),
  annotations: READ_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    assertSchemaAllowed(entry.kind, args.schema)
    const cat = getCatalog(entry.kind)
    const sequences = await cat.listSequences(entry.db, {
      ...catalogOpts(entry, signal),
      schema: args.schema,
    })
    const { items, truncated } = filterSortLimit(sequences, args.nameContains, capLimit(entry, args.limit))
    return { ok: true as const, truncated, sequences: items }
  },
})

// --- 6.15 get_definition ---

export const getDefinitionTool = defineTool({
  name: 'get_definition',
  title: 'get_definition',
  description:
    'Текст определения представления, процедуры, функции или триггера. Возвращает массив definitions, потому что имя не всегда уникально ' +
    '(перегрузки функций PostgreSQL и одноимённые триггеры разных таблиц). definitionKind: full — полный CREATE, body — только тело. ' +
    'definition — null, если текст недоступен (шифрование, нет прав).',
  input: z.strictObject({
    connection: connSchema,
    name: z.string().min(1),
    objectType: z.enum(['view', 'procedure', 'function', 'trigger'] as const),
    schema: schemaParamSchema.optional(),
    table: z.string().min(1).optional(),
  }),
  output: z.object({
    ok: z.literal(true),
    definitions: z.array(definitionSchema),
  }),
  annotations: READ_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    assertSchemaAllowed(entry.kind, args.schema)
    const cat = getCatalog(entry.kind)
    // Имя НЕ разрешается через resolveName: перегрузки функций и одноимённые
    // триггеры разных таблиц — легитимный случай, адаптер вернёт все совпадения.
    const defs = await cat.getDefinitions(entry.db, {
      ...catalogOpts(entry, signal),
      schema: args.schema,
      name: args.name,
      objectType: args.objectType,
      table: args.table,
    })
    if (defs.length === 0) {
      const qual = args.schema !== undefined ? `${args.schema}.${args.name}` : args.name
      throw new ServerError('not_found', `${args.objectType} "${qual}" не найден`)
    }
    return { ok: true as const, definitions: defs }
  },
})

// --- 6.16 sample_rows ---

const sampleLimitSchema = z.number().int().min(1).max(1000).default(10)

export const sampleRowsTool = defineTool({
  name: 'sample_rows',
  title: 'sample_rows',
  description:
    'Первые N строк таблицы или представления. Сервер сам строит SELECT на диалекте СУБД (MSSQL TOP, PostgreSQL LIMIT, Oracle FETCH FIRST, Firebird FIRST); ' +
    'имена объектов и столбцов берутся из каталога и экранируются — пользовательский текст в SQL не подставляется. Порядок строк не определён (без ORDER BY).',
  input: z.strictObject({
    connection: connSchema,
    table: z.string().min(1),
    schema: schemaParamSchema.optional(),
    columns: z.array(z.string().min(1)).min(1).optional(),
    limit: sampleLimitSchema,
    timeoutMs: z.number().int().min(1).optional(),
  }),
  output: z.object({
    ok: z.literal(true),
    schema: z.string().nullable(),
    table: z.string(),
    columns: z.array(columnSchema),
    rows: z.array(z.record(z.string(), z.unknown())),
    rowCount: z.number().int(),
    truncated: z.boolean(),
    warnings: warningsSchema.optional(),
  }),
  annotations: READ_ANNOTATIONS,
  handler: async (args, ctx, signal) => {
    const entry = getEntry(ctx, args.connection)
    assertSchemaAllowed(entry.kind, args.schema)
    const cat = getCatalog(entry.kind)
    const resolved = await resolveTableRef(entry, cat, args.table, args.schema, true, signal)
    const limit = args.limit
    // Имена столбцов берутся из каталога (как обещает описание), а не из ввода:
    // пользовательский список валидируется против реальных столбцов и экранируется
    // только для существующих — опечатка даёт понятную ошибку, а не молчаливый пустой набор.
    const columns: string[] = []
    if (args.columns !== undefined) {
      const desc = await cat.describeTable(entry.db, {
        ...catalogOpts(entry, signal),
        schema: resolved.schema,
        table: resolved.name,
      })
      // Валидация регистронезависима, но в SQL уходит каталожное имя (UPPERCASE у
      // Oracle/Firebird, реальный регистр у mixed-case PG), а не пользовательский
      // текст — иначе `columns:["id"]` на Oracle дал бы `"id"` и ORA-00904.
      const byLower = new Map(desc.columns.map((c) => [c.name.toLowerCase(), c.name]))
      for (const col of args.columns) {
        const real = byLower.get(col.toLowerCase())
        if (real === undefined) {
          throw new ServerError('invalid_argument', `столбец "${col}" не найден в "${resolved.name}"`)
        }
        columns.push(real)
      }
    }
    const cap = capLimit(entry, limit) // min(limit, server maxRowsCap) — как в прочих листингах
    // cap + 1: лишняя строка нужна только для вычисления truncated и отбрасывается из результата.
    const sql = cat.buildSampleSql({
      schema: resolved.schema,
      table: resolved.name,
      columns,
      limit: cap + 1,
    })
    const t = clampTimeout(args.timeoutMs ?? entry.limits.timeoutMs, entry.limits)
    const res = await runSql(entry.db, sql, [], {
      connection: entry.name,
      signal,
      timeoutMs: t,
      maxRows: cap + 1,
      limits: entry.limits,
    })
    const set = res.resultSets[0]
    const rows = set?.rows ?? []
    const truncated = rows.length > cap
    const outRows = truncated ? rows.slice(0, cap) : rows
    return {
      ok: true as const,
      schema: resolved.schema,
      table: resolved.name,
      columns: set?.columns ?? [],
      rows: outRows,
      rowCount: outRows.length,
      truncated,
      ...(res.warnings !== undefined ? { warnings: res.warnings } : {}),
    }
  },
})
