/**
 * Phase 3 — assignment, availability, status workflow, request editing.
 * Times arrive from the browser as local wall-clock ("2026-09-26T10:00") and are
 * interpreted in the company timezone from settings (Asia/Dubai by default).
 */
import { PoolClient } from 'pg';
import { Actor, requirePerm } from './auth';
import { ApiError, audit, bad, Db, forbidden, getSetting, notFound, one, q, tx } from './db';
import { getJob, usersWithPermission } from './jobs';
import { canMove } from './transitions';

const UUID = /^[0-9a-f-]{36}$/i;
const LOCAL_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const BLOCKED_DRIVER = ['on_leave', 'off_duty', 'inactive'];
const BLOCKED_VEHICLE = ['maintenance', 'inactive'];
const ASSIGNABLE = ['requested', 'pending_assignment', 'assigned', 'confirmed'];

async function notify(db: Db, userIds: (string | null | undefined)[], type: string, title: string, jobId: string) {
  // Fixed templates, job number only — never amounts.
  for (const uid of [...new Set(userIds.filter(Boolean))])
    await db.query('insert into notifications (user_id, type, title, job_id) values ($1,$2,$3,$4)', [uid, type, title, jobId]);
}

async function jobForUpdate(c: PoolClient, actor: Actor, id: string) {
  if (!UUID.test(id)) throw notFound('Job');
  const p: unknown[] = [id];
  let scope = '';
  if (!actor.has('jobs.view_all')) { p.push(actor.id); scope = ' and t.requested_by = $2'; }
  const job = await one(`select t.*, s.stage, s.name status_name from transport_requests t
      join job_statuses s on s.code = t.status_code
     where t.id = $1 and t.deleted_at is null${scope} for update of t`, p, c);
  if (!job) throw notFound('Job');
  return job;
}

// ------------------------------------------------------------ window
function windowSql(pickup: number, delivery: number) {
  return `tstzrange($${pickup}::timestamptz, greatest(coalesce($${delivery}::timestamptz, $${pickup}::timestamptz + interval '4 hours'),
          $${pickup}::timestamptz + interval '1 minute'), '[)')`;
}
async function toInstant(local: unknown, label: string, db?: Db): Promise<string | null> {
  if (local === undefined || local === null || local === '') return null;
  if (typeof local !== 'string' || !LOCAL_DT.test(local)) throw bad(`${label} is invalid`);
  const tz = await getSetting<string>('timezone', 'Asia/Dubai', db);
  const r = await one<{ t: string }>(`select ($1::timestamp at time zone $2)::text t`, [local, tz], db);
  return r!.t;
}

// ------------------------------------------------------------ availability
export async function availability(actor: Actor, p: Record<string, string>) {
  if (!actor.has('jobs.assign_driver') && !actor.has('jobs.assign_vehicle')) throw forbidden();
  const from = await toInstant(p.from, 'Pickup time');
  if (!from) throw bad('Pickup time is required');
  const to = await toInstant(p.to, 'Delivery ETA');
  const exclude = p.exclude_job && UUID.test(p.exclude_job) ? p.exclude_job : null;
  const day = from.slice(0, 10);
  const busy = (col: string) => `coalesce((select json_agg(json_build_object('job_number', t.job_number, 'job_id', t.id,
        'from', lower(a.busy_window), 'to', upper(a.busy_window)) order by lower(a.busy_window))
      from transport_assignments a join transport_requests t on t.id = a.job_id
     where a.${col} = e.id and a.is_current and t.deleted_at is null and t.status_code <> 'cancelled'
       and ($3::uuid is null or a.job_id <> $3) and a.busy_window && ${windowSql(1, 2)}), '[]')`;
  const drivers = await q(`select e.id, e.full_name, e.mobile, e.status, e.license_expiry, e.visa_expiry,
      ${busy('driver_id')} conflicts
    from drivers e where e.deleted_at is null and e.status <> 'inactive' order by e.full_name`, [from, to, exclude]);
  const vehicles = await q(`select e.id, e.vehicle_number, e.status, e.vehicle_type_id, vt.name vehicle_type, e.weight_capacity_kg,
      e.volume_capacity_cbm, e.registration_expiry, e.insurance_expiry, e.default_driver_id, ${busy('vehicle_id')} conflicts
    from vehicles e left join vehicle_types vt on vt.id = e.vehicle_type_id
    where e.deleted_at is null and e.status <> 'inactive' order by vt.sort_order, e.vehicle_number`, [from, to, exclude]);
  const expired = (d: string | null) => !!d && d < day;
  return {
    drivers: drivers.map((d) => ({ ...d, blocked: BLOCKED_DRIVER.includes(d.status) || expired(d.license_expiry) || expired(d.visa_expiry) })),
    vehicles: vehicles.map((v) => ({ ...v, blocked: BLOCKED_VEHICLE.includes(v.status) || expired(v.registration_expiry) || expired(v.insurance_expiry) })),
  };
}

