/** Migration 010 — rental trucks hired when own vehicles are not available. Real Postgres. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, reqFields } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createJob, getJob, listJobs } from '../src/server/jobs';
import { createMaster, listMaster } from '../src/server/masters';
import { lookups } from '../src/server/admin';
import { runReport } from '../src/server/reports';
import * as rent from '../src/server/rentals';

let admin: Actor, ops: Actor, tr: Actor, tm: Actor, customer: string, supA: string, supB: string, ton3: string;
const D = (n = 2) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); return true; });
}
const newJob = () => createJob(ops, { ...reqFields(), customer_id: customer, required_date: D(), pickup_name: 'Jebel Ali', delivery_name: 'DIP', base_selling_price: '900' });
const hire = (extra: any = {}) => ({ subcontractor_id: supA, vehicle_number: 'shj  77001', vehicle_type_id: ton3, driver_name: 'Hired Ali',
  driver_mobile: '055 700 1001', planned_pickup_at: `${D()}T09:00`, planned_delivery_at: `${D()}T13:00`, rental_cost: '450', ...extra });

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  ops = await mkUser(admin, 'ops', 'operations_manager');
  tr = await mkUser(admin, 'tr', 'transport');
  tm = await mkUser(admin, 'tm', 'transport_manager');
  customer = (await createMaster(ops, 'customers', { name: 'ABC Trading' })).id;
  ton3 = (await one("select id from vehicle_types where name = '3 Ton'")).id;
  supA = (await createMaster(tm, 'subcontractors', { name: 'Quick Hire Transport', contact_number: '04 222 3333' })).id;
  supB = (await createMaster(tm, 'subcontractors', { name: 'Gulf Rentals' })).id;
  await createMaster(tm, 'vehicles', { vehicle_number: 'DXB 12345', vehicle_type_id: ton3 });
});

test('Rental companies are a master list; duplicate names are refused', async () => {
  const e: any = await createMaster(tm, 'subcontractors', { name: ' quick hire transport ' }).catch((x) => x);
  assert.match(e.message, /already exists/);
  assert.deepEqual(((await lookups(tr)) as any).rental_companies.map((c: any) => c.name), ['Gulf Rentals', 'Quick Hire Transport']);
});

test('Transport sub-user requests a rental; it waits for the Transport Manager', async () => {
  const j = await newJob();
  await rejects(rent.requestRental(tr, j.id, hire({ driver_name: '', rental_cost: '' })), 'VALIDATION');
  await rejects(rent.requestRental(tr, j.id, hire({ vehicle_number: 'dxb 12345' })), 'VALIDATION');   // own truck → assign normally
  await rejects(rent.requestRental(ops, j.id, hire()), 'FORBIDDEN');                                   // Operations can't hire
  const g = await rent.requestRental(tr, j.id, hire());
  assert.equal(g.rentals.length, 1); assert.equal(g.rentals[0].status, 'requested');
  assert.equal(g.rentals[0].vehicle_number, 'SHJ 77001');
  assert.equal(g.driver_id ?? null, null);                                                              // not assigned yet
  await rejects(rent.requestRental(tr, j.id, hire()), 'RENTAL_PENDING');                                 // only one waiting
  await rejects(rent.approveRental(tr, g.rentals[0].id), 'FORBIDDEN');
  const n = await one(`select count(*)::int n from notifications where user_id = $1 and type = 'rental.requested'`, [tm.id]);
  assert.equal(n.n, 1);
  assert.equal((await listJobs(tm, { action_required: 'rental' })).rows.some((r: any) => r.id === j.id && r.rental_pending), true);

  const ok = await rent.approveRental(tm, g.rentals[0].id);
  assert.equal(ok.rentals[0].status, 'approved');
  assert.equal(ok.driver_name, 'Hired Ali'); assert.equal(ok.vehicle_number, 'SHJ 77001');
  assert.equal(ok.rental_company, 'Quick Hire Transport');
  assert.equal(ok.status_code, 'assigned');
  const cost = await one(`select amount from job_cost_lines where job_id = $1 and expense_type_code = 'rental'`, [j.id]);
  assert.equal(Number(cost.amount), 450);
  const back = await one(`select count(*)::int n from notifications where user_id = $1 and type = 'rental.approved'`, [tr.id]);
  assert.equal(back.n, 1);
});

test('Hired trucks and drivers stay out of the own fleet lists', async () => {
  const lk: any = await lookups(tr);
  assert.equal(lk.vehicles.some((v: any) => /77001/.test(v.name)), false);
  assert.equal(lk.drivers.some((d: any) => d.name === 'Hired Ali'), false);
  const vs = await listMaster(tm, 'vehicles', {});
  assert.equal((vs.rows ?? vs).some((v: any) => /77001/.test(v.vehicle_number)), false);
});

test('Transport Manager hire is approved at once; reject and withdraw work', async () => {
  const j = await newJob();
  const g = await rent.requestRental(tm, j.id, hire({ subcontractor_id: supB, vehicle_number: 'AUH 5550', driver_mobile: '0507771234', rental_cost: '300' }));
  assert.equal(g.rentals[0].status, 'approved'); assert.equal(g.driver_name, 'Hired Ali');
  // a second hire on the same job replaces the first one
  const j2 = await newJob();
  const w = await rent.requestRental(tr, j2.id, hire({ vehicle_number: 'RAK 1' }));
  await rejects(rent.rejectRental(tm, w.rentals[0].id, { reason: '' }), 'VALIDATION');
  const rj = await rent.rejectRental(tm, w.rentals[0].id, { reason: 'Use own truck' });
  assert.equal(rj.rentals[0].status, 'rejected'); assert.equal(rj.rentals[0].reject_reason, 'Use own truck');
  const again = await rent.requestRental(tr, j2.id, hire({ vehicle_number: 'RAK 2' }));
  const wd = await rent.rejectRental(tr, again.rentals[0].id, { cancel: true });
  assert.equal(wd.rentals[0].status, 'cancelled');
  assert.equal((await getJob(tr, j2.id)).driver_id ?? null, null);
});

test('Bill: invoice no., paid / unpaid; cost change updates the job cost line', async () => {
  const r = await one(`select id, job_id from job_rentals where vehicle_number = 'SHJ 77001'`);
  const g = await rent.updateRentalBill(tm, r.id, { supplier_invoice_no: 'QH-889', payment_status: 'paid', paid_on: D(0), rental_cost: '500' });
  const x = g.rentals.find((y: any) => y.id === r.id);
  assert.equal(x.supplier_invoice_no, 'QH-889'); assert.equal(x.payment_status, 'paid');
  const cost = await q(`select amount from job_cost_lines where job_id = $1 and expense_type_code = 'rental'`, [r.job_id]);
  assert.equal(cost.length, 1); assert.equal(Number(cost[0].amount), 500);
});

test('Selling side never leaks; cost only for cost viewers; report', async () => {
  const r = await one(`select job_id from job_rentals where vehicle_number = 'SHJ 77001'`);
  const seen = await getJob(tr, r.job_id);
  assert.equal(JSON.stringify(seen).includes('"900'), false);              // selling price hidden from Transport
  const forOps = await getJob(ops, r.job_id);
  assert.equal('rental_cost' in forOps.rentals[0], !!ops.fin.buyingView || ops.has('rentals.approve'));
  const rep: any = await runReport(tm, 'rentals', { from: D(-5), to: D(10) });
  assert.equal(rep.rows.length, 2);
  const paid: any = await runReport(tm, 'rentals', { from: D(-5), to: D(10), payment_status: 'paid' });
  assert.equal(paid.rows.length, 1); assert.equal(paid.rows[0].supplier_invoice_no, 'QH-889');
  assert.equal(JSON.stringify(rep).includes('900'), false);
});
