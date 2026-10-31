/**
 * Runs the real services against a real Postgres (DATABASE_URL), rebuilding
 * the schema from the migration files first. Uses a distinctive selling price
 * (4321.99) and asserts it never appears anywhere in a Transport user's data.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, deptId, reqFields } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createUser, updateUser, lookups, listNotifications } from '../src/server/admin';
import { createJob, getJob, listJobs, updateFinancials, dashboard } from '../src/server/jobs';

const SELL = '4321.99';
let admin: Actor, ops: Actor, transport: Actor, finance: Actor, customerId: string, jobId: string;
const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const month = { from: tomorrow.slice(0, 8) + '01', to: new Date(Date.UTC(+tomorrow.slice(0, 4), +tomorrow.slice(5, 7), 0)).toISOString().slice(0, 10) };

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code); return true; });
}
function assertNoCommercial(data: unknown, where: string) {
  const json = JSON.stringify(data);
  for (const leak of [SELL, '4321', '"commercial":', 'add_commercial', 'net_revenue', 'gross_revenue', 'customer_total', 'vat_amount',
    'vat_rate', 'discount', 'profit', 'margin', 'revenue_types', 'Selling price'])
    assert.ok(!json.includes(leak), `${where} leaked "${leak}": ${json.slice(0, 400)}`);
}

before(async () => {
  await resetDb();
  const a = await one("select id from users where email = 'admin@company.local'");
  admin = (await loadActor(a.id))!;
  const role = async (c: string) => (await one('select id from roles where code = $1', [c])).id;
  const dept = async (c: string) => (await one('select id from departments where code = $1', [c])).id;
  const mk = (name: string, r: string) => mkUser(admin, name, r);
  ops = await mk('Rahman', 'operations_manager');
  transport = await mk('Ahmed', 'transport');
  finance = await mk('Fatima', 'finance');
  customerId = (await one("insert into customers (name) values ('ABC Trading') returning id")).id;

  const job = await createJob(ops, { ...reqFields(),
    customer_id: customerId, required_date: tomorrow, slot_from: '10:00', slot_to: '12:00', boe_number: 'BOE123456',
    pickup_name: 'Jebel Ali', delivery_name: 'Dubai Investment Park', email_subject: 'RE: urgent 3T',
    base_selling_price: SELL, discount: '0',
  });
  jobId = job.id;
  await updateFinancials(transport, jobId, { cost: { lines: [
    { type: 'base', amount: '250' }, { type: 'fuel', amount: '20' }, { type: 'toll', amount: '10' }, { type: 'other', amount: '5' }] } });
});

test('Transport job detail: cost visible, selling/revenue/profit absent', async () => {
  const j = await getJob(transport, jobId);
  assert.equal(j.financials.cost.total_cost, '285.00');
  assert.equal(j.job_number, 'TR-1001');
  assertNoCommercial(j, 'getJob(transport)');
});

test('Transport job list and search: no commercial data', async () => {
  const l = await listJobs(transport, { q: 'boe123' });
  assert.equal(l.total, 1);
  assertNoCommercial(l, 'listJobs(transport)');
  assert.equal((await listJobs(transport, { q: 'ABC trad' })).total, 1, 'partial customer match');
});

test('Transport cannot infer revenue through filters or sorting', async () => {
  await rejects(listJobs(transport, { revenue_min: '4000' }), 'FORBIDDEN_FILTER');
  await rejects(listJobs(transport, { profit_max: '1' }), 'FORBIDDEN_FILTER');
  await rejects(listJobs(transport, { sort: 'net_revenue' }), 'FORBIDDEN_FILTER');
  await rejects(listJobs(transport, { sort: 'profit' }), 'FORBIDDEN_FILTER');
});

test('Transport cannot write selling price or create jobs', async () => {
  await rejects(updateFinancials(transport, jobId, { selling: { lines: [{ type: 'base', amount: '1' }] } }), 'FORBIDDEN');
  await rejects(createJob(transport, { ...reqFields(), customer_id: customerId, required_date: tomorrow, pickup_name: 'a', delivery_name: 'b' }), 'FORBIDDEN');
});

test('Transport dashboard, lookups and notifications carry no commercial data', async () => {
  assertNoCommercial(await dashboard(transport, month.from, month.to), 'dashboard(transport)');
  assertNoCommercial(await lookups(transport), 'lookups(transport)');
  const n = await listNotifications(transport);
  assert.match(n.rows[0].title, /^New transport request — Job No\. /);
  assertNoCommercial(n, 'notifications(transport)');
});

test('Misconfiguration safety: even the Super Admin cannot give a Transport user selling price or profit', async () => {
  await updateUser(admin, transport.id, { overrides: [
    { code: 'finance.profit.view', granted: true }, { code: 'finance.selling.view', granted: true }, { code: 'documents.view_commercial', granted: true }] });
  const t2 = (await loadActor(transport.id))!;
  assert.equal(t2.has('finance.profit.view'), false, 'refused by the database rule');
  assert.equal(t2.has('finance.selling.view'), false);
  assert.equal(t2.has('documents.view_commercial'), false);
  assertNoCommercial(await getJob(t2, jobId), 'getJob(transport+profit.view)');
  await updateUser(admin, transport.id, { overrides: [] });
});

test('Operations sees full commercial picture with VAT kept out of profit', async () => {
  const j = await getJob(ops, jobId);
  assert.deepEqual(
    [j.financials.commercial.net_revenue, j.financials.commercial.vat_amount, j.financials.commercial.customer_total],
    ['4321.99', '216.10', '4538.09']);
  assert.deepEqual(j.financials.profit, { gross_profit: '4036.99', margin_pct: '93.41' });
  assert.ok(j.activity.some((a: any) => a.action === 'Selling price changed'));
  assert.ok(j.activity.some((a: any) => a.action === 'Total transport cost changed' && a.new_value === '285.00'));
});

test('Operations without buying view gets no profit (it would reveal cost)', async () => {
  await updateUser(admin, ops.id, { overrides: [{ code: 'finance.buying.view', granted: false }] });
  const o2 = (await loadActor(ops.id))!;
  const j = await getJob(o2, jobId);
  assert.equal(j.financials.cost, undefined);
  assert.equal(j.financials.profit, undefined);
  assert.equal(j.financials.commercial.net_revenue, '4321.99');
  await updateUser(admin, ops.id, { overrides: [] });
});

test('Finance: read everything, change nothing', async () => {
  const j = await getJob(finance, jobId);
  assert.equal(j.financials.profit.gross_profit, '4036.99');
  await rejects(updateFinancials(finance, jobId, { cost: { lines: [] } }), 'FORBIDDEN');
  await rejects(updateFinancials(finance, jobId, { selling: { lines: [] } }), 'FORBIDDEN');
});

test('Spec example end-to-end: 400 selling, 285 cost -> 115 profit, 28.75%', async () => {
  await updateFinancials(ops, jobId, { selling: { lines: [{ type: 'base', amount: '400' }], discount: '0' } });
  const j = await getJob(ops, jobId);
  assert.equal(j.financials.commercial.customer_total, '420.00');
  assert.deepEqual(j.financials.profit, { gross_profit: '115.00', margin_pct: '28.75' });
  const d: any = await dashboard(ops, month.from, month.to);
  assert.equal(d.financials.profit.gross_profit, '115.00');
});

test('Validation: past date, duplicate BOE warning, discount > price', async () => {
  const base = { customer_id: customerId, pickup_name: 'A', delivery_name: 'B' };
  await rejects(createJob(ops, { ...reqFields(), ...base, required_date: '2020-01-01' }), 'VALIDATION');
  await rejects(createJob(ops, { ...reqFields(), ...base, required_date: tomorrow, boe_number: ' boe123456 ' }), 'BOE_DUPLICATE');
  const ok = await createJob(ops, { ...reqFields(), ...base, required_date: tomorrow, boe_number: 'BOE123456', confirm_duplicate_boe: true });
  assert.equal(ok.job_number, 'TR-1002');
  await rejects(updateFinancials(ops, ok.id, { selling: { lines: [{ type: 'base', amount: '10' }], discount: '11' } }), 'VALIDATION');
});

test('Closed jobs are locked for normal users', async () => {
  await q("update transport_requests set status_code = 'completed' where id = $1", [jobId]);
  await rejects(updateFinancials(transport, jobId, { cost: { lines: [] } }), 'JOB_LOCKED');
  await updateFinancials(admin, jobId, { cost: { lines: [{ type: 'base', amount: '285' }] } }); // admin may
});

test('Sessions die when role/permissions change; audit log is append-only', async () => {
  const v = (await one('select token_version from users where id = $1', [transport.id])).token_version;
  await updateUser(admin, transport.id, { is_active: false });
  assert.equal(await loadActor(transport.id, v), null);
  await updateUser(admin, transport.id, { is_active: true });
  await assert.rejects(q('update audit_log set new_value = $1', ['x']), /append-only/);
  await rejects(updateUser(admin, admin.id, { is_active: false }), 'SELF_DISABLE');
});

test('Operations see their own department only', async () => {
  assert.equal((await listJobs(ops, {})).total, 2);
  const other = await createJob(admin, { ...reqFields(), department_id: await deptId('sea_import'), customer_id: customerId, required_date: tomorrow, pickup_name: 'X', delivery_name: 'Y' });
  assert.equal((await listJobs(ops, {})).total, 2, 'Sea-Import job is not visible to Operations (general)');
  await rejects(getJob(ops, other.id), 'NOT_FOUND');
  assert.equal((await listJobs(transport, {})).total, 3, 'Transport sees every department');
});
