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
  -- The sign-in address, copied here by create-user.
  --
  -- A denormalised copy of auth.users.email, which is the authority. It exists
  -- because the Manage Users page had no way to show one: auth.users is not
  -- reachable from the Data API at all, so listing emails would otherwise mean
  -- a whole new admin Edge Function, and without them two reps with the same
  -- full_name are indistinguishable in the only screen that manages accounts.
  --
  -- Safe to denormalise only because nothing in this app changes an email after
  -- creation -- there is no email-change flow, and GoTrue's would bypass this
  -- column. If one is ever added, it has to write here too, and this comment is
  -- the reason why. Nullable because rows created before this column exists
  -- have no value to backfill from within a migration that cannot see
  -- auth.users at plan time (the migration does backfill it; the column stays
  -- nullable so a future service-role insert that omits it fails visibly on
  -- the page rather than at the database).
  email text,
  role text not null default 'agent' check (role in ('agent', 'admin')),
  is_active boolean not null default true,
  -- Set by create-user and admin-reset-password, cleared by
  -- clear_must_change_password() once the rep sets their own. This is what makes
  -- §8's "forced to set a real password on first login" real rather than a
  -- convention: the (app) route-group layout redirects to /auth/update-password
  -- while it is true, so an admin-known temporary password cannot survive as a
  -- working credential.
  --
  -- A column rather than auth.users.app_metadata because requireUser() already
  -- loads this row on every request, so reading it costs nothing, and because a
  -- column is assertable in the hermetic test suite where app_metadata is not.
  must_change_password boolean not null default false,
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

-- SELECT is the ONLY policy on profiles. There is deliberately no insert,
-- update or delete policy for `authenticated` — the same treatment the three
-- *_secrets tables get, and for the same reason: this is the table that decides
-- who is an admin, so it has no client write path at all.
--
-- profiles are inserted by the create-user Edge Function (service role), never
-- directly by a client. Deletes never happen at all (§8: deactivation, never
-- deletion).
--
-- On the missing UPDATE policy specifically. There used to be an
-- "admin manages profiles" policy here, `for update using (is_admin()) with
-- check (is_admin())`. It was removed by the 11 Aug security audit, because an
-- admin could use it to PATCH /rest/v1/profiles directly and thereby walk past
-- every guard inside set_user_role() below — the role vocabulary, the
-- no-self-demotion block that makes zero-active-admins unreachable, the
-- last-active-admin check — while writing no audit_log row at all, since
-- audit_log has no INSERT policy and a plain client write cannot log itself. It
-- also allowed setting is_active = false without the banned_until ban that
-- deactivate-user writes first, producing exactly the shown-inactive-but-usable
-- state that ordering exists to prevent.
--
-- Agents never had an own-row update policy either, for the narrower version of
-- the same reason: it would let them try to set their own role to 'admin'.
--
-- Every write to profiles is therefore a `security definer` RPC
-- (update_own_full_name, clear_must_change_password, set_user_role) or a
-- service-role Edge Function (create-user, deactivate-user,
-- admin-reset-password) — each of which either touches one column of the
-- caller's own row, or writes an audit_log row as part of the same statement.
--
-- FORWARD CONSTRAINT: a future "admin edits a rep's name" feature needs a new
-- narrow RPC, not a policy. Re-adding an UPDATE policy here re-opens all of the
-- above. Pinned by tests/rls/manage-users.test.ts, which asserts pg_policies
-- holds no UPDATE policy on this table.

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

