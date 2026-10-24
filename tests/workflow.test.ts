/** Phase 2 (masters) and Phase 3 (assignment & workflow) against real Postgres. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, deptId } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createUser, updateUser, listNotifications } from '../src/server/admin';
import { createJob, getJob, listJobs, updateFinancials } from '../src/server/jobs';
import { createMaster, updateMaster, deleteMaster, listMaster } from '../src/server/masters';
import { assignJob, availability, changeStatus, updateRequest, setPodNotRequired, saveSettings, saveStatus, getSettings } from '../src/server/workflow';

let admin: Actor, ops: Actor, transport: Actor, finance: Actor;
let customerId: string, van: string, ton3: string;
let ahmed: string, rahim: string, onLeave: string, expired: string;
let truckA: string, truckB: string, vanV: string, broken: string;
const tz = 'Asia/Dubai';
const dayPlus = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: tz });
const D = dayPlus(2);
const at = (hhmm: string, d = D) => `${d}T${hhmm}`;

async function rejects(p: Promise<unknown>, code: string, check?: (e: any) => void) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); check?.(e); return true; });
}
async function newJob(extra: any = {}) {
  return createJob(ops, { customer_id: customerId, required_date: D, pickup_name: 'Jebel Ali', delivery_name: 'DIP',
    base_selling_price: '400', ...extra });
}

before(async () => {
  await resetDb();
  const a = await one("select id from users where email = 'admin@company.local'");
  admin = (await loadActor(a.id))!;
  const role = async (c: string) => (await one('select id from roles where code = $1', [c])).id;
  const mk = (name: string, r: string) => mkUser(admin, name, r);
  ops = await mk('ops', 'operations_manager'); transport = await mk('tr', 'transport'); finance = await mk('fin', 'finance');
  customerId = (await createMaster(ops, 'customers', { name: 'ABC Trading' })).id;
  van = (await one("select id from vehicle_types where name = 'Van'")).id;
  ton3 = (await one("select id from vehicle_types where name = '3 Ton'")).id;
  ahmed = (await createMaster(transport, 'drivers', { full_name: 'Ahmed Khan', mobile: '+971 50 111 2222', license_expiry: dayPlus(300) })).id;
  rahim = (await createMaster(transport, 'drivers', { full_name: 'Rahim', mobile: '0502223333' })).id;
  onLeave = (await createMaster(transport, 'drivers', { full_name: 'Salim', status: 'on_leave' })).id;
  expired = (await createMaster(transport, 'drivers', { full_name: 'Old Licence', license_expiry: dayPlus(-1) })).id;
  truckA = (await createMaster(transport, 'vehicles', { vehicle_number: 'dxb  12345', vehicle_type_id: ton3, weight_capacity_kg: 3000 })).id;
  truckB = (await createMaster(transport, 'vehicles', { vehicle_number: 'DXB 54321', vehicle_type_id: ton3, weight_capacity_kg: 3000 })).id;
  vanV = (await createMaster(transport, 'vehicles', { vehicle_number: 'SHJ 777', vehicle_type_id: van, weight_capacity_kg: 1000 })).id;
  broken = (await createMaster(transport, 'vehicles', { vehicle_number: 'AUH 1', vehicle_type_id: ton3, status: 'maintenance' })).id;
});

// ------------------------------------------------------------------ Phase 2
test('Masters: validation, normalisation, duplicates', async () => {
  const v = await listMaster(transport, 'vehicles', { q: '12345' });
  assert.equal(v.rows[0].vehicle_number, 'DXB 12345', 'plate upper-cased and spaces collapsed');
  assert.equal(v.rows[0].vehicle_type_name, '3 Ton');
  await rejects(createMaster(transport, 'vehicles', { vehicle_number: 'DXB 12345', vehicle_type_id: ton3 }), 'DUPLICATE');
  await rejects(createMaster(transport, 'drivers', { full_name: '' }), 'VALIDATION');
  await rejects(createMaster(transport, 'drivers', { full_name: 'X', mobile: 'call me' }), 'VALIDATION');
  await rejects(createMaster(transport, 'drivers', { full_name: 'X', status: 'flying' }), 'VALIDATION');
  await rejects(createMaster(ops, 'customers', { name: 'abc trading' }), 'DUPLICATE');
  await rejects(createMaster(transport, 'locations', { name: 'X', latitude: 95 }), 'VALIDATION');
});

test('Masters: permissions follow the role', async () => {
  await rejects(createMaster(transport, 'customers', { name: 'Nope' }), 'FORBIDDEN');
  await rejects(createMaster(ops, 'drivers', { full_name: 'Nope' }), 'FORBIDDEN');
  await rejects(createMaster(ops, 'vehicle_types', { name: 'Nope' }), 'FORBIDDEN');
  assert.ok((await listMaster(ops, 'drivers', {})).total >= 4, 'Operations can see drivers');
  await rejects(listMaster(ops, 'nonsense', {}), 'NOT_FOUND');
});

test('Masters: edits are audited', async () => {
  await updateMaster(transport, 'drivers', rahim, { mobile: '0509998888' });
  const a = await one("select * from audit_log where entity_id = $1 and action = 'Driver updated'", [rahim]);
  assert.deepEqual([a.field, a.old_value, a.new_value], ['Mobile', '0502223333', '0509998888']);
});

// ------------------------------------------------------------------ Phase 3
let job1: string, job2: string;
test('Assign: happy path moves job to Assigned and notifies requester', async () => {
  job1 = (await newJob({ requested_vehicle_type_id: ton3, weight_kg: 2000, boe_number: 'BOE-A1' })).id;
  const j = await assignJob(transport, job1, { driver_id: ahmed, vehicle_id: truckA, planned_pickup_at: at('10:00'), planned_delivery_at: at('12:00') });
  assert.equal(j.status_code, 'assigned');
  assert.equal(j.driver_name, 'Ahmed Khan');
  assert.equal(j.vehicle_number, 'DXB 12345');
  const n = await listNotifications(ops);
  assert.ok(n.rows.some((r: any) => r.title === `Driver and vehicle assigned to ${j.job_number}`));
  assert.equal((await listJobs(ops, { q: 'ahmed kh' })).total, 1, 'search finds job by driver name');
  assert.equal((await listJobs(ops, { q: '12345' })).total, 1, 'search finds job by plate');
});

test('Assign: double-booking is blocked with the spec message; override needs permission', async () => {
  job2 = (await newJob({ boe_number: 'BOE-A2' })).id;
  await rejects(assignJob(transport, job2, { driver_id: ahmed, vehicle_id: truckB, planned_pickup_at: at('11:00'), planned_delivery_at: at('13:00') }),
    'ASSIGNMENT_BLOCKED', (e) => {
      assert.match(e.details.issues[0].message, /Driver already assigned to another job during this time slot/);
      assert.equal(e.details.can_override, false);
    });
  await rejects(assignJob(transport, job2, { driver_id: rahim, vehicle_id: truckA, planned_pickup_at: at('11:59'), planned_delivery_at: at('14:00') }),
    'ASSIGNMENT_BLOCKED', (e) => assert.match(e.details.issues[0].message, /Vehicle already assigned during this time slot/));
  await rejects(assignJob(transport, job2, { driver_id: ahmed, vehicle_id: truckB, planned_pickup_at: at('11:00'), override_conflicts: true }), 'FORBIDDEN');
  // back-to-back is fine: [10:00,12:00) then 12:00
  const ok = await assignJob(transport, job2, { driver_id: ahmed, vehicle_id: truckB, planned_pickup_at: at('12:00'), planned_delivery_at: at('13:00') });
  assert.equal(ok.status_code, 'assigned');
  // admin can override, and the override is recorded
  const j3 = (await newJob()).id;
  await assignJob(admin, j3, { driver_id: ahmed, vehicle_id: vanV, planned_pickup_at: at('10:30'), override_conflicts: true });
  assert.ok((await getJob(admin, j3)).activity.some((a: any) => a.action === 'Conflict overridden'));
  await changeStatus(admin, j3, { to: 'cancelled', reason: 'test cleanup' });
});

test('Assign: leave, expired licence and maintenance are blocking', async () => {
  const j = (await newJob()).id;
  const blocked = async (d: string, v: string, re: RegExp) => rejects(
    assignJob(transport, j, { driver_id: d, vehicle_id: v, planned_pickup_at: at('16:00') }), 'ASSIGNMENT_BLOCKED',
    (e) => assert.ok(e.details.issues.some((i: any) => re.test(i.message)), JSON.stringify(e.details)));
  await blocked(onLeave, truckB, /on leave/);
  await blocked(expired, truckB, /licence expired/);
  await blocked(rahim, broken, /maintenance/);
});

test('Assign: wrong type, overweight and different day are warnings to confirm', async () => {
  const j = (await newJob({ requested_vehicle_type_id: ton3, weight_kg: 1500 })).id;
  await rejects(assignJob(transport, j, { driver_id: rahim, vehicle_id: vanV, planned_pickup_at: at('08:00', dayPlus(3)) }),
    'ASSIGNMENT_WARNINGS', (e) => {
      const m = e.details.issues.map((i: any) => i.message).join(' | ');
      assert.match(m, /asked for a 3 Ton/); assert.match(m, /over this vehicle's 1000 kg/); assert.match(m, /Operations required/);
    });
  const ok = await assignJob(transport, j, { driver_id: rahim, vehicle_id: vanV, planned_pickup_at: at('08:00', dayPlus(3)), confirm_warnings: true });
  assert.equal(ok.status_code, 'assigned');
});

test('Availability shows who is busy and who is blocked before assigning', async () => {
  const a = await availability(transport, { from: at('11:00'), to: at('11:30') });
  const drv = (id: string) => a.drivers.find((d: any) => d.id === id);
  assert.equal(drv(ahmed).conflicts.length, 1);
  assert.equal(drv(rahim).conflicts.length, 0);
  assert.equal(drv(onLeave).blocked, true);
  assert.equal(drv(expired).blocked, true);
  assert.equal(a.vehicles.find((v: any) => v.id === broken).blocked, true);
  await rejects(availability(ops, { from: at('11:00') }), 'FORBIDDEN');
});

test('Operations cannot assign; Transport cannot edit request details', async () => {
  const j = (await newJob()).id;
  await rejects(assignJob(ops, j, { driver_id: rahim, vehicle_id: truckB, planned_pickup_at: at('20:00') }), 'FORBIDDEN');
  await rejects(updateRequest(transport, j, { special_instructions: 'x' }), 'FORBIDDEN');
});

test('Status flow: dispatch → pickup → deliver records times; POD gate on completion', async () => {
  await rejects(changeStatus(transport, job2, { to: 'completed' }), 'INVALID_TRANSITION');
  await changeStatus(transport, job2, { to: 'dispatched' });
  await changeStatus(transport, job2, { to: 'picked_up', at: at('12:05') });
  await rejects(changeStatus(transport, job2, { to: 'delivered', at: at('11:00') }), 'VALIDATION');
  const j = await changeStatus(transport, job2, { to: 'delivered', at: at('12:50') });
  assert.equal(j.status_code, 'delivered');
  assert.ok(j.actual_pickup_at && j.actual_delivery_at);
  assert.ok((await listNotifications(ops)).rows.some((r: any) => r.title === `${j.job_number} delivered`));
  assert.equal((await listJobs(ops, { action_required: 'pod' })).total, 1, 'Delivered + POD pending = action required');
  await rejects(changeStatus(transport, job2, { to: 'completed' }), 'POD_REQUIRED');
  await rejects(setPodNotRequired(transport, job2, true), 'FORBIDDEN');
  await setPodNotRequired(admin, job2, true);
  assert.equal((await changeStatus(transport, job2, { to: 'completed' })).status_code, 'completed');
});

test('Status flow: cannot dispatch without driver + vehicle; unassign returns to queue', async () => {
  const j = (await newJob()).id;
  await rejects(changeStatus(transport, j, { to: 'assigned' }), 'NOT_ASSIGNED');
  await assignJob(transport, j, { driver_id: rahim, planned_pickup_at: at('21:00') });
  await rejects(changeStatus(transport, j, { to: 'dispatched' }), 'NOT_ASSIGNED');
  const back = await changeStatus(transport, j, { to: 'pending_assignment' });
  assert.equal(back.driver_id, null);
  const a = await availability(transport, { from: at('21:00') });
  assert.equal(a.drivers.find((d: any) => d.id === rahim).conflicts.length, 0, 'unassigned slot is free again');
});

test('Cancel: needs reason and permission, frees the driver, stays in history', async () => {
  const j = (await newJob()).id;
  await assignJob(transport, j, { driver_id: rahim, vehicle_id: truckB, planned_pickup_at: at('18:00') });
  await rejects(changeStatus(transport, j, { to: 'cancelled', reason: 'no' }), 'FORBIDDEN');
  await rejects(changeStatus(ops, j, { to: 'cancelled' }), 'VALIDATION');
  const c = await changeStatus(ops, j, { to: 'cancelled', reason: 'Customer postponed' });
  assert.equal(c.cancel_reason, 'Customer postponed');
  assert.equal((await listJobs(ops, { status: 'cancelled' })).total >= 1, true);
  await assignJob(transport, (await newJob()).id, { driver_id: rahim, vehicle_id: truckB, planned_pickup_at: at('18:00') });
  assert.ok((await listNotifications(transport)).rows.some((r: any) => /cancelled/.test(r.title)));
});

test('Draft: submit notifies Transport; Operations edits before assignment only', async () => {
  const d = await newJob({ save_as_draft: true });
  assert.equal((await getJob(ops, d.id)).status_code, 'draft');
  await updateRequest(ops, d.id, { special_instructions: 'Call before arrival', weight_kg: '120' });
  const moved = await changeStatus(ops, d.id, { to: 'pending_assignment' });
  assert.equal(moved.status_code, 'pending_assignment');
  assert.ok((await listNotifications(transport)).rows.some((r: any) => r.title === `New transport request ${moved.job_number}`));
  await assignJob(transport, d.id, { driver_id: rahim, vehicle_id: vanV, planned_pickup_at: at('06:00') });
  await rejects(updateRequest(ops, d.id, { special_instructions: 'late change' }), 'FORBIDDEN');
  const act = (await getJob(ops, d.id)).activity.filter((a: any) => a.action === 'Request updated').map((a: any) => a.field);
  assert.deepEqual(act.sort(), ['Special instructions', 'Weight']);
});

test('Deleting a driver or vehicle on an open job is refused', async () => {
  await rejects(deleteMaster(transport, 'drivers', rahim), 'IN_USE');
  await rejects(deleteMaster(transport, 'vehicles', truckB), 'IN_USE');
  await rejects(deleteMaster(admin, 'vehicle_types', ton3), 'IN_USE');
  const tmp = (await createMaster(transport, 'drivers', { full_name: 'Temp' })).id;
  await deleteMaster(transport, 'drivers', tmp);
  assert.equal((await listMaster(transport, 'drivers', { q: 'Temp' })).total, 0);
});

test('Confidentiality still holds after assignment and status changes', async () => {
  const j = await getJob(transport, job1);
  const json = JSON.stringify(j) + JSON.stringify(await listJobs(transport, {})) + JSON.stringify(await listNotifications(transport));
  for (const leak of ['commercial', 'net_revenue', 'customer_total', 'vat_amount', 'gross_profit', 'Selling price'])
    assert.ok(!json.includes(leak), `leaked ${leak}`);
  assert.ok(j.next_statuses.some((s: any) => s.code === 'dispatched'));
  assert.ok(!j.next_statuses.some((s: any) => s.code === 'cancelled'), 'Transport has no cancel by default');
  void finance; void updateFinancials;
});

test('Settings: validated, audited, VAT change affects new jobs only', async () => {
  await rejects(saveSettings(ops, { vat_rate: 10 }), 'FORBIDDEN');
  await rejects(saveSettings(admin, { vat_rate: 150 }), 'VALIDATION');
  await rejects(saveSettings(admin, { currency: 'dirham' }), 'VALIDATION');
  const before = await getJob(ops, job1);
  await saveSettings(admin, { vat_rate: 10, job_number_prefix: 'TR-' });
  assert.equal((await getJob(ops, job1)).financials.commercial.vat_amount, before.financials.commercial.vat_amount);
  const n = await newJob();
  assert.match(n.job_number, /^TR-/);
  assert.equal((await getJob(ops, n.id)).financials.commercial.vat_amount, '40.00');
  await saveSettings(admin, { vat_rate: 5, job_number_prefix: 'JOB-' });
});

test('Custom status can be added between two steps and used', async () => {
  await saveStatus(admin, { name: 'At Customs', color: '#446688', after: 'picked_up', before: 'in_transit' });
  const s = await getSettings(admin);
  assert.ok(s.statuses.some((x: any) => x.code === 'at_customs'));
  const j = (await newJob()).id;
  await assignJob(transport, j, { driver_id: ahmed, vehicle_id: vanV, planned_pickup_at: at('01:00'), planned_delivery_at: at('02:00') });
  for (const to of ['dispatched', 'picked_up', 'at_customs', 'in_transit']) await changeStatus(transport, j, { to });
  assert.equal((await getJob(ops, j)).status_code, 'in_transit');
  await rejects(saveStatus(admin, { code: 'delivered', name: 'Delivered', color: '#2F855A', is_active: false }), 'VALIDATION');
  await updateUser(admin, ops.id, {}); // no-op sanity
});
