-- =====================================================================
-- Tapswipe Internal CRM — final schema for a fresh Supabase project
-- Modeled on the Hub feature set: Dashboard, Merchants, Pre-Apps,
-- Leads, Ghost Sheets, Support Tickets, Document Center, My Submissions.
--
-- Access rule, everywhere: role = 'admin' sees every row; everyone else
-- (role = 'agent') sees only rows where agent_id = auth.uid().
-- Enforced via Postgres Row Level Security using Supabase's auth.uid().
-- =====================================================================

-- ---------------------------------------------------------------------
-- PROFILES (extends Supabase's built-in auth.users 1-to-1)
-- ---------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null default 'agent' check (role in ('agent', 'admin')),
  is_active boolean not null default true,
  created_at timestamptz default now()
);

-- Role-check helper used in every policy below. security definer avoids
-- recursive RLS lookups (a policy on profiles querying profiles itself).
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'admin' and is_active
  );
$$;

alter table profiles enable row level security;

create policy "read own profile or admin reads all" on profiles
  for select using (id = auth.uid() or is_admin());

create policy "admin manages profiles" on profiles
  for update using (is_admin());
-- profiles are inserted by the create-user Edge Function (service role),
-- never directly by a client — no insert policy needed for authenticated.

-- ---------------------------------------------------------------------
-- MERCHANTS
-- ---------------------------------------------------------------------
create table merchants (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  mid text unique,
  dba text not null,
  legal_business_name text,
  status text not null default 'active' check (status in ('active', 'inactive', 'other')),
  processor text,
  split_agent_pct numeric(5,2),
  split_company_pct numeric(5,2),
  date_added date default current_date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table merchants enable row level security;

create policy "select own or admin" on merchants
  for select using (agent_id = auth.uid() or is_admin());
create policy "insert own" on merchants
  for insert with check (agent_id = auth.uid() or is_admin());
create policy "update own or admin" on merchants
  for update using (agent_id = auth.uid() or is_admin())
  with check (agent_id = auth.uid() or is_admin());
create policy "admin delete only" on merchants
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- LEADS
-- ---------------------------------------------------------------------
create table leads (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  lead_source text,
  merchant_legal_name text,
  dba text,
  contact_name text,
  contact_phone text,
  business_phone text,
  mobile_phone text,
  contact_email text,
  address text,
  city text,
  state text,
  country text,
  zip text,
  next_followup_date date,
  probability_to_close text,
  preferred_communication_method text,
  industry_vertical text,
  status text default 'open',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table leads enable row level security;

create policy "select own or admin" on leads
  for select using (agent_id = auth.uid() or is_admin());
create policy "insert own" on leads
  for insert with check (agent_id = auth.uid() or is_admin());
create policy "update own or admin" on leads
  for update using (agent_id = auth.uid() or is_admin())
  with check (agent_id = auth.uid() or is_admin());
create policy "admin delete only" on leads
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- GHOST SHEETS
-- ---------------------------------------------------------------------
create table ghost_sheets (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  lead_id int references leads(id),
  dba text,
  contact_name text,
  contact_phone text,
  notes text,
  status text default 'open',
  created_at timestamptz default now()
);

alter table ghost_sheets enable row level security;

create policy "select own or admin" on ghost_sheets
  for select using (agent_id = auth.uid() or is_admin());
create policy "insert own" on ghost_sheets
  for insert with check (agent_id = auth.uid() or is_admin());
create policy "update own or admin" on ghost_sheets
  for update using (agent_id = auth.uid() or is_admin())
  with check (agent_id = auth.uid() or is_admin());
create policy "admin delete only" on ghost_sheets
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- PRE-APPS — parent record. Non-sensitive fields only; billing_type and
-- bank_name live here (harmless on their own), routing/account numbers
-- do not (see pre_app_banking_secrets below).
-- ---------------------------------------------------------------------
create table pre_apps (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  lead_id int references leads(id),
  status text default 'draft' check (status in ('draft', 'submitted', 'approved', 'declined')),
  date_submitted date,

  -- business info
  dba_name text not null,
  legal_business_name text not null,
  contact_name text,
  contact_phone text,
  physical_address text,
  city text,
  state text,
  country text,
  zip text,
  phone_number text,
  fax_number text,
  email_address text,
  website text,

  -- business type
  state_incorporated text,
  legal_entity_type text,
  business_type text,
  sub_business_type text,
  business_start_date date,
  ein_type text,
  ein_number text,
  goods_sold text,

  -- banking (non-sensitive half — see pre_app_banking_secrets for the rest)
  billing_type text check (billing_type in ('gross', 'net')),
  bank_name text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table pre_apps enable row level security;

create policy "select own or admin" on pre_apps
  for select using (agent_id = auth.uid() or is_admin());
create policy "insert own" on pre_apps
  for insert with check (agent_id = auth.uid() or is_admin());
create policy "update own or admin" on pre_apps
  for update using (agent_id = auth.uid() or is_admin())
  with check (agent_id = auth.uid() or is_admin());
create policy "admin delete only" on pre_apps
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- PRE-APP OWNERS — non-sensitive ownership fields (name, address, %
-- owned, ID type/number, DOB). Normal RLS: reps fill this in directly.
-- SSN lives separately in pre_app_owner_secrets, below.
-- ---------------------------------------------------------------------
create table pre_app_owners (
  id serial primary key,
  pre_app_id int references pre_apps(id) not null,
  owner_name text,
  title text,
  id_type text,
  id_number text,
  id_issue_date date,
  id_expiration_date date,
  id_state text,
  dob date,
  home_phone text,
  percent_owned numeric(5,2),
  length_of_ownership text,
  home_address text,
  home_city text,
  home_state text,
  home_country text,
  home_zip text
);

alter table pre_app_owners enable row level security;

create policy "select via parent pre_app" on pre_app_owners
  for select using (
    is_admin() or exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    )
  );
create policy "insert via parent pre_app" on pre_app_owners
  for insert with check (
    is_admin() or exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    )
  );
create policy "update via parent pre_app" on pre_app_owners
  for update using (
    is_admin() or exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- PRE-APP TERMINAL — non-sensitive terminal/POS setup questions.
-- rp_password lives separately in pre_app_terminal_secrets, below.
-- ---------------------------------------------------------------------
create table pre_app_terminal (
  id serial primary key,
  pre_app_id int references pre_apps(id) not null,
  batch_out_time time,
  terminal_type text,
  auto_batch boolean,
  communication_method text,
  dial_9_outside boolean,
  reprogram_terminal boolean,
  equipment_purchase boolean,
  equipment_rental boolean,
  next_day_funding boolean,
  tip_edit boolean,
  ebt boolean,
  fns_number text,
  tax_calculation boolean,
  tax_rate numeric(5,3),
  refund_policy text,
  print_refund_on_footer boolean,
  software_pos_integration boolean,
  software_name_version text,
  pricing_provided text,
  statement_analysis text,
  receipt_header_message text,
  receipt_footer_message text,
  mp_ap_name text,
  rp_name text
);

alter table pre_app_terminal enable row level security;

create policy "select via parent pre_app" on pre_app_terminal
  for select using (
    is_admin() or exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    )
  );
create policy "insert via parent pre_app" on pre_app_terminal
  for insert with check (
    is_admin() or exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    )
  );
