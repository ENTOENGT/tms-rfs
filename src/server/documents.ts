/**
 * Phase 4 — documents, POD, notes, POD reminders.
 *
 * Upload is two steps so big files never pass through our server:
 *   1. requestUpload  → permission checks, returns a signed upload link + a signed "ticket"
 *   2. browser PUTs the file straight to storage
 *   3. confirmUpload  → verifies the ticket, checks the file really arrived (size/type),
 *                       then records it on the job (and updates POD status if it is a POD).
 * Commercial documents (customer invoice/quotation) follow the same confidentiality
 * rules as the selling price: Transport can neither see nor upload them.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { PoolClient } from 'pg';
import { Actor, requirePerm } from './auth';
import { ApiError, audit, bad, Db, forbidden, getSetting, notFound, one, q, tx } from './db';
import { getJob, usersWithPermission } from './jobs';
import { fileStore } from './storage';
import { canViewJobs, jobScope } from './scope';

const UUID = /^[0-9a-f-]{36}$/i;
export const MAX_BYTES = 10 * 1024 * 1024;
export const ALLOWED: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};
const POD_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

const canSeeCommercialDocs = (a: Actor) => a.fin.sellingView && a.has('documents.view_commercial');

async function notify(db: Db, userIds: (string | null | undefined)[], type: string, title: string, jobId: string) {
  for (const uid of [...new Set(userIds.filter(Boolean))])
    await db.query('insert into notifications (user_id, type, title, job_id) values ($1,$2,$3,$4)', [uid, type, title, jobId]);
}

async function visibleJob(actor: Actor, jobId: string, db?: Db, lock = false) {
  if (!UUID.test(jobId)) throw notFound('Job');
  if (!canViewJobs(actor)) throw forbidden();
  const p: unknown[] = [jobId];
  const scope = jobScope(actor, p);
  const job = await one(`select t.id, t.job_number, t.job_no, t.status_code, t.pod_status, t.requested_by, s.stage, s.name status_name
      from transport_requests t join job_statuses s on s.code = t.status_code
     where t.id = $1 and t.deleted_at is null${scope}${lock ? ' for update of t' : ''}`, p, db);
  if (!job) throw notFound('Job');
  return job;
}

// ------------------------------------------------------------ ticket (stateless, signed)
export function sign(payload: object) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret').update(body).digest('base64url');
  return `${body}.${mac}`;
}
export function unsign(ticket: unknown): any {
  if (typeof ticket !== 'string' || !ticket.includes('.')) throw bad('Upload ticket missing');
  const [body, mac] = ticket.split('.');
  const want = createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret').update(body).digest('base64url');
  if (want.length !== mac.length || !timingSafeEqual(Buffer.from(want), Buffer.from(mac))) throw bad('Upload ticket is invalid');
  const t = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (Date.now() > t.exp) throw new ApiError(410, 'UPLOAD_EXPIRED', 'The upload took too long. Please try again.');
  return t;
}

// ------------------------------------------------------------ upload
/** Request documents (Invoice, Packing list, BOE, BL, Gate pass, Other) can be added or replaced until the trip starts. */
const BEFORE_DISPATCH = ['draft', 'requested', 'pending_assignment', 'assigned', 'confirmed'];
export const EXPIRED_MSG = 'This document expired and was deleted automatically 30 days after it was uploaded.';

async function checkTypeAllowed(actor: Actor, db: Db | undefined, typeCode: string, mime: string, job?: { status_code: string }) {
  const dt = await one('select code, name, is_commercial, is_request_doc, retention_days from document_types where code = $1 and is_active', [typeCode], db);
  if (!dt) throw bad('Choose a document type');
  if (dt.code === 'pod') {
    requirePerm(actor, 'pod.upload');
    if (!POD_TYPES.includes(mime)) throw bad('POD must be a PDF, JPG or PNG');
  } else requirePerm(actor, 'documents.upload');
  if (dt.is_commercial && !canSeeCommercialDocs(actor)) throw forbidden('You cannot upload this type of document');
  if (dt.is_request_doc) {
    if (!POD_TYPES.includes(mime)) throw bad(`${dt.name}: only PDF, JPG or PNG files`);
    if (job && !BEFORE_DISPATCH.includes(job.status_code) && !actor.isSuperAdmin)
      throw new ApiError(409, 'AFTER_DISPATCH', `${dt.name} can only be added before the trip starts.`);
  }
  return dt;
}

