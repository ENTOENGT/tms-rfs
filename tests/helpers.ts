import { readFileSync, readdirSync } from 'fs';
import { pool } from '../src/server/db';
/** Rebuild the schema from every migration file, in order — exactly as done in Supabase. */
export async function resetDb() {
  await pool().query('drop schema public cascade; create schema public;');
  for (const f of readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort())
    await pool().query(readFileSync(`db/migrations/${f}`, 'utf8'));
}
