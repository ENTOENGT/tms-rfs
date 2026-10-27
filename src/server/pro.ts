/**
 * PRO & Container Clearance.
 *
 * PRO staff coordinate clearance with Customs, ports, municipalities, free zones and other authorities.
 * This is separate from Messenger runs (which only carry documents): own tables, statuses, assignments, reports.
 *
 *   pro_requests    one per clearance job (system PRO Request No. + the company's typed Job No.)
 *   pro_containers  each container tracked on its own: customs, inspection, release
 *   pro_activities  several authority activities per request (or per container), each with its own status
 *   pro_charges     actual or estimated fees, payment status, receipt — never booked into accounts
 *   pro_documents   files on the request or an activity; replacing keeps the older version
 *   pro_history     every change: status, activity, container, assignment, note, document, charge
 *
 * Who sees what (proScope):
 *   pro.view_all          Documentation Manager, Finance, Super Admin → everything
 *   pro.view_department   Operations → their department's requests (+ ones they raised)
 *   otherwise             requests they raised, or are the PRO officer on (request or an activity)
 *
 * Milestones are kept apart on purpose: Customs cleared ≠ container released ≠ request completed.
 * "Completed" is only allowed when every activity is finished (or not required) and every container
 * is released (or release is not required). Nothing is completed automatically.
 *
 * No government or port system is connected: everything is updated by hand, with official evidence attached.
 * (A future integration would write through the same functions — updateActivity / updateContainer.)
 */
import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { Actor, requirePerm } from './auth';
import { ApiError, audit, bad, Db, forbidden, getSetting, notFound, one, pool, q, tx } from './db';
import { fileStore } from './storage';
import { sign, unsign, MAX_BYTES } from './documents';
import { jobNoProblem } from '../lib/requestRules';

