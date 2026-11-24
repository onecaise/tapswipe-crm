-- Move the existing overrides to company funding — SUPABASE SQL EDITOR, one-off.
--
-- The owner's decision (16 Nov 2026, docs/design/override-funding.md §4.4 and
-- §8): of the 92 overrides that exist, the 91 below become COMPANY-funded
-- (paid out of the company's share; the owner keeps their full rate), and the
-- Lamar County Justice Court 25% to Plumlee LLC stays OWNER-funded, as ISO
-- Hub pays it.
--   to agent 103 (Bruce Rozar), on Plumlee LLC merchants   88 -> company
--   to agent 105 (Sherwin Anderson)                         3 -> company
--   to agent 108 (Plumlee LLC), Lamar County Justice Court  1    stays owner
--
-- RUN IT ONLY AFTER (docs/claude/deploy-override-funding.md):
--   * 20261116120000_override_funding is applied (it adds funded_by, 'owner'
--     on every existing override, and set_merchant_override_funding());
--   * every PAID processor-month these overrides touched is REOPENED. A paid
--     month aborts this script before anything changes (the function refuses
--     it too). scripts/set-override-funding-counts.sql lists them.
--
-- HOW TO RUN: paste this whole file into the SQL Editor and press Run.
--   * As shipped it is a DRY RUN: `do_commit boolean := false` below. It does
--     every check, changes every override through the real function,
--     re-checks the result, then raises an error whose message is the report.
--     The error rolls all of it back. An error starting "DRY RUN" IS the dry
--     run's success output.
--   * To commit, change that ONE literal to `true` and run it again. It ends
--     with a one-row result grid of the final tally.
--   * Then run scripts/set-override-funding-counts.sql (read-only).
--   * Running it again changes nothing: it reports "nothing to do" once the 91
--     are company-funded and Lamar is owner-funded.
--
-- WHAT IT DOES, in order. Every check fails closed: it raises, and the whole
-- block rolls back.
--   1. lock_timeout 10s; the share lock the funding function itself takes.
--   2. Exactly one active admin with admin_email; exactly one profile for each
--      of agents 103, 105 and 108, and 108 is the 'Plumlee LLC' profile.
--   3. THE TALLY, before anything changes, of EVERY override on the project
--      by recipient: 103 -> 88 (all on Plumlee LLC merchants), 105 -> 3,
--      108 -> 1 (on MID lamar_mid), nobody else, 92 in total. Any other
--      number aborts with "found N, expected M" for each line that differs.
--   4. Which change: every override but Lamar's. If they are already all
--      company-funded and Lamar is owner-funded: nothing to do. If only some
--      are: abort (a half-applied state is a question, not a re-run). Lamar
--      must be owner-funded.
--   5. No processor-month an override to change has committed lines in is
--      marked paid. Otherwise abort, naming each one (reopen them first).
--   6. Acts as the admin, transaction-local only: role `authenticated` and
--      request.jwt.claims carrying the admin's id. One
--      set_merchant_override_funding(id, 'company', reason) per override: the
--      app's own write path, its locks, guards and audit row. Nothing updates
--      merchant_overrides directly; no call is wrapped in an exception handler.
--   7. Back to the editor's own identity, then the re-check: the 91 are
--      company-funded and Lamar owner-funded; one 'set_override_funding' audit
--      row per override changed, by the admin; every other column of every
--      override byte-for-byte as before; the final tally.
--   8. Dry run: raise with the report (rolls back). Commit: the tally grid.
--
-- It prints counts, agent numbers and processor-months; no email, name or id.
-- The committed months it lists still show the old funding until each is
-- REPLACED (upload the same file again and answer Yes to replace); Mark paid
-- is refused until then.
--
-- tests/rls/set-override-funding.test.ts (PGlite) and
-- tests/live/set-override-funding.test.ts (local stack, as the non-superuser
-- `postgres` role the editor uses) run this file.

do $funding$
declare
  -- ===================================================================
  do_commit       boolean := false;   -- <<< false = DRY RUN (rolls back), true = COMMIT
  -- ===================================================================
  admin_email     constant text := 'owen@tapswipellc.com';
  reason          constant text := 'Owner decision 16 Nov 2026: overrides are paid from the company''s share, as ISO Hub pays them; Lamar County Justice Court stays owner-funded to match ISO Hub.';
  plumlee_llc     constant text := 'Plumlee LLC';
  lamar_mid       constant text := '30119964826';
  expect_103      constant int  := 88;
  expect_105      constant int  := 3;
  expect_108      constant int  := 1;
  expect_total    constant int  := 92;

  n               bigint;
  admin           profiles;
  bruce_id        uuid;
  sherwin_id      uuid;
  plumlee_id      uuid;
  found_103       int;
  found_103_pl    int;
  found_105       int;
  found_108       int;
  found_108_lamar int;
  found_total     int;
  mismatch        text := '';
  lamar_id        int;
  lamar_funding   text;
  to_change       int[];
  already         int;
  paid            text;
  audit_before    int;
  audit_count     bigint;
  before_other    text;
  after_other     text;
  override_ref    int;
  result          jsonb;
  stale           text;
  tally           text;
  company_n       int;
  owner_n         int;
  report          text;
begin
  -- 1.
  perform set_config('lock_timeout', '10s', true);
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  -- 2. Who.
  select count(*) into n
    from auth.users u join profiles p on p.id = u.id
   where lower(u.email) = lower(admin_email);
  if n <> 1 then
    raise exception 'set-override-funding: expected exactly one account with the admin_email set in this script, found %. Nothing was changed.', n;
  end if;
  select p.* into admin
    from auth.users u join profiles p on p.id = u.id
   where lower(u.email) = lower(admin_email);
  if admin.role is distinct from 'admin' or not admin.is_active then
    raise exception 'set-override-funding: the admin_email account is not an active admin, so set_merchant_override_funding() would refuse it. Nothing was changed.';
  end if;

  select count(*) into n from profiles where agent_number = '103';
  if n <> 1 then
    raise exception 'set-override-funding: expected exactly one profile with agent_number 103, found %. Nothing was changed.', n;
  end if;
  select id into bruce_id from profiles where agent_number = '103';
  select count(*) into n from profiles where agent_number = '105';
  if n <> 1 then
    raise exception 'set-override-funding: expected exactly one profile with agent_number 105, found %. Nothing was changed.', n;
  end if;
  select id into sherwin_id from profiles where agent_number = '105';
  select count(*) into n from profiles where agent_number = '108' and llc_legal_name = plumlee_llc;
  if n <> 1 then
    raise exception 'set-override-funding: expected exactly one profile with agent_number 108 and llc_legal_name ''%'', found %. Nothing was changed.', plumlee_llc, n;
  end if;
  select id into plumlee_id from profiles where agent_number = '108';

  -- 3. The tally, of every override on the project, before anything changes.
  select count(*) filter (where o.recipient_id = bruce_id),
         count(*) filter (where o.recipient_id = bruce_id and m.agent_id = plumlee_id),
         count(*) filter (where o.recipient_id = sherwin_id),
         count(*) filter (where o.recipient_id = plumlee_id),
         count(*) filter (where o.recipient_id = plumlee_id and mid_key(m.mid) = mid_key(lamar_mid)),
         count(*)
    into found_103, found_103_pl, found_105, found_108, found_108_lamar, found_total
    from merchant_overrides o join merchants m on m.id = o.merchant_id;

  if found_103 <> expect_103 then
    mismatch := mismatch || E'\n  overrides to agent 103: found ' || found_103 || ', expected ' || expect_103;
  end if;
  if found_103_pl <> expect_103 then
    mismatch := mismatch || E'\n  overrides to agent 103 on Plumlee LLC merchants: found ' || found_103_pl || ', expected ' || expect_103;
  end if;
  if found_105 <> expect_105 then
    mismatch := mismatch || E'\n  overrides to agent 105: found ' || found_105 || ', expected ' || expect_105;
  end if;
  if found_108 <> expect_108 then
    mismatch := mismatch || E'\n  overrides to agent 108: found ' || found_108 || ', expected ' || expect_108;
  end if;
  if found_108_lamar <> expect_108 then
    mismatch := mismatch || E'\n  overrides to agent 108 on MID ' || lamar_mid || ': found ' || found_108_lamar || ', expected ' || expect_108;
  end if;
  if found_total <> expect_total then
    mismatch := mismatch || E'\n  overrides in total: found ' || found_total || ', expected ' || expect_total;
  end if;

  report := E'\n  overrides by recipient (agent 103 / 105 / 108 / total): '
         || found_103 || ' / ' || found_105 || ' / ' || found_108 || ' / ' || found_total;

  if mismatch <> '' then
    raise exception using
      message = 'set-override-funding: ABORTED, nothing was changed. The overrides on this project are not the expected ones:' || mismatch || report,
      hint = 'Find out why before changing any funding; the expected numbers are the owner''s decision of 16 Nov 2026.';
  end if;

  -- 4. Which change: all but Lamar's.
  select o.id, o.funded_by into lamar_id, lamar_funding
    from merchant_overrides o join merchants m on m.id = o.merchant_id
   where o.recipient_id = plumlee_id and mid_key(m.mid) = mid_key(lamar_mid);
  if lamar_funding <> 'owner' then
    raise exception 'set-override-funding: ABORTED, nothing was changed. The Lamar County Justice Court override is %-funded; it must stay owner-funded.%',
      lamar_funding, report;
  end if;

  select coalesce(array_agg(o.id order by o.id), '{}'),
         count(*) filter (where o.funded_by = 'company')
    into to_change, already
    from merchant_overrides o
   where o.id <> lamar_id;

  if already = cardinality(to_change) then
    report := report || E'\n  nothing to do: the ' || already
           || ' are company-funded already and Lamar County Justice Court is owner-funded.';
    if not do_commit then
      raise exception using message = 'DRY RUN: rolled back, nothing was changed.' || report;
    end if;
    raise notice 'set-override-funding: NOTHING TO DO.%', report;
    perform set_config('tapswipe.override_funding', json_build_object(
      'changed', 0, 'company', already, 'owner', 1, 'total', found_total)::text, false);
    return;
  end if;
  if already > 0 then
    raise exception 'set-override-funding: ABORTED, nothing was changed. % of the % overrides to change are company-funded already; a half-applied state is a question, not a re-run.%',
      already, cardinality(to_change), report;
  end if;

  -- 5. No paid month under them.
  select string_agg(distinct c.processor || ' ' || to_char(c.period, 'YYYY-MM'), ', ')
    into paid
    from rep_payout_rows l
    join rep_payout_batches b on b.id = l.batch_id and b.status = 'committed'
    join payout_period_closures c on c.processor = l.processor and c.period = l.period
   where l.line_kind = 'override' and l.override_id = any (to_change);
  if paid is not null then
    raise exception using
      message = 'set-override-funding: ABORTED, nothing was changed. These processor-months are marked paid and carry lines of overrides to change: ' || paid || '.' || report,
      hint = 'Reopen each on Payouts (Processor months), with a reason, then run this again.';
  end if;

  select coalesce(max(id), 0), count(*) into audit_before, audit_count from audit_log;
  select md5(coalesce(string_agg(md5(row(o.id, o.merchant_id, o.recipient_id, o.override_pct,
                                          o.effective_from, o.effective_to, o.created_at)::text),
                                 ',' order by o.id), ''))
    into before_other
    from merchant_overrides o;

  -- 6. Act as the admin, for this transaction only.
  perform set_config('request.jwt.claims',
                     json_build_object('sub', admin.id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', admin.id::text, true);
  if auth.uid() is distinct from admin.id then
    raise exception 'set-override-funding: could not act as the admin (auth.uid() did not resolve to the admin_email account). Nothing was changed.';
  end if;
  perform set_config('role', 'authenticated', true);
  if not is_admin() then
    raise exception 'set-override-funding: could not act as the admin (is_admin() is false as the admin_email account). Nothing was changed.';
  end if;

  foreach override_ref in array to_change loop
    result := set_merchant_override_funding(override_ref, 'company', reason);
    if (result ->> 'changed')::boolean is distinct from true then
      raise exception 'set-override-funding: an override did not change (%). Rolled back.', result ->> 'from';
    end if;
  end loop;

  -- 7. Back to the editor's identity, then check what happened.
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);

  select count(*) filter (where funded_by = 'company'),
         count(*) filter (where funded_by = 'owner')
    into company_n, owner_n
    from merchant_overrides;
  if company_n <> cardinality(to_change) or owner_n <> 1
     or (select funded_by from merchant_overrides where id = lamar_id) <> 'owner'
     or exists (select 1 from merchant_overrides where id = any (to_change) and funded_by <> 'company') then
    raise exception 'set-override-funding: after the change, % company-funded and % owner-funded; expected % and 1 (Lamar). Rolled back.',
      company_n, owner_n, cardinality(to_change);
  end if;

  select count(*) into n
    from audit_log a
   where a.id > audit_before
     and a.action = 'set_override_funding'
     and a.table_name = 'merchant_overrides'
     and a.actor_id = admin.id
     and a.row_id = any (to_change::text[]);
  if n <> cardinality(to_change)
     or (select count(*) from audit_log) <> audit_count + cardinality(to_change) then
    raise exception 'set-override-funding: % audit row(s) by the admin for % change(s), % audit row(s) written in all. Rolled back.',
      n, cardinality(to_change), (select count(*) from audit_log) - audit_count;
  end if;

  select md5(coalesce(string_agg(md5(row(o.id, o.merchant_id, o.recipient_id, o.override_pct,
                                          o.effective_from, o.effective_to, o.created_at)::text),
                                 ',' order by o.id), ''))
    into after_other
    from merchant_overrides o;
  if after_other is distinct from before_other then
    raise exception 'set-override-funding: something other than who pays changed on an override. Rolled back.';
  end if;

  select string_agg(s.processor || ' ' || to_char(s.period, 'YYYY-MM') || ' (' || s.n || ')', ', '
                    order by s.period, s.processor)
    into stale
    from (select l.processor, l.period, count(distinct l.override_id) as n
            from rep_payout_rows l
            join rep_payout_batches b on b.id = l.batch_id and b.status = 'committed'
            join merchant_overrides o on o.id = l.override_id
           where l.line_kind = 'override'
             and l.override_funded_by is distinct from o.funded_by
           group by l.processor, l.period) s;

  select string_agg(t.k || ' ' || t.funded_by || ' ' || t.n, ', ' order by t.k, t.funded_by)
    into tally
    from (select coalesce(p.agent_number, '(no code)') as k, o.funded_by, count(*) as n
            from merchant_overrides o join profiles p on p.id = o.recipient_id
           group by 1, 2) t;

  -- 8. Report.
  report := report
         || E'\n  ' || case when do_commit then 'changed' else 'would change' end
         || ' to company-funded: ' || cardinality(to_change)
         || E'\n  left owner-funded: Lamar County Justice Court (agent 108, 25%)'
         || E'\n  final tally: ' || company_n || ' company, ' || owner_n || ' owner, '
         || (company_n + owner_n) || ' in total'
         || E'\n  by recipient: ' || coalesce(tally, '(none)')
         || E'\n  committed months to REPLACE (override count): ' || coalesce(stale, 'none');

  if not do_commit then
    raise exception using
      message = 'DRY RUN: rolled back, nothing was changed. Every check passed.' || report,
      hint = 'To commit, set do_commit to true and run again.';
  end if;

  perform set_config('tapswipe.override_funding', json_build_object(
    'changed', cardinality(to_change), 'company', company_n, 'owner', owner_n,
    'total', company_n + owner_n, 'replace', coalesce(stale, 'none'))::text, false);
  raise notice 'set-override-funding: COMMITTED.%', report;
end
$funding$;

-- Commit mode only (a dry run raised above, so this never runs): the tally.
select r.*
  from json_to_record(
         coalesce(nullif(current_setting('tapswipe.override_funding', true), ''), '{}')::json
       ) as r(changed int, company int, owner int, total int, replace text);