-- Clears the forced-password-change flag for the caller's own row, and nothing
-- else. Same shape and same reasoning as update_own_full_name above: there is no
-- self-update policy on profiles, so this is the only way a rep can retire their
-- own temporary password, and it can only ever touch this one column.
--
-- Deliberately NOT gated on is_active_agent(). A deactivated user cannot reach
-- this anyway (they cannot log in), and a gate here would mean a rep whose
-- account was switched off mid-password-change is left with the flag stuck on.
create or replace function clear_must_change_password()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update profiles set must_change_password = false where id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------------
-- SET USER ROLE — Tier 2, promoting or demoting from the Manage Users
-- screen.
--
-- An Edge Function would work but is the wrong tier: this needs no
-- service-role key and no Auth Admin API, only a server-side admin check
-- and an audit row, which is precisely §9's Tier 2. `security definer` is
-- required because audit_log has no INSERT policy for `authenticated`;
-- bundling both writes here means the role change and its audit row cannot
-- come apart.
--
-- This is now the ONLY way a role can change. It used to be one of two: the
-- "admin manages profiles" UPDATE policy allowed the same change from the
-- client with no trail, which made `security definer` here look like
-- redundancy over the policy rather than what it actually is. That policy is
-- gone (see the profiles block above), so every guard below is unavoidable
-- rather than merely preferable.
--
-- Three guards beyond is_admin(), in order:
--
--   1. The role vocabulary, so this cannot write a value the CHECK
--      constraint would then have to catch.
--   2. No self-demotion. An admin demoting themselves loses the screen
--      they are standing on, mid-session, with no way back. This is the
--      load-bearing guard: it is what makes zero active admins
--      unreachable, and zero active admins is the only unrecoverable
--      state in the whole user-management surface -- nobody could create
--      users, promote anyone, or reach /admin/users, and recovery is a
--      hand-written SQL statement in the dashboard, the manual bootstrap
--      §8 says should apply to admin #1 only.
--   3. No demoting the last active admin.
--
-- Guard 3 is UNREACHABLE as written, and that is worth stating plainly
-- rather than leaving as a puzzle for the next reader. is_admin() means
-- the caller is an active admin, and guard 2 means the caller is not the
-- target, so an active admin other than the target always exists. It is
-- kept as depth for the plausible future edit that relaxes guard 2 once a
-- second admin exists, at which point guard 3 becomes the check that
-- stops the last one going. No test claims to exercise it, because any
-- such test would really be exercising guard 2.
-- ---------------------------------------------------------------------
create or replace function set_user_role(target_user_id uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target profiles;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if new_role not in ('agent', 'admin') then
    raise exception 'role must be agent or admin' using errcode = 'PT400';
  end if;

  if target_user_id = auth.uid() then
    raise exception 'you cannot change your own role' using errcode = 'PT409';
  end if;

  select * into target from profiles where id = target_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'PT404';
  end if;

  -- Nothing to do, and nothing worth an audit row that says a role changed
  -- when it did not.
  if target.role = new_role then
    return;
  end if;

  if new_role = 'agent' then
    if not exists (
      select 1 from profiles
       where role = 'admin' and is_active and id <> target_user_id
    ) then
      raise exception 'cannot demote the last active admin'
        using errcode = 'PT409';
    end if;
  end if;

  update profiles set role = new_role where id = target_user_id;

  -- Distinct verbs rather than one 'set_user_role' plus a detail column,
  -- because audit_log has no detail column and the direction is the whole
  -- point of the entry.
  insert into audit_log (actor_id, action, table_name, row_id)
  values (
    auth.uid(),
    case when new_role = 'admin'
         then 'promote_user_to_admin'
         else 'demote_user_to_agent' end,
    'profiles',
    target_user_id::text
  );
end;
$$;

revoke all on function clear_must_change_password() from public;
grant execute on function clear_must_change_password() to authenticated, service_role;
revoke all on function set_user_role(uuid, text) from public;
grant execute on function set_user_role(uuid, text) to authenticated, service_role;

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
  -- Which pre-app was approved into this merchant, when one was. The foreign
  -- key is added after pre_apps exists, below. Nullable and staying that way:
  -- merchants are also created by hand, and every row that predates this
  -- column has no pre-app to point at.
  pre_app_id int,
  date_added date default current_date,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  -- The same rule pre_apps carries, arrived at the other way round. pre_apps
  -- has enforced it since the beginning and the wizard derives the company
  -- half from the agent half, so an approved merchant is always consistent.
  -- A hand-edited one was not: the merchant form takes both numbers as free
  -- input, and 60/45 saved without complaint.
  --
  -- Declared `not valid` deliberately. Existing rows are not checked, because
  -- nobody can say from here whether a 60/45 row is a typo or a deal someone
  -- actually struck, and a migration that rewrites commission figures on its
  -- own authority is worse than one that leaves them alone. Every insert and
  -- every update from here on is checked. Run
  --   select id, dba, split_agent_pct, split_company_pct from merchants
  --    where coalesce(split_agent_pct, 0) + coalesce(split_company_pct, 0) <> 100
  --      and (split_agent_pct is not null or split_company_pct is not null);
  -- to list what predates it, then `validate constraint` once they are settled.
  --
  -- Both-null stays legal: a merchant whose split is simply not recorded yet
  -- is an ordinary state, and NULL + NULL would otherwise be forced to 100.
  constraint merchants_split_totals_100 check (
    (split_agent_pct is null and split_company_pct is null)
    or coalesce(split_agent_pct, 0) + coalesce(split_company_pct, 0) = 100
  ) not valid
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

-- merchants.pre_app_id, deferred to here because merchants is declared before
-- pre_apps and a forward reference will not create. `on delete set null` for
-- the same reason ghost_sheets.lead_id uses it: pre_apps has an admin-only
-- DELETE policy, and without an action that delete fails against any merchant
-- approved from the row. The merchant is the durable record and outlives its
-- application; losing the provenance pointer is the correct trade.
alter table merchants
  add constraint merchants_pre_app_id_fkey
  foreign key (pre_app_id) references pre_apps(id) on delete set null;

create index idx_merchants_pre_app_id on merchants(pre_app_id);

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
-- No UPDATE policy, and no UPDATE grant either (see the grants block). A
-- document is replaced by uploading a new one and deleting the old, so nothing
-- edits this row in place. The grant is revoked as well as the policy left out
-- because a policy-only omission fails the quiet way: the privilege check would
-- pass, RLS would filter the statement to zero rows, and a future edit
-- affordance would report a save that did nothing — the same trap `notes`
-- carried until 20260812143407 closed it there too. With the grant gone the
-- answer is "permission denied", at the layer where the decision actually
-- lives.
--
-- The delete policy is the standing exception to admin-only deletes: reps
-- remove their own uploads. That is also why documents needs the cross-agent
-- audit trigger despite its access being audited in the Edge Functions — see
-- the trigger block below.

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
-- SUPPORT TICKET REPLIES — the conversation on a ticket.
--
-- A child of support_tickets rather than a use of `notes`, and the reason is
-- the policy rather than the shape. notes is scoped own-or-admin, so an admin's
-- reply on a rep's ticket would be invisible to the rep -- the one person who
-- has to read it. Replies are scoped through the PARENT instead: whoever can
-- see the ticket sees its replies, which is what makes this a conversation and
-- not two private monologues. (notes.owner_type also has no 'support_ticket'
-- member, and this is why it is not being given one.)
--
-- APPEND-ONLY, like notes and for the same reason: a reply is a record of what
-- was said, and the correction for a wrong one is another reply. No update
-- policy, and -- per the rule in the grants block -- no update grant either.
--
-- author_id is not an ownership column. It records who spoke; visibility comes
-- from the parent. That is why the insert policy pins it to auth.uid() rather
-- than trusting the client: without that conjunct a rep could post a reply
-- under the admin's name on their own ticket.
-- ---------------------------------------------------------------------
create table support_ticket_replies (
  id serial primary key,
  -- on delete cascade for the reason every pre-app child carries it: the
  -- parent's admin-only DELETE would otherwise fail on this FK.
  ticket_id int references support_tickets(id) on delete cascade not null,
  author_id uuid references profiles(id) not null,
  body text not null,
  created_at timestamptz default now()
);

alter table support_ticket_replies enable row level security;

-- Same shape as the pre_app children: is_admin() first and unqualified, and
-- is_active_agent() OUTSIDE the exists(), ANDed with it -- the activity check
-- is about the caller, not about the parent row.
create policy "select via parent ticket" on support_ticket_replies
  for select using (
    is_admin() or (is_active_agent() and exists (
      select 1 from support_tickets
       where support_tickets.id = ticket_id and support_tickets.agent_id = auth.uid()
    ))
  );
create policy "insert via parent ticket" on support_ticket_replies
  for insert with check (
    author_id = auth.uid() and (
      is_admin() or (is_active_agent() and exists (
        select 1 from support_tickets
         where support_tickets.id = ticket_id and support_tickets.agent_id = auth.uid()
      ))
    )
  );
create policy "admin delete only" on support_ticket_replies
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
-- isn't. The UPDATE grant is withheld as well (see the grants block), so the UI
-- must not offer an edit affordance and no longer can: the answer is
-- "permission denied for table notes" rather than a save that silently did
-- nothing.
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
-- BUG REPORTS — the floating report bubble, on every CRM page.
--
-- Ordinary Tier 1 shape: agent_id is the reporter, and the standard
-- own-or-admin policy scopes it. Naming the column agent_id rather than
-- reporter_id is deliberate and buys two things -- the policies are the same
-- ones as everywhere else, and log_cross_agent_change() works unchanged, so an
-- admin clearing a rep's report is audited with no new trigger function.
--
-- CLEARED BY STATUS, NOT BY DELETE. Checking a report off the admin list sets
-- status and stamps resolved_at / resolved_by; the list filters status = 'open'.
-- The same reasoning as deactivating a user instead of deleting them (§8): a
-- report is a description of something that went wrong, and it is worth more
-- after it has been dismissed than before -- when the same bug is reported
-- again, or when someone asks whether it was ever looked at. There is
-- deliberately NO delete policy and no delete grant.
--
-- The cost, stated so it is not discovered: the table only grows, and every
-- query that means "the queue" has to say `status = 'open'`. A list that
-- forgets the filter shows dismissed reports as live work rather than failing,
-- which is the quiet kind of wrong. lib/bug-reports.ts owns that filter in one
-- place for that reason.
--
-- `page` is free text, not a check constraint. It holds a route path, and
-- routes change with every feature -- a constraint would mean a migration each
-- time one is added, and a report filed against a path that no longer exists is
-- still worth reading.
-- ---------------------------------------------------------------------
create table bug_reports (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  page text not null,
  description text not null,
  -- Two ways to close, because they mean different things: 'resolved' is fixed,
  -- 'dismissed' is not-a-bug or won't-fix. Both leave the queue; only the first
  -- claims anything was done. NOT NULL for the reason support_tickets.status is:
  -- a CHECK that evaluates to NULL passes, so a nullable status silently defeats
  -- both the check and every filter built on it.
  status text not null default 'open'
    check (status in ('open', 'resolved', 'dismissed')),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id),
  created_at timestamptz default now()
);

