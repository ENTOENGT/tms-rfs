-- =====================================================================
-- TMS 002 — Reference data + first Super Admin. Run once after 001.
-- First login: admin@company.local / ChangeMe!2026 (forced to change).
-- =====================================================================
insert into companies (name) values ('My Company');

insert into departments (code, name) values
  ('admin','Administration'), ('operations','Operations'),
  ('transport','Transport'), ('finance','Finance');

insert into roles (code, name, description, is_system) values
  ('super_admin','Super Admin','Full access to everything', true),
  ('operations','Operations User','Creates requests and owns selling price', true),
  ('transport','Transport User','Assigns drivers/vehicles and owns transport cost', true),
  ('finance','Finance User','Read-only financial visibility and reports', true);

insert into permissions (code, module, name, sensitivity) values
  ('jobs.view','Jobs','View jobs','general'),
  ('jobs.view_all','Jobs','View all jobs (not just own requests)','general'),
  ('jobs.create','Jobs','Create transport requests','general'),
  ('jobs.edit','Jobs','Edit request details before assignment','general'),
  ('jobs.edit_assigned','Jobs','Edit request details after assignment','general'),
  ('jobs.edit_completed','Jobs','Edit completed jobs','general'),
  ('jobs.delete','Jobs','Delete jobs (soft delete)','general'),
  ('jobs.cancel','Jobs','Cancel jobs','general'),
  ('jobs.backdate','Jobs','Create jobs with a past required date','general'),
  ('jobs.assign_driver','Assignment','Assign driver','general'),
  ('jobs.assign_vehicle','Assignment','Assign vehicle','general'),
  ('jobs.override_conflicts','Assignment','Override double-booking / availability','general'),
  ('jobs.update_status','Assignment','Update delivery status','general'),
  ('pod.upload','POD','Upload POD','general'),
  ('pod.verify','POD','Verify / reject POD','general'),
  ('documents.upload','Documents','Upload job documents','general'),
  ('documents.view_commercial','Documents','View commercial documents (customer invoices, quotations)','commercial'),
  ('finance.buying.view','Financials','View buying cost & transport expenses','cost'),
  ('finance.buying.edit','Financials','Edit buying cost & transport expenses','cost'),
  ('finance.selling.view','Financials','View selling price, revenue, discount, VAT, customer total','commercial'),
  ('finance.selling.edit','Financials','Edit selling price, charges, discount','commercial'),
  ('finance.profit.view','Financials','View profit & margin (also needs selling + buying view)','commercial'),
  ('reports.view','Reports','View reports','general'),
  ('reports.export','Reports','Export reports','general'),
  ('drivers.manage','Masters','Manage drivers','general'),
  ('vehicles.manage','Masters','Manage vehicles','general'),
  ('customers.manage','Masters','Manage customers','general'),
  ('locations.manage','Masters','Manage locations','general'),
  ('users.manage','Administration','Manage users','admin'),
  ('roles.manage','Administration','Manage roles & permissions','admin'),
  ('settings.manage','Administration','Manage settings & lists','admin'),
  ('audit.view','Administration','View full audit log','admin');

-- Super admin: every permission (the code also treats super_admin as all-access)
insert into role_permissions (role_id, permission_code)
  select r.id, p.code from roles r cross join permissions p where r.code = 'super_admin';

insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array[
    'jobs.view','jobs.view_all','jobs.create','jobs.edit','jobs.cancel',
    'documents.upload','documents.view_commercial',
    'finance.buying.view','finance.selling.view','finance.selling.edit','finance.profit.view',
    'reports.view','reports.export','customers.manage','locations.manage'
  ]) p where r.code = 'operations';

insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array[
    'jobs.view','jobs.view_all','jobs.assign_driver','jobs.assign_vehicle','jobs.update_status',
    'pod.upload','documents.upload',
    'finance.buying.view','finance.buying.edit',
    'reports.view','reports.export','drivers.manage','vehicles.manage','locations.manage'
  ]) p where r.code = 'transport';

insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array[
    'jobs.view','jobs.view_all','documents.view_commercial',
    'finance.buying.view','finance.selling.view','finance.profit.view',
    'reports.view','reports.export'
  ]) p where r.code = 'finance';

insert into job_statuses (code, name, sort_order, color, stage, is_system) values
  ('draft','Draft',10,'#8A94A6','draft',true),
  ('requested','Requested',20,'#5B6B82','open',true),
  ('pending_assignment','Pending Assignment',30,'#B7791F','open',true),
  ('assigned','Assigned',40,'#2B6CB0','active',true),
  ('confirmed','Confirmed',50,'#2C5282','active',true),
  ('dispatched','Vehicle Dispatched',60,'#6B46C1','active',true),
  ('picked_up','Pickup Completed',70,'#805AD5','active',true),
  ('in_transit','In Transit',80,'#553C9A','active',true),
  ('delivered','Delivered',90,'#2F855A','delivered',true),
  ('pod_pending','POD Pending',100,'#C05621','delivered',true),
  ('pod_received','POD Received',110,'#276749','delivered',true),
  ('completed','Completed',120,'#22543D','closed',true),
  ('cancelled','Cancelled',130,'#9B2C2C','cancelled',true);

insert into status_transitions (from_code, to_code) values
  ('draft','pending_assignment'),('draft','cancelled'),
  ('requested','pending_assignment'),('requested','cancelled'),
  ('pending_assignment','assigned'),('pending_assignment','cancelled'),
  ('assigned','confirmed'),('assigned','dispatched'),('assigned','pending_assignment'),('assigned','cancelled'),
  ('confirmed','dispatched'),('confirmed','cancelled'),
  ('dispatched','picked_up'),('picked_up','in_transit'),('picked_up','delivered'),
  ('in_transit','delivered'),('delivered','pod_pending'),('delivered','pod_received'),
  ('pod_pending','pod_received'),('pod_received','completed'),('delivered','completed');

insert into pod_statuses (code, name, sort_order) values
  ('not_required','Not Required',10),('pending','Pending',20),
  ('uploaded','Uploaded',30),('verified','Verified',40),('rejected','Rejected',50);

insert into vehicle_types (name, weight_capacity_kg, sort_order) values
  ('Sedan',300,10),('Van',1000,20),('Pickup',1000,30),('1 Ton',1000,40),
  ('3 Ton',3000,50),('5 Ton',5000,60),('10 Ton',10000,70),
  ('Trailer',25000,80),('Reefer',null,90),('Other',null,100);

insert into expense_types (code, name, sort_order) values
  ('base','Base transport cost',10),('fuel','Fuel',20),('toll','Toll / Salik',30),
  ('parking','Parking',40),('loading','Loading / Unloading',50),
  ('waiting','Waiting charges',60),('additional','Additional charges',70),('other','Other',80);

insert into revenue_types (code, name, sort_order) values
  ('base','Base selling price',10),('additional','Additional charges',20),
  ('waiting','Waiting charges',30),('other','Other charges',40);

insert into document_types (code, name, is_commercial) values
  ('boe','BOE',false),('delivery_note','Delivery Note',false),('pod','POD',false),
  ('transport_quotation','Transport Quotation (supplier)',false),
  ('customer_request','Customer Request',false),
  ('customer_invoice','Customer Invoice',true),
  ('customer_quotation','Customer Quotation',true),
  ('other','Other',false);

insert into settings (key, value) values
  ('company_name','"My Company"'),
  ('currency','"AED"'),
  ('timezone','"Asia/Dubai"'),
  ('vat_rate','5'),
  ('job_number_prefix','"JOB-"'),
  ('pod_reminder_hours','24');

insert into users (full_name, email, password_hash, department_id, role_id, must_change_password)
select 'System Administrator', 'admin@company.local', '$2a$10$sEoNeQk1hswwPHpYx/JyY.7oiP2CoPWkvGmQ6wRIL516lBqx7Bxwa',
       (select id from departments where code='admin'), (select id from roles where code='super_admin'), true;
