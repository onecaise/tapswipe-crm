-- Reset business data — SUPABASE SQL EDITOR, one-off, dev and prod alike.
--
-- Empties every table in `public` EXCEPT `profiles` and `processors`, and
-- leaves auth.users and both kept tables byte-for-byte unchanged. `processors`
-- is the fixed list of five processors that merchants and pre-apps point at
-- (20261023130000): configuration, not business data. Other reference data (brands, products,
-- product_compatibility, marketing_materials, marketing_material_events,
-- business_documents) is cleared too. Schema, functions, policies and grants
-- are not touched. Nothing in auth.* or storage.* is touched.
--
-- RUNBOOK: docs/claude/reset-business-data.md. In order: fresh backup, dry
-- run, commit, scripts/reset-business-data-counts.sql, then delete the
-- Storage files by hand from scripts/reset-business-data-storage-inventory.sql.
--
-- HOW TO RUN: paste this whole file into the SQL Editor and press Run.
--   * As shipped it is a DRY RUN: `do_commit boolean := false` below. It does
--     the whole reset, checks the result, then raises an error whose message
--     is the before -> after count for every table. The error rolls all of it
--     back. An error IS the dry run's success output.
--   * To commit, change that ONE literal to `true` and run it again. It ends
--     with a result grid of before/after counts and a status per table.
--   * expected_emails, just below it: optional. Empty = keep every existing
--     account, whatever they are (dev). Listing addresses (prod) makes the
--     script abort if any is missing from auth.users or profiles.
--
-- WHY A DO BLOCK: TRUNCATE of a list only known at run time needs dynamic SQL.
-- A DO block is one transaction by itself, whatever the editor does with
-- multi-statement input: any error anywhere in it rolls back everything it
-- did. The trailing SELECT only reads what the block left in a session
-- setting; in a dry run the block raised, so the SELECT never runs.
--
-- WHAT IT DOES, in order. Every check fails closed: it raises, and the whole
-- block rolls back.
--   1. lock_timeout 10s, so a busy table makes it fail instead of hang.
--   2. Classification guard: every table in `public` must be in keep_tables
--      or clear_tables. A table in neither (a feature added after this file)
--      aborts the run, so it forces a decision. A clear_tables entry that
--      does not exist is skipped and reported "absent": prod runs behind the
--      repo's migrations, and this one file has to fit both projects.
--   3. Privilege guard: TRUNCATE on every table it will clear, INSERT on
--      audit_log, SELECT on auth.users. The SQL Editor's `postgres` role owns
--      these tables; anyone else is refused before anything happens.
--   4. expected_emails, if any: each must be in auth.users AND profiles.
--   5. Snapshot auth.users and every kept table: count plus an md5 per row.
--   6. ONE `truncate ... restart identity`, WITHOUT cascade. Postgres refuses
--      it outright if any table outside the list references one inside it, so
--      a foreign key from a kept table can never be silently cascaded through.
--      TRUNCATE fires no row triggers, so the audit triggers
--      (log_cross_agent_change and friends) write nothing; none is disabled.
--      `restart identity` puts every id sequence of a cleared table back to 1.
--   7. One marker row in audit_log: action 'business_data_reset', actor NULL
--      (the editor has no auth.uid()). So audit_log ends at exactly 1 row.
--   8. Re-check: every cleared table at 0 (audit_log at 1), auth.users and
--      every kept table's snapshot identical, storage.objects count unchanged.
--   9. Dry run: raise with the counts (rolls back). Commit: store the counts
--      for the trailing SELECT.
--
-- WHAT IT LEAVES BEHIND: Storage files. SQL must not delete storage objects
-- (it would orphan the bytes), so every file in every bucket survives the
-- reset with no row pointing at it. Delete them by hand from
-- scripts/reset-business-data-storage-inventory.sql. The legacy `documents`
-- table is cleared here like any other; its bucket's files are in that same
-- inventory. (scripts/purge-legacy-documents.mjs is dev-only and not needed.)
--
-- It reads no secret column and prints no email, id or digest: only table
-- names and counts.
--
-- tests/rls/reset-business-data.test.ts (PGlite) and
-- tests/live/reset-business-data.test.ts (local stack) run this file.