alter table bug_reports enable row level security;

create policy "select own or admin" on bug_reports
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
-- Pinned to the caller rather than the usual own-or-admin shape: a bug report
-- is a first-hand account, so filing one under someone else's name is not a
-- thing an admin should be able to do either. is_active_agent() checks
-- is_active without checking role, so an active admin reporting their own bug
-- satisfies this too.
create policy "insert own" on bug_reports
  for insert with check (agent_id = auth.uid() and is_active_agent());
-- Admin-only, and this is the clear-from-the-list action. A rep cannot edit a
-- report after filing it -- including their own -- for the same reason notes are
-- append-only: the value is in what it said at the time.
create policy "admin resolves" on bug_reports
  for update using (is_admin()) with check (is_admin());
-- No delete policy, on purpose. See the header.

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
create index idx_bug_reports_agent_id on bug_reports(agent_id);

-- columns the list pages actually filter on
create index idx_merchants_status on merchants(status);
create index idx_pre_apps_status on pre_apps(status);
create index idx_support_tickets_status on support_tickets(status);
-- The admin queue is `where status = 'open'`, and cleared reports accumulate
-- behind it forever -- that is the cost of clearing by status rather than by
-- delete, and this is what keeps paying it cheap.
create index idx_bug_reports_status on bug_reports(status);
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
-- Same reasoning, different parent: support_ticket_replies reaches its check
-- through support_tickets, and the thread is always read by ticket_id.
create index idx_support_ticket_replies_ticket on support_ticket_replies(ticket_id);
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
-- CROSS-AGENT AUDIT TRIGGER — the trail for admin action on other
-- people's records.
--
-- The gap this closes: §10 promises audit logging of admin actions, but
-- an admin editing or deleting any rep's merchant/lead/pre-app does it
-- with plain supabase-js. RLS permits it via is_admin() and nothing was
-- recorded, so the largest privileged surface in the app was the only
-- unlogged one. Deletes are admin-only across the board and were
-- equally silent.
--
-- Only cross-agent mutations are logged. A rep editing their own lead is
-- ordinary work, and recording it would bury the entries that matter
-- under thousands that don't -- the same reasoning that keeps
-- pre_app_secrets_presence out of the trail.
--
-- `security definer` is mandatory here, not stylistic. audit_log has no
-- INSERT policy for `authenticated`, so a security invoker trigger would
-- have its insert refused by RLS and would fail the caller's UPDATE
-- outright. Running as the owner is also what makes this compose with
-- audit_log's SELECT-only grant above.
--
-- auth.uid() still returns the real caller inside a definer function:
-- definer changes current_user, not the session's JWT claims. The same
-- property submit_pre_app() relies on, documented there.
--
-- AFTER, not BEFORE: the trail should record what actually happened, and
-- on pre_apps the BEFORE guard trigger may still reject the write.
--
-- Reads OLD through to_jsonb rather than OLD.agent_id. All eight tables
-- carry both columns today, so direct access would work -- but attached
-- to a table without agent_id it would raise and break the caller's
-- write, where this yields NULL and merely over-logs. The safer failure
-- for one function bolted onto eight tables, and the reason `documents`
-- needed no variant of its own when it was added: id and agent_id are
-- read by name out of the jsonb, so the polymorphic owner_type/owner_id
-- pair it also carries is simply not looked at.
--
-- 'cross_agent_*' rather than 'admin_*' because the condition actually
-- tested is "the actor is not this row's owner". Under RLS that means an
-- admin, but it also catches a service-role connection, which has no
-- auth.uid() at all and so is caught by `is distinct from` -- logging
-- privileged server writes is a feature. Naming those rows admin_* would
-- assert a role nothing here verified.
--
-- Note the expected duplication: approve_pre_app and decline_pre_app
-- write their own audit row AND update a rep's pre_apps, so those events
-- produce two rows at different granularities. Additive detail, not a
-- bug.
--
-- INSERT is covered too, against NEW.agent_id -- an admin creating a
-- record in a rep's name (the `insert own` policy permits an admin any
-- agent_id) is a privileged act with no other trace.
--
-- FAIL CLOSED, AND THAT IS INTENTIONAL. This is an AFTER ROW trigger, so
-- it runs inside the same transaction as the statement that fired it, and
-- it carries no EXCEPTION block. If the audit_log insert fails for any
-- reason, the error propagates and **the triggering INSERT/UPDATE/DELETE
-- is rolled back with it.** A write to these eight tables therefore
-- cannot succeed while its audit row silently does not.
--
-- That is the trade we want, and it is the opposite of the choice
-- rls_auto_enable() makes (which swallows per-table failures via
-- EXCEPTION WHEN OTHERS) and of submit-pre-app-secrets (which cannot fail
-- closed, because its ciphertext is already written by the time it
-- audits). Here nothing has been committed yet, so refusing the write is
-- both possible and correct: an unlogged admin edit is worse than a
-- failed one, because the failure is visible and the gap is not.
--
-- The realistic failure is audit_log.actor_id's foreign key to
-- profiles(id): a JWT whose sub has no profiles row would violate it. RLS
-- makes that unreachable in practice (such a caller fails both
-- is_active_agent() and is_admin(), so no policy admits their write), but
-- the rollback is asserted in tests/rls/audit-trigger.test.ts rather than
-- assumed.
-- =====================================================================
create or replace function log_cross_agent_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor        uuid := auth.uid();
  row_agent_id uuid;
  new_agent_id uuid;
