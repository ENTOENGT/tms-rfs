/**
 * Jobs service. Confidentiality is enforced in three independent layers:
 *  1. Query  — commercial tables (job_commercials, job_revenue_lines) are only
 *              joined when the caller has finance.selling.view.
 *  2. DTO    — responses are built field-by-field from a whitelist; nothing is
 *              spread from a DB row, so a new column can't leak by accident.
 *  3. Inputs — filters/sorts that could be used to infer hidden values
 *              (revenue range, profit sort...) are rejected, not ignored.
 */
import { PoolClient } from 'pg';
import { Actor } from './auth';
import { ApiError, audit, bad, Db, forbidden, getSetting, notFound, one, q, tx } from './db';
import { allowedTransitions } from './transitions';
import { fromFils, summariseCommercial, summariseCost, summariseProfit, toFils } from '../lib/finance';

// ---------------------------------------------------------------- read
const BASE_SELECT = `
  t.id, t.job_number, t.status_code, s.name status_name, s.color status_color, s.stage status_stage,
  t.priority, t.request_date, t.required_date, t.slot_from, t.slot_to,
  t.customer_id, c.name customer_name, t.customer_reference, t.email_subject,
  t.boe_number, t.shipment_number, t.booking_reference,
  t.requested_vehicle_type_id, rvt.name requested_vehicle_type,
  t.pickup_location_id, t.pickup_name, t.pickup_address, t.pickup_contact_person, t.pickup_contact_number,
  t.pickup_latitude, t.pickup_longitude,
  t.delivery_location_id, t.delivery_name, t.delivery_address, t.delivery_contact_person, t.delivery_contact_number,
  t.delivery_latitude, t.delivery_longitude,
  t.cargo_description, t.cargo_type, t.packages, t.weight_kg, t.volume_cbm, t.pallets,
  t.temperature_requirement, t.special_handling, t.special_instructions,
  t.pod_status, ps.name pod_status_name, t.cancel_reason, t.cancelled_at, t.completed_at,
  t.requested_by, ru.full_name requested_by_name, t.created_at, t.updated_at,
  a.driver_id, dr.full_name driver_name, dr.mobile driver_mobile,
  a.vehicle_id, ve.vehicle_number, a.vehicle_type_id assigned_vehicle_type_id, avt.name assigned_vehicle_type,
  a.planned_pickup_at, a.planned_delivery_at, a.actual_pickup_at, a.actual_delivery_at,
  a.assigned_at, au.full_name assigned_by_name`;

const BASE_FROM = `
  from transport_requests t
  join customers c on c.id = t.customer_id
  join job_statuses s on s.code = t.status_code
  join pod_statuses ps on ps.code = t.pod_status
  join users ru on ru.id = t.requested_by
  left join vehicle_types rvt on rvt.id = t.requested_vehicle_type_id
  left join transport_assignments a on a.job_id = t.id and a.is_current
  left join drivers dr on dr.id = a.driver_id
  left join vehicles ve on ve.id = a.vehicle_id
  left join vehicle_types avt on avt.id = a.vehicle_type_id
  left join users au on au.id = a.assigned_by`;

const COST_JOIN = `left join lateral (select coalesce(sum(amount),0) total_cost from job_cost_lines where job_id = t.id) cost on true`;
const COMM_JOIN = `left join job_commercials jc on jc.job_id = t.id
  left join lateral (select coalesce(sum(amount),0) gross from job_revenue_lines where job_id = t.id) rev on true`;