create policy "update via parent pre_app" on pre_app_terminal
  for update using (
    is_admin() or exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- PRE-APP BUSINESS PROFILE — card-mix percentages, notes. Not sensitive.
-- ---------------------------------------------------------------------
create table pre_app_business_profile (
  id serial primary key,
  pre_app_id int references pre_apps(id) not null,
  card_swiped_pct numeric(5,2),
  card_keyed_pct numeric(5,2),
  card_present_pct numeric(5,2),
  card_not_present_pct numeric(5,2),
  moto_pct numeric(5,2),
  internet_pct numeric(5,2),
  test_product_type text,
  notes text
);

alter table pre_app_business_profile enable row level security;

create policy "select via parent pre_app" on pre_app_business_profile
  for select using (
    is_admin() or exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    )
  );
create policy "insert via parent pre_app" on pre_app_business_profile
  for insert with check (
    is_admin() or exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    )
  );
create policy "update via parent pre_app" on pre_app_business_profile
  for update using (
    is_admin() or exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    )
  );

-- =====================================================================
-- SENSITIVE FIELD TABLES — SSN, routing/account number, terminal
-- password. RLS is enabled with NO policies for the authenticated role,
-- so direct client access is denied entirely, both read and write. The
-- only way in is a Supabase Edge Function using the service-role key
-- (which bypasses RLS by design) — that function holds the AES
-- encryption key as a secret and does the encrypt/decrypt itself. This
-- is true for the rep's *initial submission* of this data too: the
-- browser sends it to the Edge Function directly, never to these
-- tables via supabase-js.
-- =====================================================================

create table pre_app_owner_secrets (
  id serial primary key,
  pre_app_owner_id int references pre_app_owners(id) not null,
  ssn_encrypted bytea not null
);
alter table pre_app_owner_secrets enable row level security;
-- intentionally zero policies for `authenticated` — service role only

create table pre_app_banking_secrets (
  id serial primary key,
  pre_app_id int references pre_apps(id) not null,
  aba_routing_encrypted bytea not null,
  account_number_encrypted bytea not null
);
alter table pre_app_banking_secrets enable row level security;
-- intentionally zero policies for `authenticated` — service role only

create table pre_app_terminal_secrets (
  id serial primary key,
  pre_app_id int references pre_apps(id) not null,
  rp_password_encrypted bytea not null
);
alter table pre_app_terminal_secrets enable row level security;
-- intentionally zero policies for `authenticated` — service role only

