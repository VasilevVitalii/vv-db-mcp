import type { DbConnection } from 'vv-db-connection'

/** Общие опции вызова каталога (таймаут молчания + сигнал отмены). */
export interface Opts {
  signal?: AbortSignal
  timeoutMs: number
}

export interface TableRef {
  schema: string | null
  name: string
  comment: string | null
}

export type TypeCategory =
  | 'integer'
  | 'decimal'
  | 'float'
  | 'string'
  | 'binary'
  | 'boolean'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'other'

export interface ColumnInfo {
  position: number
  name: string
  dataType: string
  typeCategory: TypeCategory
  length: number | null
  precision: number | null
  scale: number | null
  nullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  comment: string | null
}

export interface TableDescription {
  schema: string | null
  name: string
  objectType: 'table' | 'view'
  comment: string | null
  columns: ColumnInfo[]
  primaryKey: string[]
}

export type ReferentialAction = 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT'

export interface ForeignKey {
  name: string
  schema: string | null
  table: string
  columns: string[]
  referencedSchema: string | null
  referencedTable: string
  referencedColumns: string[]
  onDelete: ReferentialAction
  onUpdate: ReferentialAction
}

export interface IndexColumn {
  name: string | null
  descending: boolean
}

export interface IndexInfo {
  name: string
  unique: boolean
  primary: boolean
  columns: IndexColumn[]
}

export interface ConstraintInfo {
  name: string
  type: 'primary_key' | 'unique' | 'check'
  columns: string[]
  expression: string | null
}

export interface RoutineRef {
  schema: string | null
  name: string
  kind: 'procedure' | 'function'
}

export interface TriggerInfo {
  schema: string | null
  name: string
  table: string
  timing: 'before' | 'after' | 'instead_of'
  events: Array<'insert' | 'update' | 'delete'>
  enabled: boolean
}

export interface SequenceRef {
  schema: string | null
  name: string
}

export interface DefinitionInfo {
  schema: string | null
  name: string
  table: string | null
  objectType: 'view' | 'procedure' | 'function' | 'trigger'
  definition: string | null
  definitionKind: 'full' | 'body'
}

/** Контракт адаптера каталога (раздел 8.3 ТЗ). */
export interface CatalogAdapter {
  listSchemas(db: DbConnection, o: Opts): Promise<string[]>
  listTables(db: DbConnection, o: Opts & { schema?: string }): Promise<TableRef[]>
  listViews(db: DbConnection, o: Opts & { schema?: string }): Promise<TableRef[]>
  describeTable(
    db: DbConnection,
    o: Opts & { schema: string | null; table: string },
  ): Promise<TableDescription>
  listForeignKeys(db: DbConnection, o: Opts & { schema?: string; table?: string }): Promise<ForeignKey[]>
  listIndexes(db: DbConnection, o: Opts & { schema: string | null; table: string }): Promise<IndexInfo[]>
  listConstraints(
    db: DbConnection,
    o: Opts & { schema: string | null; table: string; type?: 'primary_key' | 'unique' | 'check' },
  ): Promise<ConstraintInfo[]>
  listRoutines(db: DbConnection, o: Opts & { schema?: string; kind?: 'procedure' | 'function' }): Promise<RoutineRef[]>
  listTriggers(db: DbConnection, o: Opts & { schema?: string; table?: string }): Promise<TriggerInfo[]>
  listSequences(db: DbConnection, o: Opts & { schema?: string }): Promise<SequenceRef[]>
  getDefinitions(
    db: DbConnection,
    o: Opts & {
      schema?: string
      name: string
      objectType: 'view' | 'procedure' | 'function' | 'trigger'
      table?: string
    },
  ): Promise<DefinitionInfo[]>
  // Firebird без схем: `schema` всегда null и молча игнорируется адаптером fb
  // (assertSchemaAllowed в meta.ts не допускает schema для fb до вызова).
  buildSampleSql(o: { schema: string | null; table: string; columns: string[]; limit: number }): string
}