const pick = (row: any, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
const JOB_FIELDS = BASE_SELECT.split(',').map((f) => f.trim().split(/\s+/).pop()!.replace(/^\w+\./, ''));

function financialBlock(row: any, actor: Actor) {
  const out: Record<string, unknown> = {};
  let totalCost: string | null = null, net: string | null = null;
  if (actor.fin.buyingView) {
    totalCost = fromFils(toFils(row.total_cost ?? 0));
    out.cost = { total_cost: totalCost };
  }
  if (actor.fin.sellingView) {
    const c = summariseCommercial([{ amount: row.gross ?? 0 }], row.discount ?? 0, row.vat_rate ?? 0);
    net = c.net_revenue;
    out.commercial = { ...c, payment_status: row.payment_status ?? null };
  }
  if (actor.fin.profitView && totalCost !== null && net !== null) out.profit = summariseProfit(net, totalCost);
  return out;
}

export function toJobDTO(row: any, actor: Actor) {
  return { ...pick(row, JOB_FIELDS), financials: financialBlock(row, actor) };
}

function scope(actor: Actor, params: unknown[]) {
  if (actor.has('jobs.view_all')) return '';
  params.push(actor.id);
  return ` and t.requested_by = $${params.length}`;
}

export interface JobListQuery {
  q?: string; status?: string; customer_id?: string; date_from?: string; date_to?: string;
  boe?: string; job_number?: string; pod_status?: string; vehicle_type_id?: string;
  driver_id?: string; vehicle_id?: string; requested_by?: string; action_required?: string;
  revenue_min?: string; revenue_max?: string; profit_min?: string; profit_max?: string;
  sort?: string; dir?: string; page?: string; page_size?: string;
}

const SORTS: Record<string, { sql: string; needs?: 'buying' | 'selling' | 'profit' }> = {
  required_date: { sql: 't.required_date' }, request_date: { sql: 't.request_date' },
  job_number: { sql: 't.job_number' }, customer: { sql: 'c.name' }, status: { sql: 's.sort_order' },
  driver: { sql: 'dr.full_name' }, created_at: { sql: 't.created_at' },
  total_cost: { sql: 'cost.total_cost', needs: 'buying' },
  net_revenue: { sql: '(rev.gross - coalesce(jc.discount,0))', needs: 'selling' },
  profit: { sql: '(rev.gross - coalesce(jc.discount,0) - cost.total_cost)', needs: 'profit' },
};

export async function listJobs(actor: Actor, f: JobListQuery) {
  if (!actor.has('jobs.view')) throw forbidden();
  const { fin } = actor;
  const hidden = (what: string) => new ApiError(403, 'FORBIDDEN_FILTER', `You can't filter or sort by ${what}`);
  if ((f.revenue_min || f.revenue_max) && !fin.sellingView) throw hidden('revenue');
  if ((f.profit_min || f.profit_max) && !fin.profitView) throw hidden('profit');
  const sort = SORTS[f.sort ?? 'required_date'];
  if (!sort) throw bad('Unknown sort column');
  if (sort.needs === 'buying' && !fin.buyingView) throw hidden('cost');
  if (sort.needs === 'selling' && !fin.sellingView) throw hidden('revenue');
  if (sort.needs === 'profit' && !fin.profitView) throw hidden('profit');

  const p: unknown[] = [];
  const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
  let where = 'where t.deleted_at is null' + scope(actor, p);
  if (f.q?.trim()) where += ` and t.search_text like ${add('%' + f.q.trim().toLowerCase().replace(/[%_\\]/g, '\\$&') + '%')}`;
  if (f.status) where += ` and t.status_code = any(${add(f.status.split(','))})`;
  if (f.customer_id) where += ` and t.customer_id = ${add(f.customer_id)}`;
  if (f.date_from) where += ` and t.required_date >= ${add(f.date_from)}`;
  if (f.date_to) where += ` and t.required_date <= ${add(f.date_to)}`;
  if (f.boe) where += ` and t.boe_number ilike ${add('%' + f.boe + '%')}`;
  if (f.job_number) where += ` and t.job_number ilike ${add('%' + f.job_number + '%')}`;
  if (f.pod_status) where += ` and t.pod_status = any(${add(f.pod_status.split(','))})`;
  if (f.vehicle_type_id) where += ` and coalesce(a.vehicle_type_id, t.requested_vehicle_type_id) = ${add(f.vehicle_type_id)}`;
  if (f.driver_id) where += ` and a.driver_id = ${add(f.driver_id)}`;
  if (f.vehicle_id) where += ` and a.vehicle_id = ${add(f.vehicle_id)}`;
  if (f.requested_by) where += ` and t.requested_by = ${add(f.requested_by)}`;
  if (f.action_required === 'pod') where += ` and s.stage = 'delivered' and t.pod_status in ('pending','rejected')`;
  if (f.revenue_min) where += ` and (rev.gross - coalesce(jc.discount,0)) >= ${add(f.revenue_min)}`;
  if (f.revenue_max) where += ` and (rev.gross - coalesce(jc.discount,0)) <= ${add(f.revenue_max)}`;
  if (f.profit_min) where += ` and (rev.gross - coalesce(jc.discount,0) - cost.total_cost) >= ${add(f.profit_min)}`;
  if (f.profit_max) where += ` and (rev.gross - coalesce(jc.discount,0) - cost.total_cost) <= ${add(f.profit_max)}`;

  const size = Math.min(Math.max(Number(f.page_size) || 25, 1), 200);
  const page = Math.max(Number(f.page) || 1, 1);
  const dir = f.dir === 'asc' ? 'asc' : 'desc';
  const sql = `select ${BASE_SELECT}
      ${fin.buyingView ? ', cost.total_cost' : ''}
      ${fin.sellingView ? ', rev.gross, jc.discount, jc.vat_rate, jc.payment_status' : ''}
      , count(*) over() _total
    ${BASE_FROM}
    ${fin.buyingView ? COST_JOIN : ''}
    ${fin.sellingView ? COMM_JOIN : ''}
    ${where}
    order by ${sort.sql} ${dir} nulls last, t.job_number desc
    limit ${size} offset ${(page - 1) * size}`;
  const rows = await q(sql, p);
  return { total: Number(rows[0]?._total ?? 0), page, page_size: size, rows: rows.map((r) => toJobDTO(r, actor)) };
}

export async function getJob(actor: Actor, id: string) {
  if (!actor.has('jobs.view')) throw forbidden();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Job');
  const { fin } = actor;
  const p: unknown[] = [id];
  const row = await one(`select ${BASE_SELECT}
      ${fin.buyingView ? ', cost.total_cost' : ''}
      ${fin.sellingView ? ', rev.gross, jc.discount, jc.vat_rate, jc.payment_status' : ''}
    ${BASE_FROM} ${fin.buyingView ? COST_JOIN : ''} ${fin.sellingView ? COMM_JOIN : ''}
    where t.id = $1 and t.deleted_at is null ${scope(actor, p)}`, p);
  if (!row) throw notFound('Job');
  const job: any = toJobDTO(row, actor);

  if (fin.buyingView) {
    job.financials.cost.lines = (await q(
      `select l.id, l.expense_type_code, e.name expense_type, l.amount, l.description
         from job_cost_lines l join expense_types e on e.code = l.expense_type_code
        where l.job_id = $1 order by e.sort_order, l.created_at`, [id]))
      .map((l) => pick(l, ['id', 'expense_type_code', 'expense_type', 'amount', 'description']));
  }
  if (fin.sellingView) {
    job.financials.commercial.lines = (await q(
      `select l.id, l.revenue_type_code, r.name revenue_type, l.amount, l.description
         from job_revenue_lines l join revenue_types r on r.code = l.revenue_type_code
        where l.job_id = $1 order by r.sort_order, l.created_at`, [id]))
      .map((l) => pick(l, ['id', 'revenue_type_code', 'revenue_type', 'amount', 'description']));
  }
  const sens = ['general'];
  if (fin.buyingView) sens.push('cost');
  if (fin.sellingView) sens.push('commercial');
  job.activity = (await q(
    `select id, occurred_at, user_name, department_code, action, field, old_value, new_value
       from audit_log where job_id = $1 and sensitivity = any($2) order by occurred_at, id`, [id, sens]))
    .map((a) => pick(a, ['id', 'occurred_at', 'user_name', 'department_code', 'action', 'field', 'old_value', 'new_value']));
  job.notes = (await q(
    `select n.id, n.body, n.visibility, n.created_at, u.full_name author
       from job_notes n join users u on u.id = n.user_id
      where n.job_id = $1 and n.deleted_at is null and ($2 or n.visibility = 'all') order by n.created_at`,
    [id, fin.sellingView])).map((n) => pick(n, ['id', 'body', 'visibility', 'created_at', 'author']));
  job.documents = (await q(
    `select d.id, d.document_type_code, dt.name document_type, d.file_name, d.mime_type, d.size_bytes, d.created_at
       from job_documents d join document_types dt on dt.code = d.document_type_code
      where d.job_id = $1 and d.deleted_at is null and ($2 or not dt.is_commercial) order by d.created_at`,
    [id, fin.sellingView && actor.has('documents.view_commercial')]))
    .map((d) => pick(d, ['id', 'document_type_code', 'document_type', 'file_name', 'mime_type', 'size_bytes', 'created_at']));
  const stage = row.status_stage;
  const editPerm = ['draft', 'open'].includes(stage) ? 'jobs.edit' : stage === 'active' ? 'jobs.edit_assigned' : stage === 'cancelled' ? null : 'jobs.edit_completed';
  const locked = ['closed', 'cancelled'].includes(stage) && !actor.has('jobs.edit_completed');
  job.permissions = {
    edit_cost: fin.buyingEdit && !locked, edit_selling: fin.sellingEdit && !locked,
    edit_request: !!editPerm && actor.has(editPerm as any),
    assign: (actor.has('jobs.assign_driver') || actor.has('jobs.assign_vehicle')) &&
      (['requested', 'pending_assignment', 'assigned', 'confirmed'].includes(row.status_code) || (stage === 'active' && actor.has('jobs.override_conflicts'))),
    override_conflicts: actor.has('jobs.override_conflicts'),
    update_status: actor.has('jobs.update_status'), upload_pod: actor.has('pod.upload'),
    pod_requirement: actor.has('pod.verify') && !['closed', 'cancelled'].includes(stage),
  };
  job.next_statuses = locked ? [] : await allowedTransitions(actor, row);
  return job;
}

// ---------------------------------------------------------------- create
const s = (v: unknown, max = 500) => {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  if (t.length > max) throw bad(`Value too long (max ${max} characters)`);
  return t === '' ? null : t;
};
const n = (v: unknown, label: string) => {
  if (v === undefined || v === null || v === '') return null;
  const x = Number(v);
  if (!Number.isFinite(x) || x < 0) throw bad(`${label} must be a positive number`);
  return x;
};
const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v: unknown) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);

