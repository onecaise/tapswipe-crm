-- =====================================================================
-- Tapswipe Internal CRM — final schema for a fresh Supabase project
-- Modeled on the ISO Hub feature set: Dashboard, Merchants, Pre-Apps,
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

-- Deactivation must actually block a user's OWN-ROW access, not just their
-- ability to pass is_admin(). Without this, a deactivated agent who is
-- still logged in (or who logs back in before their auth.users row is
-- separately banned) can still read/write their own merchants, leads, etc.
-- Every "own row" branch of every policy below is gated on this, not just
-- on agent_id matching.
create or replace function is_active_agent()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and is_active
  );
$$;

alter table profiles enable row level security;

create policy "read own profile or admin reads all" on profiles
  for select using (id = auth.uid() or is_admin());

create policy "admin manages profiles" on profiles
  for update using (is_admin()) with check (is_admin());
-- profiles are inserted by the create-user Edge Function (service role),
-- never directly by a client — no insert policy needed for authenticated.
-- Agents do NOT get a direct update policy on their own row — that would
-- let them try to set their own role to 'admin' via a plain client update.
-- Self-service editing (e.g. full_name) goes through the RPC below instead,
-- which only ever touches full_name regardless of what's passed in.

create or replace function update_own_full_name(new_full_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_active_agent() then
    raise exception 'account is deactivated';
  end if;
  update profiles set full_name = new_full_name where id = auth.uid();
end;
$$;

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
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on merchants
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "update own or admin" on merchants
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
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
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on leads
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "update own or admin" on leads
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "admin delete only" on leads
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- GHOST SHEETS
-- ---------------------------------------------------------------------
create table ghost_sheets (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  -- on delete set null so deleting a lead doesn't require first unpicking every
  -- ghost sheet that points at it. Without it the FK defaults to NO ACTION and
  -- an admin simply cannot delete a converted lead. Note lead_id is the
  -- authoritative record of conversion state, so a sheet whose lead is deleted
  -- correctly reverts to unconverted.
  lead_id int references leads(id) on delete set null,
  dba text,
  contact_name text,
  contact_phone text,
  notes text,
  status text default 'open',
  created_at timestamptz default now()
);

alter table ghost_sheets enable row level security;

create policy "select own or admin" on ghost_sheets
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on ghost_sheets
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "update own or admin" on ghost_sheets
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
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
  -- `on delete set null` for the same reason as ghost_sheets.lead_id: this
  -- records provenance, not a dependency. Without it an admin cannot delete a
  -- lead any pre-app points at. Never CASCADE here -- deleting a lead must not
  -- delete a merchant application.
  lead_id int references leads(id) on delete set null,
  -- `not null` is load-bearing, not tidiness: a CHECK that evaluates to NULL
  -- passes, so without it `set status = null` is accepted and defeats the
  -- whole state machine (and every status filter) silently.
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'declined')),
  date_submitted date,
  -- Set by decline_pre_app() so the rep knows what to fix. Cleared by the
  -- next successful submit_pre_app().
  decline_reason text,

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

  -- Commission split between the rep and Tapswipe, recorded by the rep who
  -- knows the deal terms and copied into merchants by approve_pre_app(). The
  -- standard deal is 50/50; it is 100/0 when the CEO is the one on the sale.
  -- Without these columns approve_pre_app leaves merchants.split_*_pct NULL
  -- and an admin has to retype terms the pre-app already captured.
  split_agent_pct numeric(5,2) not null default 50,
  split_company_pct numeric(5,2) not null default 50,
  constraint pre_apps_split_sums_to_100
    check (split_agent_pct + split_company_pct = 100),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table pre_apps enable row level security;

create policy "select own or admin" on pre_apps
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on pre_apps
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "update own or admin" on pre_apps
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "admin delete only" on pre_apps
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- PRE-APP OWNERS — non-sensitive ownership fields (name, address, %
-- owned, ID type/number, DOB). Normal RLS: reps fill this in directly.
-- SSN lives separately in pre_app_owner_secrets, below.
-- ---------------------------------------------------------------------
create table pre_app_owners (
  id serial primary key,
  -- `on delete cascade` here and on every pre-app child: pre_apps has an
  -- admin-only DELETE policy, but without a referential action that delete
  -- fails with a foreign-key violation, and an admin cannot clear the
  -- children first (pre_app_owner_secrets is not granted to anyone). The
  -- cascade runs as the constraint owner and so bypasses RLS, which is what
  -- makes deleting an owner who has an SSN on file work at all.
  pre_app_id int references pre_apps(id) on delete cascade not null,
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
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "insert via parent pre_app" on pre_app_owners
  for insert with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
-- The `with check` is spelled out rather than left to Postgres reusing the
-- USING expression. Same effect, but the parent tables state it explicitly
-- and a reader should not have to know that rule to see that re-parenting a
-- row to someone else's pre-app is blocked.
create policy "update via parent pre_app" on pre_app_owners
  for update using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  )
  with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
-- Unlike most tables, delete is NOT admin-only here. A rep filling in the
-- form has to be able to remove an owner row they added by mistake, the same
-- exception `documents` makes for a rep's own uploads. Without this policy
-- the wizard's "Remove owner" cannot work at all.
create policy "delete via parent pre_app" on pre_app_owners
  for delete using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );

-- ---------------------------------------------------------------------
-- PRE-APP TERMINAL — non-sensitive terminal/POS setup questions.
-- rp_password lives separately in pre_app_terminal_secrets, below.
-- ---------------------------------------------------------------------
create table pre_app_terminal (
  id serial primary key,
  -- `unique` because this is one section of one form, not a collection. It is
  -- what lets the wizard autosave with upsert(onConflict: 'pre_app_id')
  -- instead of insert-or-update guesswork, and it is the only thing stopping
  -- a debounced save from quietly leaving two terminal rows behind.
  pre_app_id int references pre_apps(id) on delete cascade not null unique,
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
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "insert via parent pre_app" on pre_app_terminal
  for insert with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "update via parent pre_app" on pre_app_terminal
  for update using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  )
  with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "delete via parent pre_app" on pre_app_terminal
  for delete using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );

-- ---------------------------------------------------------------------
-- PRE-APP BUSINESS PROFILE — card-mix percentages, notes. Not sensitive.
-- ---------------------------------------------------------------------
create table pre_app_business_profile (
  id serial primary key,
  -- unique for the same reason as pre_app_terminal.pre_app_id above.
  pre_app_id int references pre_apps(id) on delete cascade not null unique,
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
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "insert via parent pre_app" on pre_app_business_profile
  for insert with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "update via parent pre_app" on pre_app_business_profile
  for update using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  )
  with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "delete via parent pre_app" on pre_app_business_profile
  for delete using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
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

