/** Migration 008 — manual Job No., mandatory delivery contact, request documents, 30-day automatic deletion. */
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_UPLOAD_DIR = '/tmp/tms-test-uploads';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { resetDb, mkUser, reqFields } from './helpers';
import { one, pool, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createJob, getJob, listJobs } from '../src/server/jobs';
import { createMaster } from '../src/server/masters';
import { assignJob, changeStatus, updateRequest } from '../src/server/workflow';
import { confirmUpload, deleteDocument, downloadUrl, listDocuments, requestUpload, runDocumentCleanup, cleanupStatus } from '../src/server/documents';
import { localPath, localWrite } from '../src/server/storage';
import { runReport } from '../src/server/reports';

let admin: Actor, seaImp: Actor, seaImp2: Actor, airExp: Actor, tm: Actor, customer: string, driverId: string, vehicleId: string;
const D = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); return true; });
}
const base = () => ({ customer_id: customer, required_date: D, pickup_name: 'Port', delivery_name: 'Warehouse' });
async function upload(actor: Actor, job: string, type: string, name: string, mime = 'application/pdf') {
  const r = await requestUpload(actor, job, { file_name: name, mime_type: mime, size: 1000, document_type_code: type });
  const key = new URL('http://x' + r.upload.url).searchParams.get('key')!;
  await localWrite(key, Buffer.alloc(1000, 1), mime);
  return { ...(await confirmUpload(actor, job, { ticket: r.ticket })), key };
}

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  seaImp = await mkUser(admin, 'seaimp', 'operations_manager', 'sea_import');
  seaImp2 = await mkUser(admin, 'seaimp2', 'operations', 'sea_import');
  airExp = await mkUser(admin, 'airexp', 'operations_manager', 'air_export');
  tm = await mkUser(admin, 'tm', 'transport_manager');
  customer = (await createMaster(seaImp, 'customers', { name: 'ABC' })).id;
  driverId = (await createMaster(tm, 'drivers', { full_name: 'Drv' })).id;
  vehicleId = (await createMaster(tm, 'vehicles', { vehicle_number: 'V 1', vehicle_type_id: (await one("select id from vehicle_types where name='3 Ton'")).id })).id;
});

test('A request cannot be sent without a Job No. — and none is made up', async () => {
  for (const job_no of [undefined, '', '    ']) {
    const e: any = await createJob(seaImp, { ...base(), ...reqFields(), job_no }).catch((x) => x);
    assert.equal(e.code, 'VALIDATION'); assert.equal(e.details.fields.job_no, 'Enter the Job No.');
  }
  assert.equal(Number((await one('select count(*) n from transport_requests')).n), 0);
});

test('Job No. is saved exactly as typed and can be searched', async () => {
  const j = await createJob(seaImp, { ...base(), ...reqFields(), job_no: '  SI/2026-00451 A  ' });
  const full = await getJob(seaImp, j.id);
  assert.equal(full.job_no, 'SI/2026-00451 A');
  assert.match(full.job_number, /^TR-\d+$/);                                  // the system Request No. is separate
  assert.equal((await listJobs(seaImp, { job_no: '00451' } as any)).total, 1);
  assert.equal((await listJobs(seaImp, { q: 'si/2026-00451' } as any)).total, 1);
});

test('Delivery contact name and number are required; any real phone number is accepted', async () => {
  const e1: any = await createJob(seaImp, { ...base(), ...reqFields(), delivery_contact_person: ' ' }).catch((x) => x);
  assert.equal(e1.details.fields.delivery_contact_person, "Enter the delivery contact person's name");
  const e2: any = await createJob(seaImp, { ...base(), ...reqFields(), delivery_contact_number: '' }).catch((x) => x);
  assert.equal(e2.details.fields.delivery_contact_number, 'Enter the contact number');
  for (const bad of ['abc', '12345', '050-12x-4567', '1234567890123456789'])
    await rejects(createJob(seaImp, { ...base(), ...reqFields(), delivery_contact_number: bad }), 'VALIDATION');
  for (const ok of ['050 123 4567', '+971 4 333 4444', '+44 20 7946 0000', '(04) 333-4444', '00966 55 123 4567'])
    assert.ok(await createJob(seaImp, { ...base(), ...reqFields(), delivery_contact_number: ok }));
  // once saved, the contact can be changed but not emptied
  const j = await createJob(seaImp, { ...base(), ...reqFields() });
  await rejects(updateRequest(seaImp, j.id, { delivery_contact_person: '' }), 'VALIDATION');
  await rejects(updateRequest(seaImp, j.id, { delivery_contact_number: 'x' }), 'VALIDATION');
  assert.equal((await updateRequest(seaImp, j.id, { delivery_contact_number: '+971 55 000 1111' })).delivery_contact_number, '+971 55 000 1111');
});