async function locationSnapshot(db: Db, prefix: 'pickup' | 'delivery', b: any) {
  const id = s(b[`${prefix}_location_id`]);
  if (id) {
    const l = await one('select * from locations where id = $1 and deleted_at is null', [id], db);
    if (!l) throw bad(`Saved ${prefix} location not found`);
    return { id, name: l.name, address: l.address, contact_person: l.contact_person, contact_number: l.contact_number,
      latitude: l.latitude, longitude: l.longitude };
  }
  const name = s(b[`${prefix}_name`], 200);
  if (!name) throw bad(`${prefix === 'pickup' ? 'Pickup' : 'Delivery'} location is required`);
  return { id: null, name, address: s(b[`${prefix}_address`]), contact_person: s(b[`${prefix}_contact_person`], 120),
    contact_number: s(b[`${prefix}_contact_number`], 40), latitude: n(b[`${prefix}_latitude`], 'Latitude'),
    longitude: n(b[`${prefix}_longitude`], 'Longitude') };
}

export async function usersWithPermission(db: Db, perm: string, excludeId?: string) {
  return q<{ id: string }>(
    `select u.id from users u join roles r on r.id = u.role_id
      where u.is_active and u.deleted_at is null and r.code <> 'super_admin' and u.id is distinct from $2
        and ((exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_code = $1)
              and not exists (select 1 from user_permission_overrides o where o.user_id = u.id and o.permission_code = $1 and not o.granted))
             or exists (select 1 from user_permission_overrides o where o.user_id = u.id and o.permission_code = $1 and o.granted))`,
    [perm, excludeId ?? null], db);
}
async function notify(db: Db, userIds: string[], type: string, title: string, jobId: string) {
  // Titles come from fixed templates with the job number only — never amounts.
  for (const uid of userIds)
    await db.query('insert into notifications (user_id, type, title, job_id) values ($1,$2,$3,$4)', [uid, type, title, jobId]);
}