export async function requestUpload(actor: Actor, jobId: string, b: any) {
  const job = await visibleJob(actor, jobId);
  if (job.stage === 'cancelled') throw new ApiError(409, 'JOB_LOCKED', 'Cancelled jobs can\'t take new documents.');
  if (job.stage === 'closed' && !actor.has('jobs.edit_completed')) throw new ApiError(409, 'JOB_LOCKED', 'This job is closed.');
  const mime = String(b.mime_type ?? '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!ALLOWED[mime]) throw bad('Only PDF, JPG, PNG, Excel (.xlsx) and Word (.docx) files can be uploaded');
  const size = Number(b.size);
  if (!Number.isFinite(size) || size <= 0) throw bad('The file is empty');
  if (size > MAX_BYTES) throw bad('Files can be up to 10 MB');
  const name = String(b.file_name ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || `file.${ALLOWED[mime]}`;
  await checkTypeAllowed(actor, undefined, String(b.document_type_code ?? ''), mime, job);
  const store = fileStore();
  const key = `jobs/${jobId}/${randomUUID()}.${ALLOWED[mime]}`;
  const upload = await store.createUpload(key, mime);
  const ticket = sign({ job: jobId, key, name, mime, size, type: b.document_type_code, uid: actor.id, driver: store.driver, exp: Date.now() + 60 * 60 * 1000 });
  return { upload, ticket };
}

export async function confirmUpload(actor: Actor, jobId: string, b: any) {
  const t = unsign(b.ticket);
  if (t.job !== jobId || t.uid !== actor.id) throw forbidden('This upload belongs to someone else');
  const store = fileStore();
  const info = await store.stat(t.key);
  if (!info) throw new ApiError(409, 'UPLOAD_MISSING', 'The file did not arrive. Please try again.');
  if (info.size > MAX_BYTES) { await store.remove(t.key); throw bad('Files can be up to 10 MB'); }

  const isPod = t.type === 'pod';
  let pod: { pod_date: string | null; received_by: string | null; remarks: string | null } | null = null;
  if (isPod) {
    const d = b.pod_date ? String(b.pod_date) : null;
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad('POD date is invalid');
    pod = { pod_date: d, received_by: b.received_by ? String(b.received_by).trim().slice(0, 120) : null, remarks: b.remarks ? String(b.remarks).trim().slice(0, 500) : null };
  }

  const docId = await tx(async (c) => {
    const job = await visibleJob(actor, jobId, c, true);
    const dt = await checkTypeAllowed(actor, c, t.type, t.mime, job);
    if (await one('select 1 from job_documents where storage_path = $1', [t.key], c)) throw new ApiError(409, 'DUPLICATE', 'Already saved');
    // Retention (e.g. 30 days) counts from THIS upload — a replaced file gets its own fresh 30 days.
    const doc = await one(`insert into job_documents (job_id, document_type_code, file_name, storage_path, mime_type, size_bytes, uploaded_by, storage_driver, expires_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8, case when $9::int is null then null else now() + make_interval(days => $9::int) end) returning id`,
      [jobId, t.type, t.name, t.key, t.mime, info.size, actor.id, t.driver, dt.retention_days ?? null], c);
    const typeName = (await one('select name from document_types where code = $1', [t.type], c)).name;
    const commercial = (await one('select is_commercial from document_types where code = $1', [t.type], c)).is_commercial;
    await audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId, action: `${typeName} uploaded`, new_value: t.name,
      sensitivity: commercial ? 'commercial' : 'general' });
    if (isPod) await recordPod(c, actor, job, doc.id, pod!);
    return doc.id as string;
  });
  return { id: docId, job: await getJob(actor, jobId) };
}

