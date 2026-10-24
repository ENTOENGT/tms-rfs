/**
 * Users, roles and departments — for the Super Admin (everything) and for
 * department managers (their own department only).
 *
 * Rules a manager can never get around (all checked here, on the server):
 *  - sees and edits only users of their own department; never managers or Super Admins; never themselves
 *  - cannot move anyone to another department
 *  - assigns only non-manager roles meant for their side, or roles of their own department
 *  - can hand out only permissions they have themselves, never admin-type ones
 *    (so a Transport manager can't give anyone the selling price — and the database
 *     refuses it for Transport/Messenger departments anyway)
 *  - creates and edits roles for their own department only, under the same limit
 */
import { randomBytes } from 'crypto';
import { Actor, hashPassword, validatePassword } from './auth';
import { ApiError, audit, bad, forbidden, notFound, one, pool, q, tx } from './db';
import type { Side } from '../lib/permissions';

const UUID = /^[0-9a-f-]{36}$/i;
const SIDES: Side[] = ['admin', 'operations', 'transport', 'messenger', 'finance'];
export const SIDE_LABEL: Record<Side, string> = {
  admin: 'Administration', operations: 'Operations', transport: 'Transport', messenger: 'Messengers', finance: 'Finance',
};

type Scope = { all: true } | { all: false; deptId: string; deptName: string; side: Side };
function scopeFor(actor: Actor, full: 'users.manage' | 'roles.manage', dept: 'users.manage_department' | 'roles.manage_department'): Scope {
  if (actor.has(full)) return { all: true };
  if (actor.has(dept) && actor.department_id && actor.department_side)
    return { all: false, deptId: actor.department_id, deptName: actor.department_name!, side: actor.department_side };
  throw forbidden();
}
const userScope = (a: Actor) => scopeFor(a, 'users.manage', 'users.manage_department');
const roleScope = (a: Actor) => scopeFor(a, 'roles.manage', 'roles.manage_department');

/** Permissions this person may hand out to others. */
async function grantable(actor: Actor, scope: Scope) {
  const all = await q<{ code: string; module: string; name: string; sensitivity: string }>(
    'select code, module, name, sensitivity from permissions order by module, code');
  return scope.all ? all : all.filter((p) => actor.perms.has(p.code as any) && p.sensitivity !== 'admin');
}

async function assignableRoles(scope: Scope) {
  if (scope.all) return q(`select r.id, r.code, r.name, r.side, r.department_id, r.is_manager from roles r
    order by r.is_manager desc, r.name`);
  return q(`select r.id, r.code, r.name, r.side, r.department_id, r.is_manager from roles r
    where r.code <> 'super_admin' and not r.is_manager
      and (r.department_id = $1 or (r.department_id is null and r.side = $2)) order by r.name`, [scope.deptId, scope.side]);
}

async function checkRoleFits(roleId: unknown, deptId: unknown, scope: Scope, db = pool() as any) {
  if (typeof roleId !== 'string' || !UUID.test(roleId)) throw bad('Choose a role');
  const role = await one('select id, code, name, side, department_id, is_manager from roles where id = $1', [roleId], db);
  if (!role) throw bad('Choose a role');
  if (!scope.all) {
    const ok = (await assignableRoles(scope)).some((r: any) => r.id === role.id);
    if (!ok) throw forbidden(`You can't give the ${role.name} role`);
  }
  if (role.code === 'super_admin') return { role, dept: null };
  if (typeof deptId !== 'string' || !UUID.test(deptId)) throw bad('Choose a department');
  const dept = await one('select id, name, side, is_active from departments where id = $1', [deptId], db);
  if (!dept || !dept.is_active) throw bad('Choose a department');
  if (role.side && role.side !== dept.side)
    throw bad(`${role.name} is a ${SIDE_LABEL[role.side as Side]} role, but ${dept.name} is on the ${SIDE_LABEL[dept.side as Side]} side.`);
  if (role.department_id && role.department_id !== dept.id) throw bad(`${role.name} belongs to another department.`);
  return { role, dept };
}

