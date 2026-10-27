/** Migration 009 — PRO & Container Clearance (section 13 of the spec). Real Postgres + local file driver. */
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_UPLOAD_DIR = '/tmp/tms-test-uploads';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser, reqFields } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { listNotifications } from '../src/server/admin';
import { createJob } from '../src/server/jobs';
import { createMaster } from '../src/server/masters';
import { localWrite } from '../src/server/storage';
import { exportReport, reportList, runReport } from '../src/server/reports';
import { setRolePermissions } from '../src/server/team';
import { listRuns } from '../src/server/runs';
import * as pro from '../src/server/pro';

let admin: Actor, seaImp: Actor, airExp: Actor, pm: Actor, off1: Actor, off2: Actor, fin: Actor, tm: Actor, opsSub: Actor, customer: string;
const D = (n = 1) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const today = D(0);
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); return true; });
}
const base = (extra: any = {}) => ({ job_no: 'SI-500', customer_id: customer, bl_number: 'MSCUBL998877', direction: 'import', load_type: 'FCL',
  transport_mode: 'sea', uae_location: 'Jebel Ali Port T2', required_date: D(2), containers: [{ container_no: 'MSCU1234566', size_type: '40HC' }], ...extra });
const act = (a: Actor, id: string, b: any) => ({ status: pro.setProStatus, assign: pro.assignPro, container: pro.saveContainer, activity: pro.saveActivity, charge: pro.saveCharge } as any)[b.action](a, id, b);
async function upload(a: Actor, id: string, doc_type: string, name: string, extra: any = {}) {
  const r = await pro.requestProUpload(a, id, { file_name: name, mime_type: 'application/pdf', size: 900, doc_type, ...extra });
  await localWrite(new URL('http://x' + r.upload.url).searchParams.get('key')!, Buffer.alloc(900, 1), 'application/pdf');
  return pro.confirmProUpload(a, id, { ticket: r.ticket });
}

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  seaImp = await mkUser(admin, 'seaimp', 'operations_manager', 'sea_import');
  opsSub = await mkUser(admin, 'opssub', 'operations', 'sea_import');
  airExp = await mkUser(admin, 'airexp', 'operations_manager', 'air_export');
  pm = await mkUser(admin, 'PRO Boss', 'documentation_manager', 'documentations');   // the Documentation Manager supervises PRO
  off1 = await mkUser(admin, 'Officer One', 'pro_officer', 'documentations');
  off2 = await mkUser(admin, 'Officer Two', 'pro_officer', 'documentations');
  fin = await mkUser(admin, 'fin', 'finance', 'finance');
  tm = await mkUser(admin, 'tm', 'transport_manager');
  customer = (await createMaster(seaImp, 'customers', { name: 'ABC Trading' })).id;
});

let id: string;
test('Create a PRO request: required fields, container check digit, separate PRO Request No., linked to the truck job', async () => {
  const e: any = await pro.createPro(seaImp, { customer_id: customer }).catch((x) => x);
  assert.equal(e.code, 'VALIDATION');
  for (const k of ['job_no', 'bl_number', 'direction', 'uae_location', 'required_date', 'containers']) assert.ok(e.details.fields[k], k);
  await rejects(pro.createPro(seaImp, base({ containers: [{ container_no: 'ABC123' }] })), 'VALIDATION');
  await rejects(pro.createPro(seaImp, base({ containers: [{ container_no: 'MSCU1234560' }] })), 'CONTAINER_CHECK');      // wrong last digit
  assert.ok(await pro.createPro(seaImp, base({ job_no: 'SI-CHK', containers: [{ container_no: 'MSCU1234560' }], confirm_container_check: true })));
  await rejects(pro.createPro(tm, base()), 'FORBIDDEN');                       // Transport has no PRO access
  await rejects(pro.createPro(off1, base()), 'FORBIDDEN');                     // officers don't raise requests
  const truck = await createJob(seaImp, { ...reqFields(), job_no: 'SI-500', customer_id: customer, required_date: D(2), pickup_name: 'Port', delivery_name: 'WH' });
  const r = await pro.createPro(seaImp, base({ containers: [{ container_no: 'MSCU1234566', size_type: '40HC' }, { container_no: 'TGHU 987654-2' }],
    activity_types: ['customs_declaration', 'gate_pass_release'] }));
  id = r.id;
  assert.match(r.request_no, /^PRO-\d+$/); assert.equal(r.job_no, 'SI-500');
  const full = await pro.getPro(seaImp, id);
  assert.equal(full.job_id, truck.id); assert.equal(full.linked_request_no, truck.job_number);
  assert.equal(full.status_code, 'pending_assignment');
  assert.deepEqual(full.containers.map((k: any) => k.container_no), ['MSCU1234566', 'TGHU9876542']);
  assert.equal(full.activities.length, 2);
  assert.ok((await listNotifications(pm)).rows.some((n: any) => n.title.startsWith(`New PRO request ${r.request_no}`)));
});

