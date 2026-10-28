-- One required-fields function, the rep's split rate, and country fixed to US.
--
-- Phase 4 of docs/design/intake-and-reports.md (§6, §7.1, §0b.4, §9 A13/A14/
-- A16). Matches docs/tapswipe_crm_schema.sql, updated first.
--
--   1. profiles.split_rate_pct (default 50, 0-50) and set_rep_split(), its only
--      write path: admin-only, audited, security definer -- the
--      set_rep_identity() shape.
--   2. pre_apps gains the submit-time snapshot columns rep_legal_name and
--      rep_llc_legal_name; the existing split_agent_pct / split_company_pct
--      become the snapshot of the rep's rate. All four are written only by
--      submit_pre_app() (and the other state-machine RPCs' flag), enforced in
--      pre_apps_guard_transitions -- an admin included.
--   3. pre_apps.split_agent_pct is 0-50. (merchants gets the same bound in
--      phase 8, with set_merchant_split(): nothing reads the merchant split
--      until then, and the shared test fixture holds 55/60/70 merchants.)
--   4. pre_apps.country and pre_app_owners.home_country are fixed to 'US':
--      not null, default 'US', CHECK = 'US' (memo A14).
--   5. pre_app_missing_fields(): EVERY missing item at once, each with a stable
--      code. submit_pre_app() refuses with the whole list and the wizard's
--      review step shows the same list by calling the same function.
--
-- GUARD. Phase 1's rule: refuse the rows the change would break, and say
-- which. A split over 50 and a country other than US are refused, naming the
-- rows; they are someone's recorded choice and are not rewritten here.
--
-- A NULL country IS filled in with 'US', on pre-apps and owners alike. It is
-- the one value the column can now hold, and the field is no longer editable,
-- so leaving it null would strand a draft with a missing item no one can
-- clear. That is a default being applied, not a choice being overwritten. It
-- runs with the state-machine flag on, because pre_apps_guard_transitions and
-- pre_app_children_guard refuse a non-admin edit of a non-draft and a
-- migration is not an admin. The cross-agent audit trigger records each
-- pre-app it touches (actor null: the migration).

do $$
declare
  bad text;
begin
  select string_agg(format('pre-app %s (%s)', id, split_agent_pct), ', ' order by id)
    into bad from pre_apps where split_agent_pct < 0 or split_agent_pct > 50;
  if bad is not null then
    raise exception 'pre_app_required_fields migration refuses to run: split_agent_pct is outside 0-50 on %. The rep split is now at most 50 (docs/design/intake-and-reports.md §0b.4). Correct those rows deliberately, then re-run.', bad;
  end if;

  select string_agg(distinct quote_literal(country), ', ')
    into bad from pre_apps where country is not null and country <> 'US';
  if bad is not null then
    raise exception 'pre_app_required_fields migration refuses to run: pre_apps.country holds values other than US: %. Only US merchants are supported (memo A14). Map them deliberately, then re-run.', bad;
  end if;

  select string_agg(distinct quote_literal(home_country), ', ')
    into bad from pre_app_owners where home_country is not null and home_country <> 'US';
  if bad is not null then
    raise exception 'pre_app_required_fields migration refuses to run: pre_app_owners.home_country holds values other than US: %. Only US addresses are supported (memo A14). Map them deliberately, then re-run.', bad;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 1. profiles.split_rate_pct and set_rep_split()
--
-- The rep's share of a merchant's residual, in percent (§0b.4). Default 50,
-- 0-50, 0.01 steps. The house profile (agent code 122) is set to 0 by an admin
-- after this migration; no rate is hard-coded here.
--
-- NEVER IN A POLICY, never client-writable: profiles has no UPDATE grant or
-- policy, so set_rep_split() is the only write path. It is copied onto a
-- pre-app at submit, and from there onto the merchant at approval; a later
-- change here changes neither.
-- ---------------------------------------------------------------------
alter table profiles
  add column if not exists split_rate_pct numeric(5,2) not null default 50
    constraint profiles_split_rate_pct_range check (split_rate_pct between 0 and 50);

-- The set_rep_identity() shape (20261026120000): security definer, pinned
-- search_path, is_admin() first (is_admin() requires is_active). Audited as
-- 'set_rep_split' in the same transaction as the update, with no exception
-- handler, so a failed audit insert rolls the change back (fails closed). No
-- change, no audit row.
--
-- The rate is refused rather than rounded when it has more than two decimals:
-- numeric(5,2) would round 46.555 to 46.56 silently, and a money rate that is
-- not what the admin typed is the wrong kind of helpful.
create or replace function set_rep_split(user_id uuid, rate numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_rate numeric(5,2);
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if set_rep_split.rate is null then
    raise exception 'a split rate is required' using errcode = 'PT400';
  end if;
  if set_rep_split.rate < 0 or set_rep_split.rate > 50 then
    raise exception 'the split rate must be between 0 and 50' using errcode = 'PT400';
  end if;
  if set_rep_split.rate <> round(set_rep_split.rate, 2) then
    raise exception 'the split rate has at most two decimal places' using errcode = 'PT400';
  end if;

  select p.split_rate_pct into current_rate
    from profiles p where p.id = set_rep_split.user_id;
  if not found then
    raise exception 'user not found' using errcode = 'PT404';
  end if;

  if current_rate = set_rep_split.rate then
    return;
  end if;

  update profiles
     set split_rate_pct = set_rep_split.rate
   where id = set_rep_split.user_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_rep_split', 'profiles', set_rep_split.user_id::text);
end;
$$;

-- PUBLIC (which includes anon) gets EXECUTE on every new function and nothing
-- declarative revokes it. Without these lines this RPC would be callable
-- unauthenticated from the moment it exists.
revoke all on function set_rep_split(uuid, numeric) from public;
grant execute on function set_rep_split(uuid, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2-4. Columns and CHECKs on pre_apps and pre_app_owners.
-- ---------------------------------------------------------------------

-- The rep identity snapshot (memo §7.1). Written by submit_pre_app() from the
-- pre-app's rep's profile; a later set_rep_identity() changes no submitted
-- pre-app. The LLC column falls back to the rep's own legal name (A16).
alter table pre_apps
  add column if not exists rep_legal_name text,
  add column if not exists rep_llc_legal_name text;

alter table pre_apps
  add constraint pre_apps_split_agent_pct_range check (split_agent_pct between 0 and 50);

select set_config('tapswipe.pre_app_transition', 'on', true);
update pre_apps set country = 'US' where country is null;
update pre_app_owners set home_country = 'US' where home_country is null;
select set_config('tapswipe.pre_app_transition', '', true);

alter table pre_apps
  alter column country set default 'US',
  alter column country set not null,
  add constraint pre_apps_country_us check (country = 'US');

alter table pre_app_owners
  alter column home_country set default 'US',
  alter column home_country set not null,
  add constraint pre_app_owners_home_country_us check (home_country = 'US');

-- ---------------------------------------------------------------------
-- pre_apps_guard_transitions(): the snapshot columns join status and
-- date_submitted as RPC-only. Outside the state-machine flag, nobody -- an
-- admin included -- writes split_agent_pct, split_company_pct, rep_legal_name
-- or rep_llc_legal_name. On INSERT they must be the defaults (50/50, null).
-- The rest of the body is 20260916104500's.
-- ---------------------------------------------------------------------
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

  if tg_op = 'INSERT' then
    if new.status is distinct from 'draft' then
      raise exception
        'a pre-app is created as a draft; status moves only through submit_pre_app(), approve_pre_app(), decline_pre_app() or reopen_pre_app()'
        using errcode = 'PT409';
    end if;

    if new.date_submitted is not null then
      raise exception 'date_submitted is set by submit_pre_app()' using errcode = 'PT409';
    end if;

    -- The split and the rep's names are snapshotted by submit_pre_app()
    -- from the rep's profile (memo §0b.4, §7.1). A draft carries the
    -- defaults; nothing a client sends can pre-load them.
    if new.split_agent_pct is distinct from 50
       or new.split_company_pct is distinct from 50
       or new.rep_legal_name is not null
       or new.rep_llc_legal_name is not null then
      raise exception 'the split and the rep''s legal names are set by submit_pre_app() from the rep''s profile'
        using errcode = 'PT409';
    end if;

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

  if new.split_agent_pct is distinct from old.split_agent_pct
     or new.split_company_pct is distinct from old.split_company_pct
     or new.rep_legal_name is distinct from old.rep_legal_name
     or new.rep_llc_legal_name is distinct from old.rep_llc_legal_name then
    raise exception 'the split and the rep''s legal names are set by submit_pre_app() from the rep''s profile'
      using errcode = 'PT409';
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

-- ---------------------------------------------------------------------
-- 5. pre_app_missing_fields(pre_app_id_input int) returns jsonb
--
-- [{"code", "step", "label"}, ...] -- every item that blocks submission, in
-- wizard order, empty when the pre-app is submittable. Owner items also carry
-- "owner_id". Codes are stable (lib/pre-app-required.ts lists them, and
-- tests/unit/pre-app-required.test.ts pins that list to this body); labels are
-- written for a rep to read.
--
-- security definer, because it must see the zero-grant secrets tables. It
-- names no *_encrypted column: existence and kind only. The caller guard is
-- byte-for-byte pre_app_secrets_presence()'s, so "not yours" and "does not
-- exist" stay indistinguishable. Codes and labels only, never a value -- the
-- one exception is an owner's own name inside an owner label, which the
-- caller can already read on pre_app_owners.
--
-- No status check: the review step asks for any draft, and submit_pre_app()
-- checks status itself before calling this.
-- ---------------------------------------------------------------------
create or replace function pre_app_missing_fields(pre_app_id_input int)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  ws constant text := E' \t\n\r\f\x0b';
  pa pre_apps;
  rep profiles;
  bp pre_app_business_profile;
  o record;
  items jsonb := '[]'::jsonb;
  owner_count int;
  control_count int;
  tax_type_on_file text;
  who text;
  tax_step text;
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

  -- Business --------------------------------------------------------------
  if coalesce(btrim(pa.dba_name, ws), '') = '' then
    items := items || jsonb_build_object('code', 'dba_name', 'step', 'business',
      'label', 'A DBA name is required.');
  end if;
  if coalesce(btrim(pa.legal_business_name, ws), '') = '' then
    items := items || jsonb_build_object('code', 'legal_business_name', 'step', 'business',
      'label', 'A legal business name is required.');
  end if;
  if coalesce(btrim(pa.contact_phone, ws), '') = '' then
    items := items || jsonb_build_object('code', 'contact_phone', 'step', 'business',
      'label', 'A contact phone is required.');
  end if;
  if coalesce(btrim(pa.physical_address, ws), '') = '' then
    items := items || jsonb_build_object('code', 'physical_address', 'step', 'business',
      'label', 'A business street address is required.');
  end if;
  -- The location rule (20261013132000), moved here: the same test
  -- approve_pre_app() and merchants_location_guard apply, so a pre-app this
  -- accepts is one approval accepts.
  if coalesce(char_length(norm_city(pa.city)) < 2, true)
     or char_length(btrim(pa.city)) > 60 then
    items := items || jsonb_build_object('code', 'city', 'step', 'business',
      'label', 'A business city is required.');
  end if;
  if coalesce(upper(btrim(pa.state)) !~ '^[A-Z]{2}$', true) then
    items := items || jsonb_build_object('code', 'state', 'step', 'business',
      'label', 'A two-letter business state is required.');
  end if;
  if coalesce(btrim(pa.zip, ws), '') !~ '^\d{5}(-\d{4})?$' then
    items := items || jsonb_build_object('code', 'zip', 'step', 'business',
      'label', 'A business ZIP code is required.');
  end if;
  -- Always 'US' while pre_apps_country_us stands; checked anyway so the rule
  -- lives in the one list and survives that CHECK being relaxed.
  if pa.country is distinct from 'US' then
    items := items || jsonb_build_object('code', 'country', 'step', 'business',
      'label', 'The business country must be United States.');
  end if;
  if coalesce(btrim(pa.legal_entity_type, ws), '') = '' then
    items := items || jsonb_build_object('code', 'legal_entity_type', 'step', 'business',
      'label', 'An entity type is required.');
  end if;
  if coalesce(upper(btrim(pa.state_incorporated)) !~ '^[A-Z]{2}$', true) then
    items := items || jsonb_build_object('code', 'state_incorporated', 'step', 'business',
      'label', 'A state of incorporation is required.');
  end if;
  if coalesce(btrim(pa.business_type, ws), '') = '' then
    items := items || jsonb_build_object('code', 'business_type', 'step', 'business',
      'label', 'A business type is required.');
  end if;
  if coalesce(btrim(pa.bank_name, ws), '') = '' then
    items := items || jsonb_build_object('code', 'bank_name', 'step', 'business',
      'label', 'A bank name is required.');
  end if;
  -- Required and above zero (memo A13): a zero estimate is a placeholder.
  if coalesce(pa.est_annual_volume, 0) <= 0 then
    items := items || jsonb_build_object('code', 'est_annual_volume', 'step', 'business',
      'label', 'Estimated annual volume must be more than zero.');
  end if;
  if coalesce(pa.est_monthly_volume, 0) <= 0 then
    items := items || jsonb_build_object('code', 'est_monthly_volume', 'step', 'business',
      'label', 'Estimated monthly volume must be more than zero.');
  end if;
  if coalesce(pa.est_average_ticket, 0) <= 0 then
    items := items || jsonb_build_object('code', 'est_average_ticket', 'step', 'business',
      'label', 'Estimated average ticket must be more than zero.');
  end if;
  if coalesce(pa.est_high_ticket, 0) <= 0 then
    items := items || jsonb_build_object('code', 'est_high_ticket', 'step', 'business',
      'label', 'Estimated high ticket must be more than zero.');
  end if;

  -- Tax ID (the phase 3 rule, 20261026140000). A row in pre_app_tax_secrets
  -- OF THE CHOSEN KIND; only submit-pre-app-secrets writes one, after the
  -- value passed the EIN or SSN validator for that kind. Three labels, one
  -- code. The step is where the fix is: the type on Business, the number on
  -- Sensitive data.
  if not exists (
    select 1 from pre_app_tax_secrets t
     where t.pre_app_id = pa.id and t.tax_id_type = pa.ein_type
  ) then
    select t.tax_id_type into tax_type_on_file
      from pre_app_tax_secrets t where t.pre_app_id = pa.id;
    tax_step := case when pa.ein_type is null then 'business' else 'secrets' end;
    items := items || jsonb_build_object('code', 'tax_id', 'step', tax_step,
      'label', case
        when pa.ein_type is null then
          'Choose an EIN type (EIN or SSN), then enter the tax ID.'
        when tax_type_on_file is not null then
          format('The tax ID on file is an %s, but EIN type says %s. Enter the %s.',
                 tax_type_on_file, pa.ein_type, pa.ein_type)
        else format('The %s (tax ID) has not been entered.', pa.ein_type)
      end);
  end if;

  -- Owners ----------------------------------------------------------------
  select count(*), count(*) filter (where percent_owned >= 51)
    into owner_count, control_count
    from pre_app_owners where pre_app_id = pa.id;

  if owner_count = 0 then
    items := items || jsonb_build_object('code', 'owner_required', 'step', 'owners',
      'label', 'Add at least one owner.');
  elsif control_count = 0 then
    -- A genuine 50/50 partnership cannot be submitted: processors want one
    -- control person. The label has to read as a rule, not a bug.
    items := items || jsonb_build_object('code', 'owner_control', 'step', 'owners',
      'label', 'One owner must hold at least 51% ownership.');
  end if;

  for o in
    select ow.*, row_number() over (order by ow.id) as n
      from pre_app_owners ow
     where ow.pre_app_id = pa.id
     order by ow.id
  loop
    who := format('Owner %s%s', o.n,
      case when coalesce(btrim(o.owner_name, ws), '') = '' then ''
           else format(' (%s)', btrim(o.owner_name, ws)) end);

    items := items || (
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', f.code, 'step', 'owners', 'owner_id', o.id,
               'label', format('%s: %s is required.', who, f.label))
             order by f.ord), '[]'::jsonb)
        from (values
          (1,  'owner_name',               'name',               coalesce(btrim(o.owner_name, ws), '') = ''),
          (2,  'owner_title',              'title',              coalesce(btrim(o.title, ws), '') = ''),
          (3,  'owner_percent_owned',      'percent owned',      coalesce(o.percent_owned, 0) <= 0),
          (4,  'owner_dob',                'date of birth',      o.dob is null),
          (5,  'owner_home_phone',         'home phone',         coalesce(btrim(o.home_phone, ws), '') = ''),
          (6,  'owner_id_type',            'ID type',            coalesce(btrim(o.id_type, ws), '') = ''),
          (7,  'owner_id_number',          'ID number',          coalesce(btrim(o.id_number, ws), '') = ''),
          (8,  'owner_id_state',           'ID state',           coalesce(upper(btrim(o.id_state)) !~ '^[A-Z]{2}$', true)),
          (9,  'owner_id_issue_date',      'ID issue date',      o.id_issue_date is null),
          (10, 'owner_id_expiration_date', 'ID expiration date', o.id_expiration_date is null),
          (11, 'owner_home_address',       'home street address', coalesce(btrim(o.home_address, ws), '') = ''),
          (12, 'owner_home_city',          'home city',          coalesce(btrim(o.home_city, ws), '') = ''),
          (13, 'owner_home_state',         'home state',         coalesce(upper(btrim(o.home_state)) !~ '^[A-Z]{2}$', true)),
          (14, 'owner_home_zip',           'home ZIP code',      coalesce(btrim(o.home_zip, ws), '') !~ '^\d{5}(-\d{4})?$'),
          (15, 'owner_home_country',       'home country (United States)', o.home_country is distinct from 'US'),
          (16, 'owner_length_of_ownership','length of ownership', coalesce(btrim(o.length_of_ownership, ws), '') = '')
        ) as f(ord, code, label, missing)
       where f.missing
    );

    if not exists (select 1 from pre_app_owner_secrets s where s.pre_app_owner_id = o.id) then
      items := items || jsonb_build_object('code', 'owner_ssn', 'step', 'secrets',
        'owner_id', o.id, 'label', format('%s: no SSN on file.', who));
    end if;
  end loop;

  -- Card mix: two independent pairs, each checked only when filled. moto and
  -- internet are informational and never summed.
  select * into bp from pre_app_business_profile where pre_app_id = pa.id;
  if found then
    if (bp.card_swiped_pct is not null or bp.card_keyed_pct is not null)
       and coalesce(bp.card_swiped_pct, 0) + coalesce(bp.card_keyed_pct, 0) <> 100 then
      items := items || jsonb_build_object('code', 'card_swiped_keyed_total', 'step', 'profile',
        'label', 'Swiped and keyed percentages must total 100.');
    end if;
    if (bp.card_present_pct is not null or bp.card_not_present_pct is not null)
       and coalesce(bp.card_present_pct, 0) + coalesce(bp.card_not_present_pct, 0) <> 100 then
      items := items || jsonb_build_object('code', 'card_present_total', 'step', 'profile',
        'label', 'Card-present and card-not-present percentages must total 100.');
    end if;
  end if;

  -- Banking: existence only. The RP password is deliberately not required.
  if not exists (select 1 from pre_app_banking_secrets where pre_app_id = pa.id) then
    items := items || jsonb_build_object('code', 'banking', 'step', 'secrets',
      'label', 'Banking details (routing and account number) have not been entered.');
  end if;

  -- Rep identity (memo §0.6, §7.1): the pre-app's rep, NOT the caller, so an
  -- admin submitting on a rep's behalf is held to the same rule. The profile
  -- CHECKs forbid blank, so null is the whole test.
  select * into rep from profiles where id = pa.agent_id;
  if rep.legal_name is null or rep.llc_legal_name is null then
    items := items || jsonb_build_object('code', 'rep_identity', 'step', 'review',
      'label', 'The rep''s legal name and LLC legal name are not on their profile yet. An admin adds them in Manage Users.');
  end if;

  return items;