-- `unique` on the parent reference of all three: one row is the current
-- value. Without it, correcting a mistyped account number appends a second
-- ciphertext row and nothing in the schema says which one is live — the read
-- function would have to guess (and "order by id desc" is a convention a
-- future caller will forget). With it, submit-pre-app-secrets upserts and a
-- correction replaces.
--
-- `on delete cascade` so removing an owner or deleting a pre-app takes its
-- ciphertext with it. Note this is also the only way that delete can succeed:
-- these tables are granted to nobody, so no client can clear them first.

-- `key_version` on all three: the stored value is a bare
-- 12-byte IV || ciphertext || 16-byte GCM tag with no version field, so
-- nothing in the ciphertext says which key or algorithm produced it. Rotating
-- PRE_APP_SECRETS_KEY, or moving off AES-256-GCM, would otherwise leave every
-- row undecodable with no way to tell old from new. It cannot be backfilled
-- once real ciphertext exists, so it goes in before any is written.
--
-- Values travel over PostgREST as the `\x`-hex text form, NEVER base64:
-- bytea_in accepts a base64 string as the escape format and silently stores
-- its literal ASCII, so a base64 bug here is undetectable data destruction.

create table pre_app_owner_secrets (
  id serial primary key,
  pre_app_owner_id int references pre_app_owners(id) on delete cascade not null unique,
  ssn_encrypted bytea not null,
  key_version smallint not null default 1
);
alter table pre_app_owner_secrets enable row level security;
-- intentionally zero policies for `authenticated` — service role only

create table pre_app_banking_secrets (
  id serial primary key,
  pre_app_id int references pre_apps(id) on delete cascade not null unique,
  aba_routing_encrypted bytea not null,
  account_number_encrypted bytea not null,
  key_version smallint not null default 1
);
alter table pre_app_banking_secrets enable row level security;
-- intentionally zero policies for `authenticated` — service role only

create table pre_app_terminal_secrets (
  id serial primary key,
  pre_app_id int references pre_apps(id) on delete cascade not null unique,
  rp_password_encrypted bytea not null,
  key_version smallint not null default 1
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
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on documents
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "delete own or admin" on documents
  for delete using ((agent_id = auth.uid() and is_active_agent()) or is_admin());

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
  -- Constrained, and NOT NULL, because the list page filters on it. The two
  -- other filtered statuses (merchants, pre_apps) are both constrained; leads
  -- is bare text and its list deliberately filters on next_followup_date
  -- instead, because a vocabulary that lives only in TypeScript is free to
  -- drift from the column's real contents. NOT NULL for the same reason
  -- pre_apps.status is: a CHECK that evaluates to NULL passes, so a nullable
  -- status silently defeats both the check and every filter built on it.
  --
  -- Three values, not four: 'pending' covers waiting on the merchant, the
  -- processor or a hardware RMA, and a separate 'resolved' before 'closed'
  -- would need a rule about who moves it between the two.
  status text not null default 'open' check (status in ('open', 'pending', 'closed')),
  -- category, sub_category, priority and serial_number_imei stay free text on
  -- purpose. They are reference data an admin will want to extend without a
  -- migration, and the form offers a native <datalist> of suggestions the same
  -- way documents-panel.tsx does for doc_type -- suggestions, not a constraint.
  created_at timestamptz default now()
);

alter table support_tickets enable row level security;

create policy "select own or admin" on support_tickets
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on support_tickets
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "update own or admin" on support_tickets
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "admin delete only" on support_tickets
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- NOTES & TASKS — generic, attach to any of lead / pre_app / merchant /
-- ghost_sheet via owner_type + owner_id.
--
-- owner_id carries NO foreign key, and cannot: it points into one of four
-- different tables depending on owner_type, which one column cannot
-- reference. Two consequences the database therefore cannot enforce, and
-- application code owns:
--
--   1. A row can be written against an owner_id that does not exist, or
--      that the writer cannot see -- the policies here check only
--      notes.agent_id / tasks.agent_id, never whether the *owner* is the
--      caller's. The damage is bounded (the author and admins are the only
--      readers, so a misfiled note is invisible to the owner's real owner
--      rather than leaked to them) but it is real. Insert paths pass
--      owner_type/owner_id from a server-rendered page that has already
--      loaded that parent row under RLS, never from client input.
--   2. Deleting an owner leaves its notes and tasks behind. There is no
--      cascade to hang them on, so they are orphans, invisible to every
--      page because no page asks for that owner_id any more.
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

-- Notes are APPEND-ONLY by design: there is deliberately no update policy, so
-- a note can be written, and removed by an admin, but never silently rewritten.
-- A correction is a second note, which keeps the trail readable in order and
-- means a quoted note cannot have changed since it was quoted. This is the one
-- Tier 1 table without an update policy, so it reads like an omission -- it
-- isn't. The UI must not offer an edit affordance, because RLS would filter the
-- UPDATE to zero rows and the rep would see a save that silently did nothing.
create policy "select own or admin" on notes
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on notes
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "admin delete only" on notes
  for delete using (is_admin());

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
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on tasks
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
-- Tasks DO get an update policy, unlike notes: `completed` is a checkbox whose
-- whole purpose is to be toggled back and forth, and due_date moves when a
-- callback slips.
create policy "update own or admin" on tasks
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "admin delete only" on tasks
  for delete using (is_admin());

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
-- INDEXES — every RLS policy filters on agent_id, so every query does too
-- (§14.8). Added while the tables are empty, where it costs nothing.
-- =====================================================================
create index idx_merchants_agent_id on merchants(agent_id);
create index idx_leads_agent_id on leads(agent_id);
create index idx_ghost_sheets_agent_id on ghost_sheets(agent_id);
create index idx_pre_apps_agent_id on pre_apps(agent_id);
create index idx_documents_agent_id on documents(agent_id);
create index idx_support_tickets_agent_id on support_tickets(agent_id);
create index idx_notes_agent_id on notes(agent_id);
create index idx_tasks_agent_id on tasks(agent_id);

-- columns the list pages actually filter on
create index idx_merchants_status on merchants(status);
create index idx_pre_apps_status on pre_apps(status);
create index idx_support_tickets_status on support_tickets(status);
create index idx_leads_next_followup_date on leads(next_followup_date);

-- The polymorphic owner pair. documents, notes and tasks are all read the same
-- way -- `where owner_type = $1 and owner_id = $2` -- by the panels on every
-- lead / pre-app / merchant / ghost-sheet detail page, which is three such
-- queries per page render. agent_id alone does not serve those: a rep's whole
-- book shares one agent_id, so that index selects everything they own and the
-- owner pair is then filtered out row by row.
--
-- owner_type leads because it is the equality column with the smaller domain
-- and both are always supplied together; the composite serves the pair. No
-- index on owner_id alone: nothing queries a note by owner_id without also
-- naming its type, and owner_id values collide across types by construction
-- (merchant 7 and lead 7 both exist).
create index idx_documents_owner on documents(owner_type, owner_id);
create index idx_notes_owner on notes(owner_type, owner_id);
create index idx_tasks_owner on tasks(owner_type, owner_id);