export async function createJob(actor: Actor, b: any) {
  if (!actor.has('jobs.create')) throw forbidden();
  const sellingFields = ['base_selling_price', 'additional_selling_charges', 'discount'];
  if (sellingFields.some((k) => b[k] !== undefined && b[k] !== '' && b[k] !== null) && !actor.fin.sellingEdit)
    throw forbidden('You do not have permission to set the selling price');

  if (!isDate(b.required_date)) throw bad('Required date is missing or invalid');
  const tz = await getSetting<string>('timezone', 'Asia/Dubai');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  if (b.required_date < today && !actor.has('jobs.backdate')) throw bad('Required date cannot be in the past');
  if (b.slot_from && !isTime(b.slot_from)) throw bad('Time slot "from" is invalid');
  if (b.slot_to && !isTime(b.slot_to)) throw bad('Time slot "to" is invalid');
  if (b.slot_from && b.slot_to && b.slot_to <= b.slot_from) throw bad('Time slot must end after it starts');
  if (!s(b.customer_id)) throw bad('Customer is required');
  const priority = b.priority ?? 'normal';
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) throw bad('Invalid priority');

  return tx(async (c) => {
    const cust = await one('select id from customers where id = $1 and deleted_at is null and is_active', [b.customer_id], c);
    if (!cust) throw bad('Customer not found');
    if (b.requested_vehicle_type_id) {
      const vt = await one('select id from vehicle_types where id = $1 and is_active', [b.requested_vehicle_type_id], c);
      if (!vt) throw bad('Vehicle type not found');
    }
    const boe = s(b.boe_number, 60);
    if (boe && !b.confirm_duplicate_boe) {
      const dups = await q(`select job_number from transport_requests
          where upper(trim(boe_number)) = upper($1) and deleted_at is null and status_code <> 'cancelled' limit 10`, [boe], c);
      if (dups.length) throw new ApiError(409, 'BOE_DUPLICATE',
        `BOE ${boe} is already on ${dups.map((d) => d.job_number).join(', ')}. Submit again to confirm it's intended.`,
        { job_numbers: dups.map((d) => d.job_number) });
    }
    const pu = await locationSnapshot(c, 'pickup', b);
    const de = await locationSnapshot(c, 'delivery', b);
    const prefix = await getSetting<string>('job_number_prefix', 'JOB-', c);
    const vatRate = await getSetting<number>('vat_rate', 5, c);
    const dept = await one('select department_id from users where id = $1', [actor.id], c);

    const job = await one<{ id: string; job_number: string }>(
      `insert into transport_requests (job_number, status_code, priority, required_date, slot_from, slot_to,
         department_id, requested_by, customer_id, customer_reference, email_subject, boe_number, shipment_number,
         booking_reference, requested_vehicle_type_id,
         pickup_location_id, pickup_name, pickup_address, pickup_contact_person, pickup_contact_number, pickup_latitude, pickup_longitude,
         delivery_location_id, delivery_name, delivery_address, delivery_contact_person, delivery_contact_number, delivery_latitude, delivery_longitude,
         cargo_description, cargo_type, packages, weight_kg, volume_cbm, pallets, temperature_requirement, special_handling, special_instructions)
       values ($1 || nextval('job_number_seq'), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38)
       returning id, job_number`,
      [prefix, b.save_as_draft ? 'draft' : 'pending_assignment', priority, b.required_date, b.slot_from || null, b.slot_to || null,
       dept?.department_id ?? null, actor.id, b.customer_id, s(b.customer_reference, 120), s(b.email_subject, 300), boe,
       s(b.shipment_number, 60), s(b.booking_reference, 60), b.requested_vehicle_type_id || null,
       pu.id, pu.name, pu.address, pu.contact_person, pu.contact_number, pu.latitude, pu.longitude,
       de.id, de.name, de.address, de.contact_person, de.contact_number, de.latitude, de.longitude,
       s(b.cargo_description, 2000), s(b.cargo_type, 80), n(b.packages, 'Packages'), n(b.weight_kg, 'Weight'),
       n(b.volume_cbm, 'Volume'), n(b.pallets, 'Pallets'), s(b.temperature_requirement, 80),
       s(b.special_handling, 500), s(b.special_instructions, 2000)], c);
    if (!job) throw new Error('Insert failed');

    await c.query('insert into job_commercials (job_id, vat_rate) values ($1, $2)', [job.id, vatRate]);
    await audit(c, actor, { entity_type: 'job', entity_id: job.id, job_id: job.id,
      action: b.save_as_draft ? 'Draft created' : 'Transport request created' });

    if (actor.fin.sellingEdit && (b.base_selling_price || b.additional_selling_charges || b.discount)) {
      const lines = [
        { type: 'base', amount: b.base_selling_price, description: null },
        { type: 'additional', amount: b.additional_selling_charges, description: null },
      ].filter((l) => l.amount !== undefined && l.amount !== null && l.amount !== '' && toFils(l.amount) > 0);
      await writeSelling(c, actor, job.id, { lines, discount: b.discount ?? 0 });
    }
    await c.query('select refresh_job_search($1)', [job.id]);
    if (!b.save_as_draft) {
      const transport = await usersWithPermission(c, 'jobs.assign_driver', actor.id);
      await notify(c, transport.map((u) => u.id), 'job.created', `New transport request ${job.job_number}`, job.id);
    }
    return job;
  });
}

