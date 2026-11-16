-- Add Bruce's overrides on Plumlee LLC — SUPABASE SQL EDITOR, prod, one-off.
--
-- The owner's rule: Bruce Rozar (agent_number 103) gets 5% of the FULL
-- residual on EVERY merchant owned by Plumlee LLC (the profile whose
-- llc_legal_name is 'Plumlee LLC'), from the 2026-01 payout month. That is an
-- override (docs/claude/payouts-and-teardown.md, "Overrides"): 5 points of
-- the residual taken out of the rep side and paid to Bruce; the company's
-- share never moves.
--
-- HOW TO RUN: paste this whole file into the SQL Editor and press Run.
--   * As shipped it is a DRY RUN: `do_commit boolean := false` below. It does
--     every check, creates every override through the real function, re-checks
--     the result, then raises an error whose message is the report. The error
--     rolls all of it back. An error starting "DRY RUN" IS the dry run's
--     success output.
--   * To commit, change that ONE literal to `true` and run it again. It ends
--     with a one-row result grid of the same counts.
--   * Then run scripts/add-plumlee-bruce-overrides-counts.sql (read-only).
--   * Running it again creates nothing: every Plumlee merchant then has a live
--     override, and a merchant with a live override is skipped.
--
-- WHAT IT DOES, in order. Every check fails closed: it raises, and the whole
-- block rolls back.
--   1. lock_timeout 10s; the share lock set_merchant_override() itself takes,
--      so no commit, share, rate or override change lands between the counts
--      below and the writes.
--   2. Exactly one profile with llc_legal_name 'Plumlee LLC' (the owner),
--      exactly one with agent_number '103' (the recipient, who must be active
--      and must not be the owner), exactly one account with admin_email, which
--      must be an active admin.
--   3. Every Plumlee merchant, of every status: a merchant with a LIVE override
--      (merchant_has_live_override(), the app's own definition) is skipped,
--      whoever receives it. Every other one must pass what
--      set_merchant_override() will check -- a MID; a submitted or approved
--      pre-app, if it came from one; a rate of at least 5; no import line for
--      the MID in 2026-01 or later (a committed month is corrected with an
--      adjustment, never an override); no other override reaching into
--      2026-01 or later; Bruce not a party to a share on it. If ANY merchant
--      fails, it aborts before writing anything and says how many failed
--      and why.
--   4. Acts as the admin, transaction-local only: role `authenticated` and
--      request.jwt.claims carrying the admin's id, exactly what the Data API
--      sets for a signed-in caller. So set_merchant_override() runs its
--      is_admin() check and writes its 'set_merchant_override' audit row with
--      the admin as the actor, as if the admin had used the merchant page.
--   5. One set_merchant_override(merchant, Bruce, 5, 2026-01-01) per merchant
--      to create. Nothing inserts into merchant_overrides directly. No call is
--      wrapped in an exception handler.
--   6. Back to the editor's own identity, then the re-check: one new override
--      per merchant created, each to Bruce at 5 from 2026-01-01, open-ended;
--      one audit row each, by the admin; the overrides that existed before
--      byte-for-byte unchanged (nothing ended, nothing moved); no Plumlee
--      merchant left without a live override; and the number of Plumlee
--      merchants with a live override to Bruce from 2026-01 equals the
--      number created plus the number that already had one.
--   7. Dry run: raise with the report (rolls back). Commit: store it for the
--      trailing SELECT.
--
-- A merchant skipped because its live override pays someone else does NOT get
-- Bruce's 5% (one override per merchant per month). The report counts them
-- separately ("to someone else") so that is a decision, not a surprise.
--
-- It prints no email, id or digest: counts, and the names (dba) of the first
-- five merchants it would give an override.
--
-- tests/rls/add-plumlee-bruce-overrides.test.ts (PGlite) and
-- tests/live/add-plumlee-bruce-overrides.test.ts (local stack, as the
-- non-superuser `postgres` the editor uses) run this file.

do $plumlee$
declare
  -- ===================================================================
  do_commit       boolean := false;   -- <<< false = DRY RUN (rolls back), true = COMMIT
  -- ===================================================================
  owner_llc       constant text    := 'Plumlee LLC';
  recipient_code  constant text    := '103';
  admin_email     constant text    := 'owen@tapswipellc.com';
  pct             constant numeric := 5;
  start_month     constant date    := '2026-01-01';

  n               bigint;
  owner_id        uuid;
  recipient       profiles;
  admin           profiles;
  m               merchants;
  latest          date;
  pre_status      text;
  merchant_ref    int;

  merchant_count  int := 0;
  skipped_to_him  int := 0;
  skipped_other   int := 0;
  to_create       int[] := array[]::int[];
  first_names     text[] := array[]::text[];
  created_ids     int[] := array[]::int[];

  no_mid          int := 0;
  pre_app_open    int := 0;
  low_rate        int := 0;
  committed       int := 0;
  overlapping     int := 0;
  share_party     int := 0;
  blocked         int;

  existing_before text;
  existing_after  text;
  covered         int;
  uncovered       int;
  report          text;
begin
  -- 1.
  perform set_config('lock_timeout', '10s', true);
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  -- 2. Who.
  select count(*) into n from profiles where llc_legal_name = owner_llc;
  if n <> 1 then
    raise exception 'add-plumlee-bruce-overrides: expected exactly one profile with llc_legal_name ''%'', found %. Nothing was changed.',
      owner_llc, n;
  end if;
  select id into owner_id from profiles where llc_legal_name = owner_llc;

  select count(*) into n from profiles where agent_number = recipient_code;
  if n <> 1 then
    raise exception 'add-plumlee-bruce-overrides: expected exactly one profile with agent_number %, found %. Nothing was changed.',
      recipient_code, n;
  end if;
  select * into recipient from profiles where agent_number = recipient_code;
  if recipient.id = owner_id then
    raise exception 'add-plumlee-bruce-overrides: agent % is the Plumlee LLC profile itself; an override is never paid to the merchant''s owner. Nothing was changed.',
      recipient_code;
  end if;
  if not recipient.is_active then
    raise exception 'add-plumlee-bruce-overrides: agent % is deactivated, so no override can name them. Nothing was changed.',
      recipient_code;
  end if;

  select count(*) into n
    from auth.users u join profiles p on p.id = u.id
   where lower(u.email) = lower(admin_email);
  if n <> 1 then
    raise exception 'add-plumlee-bruce-overrides: expected exactly one account with the admin_email set in this script, found %. Nothing was changed.',
      n;
  end if;
  select p.* into admin
    from auth.users u join profiles p on p.id = u.id
   where lower(u.email) = lower(admin_email);
  if admin.role is distinct from 'admin' or not admin.is_active then
    raise exception 'add-plumlee-bruce-overrides: the admin_email account is not an active admin, so set_merchant_override() would refuse it. Nothing was changed.';
  end if;

  -- 3. Which merchants. The same reads set_merchant_override() makes.
  for m in
    select * from merchants where agent_id = owner_id order by dba, id
  loop
    merchant_count := merchant_count + 1;

    if merchant_has_live_override(m.id) then
      if exists (select 1 from merchant_overrides o
                  where o.merchant_id = m.id and o.recipient_id = recipient.id
                    and o.effective_from = start_month and o.effective_to is null) then
        skipped_to_him := skipped_to_him + 1;
      else
        skipped_other := skipped_other + 1;
      end if;
      continue;
    end if;

    if m.mid is null or btrim(m.mid) = '' then
      no_mid := no_mid + 1;
      continue;
    end if;

    if m.pre_app_id is not null then
      select status into pre_status from pre_apps where id = m.pre_app_id;
      if pre_status is distinct from 'submitted' and pre_status is distinct from 'approved' then
        pre_app_open := pre_app_open + 1;
        continue;
      end if;
    end if;

    if m.split_agent_pct is null or m.split_agent_pct < pct then
      low_rate := low_rate + 1;
      continue;
    end if;

    select max(period) into latest
      from rep_payout_rows
     where (merchant_id = m.id or mid = m.mid)
       and line_kind = 'import';
    if latest is not null and latest >= start_month then
      committed := committed + 1;
      continue;
    end if;

    if exists (select 1 from merchant_overrides o
                where o.merchant_id = m.id
                  and daterange(o.effective_from, o.effective_to)
                      && daterange(start_month, null)) then
      overlapping := overlapping + 1;
      continue;
    end if;

    if exists (select 1 from merchant_rep_shares s
                where s.merchant_id = m.id
                  and recipient.id in (s.primary_agent_id, s.secondary_agent_id)
                  and daterange(s.effective_from, s.effective_to)
                      && daterange(start_month, null)) then
      share_party := share_party + 1;
      continue;
    end if;

    to_create := to_create || m.id;
    if cardinality(first_names) < 5 then
      first_names := first_names || coalesce(m.dba, '(no name)');
    end if;
  end loop;

  report := E'\n  Plumlee LLC merchants (every status): ' || merchant_count
         || E'\n  already have a live override, skipped: ' || (skipped_to_him + skipped_other)
         || ' (to agent ' || recipient_code || ' at 5 from 2026-01: ' || skipped_to_him
         || ', other: ' || skipped_other || ')';

  blocked := no_mid + pre_app_open + low_rate + committed + overlapping + share_party;
  if blocked > 0 then
    raise exception using
      message = 'add-plumlee-bruce-overrides: ABORTED, nothing was changed. ' || blocked
             || ' Plumlee merchant(s) would be refused by set_merchant_override():'
             || E'\n  no MID: ' || no_mid
             || E'\n  pre-app not submitted or approved: ' || pre_app_open
             || E'\n  no rate, or a rate below ' || trim_scale(pct) || ': ' || low_rate
             || E'\n  a residual month 2026-01 or later already committed for the MID: ' || committed
             || E'\n  an ended override reaching into 2026-01 or later: ' || overlapping
             || E'\n  agent ' || recipient_code || ' is a party to a share on it: ' || share_party
             || report,
      hint = 'Decide each of these first; the script gives every merchant the override or none.';
  end if;

  select count(*) || ':' || coalesce(md5(string_agg(md5(o::text), ',' order by o.id)), '')
    into existing_before
    from merchant_overrides o join merchants mm on mm.id = o.merchant_id
   where mm.agent_id = owner_id;

  -- 4. Act as the admin, for this transaction only.
  perform set_config('request.jwt.claims',
                     json_build_object('sub', admin.id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin.id::text, true);
  -- auth.uid() reads only those settings; asked here, before the role
  -- switch, because `authenticated` need not hold USAGE on schema auth.
  if auth.uid() is distinct from admin.id then
    raise exception 'add-plumlee-bruce-overrides: could not act as the admin (auth.uid() did not resolve to the admin_email account). Nothing was changed.';
  end if;
  perform set_config('role', 'authenticated', true);
  if not is_admin() then
    raise exception 'add-plumlee-bruce-overrides: could not act as the admin (is_admin() is false as the admin_email account). Nothing was changed.';
  end if;

  -- 5. The app's own write path, guards and audit row included.
  foreach merchant_ref in array to_create loop
    created_ids := created_ids || set_merchant_override(merchant_ref, recipient.id, pct, start_month);
  end loop;

  -- 6. Back to the editor's identity, then check what happened.
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);

  if cardinality(created_ids) <> cardinality(to_create) then
    raise exception 'add-plumlee-bruce-overrides: created % override(s), expected %. Rolled back.',
      cardinality(created_ids), cardinality(to_create);
  end if;

  select count(*) into n
    from merchant_overrides o
   where o.id = any (created_ids)
     and o.merchant_id = any (to_create)
     and o.recipient_id = recipient.id
     and o.override_pct = pct
     and o.effective_from = start_month
     and o.effective_to is null;
  if n <> cardinality(to_create)
     or (select count(distinct merchant_id) from merchant_overrides where id = any (created_ids))
        <> cardinality(to_create) then
    raise exception 'add-plumlee-bruce-overrides: only % of % new override(s) are to agent % at 5 from 2026-01, open-ended, one per merchant. Rolled back.',
      n, cardinality(to_create), recipient_code;
  end if;

  select count(*) into n
    from audit_log a
   where a.action = 'set_merchant_override'
     and a.table_name = 'merchant_overrides'
     and a.actor_id = admin.id
     and a.row_id = any (created_ids::text[]);
  if n <> cardinality(to_create) then
    raise exception 'add-plumlee-bruce-overrides: % audit row(s) by the admin for % new override(s). Rolled back.',
      n, cardinality(to_create);
  end if;

  select count(*) || ':' || coalesce(md5(string_agg(md5(o::text), ',' order by o.id)), '')
    into existing_after
    from merchant_overrides o join merchants mm on mm.id = o.merchant_id
   where mm.agent_id = owner_id and o.id <> all (created_ids);
  if existing_after is distinct from existing_before then
    raise exception 'add-plumlee-bruce-overrides: an override that existed before the run changed. Rolled back.';
  end if;

  select count(*) filter (where not merchant_has_live_override(mm.id)),
         count(*) filter (where exists (
           select 1 from merchant_overrides o
            where o.merchant_id = mm.id and o.recipient_id = recipient.id
              and o.override_pct = pct and o.effective_from = start_month
              and o.effective_to is null))
    into uncovered, covered
    from merchants mm
   where mm.agent_id = owner_id;
  if uncovered <> 0 then
    raise exception 'add-plumlee-bruce-overrides: % Plumlee merchant(s) still have no live override. Rolled back.',
      uncovered;
  end if;
  if covered <> cardinality(to_create) + skipped_to_him then
    raise exception 'add-plumlee-bruce-overrides: % Plumlee merchant(s) have agent %''s override from 2026-01, expected %. Rolled back.',
      covered, recipient_code, cardinality(to_create) + skipped_to_him;
  end if;

  -- 7. Report.
  report := report
         || E'\n  ' || case when do_commit then 'created' else 'would create' end
         || ' (5% of the full residual to agent ' || recipient_code || ', from 2026-01): '
         || cardinality(to_create)
         || E'\n  first five: ' || coalesce(nullif(array_to_string(first_names, ', '), ''), '(none)')
         || E'\n  Plumlee merchants with agent ' || recipient_code || '''s override from 2026-01 afterwards: '
         || covered || ' of ' || merchant_count;

  if not do_commit then
    raise exception using
      message = 'DRY RUN: rolled back, nothing was changed. Every check passed.' || report,
      hint = 'To commit, set do_commit to true and run again.';
  end if;

  perform set_config('tapswipe.plumlee_overrides', json_build_object(
    'plumlee_merchants', merchant_count,
    'skipped_already_to_103', skipped_to_him,
    'skipped_other_override', skipped_other,
    'created', cardinality(to_create),
    'first_five', array_to_string(first_names, ', '),
    'with_103_override_from_2026_01', covered)::text, false);
  raise notice 'add-plumlee-bruce-overrides: COMMITTED.%', report;
end
$plumlee$;

-- Commit mode only (a dry run raised above, so this never runs): the counts.
select r.*
  from json_to_record(
         coalesce(nullif(current_setting('tapswipe.plumlee_overrides', true), ''), '{}')::json
       ) as r(plumlee_merchants int, skipped_already_to_103 int, skipped_other_override int,
              created int, first_five text, with_103_override_from_2026_01 int);