do $reset$
declare
  -- ===================================================================
  do_commit       boolean := false;   -- <<< false = DRY RUN (rolls back), true = COMMIT
  expected_emails text[]  := array[]::text[];  -- <<< optional, e.g. array['a@x.com','b@y.com']
  -- ===================================================================

  -- processors: reference data the schema itself seeds (five rows), kept.
  keep_tables constant text[] := array['profiles', 'processors'];
  clear_tables constant text[] := array[
    -- sales pipeline
    'leads', 'ghost_sheets', 'merchants',
    'pre_apps', 'pre_app_owners', 'pre_app_terminal', 'pre_app_business_profile',
    'pre_app_owner_secrets', 'pre_app_banking_secrets', 'pre_app_terminal_secrets',
    'pre_app_tax_secrets',
    -- record-level activity
    'notes', 'tasks', 'support_tickets', 'support_ticket_replies', 'bug_reports',
    'documents', 'audit_log',
    -- proposals
    'quotes', 'quote_line_items',
    -- residuals
    'rep_payout_batches', 'rep_payout_import_rows', 'rep_payout_rows',
    'rep_payout_row_history', 'merchant_rep_shares',
    -- Overrides (20261102120000): per-merchant payroll terms, like shares.
    -- Business data: they describe merchants and ledger lines this script
    -- empties (both hold it by RESTRICT keys).
    'merchant_overrides',
    -- Mark paid (20261030120000): which processor-months were paid. Business
    -- data: it describes ledger months this script empties.
    'payout_period_closures',
    -- bulk user import staging
    'user_import_batches', 'user_import_rows',
    -- reference data
    'brands', 'products', 'product_compatibility',
    'marketing_materials', 'marketing_material_events', 'business_documents'
  ];

  t              text;
  n              bigint;
  present        text[] := array[]::text[];
  absent         text[] := array[]::text[];
  unclassified   text[];
  missing        text[];
  before_counts  jsonb := '{}'::jsonb;
  after_counts   jsonb := '{}'::jsonb;
  users_before   text;
  users_after    text;
  profiles_before text;
  profiles_after  text;
  kept_before    jsonb := '{}'::jsonb;
  kept_after     jsonb := '{}'::jsonb;
  digest         text;
  storage_before bigint;
  storage_after  bigint;
  i              int;
  report         text := '';
  summary        jsonb := '[]'::jsonb;