const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const DOC_TYPES: [string, string][] = [
  ['commercial_invoice', 'Commercial Invoice'], ['packing_list', 'Packing List'], ['bill_of_lading', 'Bill of Lading'],
  ['certificate_of_origin', 'Certificate of Origin'], ['customs_declaration', 'Customs Declaration / BOE'],
  ['permit', 'Import or Export Permit'], ['delivery_order', 'Delivery Order'], ['customs_payment_receipt', 'Customs Payment Receipt'],
  ['inspection_report', 'Inspection Report'], ['authority_approval', 'Municipality / authority approval'], ['gate_pass', 'Gate Pass'],
  ['clearance_proof', 'Customs Clearance Certificate / proof'], ['release_confirmation', 'Container Release Confirmation'],
  ['other', 'Other Supporting Documents'],
];
const DOC_NAME = Object.fromEntries(DOC_TYPES);
export const CHARGE_CATEGORIES: [string, string][] = [
  ['customs_duty', 'Customs duty'], ['customs_fee', 'Customs fees'], ['port_charges', 'Port / terminal charges'],
  ['inspection_fee', 'Inspection fee'], ['municipality_fee', 'Municipality fee'], ['permit_fee', 'Permit / certificate fee'],
  ['delivery_order', 'Delivery order charges'], ['storage_demurrage', 'Storage / demurrage'], ['other', 'Other'],
];
const CHARGE_NAME = Object.fromEntries(CHARGE_CATEGORIES);
export const ACTIVITY_STATUS: [string, string][] = [
  ['not_started', 'Not started'], ['documents_required', 'Documents required'], ['submitted', 'Submitted to authority'],
  ['pending_inspection', 'Pending inspection'], ['inspection_in_progress', 'Inspection in progress'], ['pending_approval', 'Pending approval'],
  ['payment_pending', 'Payment pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['completed', 'Completed'],
  ['not_required', 'Not required'], ['on_hold', 'On hold'],
];
const ACT_NAME = Object.fromEntries(ACTIVITY_STATUS);
/** An activity counts as finished for completion when it is one of these. */
const ACT_DONE = ['approved', 'completed', 'not_required'];
const CONTAINER_LABEL: Record<string, Record<string, string>> = {
  customs_status: { pending: 'Pending', cleared: 'Cleared', held: 'Held by Customs' },
  inspection_status: { not_required: 'Not required', pending: 'Pending', scheduled: 'Scheduled', in_progress: 'In progress', passed: 'Passed', failed: 'Failed' },
  release_status: { pending: 'Not yet', release_pending: 'Release pending', released: 'Released', not_required: 'Not required' },
};
const MAX_FILE = MAX_BYTES;
const FILE_TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

// ------------------------------------------------------------ who sees / does what
export const canSeePro = (a: Actor) => ['pro.view_all', 'pro.view_department', 'pro.create', 'pro.update', 'pro.assign'].some((p) => a.has(p as any));
export function proScope(actor: Actor, params: unknown[], alias = 'r'): string {
  if (actor.has('pro.view_all')) return '';
  params.push(actor.id);
  const me = `$${params.length}`;
  const mine = `${alias}.requested_by = ${me} or ${alias}.assigned_to = ${me}
    or exists (select 1 from pro_activities sa where sa.request_id = ${alias}.id and sa.deleted_at is null and (sa.assigned_to = ${me} or sa.next_action_by = ${me}))`;
  if (actor.has('pro.view_department') && actor.department_id) {
    params.push(actor.department_id);
    return ` and (${alias}.department_id = $${params.length} or ${mine})`;
  }
  return ` and (${mine})`;
}

async function loadRequest(actor: Actor, id: string, db?: Db, lock = false) {
  if (!canSeePro(actor)) throw forbidden();
  if (!isUuid(id)) throw notFound('PRO request');
  const p: unknown[] = [id];
  const r = await one(`select r.*, s.name status_name, s.stage, s.color status_color from pro_requests r join pro_statuses s on s.code = r.status_code
    where r.id = $1 and r.deleted_at is null${proScope(actor, p)}${lock ? ' for update of r' : ''}`, p, db);
  if (!r) throw notFound('PRO request');
  return r;
}
/** May work on the clearance: supervisors, or the officer on the request / an activity. */
async function canWork(actor: Actor, r: any, db?: Db) {
  if (actor.isSuperAdmin || actor.has('pro.assign')) return true;
  if (!actor.has('pro.update')) return false;
  if (r.assigned_to === actor.id) return true;
  return !!(await one('select 1 from pro_activities where request_id = $1 and deleted_at is null and (assigned_to = $2 or next_action_by = $2) limit 1', [r.id, actor.id], db));
}
const closed = (r: any) => ['done', 'cancelled'].includes(r.stage);
function requireOpen(actor: Actor, r: any) {
  if (closed(r) && !actor.isSuperAdmin && !actor.has('pro.assign'))
    throw new ApiError(409, 'PRO_CLOSED', `This request is ${r.status_name.toLowerCase()}. Ask the Documentation Manager to reopen it.`);
}

async function history(db: Db, actor: Actor | null, h: { request_id: string; kind: string; field?: string; old_value?: unknown; new_value?: unknown;
  remarks?: string | null; activity_id?: string | null; container_id?: string | null; document_id?: string | null }) {
  const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, 1000));
  await db.query(`insert into pro_history (request_id, activity_id, container_id, kind, field, old_value, new_value, remarks, document_id, user_id, user_name)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [h.request_id, h.activity_id ?? null, h.container_id ?? null, h.kind, h.field ?? null, str(h.old_value), str(h.new_value),
     str(h.remarks), h.document_id ?? null, actor?.id ?? null, actor?.full_name ?? 'System']);
}
async function notify(db: Db, userIds: (string | null | undefined)[], type: string, title: string, proId: string, exclude?: string) {
  for (const uid of [...new Set(userIds.filter((u): u is string => !!u && u !== exclude))])
    await db.query('insert into notifications (user_id, type, title, pro_id) values ($1,$2,$3,$4)', [uid, type, title, proId]);
}
const supervisors = (db: Db) => q<{ id: string }>(`select u.id from users u join roles r on r.id = u.role_id
  where u.is_active and u.deleted_at is null and r.code <> 'super_admin' and user_has_perm(u.id, 'pro.assign')`, [], db);
const ref = (r: any) => `${r.request_no} (Job No. ${r.job_no})`;

async function refreshSearch(db: Db, id: string) {
  await db.query(`update pro_requests r set search_text = lower(concat_ws(' ', r.request_no, r.job_no, r.bl_number, r.shipment_reference,
      r.vessel, r.voyage, r.uae_location, r.port_of_origin, r.port_of_destination, c.name,
      (select string_agg(container_no, ' ') from pro_containers where request_id = r.id and deleted_at is null),
      (select string_agg(reference_no, ' ') from pro_activities where request_id = r.id and deleted_at is null)))
    from customers c where r.id = $1 and c.id = r.customer_id`, [id]);
}

// ------------------------------------------------------------ validation
const txt = (v: unknown, max = 500) => {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  if (t.length > max) throw bad(`Value too long (max ${max} characters)`);
  return t || null;
};
const day = (v: unknown, label: string) => {
  if (v === undefined || v === null || v === '') return null;
  if (!DATE.test(String(v))) throw bad(`${label} is not a valid date`);
  return String(v);
};
/** ISO 6346 check digit (the last digit of a container number). */
export function containerCheckOk(no: string) {
  const val = (ch: string) => {
    if (/\d/.test(ch)) return Number(ch);
    let v = ch.charCodeAt(0) - 55;              // A=10 …
    v += Math.floor((v - 1) / 10);              // skip 11, 22, 33
    return v;
  };
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += val(no[i]) * 2 ** i;
  return (sum % 11) % 10 === Number(no[10]);
}
export function normContainer(v: unknown) {
  const s = String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z]{4}\d{7}$/.test(s)) throw bad(`Container "${String(v ?? '').trim()}" should be 4 letters and 7 digits, e.g. MSCU1234565`);
  return s;
}

// ------------------------------------------------------------ list + dashboard
/** Dashboard tiles. Each tile is also a filter (?view=…) on the list, so every number opens its records. */
export const VIEWS: Record<string, { label: string; sql: string; containers?: boolean }> = {
  open: { label: 'Open requests', sql: `s.stage in ('open','active','hold')` },
  awaiting_assignment: { label: 'Awaiting assignment', sql: `s.stage in ('open','active') and r.assigned_to is null` },
  docs_review: { label: 'Documents under review / required', sql: `r.status_code in ('docs_review','docs_required')
    or exists (select 1 from pro_activities x where x.request_id = r.id and x.deleted_at is null and x.status = 'documents_required')` },
  awaiting_approval: { label: 'Awaiting authority approval', sql: `s.stage in ('active','hold') and (r.status_code in ('submitted_authority','pending_approval')
    or exists (select 1 from pro_activities x where x.request_id = r.id and x.deleted_at is null and x.status in ('submitted','pending_approval')))` },
  awaiting_inspection: { label: 'Awaiting inspection', sql: `s.stage in ('active','hold') and (r.status_code in ('pending_inspection','inspection_in_progress')
    or exists (select 1 from pro_activities x where x.request_id = r.id and x.deleted_at is null and x.status in ('pending_inspection','inspection_in_progress'))
    or exists (select 1 from pro_containers k where k.request_id = r.id and k.deleted_at is null and k.inspection_status in ('pending','scheduled','in_progress')))` },
  pending_payment: { label: 'Payments pending', sql: `s.stage in ('open','active','hold') and (r.status_code = 'payment_pending'
    or exists (select 1 from pro_activities x where x.request_id = r.id and x.deleted_at is null and x.status = 'payment_pending')
    or exists (select 1 from pro_charges g where g.request_id = r.id and g.deleted_at is null and not g.is_estimate and g.payment_status = 'unpaid'))` },
  cleared_awaiting_release: { label: 'Customs cleared, awaiting release', containers: true, sql: `exists (select 1 from pro_containers k where k.request_id = r.id
    and k.deleted_at is null and k.customs_status = 'cleared' and k.release_status in ('pending','release_pending'))` },
  released: { label: 'Containers released', containers: true, sql: `exists (select 1 from pro_containers k where k.request_id = r.id and k.deleted_at is null and k.release_status = 'released')` },
  overdue: { label: 'Overdue', sql: `s.stage in ('open','active','hold') and coalesce(r.deadline, r.required_date) < (now() at time zone 'Asia/Dubai')::date` },
  on_hold: { label: 'On hold', sql: `s.stage = 'hold'` },
  completed: { label: 'Completed', sql: `s.stage = 'done'` },
};

function filterSql(actor: Actor, f: Record<string, string>, params: unknown[]) {
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const like = (v: string) => add('%' + v.trim().toLowerCase().replace(/[%_\\]/g, '\\$&') + '%');
  let w = `where r.deleted_at is null` + proScope(actor, params);
  if (f.q?.trim()) w += ` and r.search_text like ${like(f.q)}`;
  if (f.job_no?.trim()) w += ` and lower(r.job_no) like ${like(f.job_no)}`;
  if (f.container?.trim()) w += ` and exists (select 1 from pro_containers k where k.request_id = r.id and k.deleted_at is null and lower(k.container_no) like ${like(f.container.replace(/[\s-]/g, ''))})`;
  if (f.port?.trim()) w += ` and lower(r.uae_location) like ${like(f.port)}`;
  for (const [k, col] of Object.entries({ customer_id: 'r.customer_id', assigned_to: 'r.assigned_to', department_id: 'r.department_id' }))
    if (f[k]) { if (!isUuid(f[k])) throw bad('Invalid filter'); w += ` and ${col} = ${add(f[k])}`; }
  if (f.authority_id) {
    if (!isUuid(f.authority_id)) throw bad('Invalid filter');
    w += ` and exists (select 1 from pro_activities x where x.request_id = r.id and x.deleted_at is null and x.authority_id = ${add(f.authority_id)})`;
  }
  if (f.status) w += ` and r.status_code = any(${add(f.status.split(','))})`;
  if (f.priority) w += ` and r.priority = ${add(f.priority)}`;
  if (f.date_from) { if (!DATE.test(f.date_from)) throw bad('Invalid date'); w += ` and r.request_date >= ${add(f.date_from)}`; }
  if (f.date_to) { if (!DATE.test(f.date_to)) throw bad('Invalid date'); w += ` and r.request_date <= ${add(f.date_to)}`; }
  if (f.mine === '1') w += ` and (r.assigned_to = ${add(actor.id)} or exists (select 1 from pro_activities x where x.request_id = r.id and x.deleted_at is null and x.assigned_to = ${add(actor.id)}))`;
  if (f.view) { const v = VIEWS[f.view]; if (!v) throw bad('Unknown view'); w += ` and (${v.sql})`; }
  return w;
}

const LIST_COLS = `r.id, r.request_no, r.job_no, r.job_id, r.bl_number, r.direction, r.load_type, r.uae_location, r.priority,
  r.request_date, r.required_date, coalesce(r.deadline, r.required_date) deadline, r.status_code, s.name status_name, s.color status_color, s.stage,
  r.customs_cleared_at, r.completed_at, c.name customer_name, au.full_name assigned_to_name, r.assigned_to, dep.name department_name,
  (s.stage in ('open','active','hold') and coalesce(r.deadline, r.required_date) < (now() at time zone 'Asia/Dubai')::date) overdue,
  (select count(*)::int from pro_containers k where k.request_id = r.id and k.deleted_at is null) containers,
  (select count(*)::int from pro_containers k where k.request_id = r.id and k.deleted_at is null and k.release_status = 'released') containers_released,
  (select string_agg(k.container_no, ', ' order by k.container_no) from pro_containers k where k.request_id = r.id and k.deleted_at is null) container_list,
  (select string_agg(distinct a2.name, ', ') from pro_activities x join pro_authorities a2 on a2.id = x.authority_id
     where x.request_id = r.id and x.deleted_at is null and x.status not in ('approved','completed','not_required')) pending_authorities`;
const LIST_FROM = `from pro_requests r join pro_statuses s on s.code = r.status_code join customers c on c.id = r.customer_id
  left join users au on au.id = r.assigned_to left join departments dep on dep.id = r.department_id`;

export async function listPro(actor: Actor, f: Record<string, string>) {
  if (!canSeePro(actor)) throw forbidden();
  const params: unknown[] = [];
  const where = filterSql(actor, f, params);
  const size = Math.min(Math.max(Number(f.page_size) || 50, 1), 200), page = Math.max(Number(f.page) || 1, 1);
  const SORT: Record<string, string> = { request_no: 'r.request_no', job_no: 'upper(r.job_no)', deadline: 'coalesce(r.deadline, r.required_date)',
    customer: 'c.name', status: 's.sort_order', priority: `case r.priority when 'critical' then 0 when 'urgent' then 1 else 2 end`, request_date: 'r.request_date' };
  const sort = SORT[f.sort ?? ''] ?? `case when s.stage in ('done','cancelled') then 1 else 0 end, coalesce(r.deadline, r.required_date)`;
  const rows = await q(`select ${LIST_COLS}, count(*) over() _total ${LIST_FROM} ${where}
    order by ${sort} ${f.dir === 'desc' ? 'desc' : 'asc'} nulls last, r.request_no desc limit ${size} offset ${(page - 1) * size}`, params);
  return { total: Number(rows[0]?._total ?? 0), page, page_size: size, rows: rows.map(({ _total, ...r }) => r) };
}

export async function proDashboard(actor: Actor, f: Record<string, string>) {
  if (!canSeePro(actor)) throw forbidden();
  const params: unknown[] = [];
  const where = filterSql(actor, { ...f, view: '' }, params);
  const counts = await one(`select ${Object.entries(VIEWS).map(([k, v]) => `count(*) filter (where ${v.sql})::int ${k}`).join(', ')}
    ${LIST_FROM} ${where}`, params);
  // two tiles count containers, not requests
  const p2: unknown[] = [];
  const w2 = filterSql(actor, { ...f, view: '' }, p2);
  const cont = await one(`select count(*) filter (where k.customs_status = 'cleared' and k.release_status in ('pending','release_pending'))::int cleared_awaiting_release,
      count(*) filter (where k.release_status = 'released')::int released
    from pro_containers k join pro_requests r on r.id = k.request_id join pro_statuses s on s.code = r.status_code
    join customers c on c.id = r.customer_id left join users au on au.id = r.assigned_to left join departments dep on dep.id = r.department_id
    ${w2} and k.deleted_at is null`, p2);
  return { tiles: Object.entries(VIEWS).map(([key, v]) => ({ key, label: v.label, count: v.containers ? cont![key] : counts![key], unit: v.containers ? 'containers' : 'requests' })) };
}

/** Container-by-container overview (each container's own stage, pending authority, payment, delay). */
export async function listContainers(actor: Actor, f: Record<string, string>) {
  if (!canSeePro(actor)) throw forbidden();
  const params: unknown[] = [];
  const where = filterSql(actor, f, params);
  const seeCharges = actor.has('pro.charges.view');
  const rows = await q(`select k.id, k.container_no, k.size_type, k.customs_status, k.customs_cleared_at, k.inspection_status, k.release_status,
      k.released_at, k.delay_reason, r.id request_id, r.request_no, r.job_no, r.bl_number, r.uae_location, c.name customer_name,
      au.full_name assigned_to_name, s.name status_name, s.stage, coalesce(r.deadline, r.required_date) deadline,
      (select string_agg(distinct a2.name, ', ') from pro_activities x join pro_authorities a2 on a2.id = x.authority_id
         where x.request_id = r.id and x.deleted_at is null and (x.container_id is null or x.container_id = k.id)
           and x.status not in ('approved','completed','not_required')) pending_authority,
      (select string_agg(x.required_documents, '; ') from pro_activities x where x.request_id = r.id and x.deleted_at is null
         and (x.container_id is null or x.container_id = k.id) and x.status = 'documents_required' and x.required_documents is not null) pending_documents,
      (select string_agg(x.next_action, '; ') from pro_activities x where x.request_id = r.id and x.deleted_at is null
         and (x.container_id is null or x.container_id = k.id) and x.next_action is not null and x.status not in ('approved','completed','not_required')) outstanding_actions,
      ${seeCharges ? `(select case when count(*) = 0 then null when bool_and(g.payment_status <> 'unpaid') then 'Paid' else 'Unpaid' end
         from pro_charges g where g.request_id = r.id and g.deleted_at is null and not g.is_estimate and (g.container_id is null or g.container_id = k.id))` : 'null'} payment_status
    from pro_containers k join pro_requests r on r.id = k.request_id join pro_statuses s on s.code = r.status_code
    join customers c on c.id = r.customer_id left join users au on au.id = r.assigned_to left join departments dep on dep.id = r.department_id
    ${where} and k.deleted_at is null
    order by case when k.release_status = 'released' or s.stage in ('done','cancelled') then 1 else 0 end, coalesce(r.deadline, r.required_date), k.container_no
    limit 500`, params);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  return rows.map((k) => {
    const finished = k.release_status === 'released' || k.release_status === 'not_required' || ['done', 'cancelled'].includes(k.stage);
    const stage = k.release_status === 'released' ? 'Released' : k.release_status === 'release_pending' ? 'Release pending'
      : k.customs_status === 'cleared' ? 'Customs cleared' : k.customs_status === 'held' ? 'Held by Customs'
      : ['scheduled', 'in_progress', 'pending'].includes(k.inspection_status) ? `Inspection ${CONTAINER_LABEL.inspection_status[k.inspection_status].toLowerCase()}` : k.status_name;
    return { ...k, stage, inspection_label: CONTAINER_LABEL.inspection_status[k.inspection_status],
      release_label: CONTAINER_LABEL.release_status[k.release_status], delayed: !finished && k.deadline < today,
      overall: finished ? 'Done' : 'Open', payment_status: seeCharges ? k.payment_status : undefined };
  });
}

// ------------------------------------------------------------ one request
export async function getPro(actor: Actor, id: string) {
  const r = await loadRequest(actor, id);
  const seeCharges = actor.has('pro.charges.view');
  const work = await canWork(actor, r);
  const supervisor = actor.isSuperAdmin || actor.has('pro.assign');
  const [extra, containers, activities, documents, hist] = await Promise.all([
    one(`select c.name customer_name, rq.full_name requested_by_name, au.full_name assigned_to_name, ab.full_name assigned_by_name,
        dep.name department_name, t.job_number linked_request_no from pro_requests r join customers c on c.id = r.customer_id
        join users rq on rq.id = r.requested_by left join users au on au.id = r.assigned_to left join users ab on ab.id = r.assigned_by
        left join departments dep on dep.id = r.department_id left join transport_requests t on t.id = r.job_id where r.id = $1`, [id]),
    q(`select id, container_no, size_type, customs_status, customs_cleared_at, inspection_status, release_status, released_at, delay_reason, remarks
       from pro_containers where request_id = $1 and deleted_at is null order by container_no`, [id]),
    q(`select x.*, t.name type_name, t.milestone, a.name authority_name, u.full_name assigned_to_name, n.full_name next_action_by_name,
         k.container_no from pro_activities x join pro_activity_types t on t.code = x.activity_type_code
         left join pro_authorities a on a.id = x.authority_id left join users u on u.id = x.assigned_to left join users n on n.id = x.next_action_by
         left join pro_containers k on k.id = x.container_id where x.request_id = $1 and x.deleted_at is null order by t.sort_order, x.created_at`, [id]),
    q(`select d.id, d.activity_id, d.doc_type, d.file_name, d.mime_type, d.size_bytes, d.version, d.replaces_id, d.replaced_at, d.created_at,
         u.full_name uploaded_by_name, d.uploaded_by from pro_documents d left join users u on u.id = d.uploaded_by
       where d.request_id = $1 and d.deleted_at is null order by d.doc_type, d.created_at`, [id]),
    q(`select id, kind, field, old_value, new_value, remarks, document_id, user_name, at, activity_id, container_id from pro_history
       where request_id = $1 and (kind <> 'charge' or $2) order by at, id`, [id, seeCharges]),
  ]);
  const charges = seeCharges ? await q(`select g.*, a.name authority_name, t.name activity_name, k.container_no from pro_charges g
      left join pro_activities x on x.id = g.activity_id left join pro_activity_types t on t.code = x.activity_type_code
      left join pro_authorities a on a.id = x.authority_id left join pro_containers k on k.id = g.container_id
      where g.request_id = $1 and g.deleted_at is null order by g.created_at`, [id]) : undefined;
  const statuses = await q('select code, name, stage, color from pro_statuses where is_active order by sort_order');
  const canEditCharges = actor.has('pro.charges.edit') && (supervisor || work || actor.has('pro.view_all'));
  const requester = r.requested_by === actor.id || (actor.has('pro.create') && actor.has('pro.view_department') && actor.department_id === r.department_id);
  return {
    ...r, ...extra, search_text: undefined,
    containers: containers.map((k) => ({ ...k, labels: Object.fromEntries(Object.keys(CONTAINER_LABEL).map((f) => [f, CONTAINER_LABEL[f][k[f]]])) })),
    activities: activities.map((x) => ({ ...x, status_name: ACT_NAME[x.status], finished: ACT_DONE.includes(x.status) })),
    documents: documents.map((d) => ({ ...d, doc_type_name: DOC_NAME[d.doc_type] ?? d.doc_type, current: !d.replaced_at })),
    charges: charges?.map((g) => ({ ...g, category_name: CHARGE_NAME[g.category] })),
    charges_total: charges ? {
      actual: charges.filter((g) => !g.is_estimate).reduce((s, g) => s + Number(g.amount), 0).toFixed(2),
      estimated: charges.filter((g) => g.is_estimate).reduce((s, g) => s + Number(g.amount), 0).toFixed(2),
      unpaid: charges.filter((g) => !g.is_estimate && g.payment_status === 'unpaid').reduce((s, g) => s + Number(g.amount), 0).toFixed(2),
    } : undefined,
    history: hist,
    completion: completionBlockers(activities, containers),
    can: {
      work, supervisor, assign: actor.isSuperAdmin || actor.has('pro.assign'),
      edit_request: !closed(r) && (supervisor || requester),
      status: work && (!closed(r) || supervisor),
      cancel: !closed(r) && (supervisor || (requester && ['draft', 'open'].includes(r.stage))),
      submit_draft: r.status_code === 'draft' && (requester || supervisor),
      upload: !['cancelled'].includes(r.stage) && (work || requester || supervisor),
      note: true,
      charges_view: seeCharges, charges_edit: canEditCharges && !closed(r),
    },
    options: {
      statuses, activity_statuses: ACTIVITY_STATUS, doc_types: DOC_TYPES, charge_categories: CHARGE_CATEGORIES,
      authorities: await q('select id, name from pro_authorities where is_active order by sort_order, name'),
      activity_types: await q('select code, name, milestone from pro_activity_types where is_active order by sort_order'),
      officers: supervisor || work ? await proOfficers() : [],
      container_labels: CONTAINER_LABEL,
    },
  };
}

function completionBlockers(activities: any[], containers: any[]) {
  const out: string[] = [];
  for (const x of activities) if (!ACT_DONE.includes(x.status))
    out.push(`${x.type_name}${x.authority_name ? ' — ' + x.authority_name : ''}${x.container_no ? ` (${x.container_no})` : ''}: ${ACT_NAME[x.status].toLowerCase()}`);
  for (const k of containers) if (!['released', 'not_required'].includes(k.release_status)) out.push(`Container ${k.container_no}: not released yet`);
  return { ready: out.length === 0, blockers: out };
}

/** PRO officers who can be assigned (active users holding pro.update). */
export async function proOfficers() {
  return q(`select u.id, u.full_name, r.name role_name,
      (select count(*)::int from pro_requests p join pro_statuses s on s.code = p.status_code
        where p.assigned_to = u.id and p.deleted_at is null and s.stage in ('open','active','hold')) open_requests
    from users u join roles r on r.id = u.role_id
    where u.is_active and u.deleted_at is null and r.code <> 'super_admin' and user_has_perm(u.id, 'pro.update') order by u.full_name`);
}

// ------------------------------------------------------------ create
export async function createPro(actor: Actor, b: any) {
  requirePerm(actor, 'pro.create');
  const jobNo = String(b.job_no ?? '').trim();
  const fields: Record<string, string> = {};
  const jp = jobNoProblem(jobNo); if (jp) fields.job_no = jp;
  if (!isUuid(b.customer_id)) fields.customer_id = 'Choose the customer';
  if (!String(b.bl_number ?? '').trim()) fields.bl_number = 'Enter the BL number';
  if (!['import', 'export', 'transit'].includes(b.direction)) fields.direction = 'Choose Import, Export or Transit';
  if (!String(b.uae_location ?? '').trim()) fields.uae_location = 'Enter the UAE port, terminal or free zone';
  if (!DATE.test(String(b.required_date ?? ''))) fields.required_date = 'Choose the required clearance date';
  const containers: { container_no: string; size_type: string | null }[] = [];
  try {
    for (const k of Array.isArray(b.containers) ? b.containers : []) {
      if (!String(k?.container_no ?? '').trim()) continue;
      containers.push({ container_no: normContainer(k.container_no), size_type: txt(k.size_type, 20) });
    }
  } catch (e: any) { fields.containers = e.message; }
  const needsContainers = (b.transport_mode ?? 'sea') === 'sea' && b.load_type !== 'LCL';
  if (!fields.containers && needsContainers && !containers.length) fields.containers = 'Add at least one container number (or choose LCL / another transport mode)';
  if (new Set(containers.map((k) => k.container_no)).size !== containers.length) fields.containers = 'The same container is listed twice';
  if (Object.keys(fields).length) throw new ApiError(400, 'VALIDATION', Object.values(fields)[0], { fields });
  if (b.load_type && !['FCL', 'LCL'].includes(b.load_type)) throw bad('Choose FCL or LCL');
  if (b.transport_mode && !['sea', 'air', 'land'].includes(b.transport_mode)) throw bad('Choose sea, air or land');
  const priority = b.priority || 'normal';
  if (!['normal', 'urgent', 'critical'].includes(priority)) throw bad('Choose Normal, Urgent or Critical');
  const deadline = day(b.deadline, 'Deadline');
  if (deadline && deadline < b.required_date) throw bad('The deadline is before the required clearance date');
  const wrongCheck = containers.filter((k) => !containerCheckOk(k.container_no));
  if (wrongCheck.length && !b.confirm_container_check)
    throw new ApiError(409, 'CONTAINER_CHECK', `The last digit of ${wrongCheck.map((k) => k.container_no).join(', ')} does not match. Please re-check the number — send again if it is correct.`,
      { containers: wrongCheck.map((k) => k.container_no) });
  if (b.assigned_to && !actor.has('pro.assign')) throw forbidden('Only the Documentation Manager assigns officers');
  const types: string[] = (Array.isArray(b.activity_types) ? b.activity_types : []).filter((x: unknown) => typeof x === 'string');

  return tx(async (c) => {
    if (!(await one('select 1 from customers where id = $1 and deleted_at is null', [b.customer_id], c))) throw bad('Customer not found');
    let deptId: string | null = actor.department_side === 'operations' ? actor.department_id : null;
    if (!deptId && b.department_id) {
      const d = isUuid(b.department_id) ? await one(`select id from departments where id = $1 and side = 'operations' and is_active`, [b.department_id], c) : null;
      if (!d) throw bad('Choose an operations department');
      deptId = d.id;
    }
    // the same Job No. may legitimately have several PRO requests — warn, never block
    const same = await q(`select request_no from pro_requests r join pro_statuses s on s.code = r.status_code
      where upper(btrim(r.job_no)) = upper($1) and r.deleted_at is null and s.stage <> 'cancelled'`, [jobNo], c);
    if (same.length && !b.confirm_duplicate_job_no)
      throw new ApiError(409, 'PRO_JOB_NO_EXISTS', `Job No. ${jobNo} already has PRO request ${same.map((x) => x.request_no).join(', ')}. Send again to add another request for it.`,
        { request_nos: same.map((x) => x.request_no) });
    // reuse the truck job with the same Job No. (same department first) instead of copying shipment data
    const job = await one(`select id from transport_requests where upper(btrim(job_no)) = upper($1) and deleted_at is null and status_code <> 'cancelled'
      order by (department_id is not distinct from $2) desc, created_at desc limit 1`, [jobNo, deptId], c);
    let officer: string | null = null;
    if (b.assigned_to) {
      if (!(await proOfficers()).some((o) => o.id === b.assigned_to)) throw bad('Choose a PRO officer');
      officer = b.assigned_to;
    }
    const status = b.save_as_draft ? 'draft' : officer ? 'assigned' : 'pending_assignment';
    const r = await one(`insert into pro_requests (request_no, job_no, job_id, department_id, requested_by, customer_id, shipment_reference, bl_number,
        direction, load_type, transport_mode, vessel, voyage, port_of_origin, port_of_destination, uae_location, cargo_description,
        required_date, deadline, priority, instructions, status_code, assigned_to, assigned_by, assigned_at)
      values ('PRO-' || nextval('pro_request_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
        case when $22::uuid is null then null else $4::uuid end, case when $22::uuid is null then null else now() end)
      returning id, request_no, job_no`,
      [jobNo, job?.id ?? null, deptId, actor.id, b.customer_id, txt(b.shipment_reference, 80), txt(b.bl_number, 60), b.direction,
       b.load_type || null, b.transport_mode || null, txt(b.vessel, 80), txt(b.voyage, 40), txt(b.port_of_origin, 120), txt(b.port_of_destination, 120),
       txt(b.uae_location, 160), txt(b.cargo_description, 2000), b.required_date, deadline, priority, txt(b.instructions, 2000), status, officer], c);
    for (const k of containers)
      await c.query('insert into pro_containers (request_id, container_no, size_type) values ($1,$2,$3)', [r.id, k.container_no, k.size_type]);
    if (types.length) {
      const valid = await q('select code from pro_activity_types where code = any($1) and is_active', [types], c);
      for (const t of valid) await c.query('insert into pro_activities (request_id, activity_type_code, assigned_to, created_by) values ($1,$2,$3,$4)', [r.id, t.code, officer, actor.id]);
    }
    await history(c, actor, { request_id: r.id, kind: 'status', field: 'Status', new_value: (await one('select name from pro_statuses where code = $1', [status], c)).name,
      remarks: `Request created${containers.length ? ` with ${containers.length} container(s)` : ''}` });
    await refreshSearch(c, r.id);
    if (status !== 'draft') {
      await notify(c, (await supervisors(c)).map((u) => u.id), 'pro.created', `New PRO request ${ref(r)}`, r.id, actor.id);
      if (officer) await notify(c, [officer], 'pro.assigned', `PRO request ${ref(r)} assigned to you`, r.id, actor.id);
    }
    return { id: r.id, request_no: r.request_no, job_no: r.job_no };
  });
}

// ------------------------------------------------------------ edit request details
const EDITABLE: Record<string, { label: string; parse: (v: unknown) => unknown }> = {
  job_no: { label: 'Job No.', parse: (v) => { const p = jobNoProblem(v); if (p) throw bad(p); return String(v).trim(); } },
  customer_id: { label: 'Customer', parse: (v) => { if (!isUuid(v)) throw bad('Choose the customer'); return v; } },
  shipment_reference: { label: 'Shipment / booking ref.', parse: (v) => txt(v, 80) },
  bl_number: { label: 'BL number', parse: (v) => { const t = txt(v, 60); if (!t) throw bad('Enter the BL number'); return t; } },
  direction: { label: 'Import / Export / Transit', parse: (v) => { if (!['import', 'export', 'transit'].includes(String(v))) throw bad('Choose Import, Export or Transit'); return v; } },
  load_type: { label: 'FCL / LCL', parse: (v) => { if (v && !['FCL', 'LCL'].includes(String(v))) throw bad('Choose FCL or LCL'); return v || null; } },
  transport_mode: { label: 'Transport mode', parse: (v) => { if (v && !['sea', 'air', 'land'].includes(String(v))) throw bad('Choose sea, air or land'); return v || null; } },
  vessel: { label: 'Vessel', parse: (v) => txt(v, 80) }, voyage: { label: 'Voyage', parse: (v) => txt(v, 40) },
  port_of_origin: { label: 'Port of origin', parse: (v) => txt(v, 120) }, port_of_destination: { label: 'Port of destination', parse: (v) => txt(v, 120) },
  uae_location: { label: 'UAE port / terminal / free zone', parse: (v) => { const t = txt(v, 160); if (!t) throw bad('Enter the UAE port, terminal or free zone'); return t; } },
  cargo_description: { label: 'Cargo', parse: (v) => txt(v, 2000) },
  required_date: { label: 'Required clearance date', parse: (v) => { const d = day(v, 'Required date'); if (!d) throw bad('Choose the required clearance date'); return d; } },
  deadline: { label: 'Deadline', parse: (v) => day(v, 'Deadline') },
  priority: { label: 'Priority', parse: (v) => { if (!['normal', 'urgent', 'critical'].includes(String(v))) throw bad('Choose Normal, Urgent or Critical'); return v; } },
  instructions: { label: 'Instructions', parse: (v) => txt(v, 2000) },
};
export async function updatePro(actor: Actor, id: string, b: any) {
  await tx(async (c) => {
    const r = await loadRequest(actor, id, c, true);
    const full = await getProCan(actor, r, c);
    if (!full.edit_request) throw forbidden('You cannot change this request');
    const changes: [string, unknown, unknown][] = [];
    for (const [k, f] of Object.entries(EDITABLE)) {
      if (!(k in b)) continue;
      const v = f.parse(b[k]);
      const old = r[k] instanceof Date ? r[k].toISOString().slice(0, 10) : r[k];
      if (String(old ?? '') !== String(v ?? '')) changes.push([k, old, v]);
    }
    if (!changes.length) return;
    const get = (k: string) => (changes.find((x) => x[0] === k)?.[2] ?? r[k]);
    const rd = String(get('required_date') instanceof Date ? (get('required_date') as Date).toISOString().slice(0, 10) : get('required_date'));
    const dl = get('deadline'); if (dl && String(dl instanceof Date ? dl.toISOString().slice(0, 10) : dl) < rd) throw bad('The deadline is before the required clearance date');
    await c.query(`update pro_requests set ${changes.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now(),
        deadline_warned_at = null, escalated_at = null where id = $1`, [id, ...changes.map((x) => x[2])]);
    for (const [k, o, n] of changes) await history(c, actor, { request_id: id, kind: 'request', field: EDITABLE[k].label,
      old_value: k === 'customer_id' ? (await one('select name from customers where id = $1', [o], c))?.name : o,
      new_value: k === 'customer_id' ? (await one('select name from customers where id = $1', [n], c))?.name : n });
    await refreshSearch(c, id);
    if (r.assigned_to && r.assigned_to !== actor.id) await notify(c, [r.assigned_to], 'pro.updated', `Request details changed on ${ref(r)}`, id);
  });
  return getPro(actor, id);
}
async function getProCan(actor: Actor, r: any, db: Db) {
  const supervisor = actor.isSuperAdmin || actor.has('pro.assign');
  const requester = r.requested_by === actor.id || (actor.has('pro.create') && actor.has('pro.view_department') && actor.department_id === r.department_id);
  return { supervisor, requester, work: await canWork(actor, r, db), edit_request: !closed(r) && (supervisor || requester) };
}

// ------------------------------------------------------------ overall status
export async function setProStatus(actor: Actor, id: string, b: any) {
  const to = String(b.to ?? '');
  const remarks = txt(b.remarks, 1000);
  await tx(async (c) => {
    const r = await loadRequest(actor, id, c, true);
    const target = await one('select code, name, stage from pro_statuses where code = $1 and is_active', [to], c);
    if (!target) throw bad('Unknown status');
    if (to === r.status_code) return;
    const can = await getProCan(actor, r, c);
    const reopening = closed(r);
    // requesters may only send a draft and cancel before PRO starts; everything else is PRO's (or the supervisor's)
    const requesterMove = can.requester && ((r.status_code === 'draft' && ['submitted', 'pending_assignment'].includes(to))
      || (to === 'cancelled' && ['draft', 'open'].includes(r.stage)));
    if (!requesterMove && !(can.work && actor.has('pro.update')) && !can.supervisor) throw forbidden('Only the PRO officer or Documentation Manager can change this status');
    if (reopening && !can.supervisor) throw forbidden('Only the Documentation Manager can reopen a closed request');
    if (to === 'draft') throw bad('A request cannot go back to Draft');
    if (['cancelled', 'on_hold', 'rejected'].includes(to) && !remarks) throw bad(`Give a reason for "${target.name}"`);
    if (to === 'completed') {
      const acts = await q(`select x.status, t.name type_name, a.name authority_name, k.container_no from pro_activities x
          join pro_activity_types t on t.code = x.activity_type_code left join pro_authorities a on a.id = x.authority_id
          left join pro_containers k on k.id = x.container_id where x.request_id = $1 and x.deleted_at is null`, [id], c);
      const conts = await q('select container_no, release_status from pro_containers where request_id = $1 and deleted_at is null', [id], c);
      const chk = completionBlockers(acts, conts);
      if (!chk.ready) throw new ApiError(409, 'PRO_NOT_COMPLETE', `Not everything is finished yet: ${chk.blockers.join('; ')}.`, { blockers: chk.blockers });
    }
    if (['assigned'].includes(to) && !r.assigned_to) throw bad('Assign a PRO officer first');
    if (b.document_id && !(await one('select 1 from pro_documents where id = $1 and request_id = $2', [b.document_id, id], c))) throw bad('Attachment not found');
    await c.query(`update pro_requests set status_code = $2, updated_at = now(),
        hold_reason = case when $2 = 'on_hold' then $3 else hold_reason end,
        cancel_reason = case when $2 = 'cancelled' then $3 else cancel_reason end,
        customs_cleared_at = case when $2 = 'customs_cleared' then coalesce(customs_cleared_at, now()) else customs_cleared_at end,
        completed_at = case when $2 = 'completed' then now() when $4 then null else completed_at end
      where id = $1`, [id, to, remarks, reopening]);
    await history(c, actor, { request_id: id, kind: 'status', field: 'Status', old_value: r.status_name, new_value: target.name, remarks, document_id: b.document_id ?? null });
    const title: Record<string, string> = {
      docs_required: `Documents required for ${ref(r)}`, rejected: `${ref(r)} rejected by the authority`, payment_pending: `Payment pending on ${ref(r)}`,
      customs_cleared: `Customs cleared: ${ref(r)}`, release_pending: `Container release pending: ${ref(r)}`, container_released: `Container released: ${ref(r)}`,
      completed: `PRO request completed: ${ref(r)}`, cancelled: `PRO request cancelled: ${ref(r)}`, on_hold: `${ref(r)} put on hold`,
    };
    const people = [r.requested_by, r.assigned_to];
    if (['rejected', 'on_hold', 'cancelled'].includes(to)) people.push(...(await supervisors(c)).map((u) => u.id));
    if (to === 'payment_pending') people.push(...(await q<{ id: string }>(`select u.id from users u join roles ro on ro.id = u.role_id where u.is_active and u.deleted_at is null
      and ro.code <> 'super_admin' and user_has_perm(u.id, 'pro.charges.edit') and user_has_perm(u.id, 'pro.view_all')`, [], c)).map((u) => u.id));
    if (['submitted', 'pending_assignment'].includes(to) && r.status_code === 'draft') {
      await notify(c, (await supervisors(c)).map((u) => u.id), 'pro.created', `New PRO request ${ref(r)}`, id, actor.id);
    } else await notify(c, people, `pro.${to}`, title[to] ?? `${ref(r)}: ${target.name}`, id, actor.id);
  });
  return getPro(actor, id);
}

// ------------------------------------------------------------ assignment
export async function assignPro(actor: Actor, id: string, b: any) {
  if (!actor.isSuperAdmin) requirePerm(actor, 'pro.assign');
  await tx(async (c) => {
    const r = await loadRequest(actor, id, c, true);
    requireOpen(actor, r);
    const officer = (await proOfficers()).find((o) => o.id === b.assigned_to);
    if (!officer) throw bad('Choose a PRO officer');
    if (officer.id === r.assigned_to) return;
    const old = r.assigned_to ? (await one('select full_name from users where id = $1', [r.assigned_to], c))?.full_name : null;
    const moveStatus = ['submitted', 'pending_assignment'].includes(r.status_code);
    await c.query(`update pro_requests set assigned_to = $2, assigned_by = $3, assigned_at = now(), updated_at = now()
      ${moveStatus ? ", status_code = 'assigned'" : ''} where id = $1`, [id, officer.id, actor.id]);
    // activities that followed the previous officer move with the request
    await c.query(`update pro_activities set assigned_to = $2, updated_at = now() where request_id = $1 and deleted_at is null
      and (assigned_to is null or assigned_to = $3) and status not in ('approved','completed','not_required')`, [id, officer.id, r.assigned_to]);
    await history(c, actor, { request_id: id, kind: 'assign', field: 'PRO officer', old_value: old, new_value: officer.full_name, remarks: txt(b.remarks, 500) });
    if (moveStatus) await history(c, actor, { request_id: id, kind: 'status', field: 'Status', old_value: r.status_name, new_value: 'Assigned to PRO' });
    await notify(c, [officer.id], 'pro.assigned', `PRO request ${ref(r)} assigned to you`, id, actor.id);
    if (r.assigned_to) await notify(c, [r.assigned_to], 'pro.reassigned', `${ref(r)} was given to ${officer.full_name}`, id, actor.id);
    await notify(c, [r.requested_by], 'pro.assigned', `${officer.full_name} is handling ${ref(r)}`, id, actor.id);
  });
  return getPro(actor, id);
}

// ------------------------------------------------------------ containers
export async function saveContainer(actor: Actor, id: string, b: any) {
  await tx(async (c) => {
    const r = await loadRequest(actor, id, c, true);
    requireOpen(actor, r);
    const can = await getProCan(actor, r, c);
    if (b.remove) {
      if (!can.supervisor && !can.edit_request) throw forbidden();
      const k = await one('select * from pro_containers where id = $1 and request_id = $2 and deleted_at is null', [b.container_id, id], c);
      if (!k) throw notFound('Container');
      if (await one('select 1 from pro_activities where container_id = $1 and deleted_at is null', [k.id], c))
        throw new ApiError(409, 'IN_USE', 'This container has its own activities. Remove or move them first.');
      await c.query('update pro_containers set deleted_at = now() where id = $1', [k.id]);
      await history(c, actor, { request_id: id, container_id: k.id, kind: 'container', field: 'Container removed', old_value: k.container_no });
      return;
    }
    if (!b.container_id) {                                       // add
      if (!can.edit_request && !can.work) throw forbidden();
      const no = normContainer(b.container_no);
      if (!containerCheckOk(no) && !b.confirm_container_check)
        throw new ApiError(409, 'CONTAINER_CHECK', `The last digit of ${no} does not match. Please re-check — send again if it is correct.`, { containers: [no] });
      if (await one('select 1 from pro_containers where request_id = $1 and container_no = $2 and deleted_at is null', [id, no], c))
        throw new ApiError(409, 'DUPLICATE', `${no} is already on this request`);
      const k = await one('insert into pro_containers (request_id, container_no, size_type) values ($1,$2,$3) returning id', [id, no, txt(b.size_type, 20)], c);
      await history(c, actor, { request_id: id, container_id: k.id, kind: 'container', field: 'Container added', new_value: no });
      await refreshSearch(c, id);
      return;
    }
    if (!can.work) throw forbidden('Only the PRO officer or Documentation Manager updates container clearance');
    const k = await one('select * from pro_containers where id = $1 and request_id = $2 and deleted_at is null for update', [b.container_id, id], c);
    if (!k) throw notFound('Container');
    const ch: [string, unknown, unknown][] = [];
    const take = (f: string, v: unknown) => { if (v !== undefined && String(k[f] ?? '') !== String(v ?? '')) ch.push([f, k[f], v]); };
    for (const f of ['customs_status', 'inspection_status', 'release_status'] as const)
      if (b[f] !== undefined) { if (!CONTAINER_LABEL[f][b[f]]) throw bad('Invalid status'); take(f, b[f]); }
    if (b.size_type !== undefined) take('size_type', txt(b.size_type, 20));
    if (b.delay_reason !== undefined) take('delay_reason', txt(b.delay_reason, 500));
    if (b.remarks !== undefined) take('remarks', txt(b.remarks, 1000));
    if (!ch.length) return;
    const sets = ch.map(([f], i) => `${f} = $${i + 2}`);
    if (ch.some(([f, , v]) => f === 'customs_status' && v === 'cleared')) sets.push('customs_cleared_at = coalesce(customs_cleared_at, now())');
    if (ch.some(([f, , v]) => f === 'customs_status' && v !== 'cleared')) sets.push('customs_cleared_at = null');
    if (ch.some(([f, , v]) => f === 'release_status' && v === 'released')) sets.push('released_at = coalesce(released_at, now())');
    if (ch.some(([f, , v]) => f === 'release_status' && v !== 'released')) sets.push('released_at = null');
    await c.query(`update pro_containers set ${sets.join(', ')}, updated_at = now() where id = $1`, [k.id, ...ch.map((x) => x[2])]);
    const label = (f: string, v: any) => CONTAINER_LABEL[f]?.[v] ?? v;
    const names: Record<string, string> = { customs_status: 'Customs', inspection_status: 'Inspection', release_status: 'Release', size_type: 'Size / type', delay_reason: 'Delay reason', remarks: 'Remarks' };
    for (const [f, o, n] of ch) await history(c, actor, { request_id: id, container_id: k.id, kind: 'container',
      field: `${k.container_no} — ${names[f]}`, old_value: label(f, o), new_value: label(f, n), document_id: b.document_id ?? null });
    await c.query('update pro_requests set updated_at = now() where id = $1', [id]);
    const people = [r.requested_by, r.assigned_to];
    if (ch.some(([f, , v]) => f === 'customs_status' && v === 'cleared')) await notify(c, people, 'pro.customs_cleared', `Customs cleared for ${k.container_no} — ${ref(r)}`, id, actor.id);
    if (ch.some(([f, , v]) => f === 'release_status' && v === 'release_pending')) await notify(c, people, 'pro.release_pending', `Release pending for ${k.container_no} — ${ref(r)}`, id, actor.id);
    if (ch.some(([f, , v]) => f === 'release_status' && v === 'released')) await notify(c, people, 'pro.container_released', `Container ${k.container_no} released — ${ref(r)}`, id, actor.id);
  });
  return getPro(actor, id);
}

// ------------------------------------------------------------ activities
const ACT_FIELDS: Record<string, { label: string; parse: (v: unknown) => unknown }> = {
  authority_id: { label: 'Authority', parse: (v) => { if (v && !isUuid(v)) throw bad('Choose an authority'); return v || null; } },
  reference_no: { label: 'Reference / application no.', parse: (v) => txt(v, 80) },
  submitted_on: { label: 'Submitted on', parse: (v) => day(v, 'Submission date') },
  appointment_at: { label: 'Inspection / appointment', parse: (v) => {
    if (!v) return null; const d = new Date(String(v).length === 16 ? `${v}:00+04:00` : String(v));
    if (isNaN(d.getTime())) throw bad('Appointment time is not valid'); return d.toISOString(); } },
  required_documents: { label: 'Required documents', parse: (v) => txt(v, 1000) },
  authority_remarks: { label: 'Authority remarks', parse: (v) => txt(v, 2000) },
  outstanding: { label: 'Outstanding requirements', parse: (v) => txt(v, 2000) },
  approved_on: { label: 'Approved on', parse: (v) => day(v, 'Approval date') },
  rejected_on: { label: 'Rejected on', parse: (v) => day(v, 'Rejection date') },
  completed_on: { label: 'Completed on', parse: (v) => day(v, 'Completion date') },
  next_action: { label: 'Next action', parse: (v) => txt(v, 500) },
  next_action_by: { label: 'Next action by', parse: (v) => { if (v && !isUuid(v)) throw bad('Choose who does the next action'); return v || null; } },
  next_action_due: { label: 'Next action due', parse: (v) => day(v, 'Next action date') },
  container_id: { label: 'Container', parse: (v) => { if (v && !isUuid(v)) throw bad('Choose a container'); return v || null; } },
  assigned_to: { label: 'PRO officer', parse: (v) => { if (v && !isUuid(v)) throw bad('Choose a PRO officer'); return v || null; } },
  status: { label: 'Status', parse: (v) => { if (!ACT_NAME[String(v)]) throw bad('Invalid activity status'); return v; } },
};
export async function saveActivity(actor: Actor, id: string, b: any) {
  await tx(async (c) => {
    const r = await loadRequest(actor, id, c, true);
    requireOpen(actor, r);
    const can = await getProCan(actor, r, c);
    if (b.remove) {
      const x = await one('select x.*, t.name type_name from pro_activities x join pro_activity_types t on t.code = x.activity_type_code where x.id = $1 and x.request_id = $2 and x.deleted_at is null', [b.activity_id, id], c);
      if (!x) throw notFound('Activity');
      if (!can.supervisor && !(can.work && x.status === 'not_started')) throw forbidden('Only the Documentation Manager can remove an activity that has started');
      await c.query('update pro_activities set deleted_at = now() where id = $1', [x.id]);
      await history(c, actor, { request_id: id, activity_id: x.id, kind: 'activity', field: 'Activity removed', old_value: x.type_name });
      return;
    }
    if (!can.work && !(can.edit_request && !b.activity_id)) throw forbidden('Only the PRO officer or Documentation Manager updates clearance activities');
    const ref2 = async (f: string, v: any) => {
      if (!v) return;
      if (f === 'authority_id' && !(await one('select 1 from pro_authorities where id = $1', [v], c))) throw bad('Authority not found');
      if (f === 'container_id' && !(await one('select 1 from pro_containers where id = $1 and request_id = $2 and deleted_at is null', [v, id], c))) throw bad('Container not found');
      if ((f === 'assigned_to') && !(await proOfficers()).some((o) => o.id === v)) throw bad('Choose a PRO officer');
      if (f === 'assigned_to' && !can.supervisor && v !== actor.id) throw forbidden('Only the Documentation Manager assigns activities to others');
      if (f === 'next_action_by' && !(await one('select 1 from users where id = $1 and is_active and deleted_at is null', [v], c))) throw bad('Person not found');
    };
    if (!b.activity_id) {                                                    // add
      const t = await one('select code, name from pro_activity_types where code = $1 and is_active', [b.activity_type_code], c);
      if (!t) throw bad('Choose an activity type');
      const vals: Record<string, unknown> = {};
      for (const [f, d] of Object.entries(ACT_FIELDS)) if (b[f] !== undefined && b[f] !== '') { vals[f] = d.parse(b[f]); await ref2(f, vals[f]); }
      vals.assigned_to = vals.assigned_to ?? r.assigned_to;
      const cols = Object.keys(vals);
      const x = await one(`insert into pro_activities (request_id, activity_type_code, created_by${cols.map((k) => ', ' + k).join('')})
        values ($1,$2,$3${cols.map((_, i) => `, $${i + 4}`).join('')}) returning id`, [id, t.code, actor.id, ...cols.map((k) => vals[k])], c);
      await history(c, actor, { request_id: id, activity_id: x.id, kind: 'activity', field: 'Activity added', new_value: t.name, remarks: txt(b.remarks, 1000) });
      await refreshSearch(c, id);
      return;
    }
    const x = await one(`select x.*, t.name type_name, a.name authority_name from pro_activities x join pro_activity_types t on t.code = x.activity_type_code
      left join pro_authorities a on a.id = x.authority_id where x.id = $1 and x.request_id = $2 and x.deleted_at is null for update of x`, [b.activity_id, id], c);
    if (!x) throw notFound('Activity');
    const ch: [string, unknown, unknown][] = [];
    for (const [f, d] of Object.entries(ACT_FIELDS)) {
      if (!(f in b)) continue;
      const v = d.parse(b[f]); await ref2(f, v);
      const o = x[f] instanceof Date ? (f === 'appointment_at' ? x[f].toISOString() : x[f].toISOString().slice(0, 10)) : x[f];
      if (String(o ?? '') !== String(v ?? '')) ch.push([f, o, v]);
    }
    // dates that follow the status, unless given
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
    const st = ch.find(([f]) => f === 'status')?.[2] as string | undefined;
    const auto: Record<string, string> = { submitted: 'submitted_on', approved: 'approved_on', rejected: 'rejected_on', completed: 'completed_on' };
    if (st && auto[st] && !x[auto[st]] && !ch.some(([f]) => f === auto[st])) ch.push([auto[st], null, today]);
    if (st === 'rejected' && !txt(b.remarks, 1000) && !ch.some(([f]) => f === 'authority_remarks')) throw bad('Write why the authority rejected it (remarks)');
    if (!ch.length && !b.remarks) return;
    if (ch.length) await c.query(`update pro_activities set ${ch.map(([f], i) => `${f} = $${i + 2}`).join(', ')}, updated_at = now(),
        appointment_reminded_at = ${ch.some(([f]) => f === 'appointment_at') ? 'null' : 'appointment_reminded_at'} where id = $1`, [x.id, ...ch.map((y) => y[2])]);
    const name = async (f: string, v: any) => {
      if (v == null) return v;
      if (f === 'status') return ACT_NAME[v];
      if (f === 'authority_id') return (await one('select name from pro_authorities where id = $1', [v], c))?.name;
      if (f === 'container_id') return (await one('select container_no from pro_containers where id = $1', [v], c))?.container_no;
      if (['assigned_to', 'next_action_by'].includes(f)) return (await one('select full_name from users where id = $1', [v], c))?.full_name;
      return v;
    };
    const label = `${x.type_name}${x.authority_name ? ' — ' + x.authority_name : ''}`;
    for (const [f, o, n] of ch) await history(c, actor, { request_id: id, activity_id: x.id, kind: 'activity', field: `${label}: ${ACT_FIELDS[f].label}`,
      old_value: await name(f, o), new_value: await name(f, n), remarks: f === 'status' ? txt(b.remarks, 1000) : null, document_id: f === 'status' ? b.document_id ?? null : null });
    if (!ch.length && b.remarks) await history(c, actor, { request_id: id, activity_id: x.id, kind: 'note', field: label, remarks: txt(b.remarks, 1000) });
    await c.query('update pro_requests set updated_at = now() where id = $1', [id]);
    await refreshSearch(c, id);
    // tell the requester / officer what the authority said
    const people = [r.requested_by, r.assigned_to, x.assigned_to];
    const msg: Record<string, string> = { documents_required: `Documents required — ${label} — ${ref(r)}`, approved: `Approved — ${label} — ${ref(r)}`,
      rejected: `Rejected — ${label} — ${ref(r)}`, payment_pending: `Payment pending — ${label} — ${ref(r)}`,
      pending_inspection: `Inspection pending — ${label} — ${ref(r)}`, completed: `Done — ${label} — ${ref(r)}` };
    if (st && msg[st]) {
      if (st === 'rejected') people.push(...(await supervisors(c)).map((u) => u.id));
      await notify(c, people, `pro.activity_${st}`, msg[st], id, actor.id);
    }
    const nb = ch.find(([f]) => f === 'next_action_by');
    if (nb?.[2]) await notify(c, [nb[2] as string], 'pro.next_action', `Next action for you on ${ref(r)}: ${(ch.find(([f]) => f === 'next_action')?.[2] ?? x.next_action) || label}`, id, actor.id);
    const asg = ch.find(([f]) => f === 'assigned_to');
    if (asg?.[2]) await notify(c, [asg[2] as string], 'pro.assigned', `Activity "${label}" on ${ref(r)} assigned to you`, id, actor.id);
  });
  return getPro(actor, id);
}

// ------------------------------------------------------------ charges
export async function saveCharge(actor: Actor, id: string, b: any) {
  requirePerm(actor, 'pro.charges.edit');
  await tx(async (c) => {
    const r = await loadRequest(actor, id, c, true);
    requireOpen(actor, r);
    const can = await getProCan(actor, r, c);
    if (!can.work && !can.supervisor && !actor.has('pro.view_all')) throw forbidden();
    if (b.remove) {
      const g = await one('select * from pro_charges where id = $1 and request_id = $2 and deleted_at is null', [b.charge_id, id], c);
      if (!g) throw notFound('Charge');
      await c.query('update pro_charges set deleted_at = now() where id = $1', [g.id]);
      await history(c, actor, { request_id: id, kind: 'charge', field: 'Charge removed', old_value: `${CHARGE_NAME[g.category]} ${g.amount}` });
      return;
    }
    const category = String(b.category ?? '');
    if (!CHARGE_NAME[category]) throw bad('Choose a charge category');
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) throw bad('Enter the amount');
    const status = b.payment_status || 'unpaid';
    if (!['unpaid', 'paid', 'waived'].includes(status)) throw bad('Invalid payment status');
    const paidOn = status === 'paid' ? day(b.paid_on, 'Paid on') ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' }) : null;
    for (const [f, t] of [['activity_id', 'pro_activities'], ['container_id', 'pro_containers'], ['receipt_document_id', 'pro_documents']] as const)
      if (b[f] && !(isUuid(b[f]) && await one(`select 1 from ${t} where id = $1 and request_id = $2`, [b[f], id], c))) throw bad('Linked item not found');
    const vals = [category, txt(b.description, 300), amount.toFixed(2), !!b.is_estimate, status, paidOn, b.activity_id || null, b.container_id || null, b.receipt_document_id || null];
    if (b.charge_id) {
      const g = await one('select * from pro_charges where id = $1 and request_id = $2 and deleted_at is null for update', [b.charge_id, id], c);
      if (!g) throw notFound('Charge');
      await c.query(`update pro_charges set category = $2, description = $3, amount = $4, is_estimate = $5, payment_status = $6, paid_on = $7,
          activity_id = $8, container_id = $9, receipt_document_id = $10, updated_at = now() where id = $1`, [g.id, ...vals]);
      await history(c, actor, { request_id: id, kind: 'charge', field: `${CHARGE_NAME[category]}${b.is_estimate ? ' (estimate)' : ''}`,
        old_value: `${g.amount} — ${g.payment_status}`, new_value: `${amount.toFixed(2)} — ${status}` });
    } else {
      await c.query(`insert into pro_charges (request_id, category, description, amount, is_estimate, payment_status, paid_on, activity_id, container_id, receipt_document_id, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, ...vals, actor.id]);
      await history(c, actor, { request_id: id, kind: 'charge', field: 'Charge added', new_value: `${CHARGE_NAME[category]}${b.is_estimate ? ' (estimate)' : ''}: ${amount.toFixed(2)} — ${status}` });
    }
  });
  return getPro(actor, id);
}