const tempPassword = () => randomBytes(9).toString('base64url') + '7a';
async function activeSuperAdmins(excluding: string) {
  return Number((await one(`select count(*) n from users u join roles r on r.id = u.role_id
    where r.code = 'super_admin' and u.is_active and u.deleted_at is null and u.id <> $1`, [excluding]))!.n);
}

// ---------------------------------------------------------------- users
export async function listUsers(actor: Actor) {
  const scope = userScope(actor);
  const params: unknown[] = [];
  let where = 'where u.deleted_at is null';
  if (!scope.all) { params.push(scope.deptId); where += ' and u.department_id = $1'; }
  const users = await q(`select u.id, u.full_name, u.email, u.mobile, u.is_active, u.must_change_password, u.last_login_at, u.created_at,
      r.id role_id, r.code role_code, r.name role_name, r.is_manager, d.id department_id, d.name department_name, d.side department_side
    from users u join roles r on r.id = u.role_id left join departments d on d.id = u.department_id
    ${where} order by d.name nulls first, r.is_manager desc, u.full_name`, params);
  const perms = await grantable(actor, scope);
  const visible = new Set(perms.map((p) => p.code));
  const ov = await q('select user_id, permission_code, granted from user_permission_overrides where user_id = any($1)', [users.map((u) => u.id)]);
  return {
    scope: scope.all ? 'all' : 'department',
    department: scope.all ? null : { id: scope.deptId, name: scope.deptName, side: scope.side },
    users: users.map((u) => ({
      ...u,
      overrides: ov.filter((o) => o.user_id === u.id && visible.has(o.permission_code)).map((o) => ({ code: o.permission_code, granted: o.granted })),
      can_edit: scope.all ? !(u.role_code === 'super_admin' && !actor.isSuperAdmin) : (!u.is_manager && u.role_code !== 'super_admin' && u.id !== actor.id),
    })),
    roles: await assignableRoles(scope),
    departments: scope.all ? await q('select id, name, side from departments where is_active order by side, name')
      : [{ id: scope.deptId, name: scope.deptName, side: scope.side }],
    permissions: perms,
  };
}

export async function createUser(actor: Actor, b: any) {
  const scope = userScope(actor);
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address');
  const name = String(b.full_name ?? '').trim();
  if (!name) throw bad('Name is required');
  const deptId = scope.all ? b.department_id : scope.deptId;      // managers always add to their own department
  const { role, dept } = await checkRoleFits(b.role_id, deptId, scope);
  if (role.code === 'super_admin' && !actor.isSuperAdmin) throw forbidden('Only a Super Admin can create another Super Admin');
  const password = b.password ? validatePassword(b.password) : tempPassword();
  if (await one('select 1 from users where lower(email) = $1 and deleted_at is null', [email]))
    throw new ApiError(409, 'EMAIL_TAKEN', 'A user with this email already exists');
  return tx(async (c) => {
    const u = await one(`insert into users (full_name, email, mobile, password_hash, role_id, department_id, must_change_password)
        values ($1,$2,$3,$4,$5,$6,true) returning id`,
      [name, email, b.mobile || null, await hashPassword(password), role.id, dept?.id ?? (b.department_id || null)], c);
    await audit(c, actor, { entity_type: 'user', entity_id: u.id, action: 'User created',
      new_value: `${name} <${email}>, ${role.name}${dept ? ', ' + dept.name : ''}`, sensitivity: 'admin' });
    return { id: u.id, temporary_password: password };          // shown once, never logged
  });
}

async function editableUser(actor: Actor, scope: Scope, id: string, db?: any) {
  if (!UUID.test(id)) throw notFound('User');
  const cur = await one(`select u.*, r.code role_code, r.is_manager from users u join roles r on r.id = u.role_id
    where u.id = $1 and u.deleted_at is null`, [id], db);
  if (!cur) throw notFound('User');
  if (scope.all) {
    if (cur.role_code === 'super_admin' && !actor.isSuperAdmin) throw forbidden('Only a Super Admin can edit a Super Admin');
  } else {
    if (cur.department_id !== scope.deptId) throw notFound('User');                       // other departments don't exist for you
    if (cur.is_manager || cur.role_code === 'super_admin') throw forbidden('Only the Super Admin can change a manager');
    if (cur.id === actor.id) throw forbidden('Ask the Super Admin to change your own account');
  }
  return cur;
}