// ------------------------------------------------------------ assign
interface Issue { level: 'blocking' | 'warning'; message: string }
const fmtDate = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export async function assignJob(actor: Actor, jobId: string, b: any) {
  const driverId = b.driver_id || null, vehicleId = b.vehicle_id || null;
  if (!driverId && !vehicleId) throw bad('Choose a driver and/or a vehicle');
  if ((driverId && !UUID.test(driverId)) || (vehicleId && !UUID.test(vehicleId))) throw bad('Invalid driver or vehicle');
  if (b.override_conflicts && !actor.has('jobs.override_conflicts'))
    throw forbidden('Only users allowed to override conflicts can do this');

  return tx(async (c) => {
    const job = await jobForUpdate(c, actor, jobId);
    const cur = await one('select * from transport_assignments where job_id = $1 and is_current', [jobId], c);
    if ((driverId ?? null) !== (cur?.driver_id ?? null)) requirePerm(actor, 'jobs.assign_driver');
    if ((vehicleId ?? null) !== (cur?.vehicle_id ?? null)) requirePerm(actor, 'jobs.assign_vehicle');
    if (!actor.has('jobs.assign_driver') && !actor.has('jobs.assign_vehicle')) throw forbidden();
    if (!ASSIGNABLE.includes(job.status_code)) {
      if (!(job.stage === 'active' && actor.has('jobs.override_conflicts')))
        throw new ApiError(409, 'NOT_ASSIGNABLE', `A job that is "${job.status_name}" can't be reassigned. Ask a user with override permission.`);
    }
    const pickup = await toInstant(b.planned_pickup_at, 'Planned pickup', c);
    if (!pickup) throw bad('Planned pickup time is required');
    const eta = await toInstant(b.planned_delivery_at, 'Delivery ETA', c);
    if (eta && eta <= pickup) throw bad('Delivery ETA must be after the pickup time');

    // Serialise assignments per driver/vehicle so two people can't double-book at the same moment.
    for (const id of [driverId, vehicleId].filter(Boolean)) await c.query('select pg_advisory_xact_lock(hashtext($1))', [id]);

    const issues: Issue[] = [];
    const tz = await getSetting<string>('timezone', 'Asia/Dubai', c);
    const day = (await one(`select ($1::timestamptz at time zone $2)::date::text d`, [pickup, tz], c))!.d;
    const overlap = async (col: string, id: string) => q(`select t.job_number from transport_assignments a
        join transport_requests t on t.id = a.job_id
       where a.${col} = $3 and a.is_current and a.job_id <> $4 and t.deleted_at is null and t.status_code <> 'cancelled'
         and a.busy_window && ${windowSql(1, 2)} order by lower(a.busy_window)`, [pickup, eta, id, jobId], c);

    let driver: any = null, vehicle: any = null;
    if (driverId) {
      driver = await one('select * from drivers where id = $1 and deleted_at is null', [driverId], c);
      if (!driver) throw bad('Driver not found');
      if (BLOCKED_DRIVER.includes(driver.status)) issues.push({ level: 'blocking', message: `${driver.full_name} is marked ${driver.status.replace('_', ' ')}.` });
      if (driver.license_expiry && driver.license_expiry < day) issues.push({ level: 'blocking', message: `${driver.full_name}'s licence expired on ${fmtDate(driver.license_expiry)}.` });
      if (driver.visa_expiry && driver.visa_expiry < day) issues.push({ level: 'blocking', message: `${driver.full_name}'s visa expired on ${fmtDate(driver.visa_expiry)}.` });
      const o = await overlap('driver_id', driverId);
      if (o.length) issues.push({ level: 'blocking', message: `Driver already assigned to another job during this time slot (${o.map((x) => x.job_number).join(', ')}).` });
    }
    if (vehicleId) {
      vehicle = await one(`select v.*, vt.name type_name from vehicles v left join vehicle_types vt on vt.id = v.vehicle_type_id
        where v.id = $1 and v.deleted_at is null`, [vehicleId], c);
      if (!vehicle) throw bad('Vehicle not found');
      if (BLOCKED_VEHICLE.includes(vehicle.status)) issues.push({ level: 'blocking', message: `${vehicle.vehicle_number} is marked ${vehicle.status}.` });
      if (vehicle.registration_expiry && vehicle.registration_expiry < day) issues.push({ level: 'blocking', message: `${vehicle.vehicle_number} registration expired on ${fmtDate(vehicle.registration_expiry)}.` });
      if (vehicle.insurance_expiry && vehicle.insurance_expiry < day) issues.push({ level: 'blocking', message: `${vehicle.vehicle_number} insurance expired on ${fmtDate(vehicle.insurance_expiry)}.` });
      const o = await overlap('vehicle_id', vehicleId);
      if (o.length) issues.push({ level: 'blocking', message: `Vehicle already assigned during this time slot (${o.map((x) => x.job_number).join(', ')}).` });
      if (job.requested_vehicle_type_id && vehicle.vehicle_type_id !== job.requested_vehicle_type_id) {
        const want = await one('select name from vehicle_types where id = $1', [job.requested_vehicle_type_id], c);
        issues.push({ level: 'warning', message: `Operations asked for a ${want?.name}; ${vehicle.vehicle_number} is a ${vehicle.type_name ?? 'vehicle of another type'}.` });
      }
      if (job.weight_kg && vehicle.weight_capacity_kg && Number(job.weight_kg) > Number(vehicle.weight_capacity_kg))
        issues.push({ level: 'warning', message: `Cargo weight ${Number(job.weight_kg)} kg is over this vehicle's ${Number(vehicle.weight_capacity_kg)} kg capacity.` });
      if (job.volume_cbm && vehicle.volume_capacity_cbm && Number(job.volume_cbm) > Number(vehicle.volume_capacity_cbm))
        issues.push({ level: 'warning', message: `Cargo volume ${Number(job.volume_cbm)} cbm is over this vehicle's ${Number(vehicle.volume_capacity_cbm)} cbm capacity.` });
    }
    if (day !== job.required_date) issues.push({ level: 'warning', message: `Pickup is on ${fmtDate(day)} but Operations required ${fmtDate(job.required_date)}.` });

    const blocking = issues.filter((i) => i.level === 'blocking');
    const warnings = issues.filter((i) => i.level === 'warning');
    if (blocking.length && !b.override_conflicts)
      throw new ApiError(409, 'ASSIGNMENT_BLOCKED', 'This assignment has problems that must be fixed or overridden.',
        { issues, can_override: actor.has('jobs.override_conflicts') });
    if (warnings.length && !b.confirm_warnings && !b.override_conflicts)
      throw new ApiError(409, 'ASSIGNMENT_WARNINGS', 'Please check before assigning.', { issues, can_override: false });

    // Record the change
    if (cur) await c.query('update transport_assignments set is_current = false where id = $1', [cur.id]);
    await c.query(`insert into transport_assignments (job_id, driver_id, vehicle_id, vehicle_type_id, planned_pickup_at, planned_delivery_at,
        assigned_by, conflict_overridden_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [jobId, driverId, vehicleId, vehicle?.vehicle_type_id ?? null, pickup, eta, actor.id, blocking.length ? actor.id : null]);
    const name = async (t: string, col: string, id: string | null) => id ? (await one(`select ${col} n from ${t} where id = $1`, [id], c))?.n : null;
    const log = (field: string, o: unknown, n: unknown) => (o ?? null) !== (n ?? null) &&
      audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId, action: field === 'Driver' ? 'Driver assigned' : field === 'Vehicle' ? 'Vehicle assigned' : 'Schedule changed', field, old_value: o, new_value: n });
    await log('Driver', await name('drivers', 'full_name', cur?.driver_id), driver?.full_name);
    await log('Vehicle', await name('vehicles', 'vehicle_number', cur?.vehicle_id), vehicle?.vehicle_number);
    const fmt = async (t: string | null) => t ? (await one(`select to_char($1::timestamptz at time zone $2, 'DD Mon YYYY HH24:MI') v`, [t, tz], c))!.v : null;
    await log('Planned pickup', await fmt(cur?.planned_pickup_at?.toISOString?.() ?? cur?.planned_pickup_at ?? null), await fmt(pickup));
    await log('Delivery ETA', await fmt(cur?.planned_delivery_at?.toISOString?.() ?? cur?.planned_delivery_at ?? null), await fmt(eta));
    if (blocking.length)
      await audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId, action: 'Conflict overridden', new_value: blocking.map((i) => i.message).join(' ') });

    if (['requested', 'pending_assignment'].includes(job.status_code)) {
      await c.query(`update transport_requests set status_code = 'assigned', updated_at = now() where id = $1`, [jobId]);
      await audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId, action: 'Status changed', field: 'Status', old_value: job.status_name, new_value: 'Assigned' });
    } else await c.query('update transport_requests set updated_at = now() where id = $1', [jobId]);
    await c.query('select refresh_job_search($1)', [jobId]);
    await notify(c, [job.requested_by !== actor.id ? job.requested_by : null], 'job.assigned',
      cur ? `Assignment changed on ${job.job_number}` : `Driver and vehicle assigned to ${job.job_number}`, jobId);
    return { ok: true, warnings: warnings.map((w) => w.message) };
  }).then(() => getJob(actor, jobId));
}

// ------------------------------------------------------------ status workflow
export async function changeStatus(actor: Actor, jobId: string, b: any) {
  const to = String(b.to ?? '');
  await tx(async (c) => {
    const job = await jobForUpdate(c, actor, jobId);
    const target = await one('select code, name, stage from job_statuses where code = $1 and is_active', [to], c);
    if (!target) throw bad('Unknown status');
    if (to === job.status_code) return;
    const allowed = await one('select 1 from status_transitions where from_code = $1 and to_code = $2', [job.status_code, to], c);
    if (!allowed && !actor.isSuperAdmin)
      throw new ApiError(409, 'INVALID_TRANSITION', `A job can't go from "${job.status_name}" to "${target.name}".`);
    if (!canMove(actor, job.status_code, to, target.stage)) throw forbidden(`You can't move a job to "${target.name}"`);
    if (['closed', 'cancelled'].includes(job.stage) && !actor.has('jobs.edit_completed'))
      throw new ApiError(409, 'JOB_LOCKED', 'This job is closed.');

    const asg = await one('select * from transport_assignments where job_id = $1 and is_current', [jobId], c);
    if (to === 'assigned' && !asg?.driver_id && !asg?.vehicle_id)
      throw new ApiError(409, 'NOT_ASSIGNED', 'Use "Assign" to choose a driver and vehicle.');
    const needsTruck = ['confirmed', 'dispatched', 'picked_up', 'in_transit', 'delivered'].includes(to);
    if (needsTruck && (!asg?.driver_id || !asg?.vehicle_id))
      throw new ApiError(409, 'NOT_ASSIGNED', 'Assign a driver and a vehicle first.');
    const at = (await toInstant(b.at, 'Time', c)) ?? new Date().toISOString();
    let reason: string | null = null;

    if (to === 'cancelled') {
      reason = String(b.reason ?? '').trim();
      if (reason.length < 3) throw bad('Give a reason for cancelling');
      await c.query('update transport_requests set cancelled_at = now(), cancel_reason = $2 where id = $1', [jobId, reason.slice(0, 500)]);
    }
    if (to === 'pending_assignment' && asg) await c.query('update transport_assignments set is_current = false where id = $1', [asg.id]);
    if (to === 'picked_up') await c.query('update transport_assignments set actual_pickup_at = $2 where id = $1', [asg.id, at]);
    if (to === 'delivered') {
      if (asg.actual_pickup_at && new Date(at) < new Date(asg.actual_pickup_at)) throw bad('Delivery time is before the pickup time');
      await c.query('update transport_assignments set actual_pickup_at = coalesce(actual_pickup_at, $2), actual_delivery_at = $2 where id = $1', [asg.id, at]);
    }
    if (['completed', 'pod_received'].includes(to) && !['uploaded', 'verified', 'not_required'].includes(job.pod_status))
      throw new ApiError(409, 'POD_REQUIRED', 'Upload the POD first, or have it marked "not required".');
    if (to === 'completed') await c.query('update transport_requests set completed_at = now() where id = $1', [jobId]);

    await c.query('update transport_requests set status_code = $2, updated_at = now() where id = $1', [jobId, to]);
    await audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId, action: allowed ? 'Status changed' : 'Status changed (forced by admin)',
      field: 'Status', old_value: job.status_name, new_value: target.name + (reason ? ` — ${reason}` : '') });
    if (to === 'pending_assignment' && asg) await c.query('select refresh_job_search($1)', [jobId]);

    // Who hears about it
    if (job.status_code === 'draft' && to === 'pending_assignment') {
      const t = await usersWithPermission(c, 'jobs.assign_driver', actor.id);
      await notify(c, t.map((u) => u.id), 'job.created', `New transport request ${job.job_number}`, jobId);
    }
    if (to === 'delivered') await notify(c, [job.requested_by], 'job.delivered', `${job.job_number} delivered`, jobId);
    if (to === 'picked_up') await notify(c, [job.requested_by], 'job.picked_up', `${job.job_number} picked up`, jobId);
    if (to === 'cancelled') {
      const t = asg ? await usersWithPermission(c, 'jobs.assign_driver', actor.id) : [];
      await notify(c, [...t.map((u) => u.id), job.requested_by !== actor.id ? job.requested_by : null], 'job.cancelled', `${job.job_number} cancelled`, jobId);
    }
  });
  return getJob(actor, jobId);
}

