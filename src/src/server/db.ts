import { Pool, PoolClient, types } from 'pg';

// Keep numeric and date as strings: no float conversion, no timezone shifting.
types.setTypeParser(1700, (v) => v); // numeric
types.setTypeParser(1082, (v) => v); // date

const g = globalThis as unknown as { __tmsPool?: Pool };
export function pool(): Pool {
  if (!g.__tmsPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    g.__tmsPool = new Pool({
      connectionString: url,
      ssl: local ? false : { rejectUnauthorized: false },
      max: Number(process.env.DB_POOL_MAX || 5),
    });
  }
  return g.__tmsPool;
}
export type Db = Pool | PoolClient;

export async function q<T = any>(sql: string, params: unknown[] = [], db?: Db): Promise<T[]> {
  const r = await (db ?? pool()).query(sql, params);
  return r.rows as T[];
}
export async function one<T = any>(sql: string, params: unknown[] = [], db?: Db): Promise<T | null> {
  return (await q<T>(sql, params, db))[0] ?? null;
}
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const forbidden = (msg = 'You do not have permission to do this') => new ApiError(403, 'FORBIDDEN', msg);
export const notFound = (what = 'Record') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const bad = (msg: string, details?: unknown) => new ApiError(400, 'VALIDATION', msg, details);

export async function getSetting<T = unknown>(key: string, fallback: T, db?: Db): Promise<T> {
  const r = await one<{ value: T }>('select value from settings where key = $1', [key], db);
  return r ? r.value : fallback;
}

export type Sensitivity = 'general' | 'cost' | 'commercial' | 'admin';
export interface AuditEntry {
  entity_type: string; entity_id?: string | null; job_id?: string | null;
  action: string; field?: string | null; old_value?: unknown; new_value?: unknown;
  sensitivity?: Sensitivity;
}
const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

export async function audit(db: Db, actor: { id: string; full_name: string; department_code: string | null } | null, e: AuditEntry) {
  await db.query(
    `insert into audit_log (user_id, user_name, department_code, entity_type, entity_id, job_id, action, field, old_value, new_value, sensitivity)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [actor?.id ?? null, actor?.full_name ?? 'System', actor?.department_code ?? null, e.entity_type,
     e.entity_id ?? null, e.job_id ?? null, e.action, e.field ?? null, str(e.old_value), str(e.new_value),
     e.sensitivity ?? 'general'],
  );
}