export async function updateUser(actor: Actor, id: string, b: any) {
  const scope = userScope(actor);
  return tx(async (c) => {
    const cur = await editableUser(actor, scope, id, c);
    const changes: [string, unknown, unknown][] = [];
    let bump = false;
    if (b.full_name !== undefined && String(b.full_name).trim() && String(b.full_name).trim() !== cur.full_name)
      changes.push(['full_name', cur.full_name, String(b.full_name).trim()]);
    if (b.mobile !== undefined && (b.mobile || null) !== cur.mobile) changes.push(['mobile', cur.mobile, b.mobile || null]);

    const newDept = b.department_id !== undefined ? (b.department_id || null) : cur.department_id;
    const newRole = b.role_id !== undefined ? b.role_id : cur.role_id;
    if (newDept !== cur.department_id && !scope.all) throw forbidden('Only the Super Admin can move someone to another department');
    if (newDept !== cur.department_id || newRole !== cur.role_id) {
      const { role } = await checkRoleFits(newRole, newDept, scope, c);
      if (role.code === 'super_admin' && !actor.isSuperAdmin) throw forbidden('Only a Super Admin can grant Super Admin');
      if (cur.role_code === 'super_admin' && role.code !== 'super_admin' && (await activeSuperAdmins(id)) === 0)
        throw new ApiError(409, 'LAST_ADMIN', 'This is the last active Super Admin. Create another one first.');
      if (newDept !== cur.department_id) changes.push(['department_id', cur.department_id, newDept]);
      if (newRole !== cur.role_id) changes.push(['role_id', cur.role_id, role.id]);
      bump = true;
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
      // A manager only touches the permissions they can hand out; anything else stays as it was.
      const mine = new Set((await grantable(actor, scope)).map((p) => p.code));
      const asked = b.overrides.filter((o: any) => typeof o?.code === 'string');
      const refused = asked.filter((o: any) => !mine.has(o.code));
      if (refused.length) throw forbidden(`You can't give or remove: ${refused.map((o: any) => o.code).join(', ')}`);
      const before = await q('select permission_code code, granted from user_permission_overrides where user_id = $1 order by 1', [id], c);
      await c.query('delete from user_permission_overrides where user_id = $1 and permission_code = any($2)', [id, [...mine]]);
      for (const o of asked)
        await c.query('insert into user_permission_overrides (user_id, permission_code, granted) values ($1,$2,$3) on conflict (user_id, permission_code) do update set granted = excluded.granted',
          [id, o.code, Boolean(o.granted)]);
      const after = await q('select permission_code code, granted from user_permission_overrides where user_id = $1 order by 1', [id], c);
      const fmt = (l: any[]) => l.map((o) => `${o.granted ? '+' : '−'}${o.code}`).sort().join(', ') || 'none';
      if (fmt(before) !== fmt(after)) { changes.push(['permission exceptions', fmt(before), fmt(after)]); bump = true; }
    }
    if (bump) await c.query('update users set token_version = token_version + 1 where id = $1', [id]);   // signs them out everywhere
    const label = async (field: string, v: unknown) => {
      if (!v) return v;
      if (field === 'role_id') return (await one('select name from roles where id = $1', [v], c))?.name;
      if (field === 'department_id') return (await one('select name from departments where id = $1', [v], c))?.name;
      return v;
    };
    for (const [field, o, nv] of changes)
      await audit(c, actor, { entity_type: 'user', entity_id: id, action: 'User updated', field: field.replace('_id', ''),
        old_value: await label(field, o), new_value: await label(field, nv), sensitivity: 'admin' });
    return { ok: true };
  });
}

