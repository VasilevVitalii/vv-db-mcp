import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TDbKind } from 'vv-db-connection'
import { loadConfig } from '../../src/config/load.js'
import { ConnectionRegistry } from '../../src/connections/registry.js'
import type { Entry } from '../../src/connections/registry.js'
import { getCatalog } from '../../src/catalog/index.js'
import type { CatalogAdapter } from '../../src/catalog/types.js'
import { runSql } from '../../src/exec/run.js'

export const CONNECT_PATH = join(process.cwd(), '.connect.json')
export const KINDS: TDbKind[] = ['pg', 'mssql', 'ora', 'fb']

export const PARENT = 'vvdbmcp_parent'
export const CHILD = 'vvdbmcp_child'
export const VIEW = 'vvdbmcp_v_child'
export const SEQ = 'vvdbmcp_seq'
export const TRG = 'vvdbmcp_trg_child'
export const PROC = 'vvdbmcp_proc'
export const FUNC = 'vvdbmcp_func'
export const IDX = 'vvdbmcp_idx_child'
export const DESC_IDX = 'vvdbmcp_idx_desc'
export const TRG_FN = 'vvdbmcp_trgfn'
export const MV = 'vvdbmcp_mv_child'

/** Схема по умолчанию для каждого kind; null — схема не указывается (ora: текущая схема, fb: схем нет). */
export const DEFAULT_SCHEMA: Record<TDbKind, string | null> = {
  pg: 'public',
  mssql: 'dbo',
  ora: null,
  fb: null,
}

export interface Harness {
  registry: ConnectionRegistry
  entries: Partial<Record<TDbKind, Entry>>
  catalogs: Record<TDbKind, CatalogAdapter>
  /** Пароли из .connect.json — для проверки, что они нигде не протекают в ответах. */
  passwords: string[]
}

export function connectAvailable(): boolean {
  return existsSync(CONNECT_PATH)
}

/** Есть ли запись данного kind в .connect.json (для skipIf до построения harness). */
export function hasKind(kind: TDbKind): boolean {
  if (!existsSync(CONNECT_PATH)) return false
  const raw = JSON.parse(readFileSync(CONNECT_PATH, 'utf8'))
  const conns: Array<{ kind?: string }> = raw.connections ?? []
  return conns.some((c) => c.kind === kind)
}

function collectPasswords(raw: unknown): string[] {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') return
    if (Array.isArray(node)) {
      for (const v of node) walk(v)
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'password' && typeof v === 'string' && v.length > 0) out.push(v)
        else walk(v)
      }
    }
  }
  walk(raw)
  return [...new Set(out)]
}

export async function buildHarness(): Promise<Harness> {
  const raw = JSON.parse(readFileSync(CONNECT_PATH, 'utf8'))
  const loaded = await loadConfig(CONNECT_PATH, null)
  const registry = new ConnectionRegistry(loaded.connections, loaded.maskSecrets)
  const entries: Partial<Record<TDbKind, Entry>> = {}
  for (const e of registry.list()) entries[e.kind] = e
  return {
    registry,
    entries,
    catalogs: {
      pg: getCatalog('pg'),
      mssql: getCatalog('mssql'),
      ora: getCatalog('ora'),
      fb: getCatalog('fb'),
    },
    passwords: collectPasswords(raw),
  }
}