begin
  -- INSERT is handled first and in its own branch because OLD is NOT ASSIGNED
  -- for an insert. Reading it here -- even inside a CASE that should not
  -- evaluate -- risks "record old is not assigned yet", which would break every
  -- insert on all seven tables. Nothing below this block touches OLD until
  -- TG_OP has ruled INSERT out.
  if TG_OP = 'INSERT' then
    row_agent_id := (to_jsonb(NEW) ->> 'agent_id')::uuid;
    if actor is distinct from row_agent_id then
      insert into audit_log (actor_id, action, table_name, row_id)
      values (
        actor, 'cross_agent_insert', TG_TABLE_NAME, to_jsonb(NEW) ->> 'id'
      );
    end if;
    return null;
  end if;

  -- UPDATE or DELETE from here, so OLD is assigned.
  row_agent_id := (to_jsonb(OLD) ->> 'agent_id')::uuid;

  if TG_OP = 'UPDATE' then
    new_agent_id := (to_jsonb(NEW) ->> 'agent_id')::uuid;
    -- Reassignment is checked before ownership, and separately from it. An admin
    -- moving a record they THEMSELVES own into another rep's book has
    -- actor = OLD.agent_id, so the ownership test below would skip it -- yet
    -- moving a record between books is precisely the privileged act a trail
    -- exists for.
    if new_agent_id is distinct from row_agent_id then
      insert into audit_log (actor_id, action, table_name, row_id)
      values (actor, 'record_reassigned', TG_TABLE_NAME, to_jsonb(OLD) ->> 'id');
      return null;
    end if;
  end if;

  if actor is distinct from row_agent_id then
    insert into audit_log (actor_id, action, table_name, row_id)
    values (
      actor,
      case TG_OP when 'DELETE' then 'cross_agent_delete'
                 else 'cross_agent_update' end,
      TG_TABLE_NAME,
      to_jsonb(OLD) ->> 'id'
    );
  end if;

  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

