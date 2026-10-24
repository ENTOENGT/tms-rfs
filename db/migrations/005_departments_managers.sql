-- =====================================================================
-- TMS 005 — Departments, department managers, department-only visibility.
-- Run once in Supabase SQL Editor BEFORE uploading the new code.
-- Safe to run twice.
--
-- Structure (Reliance Freight Systems):
--   Super Admin  → creates every department manager, sees everything
--   Transport side   → Transport Manager, sub-users (drivers get the phone app later)
--   Operations side  → E-Com, Sea-Import, Sea-Export, Air-Import, Air-Export,
--                      Documentations, Commercial — each with a Manager and sub-users
--   Messengers side  → Messenger Manager, messengers (phone app later)
-- Managers create their own sub-users and roles, inside their own department only.
-- =====================================================================

-- ---------- Departments belong to a "side" --------------------------
alter table departments add column if not exists side text;
update departments set side = case code
    when 'admin' then 'admin' when 'operations' then 'operations'
    when 'transport' then 'transport' when 'finance' then 'finance' else 'operations' end
  where side is null;
alter table departments alter column side set not null;
alter table departments drop constraint if exists departments_side_chk;
alter table departments add constraint departments_side_chk
  check (side in ('admin','operations','transport','messenger','finance'));

update departments set name = 'Operations (general)' where code = 'operations' and name = 'Operations';
insert into departments (code, name, side) values
  ('ecom', 'E-Com', 'operations'), ('sea_import', 'Sea-Import', 'operations'),
  ('sea_export', 'Sea-Export', 'operations'), ('air_import', 'Air-Import', 'operations'),
  ('air_export', 'Air-Export', 'operations'), ('documentations', 'Documentations', 'operations'),
  ('commercial', 'Commercial', 'operations'), ('messengers', 'Messengers', 'messenger')
on conflict (code) do nothing;

-- ---------- Roles: which side they are for, and department-own roles ---
alter table roles add column if not exists side text;
alter table roles add column if not exists department_id uuid references departments(id);
alter table roles add column if not exists is_manager boolean not null default false;
alter table roles drop constraint if exists roles_side_chk;
alter table roles add constraint roles_side_chk
  check (side is null or side in ('admin','operations','transport','messenger','finance'));
update roles set side = case code
    when 'super_admin' then 'admin' when 'operations' then 'operations'
    when 'transport' then 'transport' when 'finance' then 'finance' end
  where side is null and is_system;
update roles set name = 'Operations Sub-user', description = 'Default role for operations staff. Sees own department only.'
  where code = 'operations' and name = 'Operations User';
update roles set name = 'Transport Sub-user' where code = 'transport' and name = 'Transport User';

insert into roles (code, name, description, is_system, side, is_manager) values
  ('operations_manager', 'Operations Manager', 'Admin of one operations department: manages its users and roles', true, 'operations', true),
  ('transport_manager', 'Transport Manager', 'Admin of the transport side: manages its users and roles', true, 'transport', true),
  ('messenger_manager', 'Messenger Manager', 'Admin of the messengers side: manages its users and roles', true, 'messenger', true),
  ('messenger', 'Messenger', 'Carries documents. Uses the phone app (coming next).', true, 'messenger', false)
on conflict (code) do nothing;

-- ---------- New permissions --------------------------------------------
insert into permissions (code, module, name, sensitivity) values
  ('jobs.view_department', 'Jobs', 'View all jobs of own department', 'general'),
  ('users.manage_department', 'Administration', 'Manage users of own department', 'admin'),
  ('roles.manage_department', 'Administration', 'Manage roles of own department', 'admin')
on conflict (code) do nothing;
insert into role_permissions (role_id, permission_code)
  select r.id, p.code from roles r cross join permissions p where r.code = 'super_admin'
  on conflict do nothing;

-- ---------- Operations Manager = previous Operations role + management ----
-- (copied first, so any changes you made to the Operations role are kept)
insert into role_permissions (role_id, permission_code)
  select (select id from roles where code = 'operations_manager'), rp.permission_code
  from role_permissions rp join roles r on r.id = rp.role_id where r.code = 'operations'
  on conflict do nothing;
insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['jobs.view', 'jobs.create', 'jobs.edit', 'jobs.cancel',
    'jobs.view_department', 'users.manage_department', 'roles.manage_department',
    'finance.buying.view', 'finance.selling.view', 'finance.selling.edit', 'finance.profit.view',
    'documents.view_commercial', 'pod.verify', 'reports.view', 'reports.export']) p
  where r.code = 'operations_manager'
  on conflict do nothing;
delete from role_permissions where permission_code = 'jobs.view_all'
  and role_id = (select id from roles where code = 'operations_manager');

-- ---------- Operations Sub-user: own department, no selling price by default ----
insert into role_permissions (role_id, permission_code)
  select id, 'jobs.view_department' from roles where code = 'operations'
  on conflict do nothing;
delete from role_permissions
  where role_id = (select id from roles where code = 'operations')
    and permission_code in ('jobs.view_all', 'finance.selling.view', 'finance.selling.edit',
                            'finance.profit.view', 'documents.view_commercial');

-- ---------- Transport Manager = Transport role + management + override ----
insert into role_permissions (role_id, permission_code)
  select (select id from roles where code = 'transport_manager'), rp.permission_code
  from role_permissions rp join roles r on r.id = rp.role_id where r.code = 'transport'
  on conflict do nothing;
insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['jobs.override_conflicts', 'users.manage_department', 'roles.manage_department']) p
  where r.code = 'transport_manager'
  on conflict do nothing;

-- ---------- Messenger Manager (task permissions arrive with stage 2) ----
insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['users.manage_department', 'roles.manage_department']) p
  where r.code = 'messenger_manager'
  on conflict do nothing;

-- ---------- One place that decides "does this user have this permission" ----
-- Used by the app for every request. Two hard rules live here:
--   1. Super Admin has everything.
--   2. Selling price / revenue / profit / customer documents can NEVER reach
--      anyone in a Transport or Messenger department — whatever their role
--      or exceptions say. This protects against a mis-ticked box.
create or replace function user_has_perm(p_user uuid, p_perm text) returns boolean
language sql stable as $$
  select exists (
    select 1 from users u
      join roles r on r.id = u.role_id
      join permissions p on p.code = p_perm
      left join departments d on d.id = u.department_id
    where u.id = p_user and u.deleted_at is null
      and (
        r.code = 'super_admin'
        or (
          not (p.sensitivity = 'commercial' and coalesce(d.side, '') in ('transport', 'messenger'))
          and (
            exists (select 1 from user_permission_overrides o
                     where o.user_id = u.id and o.permission_code = p_perm and o.granted)
            or (exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_code = p_perm)
                and not exists (select 1 from user_permission_overrides o
                                 where o.user_id = u.id and o.permission_code = p_perm and not o.granted))
          )
        )
      )
  );
$$;
revoke execute on function user_has_perm(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function user_has_perm(uuid, text) from anon, authenticated';
  end if;
end $$;

-- Faster department filtering
create index if not exists tr_department_idx on transport_requests (department_id) where deleted_at is null;
create index if not exists users_department_idx on users (department_id) where deleted_at is null;

-- Everyone using a changed role must sign in again so the new access applies.
update users set token_version = token_version + 1
  where role_id in (select id from roles where code in ('operations', 'transport'));
