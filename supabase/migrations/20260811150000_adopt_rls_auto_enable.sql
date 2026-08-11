-- L6 — bring the hosted project's RLS backstop under version control.
--
-- Provenance, since this arrived without a migration behind it: the function and
-- its `ensure_rls` event trigger exist on the linked project only. They appear in
-- no commit on any ref, are absent from the local stack, and are not shipped by
-- the `supabase` CLI package. The code style — RAISE LOG lines, defensive
-- pg_toast%/pg_temp% filters, a blanket EXCEPTION WHEN OTHERS, and
-- `set search_path to 'pg_catalog'` — matches nothing else in this repo. So it
-- was installed out-of-band on the hosted project, via the Dashboard SQL editor
-- or a Supabase advisor action. Who and when is only answerable from the
-- Dashboard's SQL editor history or the org audit log.
--
-- Adopted rather than dropped, because the divergence is the actual cost. Per the
-- note in docs/tapswipe_crm_schema.sql: a migration that forgets
-- `enable row level security` comes up RLS-on-with-no-policies in production
-- (looks like a broken feature) and WIDE OPEN everywhere else (a leak) — the same
-- SQL failing opposite ways, with the environment that looks fine being the one
-- nobody tests against. Adopting makes local match production and lets the test
-- suite assert the backstop instead of warning about it in prose.
--
-- Not a substitute for writing `alter table ... enable row level security` in
-- every migration. It is a net, not a policy: it enables RLS and adds no
-- policies, so a table it catches denies everyone. Belt and braces, in that
-- order.

-- The function is reproduced verbatim from the linked project, so adopting it
-- changes nothing that is already running there.
--
-- security definer is required: it runs ALTER TABLE on tables it does not own.
-- search_path is pinned to pg_catalog so a temp-table shadow cannot redirect any
-- of the catalog lookups below.
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

-- An event-trigger function is never called directly — Postgres refuses a call
-- to anything returning `event_trigger` — so no role needs EXECUTE. The linked
-- project had it granted to `authenticated` from the same legacy default that
-- caused the table-grant finding; harmless, and removed here for tidiness.
revoke all on function public.rls_auto_enable() from public;
revoke all on function public.rls_auto_enable() from anon, authenticated;

-- The event trigger itself is guarded three ways, because this is the half that
-- may legitimately fail:
--
--   1. It ALREADY EXISTS on the linked project, so a bare CREATE would abort the
--      push. `pg_event_trigger` is checked first.
--   2. CREATE EVENT TRIGGER normally requires superuser. Local Postgres is
--      superuser so this succeeds there; the hosted migration role may refuse
--      it. insufficient_privilege is downgraded to a NOTICE so one unavailable
--      backstop cannot block an otherwise good migration — production already
--      has the trigger, which is the whole reason this file exists.
--   3. Any other failure is re-raised, so a genuine mistake here is not silently
--      swallowed the way the function's own EXCEPTION block swallows per-table
--      failures.
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
