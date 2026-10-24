/** Phase 4 — POD, documents, notes, reminders. Real Postgres + local file driver. */
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_UPLOAD_DIR = '/tmp/tms-test-uploads';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, deptId } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createUser, listNotifications, updateUser } from '../src/server/admin';
import { createJob, getJob } from '../src/server/jobs';
import { createMaster } from '../src/server/masters';
import { assignJob, changeStatus } from '../src/server/workflow';
import { localWrite } from '../src/server/storage';
import { addNote, confirmUpload, deleteDocument, deleteNote, downloadUrl, listDocuments, requestUpload, reviewPod, runPodReminders, storageCheck } from '../src/server/documents';

let admin: Actor, ops: Actor, transport: Actor, jobId: string, jobNo: string;
const D = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); return true; });
}
async function upload(actor: Actor, job: string, type: string, name = 'pod.jpg', mime = 'image/jpeg', bytes = 2048, extra: any = {}) {
  const r = await requestUpload(actor, job, { file_name: name, mime_type: mime, size: bytes, document_type_code: type });
  const key = new URL('http://x' + r.upload.url).searchParams.get('key')!;
  await localWrite(key, Buffer.alloc(bytes, 1), mime);
  return confirmUpload(actor, job, { ticket: r.ticket, ...extra });
}
async function deliveredJob() {
  const j = await createJob(ops, { customer_id: (await one('select id from customers limit 1')).id, required_date: D, pickup_name: 'A', delivery_name: 'B', base_selling_price: '777.77' });
  const drv = (await createMaster(transport, 'drivers', { full_name: 'Driver ' + j.job_number })).id;
  const veh = (await createMaster(transport, 'vehicles', { vehicle_number: 'T ' + j.job_number, vehicle_type_id: (await one("select id from vehicle_types where name='3 Ton'")).id })).id;
  await assignJob(transport, j.id, { driver_id: drv, vehicle_id: veh, planned_pickup_at: `${D}T09:00`, confirm_warnings: true });
  for (const to of ['dispatched', 'picked_up', 'delivered']) await changeStatus(transport, j.id, { to });
  return j;
}

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  const role = async (c: string) => (await one('select id from roles where code=$1', [c])).id;
  const mk = (n: string, r: string) => mkUser(admin, n, r);
  ops = await mk('ops', 'operations_manager'); transport = await mk('tr', 'transport');
  await createMaster(ops, 'customers', { name: 'ABC' });
  const j = await deliveredJob(); jobId = j.id; jobNo = j.job_number;
});

test('Transport uploads POD: job moves to POD Received, Operations is notified', async () => {
  const r = await upload(transport, jobId, 'pod', 'signed-pod.jpg', 'image/jpeg', 4096, { received_by: 'Mr. Khalid', pod_date: D, remarks: '2 cartons dented' });
  const j = r.job;
  assert.equal(j.pod_status, 'uploaded');
  assert.equal(j.status_code, 'pod_received');
  assert.equal(j.pod.received_by, 'Mr. Khalid');
  assert.equal(j.documents[0].file_name, 'signed-pod.jpg');
  assert.ok((await listNotifications(ops)).rows.some((n: any) => n.title === `POD uploaded for ${jobNo}`));
});

