-- 009 — PRO & Container Clearance
-- PRO coordinates clearance with Customs, ports, municipalities, free zones and other authorities.
-- Completely separate from Messenger runs (which only carry documents). Safe to run more than once.

-- ---------- a PRO side, department and roles -----------------------------------
alter table departments drop constraint if exists departments_side_chk;
alter table departments add constraint departments_side_chk
  check (side in ('admin','operations','transport','messenger','finance','pro'));
alter table roles drop constraint if exists roles_side_chk;
alter table roles add constraint roles_side_chk
  check (side is null or side in ('admin','operations','transport','messenger','finance','pro'));

-- PRO is run by the Documentations department: its manager (Documentation Manager) supervises PRO,
-- and PRO officers are sub-users of Documentations who use the phone app.
insert into roles (code, name, description, is_system, side, is_manager, app_only, department_id)
  select 'documentation_manager', 'Documentation Manager',
    'Manager of Documentations. Also supervises PRO clearance: assigns officers, sees all PRO work, PRO settings.',
    true, 'operations', true, false, d.id from departments d where d.code = 'documentations'
on conflict (code) do nothing;
insert into roles (code, name, description, is_system, side, is_manager, app_only, department_id)
  select 'pro_officer', 'PRO Officer', 'Documentations sub-user who handles clearance with the authorities. Uses the phone app.',
    true, 'operations', false, true, d.id from departments d where d.code = 'documentations'
on conflict (code) do nothing;
update roles set side = 'operations', is_manager = false, app_only = true,
    department_id = (select id from departments where code = 'documentations')
  where code = 'pro_officer';

insert into permissions (code, module, name, sensitivity) values
  ('pro.view_all', 'PRO', 'View all PRO requests', 'general'),
  ('pro.view_department', 'PRO', 'View PRO requests of own department', 'general'),
  ('pro.create', 'PRO', 'Create PRO requests', 'general'),
  ('pro.assign', 'PRO', 'Assign / reassign PRO officers (supervisor)', 'general'),
  ('pro.update', 'PRO', 'Update clearance status, activities and containers', 'general'),
  ('pro.charges.view', 'PRO', 'See clearance charges and payments', 'cost'),
  ('pro.charges.edit', 'PRO', 'Record clearance charges and payments', 'cost'),
  ('pro.configure', 'PRO', 'Configure authorities, activity types and PRO statuses', 'admin')
on conflict (code) do nothing;

-- Documentation Manager = everything an Operations Manager has + PRO supervision
insert into role_permissions (role_id, permission_code)
  select (select id from roles where code = 'documentation_manager'), rp.permission_code
    from role_permissions rp join roles r on r.id = rp.role_id where r.code = 'operations_manager'
union all
  select r.id, p from roles r, unnest(array['pro.view_all','pro.create','pro.assign','pro.update','pro.charges.view','pro.charges.edit','pro.configure']) p
   where r.code = 'documentation_manager'
union all
  select r.id, p from roles r, unnest(array['pro.update','pro.charges.view','pro.charges.edit']) p where r.code = 'pro_officer'
union all
  select r.id, p from roles r, unnest(array['pro.view_department','pro.create','pro.charges.view']) p where r.code = 'operations_manager'
union all
  select r.id, p from roles r, unnest(array['pro.view_department','pro.create']) p where r.code = 'operations'
union all
  select r.id, p from roles r, unnest(array['pro.view_all','pro.charges.view','pro.charges.edit']) p where r.code = 'finance'
on conflict do nothing;

-- the current Documentations manager becomes the Documentation Manager
update users set role_id = (select id from roles where code = 'documentation_manager'), token_version = token_version + 1
 where role_id = (select id from roles where code = 'operations_manager')
   and department_id = (select id from departments where code = 'documentations');

-- an earlier draft of this update had a separate PRO department and PRO Manager: fold them into Documentations
update users set role_id = (select id from roles where code = 'documentation_manager'),
    department_id = (select id from departments where code = 'documentations')
 where role_id = (select id from roles where code = 'pro_manager');
