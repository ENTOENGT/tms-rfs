-- =====================================================================
-- TMS 003 — Phase 2 (masters) + Phase 3 (assignment & workflow).
-- Run once in Supabase SQL Editor, BEFORE uploading the Phase 2–3 code.
-- Safe on a live database: only adds settings, transitions and indexes.
-- =====================================================================

insert into settings (key, value) values ('expiry_warning_days', '30')
  on conflict (key) do nothing;

-- Extra real-world transitions
insert into status_transitions (from_code, to_code) values
  ('confirmed','pending_assignment'),   -- unassign after confirmation
  ('dispatched','cancelled'),           -- cancelled after the truck left
  ('dispatched','assigned'),            -- truck swapped after dispatch (needs override permission)
  ('pod_pending','completed')           -- only allowed once POD is uploaded / not required
on conflict do nothing;

-- Faster lookups used by availability and master screens
create index if not exists ta_job_idx on transport_assignments (job_id);
create index if not exists drivers_status_idx on drivers (status) where deleted_at is null;
create index if not exists vehicles_status_idx on vehicles (status) where deleted_at is null;
create unique index if not exists customers_name_uq on customers (lower(name)) where deleted_at is null;

-- Custom statuses added by admins get a code; keep codes unique and lowercase
alter table job_statuses drop constraint if exists job_statuses_code_format;
alter table job_statuses add constraint job_statuses_code_format check (code ~ '^[a-z0-9_]+$');