const CREATE: Record<TDbKind, string[]> = {
  pg: [
    `CREATE TABLE ${PARENT} (id integer PRIMARY KEY, name varchar(64) NOT NULL UNIQUE, note varchar(128))`,
    `CREATE TABLE ${CHILD} (id integer PRIMARY KEY, parent_id integer REFERENCES ${PARENT}(id), code integer CHECK (code >= 0), label varchar(64))`,
    `CREATE INDEX ${IDX} ON ${CHILD} (parent_id, code)`,
    `CREATE INDEX ${DESC_IDX} ON ${CHILD} (parent_id DESC)`,
    `CREATE VIEW ${VIEW} AS SELECT id, parent_id, code FROM ${CHILD}`,
    `CREATE MATERIALIZED VIEW ${MV} AS SELECT id, parent_id FROM ${CHILD}`,
    `CREATE SEQUENCE ${SEQ}`,
    `CREATE FUNCTION ${TRG_FN}() RETURNS trigger AS $$ BEGIN IF NEW.label IS NULL THEN NEW.label := 'auto'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`,
    `CREATE TRIGGER ${TRG} BEFORE INSERT ON ${CHILD} FOR EACH ROW EXECUTE FUNCTION ${TRG_FN}()`,
    `CREATE PROCEDURE ${PROC}(p_id integer) LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${PARENT}(id, name) VALUES (p_id, 'proc-' || p_id); END; $$`,
    `CREATE FUNCTION ${FUNC}(p_id integer) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN p_id * 2; END; $$`,
  ],
  mssql: [
    `CREATE TABLE ${PARENT} (id int PRIMARY KEY, name varchar(64) NOT NULL UNIQUE, note varchar(128))`,
    `CREATE TABLE ${CHILD} (id int PRIMARY KEY, parent_id int REFERENCES ${PARENT}(id), code int CHECK (code >= 0), label varchar(64))`,
    `CREATE INDEX ${IDX} ON ${CHILD} (parent_id, code)`,
    `CREATE VIEW ${VIEW} AS SELECT id, parent_id, code FROM ${CHILD}`,
    `CREATE SEQUENCE ${SEQ} AS int START WITH 1 INCREMENT BY 1`,
    `CREATE TRIGGER ${TRG} ON ${CHILD} AFTER INSERT AS UPDATE ${CHILD} SET label = COALESCE(label, 'auto') WHERE id IN (SELECT id FROM inserted)`,
    `CREATE PROCEDURE ${PROC} @p_id int AS INSERT INTO ${PARENT}(id, name) VALUES (@p_id, 'proc-' + CAST(@p_id AS varchar(20)))`,
    `CREATE FUNCTION ${FUNC}(@p_id int) RETURNS int AS BEGIN RETURN @p_id * 2; END`,
  ],
  ora: [
    `CREATE TABLE ${PARENT} (id NUMBER(10) PRIMARY KEY, name VARCHAR2(64) NOT NULL UNIQUE, note VARCHAR2(128))`,
    `CREATE TABLE ${CHILD} (id NUMBER(10) PRIMARY KEY, parent_id NUMBER(10) REFERENCES ${PARENT}(id), code NUMBER(10) CHECK (code >= 0), label VARCHAR2(64))`,
    `CREATE INDEX ${IDX} ON ${CHILD} (parent_id, code)`,
    `CREATE VIEW ${VIEW} AS SELECT id, parent_id, code FROM ${CHILD}`,
    `CREATE SEQUENCE ${SEQ}`,
    `CREATE TRIGGER ${TRG} BEFORE INSERT ON ${CHILD} FOR EACH ROW BEGIN IF :NEW.label IS NULL THEN :NEW.label := 'auto'; END IF; END;`,
    `CREATE PROCEDURE ${PROC}(p_id IN NUMBER) AS BEGIN INSERT INTO ${PARENT}(id, name) VALUES (p_id, 'proc-' || p_id); END;`,
    `CREATE FUNCTION ${FUNC}(p_id IN NUMBER) RETURN NUMBER AS BEGIN RETURN p_id * 2; END;`,
  ],
  fb: [
    `CREATE TABLE ${PARENT} (id INTEGER PRIMARY KEY, name VARCHAR(64) NOT NULL UNIQUE, note VARCHAR(128))`,
    `CREATE TABLE ${CHILD} (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES ${PARENT}(id), code INTEGER CHECK (code >= 0), label VARCHAR(64))`,
    `CREATE INDEX ${IDX} ON ${CHILD} (parent_id, code)`,
    `CREATE VIEW ${VIEW} AS SELECT id, parent_id, code FROM ${CHILD}`,
    `CREATE SEQUENCE ${SEQ}`,
    `CREATE TRIGGER ${TRG} FOR ${CHILD} ACTIVE BEFORE INSERT POSITION 0 AS BEGIN IF (NEW.label IS NULL) THEN NEW.label = 'auto'; END`,
    `CREATE PROCEDURE ${PROC} AS BEGIN INSERT INTO ${PARENT}(id, name) VALUES (777, 'proc-fb'); END`,
    `CREATE FUNCTION ${FUNC} RETURNS INTEGER AS BEGIN RETURN 42; END`,
  ],
}