export async function setPodNotRequired(actor: Actor, jobId: string, notRequired: boolean) {
  requirePerm(actor, 'pod.verify');
  await tx(async (c) => {
    const job = await jobForUpdate(c, actor, jobId);
    const next = notRequired ? 'not_required' : 'pending';
    if (job.pod_status === next) return;
    if (!notRequired && job.pod_status !== 'not_required') return;
    await c.query('update transport_requests set pod_status = $2 where id = $1', [jobId, next]);
    await audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId, action: 'POD requirement changed',
      field: 'POD', old_value: job.pod_status, new_value: next });
  });
  return getJob(actor, jobId);
}

// ------------------------------------------------------------ edit request
type Parser = (v: unknown) => unknown;
const txt = (max: number): Parser => (v) => { const s = v == null ? '' : String(v).trim(); if (s.length > max) throw bad(`Value too long (max ${max})`); return s || null; };
const num = (label: string, int = false): Parser => (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v); if (!Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n))) throw bad(`${label} must be a positive number`); return n;
};
const time: Parser = (v) => { if (v === '' || v == null) return null; if (!/^\d{2}:\d{2}(:\d{2})?$/.test(String(v))) throw bad('Invalid time'); return String(v).slice(0, 5); };
const EDITABLE: Record<string, { label: string; parse: Parser }> = {
  required_date: { label: 'Required date', parse: (v) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw bad('Required date is invalid'); return v; } },
  slot_from: { label: 'Slot from', parse: time }, slot_to: { label: 'Slot to', parse: time },
  priority: { label: 'Priority', parse: (v) => { if (!['low', 'normal', 'high', 'urgent'].includes(String(v))) throw bad('Invalid priority'); return v; } },
  customer_id: { label: 'Customer', parse: (v) => { if (!UUID.test(String(v))) throw bad('Customer is required'); return v; } },
  customer_reference: { label: 'Customer reference', parse: txt(120) }, email_subject: { label: 'Email subject', parse: txt(300) },
  boe_number: { label: 'BOE number', parse: txt(60) }, shipment_number: { label: 'Shipment number', parse: txt(60) },
  booking_reference: { label: 'Booking reference', parse: txt(60) },
  requested_vehicle_type_id: { label: 'Vehicle type needed', parse: (v) => (v ? (UUID.test(String(v)) ? v : (() => { throw bad('Invalid vehicle type'); })()) : null) },
  cargo_description: { label: 'Cargo description', parse: txt(2000) }, cargo_type: { label: 'Cargo type', parse: txt(80) },
  packages: { label: 'Packages', parse: num('Packages', true) }, weight_kg: { label: 'Weight', parse: num('Weight') },
  volume_cbm: { label: 'Volume', parse: num('Volume') }, pallets: { label: 'Pallets', parse: num('Pallets', true) },
  temperature_requirement: { label: 'Temperature', parse: txt(80) }, special_handling: { label: 'Special handling', parse: txt(500) },
  special_instructions: { label: 'Special instructions', parse: txt(2000) },
  pickup_name: { label: 'Pickup', parse: txt(200) }, pickup_address: { label: 'Pickup address', parse: txt(500) },
  pickup_contact_person: { label: 'Pickup contact', parse: txt(120) }, pickup_contact_number: { label: 'Pickup phone', parse: txt(40) },
  delivery_name: { label: 'Delivery', parse: txt(200) }, delivery_address: { label: 'Delivery address', parse: txt(500) },
  delivery_contact_person: { label: 'Delivery contact', parse: txt(120) }, delivery_contact_number: { label: 'Delivery phone', parse: txt(40) },
};

