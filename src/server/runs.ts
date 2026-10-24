/**
 * Messenger runs — carrying documents (collect / deliver / submit).
 *
 * Who sees what:
 *   runs.view_all         → every run (Messenger Manager, Super Admin)
 *   runs.view_department  → runs of own department (+ own requests)        (Operations)
 *   otherwise             → runs they requested or are assigned to         (Messengers)
 *
 * Flow:  pending → assigned → collected → delivered
 *                       ↘ failed (reason) → assigned again / cancelled
 *        pending / assigned / failed → cancelled (reason)
 */
import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { Actor, requirePerm } from './auth';
import { ApiError, audit, bad, Db, forbidden, getSetting, notFound, one, q, tx } from './db';
import { fileStore } from './storage';
import { sign, unsign, MAX_BYTES } from './documents';

const UUID = /^[0-9a-f-]{36}$/i;
const STATUS: Record<string, string> = {
  pending: 'Waiting for a messenger', assigned: 'Assigned', collected: 'Collected',
  delivered: 'Delivered', failed: 'Could not complete', cancelled: 'Cancelled',
};
export const TASKS: Record<string, string> = {
  collect: 'Collect documents', deliver: 'Deliver documents', collect_deliver: 'Collect and deliver',
  submit: 'Submit documents (e.g. customs)', other: 'Other',
};
const PROOF_TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

// ------------------------------------------------------------ helpers
function runScope(actor: Actor, params: unknown[], alias = 'm'): string {
  if (actor.has('runs.view_all')) return '';
  params.push(actor.id);
  const me = `$${params.length}`;
  if (actor.has('runs.view_department') && actor.department_id) {
    params.push(actor.department_id);
    return ` and (${alias}.department_id = $${params.length} or ${alias}.requested_by = ${me} or ${alias}.messenger_id = ${me})`;
  }
  return ` and (${alias}.requested_by = ${me} or ${alias}.messenger_id = ${me})`;
}
const canSeeRuns = (a: Actor) => ['runs.view_all', 'runs.view_department', 'runs.create', 'runs.update_status', 'runs.assign'].some((p) => a.has(p as any));

async function notify(db: Db, userIds: (string | null | undefined)[], type: string, title: string, runId: string, exclude?: string) {
  for (const uid of [...new Set(userIds.filter((u): u is string => !!u && u !== exclude))])
    await db.query('insert into notifications (user_id, type, title, run_id) values ($1,$2,$3,$4)', [uid, type, title, runId]);
}
async function managers(db: Db) {
  return (await q<{ id: string }>(`select u.id from users u join roles r on r.id = u.role_id
    where u.is_active and u.deleted_at is null and r.code <> 'super_admin' and user_has_perm(u.id, 'runs.assign')`, [], db)).map((r) => r.id);
}

const txt = (v: unknown, max: number, label: string, required = false) => {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw bad(`${label} is required`);
  if (s.length > max) throw bad(`${label} is too long (max ${max} characters)`);
  return s || null;
};
const timeOrNull = (v: unknown, label: string) => {
  if (v === undefined || v === null || v === '') return null;
  if (!/^\d{2}:\d{2}$/.test(String(v))) throw bad(`${label} is invalid`);
  return String(v);
};

function parseRun(b: any) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.required_date ?? ''))) throw bad('Date is required');
  if (b.task_type && !TASKS[b.task_type]) throw bad('Choose what the messenger has to do');
  if (b.priority && !['low', 'normal', 'high', 'urgent'].includes(b.priority)) throw bad('Invalid priority');
  const r = {
    required_date: String(b.required_date), slot_from: timeOrNull(b.slot_from, 'Time from'), slot_to: timeOrNull(b.slot_to, 'Time to'),
    task_type: b.task_type || 'collect_deliver', priority: b.priority || 'normal',
    from_name: txt(b.from_name, 200, 'From (place)', true), from_address: txt(b.from_address, 500, 'From address'),
    from_contact_person: txt(b.from_contact_person, 120, 'Contact'), from_contact_number: txt(b.from_contact_number, 40, 'Contact number'),
    to_name: txt(b.to_name, 200, 'To (place)'), to_address: txt(b.to_address, 500, 'To address'),
    to_contact_person: txt(b.to_contact_person, 120, 'Contact'), to_contact_number: txt(b.to_contact_number, 40, 'Contact number'),
    documents: txt(b.documents, 1000, 'Documents', true), reference: txt(b.reference, 120, 'Reference'),
    customer_id: b.customer_id && UUID.test(b.customer_id) ? b.customer_id : null,
    job_id: b.job_id && UUID.test(b.job_id) ? b.job_id : null,
    instructions: txt(b.instructions, 2000, 'Instructions'),
  };
  if (r.slot_from && r.slot_to && r.slot_to <= r.slot_from) throw bad('Time slot must end after it starts');
  if (r.task_type !== 'collect' && r.task_type !== 'submit' && !r.to_name) throw bad('Where should the documents go? Fill in "To"');
  return r;
}