async function recordPod(c: PoolClient, actor: Actor, job: any, documentId: string, pod: { pod_date: string | null; received_by: string | null; remarks: string | null }) {
  await c.query(`insert into job_pod (job_id, document_id, pod_date, received_by, remarks, updated_at)
      values ($1,$2,$3,$4,$5, now())
    on conflict (job_id) do update set document_id = excluded.document_id,
      pod_date = coalesce(excluded.pod_date, job_pod.pod_date), received_by = coalesce(excluded.received_by, job_pod.received_by),
      remarks = coalesce(excluded.remarks, job_pod.remarks), verified_by = null, verified_at = null, rejection_reason = null, updated_at = now()`,
    [job.id, documentId, pod.pod_date, pod.received_by, pod.remarks]);
  if (job.pod_status !== 'uploaded') {
    await c.query(`update transport_requests set pod_status = 'uploaded', updated_at = now() where id = $1`, [job.id]);
    await audit(c, actor, { entity_type: 'job', entity_id: job.id, job_id: job.id, action: 'POD status changed', field: 'POD', old_value: job.pod_status, new_value: 'uploaded' });
  }
  if (['delivered', 'pod_pending'].includes(job.status_code)) {
    await c.query(`update transport_requests set status_code = 'pod_received' where id = $1`, [job.id]);
    await audit(c, actor, { entity_type: 'job', entity_id: job.id, job_id: job.id, action: 'Status changed', field: 'Status', old_value: job.status_name, new_value: 'POD Received' });
  }
  const verifiers = await usersWithPermission(c, 'pod.verify', actor.id, job.id);
  await notify(c, [job.requested_by !== actor.id ? job.requested_by : null, ...verifiers.map((u) => u.id)], 'pod.uploaded', `POD uploaded for ${job.job_no ?? job.job_number}`, job.id);
}

// ------------------------------------------------------------ POD verify / reject
export async function reviewPod(actor: Actor, jobId: string, b: any) {
  requirePerm(actor, 'pod.verify');
  const action = b.action;
  if (!['verify', 'reject'].includes(action)) throw bad('Choose verify or reject');
  await tx(async (c) => {
    const job = await visibleJob(actor, jobId, c, true);
    if (!['uploaded', 'verified'].includes(job.pod_status)) throw new ApiError(409, 'NO_POD', 'There is no POD waiting for review.');
    if (job.stage === 'closed' && !actor.has('jobs.edit_completed')) throw new ApiError(409, 'JOB_LOCKED', 'This job is closed.');
    if (action === 'verify') {
      await c.query(`update job_pod set verified_by = $2, verified_at = now(), rejection_reason = null, updated_at = now() where job_id = $1`, [jobId, actor.id]);
      await c.query(`update transport_requests set pod_status = 'verified', updated_at = now() where id = $1`, [jobId]);
      await audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId, action: 'POD verified', field: 'POD', old_value: job.pod_status, new_value: 'verified' });
    } else {
      const reason = String(b.reason ?? '').trim();
      if (reason.length < 3) throw bad('Say what is wrong with the POD so Transport can fix it');
      await c.query(`update job_pod set verified_by = null, verified_at = null, rejection_reason = $2, updated_at = now() where job_id = $1`, [jobId, reason.slice(0, 500)]);
      await c.query(`update transport_requests set pod_status = 'rejected', pod_reminded_at = null, updated_at = now() where id = $1`, [jobId]);
      if (job.status_code === 'pod_received')
        await c.query(`update transport_requests set status_code = 'pod_pending' where id = $1`, [jobId]);
      await audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId, action: 'POD rejected', field: 'POD', old_value: job.pod_status, new_value: `rejected — ${reason}` });
      const t = await one('select assigned_by from transport_assignments where job_id = $1 and is_current', [jobId], c);
      const uploaders = await usersWithPermission(c, 'pod.upload', actor.id, jobId);
      await notify(c, [t?.assigned_by, ...uploaders.map((u) => u.id)], 'pod.rejected', `POD rejected for ${job.job_no ?? job.job_number}`, jobId);
    }
  });
  return getJob(actor, jobId);
}