end;
$$;

revoke all on function pre_app_missing_fields(int) from public;
grant execute on function pre_app_missing_fields(int) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- submit_pre_app(): every completeness rule now lives in
-- pre_app_missing_fields(); this refuses with the whole list (PT422, the
-- labels in the message, the codes in DETAIL) and then snapshots the rep's
-- identity and split rate onto the pre-app.
--
-- The phase 3 tax-ID block, the location rule, the owner rules, card mix and
-- banking are all gone from this body -- they are codes in the function. The
-- caller guard and the status check stay here, first, so a rep gets "not a
-- draft" rather than a list.
-- ---------------------------------------------------------------------
create or replace function submit_pre_app(pre_app_id_input int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  pa       pre_apps;
  rep      profiles;
  missing  jsonb;
  n        int;
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

  missing := pre_app_missing_fields(pa.id);
  n := jsonb_array_length(missing);
  if n > 0 then
    raise exception '%',
      format('This pre-app cannot be submitted yet. %s missing: %s',
             case when n = 1 then 'One thing is' else n || ' things are' end,
             (select string_agg(m ->> 'label', ' ' order by ord)
                from jsonb_array_elements(missing) with ordinality as e(m, ord)))
      using errcode = 'PT422',
            detail = (select jsonb_agg(m ->> 'code' order by ord)
                        from jsonb_array_elements(missing) with ordinality as e(m, ord))::text;
  end if;

  -- The snapshot (memo §7.1, §0b.4). From the pre-app's rep, not the caller.
  -- rep_identity above guarantees both names are set; the coalesce is the A16
  -- rule written down where it applies (no LLC: the rep's own legal name),
  -- not a path the check above leaves open.
  select * into rep from profiles where id = pa.agent_id;

  perform set_config('tapswipe.pre_app_transition', 'on', true);
  update pre_apps
     set status = 'submitted',
         date_submitted = current_date,
         decline_reason = null,
         rep_legal_name = rep.legal_name,
         rep_llc_legal_name = coalesce(rep.llc_legal_name, rep.legal_name),
         split_agent_pct = rep.split_rate_pct,
         split_company_pct = 100 - rep.split_rate_pct
   where id = pa.id;
  perform set_config('tapswipe.pre_app_transition', '', true);

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'submit_pre_app', 'pre_apps', pa.id::text);

  return pa.id;
end;
$$;

revoke all on function submit_pre_app(int) from public;
grant execute on function submit_pre_app(int) to authenticated, service_role;
