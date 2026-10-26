-- The business tax ID (EIN, or an SSN used as one) moves into a FOURTH
-- encrypted secrets table, and the plaintext pre_apps.ein_number is dropped.
--
-- Phase 3 of docs/design/intake-and-reports.md (§5). Matches
-- docs/tapswipe_crm_schema.sql, updated first.
--
-- pre_app_tax_secrets is built exactly as the three existing *_secrets tables
-- are: unique parent reference, ON DELETE CASCADE from pre_apps, key_version,
-- RLS enabled with ZERO policies, and no grant to anon or authenticated. The
-- only way in or out is the two secrets Edge Functions on the service role.
--
-- REFUSES TO RUN while any pre_apps.ein_number value exists. The encryption
-- key lives only in Edge Function secrets, so a SQL migration cannot carry a
-- plaintext EIN into the encrypted table -- dropping the column over a value
-- would destroy it. Prod and dev were reset and hold no real pre-apps, so the
-- check passes there. If it ever fails, the fix is the memo's one-off
-- service-role script (encrypt and insert every value through the function,
-- verify counts, set the column to NULL), then re-run -- never a retry.
-- The message names the pre-app ids, never the numbers.
--
-- It also refuses a pre_apps.ein_type outside ('EIN', 'SSN'), naming the
-- values (they describe the identifier, not the number), because the CHECK
-- below cannot be added over them and rewriting someone's choice is the quiet
-- data change this repo does not do. Phase 1's rule: refuse the rows the
-- change would break, never merely "the table has rows".

do $$
declare
  holders text;
  bad_types text;
begin
  select string_agg(id::text, ', ' order by id)
    into holders
    from pre_apps
   where ein_number is not null;
  if holders is not null then
    raise exception 'pre_app_tax_secrets migration refuses to run: pre_apps.ein_number holds a value on pre-app(s) %. The encryption key lives only in the Edge Functions, so this migration cannot move those numbers into pre_app_tax_secrets, and dropping the column would destroy them. Re-enter each through submit-pre-app-secrets (or the one-off service-role script in docs/design/intake-and-reports.md §5), set ein_number to NULL, then re-run.', holders;
  end if;

  select string_agg(distinct quote_literal(ein_type), ', ' order by quote_literal(ein_type))
    into bad_types
    from pre_apps
   where ein_type is not null
     and ein_type not in ('EIN', 'SSN');
  if bad_types is not null then
    raise exception 'pre_app_tax_secrets migration refuses to run: pre_apps.ein_type holds values outside (EIN, SSN): %. Map them to EIN or SSN (or NULL) deliberately, then re-run.', bad_types;
  end if;
end;
$$;

alter table pre_apps drop column ein_number;

alter table pre_apps
  add constraint pre_apps_ein_type_check check (ein_type in ('EIN', 'SSN'));

-- ---------------------------------------------------------------------
-- The fourth secrets table. Constraint names are the ones Postgres would
-- generate inline (pre_app_tax_secrets_pre_app_id_key / _fkey), matching
-- the three others, so tests can pin them by name.
-- ---------------------------------------------------------------------
create table pre_app_tax_secrets (
  id serial primary key,
  pre_app_id int references pre_apps(id) on delete cascade not null unique,
  -- Which validator accepted the value, and so what the ciphertext holds.
  -- Written by submit-pre-app-secrets, which refuses one that differs from
  -- the pre-app's current ein_type. Plaintext: it says what the number is,
  -- not what it is.
  tax_id_type text not null
    constraint pre_app_tax_secrets_tax_id_type_check check (tax_id_type in ('EIN', 'SSN')),
  tax_id_encrypted bytea not null,
  key_version smallint not null default 1
);

-- Written even though ensure_rls would switch it on: that backstop is skipped
-- where the migration role is not superuser and swallows its own failures.
alter table pre_app_tax_secrets enable row level security;
-- intentionally zero policies for `authenticated` — service role only

-- The second lock. revoke all first: on the local stack pg_default_acl hands
-- new tables to roles nobody listed here (phase 1 build note), and PGlite has
-- no such default, so starting from nothing makes both end in the same place.
-- service_role gets what it holds on the other three: everything.
revoke all on pre_app_tax_secrets from public, anon, authenticated, service_role;
revoke all on sequence pre_app_tax_secrets_id_seq from public, anon, authenticated, service_role;
grant all on pre_app_tax_secrets to service_role;
grant all on sequence pre_app_tax_secrets_id_seq to service_role;

