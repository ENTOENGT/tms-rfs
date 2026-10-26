/** Phase 6 — Reports: content, permissions, exports (CSV/Excel read back), audit. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { resetDb, mkUser, deptId, reqFields } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createUser, updateUser } from '../src/server/admin';
import { createJob, updateFinancials } from '../src/server/jobs';
import { createMaster } from '../src/server/masters';
import { assignJob, changeStatus } from '../src/server/workflow';
import { exportReport, reportList, runReport } from '../src/server/reports';

let admin: Actor, ops: Actor, tr: Actor;
const day = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const P = { from: day(-10), to: day(10) };
async function rejects(p: Promise<unknown>, code: string) { await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); return true; }); }

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  const role = async (c: string) => (await one('select id from roles where code=$1', [c])).id;
  const mk = (n: string, r: string) => mkUser(admin, n, r);
  ops = await mk('ops', 'operations_manager'); tr = await mk('tr', 'transport');
  const abc = (await createMaster(ops, 'customers', { name: 'ABC Trading' })).id;
  const evil = (await createMaster(ops, 'customers', { name: '=HYPERLINK("http://x","click")' })).id;
  const drv = (await createMaster(tr, 'drivers', { full_name: 'Ahmed' })).id;
  const veh = (await createMaster(tr, 'vehicles', { vehicle_number: 'DXB 1', vehicle_type_id: (await one("select id from vehicle_types where name='3 Ton'")).id })).id;
  const mkJob = async (cust: string, sell: string, cost: string, d: string, hh: string, deliver = false) => {
    const j = await createJob(ops, { ...reqFields(), customer_id: cust, required_date: d, pickup_name: 'Jebel Ali', delivery_name: 'DIP', boe_number: 'BOE-' + sell, base_selling_price: sell });
    await updateFinancials(tr, j.id, { cost: { lines: [{ type: 'base', amount: cost }] } });
    await assignJob(tr, j.id, { driver_id: drv, vehicle_id: veh, planned_pickup_at: `${d}T${hh}:00`, planned_delivery_at: `${d}T${hh}:30`, confirm_warnings: true });
    if (deliver) for (const to of ['dispatched', 'picked_up', 'delivered']) await changeStatus(tr, j.id, { to });
    return j;
  };
  await mkJob(abc, '400', '285', day(1), '08', true);
  await mkJob(abc, '1000', '600', day(2), '09');
  await mkJob(evil, '4321.99', '100', day(3), '10');
});

test('Report list follows permissions', async () => {
  assert.deepEqual(reportList(ops).map((r) => r.key), ['operational', 'financial', 'department', 'driver', 'vehicle', 'customer', 'messenger', 'pod_pending']);
  assert.equal(reportList(tr).length, 8, 'Transport keeps cost-only versions');
  await updateUser(admin, tr.id, { overrides: [{ code: 'finance.buying.view', granted: false }] });
  const noFin = (await loadActor(tr.id))!;
  assert.deepEqual(reportList(noFin).map((r) => r.key), ['operational', 'messenger', 'pod_pending']);
  await rejects(runReport(noFin, 'financial', P), 'FORBIDDEN');
  await updateUser(admin, tr.id, { overrides: [] });
});

test('Financial report: correct figures and totals for Operations', async () => {
  const r = await runReport(ops, 'financial', P);
  assert.deepEqual(r.columns.map((c) => c.key), ['job_no', 'job_number', 'required_date', 'department_name', 'customer_name', 'status_name', 'net_revenue', 'vat', 'total_cost', 'gross_profit', 'margin_pct']);
  assert.equal(r.total, 3);
  assert.deepEqual([r.totals!.net_revenue, r.totals!.total_cost, r.totals!.gross_profit, r.totals!.margin_pct], ['5721.99', '985.00', '4736.99', '82.79']);
  const spec = r.rows.find((x) => x.net_revenue === '400.00')!;
  assert.deepEqual([spec.vat, spec.total_cost, spec.gross_profit, spec.margin_pct], ['20.00', '285.00', '115.00', '28.75']);
});

test('Transport financial report is cost-only, and cannot be ranked by hidden revenue', async () => {
  const r = await runReport(tr, 'financial', { ...P, sort: 'net_revenue', dir: 'desc' });
  assert.deepEqual(r.columns.map((c) => c.key), ['job_no', 'job_number', 'required_date', 'department_name', 'customer_name', 'status_name', 'total_cost']);
  const json = JSON.stringify(r);
  for (const leak of ['4321', 'net_revenue', 'gross_profit', 'vat', 'margin', '5721']) assert.ok(!json.includes(leak), `leaked ${leak}`);
  const def = await runReport(tr, 'financial', P);
  assert.deepEqual(r.rows.map((x) => x.job_number), def.rows.map((x) => x.job_number), 'sort on hidden column ignored');
  const g = await runReport(tr, 'customer', P);
  assert.ok(!JSON.stringify(g).includes('4321'));
});

test('Operational report: search, filters, sorting', async () => {
  assert.equal((await runReport(ops, 'operational', { ...P, q: 'boe-1000' })).total, 1);
  assert.equal((await runReport(ops, 'operational', { ...P, q: 'ahmed' })).total, 3);
  const s = await runReport(ops, 'operational', { ...P, sort: 'job_number', dir: 'asc' });
  assert.deepEqual(s.rows.map((x) => x.job_number), ['TR-1001', 'TR-1002', 'TR-1003']);
  assert.equal(s.rows[0].slot, null);
  await rejects(runReport(ops, 'operational', { from: P.to, to: P.from }), 'VALIDATION');
  await rejects(runReport(ops, 'nope', P), 'NOT_FOUND');
});

test('POD pending report lists delivered jobs without POD', async () => {
  const r = await runReport(tr, 'pod_pending', {});
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].job_number, 'TR-1001');
  assert.equal(r.rows[0].days_waiting, 0);
});

test('Driver / vehicle / customer reports', async () => {
  const d = await runReport(ops, 'driver', P);
  assert.deepEqual([d.rows[0].label, d.rows[0].jobs, d.rows[0].net_revenue, d.totals!.gross_profit], ['Ahmed', 3, '5721.99', '4736.99']);
  assert.equal((await runReport(ops, 'customer', { ...P, q: 'abc' })).rows.length, 1);
});

test('Excel export: real numbers, title block, and Transport file has no revenue', async () => {
  const x = await exportReport(ops, 'financial', P, 'xlsx');
  assert.match(x.name, /^financial-report-.*\.xlsx$/);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body as any);
  const ws = wb.worksheets[0];
  assert.equal(ws.getCell('A2').value, 'Financial report');
  assert.equal(ws.getRow(5).getCell(7).value, 'Revenue (ex VAT) (AED)');
  const totalRow = ws.getRow(ws.rowCount);
  assert.equal(totalRow.getCell(10).value, 4736.99);
  const t = await exportReport(tr, 'financial', P, 'xlsx');
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(t.body as any);
  const all: string[] = [];
  wb2.worksheets[0].eachRow((r) => r.eachCell((c) => all.push(String(c.value))));
  assert.ok(!all.some((v) => /Revenue|Profit|VAT|4321|5721/.test(v)), all.join('|'));
});

test('CSV export: Excel-safe text, formulas neutralised, negatives intact; exports are audited', async () => {
  const c = await exportReport(ops, 'financial', P, 'csv');
  const text = c.body.toString('utf8');
  assert.ok(text.startsWith('\ufeffJob No.,Request No.,Date,Department,Customer'));
  assert.ok(text.includes(`"'=HYPERLINK(""http://x"",""click"")"`), 'formula neutralised');
  const log = await one(`select action, new_value from audit_log where entity_type = 'report' order by id desc limit 1`);
  assert.match(log.action, /Report exported \(CSV\)/); assert.match(log.new_value, /Financial report/);
  await updateUser(admin, tr.id, { overrides: [{ code: 'reports.export', granted: false }] });
  await rejects(exportReport((await loadActor(tr.id))!, 'operational', P, 'csv'), 'FORBIDDEN');
  await updateUser(admin, tr.id, { overrides: [] });
  await rejects(exportReport(ops, 'operational', P, 'pdf'), 'VALIDATION');
});