export async function updateRequest(actor: Actor, jobId: string, b: any) {
  await tx(async (c) => {
    const job = await jobForUpdate(c, actor, jobId);
    if (job.stage === 'cancelled') throw new ApiError(409, 'JOB_LOCKED', 'Cancelled jobs can\'t be edited.');
    const need = ['draft', 'open'].includes(job.stage) ? 'jobs.edit' : job.stage === 'active' ? 'jobs.edit_assigned' : 'jobs.edit_completed';
    if (!actor.has(need as any)) throw forbidden(need === 'jobs.edit' ? undefined
      : `This job is already ${job.status_name.toLowerCase()}. Ask Transport or an admin to change it.`);

    // A saved location replaces the manual pickup/delivery fields with its snapshot
    for (const p of ['pickup', 'delivery'] as const) {
      const lid = b[`${p}_location_id`];
      if (lid) {
        const l = await one('select * from locations where id = $1 and deleted_at is null', [lid], c);
        if (!l) throw bad(`Saved ${p} location not found`);
        Object.assign(b, { [`${p}_name`]: l.name, [`${p}_address`]: l.address, [`${p}_contact_person`]: l.contact_person, [`${p}_contact_number`]: l.contact_number });
      }
    }
    const changes: Record<string, [unknown, unknown]> = {};
    for (const [k, f] of Object.entries(EDITABLE)) {
      if (!(k in b)) continue;
      const v = f.parse(b[k]);
      const old = job[k] instanceof Date ? job[k].toISOString().slice(0, 10) : job[k];
      const oldN = typeof old === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(old) ? old.slice(0, 5) : old;
      if (String(oldN ?? '') !== String(v ?? '') && !(typeof v === 'number' && Number(oldN) === v)) changes[k] = [oldN, v];
    }
    if (!Object.keys(changes).length) return;
    if (changes.pickup_name && !changes.pickup_name[1]) throw bad('Pickup location is required');
    if (changes.delivery_name && !changes.delivery_name[1]) throw bad('Delivery location is required');
    const tz = await getSetting<string>('timezone', 'Asia/Dubai', c);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    if (changes.required_date && String(changes.required_date[1]) < today && !actor.has('jobs.backdate')) throw bad('Required date cannot be in the past');
    const sf = changes.slot_from ? changes.slot_from[1] : job.slot_from?.slice(0, 5), st = changes.slot_to ? changes.slot_to[1] : job.slot_to?.slice(0, 5);
    if (sf && st && String(st) <= String(sf)) throw bad('Time slot must end after it starts');
    if (changes.customer_id && !(await one('select 1 from customers where id = $1 and deleted_at is null and is_active', [changes.customer_id[1]], c))) throw bad('Customer not found');
    if (changes.pickup_name || b.pickup_location_id !== undefined) changes.pickup_location_id = [job.pickup_location_id, b.pickup_location_id || null];
    if (changes.delivery_name || b.delivery_location_id !== undefined) changes.delivery_location_id = [job.delivery_location_id, b.delivery_location_id || null];

    const keys = Object.keys(changes);
    await c.query(`update transport_requests set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`,
      [jobId, ...keys.map((k) => changes[k][1])]);
    for (const k of keys.filter((k) => EDITABLE[k])) {
      let [o, n] = changes[k];
      if (k === 'customer_id' || k === 'requested_vehicle_type_id') {
        const t = k === 'customer_id' ? 'customers' : 'vehicle_types';
        const nm = async (id: unknown) => id ? (await one(`select name from ${t} where id = $1`, [id], c))?.name : null;
        [o, n] = [await nm(o), await nm(n)];
      }
      await audit(c, actor, { entity_type: 'job', entity_id: jobId, job_id: jobId, action: 'Request updated', field: EDITABLE[k].label, old_value: o, new_value: n });
    }
    await c.query('select refresh_job_search($1)', [jobId]);
    if (job.stage === 'active') {
      const t = await usersWithPermission(c, 'jobs.assign_driver', actor.id);
      await notify(c, t.map((u) => u.id), 'job.updated', `Request details changed on ${job.job_number}`, jobId);
    }
  });
  return getJob(actor, jobId);
}