const SELECT = `m.*, d.name department_name, ru.full_name requested_by_name, ms.full_name messenger_name, ms.mobile messenger_mobile,
  ab.full_name assigned_by_name, c.name customer_name, t.job_number`;
const FROM = `from messenger_runs m
  left join departments d on d.id = m.department_id
  join users ru on ru.id = m.requested_by
  left join users ms on ms.id = m.messenger_id
  left join users ab on ab.id = m.assigned_by
  left join customers c on c.id = m.customer_id
  left join transport_requests t on t.id = m.job_id`;
const LIST_FIELDS = ['id', 'run_number', 'status', 'priority', 'task_type', 'required_date', 'slot_from', 'slot_to', 'from_name', 'to_name',
  'documents', 'reference', 'department_name', 'requested_by_name', 'messenger_id', 'messenger_name', 'customer_name', 'job_number',
  'planned_at', 'collected_at', 'delivered_at', 'created_at'];
const pick = (row: any, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
const dto = (row: any): Record<string, any> => ({ ...pick(row, LIST_FIELDS), status_name: STATUS[row.status], task_name: TASKS[row.task_type] });

// ------------------------------------------------------------ list / get
export async function listRuns(actor: Actor, f: Record<string, string>) {
  if (!canSeeRuns(actor)) throw forbidden();
  const p: unknown[] = [];
  const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
  let where = 'where m.deleted_at is null' + runScope(actor, p);
  if (f.mine === '1') where += ` and m.messenger_id = ${add(actor.id)}`;
  if (f.q?.trim()) where += ` and m.search_text like ${add('%' + f.q.trim().toLowerCase().replace(/[%_\\]/g, '\\$&') + '%')}`;
  if (f.status) where += ` and m.status = any(${add(f.status.split(','))})`;
  if (f.open === '1') where += ` and m.status in ('pending','assigned','collected','failed')`;
  if (f.date_from) where += ` and m.required_date >= ${add(f.date_from)}`;
  if (f.date_to) where += ` and m.required_date <= ${add(f.date_to)}`;
  if (f.department_id && UUID.test(f.department_id)) where += ` and m.department_id = ${add(f.department_id)}`;
  if (f.messenger_id && UUID.test(f.messenger_id)) where += ` and m.messenger_id = ${add(f.messenger_id)}`;
  const size = Math.min(Math.max(Number(f.page_size) || 50, 1), 200), page = Math.max(Number(f.page) || 1, 1);
  const order = f.mine === '1' ? `case m.status when 'collected' then 0 when 'assigned' then 1 when 'failed' then 2 else 3 end, m.required_date, m.slot_from nulls last`
    : `case m.status when 'pending' then 0 when 'failed' then 1 else 2 end, m.required_date desc, m.run_number desc`;
  const rows = await q(`select ${SELECT}, count(*) over() _total ${FROM} ${where} order by ${order} limit ${size} offset ${(page - 1) * size}`, p);
  return { total: Number(rows[0]?._total ?? 0), page, page_size: size, rows: rows.map(dto) };
}

async function loadRun(actor: Actor, id: string, db?: Db, lock = false) {
  if (!UUID.test(id)) throw notFound('Run');
  if (!canSeeRuns(actor)) throw forbidden();
  const p: unknown[] = [id];
  const row = await one(`select ${SELECT} ${FROM} where m.id = $1 and m.deleted_at is null ${runScope(actor, p)}${lock ? ' for update of m' : ''}`, p, db);
  if (!row) throw notFound('Run');
  return row;
}

export async function getRun(actor: Actor, id: string): Promise<Record<string, any>> {
  const r = await loadRun(actor, id);
  const mine = r.messenger_id === actor.id;
  const managing = actor.has('runs.view_all') && actor.has('runs.update_status');
  const open = ['pending', 'assigned', 'collected', 'failed'].includes(r.status);
  const files = await q(`select f.id, f.kind, f.file_name, f.mime_type, f.size_bytes, f.created_at, u.full_name uploaded_by_name
      from messenger_run_files f left join users u on u.id = f.uploaded_by where f.run_id = $1 and f.deleted_at is null order by f.created_at`, [id]);
  const notes = await q(`select n.id, n.body, n.created_at, u.full_name author from messenger_run_notes n join users u on u.id = n.user_id
      where n.run_id = $1 order by n.created_at`, [id]);
  const activity = await q(`select id, occurred_at, user_name, department_code, action, field, old_value, new_value
      from audit_log where entity_type = 'run' and entity_id = $1 order by occurred_at, id`, [id]);
  const canUpdate = actor.has('runs.update_status') && (mine || managing);
  return {
    ...dto(r),
    from_address: r.from_address, from_contact_person: r.from_contact_person, from_contact_number: r.from_contact_number,
    to_address: r.to_address, to_contact_person: r.to_contact_person, to_contact_number: r.to_contact_number,
    instructions: r.instructions, customer_id: r.customer_id, job_id: r.job_id, department_id: r.department_id,
    messenger_mobile: r.messenger_mobile, assigned_by_name: r.assigned_by_name, assigned_at: r.assigned_at,
    received_by: r.received_by, fail_reason: r.fail_reason, cancel_reason: r.cancel_reason, cancelled_at: r.cancelled_at,
    files, notes, activity,
    can: {
      assign: actor.has('runs.assign') && ['pending', 'assigned', 'failed'].includes(r.status),
      collect: canUpdate && r.status === 'assigned',
      deliver: canUpdate && ['assigned', 'collected'].includes(r.status),
      fail: canUpdate && ['assigned', 'collected'].includes(r.status),
      cancel: actor.has('runs.cancel') && ['pending', 'assigned', 'failed'].includes(r.status),
      edit: actor.has('runs.create') && r.status === 'pending',
      upload: (canUpdate || actor.has('runs.create')) && r.status !== 'cancelled',
      note: r.status !== 'cancelled',
    },
  };
}

// ------------------------------------------------------------ create / edit
export async function createRun(actor: Actor, b: any) {
  requirePerm(actor, 'runs.create');
  const r = parseRun(b);
  const tz = await getSetting<string>('timezone', 'Asia/Dubai');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  if (r.required_date < today && !actor.has('jobs.backdate')) throw bad('The date cannot be in the past');
  return tx(async (c) => {
    let dept: string | null = actor.department_side === 'operations' ? actor.department_id : null;
    if (!dept) {
      const d = b.department_id && UUID.test(b.department_id)
        ? await one(`select id from departments where id = $1 and side = 'operations' and is_active`, [b.department_id], c) : null;
      if (!d) throw bad('Choose which department this run is for');
      dept = d.id;
    }
    if (r.customer_id && !(await one('select 1 from customers where id = $1 and deleted_at is null', [r.customer_id], c))) throw bad('Customer not found');
    if (r.job_id) {
      const p: unknown[] = [r.job_id];
      const { jobScope } = await import('./scope');
      if (!(await one(`select 1 from transport_requests t where t.id = $1 and t.deleted_at is null ${jobScope(actor, p)}`, p, c))) throw bad('Linked job not found');
    }
    const keys = Object.keys(r) as (keyof typeof r)[];
    const run = await one<{ id: string; run_number: string }>(
      `insert into messenger_runs (run_number, department_id, requested_by, ${keys.join(', ')})
       values ('MR-' || nextval('messenger_run_seq'), $1, $2, ${keys.map((_, i) => `$${i + 3}`).join(', ')}) returning id, run_number`,
      [dept, actor.id, ...keys.map((k) => r[k])], c);
    await c.query('select refresh_run_search($1)', [run!.id]);
    await audit(c, actor, { entity_type: 'run', entity_id: run!.id, action: 'Messenger run requested', new_value: `${TASKS[r.task_type]}: ${r.documents}` });
    await notify(c, await managers(c), 'run.created', `New messenger run ${run!.run_number}`, run!.id, actor.id);
    return run!;
  });
}

export async function updateRun(actor: Actor, id: string, b: any) {
  requirePerm(actor, 'runs.create');
  await tx(async (c) => {
    const cur = await loadRun(actor, id, c, true);
    if (cur.status !== 'pending') throw new ApiError(409, 'RUN_LOCKED', 'A run can only be edited before a messenger is assigned. Add a note instead.');
    const r = parseRun({ ...cur, ...b, slot_from: b.slot_from ?? cur.slot_from?.slice(0, 5), slot_to: b.slot_to ?? cur.slot_to?.slice(0, 5),
      required_date: b.required_date ?? (cur.required_date instanceof Date ? cur.required_date.toISOString().slice(0, 10) : cur.required_date) });
    const keys = Object.keys(r) as (keyof typeof r)[];
    const norm = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(v) ? v.slice(0, 5) : v ?? null);
    const changed = keys.filter((k) => String(norm(cur[k]) ?? '') !== String(r[k] ?? ''));
    if (!changed.length) return;
    await c.query(`update messenger_runs set ${changed.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [id, ...changed.map((k) => r[k])]);
    for (const k of changed)
      await audit(c, actor, { entity_type: 'run', entity_id: id, action: 'Run updated', field: k.replace(/_/g, ' '), old_value: norm(cur[k]), new_value: r[k] });
    await c.query('select refresh_run_search($1)', [id]);
  });
  return getRun(actor, id);
}

// ------------------------------------------------------------ messengers + assign
export async function messengersFor(actor: Actor, date?: string) {
  requirePerm(actor, 'runs.assign');
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toLocaleDateString('en-CA', { timeZone: await getSetting('timezone', 'Asia/Dubai') });
  return q(`select u.id, u.full_name, u.mobile,
      (select count(*)::int from messenger_runs m where m.messenger_id = u.id and m.required_date = $1
         and m.status in ('assigned','collected') and m.deleted_at is null) open_runs
    from users u join roles r on r.id = u.role_id join departments d on d.id = u.department_id
    where u.is_active and u.deleted_at is null and d.side = 'messenger' and user_has_perm(u.id, 'runs.update_status')
      and not user_has_perm(u.id, 'runs.assign')
    order by u.full_name`, [day]);
}

export async function assignRun(actor: Actor, id: string, b: any) {
  requirePerm(actor, 'runs.assign');
  if (!b.messenger_id || !UUID.test(b.messenger_id)) throw bad('Choose a messenger');
  await tx(async (c) => {
    const cur = await loadRun(actor, id, c, true);
    if (!['pending', 'assigned', 'failed'].includes(cur.status)) throw new ApiError(409, 'RUN_LOCKED', `A run that is "${STATUS[cur.status]}" can't be reassigned.`);
    const m = await one(`select u.id, u.full_name from users u join departments d on d.id = u.department_id
      where u.id = $1 and u.is_active and u.deleted_at is null and d.side = 'messenger' and user_has_perm(u.id, 'runs.update_status')`, [b.messenger_id], c);
    if (!m) throw bad('That person is not an active messenger');
    let planned: string | null = null;
    if (b.planned_at) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.planned_at)) throw bad('Planned time is invalid');
      const tz = await getSetting<string>('timezone', 'Asia/Dubai', c);
      planned = (await one<{ t: string }>(`select ($1::timestamp at time zone $2)::text t`, [b.planned_at, tz], c))!.t;
    }
    await c.query(`update messenger_runs set messenger_id = $2, assigned_by = $3, assigned_at = now(), planned_at = $4,
        status = 'assigned', fail_reason = null, updated_at = now() where id = $1`, [id, m.id, actor.id, planned]);
    await audit(c, actor, { entity_type: 'run', entity_id: id, action: cur.messenger_id ? 'Messenger changed' : 'Messenger assigned',
      field: 'Messenger', old_value: cur.messenger_name, new_value: m.full_name });
    await c.query('select refresh_run_search($1)', [id]);
    await notify(c, [m.id], 'run.assigned', `New run for you: ${cur.run_number}`, id, actor.id);
    if (cur.messenger_id && cur.messenger_id !== m.id) await notify(c, [cur.messenger_id], 'run.unassigned', `${cur.run_number} was given to another messenger`, id, actor.id);
    await notify(c, [cur.requested_by], 'run.assigned', `Messenger assigned to ${cur.run_number}`, id, actor.id);
  });
  return getRun(actor, id);
}

