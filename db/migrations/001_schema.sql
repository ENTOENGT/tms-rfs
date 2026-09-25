-- =====================================================================
-- TMS 001 — Core schema (all phases). Run once in Supabase SQL Editor.
-- Money: numeric(14,2), always EXCLUDING VAT unless the column says vat.
-- Confidential commercial data lives in its own tables (job_commercials,
-- job_revenue_lines) so a query that doesn't join them cannot leak them.
-- =====================================================================
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists btree_gist;

-- ---------- Organisation (future: multi-company / multi-branch) -------
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trn text,
  created_at timestamptz not null default now()
);
create table branches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  created_at timestamptz not null default now()
);
create table departments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,            -- operations | transport | finance | admin
  name text not null,
  is_active boolean not null default true
);

-- ---------- Access control -------------------------------------------
create table roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  is_system boolean not null default false,   -- system roles can't be deleted
  created_at timestamptz not null default now()
);
create table permissions (
  code text primary key,                -- e.g. finance.selling.view
  module text not null,
  name text not null,
  description text,
  sensitivity text not null default 'general'
    check (sensitivity in ('general','cost','commercial','admin'))
);
create table role_permissions (
  role_id uuid not null references roles(id) on delete cascade,
  permission_code text not null references permissions(code) on delete cascade,
  primary key (role_id, permission_code)
);
create table users (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null,
  password_hash text not null,
  mobile text,
  department_id uuid references departments(id),
  role_id uuid not null references roles(id),
  branch_id uuid references branches(id),
  is_active boolean not null default true,
  must_change_password boolean not null default true,
  token_version integer not null default 1,   -- bump = log out everywhere
  failed_logins integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index users_email_uq on users (lower(email)) where deleted_at is null;
-- Per-user exceptions on top of the role: granted=true adds, false removes.
create table user_permission_overrides (
  user_id uuid not null references users(id) on delete cascade,
  permission_code text not null references permissions(code) on delete cascade,
  granted boolean not null,
  primary key (user_id, permission_code)
);

-- ---------- Settings & configurable lists ----------------------------
create table settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create table job_statuses (
  code text primary key,
  name text not null,
  sort_order integer not null,
  color text not null default '#6B7280',
  stage text not null default 'active'
    check (stage in ('draft','open','active','delivered','closed','cancelled')),
  is_system boolean not null default false,
  is_active boolean not null default true
);
create table status_transitions (
  from_code text not null references job_statuses(code),
  to_code text not null references job_statuses(code),
  primary key (from_code, to_code)
);
create table pod_statuses (
  code text primary key,
  name text not null,
  sort_order integer not null,
  is_active boolean not null default true
);
create table vehicle_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  weight_capacity_kg numeric(10,2),
  volume_capacity_cbm numeric(10,2),
  sort_order integer not null default 0,
  is_active boolean not null default true
);
create table expense_types (       -- transport-side (cost)
  code text primary key,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true
);
create table revenue_types (       -- operations-side (selling) — CONFIDENTIAL
  code text primary key,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true
);
create table document_types (
  code text primary key,
  name text not null,
  is_commercial boolean not null default false,  -- e.g. customer invoice: hidden from transport
  is_active boolean not null default true
);