// ------------------------------------------------------------ settings
const SETTINGS: Record<string, (v: any) => unknown> = {
  company_name: (v) => { const s = String(v ?? '').trim(); if (!s || s.length > 120) throw bad('Company name is required'); return s; },
  currency: (v) => { const s = String(v ?? '').trim().toUpperCase(); if (!/^[A-Z]{3}$/.test(s)) throw bad('Currency must be a 3-letter code, e.g. AED'); return s; },
  vat_rate: (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100) throw bad('VAT rate must be between 0 and 100'); return n; },
  job_number_prefix: (v) => { const s = String(v ?? '').trim(); if (!/^[A-Za-z0-9-_/]{1,10}$/.test(s)) throw bad('Job prefix: up to 10 letters, numbers or - _ /'); return s; },
  timezone: (v) => { const s = String(v ?? ''); try { new Intl.DateTimeFormat('en', { timeZone: s }); } catch { throw bad('Unknown timezone'); } return s; },
  expiry_warning_days: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 365) throw bad('Expiry warning must be 0–365 days'); return n; },
  pod_reminder_hours: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 720) throw bad('POD reminder must be 1–720 hours'); return n; },
};
export async function getSettings(actor: Actor) {
  requirePerm(actor, 'settings.manage');
  const rows = await q('select key, value from settings where key = any($1)', [Object.keys(SETTINGS)]);
  const statuses = await q('select code, name, color, stage, sort_order, is_system, is_active from job_statuses order by sort_order');
  const transitions = await q('select from_code, to_code from status_transitions');
  return { settings: Object.fromEntries(rows.map((r) => [r.key, r.value])), statuses, transitions };
}
export async function saveSettings(actor: Actor, b: any) {
  requirePerm(actor, 'settings.manage');
  const vals = Object.entries(b ?? {}).filter(([k]) => SETTINGS[k]).map(([k, v]) => [k, SETTINGS[k](v)] as const);
  await tx(async (c) => {
    for (const [k, v] of vals) {
      const old = await one('select value from settings where key = $1', [k], c);
      if (JSON.stringify(old?.value) === JSON.stringify(v)) continue;
      await c.query(`insert into settings (key, value, updated_by, updated_at) values ($1, $2, $3, now())
        on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`, [k, JSON.stringify(v), actor.id]);
      await audit(c, actor, { entity_type: 'setting', entity_id: k, action: 'Setting changed', field: k, old_value: old?.value, new_value: v, sensitivity: 'admin' });
    }
  });
  return getSettings(actor);
}