// ------------------------------------------------------------ progress
export async function updateRunStatus(actor: Actor, id: string, b: any) {
  const to = String(b.to ?? '');
  await tx(async (c) => {
    const cur = await loadRun(actor, id, c, true);
    const mine = cur.messenger_id === actor.id;
    const managing = actor.has('runs.view_all') && actor.has('runs.update_status');
    const log = (action: string, extra?: string) => audit(c, actor, { entity_type: 'run', entity_id: id, action, field: 'Status',
      old_value: STATUS[cur.status], new_value: STATUS[to] + (extra ? ` — ${extra}` : '') });
    if (to === 'cancelled') {
      requirePerm(actor, 'runs.cancel');
      if (!['pending', 'assigned', 'failed'].includes(cur.status)) throw new ApiError(409, 'RUN_LOCKED', `A run that is "${STATUS[cur.status]}" can't be cancelled.`);
      const reason = txt(b.reason, 500, 'Reason', true)!;
      if (reason.length < 3) throw bad('Give a reason for cancelling');
      await c.query(`update messenger_runs set status = 'cancelled', cancel_reason = $2, cancelled_at = now(), updated_at = now() where id = $1`, [id, reason]);
      await log('Run cancelled', reason);
      await notify(c, [cur.messenger_id, cur.requested_by, ...(await managers(c))], 'run.cancelled', `${cur.run_number} cancelled`, id, actor.id);
      return;
    }
    if (!actor.has('runs.update_status') || !(mine || managing)) throw forbidden('Only the assigned messenger or the Messenger Manager can update this run');
    if (to === 'collected') {
      if (cur.status !== 'assigned') throw new ApiError(409, 'INVALID_STEP', 'Only an assigned run can be marked collected.');
      await c.query(`update messenger_runs set status = 'collected', collected_at = now(), updated_at = now() where id = $1`, [id]);
      await log('Documents collected');
      await notify(c, [cur.requested_by], 'run.collected', `${cur.run_number}: documents collected`, id, actor.id);
    } else if (to === 'delivered') {
      if (!['assigned', 'collected'].includes(cur.status)) throw new ApiError(409, 'INVALID_STEP', 'This run is not in progress.');
      const receivedBy = txt(b.received_by, 120, 'Received by');
      if (cur.task_type !== 'collect' && !receivedBy) throw bad('Write who received the documents');
      await c.query(`update messenger_runs set status = 'delivered', delivered_at = now(), collected_at = coalesce(collected_at, now()),
          received_by = $2, updated_at = now() where id = $1`, [id, receivedBy]);
      await log('Run completed', receivedBy ? `received by ${receivedBy}` : undefined);
      await notify(c, [cur.requested_by], 'run.delivered', `${cur.run_number} delivered`, id, actor.id);
    } else if (to === 'failed') {
      if (!['assigned', 'collected'].includes(cur.status)) throw new ApiError(409, 'INVALID_STEP', 'This run is not in progress.');
      const reason = txt(b.reason, 500, 'Reason', true)!;
      await c.query(`update messenger_runs set status = 'failed', fail_reason = $2, updated_at = now() where id = $1`, [id, reason]);
      await log('Could not complete', reason);
      await notify(c, [cur.requested_by, ...(await managers(c))], 'run.failed', `${cur.run_number} could not be completed`, id, actor.id);
    } else throw bad('Unknown step');
  });
  return getRun(actor, id);
}