// ------------------------------------------------------------ notes
export async function addProNote(actor: Actor, id: string, b: any) {
  const body = txt(b.remarks, 2000);
  if (!body) throw bad('Write a note first');
  await tx(async (c) => {
    const r = await loadRequest(actor, id, c);
    await history(c, actor, { request_id: id, kind: 'note', remarks: body });
    await notify(c, [r.requested_by, r.assigned_to], 'pro.note', `New note on ${ref(r)}`, id, actor.id);
  });
  return getPro(actor, id);
}

// ------------------------------------------------------------ documents (upload / replace / view)
export async function requestProUpload(actor: Actor, id: string, b: any) {
  const r = await loadRequest(actor, id);
  if (r.stage === 'cancelled') throw new ApiError(409, 'PRO_CLOSED', 'Cancelled requests can\'t take new documents.');
  const can = await getProCan(actor, r, pool());
  if (!can.work && !can.requester && !can.supervisor) throw forbidden('You cannot upload to this request');
  const mime = String(b.mime_type ?? '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!FILE_TYPES[mime]) throw bad('Upload a PDF, JPG or PNG');
  const size = Number(b.size);
  if (!Number.isFinite(size) || size <= 0) throw bad('The file is empty');
  if (size > MAX_FILE) throw bad('Files can be up to 10 MB');
  if (!DOC_NAME[b.doc_type]) throw bad('Choose the document type');
  if (b.activity_id && !(isUuid(b.activity_id) && await one('select 1 from pro_activities where id = $1 and request_id = $2 and deleted_at is null', [b.activity_id, id])))
    throw bad('Activity not found');
  if (b.replaces_id && !(isUuid(b.replaces_id) && await one('select 1 from pro_documents where id = $1 and request_id = $2 and replaced_at is null and deleted_at is null', [b.replaces_id, id])))
    throw bad('The document to replace was not found (maybe it was already replaced)');
  const name = String(b.file_name ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || `document.${FILE_TYPES[mime]}`;
  const store = fileStore();
  const key = `pro/${id}/${randomUUID()}.${FILE_TYPES[mime]}`;
  const upload = await store.createUpload(key, mime);
  const ticket = sign({ pro: id, key, name, mime, uid: actor.id, driver: store.driver, doc_type: b.doc_type, activity_id: b.activity_id || null,
    replaces_id: b.replaces_id || null, exp: Date.now() + 3600_000 });
  return { upload, ticket };
}
export async function confirmProUpload(actor: Actor, id: string, b: any) {
  const t = unsign(b.ticket);
  if (t.pro !== id || t.uid !== actor.id) throw forbidden('This upload belongs to someone else');
  const store = fileStore();
  const info = await store.stat(t.key);
  if (!info) throw new ApiError(409, 'UPLOAD_MISSING', 'The file did not arrive. Please try again.');
  if (info.size > MAX_FILE) { await store.remove(t.key); throw bad('Files can be up to 10 MB'); }
  await tx(async (c) => {
    await loadRequest(actor, id, c, true);
    if (await one('select 1 from pro_documents where storage_path = $1', [t.key], c)) throw new ApiError(409, 'DUPLICATE', 'Already saved');
    let version = 1;
    if (t.replaces_id) {
      const old = await one('select * from pro_documents where id = $1 and request_id = $2 and replaced_at is null and deleted_at is null for update', [t.replaces_id, id], c);
      if (!old) throw new ApiError(409, 'ALREADY_REPLACED', 'Someone replaced this document a moment ago. Refresh and try again.');
      version = old.version + 1;
      await c.query('update pro_documents set replaced_at = now() where id = $1', [old.id]);
    }
    const d = await one(`insert into pro_documents (request_id, activity_id, doc_type, file_name, storage_path, mime_type, size_bytes, version, replaces_id, uploaded_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [id, t.activity_id, t.doc_type, t.name, t.key, t.mime, info.size, version, t.replaces_id, actor.id], c);
    await history(c, actor, { request_id: id, activity_id: t.activity_id, kind: 'document', document_id: d.id,
      field: t.replaces_id ? `${DOC_NAME[t.doc_type]} replaced (version ${version})` : `${DOC_NAME[t.doc_type]} uploaded`, new_value: t.name });
    await c.query('update pro_requests set updated_at = now() where id = $1', [id]);
  });
  return getPro(actor, id);
}
export async function proFileUrl(actor: Actor, docId: string, inline = false) {
  if (!isUuid(docId)) throw notFound('Document');
  const d = await one('select * from pro_documents where id = $1 and deleted_at is null', [docId]);
  if (!d) throw notFound('Document');
  await loadRequest(actor, d.request_id);                 // same visibility as the request
  return fileStore().downloadUrl(d.storage_path, d.file_name, inline);
}

// ------------------------------------------------------------ configuration (authorities, activity types)
export async function proConfig(actor: Actor) {
  if (!canSeePro(actor)) throw forbidden();
  return {
    authorities: await q('select id, name, is_active, sort_order from pro_authorities order by sort_order, name'),
    activity_types: await q('select code, name, milestone, is_active, sort_order from pro_activity_types order by sort_order'),
    statuses: await q('select code, name, stage, color, is_active, sort_order from pro_statuses order by sort_order'),
    settings: { pro_deadline_warning_hours: await getSetting('pro_deadline_warning_hours', 24), pro_escalate_after_hours: await getSetting('pro_escalate_after_hours', 0) },
    can_configure: actor.isSuperAdmin || actor.has('pro.configure'),
  };
}
export async function saveProConfig(actor: Actor, b: any) {
  if (!actor.isSuperAdmin) requirePerm(actor, 'pro.configure');
  const name = txt(b.name, 120);
  await tx(async (c) => {
    if (b.kind === 'authority') {
      if (b.id) await c.query('update pro_authorities set name = coalesce($2, name), is_active = coalesce($3, is_active) where id = $1', [b.id, name, b.is_active ?? null]);
      else { if (!name) throw bad('Enter the authority name'); await c.query('insert into pro_authorities (name) values ($1)', [name]); }
    } else if (b.kind === 'activity_type') {
      if (b.code && b.existing) await c.query('update pro_activity_types set name = coalesce($2, name), is_active = coalesce($3, is_active) where code = $1', [b.code, name, b.is_active ?? null]);
      else {
        if (!name) throw bad('Enter the activity name');
        const code = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'activity';
        await c.query(`insert into pro_activity_types (code, name, sort_order) values ($1, $2, (select coalesce(max(sort_order), 0) + 10 from pro_activity_types))`, [code, name]);
      }
    } else if (b.kind === 'status') {
      if (['draft', 'completed', 'cancelled', 'on_hold', 'pending_assignment', 'assigned'].includes(b.code) && b.is_active === false)
        throw bad('This status is needed by the workflow and cannot be switched off');
      await c.query('update pro_statuses set name = coalesce($2, name), is_active = coalesce($3, is_active) where code = $1', [b.code, name, b.is_active ?? null]);
    } else if (b.kind === 'settings') {
      for (const k of ['pro_deadline_warning_hours', 'pro_escalate_after_hours']) if (b[k] !== undefined) {
        const n = Number(b[k]); if (!Number.isInteger(n) || n < 0 || n > 720) throw bad('Hours must be a whole number from 0 to 720');
        await c.query(`insert into settings (key, value, updated_by) values ($1, $2::jsonb, $3) on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`, [k, String(n), actor.id]);
      }
    } else throw bad('Unknown setting');
    await audit(c, actor, { entity_type: 'settings', entity_id: 'pro', action: 'PRO settings changed', new_value: `${b.kind}: ${name ?? b.code ?? ''}`, sensitivity: 'admin' });
  }).catch((e) => { if (e?.code === '23505') throw new ApiError(409, 'DUPLICATE', 'That name already exists'); throw e; });
  return proConfig(actor);
}

// ------------------------------------------------------------ deadlines, appointments, escalation
/**
 * Runs from the hourly scheduled task and on normal app use (at most every 10 minutes):
 *  - warns the officer and requester before a deadline (pro_deadline_warning_hours)
 *  - escalates overdue requests to PRO supervisors (pro_escalate_after_hours past the deadline)
 *  - reminds the officer of inspections / appointments in the next 24 hours, and next actions due today
 */
export async function runProReminders(force = false) {
  const claimed = await one(`insert into settings (key, value) values ('pro_reminder_last_run', to_jsonb(now()::text))
      on conflict (key) do update set value = excluded.value
      where $1 or (settings.value #>> '{}')::timestamptz < now() - interval '10 minutes' returning 1 ok`, [force]);
  if (!claimed) return { warned: 0, escalated: 0, appointments: 0 };
  const warnH = Number(await getSetting('pro_deadline_warning_hours', 24));
  const escH = Number(await getSetting('pro_escalate_after_hours', 0));
  const open = `s.stage in ('open','active','hold') and r.deleted_at is null`;
  // deadline = end of that day in Dubai
  const due = `((coalesce(r.deadline, r.required_date) + 1)::timestamp at time zone 'Asia/Dubai')`;
  let warned = 0, escalated = 0, appointments = 0;
  await tx(async (c) => {
    const soon = await q(`select r.* from pro_requests r join pro_statuses s on s.code = r.status_code
      where ${open} and r.deadline_warned_at is null and ${due} > now() and ${due} <= now() + make_interval(hours => $1)`, [warnH], c);
    for (const r of soon) {
      await notify(c, [r.assigned_to, r.requested_by], 'pro.deadline', `Deadline soon (${String(r.deadline ?? r.required_date).slice(0, 10)}): ${ref(r)}`, r.id);
      await c.query('update pro_requests set deadline_warned_at = now() where id = $1', [r.id]); warned++;
    }
    const late = await q(`select r.* from pro_requests r join pro_statuses s on s.code = r.status_code
      where ${open} and r.escalated_at is null and ${due} + make_interval(hours => $1) <= now()`, [escH], c);
    const sup = (await supervisors(c)).map((u) => u.id);
    for (const r of late) {
      await notify(c, [...sup, r.assigned_to, r.requested_by], 'pro.overdue', `OVERDUE: ${ref(r)} passed its deadline`, r.id);
      await c.query('update pro_requests set escalated_at = now() where id = $1', [r.id]);
      await history(c, null, { request_id: r.id, kind: 'note', remarks: 'Overdue — escalated to the PRO supervisor' });
      escalated++;
    }
    const appts = await q(`select x.id, x.request_id, x.assigned_to, x.appointment_at, r.request_no, r.job_no, r.assigned_to req_officer, t.name type_name
      from pro_activities x join pro_requests r on r.id = x.request_id join pro_statuses s on s.code = r.status_code
      join pro_activity_types t on t.code = x.activity_type_code
      where ${open} and x.deleted_at is null and x.appointment_reminded_at is null and x.appointment_at between now() and now() + interval '24 hours'
        and x.status not in ('approved','completed','not_required')`, [], c);
    for (const a of appts) {
      const when = new Date(a.appointment_at).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short' });
      await notify(c, [a.assigned_to ?? a.req_officer], 'pro.appointment', `${a.type_name} on ${when} — ${a.request_no} (Job No. ${a.job_no})`, a.request_id);
      await c.query('update pro_activities set appointment_reminded_at = now() where id = $1', [a.id]); appointments++;
    }
  });
  return { warned, escalated, appointments };
}


// ------------------------------------------------------------ reports (A–E), run through the normal Reports page
export async function proReport(actor: Actor, def: { key: string; title: string; kind: string; cols: any[] }, cols: any[], colsOut: any[],
  p: Record<string, string>, opts: { all?: boolean }) {
  if (!DATE.test(p.from ?? '') || !DATE.test(p.to ?? '')) throw bad('Choose a period');
  if (p.to < p.from) throw bad('The end date is before the start date');
  const params: unknown[] = [];
  const where = filterSql(actor, { ...p, date_from: p.from, date_to: p.to, view: '' }, params);
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const sortCol = cols.find((c) => c.key === p.sort && c.sort);
  const dir = p.dir === 'asc' ? 'asc' : 'desc';
  const cap = opts.all ? 50000 : Math.min(Math.max(Number(p.page_size) || 100, 1), 500);
  const page = opts.all ? 1 : Math.max(Number(p.page) || 1, 1);
  const lim = `limit ${cap} offset ${(page - 1) * cap}`;
  const today = `(now() at time zone 'Asia/Dubai')::date`;
  let rows: any[] = [];
  let totals: Record<string, unknown> | null = null;
  if (def.key === 'pro_register') {
    rows = await q(`select ${LIST_COLS},
        (select string_agg(distinct a2.name, ', ') from pro_activities x join pro_authorities a2 on a2.id = x.authority_id
           where x.request_id = r.id and x.deleted_at is null) authorities, count(*) over() _total
      ${LIST_FROM} ${where} order by ${sortCol ? `${sortCol.sort} ${dir} nulls last` : 'r.request_date desc'}, r.request_no desc ${lim}`, params);
  } else if (def.key === 'pro_containers') {
    const all = await listContainers(actor, { ...p, date_from: p.from, date_to: p.to });
    let list = all.map((k: any) => ({ ...k, delay: k.delayed ? 'Yes' : 'No' }));
    if (sortCol) list.sort((a: any, b: any) => (dir === 'asc' ? 1 : -1) * String(a[sortCol.key] ?? '').localeCompare(String(b[sortCol.key] ?? '')));
    rows = list.slice((page - 1) * cap, page * cap).map((k: any) => ({ ...k, _total: list.length }));
  } else if (def.key === 'pro_officers') {
    rows = await q(`select officer, assigned, completed, open, overdue, avg_days, count(*) over() _total from (
        select coalesce(au.full_name, 'Not assigned') officer, count(*)::int assigned,
          count(*) filter (where s.stage = 'done')::int completed,
          count(*) filter (where s.stage in ('open','active','hold'))::int open,
          count(*) filter (where s.stage in ('open','active','hold') and coalesce(r.deadline, r.required_date) < ${today})::int overdue,
          to_char(avg(extract(epoch from (r.completed_at - coalesce(r.assigned_at, r.created_at))) / 86400) filter (where r.completed_at is not null), 'FM990.0') avg_days
        ${LIST_FROM} ${where} group by au.full_name) z
      order by ${sortCol ? `${sortCol.sort} ${dir} nulls last` : 'assigned desc'}, officer ${lim}`, params);
  } else if (def.key === 'pro_authority_pending') {
    rows = await q(`select a.name authority, t.name activity, x.reference_no, r.request_no, r.job_no, k.container_no, x.status, x.submitted_on,
        nullif(concat_ws(' · ', x.outstanding, case when x.status = 'documents_required' then x.required_documents end), '') pending_requirement,
        (${today} - coalesce(x.submitted_on, x.created_at::date))::int days_pending, x.next_action, n.full_name next_action_by, count(*) over() _total
      from pro_activities x join pro_activity_types t on t.code = x.activity_type_code left join pro_authorities a on a.id = x.authority_id
      left join pro_containers k on k.id = x.container_id left join users n on n.id = x.next_action_by
      join pro_requests r on r.id = x.request_id join pro_statuses s on s.code = r.status_code join customers c on c.id = r.customer_id
      left join users au on au.id = r.assigned_to left join departments dep on dep.id = r.department_id
      ${where} and x.deleted_at is null and x.status not in ('approved','completed','not_required') and s.stage not in ('done','cancelled')
      ${p.authority_id ? ` and x.authority_id = ${add(p.authority_id)}` : ''}
      order by ${sortCol ? `${sortCol.sort} ${dir} nulls last` : 'days_pending desc'}, r.request_no ${lim}`, params);
    rows = rows.map((x) => ({ ...x, activity_status: ACT_NAME[x.status] }));
  } else if (def.key === 'pro_charges') {
    if (p.payment_status && !['unpaid', 'paid', 'waived'].includes(p.payment_status)) throw bad('Invalid filter');
    rows = await q(`select r.request_no, r.job_no, k.container_no, a.name authority, g.category, g.description, g.amount, g.is_estimate,
        g.payment_status, g.paid_on, d.file_name receipt, count(*) over() _total,
        sum(case when not g.is_estimate then g.amount else 0 end) over() _actual, sum(case when g.is_estimate then g.amount else 0 end) over() _estimate
      from pro_charges g join pro_requests r on r.id = g.request_id join pro_statuses s on s.code = r.status_code join customers c on c.id = r.customer_id
      left join users au on au.id = r.assigned_to left join departments dep on dep.id = r.department_id
      left join pro_containers k on k.id = g.container_id left join pro_activities x on x.id = g.activity_id
      left join pro_authorities a on a.id = x.authority_id left join pro_documents d on d.id = g.receipt_document_id
      ${where} and g.deleted_at is null ${p.payment_status ? ` and g.payment_status = ${add(p.payment_status)}` : ''}
      order by ${sortCol ? `${sortCol.sort} ${dir} nulls last` : 'r.request_no desc'}, g.created_at ${lim}`, params);
    totals = { request_no: 'Total', actual: rows[0]?._actual ?? '0.00', estimate: rows[0]?._estimate ?? '0.00' };
    rows = rows.map((g) => ({ ...g, category: CHARGE_NAME[g.category], kind: g.is_estimate ? 'Estimate' : 'Actual',
      actual: g.is_estimate ? null : g.amount, estimate: g.is_estimate ? g.amount : null,
      payment_status: { unpaid: 'Unpaid', paid: 'Paid', waived: 'Waived' }[g.payment_status as string] }));
  }
  const total = Number(rows[0]?._total ?? 0);
  return { report: { key: def.key, title: def.title, kind: def.kind }, columns: colsOut,
    rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c.key, r[c.key] ?? null]))), totals, total, page, page_size: cap,
    filters: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) };
}
