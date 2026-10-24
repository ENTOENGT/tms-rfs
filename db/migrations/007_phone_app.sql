-- 007 — Phone app for drivers and messengers
-- * Driver role: sees ONLY the jobs assigned to them, moves them along
--   (start trip → picked up → delivered) and uploads the POD photo.
-- * "App link": a one-time link a manager sends by WhatsApp. The person opens it
--   on their phone, chooses a password, and adds the app to the home screen.
-- Safe to run more than once.

-- ---------- roles used only from the phone ----------------------------------
alter table roles add column if not exists app_only boolean not null default false;

insert into roles (code, name, description, is_system, side, is_manager, app_only) values
  ('driver', 'Driver', 'Drives the truck. Uses the phone app: sees only own jobs, updates status, uploads POD.', true, 'transport', false, true)
on conflict (code) do nothing;
update roles set app_only = true where code in ('driver', 'messenger');
update roles set description = 'Carries documents. Uses the phone app.' where code = 'messenger';

insert into permissions (code, module, name, sensitivity) values
  ('jobs.view_assigned', 'Jobs', 'View jobs assigned to me as driver', 'general')
on conflict (code) do nothing;

insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['jobs.view_assigned', 'jobs.update_status', 'pod.upload']) p
  where r.code = 'driver'
on conflict do nothing;

-- ---------- one-time app links ----------------------------------------------
create table if not exists app_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,            -- only a hash is stored; the link itself is never saved
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists app_links_user_idx on app_links (user_id);
create index if not exists drivers_user_idx on drivers (user_id) where user_id is not null;

alter table app_links enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on app_links from anon, authenticated';
  end if;
end $$;

-- everyone signs in again so the new permission takes effect
update users set token_version = token_version + 1;