-- child tables reach their access check through
-- `exists (select 1 from pre_apps where pre_apps.id = pre_app_id ...)`,
-- so they filter on pre_app_id on every read and write
create index idx_pre_app_owners_pre_app_id on pre_app_owners(pre_app_id);
-- pre_app_terminal, pre_app_business_profile and the three *_secrets tables
-- need no index here: their `unique (pre_app_id)` / `unique (pre_app_owner_id)`
-- constraint already creates a unique btree index on exactly that column,
-- which serves these lookups. A second plain index would be dead weight on
-- every write. (This is why the earlier idx_pre_app_terminal_pre_app_id and
-- idx_pre_app_business_profile_pre_app_id are dropped when the constraints
-- are added.)

-- ---------------------------------------------------------------------
-- updated_at trigger — plain function, no security definer: it only
-- ever touches the row already being written, under the caller's own
-- RLS-checked UPDATE. Applied only where the column actually exists.
-- ---------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger merchants_set_updated_at
  before update on merchants
  for each row execute function set_updated_at();

create trigger leads_set_updated_at
  before update on leads
  for each row execute function set_updated_at();

create trigger pre_apps_set_updated_at
  before update on pre_apps
  for each row execute function set_updated_at();

-- =====================================================================
-- PRE-APP STATUS GUARD.
--
-- Why this exists: the pre_apps update policy is
-- `(agent_id = auth.uid() and is_active_agent()) or is_admin()` and says
-- nothing about WHICH COLUMNS may change. Without this trigger an agent can
-- PATCH `status = 'approved'` straight through PostgREST, skipping
-- approve_pre_app entirely -- its is_admin() guard is meaningless if the
-- column is directly writable -- and can raise split_agent_pct after
-- submitting but before approval, which approve_pre_app then copies into
-- merchants. RLS cannot express "status unchanged": a `with check`
-- expression sees only NEW, never OLD. A row trigger can.
--
-- How the trigger tells an RPC's own write from a client's: a session-local
-- flag, NOT the caller's role. `security definer` changes current_user, not
-- the session's JWT claims, so auth.uid() inside submit_pre_app still
-- returns the caller and is_admin() still evaluates against the caller's
-- profile. approve_pre_app's caller is an admin by its own guard, but
-- submit_pre_app's caller is normally the agent submitting their own draft --
-- so a role test would let approval through and block submission, which is
-- the worst possible split.
--
-- Deliberately no is_admin() early return. With one, an admin could PATCH
-- status to 'approved' directly and reach the approved state with no
-- merchants row and no audit_log entry: a data-integrity hole, not just an
-- authorization one. Status moves only through an RPC, for everyone.
-- is_admin() appears here solely to relax the separate rule that non-draft
-- rows are frozen.
--
-- NOTE FOR EDGE FUNCTION AUTHORS: this fires for the table OWNER too, so a
-- service-role connection is not exempt — and because such a connection has
-- no auth.uid(), is_admin() is false there as well. Privileged server code
-- therefore cannot UPDATE pre_apps.status, or touch a non-draft pre-app at
-- all; it has to call these RPCs. That is intended: it keeps the audit_log
-- write and the merchant creation on the only path that exists. If some
-- future function genuinely needs to bypass it, set the transition flag
-- around its own write rather than weakening the trigger.
-- =====================================================================
create or replace function pre_apps_guard_transitions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Set by the four state-machine RPCs immediately before their own UPDATE
  -- and cleared immediately after. Named under `tapswipe.` rather than
  -- `request.` on purpose: PostgREST populates the request.* namespace from
  -- client-controlled headers. A client cannot set this one -- set_config
  -- lives in pg_catalog, so it is not reachable as /rpc/set_config either.
  if coalesce(current_setting('tapswipe.pre_app_transition', true), '') = 'on' then
    return new;
  end if;

  if new.status is distinct from old.status then
    raise exception
      'status changes only through submit_pre_app(), approve_pre_app(), decline_pre_app() or reopen_pre_app()'
      using errcode = 'PT409';
  end if;

  if new.date_submitted is distinct from old.date_submitted then
    raise exception 'date_submitted is set by submit_pre_app()' using errcode = 'PT409';
  end if;

  -- Decision: agents edit drafts, admins edit anything. Enforced here rather
  -- than in RLS because the policy cannot see OLD.status.
  if old.status <> 'draft' and not is_admin() then
    raise exception 'a % pre-app can only be edited by an admin', old.status
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

create trigger pre_apps_guard_transitions
  before update on pre_apps
  for each row execute function pre_apps_guard_transitions();