// ------------------------------------------------------------ list / download / delete
export async function listDocuments(actor: Actor, p: Record<string, string>) {
  if (!actor.has('jobs.view')) throw forbidden();
  const params: unknown[] = [canSeeCommercialDocs(actor)];
  let where = 'where d.deleted_at is null and t.deleted_at is null and ($1 or not dt.is_commercial)';
  where += jobScope(actor, params);
  if (p.type) { params.push(p.type); where += ` and d.document_type_code = $${params.length}`; }
  if (p.q?.trim()) {
    params.push('%' + p.q.trim().replace(/[%_\\]/g, '\\$&') + '%');
    where += ` and (d.file_name ilike $${params.length} or t.job_no ilike $${params.length} or t.job_number ilike $${params.length} or t.boe_number ilike $${params.length} or c.name ilike $${params.length})`;
  }
  if (p.date_from) { params.push(p.date_from); where += ` and d.created_at >= $${params.length}::date`; }
  if (p.date_to) { params.push(p.date_to); where += ` and d.created_at < $${params.length}::date + 1`; }
  const size = Math.min(Math.max(Number(p.page_size) || 50, 1), 200), page = Math.max(Number(p.page) || 1, 1);
  const rows = await q(`select d.id, d.file_name, d.mime_type, d.size_bytes, d.created_at, d.document_type_code, dt.name document_type,
      d.expires_at, d.purged_at is not null expired, t.id job_id, t.job_number, t.job_no, t.boe_number, c.name customer_name, u.full_name uploaded_by_name, count(*) over() _total
    from job_documents d join document_types dt on dt.code = d.document_type_code
    join transport_requests t on t.id = d.job_id join customers c on c.id = t.customer_id
    left join users u on u.id = d.uploaded_by
    ${where} order by d.created_at desc limit ${size} offset ${(page - 1) * size}`, params);
  return { total: Number(rows[0]?._total ?? 0), page, page_size: size, rows: rows.map(({ _total, ...r }) => r) };
}

async function visibleDoc(actor: Actor, docId: string, db?: Db) {
  if (!UUID.test(docId)) throw notFound('Document');
  const d = await one(`select d.*, dt.is_commercial, dt.name type_name from job_documents d join document_types dt on dt.code = d.document_type_code
    where d.id = $1 and d.deleted_at is null`, [docId], db);
  if (!d) throw notFound('Document');
  await visibleJob(actor, d.job_id, db);                    // same scoping as the job itself
  if (d.is_commercial && !canSeeCommercialDocs(actor)) throw notFound('Document');   // don't even confirm it exists
  return d;
}

export async function downloadUrl(actor: Actor, docId: string, inline = false) {
  const d = await visibleDoc(actor, docId);
  if (d.purged_at || (d.expires_at && new Date(d.expires_at) <= new Date())) throw new ApiError(410, 'EXPIRED', EXPIRED_MSG);
  return fileStore().downloadUrl(d.storage_path, d.file_name, inline);
}