update users set department_id = (select id from departments where code = 'documentations')
 where department_id = (select id from departments where code = 'pro');
delete from role_permissions where role_id = (select id from roles where code = 'pro_manager');
delete from roles where code = 'pro_manager' and not exists (select 1 from users u where u.role_id = roles.id);
delete from departments where code = 'pro' and not exists (select 1 from users u where u.department_id = departments.id)
  and not exists (select 1 from roles r where r.department_id = departments.id);

-- Selling price / revenue / profit can never reach Transport, Messengers — or PRO.
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
          not (p.sensitivity = 'commercial' and coalesce(d.side, '') in ('transport', 'messenger', 'pro'))
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

-- ---------- configurable lists ------------------------------------------------------
create table if not exists pro_authorities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true,
  sort_order integer not null default 100
);
insert into pro_authorities (name, sort_order) values
  ('Dubai Customs', 10), ('Abu Dhabi Customs', 11), ('Sharjah Customs', 12), ('Ajman Customs', 13), ('Ras Al Khaimah Customs', 14),
  ('Fujairah Customs', 15), ('Umm Al Quwain Customs', 16), ('Federal Customs Authority (ICP)', 17),
  ('DP World – Jebel Ali Port', 20), ('DP World – Port Rashid', 21), ('AD Ports – Khalifa Port', 22), ('Sharjah Ports (Khalid / Khorfakkan)', 23),
  ('Dubai Municipality', 30), ('Abu Dhabi Agriculture & Food Safety (ADAFSA)', 31), ('Sharjah Municipality', 32),
  ('Ministry of Climate Change & Environment (MOCCAE)', 33), ('Ministry of Industry (MoIAT)', 34), ('Emirates Drug Establishment / MOHAP', 35),
  ('JAFZA', 40), ('Dubai South / DWC', 41), ('Dubai Airport Free Zone (DAFZA)', 42), ('Hamriyah / SAIF Zone', 43),
  ('Shipping line / agent', 50), ('Other', 99)
on conflict (name) do nothing;

create table if not exists pro_activity_types (
  code text primary key,
  name text not null,
  milestone text check (milestone in ('customs_clearance', 'release')),   -- what finishing this activity proves
  is_active boolean not null default true,
  sort_order integer not null default 100
);
insert into pro_activity_types (code, name, milestone, sort_order) values
  ('customs_declaration', 'Customs declaration and clearance', 'customs_clearance', 10),
  ('customs_inspection', 'Customs inspection coordination', null, 20),
  ('duty_payment', 'Customs duty / government charge coordination', null, 30),
  ('port_documentation', 'Port and terminal documentation', null, 40),
  ('delivery_order', 'Delivery order / release document', null, 50),
  ('gate_pass_release', 'Gate pass and container release', 'release', 60),
  ('municipality', 'Municipality approval / inspection', null, 70),
  ('commodity_approval', 'Food, health or agricultural approval', null, 80),
  ('free_zone', 'Free-zone authority formalities', null, 90),
  ('permit_certificate', 'Import / export permit or certificate', null, 100),
  ('document_submission', 'Document submission / correction / resubmission', null, 110),
  ('container_examination', 'Container examination / inspection appointment', null, 120),
  ('other_approval', 'Other authority approval', null, 130)
on conflict (code) do nothing;