const DROP: Record<TDbKind, string[]> = {
  pg: [
    `DROP TRIGGER IF EXISTS ${TRG} ON ${CHILD}`,
    `DROP FUNCTION IF EXISTS ${TRG_FN}() CASCADE`,
    `DROP FUNCTION IF EXISTS ${FUNC}(integer)`,
    `DROP PROCEDURE IF EXISTS ${PROC}(integer)`,
    `DROP VIEW IF EXISTS ${VIEW}`,
    `DROP MATERIALIZED VIEW IF EXISTS ${MV}`,
    `DROP SEQUENCE IF EXISTS ${SEQ}`,
    `DROP INDEX IF EXISTS ${DESC_IDX}`,
    `DROP TABLE IF EXISTS ${CHILD}`,
    `DROP TABLE IF EXISTS ${PARENT}`,
    `DROP TABLE IF EXISTS vvdbmcp_tmp_pg`,
  ],
  mssql: [
    `IF OBJECT_ID('${TRG}', 'TR') IS NOT NULL DROP TRIGGER ${TRG}`,
    `IF OBJECT_ID('${FUNC}', 'FN') IS NOT NULL DROP FUNCTION ${FUNC}`,
    `IF OBJECT_ID('${PROC}', 'P') IS NOT NULL DROP PROCEDURE ${PROC}`,
    `IF OBJECT_ID('${VIEW}', 'V') IS NOT NULL DROP VIEW ${VIEW}`,
    `IF OBJECT_ID('${SEQ}', 'SO') IS NOT NULL DROP SEQUENCE ${SEQ}`,
    `IF OBJECT_ID('${CHILD}', 'U') IS NOT NULL DROP TABLE ${CHILD}`,
    `IF OBJECT_ID('${PARENT}', 'U') IS NOT NULL DROP TABLE ${PARENT}`,
    `IF OBJECT_ID('vvdbmcp_tmp_mssql', 'U') IS NOT NULL DROP TABLE vvdbmcp_tmp_mssql`,
  ],
  ora: [
    `BEGIN EXECUTE IMMEDIATE 'DROP TRIGGER ${TRG}'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
    `BEGIN EXECUTE IMMEDIATE 'DROP FUNCTION ${FUNC}'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
    `BEGIN EXECUTE IMMEDIATE 'DROP PROCEDURE ${PROC}'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
    `BEGIN EXECUTE IMMEDIATE 'DROP VIEW ${VIEW}'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
    `BEGIN EXECUTE IMMEDIATE 'DROP SEQUENCE ${SEQ}'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
    `BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${CHILD} CASCADE CONSTRAINTS'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
    `BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${PARENT} CASCADE CONSTRAINTS'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
    `BEGIN EXECUTE IMMEDIATE 'DROP TABLE vvdbmcp_tmp_ora'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
  ],
  fb: [
    `EXECUTE BLOCK AS BEGIN IF (EXISTS (SELECT 1 FROM RDB$TRIGGERS WHERE RDB$TRIGGER_NAME = '${TRG.toUpperCase()}')) THEN EXECUTE STATEMENT 'DROP TRIGGER ${TRG}'; END`,
    `EXECUTE BLOCK AS BEGIN IF (EXISTS (SELECT 1 FROM RDB$FUNCTIONS WHERE RDB$FUNCTION_NAME = '${FUNC.toUpperCase()}')) THEN EXECUTE STATEMENT 'DROP FUNCTION ${FUNC}'; END`,
    `EXECUTE BLOCK AS BEGIN IF (EXISTS (SELECT 1 FROM RDB$PROCEDURES WHERE RDB$PROCEDURE_NAME = '${PROC.toUpperCase()}')) THEN EXECUTE STATEMENT 'DROP PROCEDURE ${PROC}'; END`,
    `EXECUTE BLOCK AS BEGIN IF (EXISTS (SELECT 1 FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = '${VIEW.toUpperCase()}' AND RDB$VIEW_BLR IS NOT NULL)) THEN EXECUTE STATEMENT 'DROP VIEW ${VIEW}'; END`,
    `EXECUTE BLOCK AS BEGIN IF (EXISTS (SELECT 1 FROM RDB$GENERATORS WHERE RDB$GENERATOR_NAME = '${SEQ.toUpperCase()}' AND RDB$SYSTEM_FLAG = 0)) THEN EXECUTE STATEMENT 'DROP SEQUENCE ${SEQ}'; END`,
    `EXECUTE BLOCK AS BEGIN IF (EXISTS (SELECT 1 FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = '${CHILD.toUpperCase()}' AND RDB$VIEW_BLR IS NULL)) THEN EXECUTE STATEMENT 'DROP TABLE ${CHILD}'; END`,
    `EXECUTE BLOCK AS BEGIN IF (EXISTS (SELECT 1 FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = '${PARENT.toUpperCase()}' AND RDB$VIEW_BLR IS NULL)) THEN EXECUTE STATEMENT 'DROP TABLE ${PARENT}'; END`,
    `EXECUTE BLOCK AS BEGIN IF (EXISTS (SELECT 1 FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = 'VVDBMCP_TMP_FB' AND RDB$VIEW_BLR IS NULL)) THEN EXECUTE STATEMENT 'DROP TABLE vvdbmcp_tmp_fb'; END`,
  ],
}

const opts = (entry: Entry) => ({ timeoutMs: 30000, maxRows: 100, limits: entry.limits, connection: entry.name })

export async function createFixture(entry: Entry): Promise<void> {
  for (const sql of CREATE[entry.kind]) {
    await runSql(entry.db, sql, [], opts(entry))
  }
}

export async function dropFixture(entry: Entry): Promise<void> {
  for (const sql of DROP[entry.kind]) {
    try {
      await runSql(entry.db, sql, [], opts(entry))
    } catch {
      // best-effort cleanup
    }
  }
}

/** Регистронезависимый поиск по name/table. */
export function hasName(items: Array<{ name?: string; table?: string }>, name: string): boolean {
  const want = name.toLowerCase()
  return items.some((i) => (i.name ?? i.table ?? '').toLowerCase() === want)
}

/** Доступ к колонке строки без учёта регистра: ora/fb возвращают ключи UPPERCASE. */
export function cell(row: Record<string, unknown>, key: string): unknown {
  return row[key] ?? row[key.toUpperCase()] ?? row[key.toLowerCase()]
}
