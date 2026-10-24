/** Phase 5 — financial dashboard numbers and confidentiality, against real Postgres. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, deptId } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createUser, updateUser } from '../src/server/admin';
import { createJob, updateFinancials } from '../src/server/jobs';
import { createMaster } from '../src/server/masters';
import { assignJob, changeStatus } from '../src/server/workflow';
import { financials } from '../src/server/financials';

let admin: Actor, ops: Actor, tr: Actor, fin: Actor;
let abc: string, gulf: string, ahmed: string, truck: string;
const day = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const P = { from: day(-40), to: day(40) };
async function rejects(p: Promise<unknown>, code: string) { await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); return true; }); }

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  const role = async (c: string) => (await one('select id from roles where code=$1', [c])).id;
  const mk = (n: string, r: string) => mkUser(admin, n, r);
  ops = await mk('ops', 'operations_manager'); tr = await mk('tr', 'transport'); fin = await mk('fin', 'finance');
  abc = (await createMaster(ops, 'customers', { name: 'ABC' })).id; gulf = (await createMaster(ops, 'customers', { name: 'Gulf' })).id;
  ahmed = (await createMaster(tr, 'drivers', { full_name: 'Ahmed' })).id;
  truck = (await createMaster(tr, 'vehicles', { vehicle_number: 'DXB 1', vehicle_type_id: (await one("select id from vehicle_types where name='3 Ton'")).id })).id;
  const job = async (cust: string, sell: string, cost: [string, string][], d = day(1), assign = false) => {
    const j = await createJob(ops, { customer_id: cust, required_date: d, pickup_name: 'A', delivery_name: 'B', base_selling_price: sell });
    await updateFinancials(tr, j.id, { cost: { lines: cost.map(([type, amount]) => ({ type, amount })) } });
    if (assign) await assignJob(tr, j.id, { driver_id: ahmed, vehicle_id: truck, planned_pickup_at: `${d}T0${3 + Math.floor(Math.random() * 6)}:00`, override_conflicts: false, confirm_warnings: true }).catch(async () =>
      assignJob(admin, j.id, { driver_id: ahmed, vehicle_id: truck, planned_pickup_at: `${d}T20:00`, override_conflicts: true }));
    return j;
  };
  await job(abc, '400', [['base', '250'], ['fuel', '20'], ['toll', '10'], ['other', '5']], day(1), true);   // spec example: profit 115
  await job(abc, '1000', [['base', '600']], day(2), true);
  await job(gulf, '333.33', [['base', '100'], ['waiting', '33.33']], day(3));
  const cancelled = await job(gulf, '9999', [['base', '1']]);
  await changeStatus(ops, cancelled.id, { to: 'cancelled', reason: 'test' });
  await createJob(ops, { customer_id: gulf, required_date: day(4), pickup_name: 'A', delivery_name: 'B', base_selling_price: '5555', save_as_draft: true });
});

test('Totals: cancelled and drafts excluded; VAT separate from profit', async () => {
  const r: any = await financials(ops, P);
  const t = r.totals;
  assert.equal(t.jobs, 3);
  assert.equal(t.net_revenue, '1733.33');
  assert.equal(t.vat, '86.67');                       // 20.00 + 50.00 + 16.67
  assert.equal(t.revenue_incl_vat, '1820.00');
  assert.equal(t.total_cost, '1018.33');
  assert.equal(t.base_cost, '950.00');
  assert.equal(t.other_expenses, '68.33');
  assert.equal(t.gross_profit, '715.00');
  assert.equal(t.margin_pct, '41.25');
  assert.equal(t.avg_revenue, '577.78');
});

test('Breakdowns: by customer, driver (with Unassigned), month, status', async () => {
  const r: any = await financials(fin, P);
  assert.deepEqual(r.by_customer.map((c: any) => [c.label, c.jobs, c.net_revenue, c.gross_profit]), [['ABC', 2, '1400.00', '515.00'], ['Gulf', 1, '333.33', '200.00']]);
  assert.deepEqual(r.by_driver.map((d: any) => [d.label, d.jobs]), [['Ahmed', 2], ['Unassigned', 1]]);
  assert.ok(r.by_month.length >= 2 && r.by_month.reduce((s: number, m: any) => s + m.jobs, 0) === 3);
  assert.deepEqual(r.by_status.map((s: any) => s.label), ['Pending Assignment', 'Assigned']);
});

test('Filters combine: customer + driver', async () => {
  const r: any = await financials(ops, { ...P, customer_id: abc, driver_id: ahmed });
  assert.equal(r.totals.jobs, 2);
  assert.equal((await financials(ops, { ...P, customer_id: gulf, driver_id: ahmed }) as any).totals.jobs, 0);
  await rejects(financials(ops, { ...P, customer_id: 'x' }), 'VALIDATION');
  await rejects(financials(ops, { from: P.to, to: P.from }), 'VALIDATION');
});

test('Transport gets a cost-only dashboard — no revenue, VAT or profit anywhere', async () => {
  const r: any = await financials(tr, P);
  assert.deepEqual(r.access, { cost: true, revenue: false, profit: false });
  assert.equal(r.totals.total_cost, '1018.33');
  const json = JSON.stringify(r);
  for (const leak of ['net_revenue', 'vat', 'gross_profit', 'margin', 'avg_revenue', '1733.33', '1400.00', '715.00'])
    assert.ok(!json.includes(leak), `leaked ${leak}`);
  assert.deepEqual(r.by_customer.map((c: any) => c.label), ['ABC', 'Gulf'], 'ranked by cost, not revenue');
});

test('Operations without buying view sees revenue but no cost or profit', async () => {
  await updateUser(admin, ops.id, { overrides: [{ code: 'finance.buying.view', granted: false }] });
  const o = (await loadActor(ops.id))!;
  const r: any = await financials(o, P);
  assert.equal(r.totals.net_revenue, '1733.33');
  assert.equal(r.totals.total_cost, undefined); assert.equal(r.totals.gross_profit, undefined);
  await updateUser(admin, ops.id, { overrides: [] });
});

test('No financial permission at all: refused', async () => {
  await updateUser(admin, tr.id, { overrides: [{ code: 'finance.buying.view', granted: false }] });
  await rejects(financials((await loadActor(tr.id))!, P), 'FORBIDDEN');
  await updateUser(admin, tr.id, { overrides: [] });
});