create table if not exists pro_statuses (
  code text primary key,
  name text not null,
  stage text not null check (stage in ('draft', 'open', 'active', 'hold', 'done', 'cancelled')),
  color text not null default '#5B6B82',
  sort_order integer not null,
  is_active boolean not null default true
);
insert into pro_statuses (code, name, stage, color, sort_order) values
  ('draft', 'Draft', 'draft', '#8A94A6', 10),
  ('submitted', 'Request Submitted', 'open', '#5B6B82', 20),
  ('pending_assignment', 'Pending Assignment', 'open', '#B7791F', 30),
  ('assigned', 'Assigned to PRO', 'active', '#2B6CB0', 40),
  ('docs_review', 'Documents Under Review', 'active', '#2C5282', 50),
  ('docs_required', 'Documents Required / Correction Needed', 'active', '#C05621', 60),
  ('ready_to_submit', 'Ready for Authority Submission', 'active', '#3182CE', 70),
  ('submitted_authority', 'Submitted to Authority', 'active', '#6B46C1', 80),
  ('pending_inspection', 'Pending Inspection', 'active', '#805AD5', 90),
  ('inspection_in_progress', 'Inspection in Progress', 'active', '#553C9A', 100),
  ('pending_approval', 'Pending Approval', 'active', '#9F7AEA', 110),
  ('payment_pending', 'Payment Pending', 'active', '#D69E2E', 120),
  ('clearance_in_progress', 'Approved / Clearance in Progress', 'active', '#38A169', 130),
  ('customs_cleared', 'Customs Cleared', 'active', '#2F855A', 140),
  ('release_pending', 'Port / Terminal Release Pending', 'active', '#DD6B20', 150),
  ('container_released', 'Container Released', 'active', '#276749', 160),
  ('on_hold', 'On Hold', 'hold', '#718096', 170),
  ('rejected', 'Rejected', 'active', '#9B2C2C', 180),
  ('cancelled', 'Cancelled', 'cancelled', '#6B7280', 190),
  ('completed', 'Completed', 'done', '#22543D', 200)
on conflict (code) do nothing;

