-- 010 — Rental trucks (hired transport) when own vehicles are not available.
-- Per job: rental company + hired truck + hired driver + rental cost; Transport Manager approves;
-- the supplier's bill (invoice no., paid / unpaid) is tracked. Safe to run more than once.

-- ---------- rental companies (the old "subcontractors" table, now used) ----------------
alter table subcontractors add column if not exists contact_person text;
alter table subcontractors add column if not exists email text;
alter table subcontractors add column if not exists trn text;
alter table subcontractors add column if not exists address text;
alter table subcontractors add column if not exists remarks text;
alter table subcontractors add column if not exists created_at timestamptz not null default now();
alter table subcontractors add column if not exists updated_at timestamptz not null default now();
alter table subcontractors add column if not exists deleted_at timestamptz;
create unique index if not exists subcontractors_name_uq on subcontractors (upper(btrim(name))) where deleted_at is null;

-- ---------- permission: approve rentals ----------------------------------------------------
insert into permissions (code, module, name, sensitivity) values
  ('rentals.approve', 'Transport', 'Approve rental trucks and record the rental bill', 'general')
on conflict (code) do nothing;
insert into role_permissions (role_id, permission_code)
  select r.id, 'rentals.approve' from roles r where r.code = 'transport_manager'
on conflict do nothing;

-- rental cost is a transport cost line of its own
insert into expense_types (code, name, sort_order) values ('rental', 'Rental truck (hired)', 15)
on conflict (code) do nothing;

-- ---------- one row per hire ----------------------------------------------------------------
create table if not exists job_rentals (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references transport_requests(id),
  subcontractor_id uuid not null references subcontractors(id),
  vehicle_number text not null,
  vehicle_type_id uuid references vehicle_types(id),
  driver_name text not null,
  driver_mobile text not null,
  planned_pickup_at timestamptz not null,
  planned_delivery_at timestamptz,
  rental_cost numeric(12,2) not null check (rental_cost >= 0),
  send_app_link boolean not null default false,          -- give the hired driver the phone app for this job
  remarks text,
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'cancelled', 'replaced')),
  reject_reason text,
  requested_by uuid not null references users(id),
  requested_at timestamptz not null default now(),
  approved_by uuid references users(id),
  approved_at timestamptz,
  driver_id uuid references drivers(id),                  -- the hired driver / truck records made on approval
  vehicle_id uuid references vehicles(id),
  cost_label text,                                        -- description of the rental cost line on the job
  supplier_invoice_no text,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'paid')),
  paid_on date,
  updated_at timestamptz not null default now()
);
create index if not exists jr_job_idx on job_rentals (job_id);
create index if not exists jr_supplier_idx on job_rentals (subcontractor_id);
create index if not exists jr_status_idx on job_rentals (status);
-- only one rental waiting for approval per job
create unique index if not exists jr_one_open on job_rentals (job_id) where status = 'requested';

alter table job_rentals enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on job_rentals, subcontractors from anon, authenticated';
  end if;
end $$;

update users set token_version = token_version + 1;