export async function deleteDocument(actor: Actor, docId: string) {
  await tx(async (c) => {
    const d = await visibleDoc(actor, docId, c);
    const job = await visibleJob(actor, d.job_id, c, true);
    const own = d.uploaded_by === actor.id;
    if (!actor.isSuperAdmin && !(own && actor.has(d.document_type_code === 'pod' ? 'pod.upload' : 'documents.upload')))
      throw forbidden('Only the person who uploaded it, or an admin, can remove a document');
    if (['closed', 'cancelled'].includes(job.stage) && !actor.isSuperAdmin) throw new ApiError(409, 'JOB_LOCKED', 'This job is closed.');
    const dt = await one('select is_request_doc from document_types where code = $1', [d.document_type_code], c);
    if (dt?.is_request_doc && !BEFORE_DISPATCH.includes(job.status_code) && !actor.isSuperAdmin)
      throw new ApiError(409, 'AFTER_DISPATCH', 'The trip has started — request documents can no longer be removed or replaced.');
    if (d.document_type_code === 'pod' && job.pod_status === 'verified' && !actor.isSuperAdmin)
      throw new ApiError(409, 'POD_VERIFIED', 'This POD is already verified. Ask an admin if it must be removed.');
    // Soft delete: the file stays in storage for the audit trail (request documents are still wiped at 30 days).
    await c.query('update job_documents set deleted_at = now(), deleted_by = $2 where id = $1', [docId, actor.id]);
    await audit(c, actor, { entity_type: 'job', entity_id: job.id, job_id: job.id, action: `${d.type_name} removed`, old_value: d.file_name,
      sensitivity: d.is_commercial ? 'commercial' : 'general' });
    if (d.document_type_code === 'pod') {
      const left = await one(`select id from job_documents where job_id = $1 and document_type_code = 'pod' and deleted_at is null order by created_at desc limit 1`, [job.id], c);
      if (left) await c.query('update job_pod set document_id = $2 where job_id = $1', [job.id, left.id]);
      else {
        await c.query(`update transport_requests set pod_status = 'pending' where id = $1`, [job.id]);
        if (job.status_code === 'pod_received') await c.query(`update transport_requests set status_code = 'pod_pending' where id = $1`, [job.id]);
        await c.query('update job_pod set document_id = null, verified_by = null, verified_at = null where job_id = $1', [job.id]);
        await audit(c, actor, { entity_type: 'job', entity_id: job.id, job_id: job.id, action: 'POD status changed', field: 'POD', old_value: job.pod_status, new_value: 'pending' });
      }
    }
  });
  return { ok: true };
}

// ------------------------------------------------------------ notes
export async function addNote(actor: Actor, jobId: string, b: any) {
  const body = String(b.body ?? '').trim();
  if (!body) throw bad('Write a note first');
  if (body.length > 2000) throw bad('Notes can be up to 2000 characters');
  const visibility = b.visibility === 'commercial' ? 'commercial' : 'all';
  if (visibility === 'commercial' && !actor.fin.sellingView) throw forbidden();
  await tx(async (c) => {
    const job = await visibleJob(actor, jobId, c);
    if (job.stage === 'cancelled' && !actor.isSuperAdmin) throw new ApiError(409, 'JOB_LOCKED', 'Cancelled jobs are read-only.');
    await c.query('insert into job_notes (job_id, user_id, body, visibility) values ($1,$2,$3,$4)', [jobId, actor.id, body, visibility]);
    // Notify the other side of the job. Commercial notes only go to people who may read them.
    const a = await one('select assigned_by from transport_assignments where job_id = $1 and is_current', [jobId], c);
    const targets: string[] = [];
    for (const uid of [job.requested_by, a?.assigned_by]) {
      if (!uid || uid === actor.id) continue;
      if (visibility === 'commercial') {
        const { loadActor } = await import('./auth');
        const other = await loadActor(uid);
        if (!other?.fin.sellingView) continue;
      }
      targets.push(uid);
    }
    await notify(c, targets, 'job.note', `New note on ${job.job_no ?? job.job_number}`, jobId);
  });
  return getJob(actor, jobId);
}

export async function deleteNote(actor: Actor, noteId: string) {
  if (!UUID.test(noteId)) throw notFound('Note');
  const n = await one('select * from job_notes where id = $1 and deleted_at is null', [noteId]);
  if (!n) throw notFound('Note');
  await visibleJob(actor, n.job_id);
  if (n.visibility === 'commercial' && !actor.fin.sellingView) throw notFound('Note');
  if (n.user_id !== actor.id && !actor.isSuperAdmin) throw forbidden('You can only remove your own notes');
  await q('update job_notes set deleted_at = now() where id = $1', [noteId]);
  return getJob(actor, n.job_id);
}