/** Rename/recolour/enable statuses, or add a custom one between two existing steps. */
export async function saveStatus(actor: Actor, b: any) {
  requirePerm(actor, 'settings.manage');
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 40) throw bad('Status name is required (max 40 characters)');
  const color = String(b.color ?? '#6B7280');
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw bad('Colour must look like #2B6CB0');
  await tx(async (c) => {
    if (b.code && await one('select 1 from job_statuses where code = $1', [b.code], c)) {
      const cur = await one('select * from job_statuses where code = $1', [b.code], c);
      const active = b.is_active === undefined ? cur.is_active : Boolean(b.is_active);
      if (cur.is_system && !active) throw bad('Built-in statuses can be renamed but not switched off');
      await c.query('update job_statuses set name = $2, color = $3, is_active = $4 where code = $1', [b.code, name, color, active]);
      await audit(c, actor, { entity_type: 'status', entity_id: b.code, action: 'Status edited', old_value: `${cur.name} ${cur.color}${cur.is_active ? '' : ' (off)'}`, new_value: `${name} ${color}${active ? '' : ' (off)'}`, sensitivity: 'admin' });
      return;
    }
    const after = await one('select * from job_statuses where code = $1', [b.after], c);
    const before = await one('select * from job_statuses where code = $1', [b.before], c);
    if (!after || !before) throw bad('Choose which status it comes after and before');
    if (before.sort_order <= after.sort_order) throw bad('"Before" must come later in the flow than "after"');
    const code = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'custom';
    if (await one('select 1 from job_statuses where code = $1', [code], c)) throw new ApiError(409, 'DUPLICATE', 'A status with this name already exists');
    const order = Math.floor((after.sort_order + before.sort_order) / 2);
    if (order === after.sort_order) throw bad('No room between those two statuses; choose steps further apart');
    await c.query(`insert into job_statuses (code, name, sort_order, color, stage) values ($1,$2,$3,$4,$5)`, [code, name, order, color, after.stage === 'draft' ? 'open' : after.stage]);
    await c.query('insert into status_transitions (from_code, to_code) values ($1,$2),($2,$3),($2,$4) on conflict do nothing', [after.code, code, before.code, 'cancelled']);
    await audit(c, actor, { entity_type: 'status', entity_id: code, action: 'Status added', new_value: `${name} (after ${after.name}, before ${before.name})`, sensitivity: 'admin' });
  });
  return getSettings(actor);
}
