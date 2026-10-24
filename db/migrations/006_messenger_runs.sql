-- =====================================================================
-- TMS 006 — Messengers: document runs.
-- Run once in Supabase SQL Editor BEFORE uploading the new code. Safe to run twice.
--
-- Operations requests a run (collect / deliver / submit documents), the Messenger
-- Manager assigns a messenger, the messenger marks it collected and delivered
-- (with a photo of the receipt). Runs are kept separate from truck jobs.
-- =====================================================================

create sequence if not exists messenger_run_seq start 1001;

create table if not exists messenger_runs (
  id uuid primary key default gen_random_uuid(),
  run_number text not null unique,
  department_id uuid references departments(id),
  requested_by uuid not null references users(id),
  status text not null default 'pending'
    check (status in ('pending','assigned','collected','delivered','failed','cancelled')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  task_type text not null default 'collect_deliver'
    check (task_type in ('collect','deliver','collect_deliver','submit','other')),
  required_date date not null,
  slot_from time,
  slot_to time,
  from_name text not null,
  from_address text,
  from_contact_person text,
  from_contact_number text,
  to_name text,
  to_address text,
  to_contact_person text,
  to_contact_number text,
  documents text not null,                 -- what to carry, e.g. "Original BL x3, Delivery Order"
  reference text,                          -- BL / BOE / DO number
  customer_id uuid references customers(id),
  job_id uuid references transport_requests(id),   -- optional link to a truck job
  instructions text,
  messenger_id uuid references users(id),
  assigned_by uuid references users(id),
  assigned_at timestamptz,
  planned_at timestamptz,
  collected_at timestamptz,
  delivered_at timestamptz,
  received_by text,
  fail_reason text,
  cancel_reason text,
  cancelled_at timestamptz,
  search_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint run_slot_order check (slot_from is null or slot_to is null or slot_to > slot_from)
);
create index if not exists mr_status_idx on messenger_runs (status) where deleted_at is null;
create index if not exists mr_date_idx on messenger_runs (required_date desc);
create index if not exists mr_dept_idx on messenger_runs (department_id) where deleted_at is null;
create index if not exists mr_messenger_idx on messenger_runs (messenger_id, required_date) where deleted_at is null;
create index if not exists mr_search_trgm on messenger_runs using gin (search_text gin_trgm_ops);

create table if not exists messenger_run_files (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references messenger_runs(id),
  kind text not null default 'proof' check (kind in ('proof','document')),
  file_name text not null,
  storage_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null,
  storage_driver text not null default 'supabase',
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists mrf_run_idx on messenger_run_files (run_id);

create table if not exists messenger_run_notes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references messenger_runs(id),
  user_id uuid not null references users(id),
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists mrn_run_idx on messenger_run_notes (run_id, created_at);

-- Notifications can point at a run as well as a job
alter table notifications add column if not exists run_id uuid references messenger_runs(id);

-- Keep the search text up to date
create or replace function refresh_run_search(p_run uuid) returns void language sql as $$
  update messenger_runs m set search_text = lower(concat_ws(' ',
    m.run_number, m.reference, m.documents, m.from_name, m.from_address, m.to_name, m.to_address,
    m.instructions, c.name, u.full_name, t.job_number, t.boe_number))
  from messenger_runs x
  left join customers c on c.id = x.customer_id
  left join users u on u.id = x.messenger_id
  left join transport_requests t on t.id = x.job_id
  where m.id = p_run and x.id = p_run;
$$;

-- ---------- Permissions -------------------------------------------------
insert into permissions (code, module, name, sensitivity) values
  ('runs.view_all', 'Messenger runs', 'View all messenger runs (every department)', 'general'),
  ('runs.view_department', 'Messenger runs', 'View messenger runs of own department', 'general'),
  ('runs.create', 'Messenger runs', 'Request messenger runs', 'general'),
  ('runs.cancel', 'Messenger runs', 'Cancel messenger runs', 'general'),
  ('runs.assign', 'Messenger runs', 'Assign messengers to runs', 'general'),
  ('runs.update_status', 'Messenger runs', 'Update run progress (collected, delivered, could not complete)', 'general')
on conflict (code) do nothing;

insert into role_permissions (role_id, permission_code)
  select r.id, p.code from roles r cross join permissions p where r.code = 'super_admin'
  on conflict do nothing;
insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['runs.view_all', 'runs.assign', 'runs.update_status', 'runs.cancel']) p
  where r.code = 'messenger_manager' on conflict do nothing;
insert into role_permissions (role_id, permission_code)
  select r.id, 'runs.update_status' from roles r where r.code = 'messenger' on conflict do nothing;
insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['runs.view_department', 'runs.create', 'runs.cancel']) p
  where r.code in ('operations_manager', 'operations') on conflict do nothing;

-- Lock the new tables away from Supabase's public API, like all others
alter table messenger_runs enable row level security;
alter table messenger_run_files enable row level security;
alter table messenger_run_notes enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on messenger_runs, messenger_run_files, messenger_run_notes from anon, authenticated';
    execute 'revoke all on sequence messenger_run_seq from anon, authenticated';
    execute 'revoke execute on function refresh_run_search(uuid) from anon, authenticated';
  end if;
end $$;

update users set token_version = token_version + 1
  where role_id in (select id from roles where code in ('messenger_manager', 'messenger', 'operations_manager', 'operations'));