-- =====================================================================
-- PRE-APP SUBMISSION — Tier 2. draft -> submitted, with the completeness
-- rules enforced server-side rather than trusted from the browser.
--
-- security definer, which needs justifying against the standing rule that
-- the three *_secrets tables are never granted and never given a policy.
-- This does not break that rule: the rule is about role GRANTs and RLS
-- policies, and neither is added. A definer function runs as the owner and
-- so bypasses both by a third mechanism -- the same one approve_pre_app
-- already uses to write merchants. It is still a door through the double
-- lock, so it is constrained three ways:
--
--   1. It only ever asks `exists (select 1 ...)`. No *_encrypted column is
--      named anywhere in the body, so no ciphertext can leave even though
--      it holds the privilege to read one. A test asserts that from
--      pg_get_functiondef, so the property is pinned rather than promised.
--   2. The existence check sits behind the ownership check, so it is no
--      oracle: by the time it runs the caller has been proven to own the row.
--   3. set search_path = public, so a temp-table shadow cannot redirect a read.
--
-- Because RLS does not scope reads inside a definer function, the ownership
-- check is written out by hand -- and "no such pre-app" and "not yours"
-- raise the IDENTICAL message. That is the SQL form of the 404-not-403 rule
-- the Edge Functions follow. PTxyz SQLSTATEs are PostgREST's mapping to HTTP
-- status codes, so the browser sees 404/409/422 rather than a flat 400.
-- =====================================================================
create or replace function submit_pre_app(pre_app_id_input int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  pa            pre_apps;
  bp            pre_app_business_profile;
  owner_count   int;
  control_count int;
begin
  select * into pa from pre_apps where id = pre_app_id_input;
  if not found then
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  if is_admin() then
    null;                       -- an admin may submit on a rep's behalf
  elsif pa.agent_id = auth.uid() then
    -- Telling the OWNER their account is off discloses nothing, and beats
    -- leaving them with an unexplained "not found".
    if not is_active_agent() then
      raise exception 'account is deactivated' using errcode = 'PT403';
    end if;
  else
    -- Byte-for-byte identical to the not-found branch above.
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  if pa.status <> 'draft' then
    raise exception 'pre-app is not a draft (status: %)', pa.status using errcode = 'PT409';
  end if;

  if coalesce(btrim(pa.dba_name), '') = '' then
    raise exception 'a DBA name is required' using errcode = 'PT422';
  end if;
  if coalesce(btrim(pa.legal_business_name), '') = '' then
    raise exception 'a legal business name is required' using errcode = 'PT422';
  end if;

  select count(*), count(*) filter (where percent_owned >= 51)
    into owner_count, control_count
    from pre_app_owners where pre_app_id = pa.id;

  if owner_count = 0 then
    raise exception 'at least one owner is required' using errcode = 'PT422';
  end if;
  -- Product consequence worth stating plainly: a genuine 50/50 two-owner
  -- partnership cannot be submitted. That is the rule (processors want one
  -- control person), it will come up, and the message has to read as a rule
  -- rather than a bug.
  if control_count = 0 then
    raise exception 'one owner must hold at least 51%% ownership' using errcode = 'PT422';
  end if;

  if exists (
    select 1 from pre_app_owners o
     where o.pre_app_id = pa.id
       and not exists (select 1 from pre_app_owner_secrets s where s.pre_app_owner_id = o.id)
  ) then
    raise exception 'every owner must have an SSN on file' using errcode = 'PT422';
  end if;

  -- Card mix: TWO INDEPENDENT PAIRS, nothing else. swiped+keyed is one 100%
  -- split of how the card is read; present+not-present is a second. moto and
  -- internet are informational and deliberately NOT summed against
  -- card_not_present_pct. Each pair is checked only when at least one of its
  -- columns is filled, so a half-completed profile still submits. The
  -- wizard's client-side blocker list must implement exactly these two.
  select * into bp from pre_app_business_profile where pre_app_id = pa.id;
  if found then
    if (bp.card_swiped_pct is not null or bp.card_keyed_pct is not null)
       and coalesce(bp.card_swiped_pct, 0) + coalesce(bp.card_keyed_pct, 0) <> 100 then
      raise exception 'swiped and keyed percentages must total 100' using errcode = 'PT422';
    end if;
    if (bp.card_present_pct is not null or bp.card_not_present_pct is not null)
       and coalesce(bp.card_present_pct, 0) + coalesce(bp.card_not_present_pct, 0) <> 100 then
      raise exception 'card-present and card-not-present percentages must total 100'
        using errcode = 'PT422';
    end if;
  end if;

  -- Existence only -- see the header. No *_encrypted column is named here.
  -- Terminal secrets are deliberately NOT required: whether an RP password is
  -- ever mandatory is an open question, and requiring one would block
  -- submissions for deals that have no terminal.
  if not exists (select 1 from pre_app_banking_secrets where pre_app_id = pa.id) then
    raise exception 'banking details have not been submitted' using errcode = 'PT422';
  end if;

  perform set_config('tapswipe.pre_app_transition', 'on', true);
  update pre_apps
     set status = 'submitted',
         date_submitted = current_date,
         decline_reason = null
   where id = pa.id;
  perform set_config('tapswipe.pre_app_transition', '', true);

  -- auth.uid() is available here: this is an ordinary authenticated PostgREST
  -- request, definer or not. Contrast the Edge Functions, where a service-role
  -- connection has no auth.uid() and actor_id must be passed in explicitly.
  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'submit_pre_app', 'pre_apps', pa.id::text);

  return pa.id;
end;
$$;

