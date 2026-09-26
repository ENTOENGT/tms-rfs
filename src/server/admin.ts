import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { Actor, hashPassword, requirePerm, validatePassword } from './auth';
import { ApiError, audit, bad, getSetting, notFound, one, q, tx } from './db';

const USER_FIELDS = `u.id, u.full_name, u.email, u.mobile, u.is_active, u.must_change_password, u.last_login_at,
  u.created_at, r.id role_id, r.code role_code, r.name role_name, d.id department_id, d.name department_name`;

export async function listUsers(actor: Actor) {
  requirePerm(actor, 'users.manage');
  const users = await q(`select ${USER_FIELDS} from users u join roles r on r.id = u.role_id
      left join departments d on d.id = u.department_id where u.deleted_at is null order by u.full_name`);
  const ov = await q('select user_id, permission_code, granted from user_permission_overrides');
  return users.map((u) => ({ ...u, overrides: ov.filter((o) => o.user_id === u.id)
    .map((o) => ({ code: o.permission_code, granted: o.granted })) }));
}

const tempPassword = () => randomBytes(9).toString('base64url') + '7a';

async function activeSuperAdmins(excluding: string) {
  return Number((await one(`select count(*) n from users u join roles r on r.id = u.role_id
    where r.code = 'super_admin' and u.is_active and u.deleted_at is null and u.id <> $1`, [excluding]))!.n);
}

export async function createUser(actor: Actor, b: any) {
  requirePerm(actor, 'users.manage');
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address');
  const name = String(b.full_name ?? '').trim();
  if (!name) throw bad('Name is required');
  const role = await one('select id, code from roles where id = $1', [b.role_id]);
  if (!role) throw bad('Choose a role');
  if (role.code === 'super_admin' && !actor.isSuperAdmin) throw new ApiError(403, 'FORBIDDEN', 'Only a Super Admin can create another Super Admin');
  const password = b.password ? validatePassword(b.password) : tempPassword();
  if (await one('select 1 from users where lower(email) = $1 and deleted_at is null', [email]))
    throw new ApiError(409, 'EMAIL_TAKEN', 'A user with this email already exists');
  return tx(async (c) => {
    const u = await one(`insert into users (full_name, email, mobile, password_hash, role_id, department_id, must_change_password)
        values ($1,$2,$3,$4,$5,$6,true) returning id`,
      [name, email, b.mobile || null, await hashPassword(password), role.id, b.department_id || null], c);
    await audit(c, actor, { entity_type: 'user', entity_id: u.id, action: 'User created', new_value: `${name} <${email}>`, sensitivity: 'admin' });
    // The temporary password is returned once so the admin can pass it on. It is never logged.
    return { id: u.id, temporary_password: password };
  });
}