-- ---------- Masters --------------------------------------------------
create table customers (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  name text not null,
  trn text,
  contact_person text,
  contact_number text,
  email text,
  address text,
  remarks text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index customers_name_trgm on customers using gin (name gin_trgm_ops);

create table locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  emirate text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  contact_person text,
  contact_number text,
  customer_id uuid references customers(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index locations_name_trgm on locations using gin (name gin_trgm_ops);

create table subcontractors (       -- future: outsourced trucks
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_number text,
  is_active boolean not null default true
);

create table drivers (
  id uuid primary key default gen_random_uuid(),
  driver_code text unique,
  full_name text not null,
  mobile text,
  email text,
  employee_id text,
  license_number text,
  license_expiry date,
  visa_expiry date,
  status text not null default 'available'
    check (status in ('available','assigned','on_leave','off_duty','inactive')),
  subcontractor_id uuid references subcontractors(id),
  user_id uuid references users(id),        -- future driver app login
  joining_date date,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index drivers_name_trgm on drivers using gin (full_name gin_trgm_ops);

create table vehicles (
  id uuid primary key default gen_random_uuid(),
  vehicle_number text not null,
  vehicle_type_id uuid references vehicle_types(id),
  category text,
  make text, model text, year integer,
  weight_capacity_kg numeric(10,2),
  volume_capacity_cbm numeric(10,2),
  registration_expiry date,
  insurance_expiry date,
  status text not null default 'available'
    check (status in ('available','assigned','maintenance','inactive')),
  default_driver_id uuid references drivers(id),
  subcontractor_id uuid references subcontractors(id),
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index vehicles_number_uq on vehicles (upper(vehicle_number)) where deleted_at is null;

-- ---------- The job: one central record -------------------------------
create sequence job_number_seq start 1001;

create table transport_requests (
  id uuid primary key default gen_random_uuid(),
  job_number text not null unique,
  branch_id uuid references branches(id),
  status_code text not null references job_statuses(code),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  request_date date not null default current_date,
  required_date date not null,
  slot_from time,
  slot_to time,
  department_id uuid references departments(id),
  requested_by uuid not null references users(id),
  customer_id uuid not null references customers(id),
  customer_reference text,
  email_subject text,
  email_message_id text,               -- future: link to mailbox thread
  boe_number text,
  shipment_number text,
  booking_reference text,
  requested_vehicle_type_id uuid references vehicle_types(id),
  -- pickup (snapshot: editing a saved location must not rewrite history)
  pickup_location_id uuid references locations(id),
  pickup_name text not null,
  pickup_address text,
  pickup_contact_person text,
  pickup_contact_number text,
  pickup_latitude numeric(9,6),
  pickup_longitude numeric(9,6),
  -- delivery
  delivery_location_id uuid references locations(id),
  delivery_name text not null,
  delivery_address text,
  delivery_contact_person text,
  delivery_contact_number text,
  delivery_latitude numeric(9,6),
  delivery_longitude numeric(9,6),
  -- cargo
  cargo_description text,
  cargo_type text,
  packages integer check (packages is null or packages >= 0),
  weight_kg numeric(12,2) check (weight_kg is null or weight_kg >= 0),
  volume_cbm numeric(12,3) check (volume_cbm is null or volume_cbm >= 0),
  pallets integer check (pallets is null or pallets >= 0),
  temperature_requirement text,
  special_handling text,
  special_instructions text,
  -- POD
  pod_status text not null default 'pending' references pod_statuses(code),
  -- lifecycle
  cancelled_at timestamptz,
  cancel_reason text,
  completed_at timestamptz,
  search_text text not null default '',  -- denormalised, see refresh_job_search()
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint slot_order check (slot_from is null or slot_to is null or slot_to > slot_from)
);
create index tr_status_idx on transport_requests (status_code) where deleted_at is null;
create index tr_required_date_idx on transport_requests (required_date desc);
create index tr_request_date_idx on transport_requests (request_date desc);
create index tr_customer_idx on transport_requests (customer_id);
create index tr_boe_idx on transport_requests (boe_number);
create index tr_requested_by_idx on transport_requests (requested_by);
create index tr_pod_idx on transport_requests (pod_status) where deleted_at is null;
create index tr_search_trgm on transport_requests using gin (search_text gin_trgm_ops);

create table transport_assignments (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references transport_requests(id),
  is_current boolean not null default true,
  driver_id uuid references drivers(id),
  vehicle_id uuid references vehicles(id),
  vehicle_type_id uuid references vehicle_types(id),
  subcontractor_id uuid references subcontractors(id),
  planned_pickup_at timestamptz,
  planned_delivery_at timestamptz,          -- ETA
  actual_pickup_at timestamptz,
  actual_delivery_at timestamptz,
  conflict_overridden_by uuid references users(id),
  assigned_by uuid references users(id),
  assigned_at timestamptz not null default now(),
  -- occupancy window used for double-booking checks (maintained by trigger)
  busy_window tstzrange
);
create or replace function ta_set_window() returns trigger language plpgsql as $$
begin
  new.busy_window := case when new.planned_pickup_at is null then null else
    tstzrange(new.planned_pickup_at,
      greatest(coalesce(new.planned_delivery_at, new.planned_pickup_at + interval '4 hours'),
               new.planned_pickup_at + interval '1 minute'), '[)') end;
  return new;
end $$;
create trigger ta_window before insert or update on transport_assignments
  for each row execute function ta_set_window();
create unique index ta_one_current on transport_assignments (job_id) where is_current;
create index ta_driver_window on transport_assignments using gist (driver_id, busy_window) where is_current;
create index ta_vehicle_window on transport_assignments using gist (vehicle_id, busy_window) where is_current;

-- Transport-owned cost lines (buying). Amounts exclude VAT.
create table job_cost_lines (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references transport_requests(id),
  expense_type_code text not null references expense_types(code),
  amount numeric(14,2) not null check (amount >= 0),
  vat_amount numeric(14,2) not null default 0,   -- input VAT, kept out of profit
  description text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index jcl_job_idx on job_cost_lines (job_id);

-- ===== CONFIDENTIAL: never selected for users without finance.selling.view =====
create table job_commercials (
  job_id uuid primary key references transport_requests(id),
  discount numeric(14,2) not null default 0 check (discount >= 0),
  vat_rate numeric(5,2) not null,                -- snapshot at job creation
  payment_status text not null default 'unbilled'
    check (payment_status in ('unbilled','invoiced','partially_paid','paid','written_off')),
  invoice_number text,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create table job_revenue_lines (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references transport_requests(id),
  revenue_type_code text not null references revenue_types(code),
  amount numeric(14,2) not null check (amount >= 0),
  description text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index jrl_job_idx on job_revenue_lines (job_id);

create table job_documents (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references transport_requests(id),
  document_type_code text not null references document_types(code),
  file_name text not null,
  storage_path text not null,       -- Supabase Storage key (private bucket)
  mime_type text not null,
  size_bytes bigint not null,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index jd_job_idx on job_documents (job_id);

create table job_pod (
  job_id uuid primary key references transport_requests(id),
  document_id uuid references job_documents(id),
  pod_date date,
  received_by text,
  remarks text,
  verified_by uuid references users(id),
  verified_at timestamptz,
  rejection_reason text,
  updated_at timestamptz not null default now()
);

create table job_notes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references transport_requests(id),
  user_id uuid not null references users(id),
  body text not null,
  visibility text not null default 'all' check (visibility in ('all','commercial')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index jn_job_idx on job_notes (job_id, created_at);

-- ---------- Audit (append-only) ---------------------------------------
create table audit_log (
  id bigserial primary key,
  occurred_at timestamptz not null default now(),
  user_id uuid references users(id),
  user_name text,                  -- snapshot
  department_code text,            -- snapshot
  entity_type text not null,       -- job | user | role | setting | driver ...
  entity_id text,
  job_id uuid references transport_requests(id),
  action text not null,
  field text,
  old_value text,
  new_value text,
  sensitivity text not null default 'general'
    check (sensitivity in ('general','cost','commercial','admin'))
);
create index audit_job_idx on audit_log (job_id, occurred_at);
create index audit_entity_idx on audit_log (entity_type, entity_id, occurred_at);

create or replace function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_immutable();

-- ---------- Notifications & saved views ------------------------------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  type text not null,
  title text not null,             -- templates only; never include amounts
  job_id uuid references transport_requests(id),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notif_user_idx on notifications (user_id, read_at, created_at desc);

create table saved_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  module text not null,
  name text not null,
  filters jsonb not null default '{}',
  columns jsonb,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- Search text maintenance -----------------------------------
create or replace function refresh_job_search(p_job uuid) returns void language sql as $$
  update transport_requests t set search_text = lower(concat_ws(' ',
    t.job_number, t.boe_number, t.customer_reference, t.email_subject,
    t.shipment_number, t.booking_reference, t.pickup_name, t.pickup_address,
    t.delivery_name, t.delivery_address, t.id::text,
    c.name, d.full_name, d.mobile, v.vehicle_number))
  from customers c
  left join transport_assignments a on a.job_id = p_job and a.is_current
  left join drivers d on d.id = a.driver_id
  left join vehicles v on v.id = a.vehicle_id
  where t.id = p_job and c.id = t.customer_id;
$$;

-- ---------- Lock down Supabase's public API ----------------------------
-- The browser never talks to the database. All access goes through the
-- app's server API, which applies permissions. RLS on + no policies means
-- the anon/authenticated keys can read nothing, even if leaked.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
    execute 'revoke execute on all functions in schema public from anon, authenticated';
  end if;
end $$;
