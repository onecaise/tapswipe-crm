-- Merchant location: every merchant gets a city and a state.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first -- the reasoning for
-- each piece lives there, next to the merchants table, the index list and
-- approve_pre_app(). In short:
--
--   * street, city, state, zip on merchants, nullable. City and state are
--     required for NEW merchants by the merchants_location_guard trigger
--     (insert), which also stops a complete location being removed; the
--     NULL-tolerant merchants_location_format CHECK says what one looks like
--     when present. Existing merchants without a location stay fully
--     editable. (The first version of this file used a table-wide NOT VALID
--     CHECK instead, which Postgres enforces on every UPDATE of an old row --
--     it made every legacy merchant uneditable. See the doc.)
--     No backfill here; scripts/backfill-merchant-location.sql is reviewed
--     and run by hand. Admins see the gap at /admin/merchants/missing-location.
--   * norm_city(), the one definition of "the same city" (lower-case,
--     punctuation to a space, whitespace collapsed, trimmed; no abbreviation
--     expansion), with an expression index on it for accounts_in_city().
--   * approve_pre_app() carries the pre-app's business address across, and
--     refuses by name a pre-app with no usable city or state -- the wizard
--     never required them, so a submitted pre-app can lack both.
--
-- Review the merchants that still have no location with
--   select id, agent_id, dba, status from merchants
--    where city is null or state is null order by id;

alter table merchants
  add column street text,
  add column city text,
  add column state text,
  add column zip text;

create or replace function norm_city(input text)
returns text language sql immutable strict parallel safe as $$
  select nullif(
    btrim(regexp_replace(regexp_replace(lower(input), '[[:punct:]]', ' ', 'g'),
                         '\s+', ' ', 'g')),
    '')
$$;

revoke all on function norm_city(text) from public;
grant execute on function norm_city(text) to authenticated, service_role;

-- REQUIRED FOR NEW MERCHANTS ONLY -- and this is the second design, for a
-- reason worth keeping in view.
--
-- The first version of 20261013130000 added a table-wide
-- `check (city and state present) NOT VALID`. NOT VALID only skips the rows
-- that exist when the constraint is added; Postgres still enforces it on
-- EVERY LATER UPDATE of those rows. So on a project full of merchants that
-- predate the columns, an admin could not change a merchant's status or MID
-- without also typing a location -- every existing merchant became
-- read-only. tests/rls/merchant-location.test.ts pins the edits that design
-- refused ("an existing merchant with no location stays editable"); they ran
-- red against it before this replaced it. The test fixtures had hidden it:
-- seed() was taught to give every merchant a location, so no existing test
-- ever updated a location-less row.
--
-- So the rule is split by what it applies to:
--
--   merchants_location_format   (a CHECK, validated, NULL-tolerant)
--       binds every row on every write, and only says what a location
--       looks like WHEN ONE IS PRESENT: a city that normalises to 2+
--       characters and is at most 60 trimmed (the range accounts_in_city()
--       searches, so nothing stored is unfindable), and a state of two
--       upper-case letters. A legacy row with neither passes. Plain, not
--       NOT VALID: every existing row is NULL/NULL, which it accepts.
--
--   merchants_location_guard    (a BEFORE INSERT OR UPDATE trigger)
--       INSERT: a new merchant must have both. This is "required for new
--       data" -- a CHECK cannot tell an insert from an update, which is the
--       whole reason this is a trigger.
--       UPDATE: a merchant that HAS a complete location cannot have it
--       removed. A legacy merchant with none is untouched by this branch, so
--       it stays fully editable; once a location is supplied it sticks.
--       Changing a location to another valid one is always allowed.
--
-- Raised as PT422 with a sentence, which lib/db-errors.ts passes through
-- verbatim, rather than 23514 naming a constraint a rep has never heard of.
--
-- No backfill in a migration: scripts/backfill-merchant-location.sql fills
-- what a linked pre-app can supply, reviewed and run by hand. Admins see the
-- rest at /admin/merchants/missing-location. Review query:
--   select id, agent_id, dba, status from merchants
--    where city is null or state is null order by id;
alter table merchants
  add constraint merchants_location_format check (
    (city is null
      or (char_length(btrim(city)) <= 60
          and coalesce(char_length(norm_city(city)), 0) >= 2))
    and (state is null or state ~ '^[A-Z]{2}$')
  );

create or replace function enforce_merchant_location()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if NEW.city is null or NEW.state is null then
      raise exception 'A new merchant needs a city and a two-letter state.'
        using errcode = 'PT422';
    end if;
  elsif OLD.city is not null and OLD.state is not null
        and (NEW.city is null or NEW.state is null) then
    raise exception 'A merchant''s city and state can be changed but not removed.'
      using errcode = 'PT422';
  end if;
  -- Shape (2..60 characters, a two-letter code) is merchants_location_format's
  -- job, on every row. This trigger only decides WHETHER one is required.
  return NEW;
end;
$$;

-- A trigger function needs no EXECUTE grant to fire, so nobody gets one; the
-- enforce_quote_version() convention.
revoke all on function enforce_merchant_location() from public;
revoke all on function enforce_merchant_location() from anon, authenticated;

create trigger merchants_location_guard
  before insert or update of city, state on merchants
  for each row execute function enforce_merchant_location();

create index if not exists idx_merchants_norm_city on merchants (norm_city(city));

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
  --
  -- LOCATION (20261013130000). The business address is carried across --
  -- physical_address into street, city, state upper-cased, zip -- because
  -- merchants_location_guard refuses a new merchant without one. A pre-app
  -- submitted before 20261013132000 may lack a city or state (submission did
  -- not require them until then), and such a pre-app CANNOT be approved: it is
  -- refused here by name, before any write, rather than left to fail on the
  -- constraint with a message that names a constraint instead of a fix. The
  -- fix is to reopen it and have the rep fill the address in.
  if coalesce(char_length(norm_city(pa.city)) < 2, true)
     or char_length(btrim(pa.city)) > 60
     or coalesce(upper(btrim(pa.state)) !~ '^[A-Z]{2}$', true) then
    raise exception 'pre-app % needs a city and a two-letter state before it can be approved',
      pre_app_id_input using errcode = 'PT409';
  end if;

  insert into merchants (agent_id, dba, legal_business_name, status,
                         split_agent_pct, split_company_pct, pre_app_id,
                         street, city, state, zip)
  values (pa.agent_id, pa.dba_name, pa.legal_business_name, 'active',
          pa.split_agent_pct, pa.split_company_pct, pa.id,
          nullif(btrim(pa.physical_address), ''), btrim(pa.city),
          upper(btrim(pa.state)), nullif(btrim(pa.zip), ''))
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

-- create or replace keeps the existing ACL, but the lines are restated so the
-- privilege surface of this function is readable from the file that last
-- defined it.
revoke all on function approve_pre_app(int) from public;
grant execute on function approve_pre_app(int) to authenticated, service_role;