// ------------------------------------------------------------ notes + proof files
export async function addRunNote(actor: Actor, id: string, b: any) {
  const body = txt(b.body, 2000, 'Note', true)!;
  await tx(async (c) => {
    const r = await loadRun(actor, id, c);
    if (r.status === 'cancelled') throw new ApiError(409, 'RUN_LOCKED', 'Cancelled runs are read-only.');
    await c.query('insert into messenger_run_notes (run_id, user_id, body) values ($1,$2,$3)', [id, actor.id, body]);
    await notify(c, [r.requested_by, r.messenger_id], 'run.note', `New note on ${r.run_number}`, id, actor.id);
  });
  return getRun(actor, id);
}

export async function requestRunUpload(actor: Actor, id: string, b: any) {
  const r = await getRun(actor, id);
  if (!r.can.upload) throw forbidden();
  const mime = String(b.mime_type ?? '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!PROOF_TYPES[mime]) throw bad('Upload a photo (JPG or PNG) or a PDF');
  const size = Number(b.size);
  if (!Number.isFinite(size) || size <= 0) throw bad('The file is empty');
  if (size > MAX_BYTES) throw bad('Files can be up to 10 MB');
  const name = String(b.file_name ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || `proof.${PROOF_TYPES[mime]}`;
  const store = fileStore();
  const key = `runs/${id}/${randomUUID()}.${PROOF_TYPES[mime]}`;
  const upload = await store.createUpload(key, mime);
  const ticket = sign({ run: id, key, name, mime, uid: actor.id, driver: store.driver, kind: b.kind === 'document' ? 'document' : 'proof', exp: Date.now() + 3600_000 });
  return { upload, ticket };
}

export async function confirmRunUpload(actor: Actor, id: string, b: any) {
  const t = unsign(b.ticket);
  if (t.run !== id || t.uid !== actor.id) throw forbidden('This upload belongs to someone else');
  const info = await fileStore().stat(t.key);
  if (!info) throw new ApiError(409, 'UPLOAD_MISSING', 'The file did not arrive. Please try again.');
  if (info.size > MAX_BYTES) { await fileStore().remove(t.key); throw bad('Files can be up to 10 MB'); }
  await tx(async (c) => {
    const r = await loadRun(actor, id, c);
    await c.query(`insert into messenger_run_files (run_id, kind, file_name, storage_path, mime_type, size_bytes, storage_driver, uploaded_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, t.kind, t.name, t.key, t.mime, info.size, t.driver, actor.id]);
    await audit(c, actor, { entity_type: 'run', entity_id: id, action: t.kind === 'proof' ? 'Proof photo added' : 'Document added', new_value: t.name });
    if (t.kind === 'proof') await notify(c, [r.requested_by], 'run.proof', `Proof added to ${r.run_number}`, id, actor.id);
  });
  return getRun(actor, id);
}

export async function runFileUrl(actor: Actor, fileId: string) {
  if (!UUID.test(fileId)) throw notFound('File');
  const f = await one('select * from messenger_run_files where id = $1 and deleted_at is null', [fileId]);
  if (!f) throw notFound('File');
  await loadRun(actor, f.run_id);                 // same visibility as the run itself
  return fileStore().downloadUrl(f.storage_path, f.file_name);
}

// ------------------------------------------------------------ dashboard counts
export async function runCounts(actor: Actor) {
  if (!canSeeRuns(actor)) return null;
  const tz = await getSetting<string>('timezone', 'Asia/Dubai');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const p: unknown[] = [today, tz];
  const r = await one(`select
      count(*) filter (where m.status = 'pending')::int pending,
      count(*) filter (where m.status = 'assigned')::int assigned,
      count(*) filter (where m.status = 'collected')::int collected,
      count(*) filter (where m.status = 'failed')::int failed,
      count(*) filter (where m.status = 'delivered' and (m.delivered_at at time zone $2)::date = $1::date)::int delivered_today,
      count(*) filter (where m.required_date = $1 and m.status not in ('cancelled'))::int today
    from messenger_runs m where m.deleted_at is null ${runScope(actor, p)}`, p);
  return r;
}