export async function updateUser(actor: Actor, id: string, b: any) {
  requirePerm(actor, 'users.manage');
  const cur = await one(`select u.*, r.code role_code from users u join roles r on r.id = u.role_id
    where u.id = $1 and u.deleted_at is null`, [id]);
  if (!cur) throw notFound('User');
  if (cur.role_code === 'super_admin' && !actor.isSuperAdmin) throw new ApiError(403, 'FORBIDDEN', 'Only a Super Admin can edit a Super Admin');
  return tx(async (c) => {
    const changes: [string, unknown, unknown][] = [];
    let bump = false;
    if (b.full_name !== undefined && String(b.full_name).trim() !== cur.full_name) changes.push(['full_name', cur.full_name, String(b.full_name).trim()]);
    if (b.mobile !== undefined && (b.mobile || null) !== cur.mobile) changes.push(['mobile', cur.mobile, b.mobile || null]);
    if (b.department_id !== undefined && (b.department_id || null) !== cur.department_id) changes.push(['department_id', cur.department_id, b.department_id || null]);
    if (b.role_id !== undefined && b.role_id !== cur.role_id) {
      const role = await one('select id, code from roles where id = $1', [b.role_id], c);
      if (!role) throw bad('Role not found');
      if (role.code === 'super_admin' && !actor.isSuperAdmin) throw new ApiError(403, 'FORBIDDEN', 'Only a Super Admin can grant Super Admin');
      if (cur.role_code === 'super_admin' && (await activeSuperAdmins(id)) === 0)
        throw new ApiError(409, 'LAST_ADMIN', 'This is the last active Super Admin. Create another one first.');
      changes.push(['role_id', cur.role_id, role.id]); bump = true;
    }
    if (b.is_active !== undefined && Boolean(b.is_active) !== cur.is_active) {
      if (id === actor.id && !b.is_active) throw new ApiError(409, 'SELF_DISABLE', 'You cannot disable your own account');
      if (!b.is_active && cur.role_code === 'super_admin' && (await activeSuperAdmins(id)) === 0)
        throw new ApiError(409, 'LAST_ADMIN', 'This is the last active Super Admin');
      changes.push(['is_active', cur.is_active, Boolean(b.is_active)]); bump = true;
    }
    for (const [field, , val] of changes)
      await c.query(`update users set ${field} = $2, updated_at = now() where id = $1`, [id, val]);
    if (Array.isArray(b.overrides)) {
      const valid = new Set((await q('select code from permissions', [], c)).map((r) => r.code));
      const next = b.overrides.filter((o: any) => valid.has(o.code));
      const before = await q('select permission_code code, granted from user_permission_overrides where user_id = $1 order by 1', [id], c);
      await c.query('delete from user_permission_overrides where user_id = $1', [id]);
      for (const o of next)
        await c.query('insert into user_permission_overrides (user_id, permission_code, granted) values ($1,$2,$3)', [id, o.code, Boolean(o.granted)]);
      const fmt = (l: any[]) => l.map((o) => `${o.granted ? '+' : '−'}${o.code}`).sort().join(', ') || 'none';
      if (fmt(before) !== fmt(next)) { changes.push(['permission overrides', fmt(before), fmt(next)]); bump = true; }
    }
    if (bump) await c.query('update users set token_version = token_version + 1 where id = $1', [id]);
    for (const [field, o, nv] of changes)
      await audit(c, actor, { entity_type: 'user', entity_id: id, action: 'User updated', field, old_value: o, new_value: nv, sensitivity: 'admin' });
    return { ok: true };
  });
}

export async function resetPassword(actor: Actor, id: string, b: any) {
  requirePerm(actor, 'users.manage');
  const u = await one(`select u.id, r.code role_code from users u join roles r on r.id = u.role_id where u.id = $1 and u.deleted_at is null`, [id]);
  if (!u) throw notFound('User');
  if (u.role_code === 'super_admin' && !actor.isSuperAdmin) throw new ApiError(403, 'FORBIDDEN', 'Only a Super Admin can reset a Super Admin');
  const password = b?.password ? validatePassword(b.password) : tempPassword();
  await tx(async (c) => {
    await c.query(`update users set password_hash = $2, must_change_password = true, token_version = token_version + 1,
        failed_logins = 0, locked_until = null, updated_at = now() where id = $1`, [id, await hashPassword(password)]);
    await audit(c, actor, { entity_type: 'user', entity_id: id, action: 'Password reset', sensitivity: 'admin' });
  });
  return { temporary_password: password };
}

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

// ---------------------------------------------------------------- roles
export async function listRoles(actor: Actor) {
  requirePerm(actor, 'roles.manage', 'users.manage');
  const roles = await q(`select r.id, r.code, r.name, r.description, r.is_system,
      (select count(*)::int from users u where u.role_id = r.id and u.deleted_at is null) user_count,
      coalesce(array_agg(rp.permission_code) filter (where rp.permission_code is not null), '{}') permissions
    from roles r left join role_permissions rp on rp.role_id = r.id group by r.id order by r.is_system desc, r.name`);
  const permissions = await q('select code, module, name, sensitivity from permissions order by module, code');
  return { roles, permissions };
}

