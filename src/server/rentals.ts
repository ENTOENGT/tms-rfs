/**
 * Rental trucks — hired transport when own vehicles are not available.
 *
 * Per job: Transport chooses a rental company, types the hired truck (plate, type), the hired driver
 * (name, mobile) and the rental cost. A Transport Manager's own hire is approved at once; a sub-user's
 * hire waits for a user with `rentals.approve` (Transport Manager, Super Admin).
 *
 * On approval the hired driver and truck become driver / vehicle records marked with the rental company
 * (`subcontractor_id`), so the normal assignment, conflict checks, status steps, POD and — when Transport
 * chooses — the driver phone app all work unchanged. Hired records stay off the own-fleet lists.
 * The rental cost is added to the job's transport cost (expense type "rental"), and the supplier's bill
 * (invoice no., paid / unpaid) is tracked on the rental. Cost figures follow the normal cost-visibility rule.
 */
import { Actor } from './auth';
import { ApiError, audit, bad, Db, forbidden, notFound, one, q, tx } from './db';
import { phoneProblem } from '../lib/requestRules';
import { phoneKey } from './auth';
import { jobScope } from './scope';
import { toInstant } from './workflow';

const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const OPEN_JOB = ['requested', 'pending_assignment', 'assigned', 'confirmed'];
export const canRequestRental = (a: Actor) => a.has('jobs.assign_driver') && a.has('jobs.assign_vehicle');
export const canApproveRental = (a: Actor) => a.isSuperAdmin || a.has('rentals.approve');

async function jobFor(actor: Actor, jobId: string, db: Db, lock = false) {
  if (!isUuid(jobId)) throw notFound('Job');
  const p: unknown[] = [jobId];
  const j = await one(`select t.*, s.name status_name, s.stage from transport_requests t join job_statuses s on s.code = t.status_code
    where t.id = $1 and t.deleted_at is null${jobScope(actor, p)}${lock ? ' for update of t' : ''}`, p, db);
  if (!j) throw notFound('Job');
  return j;
}
async function notify(db: Db, userIds: (string | null | undefined)[], type: string, title: string, jobId: string, exclude?: string) {
  for (const uid of [...new Set(userIds.filter((u): u is string => !!u && u !== exclude))])
    await db.query('insert into notifications (user_id, type, title, job_id) values ($1,$2,$3,$4)', [uid, type, title, jobId]);
}
const approvers = (db: Db) => q<{ id: string }>(`select u.id from users u join roles r on r.id = u.role_id
  where u.is_active and u.deleted_at is null and r.code <> 'super_admin' and user_has_perm(u.id, 'rentals.approve')`, [], db);
const jref = (j: any) => `Job No. ${j.job_no ?? j.job_number}`;