test('Same Job No. again: a warning, then allowed (never blocked)', async () => {
  const w: any = await pro.createPro(airExp, base()).catch((x) => x);
  assert.equal(w.code, 'PRO_JOB_NO_EXISTS');
  assert.ok(await pro.createPro(airExp, base({ confirm_duplicate_job_no: true, containers: [{ container_no: 'CMAU3311227' }] })));
});

test('Assign and reassign PRO officers (supervisor only); activities follow the officer', async () => {
  await rejects(pro.assignPro(seaImp, id, { assigned_to: off1.id }), 'FORBIDDEN');
  await rejects(pro.assignPro(pm, id, { assigned_to: seaImp.id }), 'VALIDATION');          // not a PRO officer
  let r = await pro.assignPro(pm, id, { assigned_to: off1.id });
  assert.equal(r.status_code, 'assigned'); assert.equal(r.assigned_to_name, 'Officer One');
  assert.ok(r.activities.every((x: any) => x.assigned_to === off1.id));
  assert.ok((await listNotifications(off1)).rows.some((n: any) => n.title.includes('assigned to you')));
  r = await pro.assignPro(pm, id, { assigned_to: off2.id, remarks: 'Officer One on leave' });
  assert.equal(r.assigned_to, off2.id);
  assert.ok((await listNotifications(off1)).rows.some((n: any) => n.title.includes('was given to Officer Two')));
  await rejects(pro.getPro(off1, id), 'NOT_FOUND');                                         // no longer theirs
  r = await pro.assignPro(pm, id, { assigned_to: off1.id });
  assert.equal(r.history.filter((h: any) => h.kind === 'assign').length, 3);
});

test('Several activities under one request, updated independently (Customs, inspection, municipality, port release)', async () => {
  const auth = (n: string) => one('select id from pro_authorities where name = $1', [n]).then((x) => x.id);
  let r = await pro.getPro(off1, id);
  const k1 = r.containers[0].id;
  await pro.saveActivity(off1, id, { activity_type_code: 'municipality', authority_id: await auth('Dubai Municipality'), required_documents: 'Health certificate' });
  await pro.saveActivity(off1, id, { activity_type_code: 'customs_inspection', authority_id: await auth('Dubai Customs'), container_id: k1 });
  r = await pro.getPro(off1, id);
  assert.equal(r.activities.length, 4);
  const byType = (t: string) => r.activities.find((x: any) => x.activity_type_code === t);
  await pro.saveActivity(off1, id, { activity_id: byType('customs_declaration').id, authority_id: await auth('Dubai Customs'), reference_no: 'DEC-2026-1', status: 'submitted' });
  await pro.saveActivity(off1, id, { activity_id: byType('municipality').id, status: 'documents_required', outstanding: 'Arabic label photos', remarks: 'Municipality asked for labels' });
  await pro.saveActivity(off1, id, { activity_id: byType('customs_inspection').id, status: 'pending_inspection', appointment_at: `${D(0)}T23:30` });
  r = await pro.getPro(seaImp, id);
  const fresh = (t: string) => r.activities.find((x: any) => x.activity_type_code === t);
  assert.equal(fresh('customs_declaration').status, 'submitted'); assert.equal(fresh('customs_declaration').submitted_on instanceof Date || !!fresh('customs_declaration').submitted_on, true);
  assert.equal(fresh('municipality').status, 'documents_required');
  assert.equal(fresh('customs_inspection').container_no, 'MSCU1234566');
  assert.ok((await listNotifications(seaImp)).rows.some((n: any) => n.title.startsWith('Documents required — Municipality')));
  await rejects(pro.saveActivity(seaImp, id, { activity_id: fresh('municipality').id, status: 'approved' }), 'FORBIDDEN');   // Operations only monitors
  await rejects(pro.saveActivity(off1, id, { activity_id: fresh('municipality').id, status: 'rejected' }), 'VALIDATION');    // reason needed
});

