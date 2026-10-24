import { Actor, requirePerm } from './auth';
import { ApiError, audit, bad, forbidden, notFound, one, q, tx } from './db';
import { MASTERS, MasterDef, MasterField } from '../lib/masters';

function def(key: string): MasterDef {
  const d = MASTERS[key];
  if (!d) throw notFound('List');
  return d;
}
const UUID = /^[0-9a-f-]{36}$/i;

function parseField(f: MasterField, raw: unknown): unknown {
  if (f.type === 'bool') return raw === true || raw === 'true';
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (f.required) throw bad(`${f.label} is required`);
    return null;
  }
  const s = String(raw).trim();
  switch (f.type) {
    case 'text': case 'longtext': case 'phone':
      if (s.length > (f.max ?? 500)) throw bad(`${f.label} is too long (max ${f.max ?? 500} characters)`);
      if (f.type === 'phone' && !/^[+0-9 ()-]{5,30}$/.test(s)) throw bad(`${f.label} doesn't look like a phone number`);
      return s;
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad(`${f.label} is not a valid email`);
      return s.toLowerCase();
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw bad(`${f.label} is not a valid date`);
      return s;
    case 'number': case 'int': {
      const n = Number(s);
      const neg = f.key === 'latitude' || f.key === 'longitude';
      if (!Number.isFinite(n) || (!neg && n < 0) || (f.type === 'int' && !Number.isInteger(n))) throw bad(`${f.label} must be a valid number`);
      if (f.key === 'latitude' && Math.abs(n) > 90) throw bad('Latitude must be between -90 and 90');
      if (f.key === 'longitude' && Math.abs(n) > 180) throw bad('Longitude must be between -180 and 180');
      if (f.key === 'year' && (n < 1980 || n > 2100)) throw bad('Year looks wrong');
      return n;
    }
    case 'select':
      if (!f.options!.some((o) => o.value === s)) throw bad(`Choose a valid ${f.label.toLowerCase()}`);
      return s;
    case 'ref':
      if (!UUID.test(s)) throw bad(`Choose a valid ${f.label.toLowerCase()}`);
      return s;
  }
}

async function checkRefs(d: MasterDef, values: Record<string, unknown>) {
  for (const f of d.fields.filter((x) => x.type === 'ref')) {
    const v = values[f.key];
    if (!v) continue;
    const t = f.ref!;
    const ok = await one(`select 1 from ${t} where id = $1 ${t === 'vehicle_types' ? '' : 'and deleted_at is null'}`, [v]);
    if (!ok) throw bad(`${f.label} not found`);
  }
}

export async function listMaster(actor: Actor, key: string, p: Record<string, string>) {
  const d = def(key);
  if (!actor.has('jobs.view') && !actor.has(d.perm)) throw forbidden();
  const params: unknown[] = [];
  let where = d.softDelete ? 'where e.deleted_at is null' : 'where true';
  if (p.q?.trim()) {
    params.push('%' + p.q.trim().replace(/[%_\\]/g, '\\$&') + '%');
    where += ` and concat_ws(' ', ${d.search.join(', ')}) ilike $${params.length}`;
  }
  if (p.active === '1') where += d.activeField === 'is_active' ? ' and e.is_active' : ` and e.status <> 'inactive'`;
  const size = Math.min(Math.max(Number(p.page_size) || 50, 1), 500);
  const page = Math.max(Number(p.page) || 1, 1);
  const cols = ['e.id', ...d.fields.map((f) => `e.${f.key}`), d.joinCols].filter(Boolean).join(', ');
  const rows = await q(`select ${cols}, count(*) over() _total from ${d.table} e ${d.joins ?? ''} ${where}
    order by ${d.orderBy} limit ${size} offset ${(page - 1) * size}`, params);
  const keep = ['id', ...d.fields.map((f) => f.key), ...Object.values(d.display ?? {})];
  const out = rows.map((r) => Object.fromEntries(keep.map((k) => [k, r[k] ?? null])));
  if (key === 'drivers' && out.length) {
    // Phone app state per driver: none → link sent → using the app
    const app = await q(`select dr.id, u.is_active, u.last_login_at,
        exists (select 1 from app_links l where l.user_id = u.id and l.used_at is null and l.expires_at > now()) link_open
      from drivers dr join users u on u.id = dr.user_id and u.deleted_at is null where dr.id = any($1)`, [out.map((r) => r.id)]);
    const by = new Map(app.map((a) => [a.id, a]));
    for (const r of out) {
      const a = by.get(r.id);
      r.app = !a ? 'none' : !a.is_active ? 'off' : a.last_login_at ? 'active' : a.link_open ? 'sent' : 'expired';
    }
  }
  return { total: Number(rows[0]?._total ?? 0), page, page_size: size, rows: out };
}

const dupMessages: Record<string, string> = {
  vehicles_number_uq: 'A vehicle with this plate number already exists',
  drivers_driver_code_key: 'A driver with this Driver ID already exists',
  customers_code_key: 'A customer with this code already exists',
  customers_name_uq: 'A customer with this name already exists',
  vehicle_types_name_key: 'A vehicle type with this name already exists',
};
function mapDup(e: any): never {
  if (e?.code === '23505') throw new ApiError(409, 'DUPLICATE', dupMessages[e.constraint] ?? 'That value already exists');
  throw e;
}
const norm = (d: MasterDef, k: string, v: unknown) =>
  k === 'vehicle_number' && typeof v === 'string' ? v.toUpperCase().replace(/\s+/g, ' ') : v;