// ---------------------------------------------------------------- financials
interface LineIn { type: string; amount: unknown; description?: unknown }

function parseLines(lines: unknown, valid: Set<string>, label: string): LineIn[] {
  if (!Array.isArray(lines)) throw bad(`${label} lines must be a list`);
  if (lines.length > 30) throw bad('Too many lines');
  return lines.map((l: any) => {
    if (!valid.has(l?.type)) throw bad(`Unknown ${label.toLowerCase()} type: ${l?.type}`);
    try { if (toFils(l.amount) < 0) throw new Error(); } catch { throw bad(`Invalid amount for ${l.type}`); }
    return { type: l.type, amount: fromFils(toFils(l.amount)), description: s(l.description, 200) };
  });
}
const byType = (rows: { t: string; amount: string }[]) => {
  const m = new Map<string, number>();
  rows.forEach((r) => m.set(r.t, (m.get(r.t) ?? 0) + toFils(r.amount)));
  return m;
};

async function writeCost(c: PoolClient, actor: Actor, jobId: string, lines: LineIn[]) {
  const before = await q('select expense_type_code t, amount from job_cost_lines where job_id = $1', [jobId], c);
  await c.query('delete from job_cost_lines where job_id = $1', [jobId]);
  for (const l of lines)
    await c.query('insert into job_cost_lines (job_id, expense_type_code, amount, description, created_by) values ($1,$2,$3,$4,$5)',
      [jobId, l.type, l.amount, l.description, actor.id]);
  const a = byType(before), b = byType(lines.map((l) => ({ t: l.type, amount: String(l.amount) })));
  for (const t of new Set([...a.keys(), ...b.keys()])) {
    if ((a.get(t) ?? 0) === (b.get(t) ?? 0)) continue;
    await audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId, action: 'Transport cost changed',
      field: `cost.${t}`, old_value: fromFils(a.get(t) ?? 0), new_value: fromFils(b.get(t) ?? 0), sensitivity: 'cost' });
  }
  const oldT = summariseCost(before).total_cost, newT = summariseCost(lines.map((l) => ({ amount: String(l.amount) }))).total_cost;
  if (oldT !== newT) await audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId,
    action: 'Total transport cost changed', field: 'total_cost', old_value: oldT, new_value: newT, sensitivity: 'cost' });
}