revoke all on function log_cross_agent_change() from public;
-- Deliberately NOT granted to authenticated: a trigger fires whether or not
-- the querying role holds EXECUTE. Same treatment as set_updated_at().

-- All eight tables that carry agent_id and are written through Tier 1.
create trigger merchants_audit_cross_agent
  after insert or update or delete on merchants
  for each row execute function log_cross_agent_change();

create trigger leads_audit_cross_agent
  after insert or update or delete on leads
  for each row execute function log_cross_agent_change();

create trigger ghost_sheets_audit_cross_agent
  after insert or update or delete on ghost_sheets
  for each row execute function log_cross_agent_change();

create trigger pre_apps_audit_cross_agent
  after insert or update or delete on pre_apps
  for each row execute function log_cross_agent_change();

create trigger support_tickets_audit_cross_agent
  after insert or update or delete on support_tickets
  for each row execute function log_cross_agent_change();

-- notes has no UPDATE policy (append-only by design), so the update arm never
-- fires there. Listed anyway rather than special-cased: if that policy is ever
-- added, the trail should not have to be remembered separately.
create trigger notes_audit_cross_agent
  after insert or update or delete on notes
  for each row execute function log_cross_agent_change();

create trigger tasks_audit_cross_agent
  after insert or update or delete on tasks
  for each row execute function log_cross_agent_change();

-- documents is the eighth, and was the last one added -- it was excluded at
-- first on the grounds that its access is audited inside create-upload-url and
-- create-download-url, where the event worth recording is the signed-URL mint
-- rather than the metadata row. That reasoning is right about reads and still
-- holds; the two functions keep writing upload_document / download_document.
--
-- It does not cover DELETE, which is what the 11 Aug audit found. documents is
-- the one table whose delete policy is own-row-or-admin rather than admin-only,
-- and a delete mints no URL -- so neither function ran, no trigger fired, and
-- the row vanished with its Storage object orphaned and nothing written down.
-- Three audit mechanisms and documents DELETE fell through all three.
--
-- Expect duplication on upload, as with approve_pre_app: an admin uploading for
-- a rep now produces both upload_document:<owner_type> and cross_agent_insert.
-- One event, two granularities. Assert on `action`, never on row counts.
--
-- The update arm is unreachable here -- documents has no UPDATE policy and no
-- UPDATE grant -- and is attached anyway for the reason notes carries above.
create trigger documents_audit_cross_agent
  after insert or update or delete on documents
  for each row execute function log_cross_agent_change();

-- bug_reports is the ninth, and needs no variant: its reporter column is named
-- agent_id precisely so the generic function reads it. Clearing a report is an
-- UPDATE by an admin on a rep's row, which is exactly what cross_agent_update
-- records -- so who dismissed what is in the trail without any extra work, and
-- resolved_by on the row is the readable copy of the same fact.
create trigger bug_reports_audit_cross_agent
  after insert or update or delete on bug_reports
  for each row execute function log_cross_agent_change();

-- ---------------------------------------------------------------------
-- support_ticket_replies gets its OWN function, not the one above.
--
-- log_cross_agent_change() reads `agent_id` by name out of to_jsonb(NEW/OLD).
-- This table has no such column -- author_id records who spoke, and ownership
-- lives on the parent ticket -- so the read yields NULL, `actor is distinct
-- from null` is true for every caller, and every reply including a rep's own
-- would log a cross_agent_insert. That is precisely the noise the "a rep
-- editing their own lead is ordinary work" rule exists to avoid.
--
-- Skipping the trigger entirely was the other option, and it is wrong here:
-- an admin replying on a rep's ticket is exactly the class of event this
-- mechanism exists to record, and no write to support_tickets accompanies it,
-- so the parent's trigger does not fire either.
--
-- security definer for the same reason its sibling is: audit_log has no insert
-- policy, so a caller-run function could not write the row.
--
-- Fail-closed, deliberately: no EXCEPTION block, so a failed audit insert rolls
-- back the reply that triggered it. A reply cannot be posted while its trail
-- quietly is not.
-- ---------------------------------------------------------------------
create or replace function log_cross_agent_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor         uuid := auth.uid();
  ticket_owner  uuid;
  reply         jsonb;
