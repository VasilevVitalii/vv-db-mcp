import { z } from 'zod'

// --- общие фрагменты схем (раздел 4.3 ТЗ) ---

export const connSchema = z.string().describe('Имя подключения из list_connections')
export const schemaParamSchema = z
  .string()
  .describe('Имя схемы; опущено — все несистемные; у Firebird недопустимо')
export const filterParamSchema = z.string().describe('Подстрока имени без учёта регистра')
export const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(10000)
  .default(1000)
  .describe('Максимум строк в ответе')
export const warningsSchema = z.array(z.string())

export const paramSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  value: z.unknown().optional(),
  type: z.string().optional(),
  direction: z.enum(['in', 'out', 'inout'] as const).optional(),
  as: z.enum(['date', 'bigint', 'binary_base64'] as const).optional(),
})
export type Param = z.infer<typeof paramSchema>

export const columnSchema = z.object({
  name: z.string(),
  type: z.string(),
  length: z.number().int().optional(),
  precision: z.number().int().optional(),
  scale: z.number().int().optional(),
})
export type Column = z.infer<typeof columnSchema>

export const resultSetSchema = z.object({
  columns: z.array(columnSchema),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
  truncated: z.boolean(),
  rowsAffected: z.number().int().optional(),
})
export type ResultSet = z.infer<typeof resultSetSchema>

export const toolErrorKindSchema = z.enum([
  'connect',
  'query',
  'tx',
  'user',
  'timeout',
  'aborted',
  'unknown_connection',
  'invalid_argument',
  'not_found',
  'ambiguous',
  'internal',
] as const)

export const toolErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    kind: toolErrorKindSchema,
    code: z.string().optional(),
    message: z.string(),
    connection: z.string().optional(),
    statementIndex: z.number().int().optional(),
    outcomeUnknown: z.boolean().optional(),
  }),
})
export type ToolError = z.infer<typeof toolErrorSchema>