async function writeSelling(c: PoolClient, actor: Actor, jobId: string, sel: { lines: any[]; discount: unknown }) {
  const before = await q('select revenue_type_code t, amount from job_revenue_lines where job_id = $1', [jobId], c);
  const jc = await one('select discount, vat_rate from job_commercials where job_id = $1 for update', [jobId], c);
  const lines = sel.lines.map((l) => ({ type: l.type, amount: fromFils(toFils(l.amount)), description: l.description ?? null }));
  let discount: string;
  try { discount = fromFils(toFils(sel.discount as any)); } catch { throw bad('Invalid discount'); }
  try { summariseCommercial(lines, discount, jc.vat_rate); } catch (e: any) { throw bad(e.message); }
  await c.query('delete from job_revenue_lines where job_id = $1', [jobId]);
  for (const l of lines)
    await c.query('insert into job_revenue_lines (job_id, revenue_type_code, amount, description, created_by) values ($1,$2,$3,$4,$5)',
      [jobId, l.type, l.amount, l.description, actor.id]);
  await c.query('update job_commercials set discount = $2, updated_by = $3, updated_at = now() where job_id = $1', [jobId, discount, actor.id]);
  const a = byType(before), b = byType(lines.map((l) => ({ t: l.type, amount: l.amount })));
  for (const t of new Set([...a.keys(), ...b.keys()])) {
    if ((a.get(t) ?? 0) === (b.get(t) ?? 0)) continue;
    await audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId, action: 'Selling price changed',
      field: `selling.${t}`, old_value: fromFils(a.get(t) ?? 0), new_value: fromFils(b.get(t) ?? 0), sensitivity: 'commercial' });
  }
  if (toFils(jc.discount) !== toFils(discount)) await audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId,
    action: 'Discount changed', field: 'discount', old_value: fromFils(toFils(jc.discount)), new_value: discount, sensitivity: 'commercial' });
}