begin
  -- Branch before touching either record. OLD is NOT ASSIGNED on an INSERT and
  -- NEW is not on a DELETE, and reading the wrong one raises "record is not
  -- assigned yet" -- which would break every reply. This is the same trap
  -- log_cross_agent_change() opens with a comment about.
  if TG_OP = 'DELETE' then
    reply := to_jsonb(OLD);
  else
    reply := to_jsonb(NEW);
  end if;

  select agent_id into ticket_owner
    from support_tickets
   where id = (reply ->> 'ticket_id')::int;

  -- The rep's own replies on their own ticket are ordinary work. Everything
  -- else -- an admin answering, or a rep somehow reaching another book -- is
  -- what the trail is for.
  if actor is distinct from ticket_owner then
    insert into audit_log (actor_id, action, table_name, row_id)
    values (
      actor,
      case TG_OP when 'DELETE' then 'cross_agent_delete'
                 when 'UPDATE' then 'cross_agent_update'
                 else 'cross_agent_insert' end,
      TG_TABLE_NAME,
      reply ->> 'id'
    );
  end if;

  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

-- Not granted to anyone, like its sibling: a trigger function is invoked by the
-- trigger, running as its owner. Postgres grants EXECUTE to PUBLIC on every new
-- function, so this line is what closes it.
revoke all on function log_cross_agent_reply() from public;
revoke all on function log_cross_agent_reply() from anon, authenticated;

create trigger support_ticket_replies_audit_cross_agent
  after insert or update or delete on support_ticket_replies
  for each row execute function log_cross_agent_reply();

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
  --
  -- pre_app_id records which application this came from. Note what it is not:
  -- a live link. Every other column here is a COPY taken at approval, and
  -- nothing syncs afterwards, so an admin editing an approved pre-app changes
  -- the application and not the merchant. That is deliberate -- the merchant is
  -- the record of what was agreed -- and the pointer exists so the divergence
  -- is at least visible from both ends rather than silent.
  insert into merchants (agent_id, dba, legal_business_name, status,
                         split_agent_pct, split_company_pct, pre_app_id)
  values (pa.agent_id, pa.dba_name, pa.legal_business_name, 'active',
          pa.split_agent_pct, pa.split_company_pct, pa.id)
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
  --
  -- 'Ghost sheet' rather than 'ghost_sheet'. lead_source is free text a rep
  -- types ("Referral", "Cold call", "Web form") and it renders raw on the lead
  -- page, so the machine-shaped value stood out as the one entry nobody wrote.
  insert into leads (agent_id, dba, contact_name, contact_phone, lead_source, status)
  values (sheet.agent_id, sheet.dba, sheet.contact_name, sheet.contact_phone,
          'Ghost sheet', 'open')
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
--   authenticated the 13 non-secret tables, one verb at a time: a verb is
--                 granted only where a policy backs it, so the two layers
--                 agree table-for-table. RLS is still the enforcement
--                 layer and is what the tests assert — the grant is the
--                 second lock, and it is what makes an unbacked write
--                 fail loudly instead of quietly. Four tables are
--                 therefore narrower than the standard four verbs; see
--                 the rule restated above the list below.
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

-- A plain `grant` only ADDS. On a project created before Supabase's
-- always-revoked default, every table in `public` already carried a legacy
-- blanket grant to `authenticated`, so layering the intended verbs on top left
-- the extras in place -- and `ALL` includes TRUNCATE, which **RLS does not
-- filter**. The audit found exactly that on both the local stack and the linked
-- project. So the model has to be stated subtractively first; see the
-- revoke-from-authenticated block further down.
--
-- The rule this list follows: a verb is granted only where a policy backs it.
-- A grant with no matching policy is dead weight that fails the quiet way --
-- the privilege check passes, RLS filters the statement to zero rows, and the
-- caller sees a save that did nothing. Four tables are therefore narrower than
-- the rest, and each exception is stated where the table is defined. As of
-- 20260812143407 the rule holds with no exceptions left: every verb below is
-- backed by a policy, and every policy has its verb.
grant select, insert, update, delete on
  merchants,
  leads,
  ghost_sheets,
  pre_apps,
  pre_app_owners,
  pre_app_terminal,
  pre_app_business_profile,
  support_tickets,
  tasks
to authenticated;

-- documents: no UPDATE. Nothing edits a document row in place; it is replaced
-- by a new upload plus a delete.
grant select, insert, delete on documents to authenticated;

-- notes: no UPDATE either, for a different reason -- append-only by design, so
-- that a note can be added and removed but never silently rewritten. Same
-- shape, same argument as documents: the missing policy already denied the
-- write, and revoking the grant is what makes it deny loudly.
grant select, insert, delete on notes to authenticated;

-- support_ticket_replies: append-only, so the same three verbs as notes. The
-- table was created this way rather than narrowed later, which is the point of
-- stating the rule above -- a new table gets the verbs its policies back, and
-- no more.
grant select, insert, delete on support_ticket_replies to authenticated;

-- bug_reports: no DELETE, and that is the whole design rather than an omission
-- -- a report is cleared by setting status, so the row survives for review. The
-- UPDATE here is backed by the admin-only "admin resolves" policy, so a rep
-- holds the privilege but no policy admits their write.
grant select, insert, update on bug_reports to authenticated;

