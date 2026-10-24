/** Stage 3 — phone app: app links, driver role, sign-in by mobile. Real Postgres + local file driver. */
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_UPLOAD_DIR = '/tmp/tms-test-uploads';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, login, Actor } from '../src/server/auth';
import { listNotifications } from '../src/server/admin';
import { createJob, dashboard, getJob, listJobs } from '../src/server/jobs';
import { createMaster, listMaster } from '../src/server/masters';
import { assignJob, changeStatus } from '../src/server/workflow';
import { requestUpload, confirmUpload } from '../src/server/documents';
import { localWrite } from '../src/server/storage';
import { appLinkForDriver, appLinkForUser, appLinkInfo, useAppLink } from '../src/server/applink';

let admin: Actor, ops: Actor, tm: Actor, tsub: Actor, mm: Actor, messenger: Actor;
let drvA: string, drvB: string, driver: Actor;
const D = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const tokenOf = (path: string) => path.split('/').pop()!;
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); return true; });
}
let vehN = 0;
async function jobFor(driverId: string, price = '555.55') {
  const j = await createJob(ops, { customer_id: (await one('select id from customers limit 1')).id, required_date: D,
    pickup_name: 'Jebel Ali Port', pickup_contact_number: '0500000001', delivery_name: 'Warehouse 7', base_selling_price: price });
  const veh = (await createMaster(tm, 'vehicles', { vehicle_number: `D ${++vehN}`, vehicle_type_id: (await one("select id from vehicle_types where name='3 Ton'")).id })).id;
  await assignJob(tm, j.id, { driver_id: driverId, vehicle_id: veh, planned_pickup_at: `${D}T${String(6 + vehN).padStart(2, '0')}:00`, confirm_warnings: true, override_conflicts: true });
  return j;
}

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  ops = await mkUser(admin, 'ops', 'operations_manager');
  tm = await mkUser(admin, 'tm', 'transport_manager');
  tsub = await mkUser(admin, 'tsub', 'transport');
  mm = await mkUser(admin, 'mm', 'messenger_manager');
  messenger = await mkUser(admin, 'Ali Messenger', 'messenger');
  await q("update users set mobile = '055 111 2222' where id = $1", [messenger.id]);
  await createMaster(ops, 'customers', { name: 'ABC' });
  drvA = (await createMaster(tm, 'drivers', { full_name: 'Rashid Driver', mobile: '+971 50 123 4567' })).id;
  drvB = (await createMaster(tm, 'drivers', { full_name: 'Other Driver' })).id;
});

test('Only the Transport Manager or Super Admin can send a driver the app; a mobile number is needed', async () => {
  await rejects(appLinkForDriver(tsub, drvA), 'FORBIDDEN');          // Transport Sub-user
  await rejects(appLinkForDriver(mm, drvA), 'FORBIDDEN');            // Messenger Manager
  await rejects(appLinkForDriver(ops, drvA), 'FORBIDDEN');           // Operations Manager
  await rejects(appLinkForDriver(tm, drvB), 'VALIDATION');           // no mobile yet
  const r = await appLinkForDriver(tm, drvA);
  assert.match(r.path, /^\/join\/[A-Za-z0-9_-]{30,}$/);
  assert.equal(r.sign_in_with, '+971 50 123 4567');
  const u = await one(`select u.*, r.code role_code, d.code dept from users u join roles r on r.id = u.role_id
    join departments d on d.id = u.department_id where u.id = (select user_id from drivers where id = $1)`, [drvA]);
  assert.equal(u.role_code, 'driver'); assert.equal(u.dept, 'transport');
  // the stored link is only a hash
  assert.equal(await one('select 1 from app_links where token_hash = $1', [tokenOf(r.path)]), null);
});

test('The link: shows the name, needs a strong password, signs in for 60 days, works once', async () => {
  const old = await appLinkForDriver(admin, drvA);                   // Super Admin can too
  const r = await appLinkForDriver(tm, drvA);                        // a new link switches off the older one
  await rejects(appLinkInfo(tokenOf(old.path)), 'LINK_EXPIRED');
  assert.deepEqual(await appLinkInfo(tokenOf(r.path)), { full_name: 'Rashid Driver', sign_in_with: '+971 50 123 4567', app_only: true });
  await rejects(useAppLink(tokenOf(r.path), 'short1'), 'WEAK_PASSWORD');
  const s = await useAppLink(tokenOf(r.path), 'Truck2026go');
  assert.equal(s.options.maxAge, 60 * 24 * 3600);
  await rejects(useAppLink(tokenOf(r.path), 'Truck2026go'), 'LINK_EXPIRED');
  await rejects(appLinkInfo('x'.repeat(40)), 'LINK_EXPIRED');
  driver = (await loadActor((await one('select user_id from drivers where id = $1', [drvA])).user_id))!;
  assert.equal(driver.must_change_password, false);
});

