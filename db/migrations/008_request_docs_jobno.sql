-- 008 — New Transport Request: manual Job No., mandatory delivery contact,
--        request documents (Invoice, Packing list, BOE, BL, Gate pass, Other)
--        with automatic deletion 30 days after upload.
-- Nothing existing is deleted. Safe to run more than once.

-- ---------- Job No. (typed by Operations) ------------------------------------
-- The old automatic number stays as the system "Request No." (job_number).
alter table transport_requests add column if not exists job_no text;
-- Existing jobs keep the number they already have as their Job No.
update transport_requests set job_no = job_number where job_no is null;
-- One department can't use the same Job No. twice (cancelled jobs free the number).
-- Different departments may share a Job No. — the app warns, then allows.
create unique index if not exists tr_job_no_dept_uq on transport_requests (department_id, upper(btrim(job_no)))
  where deleted_at is null and job_no is not null and status_code <> 'cancelled';
create index if not exists tr_job_no_idx on transport_requests (upper(btrim(job_no)));
-- New automatic Request Nos. start with TR- so they are never confused with a Job No.
update settings set value = '"TR-"' where key = 'job_number_prefix' and value = '"JOB-"';

-- Search also finds the Job No. and the delivery contact
create or replace function refresh_job_search(p_job uuid) returns void language sql as $$
  update transport_requests t set search_text = lower(concat_ws(' ',
    t.job_no, t.job_number, t.boe_number, t.customer_reference, t.email_subject,
    t.shipment_number, t.booking_reference, t.pickup_name, t.pickup_address,
    t.delivery_name, t.delivery_address, t.delivery_contact_person, t.delivery_contact_number, t.id::text,
    c.name, d.full_name, d.mobile, v.vehicle_number))
  from customers c
  left join transport_assignments a on a.job_id = p_job and a.is_current
  left join drivers d on d.id = a.driver_id
  left join vehicles v on v.id = a.vehicle_id
  where t.id = p_job and c.id = t.customer_id;
$$;
select refresh_job_search(id) from transport_requests where deleted_at is null;

-- ---------- Request document headings ----------------------------------------
alter table document_types add column if not exists is_request_doc boolean not null default false;
alter table document_types add column if not exists retention_days integer check (retention_days is null or retention_days > 0);
alter table document_types add column if not exists sort_order integer not null default 100;

insert into document_types (code, name, is_commercial) values
  ('shipment_invoice', 'Invoice', false),
  ('packing_list', 'Packing list', false),
  ('bl', 'BL', false),
  ('gate_pass', 'Gate pass', false),
  ('supporting_doc', 'Other supporting documents', false)
on conflict (code) do nothing;
update document_types set is_request_doc = true, retention_days = 30, sort_order = x.ord
  from (values ('shipment_invoice', 1), ('packing_list', 2), ('boe', 3), ('bl', 4), ('gate_pass', 5), ('supporting_doc', 6)) x(code, ord)
 where document_types.code = x.code;
-- the seller's own invoice to the customer stays hidden from Transport, and is now clearly named
update document_types set name = 'Customer Invoice (our bill)' where code = 'customer_invoice' and name = 'Customer Invoice';

-- ---------- 30-day retention ----------------------------------------------------
alter table job_documents add column if not exists expires_at timestamptz;     -- upload time + retention days
alter table job_documents add column if not exists purged_at timestamptz;      -- file deleted from storage
alter table job_documents add column if not exists purge_attempts integer not null default 0;
alter table job_documents add column if not exists purge_error text;
alter table job_documents add column if not exists purge_tried_at timestamptz;
create index if not exists jd_expiry_idx on job_documents (expires_at) where expires_at is not null and purged_at is null;

-- One row per clean-up run, so anyone can see it is working (Settings → Document clean-up)
create table if not exists document_cleanup_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  trigger text not null,            -- 'schedule' | 'backup' | 'manual'
  deleted integer not null default 0,
  failed integer not null default 0,
  error text
);
alter table document_cleanup_runs enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on document_cleanup_runs from anon, authenticated';
    execute 'revoke all on sequence document_cleanup_runs_id_seq from anon, authenticated';
  end if;
end $$;