-- profiles: SELECT only, matching its single SELECT policy. Every write is a
-- security definer RPC or a service-role Edge Function, both of which bypass
-- grants entirely, so nothing legitimate loses access here. The INSERT/UPDATE/
-- DELETE grants this table used to carry were backed by no policy at all after
-- "admin manages profiles" was dropped -- three dead grants on the table that
-- decides who is an admin.
grant select on profiles to authenticated;

-- audit_log is SELECT-only, and deliberately not in the list above.
--
-- It is the tamper-evidence table: everything else in this schema can be
-- reconstructed or corrected, but a forged or erased audit row destroys the one
-- record of who did what. Until now its INSERT/UPDATE/DELETE grants were held
-- back by nothing but the absence of a policy for those verbs -- one permissive
-- policy, or one `disable row level security`, and any signed-in rep could
-- rewrite the trail.
--
-- Nothing legitimate loses access. Every writer is either a `security definer`
-- function (which runs as the owner and bypasses both RLS and grants -- see
-- log_cross_agent_change and the pre-app RPCs) or a service-role Edge Function.
grant select on audit_log to authenticated;

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
  support_ticket_replies_id_seq,
  notes_id_seq,
  tasks_id_seq,
  bug_reports_id_seq
to authenticated;
-- audit_log_id_seq is deliberately absent, to match audit_log's SELECT-only
-- grant above. Nothing `authenticated` can do consumes it: every audit_log
-- insert comes from a security definer function (running as the owner) or a
-- service-role Edge Function, neither of which needs this grant. What it left
-- reachable was small but pointed the wrong way -- nextval() through any
-- security invoker RPC burns ids and puts gaps in the sequence of the one
-- table whose job is tamper evidence.

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

-- The same treatment for `authenticated`, and it was missing for a long time.
--
-- The blanket revoke above names only `anon`, and `alter default privileges`
-- (below) binds FUTURE objects only -- so the 13 tables that already existed
-- kept their legacy `GRANT ALL` to `authenticated`. The audit confirmed it on
-- the local stack and on the linked project: `GRANT ALL ON TABLE ... TO
-- "authenticated"` everywhere, where this document said
-- `select, insert, update, delete`.
--
-- What `ALL` adds beyond those four verbs:
--
--   TRUNCATE   -- and **RLS does not apply to TRUNCATE**. Every row-level
--                protection in this schema is silent on it.
--   REFERENCES -- allows pointing a foreign key at the table.
--   TRIGGER    -- allows attaching a trigger to it.
--
-- Not reachable through the API today: PostgREST issues only
-- SELECT/INSERT/UPDATE/DELETE, and no `security invoker` RPC here contains a
-- TRUNCATE, so exploiting it needs a direct Postgres connection as a role that
-- has no password. It is removed because "unreachable" is a property of today's
-- surface, not a guarantee, and because a grant that contradicts the documented
-- model is exactly the drift the whole grants-versus-RLS section exists to
-- prevent.
--
-- Order matters: revoke first, then the explicit grants above are what remains.
-- Sequences go back to USAGE alone -- the legacy grant included UPDATE, i.e.
-- setval(), which would let a client reset an id sequence into collisions.
revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from authenticated;