-- ---------------------------------------------------------------------
-- DOCUMENTS — metadata only; file bytes live in Supabase Storage.
-- Not itself highly sensitive (a doc_type label + a storage key), so
-- normal RLS applies here; the actual signed URLs are still minted only
-- by the create-upload-url / create-download-url Edge Functions.
-- ---------------------------------------------------------------------
create table documents (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  owner_type text not null check (owner_type in ('pre_app', 'merchant', 'support_ticket', 'lead')),
  owner_id int not null,
  doc_type text not null,
  file_key text not null,
  file_name text,
  mime_type text,
  uploaded_at timestamptz default now()
);

alter table documents enable row level security;

create policy "select own or admin" on documents
  for select using (agent_id = auth.uid() or is_admin());
create policy "insert own" on documents
  for insert with check (agent_id = auth.uid() or is_admin());
create policy "delete own or admin" on documents
  for delete using (agent_id = auth.uid() or is_admin());

-- ---------------------------------------------------------------------
-- SUPPORT TICKETS
-- ---------------------------------------------------------------------
create table support_tickets (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  merchant_id int references merchants(id),
  category text,
  sub_category text,
  priority text,
  serial_number_imei text,
  subject text not null,
  message text,
  status text default 'open',
  created_at timestamptz default now()
);

alter table support_tickets enable row level security;

create policy "select own or admin" on support_tickets
  for select using (agent_id = auth.uid() or is_admin());
create policy "insert own" on support_tickets
  for insert with check (agent_id = auth.uid() or is_admin());
create policy "update own or admin" on support_tickets
  for update using (agent_id = auth.uid() or is_admin())
  with check (agent_id = auth.uid() or is_admin());

-- ---------------------------------------------------------------------
-- NOTES & TASKS — generic, attach to any of lead / pre_app / merchant /
-- ghost_sheet via owner_type + owner_id.
-- ---------------------------------------------------------------------
create table notes (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  owner_type text not null check (owner_type in ('lead', 'pre_app', 'merchant', 'ghost_sheet')),
  owner_id int not null,
  body text not null,
  created_at timestamptz default now()
);

alter table notes enable row level security;

create policy "select own or admin" on notes
  for select using (agent_id = auth.uid() or is_admin());
create policy "insert own" on notes
  for insert with check (agent_id = auth.uid() or is_admin());

create table tasks (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  owner_type text not null check (owner_type in ('lead', 'pre_app', 'merchant', 'ghost_sheet')),
  owner_id int not null,
  title text not null,
  due_date date,
  completed boolean default false,
  created_at timestamptz default now()
);

alter table tasks enable row level security;

create policy "select own or admin" on tasks
  for select using (agent_id = auth.uid() or is_admin());
create policy "insert own" on tasks
  for insert with check (agent_id = auth.uid() or is_admin());
create policy "update own or admin" on tasks
  for update using (agent_id = auth.uid() or is_admin())
  with check (agent_id = auth.uid() or is_admin());

-- ---------------------------------------------------------------------
-- AUDIT LOG — who touched what, when. Populated from Edge Functions for
-- admin actions and sensitive-data access; optionally from triggers for
-- everything else.
-- ---------------------------------------------------------------------
create table audit_log (
  id serial primary key,
  actor_id uuid references profiles(id),
  action text not null,
  table_name text,
  row_id text,
  created_at timestamptz default now()
);

alter table audit_log enable row level security;

create policy "admin reads audit log" on audit_log
  for select using (is_admin());
-- writes come only from service-role Edge Functions / triggers, not clients

-- =====================================================================
-- PRE-APP APPROVAL — Tier 2 (Postgres RPC function, no secrets needed).
-- security definer because it must write to merchants regardless of the
-- caller's own row restrictions; guards that power with an explicit
-- is_admin() check up front rather than relying on grants alone.
-- =====================================================================
create or replace function approve_pre_app(pre_app_id_input int)
returns int
language plpgsql
security definer
as $$
declare
  new_merchant_id int;
begin
  if not is_admin() then
    raise exception 'only admins can approve pre-apps';
  end if;

  insert into merchants (agent_id, dba, legal_business_name, status)
  select agent_id, dba_name, legal_business_name, 'active'
  from pre_apps where id = pre_app_id_input
  returning id into new_merchant_id;

  update pre_apps set status = 'approved' where id = pre_app_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'approve_pre_app', 'pre_apps', pre_app_id_input::text);

  return new_merchant_id;
end;
$$;

-- =====================================================================
-- NOTE ON SUPABASE STORAGE (not SQL — set up in the dashboard/CLI)
-- Create one private bucket named `documents`. Do not add public storage
-- policies referencing these tables — all upload/download access goes
-- through the create-upload-url / create-download-url Edge Functions,
-- which check the `documents` table's agent_id (or is_admin()) before
-- minting a short-lived signed URL with the service-role client.
-- =====================================================================