/** Job search text includes driver, vehicle and customer names — keep it in step. */
async function refreshSearch(c: any, key: string, id: string) {
  const sql: Record<string, string> = {
    drivers: 'select refresh_job_search(job_id) from transport_assignments where driver_id = $1 and is_current',
    vehicles: 'select refresh_job_search(job_id) from transport_assignments where vehicle_id = $1 and is_current',
    customers: 'select refresh_job_search(id) from transport_requests where customer_id = $1',
  };
  if (sql[key]) await c.query(sql[key], [id]);
}

export async function createMaster(actor: Actor, key: string, b: any) {
  const d = def(key);
  requirePerm(actor, d.perm);
  const values: Record<string, unknown> = {};
  for (const f of d.fields) {
    let raw = b[f.key];
    if (raw === undefined && f.type === 'bool') raw = true;          // new records start active
    if (raw === undefined && f.key === 'status') raw = 'available';
    values[f.key] = norm(d, f.key, parseField(f, raw));
  }
  await checkRefs(d, values);
  const keys = Object.keys(values);
  return tx(async (c) => {
    const r = await c.query(`insert into ${d.table} (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      keys.map((k) => values[k])).catch(mapDup);
    const id = r.rows[0].id;
    const label = String(values[d.fields[0].key]);
    await audit(c, actor, { entity_type: d.key, entity_id: id, action: `${cap(d.singular)} created`, new_value: label });
    return { id };
  });
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export async function updateMaster(actor: Actor, key: string, id: string, b: any) {
  const d = def(key);
  requirePerm(actor, d.perm);
  if (!UUID.test(id)) throw notFound(cap(d.singular));
  const cur = await one(`select * from ${d.table} where id = $1 ${d.softDelete ? 'and deleted_at is null' : ''}`, [id]);
  if (!cur) throw notFound(cap(d.singular));
  const changes: Record<string, unknown> = {};
  for (const f of d.fields) {
    if (!(f.key in b)) continue;
    const v = norm(d, f.key, parseField(f, b[f.key]));
    const old = cur[f.key];
    const same = (old === null && v === null) || String(old ?? '') === String(v ?? '') ||
      (f.type === 'number' && old !== null && v !== null && Number(old) === Number(v));
    if (!same) changes[f.key] = v;
  }
  if (!Object.keys(changes).length) return { id, changed: 0 };
  await checkRefs(d, changes);
  await tx(async (c) => {
    const keys = Object.keys(changes);
    await c.query(`update ${d.table} set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}
      ${'updated_at' in cur ? ', updated_at = now()' : ''} where id = $1`, [id, ...keys.map((k) => changes[k])]).catch(mapDup);
    for (const k of keys)
      await audit(c, actor, { entity_type: d.key, entity_id: id, action: `${cap(d.singular)} updated`,
        field: d.fields.find((f) => f.key === k)!.label, old_value: cur[k], new_value: changes[k] });
    await refreshSearch(c, key, id);
  });
  return { id, changed: Object.keys(changes).length };
}

export async function deleteMaster(actor: Actor, key: string, id: string) {
  const d = def(key);
  requirePerm(actor, d.perm);
  if (!UUID.test(id)) throw notFound(cap(d.singular));
  const openJobs: Record<string, string> = {
    drivers: `select t.job_number from transport_assignments a join transport_requests t on t.id = a.job_id join job_statuses s on s.code = t.status_code
      where a.driver_id = $1 and a.is_current and s.stage in ('open','active') and t.deleted_at is null limit 5`,
    vehicles: `select t.job_number from transport_assignments a join transport_requests t on t.id = a.job_id join job_statuses s on s.code = t.status_code
      where a.vehicle_id = $1 and a.is_current and s.stage in ('open','active') and t.deleted_at is null limit 5`,
    customers: `select t.job_number from transport_requests t join job_statuses s on s.code = t.status_code
      where t.customer_id = $1 and s.stage in ('draft','open','active') and t.deleted_at is null limit 5`,
  };
  if (openJobs[key]) {
    const jobs = await q(openJobs[key], [id]);
    if (jobs.length) throw new ApiError(409, 'IN_USE', `Can't remove: still on open job(s) ${jobs.map((j) => j.job_number).join(', ')}. Reassign or finish them first.`);
  }
  if (key === 'vehicle_types') {
    const used = await one('select count(*)::int n from vehicles where vehicle_type_id = $1 and deleted_at is null', [id]);
    if (used!.n) throw new ApiError(409, 'IN_USE', `Can't remove: ${used!.n} vehicle(s) use this type. Mark it inactive instead.`);
  }
  await tx(async (c) => {
    if (key === 'drivers')      // a removed driver can no longer use the phone app
      await c.query(`update users set is_active = false, token_version = token_version + 1, updated_at = now()
        where id = (select user_id from drivers where id = $1)`, [id]);
    const r = d.softDelete
      ? await c.query(`update ${d.table} set deleted_at = now() where id = $1 and deleted_at is null returning id`, [id])
      : await c.query(`delete from ${d.table} where id = $1 returning id`, [id]).catch(() => {
          throw new ApiError(409, 'IN_USE', 'This is used on existing jobs. Mark it inactive instead.');
        });
    if (!r.rowCount) throw notFound(cap(d.singular));
    await audit(c, actor, { entity_type: d.key, entity_id: id, action: `${cap(d.singular)} removed` });
  });
  return { ok: true };
}
