-- 011 — Standard rental rates: each rental company's price per truck type and route.
-- In "Hire rental truck" the matching rate fills the cost; Transport can still change it. Safe to run more than once.
create table if not exists rental_rates (
  id uuid primary key default gen_random_uuid(),
  subcontractor_id uuid not null references subcontractors(id),
  vehicle_type_id uuid not null references vehicle_types(id),
  from_place text not null,
  to_place text not null,
  standard_cost numeric(12,2) not null check (standard_cost >= 0),
  is_active boolean not null default true,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists rental_rates_uq on rental_rates
  (subcontractor_id, vehicle_type_id, upper(btrim(from_place)), upper(btrim(to_place))) where deleted_at is null;
create index if not exists rental_rates_sup_idx on rental_rates (subcontractor_id);

-- which standard rate was used, and its cost at that time (to compare with the cost actually agreed)
alter table job_rentals add column if not exists rate_id uuid references rental_rates(id);
alter table job_rentals add column if not exists standard_cost numeric(12,2);

alter table rental_rates enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on rental_rates from anon, authenticated';
  end if;
end $$;