-- Trigger functions hold no grant at all: a trigger fires whether or not the
-- querying role holds EXECUTE, so a grant widens the surface for nothing. The
-- linked project had `set_updated_at()` granted to `authenticated` from the same
-- legacy default -- harmless in practice, since Postgres refuses a direct call
-- to a function returning `trigger`, but it is not supposed to be there.
revoke all on function set_updated_at() from authenticated;
revoke all on function pre_apps_guard_transitions() from authenticated;
revoke all on function log_cross_agent_change() from authenticated;

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
-- `ensure_rls` / `rls_auto_enable()` — the RLS backstop. ADOPTED into the
-- migrations on 2026-08-11 by 20260811150000. Until then it existed on the
-- hosted project and nowhere else, and that divergence — not the missing
-- convenience — is what this section used to warn about and what adopting
-- it removes.
--
-- PROVENANCE. Read off ref vdjtosofrimipklbdjbi on 2026-08-05:
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
-- So every new table gets RLS switched on for free, and quietly does not
-- if the attempt fails.
--
-- It arrived without a migration behind it: absent from every commit on
-- every ref, from the Supabase CLI package, and from every other
-- environment. The style — RAISE LOG lines, defensive pg_toast%/pg_temp%
-- filters, a blanket EXCEPTION WHEN OTHERS, `set search_path to
-- 'pg_catalog'` — matches nothing else in this repo, so it was installed
-- out-of-band through the Dashboard SQL editor or a Supabase advisor
-- action. Who and when is answerable only from the Dashboard's SQL editor
-- history or the org audit log.
--
-- It is owned by `postgres`, whereas the platform's own event triggers are
-- owned by `supabase_admin` — so it was almost certainly not shipped by
-- Supabase, and nobody should assume it is maintained, upgraded or
-- restored for us. That is not an argument for leaving it alone; it is the
-- argument for owning it deliberately, which is what the migration does.
--
-- WHY IT WAS ADOPTED, rather than dropped or left where it was.
--
-- Dropping it would have deleted a backstop that demonstrably works, from
-- the one environment holding real data, purely to buy consistency.
--
-- Leaving it alone kept the part that actually hurts. A migration that
-- forgets `alter table ... enable row level security` produced two
-- DIFFERENT bugs depending on where it ran. On the hosted project the
-- table came up RLS-enabled with no policies, which denies everyone and
-- reads as a broken feature. Everywhere else the same table was wide open,
-- which is a data leak. Same SQL, opposite failure — and the environment
-- where it looked fine was the one nobody tests against. That is worse
-- than the net not existing at all, and it is the divergence CLAUDE.md
-- warns about under "Do not rely on ensure_rls".
--
-- Adopting it keeps the backstop AND closes the divergence. The local
-- stack, the PGlite suite and any fresh project built from these
-- migrations now behave the way production already did, so a forgotten
-- `enable row level security` fails the same way everywhere — and the net
-- can be ASSERTED instead of described. tests/rls/grants.test.ts,
-- "auto-enables RLS on a table a future migration forgets", is that
-- assertion: it creates a table that never asks for RLS and requires
-- relrowsecurity to come back true.
--
-- The adoption is a no-op on the hosted project by construction. The
-- function below is reproduced verbatim from it — re-verified against
-- `supabase db dump --linked` on 2026-08-11, identical modulo pg_dump's
-- quoting and case — and the event trigger is created only when absent.
--
-- WHERE IT NOW EXISTS:
--   * The hosted project (ref vdjtosofrimipklbdjbi), unchanged, since
--     2026-08-05 or earlier.
--   * The local CLI stack, from 20260811150000. Its event triggers are now
--     ensure_rls, issue_graphql_placeholder, issue_pg_cron_access,
--     issue_pg_graphql_access, issue_pg_net_access, pgrst_ddl_watch and
--     pgrst_drop_watch — verified 2026-08-11. (Before adoption this list
--     was the same six minus ensure_rls, which is what the old version of
--     this note recorded.)
--   * The PGlite suite (tests/helpers/db.ts), which applies the same
--     migrations over its three-role auth shim. PGlite does run event
--     triggers — the test named above is the proof, and it passes.
--   * Any fresh project built from this file or from supabase/migrations/,
--     because the DDL below is now part of both.
--
-- WHERE IT STILL DOES NOT EXIST, and must not be assumed:
--   * Any clone made with `supabase db dump`. The CLI's dump script does
--     not emit `CREATE EVENT TRIGGER` at all — verified against the
--     2026-08-11 linked dump, which carries the rls_auto_enable() function
--     and zero occurrences of `CREATE EVENT TRIGGER`. A dump-based restore
--     therefore arrives with the function defined and nothing calling it,
--     which is the worst shape available: it LOOKS present in the schema.
--     Re-run 20260811150000, or create the trigger by hand, after any
--     restore of that kind.
--
-- THE RULE IS UNCHANGED AND UNCONDITIONAL. Every new table still spells
-- out `alter table ... enable row level security` and its four policies in
-- the migration that creates it. What changed is only the standing of the
-- net: it is a deliberate, version-controlled backstop now rather than one
-- that happened to be there. It is still a net and not a policy — it
-- enables RLS and adds no policies, so a table it catches denies everyone.
-- Belt and braces, in that order.
-- =====================================================================

-- security definer is required: it runs ALTER TABLE on tables it does not
-- own. search_path is pinned to pg_catalog so a temp-table shadow cannot
-- redirect any of the catalog lookups.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;

-- An event-trigger function is never called directly — Postgres refuses a
-- call to anything returning `event_trigger` — so no role needs EXECUTE.
-- The hosted project had it granted to `authenticated` from the same
-- legacy default that produced the M1 table-grant finding: harmless, and
-- removed here for tidiness.
revoke all on function public.rls_auto_enable() from public;
revoke all on function public.rls_auto_enable() from anon, authenticated;

-- The event trigger is guarded three ways, because this is the half that
-- may legitimately fail:
--
--   1. It ALREADY EXISTS on the hosted project, so a bare CREATE would
--      abort the push. pg_event_trigger is checked first.
--   2. CREATE EVENT TRIGGER normally requires superuser. `postgres` can
--      create one on the local stack despite not being a superuser
--      (verified), but the hosted migration role may refuse it, so
--      insufficient_privilege degrades to a NOTICE rather than blocking an
--      otherwise good migration — production already has the trigger,
--      which is the whole reason the adoption is safe.
--   3. Anything else is re-raised, so a genuine mistake here is not
--      swallowed the way the function's own handler swallows per-table
--      failures.
--
-- Deliberately last in this file. Built top-to-bottom, every table above
-- has already declared its own RLS, so arming the trigger here changes
-- nothing retroactively — it is armed for what comes next.
do $$
begin
  if exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    raise notice 'ensure_rls already exists — leaving it alone';
  else
    create event trigger ensure_rls
      on ddl_command_end
      execute function public.rls_auto_enable();
    raise notice 'ensure_rls created';
  end if;
exception
  when insufficient_privilege then
    raise notice
      'ensure_rls not created: the migration role lacks superuser. The function is in place; create the trigger from the dashboard if this environment needs it.';
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