export async function resetPassword(actor: Actor, id: string, b: any) {
  const scope = userScope(actor);
  await editableUser(actor, scope, id);
  const password = b?.password ? validatePassword(b.password) : tempPassword();
  await tx(async (c) => {
    await c.query(`update users set password_hash = $2, must_change_password = true, token_version = token_version + 1,
        failed_logins = 0, locked_until = null, updated_at = now() where id = $1`, [id, await hashPassword(password)]);
    await audit(c, actor, { entity_type: 'user', entity_id: id, action: 'Password reset', sensitivity: 'admin' });
  });
  return { temporary_password: password };
}

// ---------------------------------------------------------------- roles
export async function listRoles(actor: Actor) {
  const scope = roleScope(actor);
  const params: unknown[] = [];
  let where = '';
  if (!scope.all) {
    params.push(scope.deptId, scope.side);
    where = `where r.code <> 'super_admin' and not r.is_manager and (r.department_id = $1 or (r.department_id is null and r.side = $2))`;
  }
  const roles = await q(`select r.id, r.code, r.name, r.description, r.is_system, r.is_manager, r.side, r.department_id, d.name department_name,
      (select count(*)::int from users u where u.role_id = r.id and u.deleted_at is null ${scope.all ? '' : 'and u.department_id = $1'}) user_count,
      coalesce(array_agg(rp.permission_code) filter (where rp.permission_code is not null), '{}') permissions
    from roles r left join role_permissions rp on rp.role_id = r.id left join departments d on d.id = r.department_id
    ${where} group by r.id, d.name order by r.side nulls last, r.is_manager desc, r.is_system desc, r.name`, params);
  const perms = await grantable(actor, scope);
  const shown = new Set(perms.map((p) => p.code));
  return {
    scope: scope.all ? 'all' : 'department',
    department: scope.all ? null : { id: scope.deptId, name: scope.deptName, side: scope.side },
    roles: roles.map((r) => ({ ...r, permissions: r.permissions.filter((p: string) => shown.has(p)),
      editable: r.code !== 'super_admin' && (scope.all || r.department_id === scope.deptId) })),
    permissions: perms,
  };
}

export async function createRole(actor: Actor, b: any) {
  const scope = roleScope(actor);
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 60) throw bad('Role name is required (max 60 characters)');
  let side: Side | null = null, deptId: string | null = null, prefix = '';
  if (scope.all) {
    if (b.side) { if (!SIDES.includes(b.side)) throw bad('Choose a side'); side = b.side; }
  } else {
    side = scope.side; deptId = scope.deptId;
    prefix = ((await one('select code from departments where id = $1', [deptId]))!.code) + '_';
  }
  const code = prefix + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (await one('select 1 from roles where code = $1', [code])) throw new ApiError(409, 'ROLE_EXISTS', 'A role with this name already exists');
  const r = await one('insert into roles (code, name, description, side, department_id) values ($1,$2,$3,$4,$5) returning id',
    [code, name, b.description || null, side, deptId]);
  await audit(pool(), actor, { entity_type: 'role', entity_id: r.id, action: 'Role created',
    new_value: name + (scope.all ? '' : ` (${scope.deptName})`), sensitivity: 'admin' });
  return r;
}