-- ---------- requests ---------------------------------------------------------------------
create sequence if not exists pro_request_seq start 1001;
create table if not exists pro_requests (
  id uuid primary key default gen_random_uuid(),
  request_no text not null unique,                       -- system PRO Request No. (PRO-1001)
  job_no text not null,                                  -- the company's Job No., typed by the requester
  job_id uuid references transport_requests(id),         -- linked truck job with the same Job No., when there is one
  department_id uuid references departments(id),
  requested_by uuid not null references users(id),
  customer_id uuid not null references customers(id),
  shipment_reference text,
  bl_number text not null,
  direction text not null check (direction in ('import', 'export', 'transit')),
  load_type text check (load_type in ('FCL', 'LCL')),
  transport_mode text check (transport_mode in ('sea', 'air', 'land')),
  vessel text, voyage text,
  port_of_origin text, port_of_destination text,
  uae_location text not null,                            -- UAE port / terminal / free zone
  cargo_description text,
  request_date date not null default current_date,
  required_date date not null,                           -- required clearance date
  deadline date,                                         -- hard deadline (defaults to the required date)
  priority text not null default 'normal' check (priority in ('normal', 'urgent', 'critical')),
  instructions text,
  status_code text not null references pro_statuses(code),
  hold_reason text,
  cancel_reason text,
  assigned_to uuid references users(id),
  assigned_by uuid references users(id),
  assigned_at timestamptz,
  customs_cleared_at timestamptz,
  completed_at timestamptz,
  deadline_warned_at timestamptz,
  escalated_at timestamptz,
  search_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists pro_job_no_idx on pro_requests (upper(btrim(job_no)));
create index if not exists pro_status_idx on pro_requests (status_code) where deleted_at is null;
create index if not exists pro_assigned_idx on pro_requests (assigned_to) where deleted_at is null;
create index if not exists pro_dept_idx on pro_requests (department_id) where deleted_at is null;
create index if not exists pro_search_trgm on pro_requests using gin (search_text gin_trgm_ops);

-- each container is tracked on its own (statuses can differ)
create table if not exists pro_containers (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references pro_requests(id),
  container_no text not null,
  size_type text,                                        -- 20GP, 40HC, 40RF …
  customs_status text not null default 'pending' check (customs_status in ('pending', 'cleared', 'held')),
  customs_cleared_at timestamptz,
  inspection_status text not null default 'not_required'
    check (inspection_status in ('not_required', 'pending', 'scheduled', 'in_progress', 'passed', 'failed')),
  release_status text not null default 'pending' check (release_status in ('pending', 'release_pending', 'released', 'not_required')),
  released_at timestamptz,
  delay_reason text,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists pro_cont_req_idx on pro_containers (request_id) where deleted_at is null;
create index if not exists pro_cont_no_idx on pro_containers (container_no);
create unique index if not exists pro_cont_uq on pro_containers (request_id, container_no) where deleted_at is null;

-- several clearance activities per request, each with its own authority and status
create table if not exists pro_activities (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references pro_requests(id),
  container_id uuid references pro_containers(id),       -- null = for the whole request
  activity_type_code text not null references pro_activity_types(code),
  authority_id uuid references pro_authorities(id),
  status text not null default 'not_started' check (status in ('not_started', 'documents_required', 'submitted', 'pending_inspection',
    'inspection_in_progress', 'pending_approval', 'payment_pending', 'approved', 'rejected', 'completed', 'not_required', 'on_hold')),
  reference_no text,                                     -- authority application / declaration number
  assigned_to uuid references users(id),
  submitted_on date,
  appointment_at timestamptz,                            -- inspection / appointment
  required_documents text,
  authority_remarks text,
  outstanding text,                                      -- outstanding requirements
  approved_on date,
  rejected_on date,
  completed_on date,
  next_action text,
  next_action_by uuid references users(id),
  next_action_due date,
  appointment_reminded_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists pro_act_req_idx on pro_activities (request_id) where deleted_at is null;

-- charges: actual or estimated, never booked into accounts automatically
create table if not exists pro_charges (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references pro_requests(id),
  activity_id uuid references pro_activities(id),
  container_id uuid references pro_containers(id),
  category text not null check (category in ('customs_duty', 'customs_fee', 'port_charges', 'inspection_fee', 'municipality_fee',
    'permit_fee', 'delivery_order', 'storage_demurrage', 'other')),
  description text,
  amount numeric(12,2) not null check (amount >= 0),
  is_estimate boolean not null default false,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'paid', 'waived')),
  paid_on date,
  receipt_document_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists pro_charge_req_idx on pro_charges (request_id) where deleted_at is null;

-- documents: on the request or on one activity; replacing keeps the old version
create table if not exists pro_documents (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references pro_requests(id),
  activity_id uuid references pro_activities(id),
  doc_type text not null,
  file_name text not null,
  storage_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null,
  version integer not null default 1,
  replaces_id uuid references pro_documents(id),
  replaced_at timestamptz,                                -- set when a newer version arrives
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists pro_doc_req_idx on pro_documents (request_id);

-- complete history: status changes, activity/container updates, assignments, notes, documents, charges
create table if not exists pro_history (
  id bigserial primary key,
  request_id uuid not null references pro_requests(id),
  activity_id uuid references pro_activities(id),
  container_id uuid references pro_containers(id),
  kind text not null,                                     -- status | activity | container | assign | note | document | charge | request
  field text,
  old_value text,
  new_value text,
  remarks text,
  document_id uuid references pro_documents(id),
  user_id uuid references users(id),
  user_name text not null,
  at timestamptz not null default now()
);
create index if not exists pro_hist_req_idx on pro_history (request_id, at);

alter table notifications add column if not exists pro_id uuid references pro_requests(id);

insert into settings (key, value) values
  ('pro_deadline_warning_hours', '24'),     -- warn the officer and requester this long before the deadline
  ('pro_escalate_after_hours', '0')         -- tell PRO supervisors once a request is this many hours past its deadline
on conflict (key) do nothing;

do $$ begin
  execute 'alter table pro_requests enable row level security';
  execute 'alter table pro_containers enable row level security';
  execute 'alter table pro_activities enable row level security';
  execute 'alter table pro_charges enable row level security';
  execute 'alter table pro_documents enable row level security';
  execute 'alter table pro_history enable row level security';
  execute 'alter table pro_authorities enable row level security';
  execute 'alter table pro_activity_types enable row level security';
  execute 'alter table pro_statuses enable row level security';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on pro_requests, pro_containers, pro_activities, pro_charges, pro_documents, pro_history,
      pro_authorities, pro_activity_types, pro_statuses from anon, authenticated';
    execute 'revoke all on sequence pro_request_seq, pro_history_id_seq from anon, authenticated';
  end if;
end $$;

update users set token_version = token_version + 1;