// ------------------------------------------------------------ request (and approve at once for managers)
export async function requestRental(actor: Actor, jobId: string, b: any) {
  if (!canRequestRental(actor)) throw forbidden('Only Transport can hire a rental truck');
  const fields: Record<string, string> = {};
  if (!isUuid(b.subcontractor_id)) fields.subcontractor_id = 'Choose the rental company';
  const plate = String(b.vehicle_number ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!plate) fields.vehicle_number = 'Enter the hired truck plate number';
  if (!String(b.driver_name ?? '').trim()) fields.driver_name = "Enter the hired driver's name";
  const pp = phoneProblem(b.driver_mobile); if (pp) fields.driver_mobile = pp;
  const cost = Number(b.rental_cost);
  if (b.rental_cost === '' || b.rental_cost == null || !Number.isFinite(cost) || cost < 0 || cost > 1_000_000) fields.rental_cost = 'Enter the rental cost';
  if (!b.planned_pickup_at) fields.planned_pickup_at = 'Choose the planned pickup time';
  if (Object.keys(fields).length) throw new ApiError(400, 'VALIDATION', Object.values(fields)[0], { fields });

  const rentalId = await tx(async (c) => {
    const job = await jobFor(actor, jobId, c, true);
    if (!OPEN_JOB.includes(job.status_code))
      throw new ApiError(409, 'NOT_ASSIGNABLE', `A job that is "${job.status_name}" can't get a rental truck now.`);
    const sup = await one('select id, name, is_active from subcontractors where id = $1 and deleted_at is null', [b.subcontractor_id], c);
    if (!sup || !sup.is_active) throw bad('Rental company not found');
    if (b.vehicle_type_id && !(isUuid(b.vehicle_type_id) && await one('select 1 from vehicle_types where id = $1', [b.vehicle_type_id], c))) throw bad('Vehicle type not found');
    const own = await one('select 1 from vehicles where upper(vehicle_number) = $1 and deleted_at is null and subcontractor_id is null', [plate], c);
    if (own) throw bad(`${plate} is one of your own vehicles — assign it normally instead of hiring.`);
    const pickup = await toInstant(b.planned_pickup_at, 'Planned pickup', c);
    const eta = await toInstant(b.planned_delivery_at, 'Delivery ETA', c);
    if (eta && pickup && eta <= pickup) throw bad('Delivery ETA must be after the pickup time');
    if (await one(`select 1 from job_rentals where job_id = $1 and status = 'requested'`, [jobId], c))
      throw new ApiError(409, 'RENTAL_PENDING', 'A rental for this job is already waiting for approval.');
    const r = await one(`insert into job_rentals (job_id, subcontractor_id, vehicle_number, vehicle_type_id, driver_name, driver_mobile,
        planned_pickup_at, planned_delivery_at, rental_cost, send_app_link, remarks, requested_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [jobId, sup.id, plate, b.vehicle_type_id || null, String(b.driver_name).trim().slice(0, 120), String(b.driver_mobile).trim().slice(0, 40),
       pickup, eta, cost.toFixed(2), !!b.send_app_link, b.remarks ? String(b.remarks).trim().slice(0, 500) : null, actor.id], c);
    await audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId, action: 'Rental truck requested',
      new_value: `${sup.name} — ${plate}, driver ${String(b.driver_name).trim()}` });
    if (!canApproveRental(actor))
      await notify(c, (await approvers(c)).map((u) => u.id), 'rental.requested', `Rental truck to approve — ${jref(job)} (${sup.name})`, jobId, actor.id);
    return r.id as string;
  });
  if (canApproveRental(actor)) return approveRental(actor, rentalId, { override_conflicts: b.override_conflicts, confirm_warnings: true });
  const { getJob } = await import('./jobs');
  return getJob(actor, jobId);
}

// ------------------------------------------------------------ approve: hired driver + truck → normal assignment
export async function approveRental(actor: Actor, rentalId: string, b: any = {}) {
  if (!canApproveRental(actor)) throw forbidden('Only the Transport Manager approves rental trucks');
  if (!isUuid(rentalId)) throw notFound('Rental');
  // times as local "YYYY-MM-DDTHH:MM" in the company time zone, the form assignJob expects
  const r = await one(`select jr.*, s.name supplier,
      to_char(jr.planned_pickup_at at time zone coalesce((select value #>> '{}' from settings where key = 'timezone'), 'Asia/Dubai'), 'YYYY-MM-DD"T"HH24:MI') pickup_local,
      to_char(jr.planned_delivery_at at time zone coalesce((select value #>> '{}' from settings where key = 'timezone'), 'Asia/Dubai'), 'YYYY-MM-DD"T"HH24:MI') eta_local
    from job_rentals jr join subcontractors s on s.id = jr.subcontractor_id where jr.id = $1`, [rentalId]);
  if (!r) throw notFound('Rental');
  if (r.status !== 'requested') throw new ApiError(409, 'RENTAL_DONE', `This rental is already ${r.status}.`);
  // 1. the hired driver and truck, kept apart from the own fleet by their rental company
  const ids = await tx(async (c) => {
    await jobFor(actor, r.job_id, c);
    let veh = await one('select id, subcontractor_id from vehicles where upper(vehicle_number) = $1 and deleted_at is null', [r.vehicle_number], c);
    if (veh && !veh.subcontractor_id) throw bad(`${r.vehicle_number} is one of your own vehicles.`);
    if (veh) await c.query(`update vehicles set subcontractor_id = $2, vehicle_type_id = coalesce($3, vehicle_type_id), status = 'available', updated_at = now() where id = $1`,
      [veh.id, r.subcontractor_id, r.vehicle_type_id]);
    else veh = await one(`insert into vehicles (vehicle_number, vehicle_type_id, subcontractor_id, category, remarks)
      values ($1,$2,$3,'Hired','Rental truck') returning id`, [r.vehicle_number, r.vehicle_type_id, r.subcontractor_id], c);
    let drv = await one(`select id from drivers where deleted_at is null and subcontractor_id = $1
      and right(regexp_replace(coalesce(mobile, ''), '\\D', '', 'g'), 9) = $2`, [r.subcontractor_id, phoneKey(r.driver_mobile)], c);
    if (drv) await c.query(`update drivers set full_name = $2, mobile = $3, status = 'available', updated_at = now() where id = $1`, [drv.id, r.driver_name, r.driver_mobile]);
    else drv = await one(`insert into drivers (full_name, mobile, subcontractor_id, remarks) values ($1,$2,$3,'Hired driver') returning id`,
      [r.driver_name, r.driver_mobile, r.subcontractor_id], c);
    return { vehicle_id: veh!.id as string, driver_id: drv!.id as string };
  });
  // 2. assign them through the normal assignment (conflict checks, notifications, history)
  const { assignJob } = await import('./workflow');
  await assignJob(actor, r.job_id, { driver_id: ids.driver_id, vehicle_id: ids.vehicle_id,
    planned_pickup_at: r.pickup_local, planned_delivery_at: r.eta_local,
    confirm_warnings: true, override_conflicts: !!b.override_conflicts && actor.has('jobs.override_conflicts') });
  // 3. mark approved, record the rental company on the assignment, add the cost line
  await tx(async (c) => {
    const job = await jobFor(actor, r.job_id, c, true);
    const label = `Rental: ${r.supplier} — ${r.vehicle_number}`;
    await c.query(`update job_rentals set status = 'replaced', updated_at = now() where job_id = $1 and status = 'approved' and id <> $2`, [r.job_id, r.id]);
    await c.query(`update job_rentals set status = 'approved', approved_by = $2, approved_at = now(), driver_id = $3, vehicle_id = $4,
        cost_label = $5, updated_at = now() where id = $1`, [r.id, actor.id, ids.driver_id, ids.vehicle_id, label]);
    await c.query('update transport_assignments set subcontractor_id = $2 where job_id = $1 and is_current', [r.job_id, r.subcontractor_id]);
    await c.query(`insert into job_cost_lines (job_id, expense_type_code, amount, description, created_by) values ($1, 'rental', $2, $3, $4)`,
      [r.job_id, r.rental_cost, label, actor.id]);
    await audit(c, actor, { entity_type: 'job', entity_id: r.job_id, job_id: r.job_id, action: 'Rental truck approved', new_value: label });
    await audit(c, actor, { entity_type: 'job', entity_id: r.job_id, job_id: r.job_id, action: 'Transport cost changed', field: 'cost.rental',
      new_value: String(r.rental_cost), sensitivity: 'cost' });
    if (r.requested_by !== actor.id) await notify(c, [r.requested_by], 'rental.approved', `Rental truck approved — ${jref(job)} (${r.vehicle_number})`, r.job_id);
  });
  const { getJob } = await import('./jobs');
  return getJob(actor, r.job_id);
}

export async function rejectRental(actor: Actor, rentalId: string, b: any) {
  const reason = String(b.reason ?? '').trim() || (b.cancel ? 'Withdrawn by requester' : '');
  if (reason.length < 3) throw bad('Give a reason');
  const r = isUuid(rentalId) ? await one('select * from job_rentals where id = $1', [rentalId]) : null;
  if (!r) throw notFound('Rental');
  const own = r.requested_by === actor.id && b.cancel;
  if (!own && !canApproveRental(actor)) throw forbidden('Only the Transport Manager approves rental trucks');
  if (r.status !== 'requested') throw new ApiError(409, 'RENTAL_DONE', `This rental is already ${r.status}.`);
  await tx(async (c) => {
    const job = await jobFor(actor, r.job_id, c);
    await c.query(`update job_rentals set status = $2, reject_reason = $3, approved_by = $4, approved_at = now(), updated_at = now() where id = $1`,
      [r.id, own ? 'cancelled' : 'rejected', own && !String(b.reason ?? '').trim() ? null : reason.slice(0, 500), actor.id]);
    await audit(c, actor, { entity_type: 'job', entity_id: r.job_id, job_id: r.job_id, action: own ? 'Rental request withdrawn' : 'Rental truck rejected', new_value: reason });
    if (!own) await notify(c, [r.requested_by], 'rental.rejected', `Rental truck not approved — ${jref(job)}: ${reason}`, r.job_id);
  });
  const { getJob } = await import('./jobs');
  return getJob(actor, r.job_id);
}

// ------------------------------------------------------------ the supplier's bill
export async function updateRentalBill(actor: Actor, rentalId: string, b: any) {
  if (!canApproveRental(actor) && !actor.has('finance.buying.edit')) throw forbidden();
  const r = isUuid(rentalId) ? await one('select * from job_rentals where id = $1', [rentalId]) : null;
  if (!r) throw notFound('Rental');
  if (r.status !== 'approved') throw bad('Only an approved rental has a bill');
  const status = b.payment_status ?? r.payment_status;
  if (!['unpaid', 'paid'].includes(status)) throw bad('Invalid payment status');
  const paidOn = status === 'paid' ? (b.paid_on && /^\d{4}-\d{2}-\d{2}$/.test(b.paid_on) ? b.paid_on : new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' })) : null;
  let cost = r.rental_cost;
  if (b.rental_cost !== undefined && b.rental_cost !== '') {
    const n = Number(b.rental_cost);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw bad('Enter the rental cost');
    cost = n.toFixed(2);
  }
  await tx(async (c) => {
    await jobFor(actor, r.job_id, c, true);
    await c.query(`update job_rentals set supplier_invoice_no = $2, payment_status = $3, paid_on = $4, rental_cost = $5, updated_at = now() where id = $1`,
      [r.id, b.supplier_invoice_no !== undefined ? (String(b.supplier_invoice_no).trim().slice(0, 60) || null) : r.supplier_invoice_no, status, paidOn, cost]);
    if (String(cost) !== String(r.rental_cost)) {
      await c.query(`update job_cost_lines set amount = $3 where job_id = $1 and expense_type_code = 'rental' and description = $2`, [r.job_id, r.cost_label, cost]);
      await audit(c, actor, { entity_type: 'job', entity_id: r.job_id, job_id: r.job_id, action: 'Transport cost changed', field: 'cost.rental',
        old_value: String(r.rental_cost), new_value: String(cost), sensitivity: 'cost' });
    }
    await audit(c, actor, { entity_type: 'job', entity_id: r.job_id, job_id: r.job_id, action: 'Rental bill updated',
      new_value: `${b.supplier_invoice_no ?? r.supplier_invoice_no ?? '—'} · ${status}`, sensitivity: 'cost' });
  });
  const { getJob } = await import('./jobs');
  return getJob(actor, r.job_id);
}

/** Rentals shown on the job. Cost and bill only for people who see transport cost. */
export async function rentalsForJob(actor: Actor, jobId: string, db?: Db) {
  const rows = await q(`select jr.id, jr.status, jr.vehicle_number, vt.name vehicle_type, jr.driver_name, jr.driver_mobile, jr.planned_pickup_at,
      jr.planned_delivery_at, jr.rental_cost, jr.send_app_link, jr.remarks, jr.reject_reason, jr.requested_at, jr.approved_at,
      jr.supplier_invoice_no, jr.payment_status, jr.paid_on, jr.driver_id, s.name supplier, s.contact_number supplier_phone,
      rq.full_name requested_by_name, ap.full_name approved_by_name, jr.requested_by
    from job_rentals jr join subcontractors s on s.id = jr.subcontractor_id left join vehicle_types vt on vt.id = jr.vehicle_type_id
    join users rq on rq.id = jr.requested_by left join users ap on ap.id = jr.approved_by
    where jr.job_id = $1 order by jr.requested_at desc`, [jobId], db);
  const seeCost = actor.fin.buyingView || canApproveRental(actor);
  return rows.map(({ rental_cost, supplier_invoice_no, payment_status, paid_on, requested_by, ...x }) => ({
    ...x, ...(seeCost ? { rental_cost, supplier_invoice_no, payment_status, paid_on } : {}),
    can_approve: x.status === 'requested' && canApproveRental(actor),
    can_withdraw: x.status === 'requested' && requested_by === actor.id,
    can_bill: x.status === 'approved' && (canApproveRental(actor) || actor.has('finance.buying.edit')),
  }));
}

// ------------------------------------------------------------ rental report (per supplier, cost viewers)
export async function rentalReport(actor: Actor, def: any, cols: any[], colsOut: any[], p: Record<string, string>, opts: { all?: boolean }) {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE.test(p.from ?? '') || !DATE.test(p.to ?? '')) throw bad('Choose a period');
  const params: unknown[] = [p.from, p.to];
  let where = `where jr.status = 'approved' and (jr.planned_pickup_at at time zone 'Asia/Dubai')::date between $1 and $2` + jobScope(actor, params);
  if (p.subcontractor_id) { if (!isUuid(p.subcontractor_id)) throw bad('Invalid filter'); params.push(p.subcontractor_id); where += ` and jr.subcontractor_id = $${params.length}`; }
  if (p.payment_status) { if (!['paid', 'unpaid'].includes(p.payment_status)) throw bad('Invalid filter'); params.push(p.payment_status); where += ` and jr.payment_status = $${params.length}`; }
  if (p.job_no?.trim()) { params.push('%' + p.job_no.trim().toLowerCase() + '%'); where += ` and lower(t.job_no) like $${params.length}`; }
  const sortCol = cols.find((c: any) => c.key === p.sort && c.sort);
  const cap = opts.all ? 50000 : Math.min(Math.max(Number(p.page_size) || 100, 1), 500);
  const page = opts.all ? 1 : Math.max(Number(p.page) || 1, 1);
  const rows = await q(`select jr.planned_pickup_at trip_date, t.job_no, t.job_number, s.name supplier, jr.vehicle_number, vt.name vehicle_type,
      jr.driver_name, jr.rental_cost, jr.supplier_invoice_no, jr.payment_status, jr.paid_on, ap.full_name approved_by_name, js.name job_status,
      count(*) over() _total, sum(jr.rental_cost) over() _sum, sum(case when jr.payment_status = 'unpaid' then jr.rental_cost else 0 end) over() _unpaid
    from job_rentals jr join transport_requests t on t.id = jr.job_id join job_statuses js on js.code = t.status_code
    join subcontractors s on s.id = jr.subcontractor_id left join vehicle_types vt on vt.id = jr.vehicle_type_id left join users ap on ap.id = jr.approved_by
    ${where} order by ${sortCol ? `${sortCol.sort} ${p.dir === 'asc' ? 'asc' : 'desc'} nulls last` : 'jr.planned_pickup_at desc'} limit ${cap} offset ${(page - 1) * cap}`, params);
  return { report: { key: def.key, title: def.title, kind: def.kind }, columns: colsOut,
    rows: rows.map((r) => Object.fromEntries(cols.map((c: any) => [c.key, c.key === 'payment_status' ? (r.payment_status === 'paid' ? 'Paid' : 'Unpaid') : r[c.key] ?? null]))),
    totals: { trip_date: 'Total', rental_cost: rows[0]?._sum ?? '0.00', supplier_invoice_no: `Unpaid: ${rows[0]?._unpaid ?? '0.00'}` },
    total: Number(rows[0]?._total ?? 0), page, page_size: cap, filters: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) };
}