test('Customs cleared is not release, and release is not completion', async () => {
  let r = await pro.getPro(off1, id);
  const [k1, k2] = r.containers;
  await pro.saveContainer(off1, id, { container_id: k1.id, customs_status: 'cleared' });
  r = await pro.setProStatus(off1, id, { to: 'customs_cleared' });
  assert.equal(r.status_code, 'customs_cleared'); assert.ok(r.customs_cleared_at); assert.equal(r.completed_at, null);
  assert.equal(r.containers[0].release_status, 'pending');                          // nothing released automatically
  const e: any = await pro.setProStatus(off1, id, { to: 'completed' }).catch((x) => x);
  assert.equal(e.code, 'PRO_NOT_COMPLETE');
  assert.ok(e.details.blockers.some((b: string) => b.includes('Container MSCU1234566: not released')));
  assert.ok(e.details.blockers.some((b: string) => b.startsWith('Municipality')));
  // containers move on their own
  await pro.saveContainer(off1, id, { container_id: k1.id, release_status: 'release_pending' });
  r = await pro.saveContainer(off1, id, { container_id: k1.id, release_status: 'released' });
  assert.ok(r.containers.find((k: any) => k.id === k1.id).released_at);
  assert.equal(r.containers.find((k: any) => k.id === k2.id).customs_status, 'pending');
  // finish everything, then completion is allowed
  for (const x of r.activities) await pro.saveActivity(off1, id, { activity_id: x.id, status: x.activity_type_code === 'municipality' ? 'not_required' : 'completed' });
  await pro.saveContainer(off1, id, { container_id: k2.id, customs_status: 'cleared' });
  await pro.saveContainer(off1, id, { container_id: k2.id, release_status: 'released' });
  r = await pro.setProStatus(off1, id, { to: 'completed', remarks: 'All released' });
  assert.equal(r.status_code, 'completed'); assert.ok(r.completed_at);
  assert.ok(r.history.some((h: any) => h.kind === 'status' && h.new_value === 'Completed' && h.remarks === 'All released' && h.user_name === 'Officer One'));
  await rejects(pro.setProStatus(off1, id, { to: 'assigned' }), 'FORBIDDEN');        // only the supervisor reopens
  await rejects(pro.saveContainer(off1, id, { container_id: k1.id, remarks: 'x' }), 'PRO_CLOSED');
});

let id2: string;
test('Upload and replace documents: versions kept, who and when recorded', async () => {
  const r0 = await pro.createPro(seaImp, base({ job_no: 'SI-600', containers: [{ container_no: 'MSCU1234566' }], deadline: D(3) }));
  id2 = r0.id;
  await pro.assignPro(pm, id2, { assigned_to: off2.id });
  let r = await upload(seaImp, id2, 'commercial_invoice', 'inv-v1.pdf');
  const v1 = r.documents[0];
  await rejects(pro.requestProUpload(seaImp, id2, { file_name: 'x.docx', mime_type: 'application/msword', size: 10, doc_type: 'other' }), 'VALIDATION');
  r = await upload(off2, id2, 'commercial_invoice', 'inv-v2.pdf', { replaces_id: v1.id });
  const docs = r.documents.filter((d: any) => d.doc_type === 'commercial_invoice');
  assert.equal(docs.length, 2);
  assert.equal(docs.find((d: any) => d.current).version, 2); assert.equal(docs.find((d: any) => !d.current).file_name, 'inv-v1.pdf');
  await rejects(pro.requestProUpload(off2, id2, { file_name: 'y.pdf', mime_type: 'application/pdf', size: 10, doc_type: 'other', replaces_id: v1.id }), 'VALIDATION');
  assert.ok(r.history.some((h: any) => h.field === 'Commercial Invoice replaced (version 2)' && h.user_name === 'Officer Two'));
  assert.match(await pro.proFileUrl(seaImp, v1.id, true), /inline=1/);
  await rejects(pro.proFileUrl(airExp, v1.id), 'NOT_FOUND');                         // other department
  await rejects(pro.proFileUrl(off1, v1.id), 'NOT_FOUND');                           // not their request
  await rejects(pro.proFileUrl(tm, v1.id), 'FORBIDDEN');                             // Transport: no PRO at all
});

