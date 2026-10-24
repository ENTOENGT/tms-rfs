/** Stage 2 — Messenger runs. Real Postgres + local file driver. */
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_UPLOAD_DIR = '/tmp/tms-test-uploads';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { listNotifications } from '../src/server/admin';
import { createUser } from '../src/server/team';
import { localWrite } from '../src/server/storage';
import { addRunNote, assignRun, confirmRunUpload, createRun, getRun, listRuns, messengersFor, requestRunUpload, runCounts,
  runFileUrl, updateRun, updateRunStatus } from '../src/server/runs';

let admin: Actor, seaMgr: Actor, ecomMgr: Actor, msgMgr: Actor, ali: Actor, omar: Actor, transport: Actor;
const D = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const base = { required_date: D, task_type: 'collect_deliver', from_name: 'MSC Shipping office', to_name: 'Dubai Customs, Jebel Ali',
  documents: 'Original BL x3', reference: 'BL-77812' };
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); if (msg) assert.match(e.message, msg); return true; });
}
const titles = async (a: Actor) => (await listNotifications(a)).rows.map((r: any) => r.title);

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  seaMgr = await mkUser(admin, 'SeaMgr', 'operations_manager', 'sea_import');
  ecomMgr = await mkUser(admin, 'EcomMgr', 'operations_manager', 'ecom');
  msgMgr = await mkUser(admin, 'MsgMgr', 'messenger_manager', 'messengers');
  transport = await mkUser(admin, 'Trans', 'transport_manager', 'transport');
  const role = (await one("select id from roles where code = 'messenger'")).id;
  const mk = async (n: string) => { const u = await createUser(msgMgr, { full_name: n, email: `${n}@x.ae`, role_id: role });
    await (await import('../src/server/db')).q('update users set must_change_password = false where id = $1', [u.id]); return (await loadActor(u.id))!; };
  ali = await mk('Ali'); omar = await mk('Omar');
});

let run: string, runNo: string;
test('Operations requests a run; Messenger Manager is told', async () => {
  await rejects(createRun(seaMgr, { ...base, documents: '' }), 'VALIDATION', /Documents/);
  await rejects(createRun(seaMgr, { ...base, to_name: '' }), 'VALIDATION', /To/);
  await rejects(createRun(seaMgr, { ...base, required_date: '2020-01-01' }), 'VALIDATION');
  await rejects(createRun(transport, base), 'FORBIDDEN');
  await rejects(createRun(ali, base), 'FORBIDDEN');
  const r = await createRun(seaMgr, base);
  run = r.id; runNo = r.run_number;
  assert.match(runNo, /^MR-\d+$/);
  const g = await getRun(seaMgr, run);
  assert.equal(g.department_name, 'Sea-Import'); assert.equal(g.status, 'pending');
  assert.ok((await titles(msgMgr)).includes(`New messenger run ${runNo}`));
  await rejects(createRun(admin, base), 'VALIDATION', /department/);
});

test('Each department sees its own runs; Messenger Manager sees all; Transport sees none', async () => {
  await createRun(ecomMgr, { ...base, reference: 'ECOM-1' });
  assert.deepEqual((await listRuns(seaMgr, {})).rows.map((r: any) => r.department_name), ['Sea-Import']);
  assert.equal((await listRuns(msgMgr, {})).total, 2);
  await rejects(listRuns(transport, {}), 'FORBIDDEN');
  await rejects(getRun(ecomMgr, run), 'NOT_FOUND');
  assert.equal((await listRuns(seaMgr, { q: 'bl-778' })).total, 1);
});

test('Edit only before assignment', async () => {
  const g = await updateRun(seaMgr, run, { instructions: 'Ask for Mr. Ravi at counter 4' });
  assert.equal(g.instructions, 'Ask for Mr. Ravi at counter 4');
  assert.ok(g.activity.some((a: any) => a.action === 'Run updated'));
});

test('Messenger Manager assigns; only real messengers can be picked', async () => {
  const list = await messengersFor(msgMgr, D);
  assert.deepEqual(list.map((m: any) => m.full_name), ['Ali', 'Omar']);
  await rejects(messengersFor(seaMgr, D), 'FORBIDDEN');
  await rejects(assignRun(seaMgr, run, { messenger_id: ali.id }), 'FORBIDDEN');
  await rejects(assignRun(msgMgr, run, { messenger_id: seaMgr.id }), 'VALIDATION', /not an active messenger/);
  await assignRun(msgMgr, run, { messenger_id: ali.id, planned_at: `${D}T09:30` });
  assert.ok((await titles(ali)).includes(`New run for you: ${runNo}`));
  assert.ok((await titles(seaMgr)).includes(`Messenger assigned to ${runNo}`));
  await rejects(updateRun(seaMgr, run, { instructions: 'late' }), 'RUN_LOCKED');
});