// ------------------------------------------------------------ POD reminders
/** Runs at most every 10 minutes, triggered by normal app use (no scheduler needed). */
export async function runPodReminders(force = false) {
  const claimed = await one(`update settings set value = to_jsonb(now()::text)
      where key = 'pod_reminder_last_run' and ($1 or (value #>> '{}')::timestamptz < now() - interval '10 minutes') returning 1 ok`, [force]);
  if (!claimed) return 0;
  const hours = Number(await getSetting('pod_reminder_hours', 24));
  const due = await q(`select t.id, t.job_number, t.job_no, t.pod_status from transport_requests t
      join job_statuses s on s.code = t.status_code
      join transport_assignments a on a.job_id = t.id and a.is_current
     where t.deleted_at is null and s.stage = 'delivered' and t.pod_status in ('pending','rejected')
       and a.actual_delivery_at < now() - make_interval(hours => $1)
       and (t.pod_reminded_at is null or t.pod_reminded_at < now() - make_interval(hours => $1))`, [hours]);
  if (!due.length) return 0;
  await tx(async (c) => {
    for (const j of due) {
      const people = await usersWithPermission(c, 'pod.upload', undefined, j.id);
      await notify(c, people.map((u) => u.id), 'pod.reminder',
        j.pod_status === 'rejected' ? `POD still needs re-uploading for ${j.job_no ?? j.job_number}` : `POD still missing for ${j.job_no ?? j.job_number}`, j.id);
      await c.query('update transport_requests set pod_reminded_at = now() where id = $1', [j.id]);
    }
  });
  return due.length;
}

