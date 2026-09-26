-- =====================================================================
-- TMS 004 — Phase 4: POD, documents, notes, POD reminders.
-- Run once in Supabase SQL Editor BEFORE uploading the Phase 4 code.
-- Safe on a live database and safe to run twice.
-- =====================================================================

-- Private file bucket (Supabase only; skipped automatically elsewhere).
-- Private = no public links. Files are reached only through short-lived links
-- the app issues after checking permissions. 10 MB limit, documents and photos only.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('tms-documents', 'tms-documents', false, 10485760, array[
      'application/pdf', 'image/jpeg', 'image/png',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;

-- When a POD reminder was last sent for a job (so reminders repeat, not spam)
alter table transport_requests add column if not exists pod_reminded_at timestamptz;

-- Uploaded file details
alter table job_documents add column if not exists storage_driver text not null default 'supabase';
alter table job_documents add column if not exists deleted_by uuid references users(id);
create index if not exists jd_type_idx on job_documents (document_type_code) where deleted_at is null;
create index if not exists jd_created_idx on job_documents (created_at desc) where deleted_at is null;

-- Reminder throttle (the check runs at most every 10 minutes)
insert into settings (key, value) values ('pod_reminder_last_run', '"2000-01-01T00:00:00Z"')
  on conflict (key) do nothing;

-- Operations bills the customer, so by default they check the POD.
-- (Untick "Verify / reject POD" under Roles & permissions if you prefer otherwise.)
insert into role_permissions (role_id, permission_code)
  select id, 'pod.verify' from roles where code = 'operations'
  on conflict do nothing;

-- A cargo photo type is useful for damage / loading evidence
insert into document_types (code, name, is_commercial) values ('cargo_photo', 'Cargo photo', false)
  on conflict (code) do nothing;