test('Duplicate Job No.: blocked in the same department, warning then allowed across departments', async () => {
  await createJob(seaImp, { ...base(), ...reqFields(), job_no: 'DUP-1' });
  const same: any = await createJob(seaImp2, { ...base(), ...reqFields(), job_no: 'dup-1 ' }).catch((x) => x);   // case/space-insensitive
  assert.equal(same.code, 'JOB_NO_TAKEN');
  const other: any = await createJob(airExp, { ...base(), ...reqFields(), job_no: 'DUP-1' }).catch((x) => x);
  assert.equal(other.code, 'JOB_NO_OTHER_DEPT'); assert.match(other.message, /Sea.Import/);
  const ok = await createJob(airExp, { ...base(), ...reqFields(), job_no: 'DUP-1', confirm_duplicate_job_no: true });
  assert.equal(ok.job_no, 'DUP-1');
  // the database itself also refuses a same-department duplicate (not only the app check)
  await assert.rejects(q(`insert into transport_requests (job_no, job_number, status_code, required_date, department_id, requested_by, customer_id, pickup_name, delivery_name)
      select 'DUP-1', 'X-1', 'pending_assignment', current_date, department_id, requested_by, customer_id, 'a', 'b' from transport_requests where job_no = 'DUP-1' limit 1`),
    (e: any) => e.constraint === 'tr_job_no_dept_uq');
  // a cancelled job frees its number
  const c = await createJob(seaImp, { ...base(), ...reqFields(), job_no: 'DUP-2' });
  await changeStatus(seaImp, c.id, { to: 'cancelled', reason: 'wrong' });
  assert.ok(await createJob(seaImp, { ...base(), ...reqFields(), job_no: 'DUP-2' }));
  // renaming onto a used number is blocked too
  const r = await createJob(seaImp, { ...base(), ...reqFields(), job_no: 'DUP-3' });
  await rejects(updateRequest(seaImp, r.id, { job_no: 'DUP-1' }), 'JOB_NO_TAKEN');
});

