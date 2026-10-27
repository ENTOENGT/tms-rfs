import bcrypt from 'bcryptjs';
import { Actor, hashPassword, requirePerm, validatePassword } from './auth';
import { ApiError, audit, bad, getSetting, notFound, one, q, tx } from './db';

// User, role and department management lives in team.ts (Super Admin + department managers).
export { listUsers, createUser, updateUser, resetPassword, listRoles, createRole, setRolePermissions, listDepartments, saveDepartment } from './team';

export async function changeOwnPassword(actor: Actor, b: any) {
  const u = await one('select password_hash from users where id = $1', [actor.id]);
  if (!u || !(await bcrypt.compare(String(b.current_password ?? ''), u.password_hash)))
    throw new ApiError(400, 'WRONG_PASSWORD', 'Current password is incorrect');
  const pw = validatePassword(b.new_password);
  if (pw === b.current_password) throw bad('Choose a different password from the current one');
  const r = await one(`update users set password_hash = $2, must_change_password = false, token_version = token_version + 1
      where id = $1 returning token_version`, [actor.id, await hashPassword(pw)]);
  await audit((await import('./db')).pool(), actor, { entity_type: 'user', entity_id: actor.id, action: 'Password changed', sensitivity: 'admin' });
  return r!.token_version as number;
}

// ---------------------------------------------------------------- lookups
export async function lookups(actor: Actor) {
  // Phone-app people get only what their screens use — not the customer, staff and fleet lists.
  if (actor.app_only) return {
    customers: [], locations: [], vehicle_types: [], drivers: [], vehicles: [], users: [],
    job_statuses: await q('select code, name, color, stage from job_statuses where is_active order by sort_order'),
    pod_statuses: await q('select code, name from pod_statuses where is_active order by sort_order'),
    departments: [], my_department: actor.department_id ? { id: actor.department_id, name: actor.department_name, side: actor.department_side } : null,
    document_types: await q(`select code, name from document_types where is_active and code = 'pod'`),
    expiry_warning_days: 30, currency: await getSetting('currency', 'AED'), timezone: await getSetting('timezone', 'Asia/Dubai'),
  };
  const out: Record<string, unknown> = {
    customers: await q('select id, name from customers where is_active and deleted_at is null order by name'),
    locations: await q('select id, name, address, emirate, contact_person, contact_number from locations where is_active and deleted_at is null order by name'),
    vehicle_types: await q('select id, name from vehicle_types where is_active order by sort_order'),
    job_statuses: await q('select code, name, color, stage from job_statuses where is_active order by sort_order'),
    pod_statuses: await q('select code, name from pod_statuses where is_active order by sort_order'),
    departments: await q('select id, code, name, side from departments where is_active order by side, name'),
    my_department: actor.department_id ? { id: actor.department_id, name: actor.department_name, side: actor.department_side } : null,
    drivers: await q(`select id, full_name name, mobile from drivers where deleted_at is null and status <> 'inactive' order by full_name`),
    vehicles: await q(`select v.id, v.vehicle_number name, vt.name vehicle_type from vehicles v left join vehicle_types vt on vt.id = v.vehicle_type_id
      where v.deleted_at is null and v.status <> 'inactive' order by v.vehicle_number`),
    expiry_warning_days: await getSetting('expiry_warning_days', 30),
    users: await q(`select u.id, u.full_name name, d.code department from users u left join departments d on d.id = u.department_id
      where u.deleted_at is null order by u.full_name`),
    document_types: await q('select code, name from document_types where is_active and ($1 or not is_commercial) order by name',
      [actor.fin.sellingView && actor.has('documents.view_commercial')]),
    currency: await getSetting('currency', 'AED'),
    timezone: await getSetting('timezone', 'Asia/Dubai'),
  };
  if (actor.fin.buyingView) out.expense_types = await q('select code, name from expense_types where is_active order by sort_order');
  if (actor.fin.sellingView) {
    out.revenue_types = await q('select code, name from revenue_types where is_active order by sort_order');
    out.vat_rate = await getSetting('vat_rate', 5);
  }
  return out;
}

export async function listNotifications(actor: Actor) {
  try { const { runPodReminders } = await import('./documents'); await runPodReminders(); } catch (e) { console.error('POD reminders', e); }
  try { const { maybeRunDocumentCleanup } = await import('./documents'); await maybeRunDocumentCleanup(); } catch (e) { console.error('Document clean-up', e); }
  try { const { runProReminders } = await import('./pro'); await runProReminders(); } catch (e) { console.error('PRO reminders', e); }
  const rows = await q(`select id, type, title, job_id, run_id, pro_id, read_at, created_at from notifications
    where user_id = $1 order by created_at desc limit 50`, [actor.id]);
  return { unread: rows.filter((r) => !r.read_at).length, rows };
}
export async function markNotificationsRead(actor: Actor, ids?: string[]) {
  await q(`update notifications set read_at = now() where user_id = $1 and read_at is null
    and ($2::uuid[] is null or id = any($2))`, [actor.id, ids?.length ? ids : null]);
  return { ok: true };
}

export async function createCustomer(actor: Actor, b: any) {
  requirePerm(actor, 'customers.manage');
  const name = String(b.name ?? '').trim();
  if (!name) throw bad('Customer name is required');
  const dup = await one('select id from customers where lower(name) = lower($1) and deleted_at is null', [name]);
  if (dup) throw new ApiError(409, 'CUSTOMER_EXISTS', 'A customer with this name already exists', { id: dup.id });
  const c = await one(`insert into customers (name, contact_person, contact_number, email) values ($1,$2,$3,$4) returning id, name`,
    [name, b.contact_person || null, b.contact_number || null, b.email || null]);
  await audit((await import('./db')).pool(), actor, { entity_type: 'customer', entity_id: c.id, action: 'Customer created', new_value: name });
  return c;
}