-- =====================================================================
-- PRE-APP APPROVAL — Tier 2. security definer because it writes to
-- merchants regardless of the caller's own row restrictions; guards that
-- power with an explicit is_admin() check up front rather than relying on
-- grants alone.
--
-- Five things this corrects against the original version:
--   1. No status gate -- it would approve a draft that was never submitted,
--      and approve the same pre-app twice, creating a second merchant each
--      time.
--   2. Silent no-op on a bad id -- `insert ... select ... where id = $1`
--      matched nothing, new_merchant_id stayed NULL, the UPDATE matched
--      nothing, and it returned NULL after writing an audit_log row claiming
--      an approval that never happened.
--   3. No `set search_path`, the standard definer hardening every other
--      function here already carries.
--   4. The split columns were not copied, so every approved merchant landed
--      on NULL/NULL.
--   5. audit_log recorded the pre-app id, which the caller already supplied,
--      and not the merchant id -- the one fact nobody could recover later.
-- =====================================================================
create or replace function approve_pre_app(pre_app_id_input int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  pa pre_apps;
  new_merchant_id int;
begin
  if not is_admin() then
    raise exception 'only admins can approve pre-apps' using errcode = 'PT403';
  end if;

  select * into pa from pre_apps where id = pre_app_id_input;
  if not found then
    -- The caller is a verified admin who can already see every row, so there
    -- is nothing to withhold and this names the id. The opposite of
    -- submit_pre_app's deliberately vague 404, for the opposite reason.
    raise exception 'pre-app % not found', pre_app_id_input using errcode = 'PT404';
  end if;

  if pa.status = 'approved' then
    raise exception 'pre-app % is already approved', pre_app_id_input using errcode = 'PT409';
  end if;
  if pa.status <> 'submitted' then
    raise exception 'pre-app % must be submitted before approval (status: %)',
      pre_app_id_input, pa.status using errcode = 'PT409';
  end if;

  -- agent_id comes from the pre-app, never auth.uid(): an admin approving on
  -- a rep's behalf must not move the merchant into their own book. Same
  -- reasoning as convert_ghost_sheet_to_lead.
  insert into merchants (agent_id, dba, legal_business_name, status,
                         split_agent_pct, split_company_pct)
  values (pa.agent_id, pa.dba_name, pa.legal_business_name, 'active',
          pa.split_agent_pct, pa.split_company_pct)
  returning id into new_merchant_id;

  perform set_config('tapswipe.pre_app_transition', 'on', true);
  update pre_apps set status = 'approved' where id = pa.id;
  perform set_config('tapswipe.pre_app_transition', '', true);

  -- Two rows, so the trail links both directions. audit_log has no detail
  -- column and adding one is a bigger change than this needs.
  insert into audit_log (actor_id, action, table_name, row_id) values
    (auth.uid(), 'approve_pre_app', 'pre_apps',  pa.id::text),
    (auth.uid(), 'approve_pre_app', 'merchants', new_merchant_id::text);

  return new_merchant_id;
end;
$$;

-- =====================================================================
-- PRE-APP DECLINE / REOPEN — Tier 2. A reason is required: a rep told only
-- "declined" has nothing to act on and will just ask an admin directly.
-- =====================================================================
create or replace function decline_pre_app(pre_app_id_input int, reason_input text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  pa pre_apps;
begin
  if not is_admin() then
    raise exception 'only admins can decline pre-apps' using errcode = 'PT403';
  end if;

  if coalesce(btrim(reason_input), '') = '' then
    raise exception 'a decline reason is required' using errcode = 'PT422';
  end if;

  select * into pa from pre_apps where id = pre_app_id_input;
  if not found then
    raise exception 'pre-app % not found', pre_app_id_input using errcode = 'PT404';
  end if;
  if pa.status <> 'submitted' then
    raise exception 'only a submitted pre-app can be declined (status: %)', pa.status
      using errcode = 'PT409';
  end if;

  perform set_config('tapswipe.pre_app_transition', 'on', true);
  update pre_apps
     set status = 'declined', decline_reason = btrim(reason_input)
   where id = pa.id;
  perform set_config('tapswipe.pre_app_transition', '', true);

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'decline_pre_app', 'pre_apps', pa.id::text);

  return pa.id;
end;
$$;

-- Reopen is available to the OWNING REP as well as an admin: the point of
-- recording a decline reason is that the rep can fix it themselves. The
-- reason survives the reopen so it stays on screen while they work, and
-- submit_pre_app clears it on the next successful submission.
create or replace function reopen_pre_app(pre_app_id_input int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  pa pre_apps;
begin
  select * into pa from pre_apps where id = pre_app_id_input;
  if not found then
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  if is_admin() then
    null;
  elsif pa.agent_id = auth.uid() then
    if not is_active_agent() then
      raise exception 'account is deactivated' using errcode = 'PT403';
    end if;
  else
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  if pa.status <> 'declined' then
    raise exception 'only a declined pre-app can be reopened (status: %)', pa.status
      using errcode = 'PT409';
  end if;

  perform set_config('tapswipe.pre_app_transition', 'on', true);
  update pre_apps set status = 'draft' where id = pa.id;
  perform set_config('tapswipe.pre_app_transition', '', true);

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'reopen_pre_app', 'pre_apps', pa.id::text);

  return pa.id;
end;
$$;

-- =====================================================================
-- PRE-APP SECRETS PRESENCE — Tier 2. Two booleans the wizard's review step
-- needs and cannot get any other way: does banking ciphertext exist, and how
-- many owners still have no SSN.
--
-- Why this exists rather than reusing read-pre-app-secrets: that function
-- DECRYPTS. Calling it to learn a boolean makes an admin's browser receive
-- full plaintext it never asked to see, and writes an audit_log row claiming
-- a full read that no human performed -- so merely opening the review tab
-- would pollute the one trail that is supposed to mean "somebody looked at an
-- SSN". Presence is not disclosure, so it gets its own door.
--
-- security definer for the same reason submit_pre_app is, and constrained the
-- same three ways: it only ever asks `exists`/`count`, so no *_encrypted
-- column is named anywhere in the body and no ciphertext can leave; the
-- checks sit behind the ownership check, so it is no oracle; and
-- set search_path = public stops a temp-table shadow redirecting a read. A
-- test asserts the no-ciphertext property from pg_get_functiondef.
--
-- Deliberately NO audit_log write. It reveals only what the rep is already
-- being asked to supply, and logging every render of a form step would bury
-- the reads that matter.
-- =====================================================================
create or replace function pre_app_secrets_presence(pre_app_id_input int)
returns table (banking_on_file boolean, owners_missing_ssn int)
language plpgsql
security definer
set search_path = public
as $$
declare
  pa pre_apps;
begin
  select * into pa from pre_apps where id = pre_app_id_input;
  if not found then
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  -- Byte-for-byte the guard submit_pre_app uses, for the same reason: "not
  -- yours" and "doesn't exist" must be indistinguishable.
  if is_admin() then
    null;
  elsif pa.agent_id = auth.uid() then
    if not is_active_agent() then
      raise exception 'account is deactivated' using errcode = 'PT403';
    end if;
  else
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  return query
    select
      exists (
        select 1 from pre_app_banking_secrets b where b.pre_app_id = pa.id
      ),
      (
        select count(*)::int
          from pre_app_owners o
         where o.pre_app_id = pa.id
           and not exists (
             select 1 from pre_app_owner_secrets s
              where s.pre_app_owner_id = o.id
           )
      );
end;
$$;

revoke all on function pre_app_secrets_presence(int) from public;
grant execute on function pre_app_secrets_presence(int) to authenticated, service_role;

-- =====================================================================
-- GHOST SHEET CONVERSION — Tier 2. Plain function, NOT security definer:
-- the caller owns both rows, so letting their own RLS scope the reads and
-- writes is safer than re-implementing the ownership check by hand. One
-- transaction, so a half-converted sheet is unreachable.
-- =====================================================================
create or replace function convert_ghost_sheet_to_lead(ghost_sheet_id_input int)
returns int
language plpgsql
as $$
declare
  sheet ghost_sheets;
  new_lead_id int;
begin
  -- RLS applies (security invoker), so this finds nothing unless the caller
  -- owns the sheet or is an admin — no hand-written ownership check needed.
  -- "not found" therefore covers both a nonexistent sheet and someone
  -- else's, which is the same non-disclosure the detail pages rely on.
  select * into sheet from ghost_sheets where id = ghost_sheet_id_input;
  if not found then
    raise exception 'ghost sheet not found';
  end if;
  if sheet.lead_id is not null then
    raise exception 'ghost sheet already converted';
  end if;

  -- agent_id comes from the sheet, not auth.uid(): an admin converting on a
  -- rep's behalf must not move the lead into their own book.
  insert into leads (agent_id, dba, contact_name, contact_phone, lead_source, status)
  values (sheet.agent_id, sheet.dba, sheet.contact_name, sheet.contact_phone,
          'ghost_sheet', 'open')
  returning id into new_lead_id;

  -- leads has no notes column, so the sheet's notes become a row in the
  -- polymorphic notes table. Guarded because notes.body is `not null`.
  if sheet.notes is not null and btrim(sheet.notes) <> '' then
    insert into notes (agent_id, owner_type, owner_id, body)
    values (sheet.agent_id, 'lead', new_lead_id, sheet.notes);
  end if;

  update ghost_sheets
     set lead_id = new_lead_id, status = 'converted'
   where id = ghost_sheet_id_input;

  return new_lead_id;
end;
$$;

-- =====================================================================
-- DASHBOARD COUNTS — Tier 2. Plain function, NOT security definer, for
-- the same reason convert_ghost_sheet_to_lead is: the caller's own RLS
-- does the scoping. Every count below is therefore automatically "mine"
-- for an agent and "everyone's" for an admin, with no role branch in the
-- function and no agent_id filter to keep in step with the policies.
--
-- This is the whole argument for not marking it `security definer`. A
-- definer version would run as the owner, bypass RLS, and have to
-- re-implement `(agent_id = auth.uid() and is_active_agent()) or
-- is_admin()` five times by hand — five more places for the access rule
-- to drift, in a function whose entire output is numbers an agent should
-- not be able to learn about other people's books.
--
-- One round trip rather than five head:true selects from the browser,
-- which also makes the set of numbers a single atomic snapshot.
--
-- On "active":
--
--   active_merchants  merchants.status = 'active'. A real constrained
--                     vocabulary, so this one means what it says.
--   active_leads      leads with no pre-app pointing at them. NOT
--                     `status = 'active'`: leads.status is nullable
--                     unconstrained text defaulting to 'open' (see the
--                     note on support_tickets.status for why that was
--                     deliberate), so there is no 'active' to compare
--                     against and a filter on it would invent the
--                     vocabulary this schema went out of its way not to
--                     have. pre_apps.lead_id is a real column with a real
--                     meaning, and it makes the dashboard read as a
--                     funnel — a deal counted under Pre-Apps is no longer
--                     counted under Leads, so the four figures sum to
--                     distinct work rather than double-counting.
--
-- ghost_sheets and pre_apps are deliberately unfiltered totals.
-- =====================================================================
create or replace function dashboard_counts()
returns table (
  active_merchants bigint,
  active_leads bigint,
  ghost_sheets_total bigint,
  pre_apps_total bigint,
  open_tickets bigint
)
language sql
stable
-- Output names are prefixed/suffixed away from the table names on purpose.
-- `returns table` makes each one a parameter that is in scope inside the body,
-- so an output called `ghost_sheets` would collide with the relation of the
-- same name. Every reference below is schema- or alias-qualified for the same
-- reason.
as $$
  select
    (select count(*) from public.merchants m where m.status = 'active'),
    (select count(*)
       from public.leads l
      where not exists (
        select 1 from public.pre_apps p where p.lead_id = l.id
      )),
    (select count(*) from public.ghost_sheets),
    (select count(*) from public.pre_apps),
    (select count(*) from public.support_tickets t where t.status = 'open');
$$;

revoke all on function dashboard_counts() from public;
grant execute on function dashboard_counts() to authenticated, service_role;

-- =====================================================================
-- GLOBAL SEARCH — Tier 2. Plain function, NOT security definer, and here
-- that is a security property rather than a convenience: a search box is
-- exactly the shape of thing that turns into a disclosure bug. Running as
-- the invoker means an agent's query is filtered by the same select
-- policies their list pages use, so the box cannot surface a record the
-- rest of the app would hide. A definer version would search everything
-- and rely on a hand-written filter being right five times over.
--
-- Returns a flat (kind, record_id, title, subtitle) shape rather than one
-- column per table, so the caller renders a single list. `record_id` is
-- named away from `id` because `returns table` puts these names in scope
-- inside the body.
--
-- Two guards on the input:
--   - Under MIN_TERM characters returns nothing, so an empty or one-key
--     query doesn't select every row the caller can see.
--   - The LIKE metacharacters are escaped, so typing '%' searches for a
--     percent sign instead of matching everything. Not a privilege issue
--     — RLS still applies — but "_" silently matching any character makes
--     search results look broken.
--
-- limit_input is per record kind, not overall, so one noisy table cannot
-- crowd the others out of the list.
-- =====================================================================
create or replace function search_crm(query_input text, limit_input int default 5)
returns table (
  kind text,
  record_id int,
  title text,
  subtitle text
)
language sql
stable
as $$
  with term as (
    select
      '%' ||
      -- Backslash first: escaping it after adding the others would escape the
      -- backslashes this very expression introduces.
      replace(replace(replace(btrim(query_input), '\', '\\'), '%', '\%'), '_', '\_')
      || '%' as pattern,
      length(btrim(coalesce(query_input, ''))) as term_length
  ),
  hits as (
    select * from (
      select 1 as rank, 'lead'::text as kind, l.id as record_id,
             coalesce(l.dba, l.contact_name, 'Lead #' || l.id) as title,
             l.contact_name as subtitle
        from public.leads l, term t
       where t.term_length >= 2
         and (l.dba ilike t.pattern
           or l.contact_name ilike t.pattern
           or l.contact_phone ilike t.pattern
           or l.contact_email ilike t.pattern
           or l.merchant_legal_name ilike t.pattern)
       order by l.dba
       limit limit_input
    ) lead_hits
    union all
    select * from (
      select 2 as rank, 'pre_app'::text as kind, p.id as record_id,
             p.dba_name as title,
             coalesce(p.legal_business_name, p.contact_name) as subtitle
        from public.pre_apps p, term t
       where t.term_length >= 2
         and (p.dba_name ilike t.pattern
           or p.legal_business_name ilike t.pattern
           or p.contact_name ilike t.pattern
           or p.email_address ilike t.pattern)
       order by p.dba_name
       limit limit_input
    ) pre_app_hits
    union all
    select * from (
      select 3 as rank, 'merchant'::text as kind, m.id as record_id,
             m.dba as title,
             coalesce(m.legal_business_name, m.mid) as subtitle
        from public.merchants m, term t
       where t.term_length >= 2
         and (m.dba ilike t.pattern
           or m.legal_business_name ilike t.pattern
           or m.mid ilike t.pattern)
       order by m.dba
       limit limit_input
    ) merchant_hits
    union all
    select * from (
      select 4 as rank, 'ghost_sheet'::text as kind, g.id as record_id,
             coalesce(g.dba, g.contact_name, 'Ghost sheet #' || g.id) as title,
             g.contact_name as subtitle
        from public.ghost_sheets g, term t
       where t.term_length >= 2
         and (g.dba ilike t.pattern
           or g.contact_name ilike t.pattern
           or g.contact_phone ilike t.pattern)
       order by g.dba
       limit limit_input
    ) ghost_sheet_hits
    union all
    select * from (
      select 5 as rank, 'support_ticket'::text as kind, s.id as record_id,
             s.subject as title,
             coalesce(s.category, s.serial_number_imei) as subtitle
        from public.support_tickets s, term t
       where t.term_length >= 2
         and (s.subject ilike t.pattern
           or s.serial_number_imei ilike t.pattern
           or s.category ilike t.pattern)
       order by s.subject
       limit limit_input
    ) support_ticket_hits
  )
  select h.kind, h.record_id, h.title, h.subtitle
    from hits h
   order by h.rank, h.title;
$$;

revoke all on function search_crm(text, int) from public;
grant execute on function search_crm(text, int) to authenticated, service_role;

-- =====================================================================
-- DATA API GRANTS — required, not optional.
--
-- RLS decides which ROWS a caller sees. Grants decide whether the caller
-- may touch the table at all, and the two are independent: a table with
-- perfect policies and no grant answers every request with "permission
-- denied for table X". That is the state this schema was in until this
-- section existed, and it is not a local-only quirk — Supabase's current
-- cloud default is that tables, views, sequences and functions created
-- in `public` by `postgres` (i.e. everything a migration creates) are
-- NOT auto-exposed to the Data API roles. The legacy auto-expose
-- behaviour is deprecated and the `auto_expose_new_tables` escape hatch
-- is removed on 2026-10-30, so relying on it is not an option.
--
-- Three roles, three different answers:
--
--   anon          nothing. This is an admin-provisioned CRM with sign-up
--                 off; there is no public data. Login goes through
--                 /auth/v1, not PostgREST, so anon never needs a table.
--   authenticated broad grants on the 13 non-secret tables. Broader than
--                 the policies on purpose — RLS is the enforcement layer
--                 and is what the tests assert. A grant list that tried
--                 to mirror each table's policy set would be a second,
--                 untested copy of the rules, free to drift.
--   service_role  everything, including the secrets tables. It bypasses
--                 RLS by design; this is the grant the Edge Functions
--                 run on.
--
-- The three *_secrets tables get NO grant for `authenticated`. Their
-- zero-policy RLS already denies everything, so this is the second lock
-- on the same door: if someone later adds a policy to one of them (§ the
-- standing "never add a policy to these tables" rule), the missing grant
-- still holds the line.
--
-- Tables are listed one by one rather than via `all tables in schema
-- public`. A new table then starts with no access and fails loudly on
-- first use, which forces the author back to this list — the same reason
-- the four-policy pattern is spelled out per table rather than automated.
--
-- HISTORY for the existing project (ref vdjtosofrimipklbdjbi). Probing it on
-- 2026-08-05 found it predated the always-revoked default and carried
-- Supabase's legacy blanket grants: `anon` and `authenticated` both held
-- select/insert/update/delete on all 16 tables INCLUDING the three *_secrets
-- tables, plus execute on every function. Nothing leaked (RLS returns zero
-- rows for anon, the secrets tables have no policies, and the definer RPCs
-- guard themselves), but RLS was the only lock on the secrets tables rather
-- than the second one.
--
-- RESOLVED as of 2026-08-06: `supabase migration list --linked` shows all
-- migrations applied to that project, including the REVOKE section below, so
-- its grant surface now matches this file. Re-check with `migration list`
-- rather than assuming, and remember the rule that motivated the caveat: a
-- claim about production has to be verified against production.
-- =====================================================================
grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on
  profiles,
  merchants,
  leads,
  ghost_sheets,
  pre_apps,
  pre_app_owners,
  pre_app_terminal,
  pre_app_business_profile,
  documents,
  support_tickets,
  notes,
  tasks,
  audit_log
to authenticated;

-- USAGE only, not SELECT: nextval() is all a serial insert needs, and
-- SELECT on a sequence would hand out last_value — a free row count of
-- every other agent's book.
grant usage on
  merchants_id_seq,
  leads_id_seq,
  ghost_sheets_id_seq,
  pre_apps_id_seq,
  pre_app_owners_id_seq,
  pre_app_terminal_id_seq,
  pre_app_business_profile_id_seq,
  documents_id_seq,
  support_tickets_id_seq,
  notes_id_seq,
  tasks_id_seq,
  audit_log_id_seq
to authenticated;

-- service_role bypasses RLS and is the only role that may reach the
-- secrets tables — via the submit-pre-app-secrets / read-pre-app-secrets
-- Edge Functions, which hold the encryption key.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Functions. Postgres grants EXECUTE to PUBLIC on creation, which would
-- leave these callable by anon; revoked first so the grants below are the
-- whole list. is_admin() and is_active_agent() must be executable by
-- `authenticated` because the policies call them during RLS evaluation,
-- which runs as the querying role.
revoke all on function is_admin() from public;
revoke all on function is_active_agent() from public;
revoke all on function update_own_full_name(text) from public;
revoke all on function approve_pre_app(int) from public;
revoke all on function submit_pre_app(int) from public;
revoke all on function decline_pre_app(int, text) from public;
revoke all on function reopen_pre_app(int) from public;
revoke all on function convert_ghost_sheet_to_lead(int) from public;
-- Trigger function: revoked and deliberately NOT granted below. A trigger
-- fires regardless of whether the querying role holds EXECUTE on it, so a
-- grant would widen the surface for no benefit.
revoke all on function pre_apps_guard_transitions() from public;
-- Trigger function: revoked, and deliberately NOT granted. A trigger fires
-- regardless of whether the querying role holds EXECUTE on its function, so a
-- grant would widen the surface for no benefit. (This one was missed when the
-- grants block was first written and shipped executable by anon.)
revoke all on function set_updated_at() from public;

grant execute on function is_admin() to authenticated, service_role;
grant execute on function is_active_agent() to authenticated, service_role;
grant execute on function update_own_full_name(text) to authenticated, service_role;
grant execute on function approve_pre_app(int) to authenticated, service_role;
grant execute on function submit_pre_app(int) to authenticated, service_role;
grant execute on function decline_pre_app(int, text) to authenticated, service_role;
grant execute on function reopen_pre_app(int) to authenticated, service_role;
grant execute on function convert_ghost_sheet_to_lead(int) to authenticated, service_role;

-- =====================================================================
-- REVOKE LEGACY PLATFORM GRANTS — converges an older project onto the
-- model above, and closes the door behind it.
--
-- The GRANTS section only adds privileges, so on a project created before
-- the always-revoked default it sits on top of Supabase's legacy blanket
-- grants rather than replacing them. Two problems with that, and they
-- need different fixes:
--
--   Existing objects — plain `revoke`. Strips anon back to nothing, and
--   takes `authenticated` off the three *_secrets tables so the missing
--   grant is once again the second lock behind their zero-policy RLS.
--
--   FUTURE objects — `alter default privileges`. This is the part that
--   plain revokes cannot reach, and the reason the legacy grants exist on
--   every table in the first place: they were never granted per table.
--   Confirmed by reading the linked project's pg_default_acl on
--   2026-08-05 — grantor `postgres`, schema `public`, objtype `r`:
--   {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm,
--   service_role=arwdDxtm}, plus anon=rwU on sequences and anon=X on
--   functions. Supabase's older project init ran the equivalent of
--
--     alter default privileges in schema public
--       grant all on tables to anon, authenticated, service_role;
--
--   so every table a migration creates is auto-granted at CREATE time, in
--   perpetuity. The per-object `GRANT ALL ON TABLE ... TO "anon"` lines a
--   schema dump shows are that default materialising at CREATE time, not a
--   separate mechanism. Revoking today and adding a table tomorrow would silently
--   re-open it. Removing the default-privilege entries is what makes "a
--   new table starts with no access and fails loudly" true rather than
--   aspirational.
--
-- This works for TABLES and not for FUNCTIONS, which was measured rather
-- than assumed. On Postgres 17 and on PGlite, a function created by
-- `postgres` in `public` comes out with `proacl = NULL` — the built-in
-- default, PUBLIC included — regardless of what pg_default_acl holds;
-- `alter default privileges ... revoke execute on functions from public`
-- is a verified no-op here. So there is no declarative backstop for
-- functions: every new RPC must carry its own
--
--   revoke all on function <sig> from public;
--   grant execute on function <sig> to authenticated, service_role;
--
-- in the migration that creates it, as the GRANTS section does for the
-- five that exist. tests/rls/grants.test.ts pins this so the gap is not
-- rediscovered the hard way.
--
-- Deliberately NOT touched:
--   * anon keeps USAGE on schema public. It has no table, sequence or
--     function privileges left, so it can reach nothing; keeping schema
--     usage only preserves the error shape the app already sees, rather
--     than turning an empty result into a schema-level failure on any
--     unauthenticated query that slips through.
--   * service_role's default privileges. It bypasses RLS and is the tier
--     the Edge Functions run on, so it keeps inheriting new tables. Note
--     the consequence: a table created on a project WITHOUT those legacy
--     defaults (a fresh one, or the local stack) is not reachable by
--     service_role until granted, so new-table migrations should grant it
--     explicitly rather than rely on inheritance.
--   * `for role supabase_admin`, whose defaults DO grant a full arwdDxtm
--     on tables to anon and authenticated on the local stack. Naming it
--     is fatal, not merely unnecessary: `postgres` is not a superuser and
--     not a member of that role, so the statement fails with `permission
--     denied to change default privileges` and aborts the migration
--     (tried). It is also the wrong target — that entry governs objects
--     created BY supabase_admin, i.e. the platform's, not ours. Default
--     privileges key on the CREATING role, and everything this repo adds
--     is created by `postgres` via db push or the SQL editor.
-- =====================================================================
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

revoke all on
  pre_app_owner_secrets,
  pre_app_banking_secrets,
  pre_app_terminal_secrets
from anon, authenticated;

revoke all on
  pre_app_owner_secrets_id_seq,
  pre_app_banking_secrets_id_seq,
  pre_app_terminal_secrets_id_seq
from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;

-- =====================================================================
-- NOTE ON `ensure_rls` / `rls_auto_enable()` — a safety net that exists on
-- the hosted project and NOWHERE ELSE. Nothing in code, migrations or
-- tests may assume it.
--
-- Read off ref vdjtosofrimipklbdjbi on 2026-08-05:
--
--   evtname     | evtevent        | enabled | owner    | tags
--   ensure_rls  | ddl_command_end | O       | postgres | CREATE TABLE,
--                                                        CREATE TABLE AS,
--                                                        SELECT INTO
--
-- It calls public.rls_auto_enable() — security definer, search_path
-- pg_catalog — which walks pg_event_trigger_ddl_commands(), and for each
-- new table or partitioned table in `public` runs
--
--   alter table if exists <table> enable row level security
--
-- wrapped in an exception handler that swallows failures to a RAISE LOG.
-- So on that project every new table gets RLS switched on for free, and
-- quietly does not if the attempt fails.
--
-- Where it does NOT exist:
--   * The local CLI stack. Its event triggers are issue_graphql_placeholder,
--     issue_pg_cron_access, issue_pg_graphql_access, issue_pg_net_access,
--     pgrst_ddl_watch, pgrst_drop_watch — verified, and no ensure_rls.
--   * The PGlite suite (tests/helpers/db.ts). There is no platform layer
--     there at all, only the migrations and a three-role auth shim.
--   * Any fresh project built from this file, because it is not in any
--     migration. `supabase db dump` will not carry it either — the CLI's
--     dump script comments out every `CREATE EVENT TRIGGER` line, so even a
--     dump-based clone arrives without it.
--
-- Why this matters more than a missing convenience: a migration that
-- forgets `enable row level security` produces two DIFFERENT bugs
-- depending on where it runs. On the hosted project the table comes up
-- RLS-enabled with no policies, which denies everyone and reads as a
-- broken feature. Everywhere else the same table is wide open, which is a
-- data leak. Same SQL, opposite failure, and the environment where it
-- looks fine is the one nobody tests against. That is worse than the net
-- not existing at all, which is the reason for writing this down.
--
-- The rule is therefore unchanged and unconditional: every new table
-- spells out `alter table ... enable row level security` and its four
-- policies, in the migration that creates it. Treat ensure_rls as a
-- backstop that happens to be there, never as the thing doing the work.
--
-- Two caveats on the "platform-managed" reading. First, ensure_rls is
-- owned by `postgres` while all six of the triggers above are owned by
-- `supabase_admin`, so it may well have been added through the SQL editor
-- rather than shipped by the platform — meaning nobody should assume it is
-- maintained, upgraded, or restored for us. Second, `postgres` CAN create
-- event triggers here despite not being a superuser (verified on the local
-- stack), so this could be added to a migration to make all environments
-- match. Deliberately not done: it would be a real behaviour change on
-- every future table, which wants its own decision rather than riding
-- along with a documentation note.
-- =====================================================================

-- =====================================================================
-- NOTE ON SUPABASE STORAGE (not SQL — set up in the dashboard/CLI)
-- Create one private bucket named `documents`. Do not add public storage
-- policies referencing these tables — all upload/download access goes
-- through the create-upload-url / create-download-url Edge Functions,
-- which check the `documents` table's agent_id (or is_admin()) before
-- minting a short-lived signed URL with the service-role client.
-- =====================================================================

-- =====================================================================
-- NOTES ON AUTH CONFIG (not SQL — set in supabase/config.toml and the
-- create-user / deactivate-user Edge Functions)
--
-- 1. This is an admin-provisioned CRM, not a self-service product. Public
--    sign-up must be OFF: set `enable_signup = false` under [auth] in
--    config.toml, and the /auth/sign-up route/page from the starter
--    template must be removed or replaced (not left live) — otherwise
--    anyone can create an auth.users row with no matching profiles row,
--    log in, and land on an app that's empty for them with no way to
--    self-heal (profiles has no insert policy for authenticated, by
--    design). The only way a profiles row should ever be created is the
--    create-user Edge Function, run by an existing admin.
--
-- 2. Role lookups happen per-request via is_admin()/is_active_agent()
--    rather than a custom JWT claim (a Supabase Auth "custom access
--    token hook"). This is a deliberate choice, not an oversight: a role
--    baked into the JWT can go stale until the token refreshes — e.g. a
--    just-deactivated agent's existing JWT would still claim they're
--    active. A live per-request check always reflects the current value
--    in profiles. Revisit only if this ever becomes a measurable
--    performance problem, which is unlikely at this scale.
--
-- 3. deactivate-user must do two things, not one: set profiles.is_active
--    = false (which the policies above now actually enforce for
--    "own-row" access, not just admin checks) AND ban the corresponding
--    auth.users row via the Supabase Auth Admin API, so a session/JWT
--    issued before deactivation can't keep working until it happens to
--    expire. Flipping is_active alone is not sufficient on its own.
-- =====================================================================