test('File rules: POD type, size and format limits', async () => {
  await rejects(requestUpload(transport, jobId, { file_name: 'x.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 100, document_type_code: 'pod' }), 'VALIDATION');
  await rejects(requestUpload(transport, jobId, { file_name: 'big.pdf', mime_type: 'application/pdf', size: 11 * 1024 * 1024, document_type_code: 'boe' }), 'VALIDATION');
  await rejects(requestUpload(transport, jobId, { file_name: 'x.exe', mime_type: 'application/x-msdownload', size: 100, document_type_code: 'other' }), 'VALIDATION');
  await rejects(requestUpload(ops, jobId, { file_name: 'p.pdf', mime_type: 'application/pdf', size: 100, document_type_code: 'pod' }), 'FORBIDDEN');
});

test('Upload tickets cannot be forged, reused by someone else, or confirmed without the file', async () => {
  const r = await requestUpload(transport, jobId, { file_name: 'd.pdf', mime_type: 'application/pdf', size: 100, document_type_code: 'delivery_note' });
  await rejects(confirmUpload(transport, jobId, { ticket: r.ticket.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A')) }), 'VALIDATION');
  await rejects(confirmUpload(ops, jobId, { ticket: r.ticket }), 'FORBIDDEN');
  await rejects(confirmUpload(transport, jobId, { ticket: r.ticket }), 'UPLOAD_MISSING');
  const fake = r.ticket.split('.')[0];
  const t = JSON.parse(Buffer.from(fake, 'base64url').toString()); t.type = 'customer_invoice';
  await rejects(confirmUpload(transport, jobId, { ticket: Buffer.from(JSON.stringify(t)).toString('base64url') + '.' + r.ticket.split('.')[1] }), 'VALIDATION');
});

let invoiceId: string;
test('Customer invoice stays invisible to Transport everywhere', async () => {
  await rejects(requestUpload(transport, jobId, { file_name: 'inv.pdf', mime_type: 'application/pdf', size: 100, document_type_code: 'customer_invoice' }), 'FORBIDDEN');
  invoiceId = (await upload(ops, jobId, 'customer_invoice', 'INV-777.pdf', 'application/pdf')).id;
  const tj = await getJob(transport, jobId);
  const json = JSON.stringify(tj) + JSON.stringify(await listDocuments(transport, {})) + JSON.stringify(await listNotifications(transport));
  for (const leak of ['INV-777', 'Customer Invoice', '777.77', 'commercial']) assert.ok(!json.includes(leak), `leaked ${leak}`);
  await rejects(downloadUrl(transport, invoiceId), 'NOT_FOUND');
  await rejects(downloadUrl(transport, invoiceId, true), 'NOT_FOUND');      // viewing is checked exactly like downloading
  await rejects(deleteDocument(transport, invoiceId), 'NOT_FOUND');
  assert.ok((await getJob(ops, jobId)).documents.some((d: any) => d.file_name === 'INV-777.pdf'));
  assert.match(await downloadUrl(ops, invoiceId), /dev-storage\?key=/);
  assert.doesNotMatch(await downloadUrl(ops, invoiceId), /inline=1/);       // Download button saves the file
  assert.match(await downloadUrl(ops, invoiceId, true), /inline=1/);       // viewer opens it on the page
  assert.equal((await listDocuments(ops, { type: 'customer_invoice' })).total, 1);
});

test('POD review: Transport cannot verify; rejection sends it back with a reason', async () => {
  await rejects(reviewPod(transport, jobId, { action: 'verify' }), 'FORBIDDEN');
  await rejects(reviewPod(ops, jobId, { action: 'reject', reason: '' }), 'VALIDATION');
  const r = await reviewPod(ops, jobId, { action: 'reject', reason: 'Signature missing' });
  assert.equal(r.pod_status, 'rejected'); assert.equal(r.status_code, 'pod_pending'); assert.equal(r.pod.rejection_reason, 'Signature missing');
  assert.ok((await listNotifications(transport)).rows.some((n: any) => n.title === `POD rejected for ${jobNo}`));
  await rejects(changeStatus(transport, jobId, { to: 'completed' }), 'POD_REQUIRED');
  const again = (await upload(transport, jobId, 'pod', 'pod-signed-v2.pdf', 'application/pdf')).job;
  assert.equal(again.pod_status, 'uploaded'); assert.equal(again.status_code, 'pod_received'); assert.equal(again.pod.rejection_reason, null);
  const v = await reviewPod(ops, jobId, { action: 'verify' });
  assert.equal(v.pod_status, 'verified'); assert.ok(v.pod.verified_by_name);
});

test('Verified POD is protected; job can now complete', async () => {
  const podDoc = (await getJob(transport, jobId)).documents.find((d: any) => d.file_name === 'pod-signed-v2.pdf');
  assert.equal(podDoc.can_delete, false);
  await rejects(deleteDocument(transport, podDoc.id), 'POD_VERIFIED');
  assert.equal((await changeStatus(transport, jobId, { to: 'completed' })).status_code, 'completed');
  await rejects(requestUpload(transport, jobId, { file_name: 'late.pdf', mime_type: 'application/pdf', size: 10, document_type_code: 'other' }), 'JOB_LOCKED');
});

test('Removing the only POD returns the job to POD Pending', async () => {
  const j = await deliveredJob();
  const up = await upload(transport, j.id, 'pod', 'only.jpg');
  const doc = up.job.documents.find((d: any) => d.document_type_code === 'pod');
  await rejects(deleteDocument(ops, doc.id), 'FORBIDDEN');
  await deleteDocument(transport, doc.id);
  const after = await getJob(ops, j.id);
  assert.equal(after.pod_status, 'pending'); assert.equal(after.status_code, 'pod_pending');
  assert.ok(after.activity.some((a: any) => a.action === 'POD removed'));
});

test('Notes: commercial notes hidden from Transport; the other side is notified', async () => {
  const j = await deliveredJob();
  const before = (await listNotifications(transport)).rows.length;
  await addNote(ops, j.id, { body: 'Customer agreed 850 incl. waiting', visibility: 'commercial' });
  assert.equal((await listNotifications(transport)).rows.length, before, 'no notification about a commercial note');
  await rejects(addNote(transport, j.id, { body: 'x', visibility: 'commercial' }), 'FORBIDDEN');
  await addNote(ops, j.id, { body: 'Gate pass is at reception' });
  assert.ok((await listNotifications(transport)).rows.some((n: any) => n.title === `New note on ${j.job_number}`));
  const tj = await getJob(transport, j.id);
  assert.deepEqual(tj.notes.map((n: any) => n.body), ['Gate pass is at reception']);
  await rejects(deleteNote(transport, tj.notes[0].id), 'FORBIDDEN');
  const oj = await getJob(ops, j.id);
  assert.equal(oj.notes.length, 2);
  await deleteNote(ops, oj.notes[1].id);
  assert.equal((await getJob(ops, j.id)).notes.length, 1);
});

test('POD reminders: sent once per period to Transport, not repeated', async () => {
  const j = await deliveredJob();
  await q(`update transport_assignments set actual_delivery_at = now() - interval '30 hours' where job_id = $1`, [j.id]);
  const n = await runPodReminders(true);
  assert.ok(n >= 1);
  assert.ok((await listNotifications(transport)).rows.some((x: any) => x.title === `POD still missing for ${j.job_number}`));
  assert.equal(await runPodReminders(true), 0, 'no repeat inside the reminder period');
  assert.equal(await runPodReminders(false), 0, 'throttled');
});

test('Documents of another department stay hidden', async () => {
  const limited = ops;
  const other = await createJob(admin, { department_id: await deptId('sea_import'), customer_id: (await one('select id from customers limit 1')).id, required_date: D, pickup_name: 'X', delivery_name: 'Y' });
  const doc = (await upload(admin, other.id, 'boe', 'boe.pdf', 'application/pdf')).id;
  await rejects(downloadUrl(limited, doc), 'NOT_FOUND');
  assert.ok(!(await listDocuments(limited, {})).rows.some((r: any) => r.id === doc));
});

test('Admin storage self-test passes on the configured driver', async () => {
  const r = await storageCheck(admin);
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  await rejects(storageCheck(ops), 'FORBIDDEN');
});