let jobId: string, invoiceKey: string;
test('Several request documents per heading; only PDF/JPG/PNG', async () => {
  const j = await createJob(seaImp, { ...base(), ...reqFields() }); jobId = j.id;
  invoiceKey = (await upload(seaImp, jobId, 'shipment_invoice', 'INV-1.pdf')).key;
  await upload(seaImp, jobId, 'shipment_invoice', 'INV-2.pdf');
  await upload(seaImp, jobId, 'packing_list', 'PL.jpg', 'image/jpeg');
  await upload(seaImp, jobId, 'bl', 'BL.png', 'image/png');
  await upload(seaImp, jobId, 'gate_pass', 'GP.pdf');
  await rejects(requestUpload(seaImp, jobId, { file_name: 'x.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 10, document_type_code: 'supporting_doc' }), 'VALIDATION');
  await rejects(requestUpload(seaImp, jobId, { file_name: 'big.pdf', mime_type: 'application/pdf', size: 11 * 1024 * 1024, document_type_code: 'bl' }), 'VALIDATION');
  const full = await getJob(seaImp, jobId);
  assert.equal(full.request_docs.ready, 5);
  // retention counts from each file's own upload time
  const d = await one(`select created_at, expires_at from job_documents where storage_path = $1`, [invoiceKey]);
  assert.equal(Math.round((new Date(d.expires_at).getTime() - new Date(d.created_at).getTime()) / 86400000), 30);
});

test('Transport can open and print them; other departments cannot', async () => {
  const t = await getJob(tm, jobId);
  assert.equal(t.request_docs.ready, 5);
  assert.equal((await listJobs(tm, { job_no: t.job_no } as any)).rows[0].docs_ready, 5);
  const inv = t.documents.find((d: any) => d.file_name === 'INV-1.pdf');
  assert.match(await downloadUrl(tm, inv.id, true), /inline=1/);
  await rejects(downloadUrl(airExp, inv.id), 'NOT_FOUND');
  await rejects(getJob(airExp, jobId), 'NOT_FOUND');
  assert.equal((await listDocuments(airExp, {})).rows.filter((r: any) => r.job_id === jobId).length, 0);
});

test('Documents can be added or replaced until the trip starts, not after', async () => {
  const doc = (await getJob(seaImp, jobId)).documents.find((d: any) => d.file_name === 'INV-2.pdf');
  await deleteDocument(seaImp, doc.id);                       // replace = remove + upload again (fresh 30 days)
  await upload(seaImp, jobId, 'shipment_invoice', 'INV-2b.pdf');
  await assignJob(tm, jobId, { driver_id: driverId, vehicle_id: vehicleId, planned_pickup_at: `${D}T10:00`, confirm_warnings: true });
  await upload(seaImp, jobId, 'supporting_doc', 'late-but-ok.pdf');               // assigned: still before dispatch
  await changeStatus(tm, jobId, { to: 'dispatched' });
  await rejects(requestUpload(seaImp, jobId, { file_name: 'x.pdf', mime_type: 'application/pdf', size: 10, document_type_code: 'bl' }), 'AFTER_DISPATCH');
  const d = (await getJob(seaImp, jobId)).documents.find((x: any) => x.file_name === 'BL.png');
  await rejects(deleteDocument(seaImp, d.id), 'AFTER_DISPATCH');
  assert.ok(!(await getJob(seaImp, jobId)).permissions.upload_types.some((t: any) => t.code === 'bl'));
});

test('After 30 days: file and record are cleaned up; job, history and reports stay', async () => {
  // a POD is never touched by the 30-day rule
  await changeStatus(tm, jobId, { to: 'picked_up' }); await changeStatus(tm, jobId, { to: 'delivered' });
  const pod = await upload(tm, jobId, 'pod', 'pod.jpg', 'image/jpeg');
  await q(`update job_documents set created_at = now() - interval '31 days', expires_at = now() - interval '1 day'
    where job_id = $1 and expires_at is not null and file_name in ('INV-1.pdf', 'PL.jpg')`, [jobId]);
  assert.ok(existsSync(localPath(invoiceKey)));
  const r = await runDocumentCleanup('manual');
  assert.deepEqual(r, { skipped: false, deleted: 2, failed: 0 });
  assert.ok(!existsSync(localPath(invoiceKey)), 'the stored file itself is gone');
  const full = await getJob(seaImp, jobId);
  const inv = full.documents.find((d: any) => d.file_name === 'INV-1.pdf');
  assert.equal(inv.expired, true); assert.equal(inv.can_delete, false);
  await rejects(downloadUrl(tm, inv.id, true), 'EXPIRED');
  assert.equal(full.request_docs.expired, 2);
  assert.ok(full.activity.some((a: any) => a.action === 'Invoice deleted (30-day rule)' && a.old_value === 'INV-1.pdf'));
  assert.ok(existsSync(localPath(pod.key)), 'POD kept');
  assert.equal(full.job_no, (await one('select job_no from transport_requests where id = $1', [jobId])).job_no);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const rep = await runReport(admin, 'messenger', { from: today, to: today, job_no: full.job_no });
  assert.equal(rep.rows.length, 1); assert.match(String(rep.rows[0].documents), /2 expired/);
  // running again does nothing more
  assert.equal((await runDocumentCleanup('manual')).deleted, 0);
});

test('A failed deletion is logged and retried on the next run', async () => {
  await q(`update job_documents set expires_at = now() - interval '1 minute' where job_id = $1 and file_name = 'BL.png'`, [jobId]);
  const broken = { remove: async () => { throw new Error('Storage is down'); } };
  assert.deepEqual(await runDocumentCleanup('schedule', 500, broken), { skipped: false, deleted: 0, failed: 1 });
  const d = await one(`select purged_at, purge_attempts, purge_error from job_documents where file_name = 'BL.png'`);
  assert.equal(d.purged_at, null); assert.equal(d.purge_attempts, 1); assert.equal(d.purge_error, 'Storage is down');
  const st = await cleanupStatus(admin);
  assert.equal(st.runs[0].failed, 1); assert.equal(st.problems[0].file_name, 'BL.png'); assert.equal(st.waiting, 1);
  assert.equal((await runDocumentCleanup('schedule')).deleted, 1);          // retried, now fine
  assert.equal((await one(`select purge_error from job_documents where file_name = 'BL.png'`)).purge_error, null);
  await rejects(cleanupStatus(tm), 'FORBIDDEN');
});

test('Database update keeps existing jobs: their number becomes their Job No.', async () => {
  const j = await createJob(seaImp, { ...base(), ...reqFields() });
  await q('update transport_requests set job_no = null where id = $1', [j.id]);         // like a job from before the update
  await pool().query(readFileSync('db/migrations/008_request_docs_jobno.sql', 'utf8'));  // safe to run again
  const row = await one('select job_no, job_number from transport_requests where id = $1', [j.id]);
  assert.equal(row.job_no, row.job_number);
});

test('Messenger Report: truck jobs and messenger runs, real data only, with filters and department rules', async () => {
  const { createRun, assignRun, updateRunStatus } = await import('../src/server/runs');
  const mm = await mkUser(admin, 'mm', 'messenger_manager');
  const msg = await mkUser(admin, 'Ali Msg', 'messenger');
  const j = await createJob(seaImp, { ...base(), ...reqFields(), job_no: 'MR-JOB-1', delivery_name: 'Dubai Customs', delivery_contact_person: 'Khalid', delivery_contact_number: '+971 4 111 2222' });
  await assignJob(tm, j.id, { driver_id: driverId, vehicle_id: vehicleId, planned_pickup_at: `${D}T15:00`, confirm_warnings: true, override_conflicts: true });
  await changeStatus(tm, j.id, { to: 'dispatched' });
  const run = await createRun(seaImp, { required_date: D, task_type: 'deliver', documents: 'Original BL x3', from_name: 'Office', to_name: 'MSC Shipping', to_contact_person: 'Rana', to_contact_number: '055 222 3333' });
  await assignRun(mm, run.id, { messenger_id: msg.id });
  await updateRunStatus(msg, run.id, { to: 'collected' });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const P = { from: today, to: today };

  const all = await runReport(admin, 'messenger', P);
  const job = all.rows.find((r: any) => r.job_no === 'MR-JOB-1')!;
  assert.equal(job.type, 'Truck job'); assert.equal(job.delivery_contact_person, 'Khalid'); assert.equal(job.delivery_contact_number, '+971 4 111 2222');
  assert.equal(job.driver_name, 'Drv'); assert.equal(job.vehicle_number, 'V 1'); assert.equal(job.transporter, 'tm');
  assert.equal(job.messenger_name, null); assert.ok(job.dispatch_at, 'dispatch time from the job history'); assert.equal(job.delivered_at, null);
  const mr = all.rows.find((r: any) => r.request_no === run.run_number)!;
  assert.equal(mr.type, 'Messenger run'); assert.equal(mr.messenger_name, 'Ali Msg'); assert.equal(mr.delivery_contact_person, 'Rana');
  assert.equal(mr.driver_name, null); assert.equal(mr.vehicle_number, null); assert.equal(mr.status_name, 'Collected'); assert.ok(mr.dispatch_at);
  assert.equal((all as any).summary.messenger_runs, 1);

  // filters
  assert.deepEqual((await runReport(admin, 'messenger', { ...P, job_no: 'mr-job' })).rows.map((r: any) => r.job_no), ['MR-JOB-1']);
  assert.deepEqual((await runReport(admin, 'messenger', { ...P, messenger_id: msg.id })).rows.map((r: any) => r.request_no), [run.run_number]);
  assert.ok((await runReport(admin, 'messenger', { ...P, driver_id: driverId })).rows.every((r: any) => r.type === 'Truck job'));
  assert.ok((await runReport(admin, 'messenger', { ...P, type: 'runs' })).rows.every((r: any) => r.type === 'Messenger run'));
  assert.deepEqual((await runReport(admin, 'messenger', { ...P, delivery: 'customs' })).rows.map((r: any) => r.job_no), ['MR-JOB-1']);
  assert.equal((await runReport(admin, 'messenger', { ...P, request_no: run.run_number })).total, 1);
  assert.ok((await runReport(admin, 'messenger', { ...P, status: 'cancelled' })).rows.every((r: any) => /Cancel/.test(r.status_name)));
  const sorted = await runReport(admin, 'messenger', { ...P, sort: 'job_no', dir: 'asc' });
  assert.ok(sorted.rows.length > 2);

  // departments see only their own; Transport sees all truck jobs but no messenger runs
  assert.ok(!(await runReport(airExp, 'messenger', P)).rows.some((r: any) => r.job_no === 'MR-JOB-1' || r.request_no === run.run_number));
  const tr = await runReport(tm, 'messenger', P);
  assert.ok(tr.rows.some((r: any) => r.job_no === 'MR-JOB-1')); assert.ok(!tr.rows.some((r: any) => r.type === 'Messenger run'));
  // export works and is the same data
  const { exportReport } = await import('../src/server/reports');
  const csv = (await exportReport(admin, 'messenger', { ...P, job_no: 'MR-JOB-1' }, 'csv')).body.toString();
  assert.match(csv, /Delivery contact/); assert.match(csv, /Khalid/);
});