-- ---------------------------------------------------------------------
-- submit_pre_app(): the MINIMAL change. One new rule, checked last: a tax-id
-- row of the pre-app's current ein_type must exist. Everything else in the
-- body is unchanged from 20261013132000. Phase 4 replaces this hand-written
-- list with pre_app_missing_fields(), which will carry the rule as its
-- 'tax_id' code.
-- ---------------------------------------------------------------------
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
  tax_type_on_file text;
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

  -- The business location (20261013132000). approve_pre_app() refuses a
  -- pre-app without one, because a merchant cannot be created without a city
  -- and state (merchants_location_guard) -- so the gap has to be closed HERE,
  -- where the rep can still fix it, rather than at approval, where the only
  -- move is to reopen. Same rule as approve_pre_app() and the merchant
  -- format check, so a pre-app this accepts is one approval accepts.
  -- Deliberately a submit-time rule and NOT a table constraint on pre_apps:
  -- a draft is saved field by field as it is typed, and must be allowed to
  -- have no address yet.
  if coalesce(char_length(norm_city(pa.city)) < 2, true)
     or char_length(btrim(pa.city)) > 60
     or coalesce(upper(btrim(pa.state)) !~ '^[A-Z]{2}$', true) then
    raise exception 'a business city and a two-letter state are required'
      using errcode = 'PT422';
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

  -- The business tax ID (20261026140000; phase 3 of
  -- docs/design/intake-and-reports.md). Existence only, as above: a row in
  -- pre_app_tax_secrets OF THE CHOSEN KIND. Only submit-pre-app-secrets can
  -- write that row, and only after the value passed the EIN or SSN validator
  -- for this type, so the value's validity is the write path's guarantee, not
  -- this check's. The kind comparison is what makes switching ein_type after
  -- the number was entered force the number to be entered again. Phase 4
  -- moves this rule, with every other one, into pre_app_missing_fields().
  if not exists (
    select 1 from pre_app_tax_secrets t
     where t.pre_app_id = pa.id and t.tax_id_type = pa.ein_type
  ) then
    if pa.ein_type is null then
      raise exception 'an EIN type (EIN or SSN) and the tax ID are required'
        using errcode = 'PT422';
    end if;
    select t.tax_id_type into tax_type_on_file
      from pre_app_tax_secrets t where t.pre_app_id = pa.id;
    if tax_type_on_file is not null then
      raise exception 'the tax ID on file is an %, but EIN type says %. Enter the %.',
        tax_type_on_file, pa.ein_type, pa.ein_type using errcode = 'PT422';
    end if;
    raise exception 'the % (tax ID) has not been entered', pa.ein_type
      using errcode = 'PT422';
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

revoke all on function submit_pre_app(int) from public;
grant execute on function submit_pre_app(int) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- pre_app_secrets_presence() gains tax_id_on_file (a row of the CURRENT
-- ein_type exists -- what submit_pre_app() counts) and tax_id_type_on_file
-- (the stored row's kind, plaintext metadata, so the wizard can say the kind
-- no longer matches). Existence and kind only: still no *_encrypted column
-- named. A new return type cannot be made by create or replace, so the
-- function is dropped and recreated, and its two privilege lines with it.
-- The rest of the body is unchanged from 20260810152129.
-- ---------------------------------------------------------------------
drop function pre_app_secrets_presence(int);

create or replace function pre_app_secrets_presence(pre_app_id_input int)
returns table (
  banking_on_file boolean,
  owners_missing_ssn int,
  tax_id_on_file boolean,
  tax_id_type_on_file text
)
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

  -- Existence and counting only. No *_encrypted column is named anywhere in
  -- this body, so no ciphertext can leave even though the definer privilege
  -- could read one. tests/rls/pre-app-secrets-presence.test.ts pins that from
  -- pg_get_functiondef rather than trusting this comment.
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
      ),
      exists (
        select 1 from pre_app_tax_secrets t
         where t.pre_app_id = pa.id and t.tax_id_type = pa.ein_type
      ),
      (select t.tax_id_type from pre_app_tax_secrets t where t.pre_app_id = pa.id);
end;
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function and PUBLIC includes
-- anon, so without these two lines this RPC would be callable unauthenticated
-- from the moment it exists. There is no declarative backstop for functions.
revoke all on function pre_app_secrets_presence(int) from public;
grant execute on function pre_app_secrets_presence(int) to authenticated, service_role;
