/** Stage 1 of the new structure: departments, managers, department-only visibility. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, deptId } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { listNotifications } from '../src/server/admin';
import { createUser, updateUser, listUsers, resetPassword, createRole, setRolePermissions, listRoles, saveDepartment } from '../src/server/team';
import { createJob, getJob, listJobs } from '../src/server/jobs';
import { createMaster } from '../src/server/masters';
import { updateRequest } from '../src/server/workflow';
import { financials } from '../src/server/financials';
import { runReport } from '../src/server/reports';

let admin: Actor, seaMgr: Actor, ecomMgr: Actor, trMgr: Actor, seaClerk: Actor, cust: string;
const D = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const roleId = async (code: string) => (await one('select id from roles where code = $1', [code])).id as string;
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); if (msg) assert.match(e.message, msg); return true; });
}
const reload = async (a: Actor) => (await loadActor(a.id))!;

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  seaMgr = await mkUser(admin, 'SeaManager', 'operations_manager', 'sea_import');
  ecomMgr = await mkUser(admin, 'EcomManager', 'operations_manager', 'ecom');
  trMgr = await mkUser(admin, 'TransportManager', 'transport_manager', 'transport');
  cust = (await createMaster(admin, 'customers', { name: 'ABC Trading' })).id;
});

test('Super Admin: role must match the department side', async () => {
  await rejects(createUser(admin, { full_name: 'X', email: 'x@x.ae', role_id: await roleId('transport_manager'), department_id: await deptId('sea_import') }),
    'VALIDATION', /Transport role.*Sea-Import is on the Operations side/);
  await rejects(createUser(admin, { full_name: 'X', email: 'x@x.ae', role_id: await roleId('operations') }), 'VALIDATION', /department/);
});

test('Manager adds a sub-user — always into their own department', async () => {
  const r = await createUser(seaMgr, { full_name: 'Sea Clerk', email: 'clerk@x.ae', role_id: await roleId('operations'),
    department_id: await deptId('ecom') });                      // tries another department: ignored
  await q('update users set must_change_password = false where id = $1', [r.id]);
  seaClerk = (await loadActor(r.id))!;
  assert.equal(seaClerk.department_code, 'sea_import');
  assert.ok(r.temporary_password.length >= 10);
});

test('Manager cannot hand out manager, Super Admin or other-side roles', async () => {
  for (const code of ['operations_manager', 'super_admin', 'transport', 'messenger'])
    await rejects(createUser(seaMgr, { full_name: 'Y', email: `y-${code}@x.ae`, role_id: await roleId(code) }), 'FORBIDDEN');
});

test('Manager sees and edits only their own department', async () => {
  const l = await listUsers(seaMgr);
  assert.equal(l.scope, 'department');
  assert.deepEqual(l.users.map((u: any) => u.full_name).sort(), ['Sea Clerk', 'SeaManager']);
  assert.equal(l.users.find((u: any) => u.full_name === 'SeaManager').can_edit, false, 'not themselves');
  await rejects(updateUser(seaMgr, ecomMgr.id, { mobile: '0501' }), 'NOT_FOUND');
  await rejects(updateUser(seaMgr, seaMgr.id, { mobile: '0501' }), 'FORBIDDEN');
  await rejects(resetPassword(seaMgr, ecomMgr.id, {}), 'NOT_FOUND');
  await rejects(updateUser(seaMgr, seaClerk.id, { department_id: await deptId('ecom') }), 'FORBIDDEN');
  await rejects(listUsers(seaClerk), 'FORBIDDEN');
  assert.ok((await resetPassword(seaMgr, seaClerk.id, {})).temporary_password);
  await q('update users set must_change_password = false where id = $1', [seaClerk.id]);
});

test('Selling price: off for sub-users until their manager turns it on', async () => {
  seaClerk = await reload(seaClerk);
  assert.equal(seaClerk.fin.sellingView, false);
  await rejects(createJob(seaClerk, { customer_id: cust, required_date: D, pickup_name: 'A', delivery_name: 'B', base_selling_price: '500' }), 'FORBIDDEN');
  await updateUser(seaMgr, seaClerk.id, { overrides: [{ code: 'finance.selling.view', granted: true }, { code: 'finance.selling.edit', granted: true }] });
  seaClerk = await reload(seaClerk);
  assert.equal(seaClerk.fin.sellingEdit, true);
  await rejects(updateUser(seaMgr, seaClerk.id, { overrides: [{ code: 'jobs.view_all', granted: true }] }), 'FORBIDDEN', /jobs.view_all/);
  await rejects(updateUser(seaMgr, seaClerk.id, { overrides: [{ code: 'users.manage_department', granted: true }] }), 'FORBIDDEN');
});

test("Manager's changes never wipe the Super Admin's exceptions", async () => {
  await updateUser(admin, seaClerk.id, { overrides: [{ code: 'finance.selling.view', granted: true }, { code: 'finance.selling.edit', granted: true },
    { code: 'jobs.backdate', granted: true }] });
  await updateUser(seaMgr, seaClerk.id, { overrides: [{ code: 'finance.selling.view', granted: true }, { code: 'finance.selling.edit', granted: true }] });
  assert.equal((await reload(seaClerk)).has('jobs.backdate'), true);
});

test('Transport manager can never hand out selling price', async () => {
  const sub = await createUser(trMgr, { full_name: 'Dispatcher', email: 'disp@x.ae', role_id: await roleId('transport') });
  await rejects(updateUser(trMgr, sub.id, { overrides: [{ code: 'finance.selling.view', granted: true }] }), 'FORBIDDEN');
  const role = await createRole(trMgr, { name: 'Night dispatcher' });
  await rejects(setRolePermissions(trMgr, role.id, ['finance.selling.view']), 'FORBIDDEN');
  await rejects(setRolePermissions(admin, role.id, ['jobs.view', 'finance.profit.view']), 'VALIDATION', /never be given/);
  await setRolePermissions(trMgr, role.id, ['jobs.view', 'jobs.view_all', 'jobs.update_status']);
});

test('Department roles: created by the manager, invisible to other departments', async () => {
  const r = await createRole(seaMgr, { name: 'Senior Clerk' });
  await setRolePermissions(seaMgr, r.id, ['jobs.view', 'jobs.view_department', 'jobs.create', 'finance.selling.view']);
  await rejects(setRolePermissions(seaMgr, r.id, ['jobs.view_all']), 'FORBIDDEN');
  assert.ok((await listRoles(seaMgr)).roles.some((x: any) => x.name === 'Senior Clerk' && x.editable));
  assert.ok(!(await listRoles(ecomMgr)).roles.some((x: any) => x.name === 'Senior Clerk'));
  await rejects(createUser(ecomMgr, { full_name: 'Z', email: 'z@x.ae', role_id: r.id }), 'FORBIDDEN');
  await rejects(setRolePermissions(ecomMgr, r.id, ['jobs.view']), 'FORBIDDEN');
  const u = await createUser(seaMgr, { full_name: 'Senior', email: 'senior@x.ae', role_id: r.id });
  assert.equal((await loadActor(u.id))!.fin.sellingView, true);
});

let seaJob: string;
test('Jobs: each department sees only its own; Transport sees all', async () => {
  const j = await createJob(seaClerk, { customer_id: cust, required_date: D, pickup_name: 'Jebel Ali', delivery_name: 'DIP', base_selling_price: '700' });
  seaJob = j.id;
  const e = await createJob(ecomMgr, { customer_id: cust, required_date: D, pickup_name: 'A', delivery_name: 'B', base_selling_price: '300' });
  assert.equal((await getJob(seaMgr, seaJob)).department_name, 'Sea-Import');
  await rejects(getJob(ecomMgr, seaJob), 'NOT_FOUND');
  await rejects(getJob(seaClerk, e.id), 'NOT_FOUND');
  assert.deepEqual((await listJobs(ecomMgr, {})).rows.map((r: any) => r.department_name), ['E-Com']);
  assert.equal((await listJobs(trMgr, {})).total, 2);
  assert.equal((await listJobs(admin, { department_id: await deptId('sea_import') })).total, 1);
  const n = await listNotifications(trMgr);
  assert.ok(n.rows.some((x: any) => x.title.startsWith('New transport request')), 'Transport is told about every department');
});

test('Financials and reports follow the department rule', async () => {
  const f: any = await financials(ecomMgr, { from: D, to: D });
  assert.equal(f.totals.net_revenue, '300.00');
  const r = await runReport(seaMgr, 'financial', { from: D, to: D });
  assert.deepEqual(r.rows.map((x) => x.net_revenue), ['700.00']);
});

test('Only the Super Admin creates jobs for a chosen department, or moves them', async () => {
  await rejects(createJob(admin, { customer_id: cust, required_date: D, pickup_name: 'A', delivery_name: 'B' }), 'VALIDATION', /department/);
  await rejects(createJob(admin, { department_id: await deptId('transport'), customer_id: cust, required_date: D, pickup_name: 'A', delivery_name: 'B' }), 'VALIDATION');
  await rejects(updateRequest(seaMgr, seaJob, { department_id: await deptId('ecom') }), 'FORBIDDEN');
  await updateRequest(admin, seaJob, { department_id: await deptId('ecom') });
  assert.equal((await getJob(ecomMgr, seaJob)).department_name, 'E-Com');
  await rejects(getJob(seaMgr, seaJob), 'NOT_FOUND');
});

test('Departments: Super Admin adds them; one with users cannot be switched off', async () => {
  const list = await saveDepartment(admin, { name: 'Land Freight', side: 'operations' });
  assert.ok(list.some((d: any) => d.name === 'Land Freight'));
  await rejects(saveDepartment(seaMgr, { name: 'Nope', side: 'operations' }), 'FORBIDDEN');
  const sea = await deptId('sea_import');
  await rejects(saveDepartment(admin, { id: sea, name: 'Sea-Import', is_active: false }), 'VALIDATION', /user/);
  await rejects(saveDepartment(admin, { name: 'Sea-Import', side: 'operations' }), 'DUPLICATE');
});