test('Drivers sign in with their mobile number, written any way', async () => {
  for (const m of ['0501234567', '+971 50 123 4567', '971-50-123-4567'])
    assert.equal((await login(m, 'Truck2026go')).options.maxAge, 60 * 24 * 3600);
  await rejects(login('0501234567', 'wrong-pass-1'), 'INVALID_LOGIN');
  assert.equal((await login('tm@x.ae', 'x'.repeat(3)).catch((e) => e)).code, 'INVALID_LOGIN');
});

test('Two people cannot share a mobile number', async () => {
  await q("update drivers set mobile = '055-111-2222' where id = $1", [drvB]);      // same as the messenger
  await rejects(appLinkForDriver(tm, drvB), 'VALIDATION');
  await q('update drivers set mobile = null where id = $1', [drvB]);
});

test('A driver sees only their own jobs — and never prices', async () => {
  const mine = await jobFor(drvA), other = await jobFor(drvB);
  const list = await listJobs(driver, {} as any);
  assert.deepEqual(list.rows.map((r: any) => r.job_number), [mine.job_number]);
  await rejects(getJob(driver, other.id), 'NOT_FOUND');
  const j = await getJob(driver, mine.id);
  const json = JSON.stringify(j) + JSON.stringify(list);
  for (const leak of ['555.55', 'selling_price', 'revenue', 'profit', 'total_cost', 'gross']) { const i = json.indexOf(leak); assert.ok(i < 0, `leaked ${leak}: ${json.slice(Math.max(0, i - 80), i + 40)}`); }
  assert.equal(j.pickup_contact_number, '0500000001');
  await rejects(listMaster(driver, 'customers', {}), 'FORBIDDEN');
  await rejects(dashboard(driver, D, D), 'FORBIDDEN');
  assert.ok((await listNotifications(driver)).rows.some((n: any) => n.title === `New job for you: ${mine.job_number}`));
});

test('A driver moves the job along the road and uploads the POD — nothing else', async () => {
  const j = await jobFor(drvA);
  assert.deepEqual((await getJob(driver, j.id)).next_statuses.map((s: any) => s.code), ['dispatched']);
  await rejects(changeStatus(driver, j.id, { to: 'cancelled', reason: 'no' }), 'FORBIDDEN');
  for (const to of ['dispatched', 'picked_up', 'delivered']) await changeStatus(driver, j.id, { to });
  await rejects(requestUpload(driver, j.id, { file_name: 'x.pdf', mime_type: 'application/pdf', size: 100, document_type_code: 'boe' }), 'FORBIDDEN');
  const r = await requestUpload(driver, j.id, { file_name: 'pod.jpg', mime_type: 'image/jpeg', size: 2048, document_type_code: 'pod' });
  await localWrite(new URL('http://x' + r.upload.url).searchParams.get('key')!, Buffer.alloc(2048, 1), 'image/jpeg');
  const done = await confirmUpload(driver, j.id, { ticket: r.ticket, received_by: 'Store keeper', pod_date: D });
  assert.equal(done.job.pod_status, 'uploaded');
  await rejects(changeStatus(driver, j.id, { to: 'completed' }), 'FORBIDDEN');
});

test('Taking a job off a driver tells them, and they lose it', async () => {
  const j = await jobFor(drvA);
  const drvC = (await createMaster(tm, 'drivers', { full_name: 'Third Driver' })).id;
  await assignJob(tm, j.id, { driver_id: drvC, planned_pickup_at: `${D}T23:00`, confirm_warnings: true, override_conflicts: true });
  assert.ok((await listNotifications(driver)).rows.some((n: any) => n.title === `${j.job_number} was given to another driver`));
  await rejects(getJob(driver, j.id), 'NOT_FOUND');
});

test('Messengers: the Messenger Manager or Super Admin sends the link, not other managers', async () => {
  await rejects(appLinkForUser(tm, messenger.id), 'NOT_FOUND');      // other departments don't exist for a manager
  await rejects(appLinkForUser(tsub, messenger.id), 'FORBIDDEN');
  const r = await appLinkForUser(mm, messenger.id);
  assert.equal(r.mobile, '055 111 2222');
  await useAppLink(tokenOf(r.path), 'Papers2026ok');
  assert.ok(await login('0551112222', 'Papers2026ok'));
  assert.ok(await appLinkForUser(admin, messenger.id));
});