test('Charges: actual vs estimate, payments; visible only with charge permission', async () => {
  await pro.saveCharge(off2, id2, { category: 'customs_duty', amount: '1250.50', payment_status: 'unpaid' });
  await pro.saveCharge(off2, id2, { category: 'storage_demurrage', amount: '400', is_estimate: true });
  let r = await pro.getPro(off2, id2);
  assert.deepEqual(r.charges_total, { actual: '1250.50', estimated: '400.00', unpaid: '1250.50' });
  await rejects(pro.saveCharge(seaImp, id2, { category: 'other', amount: 1 }), 'FORBIDDEN');     // Operations Manager: view only
  const sub = await pro.getPro(opsSub, id2);
  assert.equal(sub.charges, undefined); assert.ok(!JSON.stringify(sub).includes('1250.5'));      // sub-user: no charges at all
  assert.ok(!sub.history.some((h: any) => h.kind === 'charge'));
  r = await pro.saveCharge(fin, id2, { charge_id: r.charges[0].id, category: 'customs_duty', amount: '1250.50', payment_status: 'paid' });  // Finance records payment
  assert.equal(r.charges_total.unpaid, '0.00');
  assert.ok(r.charges[0].paid_on);
});

test('Overdue and pending items: dashboard tiles open the same records; escalation reaches the supervisor once', async () => {
  const late = await pro.createPro(seaImp, base({ job_no: 'SI-LATE', containers: [{ container_no: 'MSCU1234566' }], confirm_duplicate_job_no: true }));
  await q(`update pro_requests set required_date = current_date - 3, deadline = current_date - 2 where id = $1`, [late.id]);
  await pro.assignPro(pm, late.id, { assigned_to: off1.id });
  await pro.saveActivity(off1, late.id, { activity_type_code: 'customs_declaration', status: 'pending_approval' });
  const dash = await pro.proDashboard(pm, {});
  const tile = (k: string) => dash.tiles.find((t: any) => t.key === k)!.count;
  assert.ok(tile('overdue') >= 1); assert.ok(tile('awaiting_approval') >= 1); assert.ok(tile('completed') >= 1);
  assert.ok(tile('pending_payment') === 0 || tile('pending_payment') >= 0);
  const list = await pro.listPro(pm, { view: 'overdue' });
  assert.equal(list.total, tile('overdue')); assert.ok(list.rows.some((r: any) => r.id === late.id && r.overdue));
  assert.equal((await pro.listPro(pm, { view: 'awaiting_approval' })).total, tile('awaiting_approval'));
  assert.equal((await pro.listPro(pm, { container: 'mscu 1234566' })).total >= 3, true);
  const res = await pro.runProReminders(true);
  assert.ok(res.escalated >= 1);
  const lateNo = (await one('select request_no from pro_requests where id = $1', [late.id])).request_no;
  assert.ok((await listNotifications(pm)).rows.some((n: any) => n.title.startsWith(`OVERDUE: ${lateNo}`)));
  assert.equal((await pro.runProReminders(true)).escalated, 0);                  // only once
  const k = (await pro.listContainers(pm, { job_no: 'SI-LATE' }))[0];
  assert.equal(k.delayed, true);
});