export async function setRolePermissions(actor: Actor, roleId: string, codes: unknown) {
  const scope = roleScope(actor);
  if (!Array.isArray(codes)) throw bad('permissions must be a list');
  if (!UUID.test(roleId)) throw notFound('Role');
  const role = await one('select r.id, r.code, r.name, r.side, r.department_id from roles r where r.id = $1', [roleId]);
  if (!role) throw notFound('Role');
  if (role.code === 'super_admin') throw new ApiError(409, 'LOCKED_ROLE', 'Super Admin always has every permission');
  if (!scope.all && role.department_id !== scope.deptId) throw forbidden('You can only change roles of your own department');
  const perms = await grantable(actor, scope);
  const mine = new Set(perms.map((p) => p.code));
  const asked = [...new Set(codes.filter((x): x is string => typeof x === 'string'))];
  const refused = asked.filter((x) => !mine.has(x));
  if (refused.length) throw forbidden(`You can't give: ${refused.join(', ')}`);
  if (['transport', 'messenger'].includes(role.side)) {
    const commercial = new Set(perms.filter((p) => p.sensitivity === 'commercial').map((p) => p.code));
    if (asked.some((x) => commercial.has(x)))
      throw bad('Selling price, revenue, profit and customer documents can never be given to a Transport or Messenger role.');
  }
  await tx(async (c) => {
    const before = (await q('select permission_code c from role_permissions where role_id = $1 order by 1', [roleId], c)).map((r) => r.c);
    // Only the permissions this person controls are replaced; others on the role are kept.
    await c.query('delete from role_permissions where role_id = $1 and permission_code = any($2)', [roleId, [...mine]]);
    for (const p of asked) await c.query('insert into role_permissions (role_id, permission_code) values ($1,$2) on conflict do nothing', [roleId, p]);
    const after = (await q('select permission_code c from role_permissions where role_id = $1 order by 1', [roleId], c)).map((r) => r.c);
    const added = after.filter((p) => !before.includes(p)), removed = before.filter((p) => !after.includes(p));
    if (added.length || removed.length) {
      await c.query('update users set token_version = token_version + 1 where role_id = $1', [roleId]);
      await audit(c, actor, { entity_type: 'role', entity_id: roleId, action: 'Role permissions changed', field: role.name,
        old_value: removed.length ? `removed: ${removed.join(', ')}` : null, new_value: added.length ? `added: ${added.join(', ')}` : null, sensitivity: 'admin' });
    }
  });
  return { ok: true };
}

// ---------------------------------------------------------------- departments (Super Admin)
export async function listDepartments(actor: Actor) {
  if (!actor.has('settings.manage')) throw forbidden();
  return q(`select d.id, d.code, d.name, d.side, d.is_active,
      (select count(*)::int from users u where u.department_id = d.id and u.deleted_at is null and u.is_active) users
    from departments d order by d.side, d.name`);
}

export async function saveDepartment(actor: Actor, b: any) {
  if (!actor.has('settings.manage')) throw forbidden();
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 60) throw bad('Department name is required');
  await tx(async (c) => {
    if (b.id) {
      if (!UUID.test(b.id)) throw notFound('Department');
      const cur = await one('select * from departments where id = $1', [b.id], c);
      if (!cur) throw notFound('Department');
      const active = b.is_active === undefined ? cur.is_active : Boolean(b.is_active);
      const users = Number((await one('select count(*) n from users where department_id = $1 and deleted_at is null and is_active', [b.id], c))!.n);
      if (b.side && b.side !== cur.side && users) throw bad(`Move this department's ${users} user(s) out before changing its side.`);
      if (!active && cur.is_active && users) throw bad(`Move or disable this department's ${users} user(s) before switching it off.`);
      if (cur.code === 'admin' && !active) throw bad('The Administration department is needed for the Super Admin');
      const side = b.side && SIDES.includes(b.side) ? b.side : cur.side;
      await c.query('update departments set name = $2, side = $3, is_active = $4 where id = $1', [b.id, name, side, active]);
      await audit(c, actor, { entity_type: 'department', entity_id: b.id, action: 'Department changed',
        old_value: `${cur.name}, ${cur.side}${cur.is_active ? '' : ', off'}`, new_value: `${name}, ${side}${active ? '' : ', off'}`, sensitivity: 'admin' });
    } else {
      if (!SIDES.includes(b.side) || b.side === 'admin') throw bad('Choose which side the department is on');
      const code = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
      if (await one('select 1 from departments where code = $1 or lower(name) = lower($2)', [code, name], c))
        throw new ApiError(409, 'DUPLICATE', 'A department with this name already exists');
      const d = await one('insert into departments (code, name, side) values ($1,$2,$3) returning id', [code, name, b.side], c);
      await audit(c, actor, { entity_type: 'department', entity_id: d.id, action: 'Department added', new_value: `${name}, ${b.side}`, sensitivity: 'admin' });
    }
  });
  return listDepartments(actor);
}