export async function updateFinancials(actor: Actor, jobId: string, b: any) {
  if (b.cost === undefined && b.selling === undefined) throw bad('Nothing to update');
  if (b.cost !== undefined && !actor.fin.buyingEdit) throw forbidden('You do not have permission to edit transport cost');
  if (b.selling !== undefined && !actor.fin.sellingEdit) throw forbidden('You do not have permission to edit the selling price');
  const expense = new Set((await q('select code from expense_types where is_active')).map((r) => r.code));
  const revenue = new Set((await q('select code from revenue_types where is_active')).map((r) => r.code));
  const costLines = b.cost !== undefined ? parseLines(b.cost?.lines, expense, 'Cost') : null;
  const sellLines = b.selling !== undefined ? parseLines(b.selling?.lines, revenue, 'Selling') : null;

  await tx(async (c) => {
    const p: unknown[] = [jobId];
    const job = await one(`select t.id, s.stage from transport_requests t join job_statuses s on s.code = t.status_code
        where t.id = $1 and t.deleted_at is null ${scope(actor, p)} for update of t`, p, c);
    if (!job) throw notFound('Job');
    if (['closed', 'cancelled'].includes(job.stage) && !actor.has('jobs.edit_completed'))
      throw new ApiError(409, 'JOB_LOCKED', 'This job is closed. Only users allowed to edit completed jobs can change it.');
    if (costLines) await writeCost(c, actor, jobId, costLines);
    if (sellLines) await writeSelling(c, actor, jobId, { lines: sellLines, discount: b.selling?.discount ?? 0 });
    await c.query('update transport_requests set updated_at = now() where id = $1', [jobId]);
  });
  return getJob(actor, jobId);
}

// ---------------------------------------------------------------- dashboard
export async function dashboard(actor: Actor, from: string, to: string) {
  if (!actor.has('jobs.view')) throw forbidden();
  if (!isDate(from) || !isDate(to)) throw bad('Invalid period');
  const { fin } = actor;
  const tz = await getSetting<string>('timezone', 'Asia/Dubai');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const p: unknown[] = [from, to, today];
  const sc = scope(actor, p);
  const k = await one(`select
      count(*) filter (where t.required_date = $3) today_jobs,
      count(*) filter (where t.status_code in ('requested','pending_assignment')) pending,
      count(*) filter (where t.status_code in ('assigned','confirmed')) assigned,
      count(*) filter (where t.status_code in ('dispatched','picked_up','in_transit')) in_transit,
      count(*) filter (where s.stage = 'delivered') delivered,
      count(*) filter (where s.stage = 'delivered' and t.pod_status in ('pending','rejected')) pod_pending,
      count(*) filter (where t.status_code = 'completed') completed,
      count(*) filter (where t.status_code <> 'cancelled') total_jobs
    from transport_requests t join job_statuses s on s.code = t.status_code
    where t.deleted_at is null and t.required_date between $1 and $2 ${sc}`, p);
  const kpis: Record<string, unknown> = Object.fromEntries(Object.entries(k!).map(([key, v]) => [key, Number(v)]));
  // today's count must not depend on the chosen period
  const tp: unknown[] = [today];
  kpis.today_jobs = Number((await one(`select count(*) n from transport_requests t where t.deleted_at is null
      and t.status_code <> 'cancelled' and t.required_date = $1 ${scope(actor, tp)}`, tp))!.n);

  if (fin.buyingView || fin.sellingView) {
    const fp: unknown[] = [from, to];
    const f = await one(`select
        ${fin.buyingView ? 'coalesce(sum(cost.total_cost),0) total_cost' : 'null'} ,
        ${fin.sellingView ? 'coalesce(sum(rev.gross - coalesce(jc.discount,0)),0) net_revenue' : 'null'}
      from transport_requests t
      ${fin.buyingView ? COST_JOIN : ''} ${fin.sellingView ? COMM_JOIN : ''}
      where t.deleted_at is null and t.status_code <> 'cancelled' and t.required_date between $1 and $2 ${scope(actor, fp)}`, fp);
    const out: Record<string, unknown> = {};
    if (fin.buyingView) out.total_cost = fromFils(toFils(f.total_cost));
    if (fin.sellingView) out.net_revenue = fromFils(toFils(f.net_revenue));
    if (fin.profitView) out.profit = summariseProfit(out.net_revenue as string, out.total_cost as string);
    kpis.financials = out;
  }
  return kpis;
}