// ------------------------------------------------------------ admin: storage self-test
export async function storageCheck(actor: Actor) {
  requirePerm(actor, 'settings.manage');
  const steps: { step: string; ok: boolean; detail?: string }[] = [];
  const run = async (step: string, fn: () => Promise<string | void>) => {
    try { steps.push({ step, ok: true, detail: (await fn()) || undefined }); return true; }
    catch (e: any) { steps.push({ step, ok: false, detail: e?.message ?? String(e) }); return false; }
  };
  let store: ReturnType<typeof fileStore>;
  if (!(await run('Storage settings present', async () => { store = fileStore(); return store.driver; }))) return { ok: false, steps };
  const key = `_healthcheck/${randomUUID()}.pdf`;
  const content = Buffer.from('%PDF-1.4\n% TMS storage check\n');
  let target: any;
  const ok = await run('Create upload link', async () => { target = await store!.createUpload(key, 'application/pdf'); })
    && await run('Upload a test file', async () => {
      if (store!.driver === 'local') { const { localWrite } = await import('./storage'); await localWrite(key, content, 'application/pdf'); return; }
      const r = await fetch(target.url, { method: 'PUT', headers: target.headers, body: content });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    })
    && await run('Read file details', async () => { const s = await store!.stat(key); if (!s) throw new Error('File not found after upload'); return `${s.size} bytes, ${s.contentType}`; })
    && await run('Create download link', async () => {
      const u = await store!.downloadUrl(key, 'check.pdf');
      if (store!.driver === 'supabase') { const r = await fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status}`); }
    })
    && await run('Delete test file', async () => { await store!.remove(key); });
  return { ok, steps };
}


// ------------------------------------------------------------ 30-day document clean-up
/**
 * Deletes request documents whose retention has run out (30 days from each file's own upload time):
 *   1. the real file is removed from storage,
 *   2. then the record is marked "expired" (purged_at) — the job, its history and reports stay.
 * A file that can't be deleted is logged on the document (purge_error, purge_attempts) and on the run,
 * and is simply tried again on the next run. Runs are recorded in document_cleanup_runs.
 *
 * Triggered by: the Netlify scheduled function (every hour), a backup trigger on normal app use
 * (if no run in the last 2 hours), and "Run now" in Settings.
 */
export async function runDocumentCleanup(trigger: 'schedule' | 'backup' | 'manual', limit = 500, storeOverride?: Pick<ReturnType<typeof fileStore>, 'remove'>) {
  const { pool } = await import('./db');
  const lock = await pool().connect();
  try {
    // only one clean-up at a time, even if two triggers fire together
    if (!(await lock.query('select pg_try_advisory_lock(hashtext($1)) ok', ['document_cleanup'])).rows[0].ok)
      return { skipped: true, deleted: 0, failed: 0 };
    const run = await one('insert into document_cleanup_runs (trigger) values ($1) returning id', [trigger]);
    let deleted = 0, failed = 0, store: Pick<ReturnType<typeof fileStore>, 'remove'> | null = null;
    try {
      store = storeOverride ?? fileStore();     // (tests pass a store that fails on purpose)
      const due = await q(`select d.id, d.job_id, d.storage_path, d.file_name, dt.name type_name, dt.is_commercial
          from job_documents d join document_types dt on dt.code = d.document_type_code
         where d.expires_at is not null and d.expires_at <= now() and d.purged_at is null
         order by d.expires_at limit $1`, [limit]);
      for (const d of due) {
        try {
          await store.remove(d.storage_path);                          // 1. the real file
          await tx(async (c) => {                                         // 2. then the record
            await c.query(`update job_documents set purged_at = now(), purge_error = null, purge_tried_at = now(),
                purge_attempts = purge_attempts + 1 where id = $1`, [d.id]);
            await audit(c, null, { entity_type: 'job', entity_id: d.job_id, job_id: d.job_id,
              action: `${d.type_name} deleted (30-day rule)`, old_value: d.file_name, sensitivity: d.is_commercial ? 'commercial' : 'general' });
          });
          deleted++;
        } catch (e: any) {
          failed++;
          console.error('Document clean-up failed', d.id, e?.message ?? e);
          await q(`update job_documents set purge_attempts = purge_attempts + 1, purge_tried_at = now(), purge_error = $2 where id = $1`,
            [d.id, String(e?.message ?? e).slice(0, 500)]).catch(() => {});
        }
      }
      await q('update document_cleanup_runs set finished_at = now(), deleted = $2, failed = $3 where id = $1', [run.id, deleted, failed]);
    } catch (e: any) {
      console.error('Document clean-up run failed', e);
      await q('update document_cleanup_runs set finished_at = now(), deleted = $2, failed = $3, error = $4 where id = $1',
        [run.id, deleted, failed, String(e?.message ?? e).slice(0, 500)]).catch(() => {});
    }
    return { skipped: false, deleted, failed };
  } finally {
    await lock.query('select pg_advisory_unlock(hashtext($1))', ['document_cleanup']).catch(() => {});
    lock.release();
  }
}

/** Backup in case the scheduled function ever stops: normal app use runs the clean-up if none ran for 2 hours. */
export async function maybeRunDocumentCleanup() {
  const last = await one(`select max(started_at) at from document_cleanup_runs`).catch(() => null);
  if (last?.at && new Date(last.at).getTime() > Date.now() - 2 * 3600_000) return;
  await runDocumentCleanup('backup');
}

/** Settings → Document clean-up: proof that it runs, and anything that failed. */
export async function cleanupStatus(actor: Actor) {
  requirePerm(actor, 'settings.manage');
  return {
    runs: await q(`select id, started_at, finished_at, trigger, deleted, failed, error from document_cleanup_runs order by id desc limit 10`),
    waiting: Number((await one(`select count(*) n from job_documents where expires_at <= now() and purged_at is null`))!.n),
    next_due: (await one(`select min(expires_at) at from job_documents where purged_at is null and expires_at > now()`))?.at ?? null,
    deleted_30d: Number((await one(`select count(*) n from job_documents where purged_at > now() - interval '30 days'`))!.n),
    problems: await q(`select d.id, d.file_name, t.job_no, t.job_number, d.purge_attempts, d.purge_error, d.purge_tried_at
        from job_documents d join transport_requests t on t.id = d.job_id
       where d.purged_at is null and d.purge_error is not null order by d.purge_tried_at desc limit 20`),
  };
}