export async function createRole(actor: Actor, b: any) {
  requirePerm(actor, 'roles.manage');
  const name = String(b.name ?? '').trim();
  if (!name) throw bad('Role name is required');
  const code = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (await one('select 1 from roles where code = $1', [code])) throw new ApiError(409, 'ROLE_EXISTS', 'A role with this name already exists');
  const r = await one('insert into roles (code, name, description) values ($1,$2,$3) returning id', [code, name, b.description || null]);
  await audit((await import('./db')).pool(), actor, { entity_type: 'role', entity_id: r.id, action: 'Role created', new_value: name, sensitivity: 'admin' });
  return r;
}

export async function setRolePermissions(actor: Actor, roleId: string, codes: unknown) {
  requirePerm(actor, 'roles.manage');
  if (!Array.isArray(codes)) throw bad('permissions must be a list');
  const role = await one('select id, code, name from roles where id = $1', [roleId]);
  if (!role) throw notFound('Role');
  if (role.code === 'super_admin') throw new ApiError(409, 'LOCKED_ROLE', 'Super Admin always has every permission');
  await tx(async (c) => {
    const valid = new Set((await q('select code from permissions', [], c)).map((r) => r.code));
    const next = [...new Set(codes.filter((x): x is string => typeof x === 'string' && valid.has(x)))].sort();
    const before = (await q('select permission_code c from role_permissions where role_id = $1 order by 1', [roleId], c)).map((r) => r.c);
    await c.query('delete from role_permissions where role_id = $1', [roleId]);
    for (const p of next) await c.query('insert into role_permissions (role_id, permission_code) values ($1,$2)', [roleId, p]);
    const added = next.filter((p) => !before.includes(p)), removed = before.filter((p) => !next.includes(p));
    if (added.length || removed.length) {
      await c.query('update users set token_version = token_version + 1 where role_id = $1', [roleId]);
      await audit(c, actor, { entity_type: 'role', entity_id: roleId, action: 'Role permissions changed', field: role.name,
        old_value: removed.length ? `removed: ${removed.join(', ')}` : null, new_value: added.length ? `added: ${added.join(', ')}` : null, sensitivity: 'admin' });
    }
  });
  return { ok: true };
}

// ---------------------------------------------------------------- lookups
export async function lookups(actor: Actor) {
  const out: Record<string, unknown> = {
    customers: await q('select id, name from customers where is_active and deleted_at is null order by name'),
    locations: await q('select id, name, address, emirate, contact_person, contact_number from locations where is_active and deleted_at is null order by name'),
    vehicle_types: await q('select id, name from vehicle_types where is_active order by sort_order'),
    job_statuses: await q('select code, name, color, stage from job_statuses where is_active order by sort_order'),
    pod_statuses: await q('select code, name from pod_statuses where is_active order by sort_order'),
    departments: await q('select id, code, name from departments where is_active order by name'),
    drivers: await q(`select id, full_name name, mobile from drivers where deleted_at is null and status <> 'inactive' order by full_name`),
    vehicles: await q(`select v.id, v.vehicle_number name, vt.name vehicle_type from vehicles v left join vehicle_types vt on vt.id = v.vehicle_type_id
      where v.deleted_at is null and v.status <> 'inactive' order by v.vehicle_number`),
    expiry_warning_days: await getSetting('expiry_warning_days', 30),
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
  if (actor.has('users.manage')) out.roles = await q('select id, code, name from roles order by name');
  return out;
}

export async function listNotifications(actor: Actor) {
  try { const { runPodReminders } = await import('./documents'); await runPodReminders(); } catch (e) { console.error('POD reminders', e); }
  const rows = await q(`select id, type, title, job_id, read_at, created_at from notifications
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
