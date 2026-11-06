import { z } from 'zod'

/** Лимиты (раздел 3.2 ТЗ): минимальные значения; defaults применяются в resolveLimits. */
export const limitsSchema = z.strictObject({
  timeoutMs: z.number().int().min(1).optional(),
  maxTimeoutMs: z.number().int().min(1).optional(),
  maxRows: z.number().int().min(1).optional(),
  maxRowsCap: z.number().int().min(1).optional(),
  maxCellChars: z.number().int().min(1).optional(),
  maxBinaryBytes: z.number().int().min(0).optional(),
})
export type Limits = z.infer<typeof limitsSchema>
export type ResolvedLimits = Required<Limits>

export const LIMIT_DEFAULTS: ResolvedLimits = {
  timeoutMs: 60000,
  maxTimeoutMs: 3600000,
  maxRows: 1000,
  maxRowsCap: 10000,
  maxCellChars: 65536,
  maxBinaryBytes: 4096,
}

export function resolveLimits(partial: Limits | undefined): ResolvedLimits {
  return mergeLimits(LIMIT_DEFAULTS, partial)
}

/** Глобальные лимиты переопределяются поэлементно локальным блоком `limits`. */
export function mergeLimits(global: ResolvedLimits, local: Limits | undefined): ResolvedLimits {
  return {
    timeoutMs: local?.timeoutMs ?? global.timeoutMs,
    maxTimeoutMs: local?.maxTimeoutMs ?? global.maxTimeoutMs,
    maxRows: local?.maxRows ?? global.maxRows,
    maxRowsCap: local?.maxRowsCap ?? global.maxRowsCap,
    maxCellChars: local?.maxCellChars ?? global.maxCellChars,
    maxBinaryBytes: local?.maxBinaryBytes ?? global.maxBinaryBytes,
  }
}

const nameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
const descriptionSchema = z.string()
const connectTimeoutSchema = z.number().int().min(0)
const portSchema = z.number().int().min(1).max(65535)
const userSchema = z.string()
const passwordSchema = z.string()

const mssqlAuthSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mssql'), user: userSchema, password: passwordSchema }),
  z.strictObject({ kind: z.literal('ntlm'), domain: z.string(), user: userSchema, password: passwordSchema }),
])

const mssqlConn = z.strictObject({
  kind: z.literal('mssql'),
  name: nameSchema,
  description: descriptionSchema.optional(),
  limits: limitsSchema.optional(),
  server: z.string(),
  port: portSchema.optional(),
  database: z.string().optional(),
  auth: mssqlAuthSchema,
  trustServerCertificate: z.boolean().optional(),
  encrypt: z.boolean().optional(),
  ca: z.string().optional(),
  connectTimeout: connectTimeoutSchema.optional(),
})

const pgConn = z.strictObject({
  kind: z.literal('pg'),
  name: nameSchema,
  description: descriptionSchema.optional(),
  limits: limitsSchema.optional(),
  host: z.string(),
  port: portSchema.optional(),
  database: z.string(),
  user: userSchema,
  password: passwordSchema,
  ssl: z
    .union([
      z.boolean(),
      z.strictObject({
        ca: z.string().optional(),
        trustServerCertificate: z.boolean().optional(),
      }),
    ])
    .optional(),
  connectTimeout: connectTimeoutSchema.optional(),
})

const oraConn = z.strictObject({
  kind: z.literal('ora'),
  name: nameSchema,
  description: descriptionSchema.optional(),
  limits: limitsSchema.optional(),
  host: z.string(),
  port: portSchema.optional(),
  service: z.string(),
  user: userSchema,
  password: passwordSchema,
  privilege: z
    .enum(['SYSDBA', 'SYSOPER', 'SYSASM', 'SYSBACKUP', 'SYSDG', 'SYSKM', 'SYSRAC'] as const)
    .optional(),
  connectTimeout: connectTimeoutSchema.optional(),
  queueTimeout: connectTimeoutSchema.optional(),
  poolMin: z.number().int().min(0).optional(),
  poolMax: z.number().int().min(0).optional(),
  poolIncrement: z.number().int().min(0).optional(),
})

const fbConn = z.strictObject({
  kind: z.literal('fb'),
  name: nameSchema,
  description: descriptionSchema.optional(),
  limits: limitsSchema.optional(),
  host: z.string(),
  port: portSchema.optional(),
  database: z.string(),
  user: userSchema,
  password: passwordSchema,
  charset: z.enum(['UTF8', 'WIN1251'] as const).optional(),
  numericMode: z.enum(['lossy', 'safe', 'string'] as const).optional(),
  connectTimeout: connectTimeoutSchema.optional(),
})

export const connectionSchema = z.discriminatedUnion('kind', [mssqlConn, pgConn, oraConn, fbConn])
export type TConnection = z.infer<typeof connectionSchema>

export const configSchema = z.strictObject({
  limits: limitsSchema.optional(),
  connections: z.array(connectionSchema).min(1),
})
export type TConfig = z.infer<typeof configSchema>