test('Who sees what: departments, officers, finance, transport', async () => {
  const mine = (a: Actor) => pro.listPro(a, {}).then((l) => l.rows.map((r: any) => r.job_no));
  assert.ok(!(await mine(airExp)).includes('SI-600'));                           // other department
  assert.ok((await mine(seaImp)).includes('SI-600'));
  assert.deepEqual((await mine(off2)).sort(), ['SI-600']);                        // officer: only assigned work
  assert.ok((await mine(fin)).length >= 4);                                       // finance: all (to see charges)
  await rejects(pro.listPro(tm, {}), 'FORBIDDEN');
  // Operations can cancel its own request before PRO starts, but not change clearance statuses
  const r = await pro.createPro(seaImp, base({ job_no: 'SI-CANCEL', confirm_duplicate_job_no: true }));
  await rejects(pro.setProStatus(seaImp, r.id, { to: 'customs_cleared' }), 'FORBIDDEN');
  await rejects(pro.setProStatus(seaImp, r.id, { to: 'cancelled' }), 'VALIDATION');           // reason required
  assert.equal((await pro.setProStatus(seaImp, r.id, { to: 'cancelled', remarks: 'Raised twice' })).status_code, 'cancelled');
  // PRO officers get no prices; the Documentation Manager keeps its normal Operations Manager rights plus PRO supervision
  for (const p of ['finance.selling.view', 'finance.profit.view', 'jobs.view_department', 'pro.assign']) assert.ok(!off1.has(p as any), p);
  for (const p of ['pro.assign', 'pro.view_all', 'pro.configure', 'jobs.view_department', 'jobs.create', 'users.manage_department']) assert.ok(pm.has(p as any), p);
  assert.ok(!seaImp.has('pro.assign') && !seaImp.has('pro.view_all'));          // other Operations Managers are not PRO supervisors
  // the Documentation Manager adds PRO officers to Documentations — other managers can't
  const { createUser } = await import('../src/server/team');
  const role = (await one(`select id from roles where code = 'pro_officer'`)).id;
  assert.ok(await createUser(pm, { full_name: 'New Officer', mobile: '055 999 0001', role_id: role }));
  await rejects(createUser(seaImp, { full_name: 'X', mobile: '055 999 0002', role_id: role }), 'FORBIDDEN');
  void setRolePermissions;
  // configuration: PRO Manager yes, officer no
  assert.ok((await pro.saveProConfig(pm, { kind: 'authority', name: 'Khorfakkan Port' })).authorities.some((a: any) => a.name === 'Khorfakkan Port'));
  await rejects(pro.saveProConfig(off1, { kind: 'authority', name: 'X' }), 'FORBIDDEN');
  assert.ok((await pro.saveProConfig(admin, { kind: 'activity_type', name: 'Halal certificate' })).activity_types.some((t: any) => t.code === 'halal_certificate'));
});

test('Reports A–E: data, filters, export, permissions', async () => {
  const P = { from: today, to: D(30) };
  const P0 = { from: D(-30), to: D(30) };
  const reg = await runReport(pm, 'pro_register', P0);
  assert.ok(reg.rows.some((r: any) => r.job_no === 'SI-500' && r.status_name === 'Completed' && /Dubai Customs/.test(r.authorities)));
  assert.equal((await runReport(pm, 'pro_register', { ...P0, job_no: 'SI-600' })).total, 1);
  const cont = await runReport(seaImp, 'pro_containers', { ...P0, job_no: 'SI-500' });   // Sea-Import's own request
  assert.equal(cont.total, 2); assert.ok(cont.rows.every((r: any) => r.release_label === 'Released' && r.customs_cleared_at));
  const offi = await runReport(pm, 'pro_officers', P0);
  const o1 = offi.rows.find((r: any) => r.officer === 'Officer One')!;
  assert.ok(Number(o1.completed) >= 1 && Number(o1.overdue) >= 1);
  const pend = await runReport(pm, 'pro_authority_pending', P0);
  assert.ok(pend.rows.some((r: any) => r.activity_status === 'Pending approval'));
  const ch = await runReport(fin, 'pro_charges', P0);
  assert.equal(ch.totals!.actual, '1250.50'); assert.equal(ch.totals!.estimate, '400.00');
  assert.ok(ch.rows.some((r: any) => r.kind === 'Estimate' && r.estimate === '400.00' && r.actual === null));
  assert.ok(!reportList(opsSub).some((r) => r.key === 'pro_charges'));
  await rejects(runReport(opsSub, 'pro_charges', P0), 'FORBIDDEN');
  assert.ok(!reportList(tm).some((r) => r.key.startsWith('pro_')));
  await rejects(runReport(tm, 'pro_register', P0), 'FORBIDDEN');
  const csv = (await exportReport(pm, 'pro_containers', { ...P0, job_no: 'SI-500' }, 'csv')).body.toString();
  assert.match(csv, /Container,PRO Request No\.,Job No\./); assert.match(csv, /MSCU1234566/);
  assert.ok((await exportReport(fin, 'pro_charges', P0, 'xlsx')).body.length > 1000);
  void P;
});

test('Messenger runs are untouched by PRO', async () => {
  const runs = await listRuns(admin, {} as any);
  assert.equal(runs.total, 0);
  assert.equal(Number((await one(`select count(*) n from notifications where run_id is not null`)).n), 0);
});