begin
  -- 1.
  perform set_config('lock_timeout', '10s', true);

  -- 2. Classification.
  if keep_tables && clear_tables then
    raise exception 'reset-business-data: a table is in both keep_tables and clear_tables';
  end if;

  select array_agg(c.relname::text order by c.relname) into unclassified
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p', 'm', 'f')
     and not c.relispartition
     and c.relname <> all (keep_tables || clear_tables);
  if unclassified is not null then
    raise exception 'reset-business-data: unclassified table(s) in public: %. Add each to keep_tables or clear_tables first.',
      array_to_string(unclassified, ', ');
  end if;

  foreach t in array keep_tables loop
    if to_regclass(format('public.%I', t)) is null then
      raise exception 'reset-business-data: kept table public.% does not exist', t;
    end if;
  end loop;

  foreach t in array clear_tables loop
    if to_regclass(format('public.%I', t)) is null then
      absent := absent || t;
    else
      present := present || t;
    end if;
  end loop;

  if not ('audit_log' = any (present)) then
    raise exception 'reset-business-data: public.audit_log does not exist';
  end if;

  -- 3. Privileges.
  foreach t in array present loop
    if not has_table_privilege(format('public.%I', t), 'TRUNCATE') then
      raise exception 'reset-business-data: % lacks TRUNCATE on public.%', current_user, t;
    end if;
  end loop;
  if not has_table_privilege('public.audit_log', 'INSERT') then
    raise exception 'reset-business-data: % lacks INSERT on public.audit_log', current_user;
  end if;
  if not has_table_privilege('auth.users', 'SELECT') then
    raise exception 'reset-business-data: % lacks SELECT on auth.users', current_user;
  end if;

  -- 4. Expected accounts. Reported by position, never by address.
  if expected_emails is not null and cardinality(expected_emails) > 0 then
    for i in 1 .. cardinality(expected_emails) loop
      if not exists (select 1 from auth.users u
                      where lower(u.email) = lower(btrim(expected_emails[i]))) then
        raise exception 'reset-business-data: expected_emails[%] is not in auth.users', i;
      end if;
      if not exists (select 1 from auth.users u join public.profiles p on p.id = u.id
                      where lower(u.email) = lower(btrim(expected_emails[i]))) then
        raise exception 'reset-business-data: expected_emails[%] has no profiles row', i;
      end if;
    end loop;
  end if;

  -- 5. Snapshots of what must not change.
  select count(*) || ':' || coalesce(md5(string_agg(u.id::text || '=' || md5(u::text), ',' order by u.id)), '')
    into users_before from auth.users u;
  select count(*) || ':' || coalesce(md5(string_agg(p.id::text || '=' || md5(p::text), ',' order by p.id)), '')
    into profiles_before from public.profiles p;
  foreach t in array keep_tables loop
    execute format('select count(*) || '':'' || coalesce(md5(string_agg(md5(x::text), '','' order by md5(x::text))), '''') from public.%I x', t)
      into digest;
    kept_before := kept_before || jsonb_build_object(t, digest);
  end loop;

  foreach t in array present || keep_tables loop
    execute format('select count(*) from public.%I', t) into n;
    before_counts := before_counts || jsonb_build_object(t, n);
  end loop;
  select count(*) into n from auth.users;
  before_counts := before_counts || jsonb_build_object('auth.users', n);
  if to_regclass('storage.objects') is not null then
    execute 'select count(*) from storage.objects' into storage_before;
  end if;

  -- 6. The reset.
  execute 'truncate table '
       || (select string_agg(format('public.%I', x), ', ') from unnest(present) x)
       || ' restart identity';

  -- 7. The marker.
  insert into public.audit_log (actor_id, action, table_name, row_id)
  values (null, 'business_data_reset', null, null);

  -- 8. Verify.
  foreach t in array present || keep_tables loop
    execute format('select count(*) from public.%I', t) into n;
    after_counts := after_counts || jsonb_build_object(t, n);
    if t = 'audit_log' and n <> 1 then
      raise exception 'reset-business-data: audit_log has % rows after the reset, expected 1', n;
    elsif t <> 'audit_log' and t = any (present) and n <> 0 then
      raise exception 'reset-business-data: public.% still has % rows', t, n;
    end if;
  end loop;
  select count(*) into n from auth.users;
  after_counts := after_counts || jsonb_build_object('auth.users', n);

  select count(*) || ':' || coalesce(md5(string_agg(u.id::text || '=' || md5(u::text), ',' order by u.id)), '')
    into users_after from auth.users u;
  select count(*) || ':' || coalesce(md5(string_agg(p.id::text || '=' || md5(p::text), ',' order by p.id)), '')
    into profiles_after from public.profiles p;
  if users_after is distinct from users_before then
    raise exception 'reset-business-data: auth.users changed during the run (count %, was %)',
      split_part(users_after, ':', 1), split_part(users_before, ':', 1);
  end if;
  if profiles_after is distinct from profiles_before then
    raise exception 'reset-business-data: profiles changed during the run (count %, was %)',
      split_part(profiles_after, ':', 1), split_part(profiles_before, ':', 1);
  end if;
  foreach t in array keep_tables loop
    execute format('select count(*) || '':'' || coalesce(md5(string_agg(md5(x::text), '','' order by md5(x::text))), '''') from public.%I x', t)
      into digest;
    kept_after := kept_after || jsonb_build_object(t, digest);
    if kept_after -> t is distinct from kept_before -> t then
      raise exception 'reset-business-data: kept table public.% changed during the run (count %, was %)',
        t, split_part(kept_after ->> t, ':', 1), split_part(kept_before ->> t, ':', 1);
    end if;
  end loop;
  if to_regclass('storage.objects') is not null then
    execute 'select count(*) from storage.objects' into storage_after;
    if storage_after is distinct from storage_before then
      raise exception 'reset-business-data: storage.objects count changed during the run';
    end if;
  end if;

  -- 9. Report.
  foreach t in array keep_tables || array['auth.users'] || present || absent loop
    summary := summary || jsonb_build_object(
      'table_name', t,
      'before', before_counts -> t,
      'after', after_counts -> t,
      'status', case when t = any (absent) then 'absent (skipped)'
                     when t = any (keep_tables) or t = 'auth.users' then 'kept, unchanged'
                     when t = 'audit_log' then 'cleared + 1 marker row'
                     else 'cleared' end);
    report := report || E'\n  ' || t || ': '
           || coalesce((before_counts ->> t), '-') || ' -> ' || coalesce((after_counts ->> t), '-')
           || case when t = any (absent) then ' (absent, skipped)' else '' end;
  end loop;
  summary := summary || jsonb_build_object(
    'table_name', 'storage.objects', 'before', storage_before, 'after', storage_after,
    'status', 'NOT touched: delete these files by hand');

  if not do_commit then
    raise exception using
      message = 'DRY RUN: rolled back, nothing was changed. Every check passed. Counts before -> after:' || report
             || E'\n  storage.objects (not touched): ' || coalesce(storage_before::text, '-'),
      hint = 'To commit, set do_commit to true and run again.';
  end if;

  perform set_config('tapswipe.reset_business_data', summary::text, false);
  raise notice 'reset-business-data: COMMITTED.%', report;
end
$reset$;

-- Commit mode only (a dry run raised above, so this never runs): the counts.
select r.table_name, r.before, r.after, r.status
  from jsonb_to_recordset(
         coalesce(nullif(current_setting('tapswipe.reset_business_data', true), ''), '[]')::jsonb
       ) as r(table_name text, before bigint, after bigint, status text);