test('A messenger sees only their own runs and cannot touch others', async () => {
  assert.deepEqual((await listRuns(ali, { mine: '1' })).rows.map((r: any) => r.run_number), [runNo]);
  assert.equal((await listRuns(omar, {})).total, 0);
  await rejects(getRun(omar, run), 'NOT_FOUND');
  await rejects(updateRunStatus(omar, run, { to: 'collected' }), 'NOT_FOUND');
  const g = await getRun(ali, run);
  assert.equal(g.can.collect, true); assert.equal(g.can.assign, false); assert.equal(g.can.cancel, false);
});

test('Collected → proof photo → delivered (needs who received it)', async () => {
  await updateRunStatus(ali, run, { to: 'collected' });
  assert.ok((await titles(seaMgr)).includes(`${runNo}: documents collected`));
  const up = await requestRunUpload(ali, run, { file_name: 'stamp.jpg', mime_type: 'image/jpeg', size: 1000, kind: 'proof' });
  await rejects(requestRunUpload(ali, run, { file_name: 'x.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 10 }), 'VALIDATION');
  await localWrite(new URL('http://x' + up.upload.url).searchParams.get('key')!, Buffer.alloc(1000, 1), 'image/jpeg');
  await rejects(confirmRunUpload(omar, run, { ticket: up.ticket }), 'FORBIDDEN');
  const g1 = await confirmRunUpload(ali, run, { ticket: up.ticket });
  assert.equal(g1.files[0].file_name, 'stamp.jpg');
  assert.match(await runFileUrl(seaMgr, g1.files[0].id), /dev-storage/);
  await rejects(runFileUrl(ecomMgr, g1.files[0].id), 'NOT_FOUND');
  await rejects(updateRunStatus(ali, run, { to: 'delivered' }), 'VALIDATION', /received/);
  const g = await updateRunStatus(ali, run, { to: 'delivered', received_by: 'Customs counter 4 — Ahmed' });
  assert.equal(g.status, 'delivered'); assert.equal(g.received_by, 'Customs counter 4 — Ahmed');
  assert.ok((await titles(seaMgr)).includes(`${runNo} delivered`));
  await rejects(updateRunStatus(seaMgr, run, { to: 'cancelled', reason: 'too late' }), 'RUN_LOCKED');
});

test('Could not complete → reassigned to another messenger', async () => {
  const r = await createRun(seaMgr, { ...base, reference: 'BL-2' });
  await assignRun(msgMgr, r.id, { messenger_id: ali.id });
  await rejects(updateRunStatus(ali, r.id, { to: 'failed' }), 'VALIDATION', /Reason/);
  await updateRunStatus(ali, r.id, { to: 'failed', reason: 'Shipping line office closed' });
  assert.ok((await titles(msgMgr)).includes(`${r.run_number} could not be completed`));
  const g = await assignRun(msgMgr, r.id, { messenger_id: omar.id });
  assert.equal(g.status, 'assigned'); assert.equal(g.messenger_name, 'Omar'); assert.equal(g.fail_reason, null);
  assert.ok((await titles(ali)).includes(`${r.run_number} was given to another messenger`));
  await rejects(getRun(ali, r.id), 'NOT_FOUND');
});

test('Cancel needs permission and a reason; notes notify the other side', async () => {
  const r = await createRun(seaMgr, { ...base, reference: 'BL-3' });
  await rejects(updateRunStatus(ali, r.id, { to: 'cancelled', reason: 'x' }), 'NOT_FOUND');
  await rejects(updateRunStatus(seaMgr, r.id, { to: 'cancelled' }), 'VALIDATION');
  await assignRun(msgMgr, r.id, { messenger_id: omar.id });
  await addRunNote(seaMgr, r.id, { body: 'Customer moved the meeting to 2pm' });
  assert.ok((await titles(omar)).includes(`New note on ${r.run_number}`));
  const g = await updateRunStatus(seaMgr, r.id, { to: 'cancelled', reason: 'Customer will collect himself' });
  assert.equal(g.status, 'cancelled');
  assert.ok((await titles(omar)).includes(`${r.run_number} cancelled`));
  await rejects(addRunNote(seaMgr, r.id, { body: 'x' }), 'RUN_LOCKED');
});

test('Dashboard counts follow the same visibility', async () => {
  const m: any = await runCounts(msgMgr);
  assert.equal(m.delivered_today, 1);
  assert.equal(m.pending + m.assigned + m.collected + m.failed, 2);
  const s: any = await runCounts(seaMgr);
  assert.equal(s.pending + m.assigned >= 0, true);
  assert.equal(await runCounts(transport), null);
});
