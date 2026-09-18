# Shared "what does prod actually look like" probe, dot-sourced by
# diag-prod-trigger.ps1 and push-prod-migration.ps1.
#
# WHY THIS FILE EXISTS. Both scripts were written when exactly one migration was
# pending, and both hardcoded its version. That was fine for a day and then was
# not: once a second migration was waiting, `supabase db push` would have applied
# BOTH while the verification only looked at the first — and worse, the push
# script's pre-flight would have exited 0 saying "nothing to push" the moment the
# first one was recorded, with the second still missing. A verification that
# silently covers less than the action it verifies is worse than none, because it
# reports PASS.
#
# So the two scripts now share one probe, and the migration check is DERIVED
# rather than hardcoded: it reads supabase/migrations/ and asserts that every
# version on disk has a row on the server. Adding a migration cannot leave that
# check behind again.
#
# The structural checks below are still bespoke per feature, because there is no
# generic way to ask "did this migration's DDL really all land". They exist to
# catch a HALF-APPLIED migration — a recorded version row with only some of its
# objects — which a version check alone cannot see.
#
# EXPECTED VALUES WERE MEASURED, NOT GUESSED. Every number here was read off the
# local database with both migrations applied (18 Sep 2026). If one changes
# because the schema legitimately changed, update it here and say so.

# One line, so the whole state can be logged, matched and compared as a unit.
#
# inet_server_addr() is the field that cannot be misread: a unix-socket
# connection to a container's own Postgres reports NULL, anything over the pooler
# reports a real IP. The migration list is NOT proof of which database this is —
# every database in the estate shares it.
$PROD_STATE_SQL = @"
select 'server=' || coalesce(host(inet_server_addr()),'SOCKET-LOCAL')
    || ' | port=' || coalesce(inet_server_port()::text,'na')
    || ' | db=' || current_database()
    || ' | latest=' || coalesce((select max(version) from supabase_migrations.schema_migrations),'none')
    || ' | fn_has_insert_branch=' || coalesce((select case when prosrc like '%tg_op%' then 'yes' else 'no' end from pg_proc where proname = 'pre_apps_guard_transitions' limit 1),'no-function')
    || ' | ui_tables=' || (select count(*)::text from pg_class where relname in ('user_import_batches','user_import_rows') and relkind = 'r')
    || ' | ui_rls=' || (select count(*)::text from pg_class where relname in ('user_import_batches','user_import_rows') and relkind = 'r' and relrowsecurity)
    || ' | ui_policies=' || (select count(*)::text from pg_policies where tablename in ('user_import_batches','user_import_rows'))
    || ' | ui_fk=' || (select count(*)::text from pg_constraint c join pg_class t on t.oid = c.conrelid where c.contype = 'f' and t.relname = 'user_import_batches' and c.confrelid = 'public.profiles'::regclass)
    || ' | ui_grants=' || (select count(*)::text from information_schema.role_table_grants where grantee = 'authenticated' and table_name in ('user_import_batches','user_import_rows'))
    || ' | ui_anon=' || (select count(*)::text from information_schema.role_table_grants where grantee = 'anon' and table_name in ('user_import_batches','user_import_rows'))
    || ' | ui_idx=' || (select count(*)::text from pg_indexes where indexname = 'idx_user_import_rows_pending')
    || ' | trigger=' || coalesce((select pg_get_triggerdef(oid) from pg_trigger where tgname='pre_apps_guard_transitions'),'NONE')
"@

# One version per line, for the derived migration check.
$PROD_VERSIONS_SQL =
  "select version from supabase_migrations.schema_migrations order by version"

<#
.SYNOPSIS
  Every migration version in supabase/migrations/, read off disk.
.DESCRIPTION
  The filename is <version>_<name>.sql, so the version is everything before the
  first underscore. This is what makes the check self-maintaining: a new
  migration is picked up with no edit to either script.
#>
function Get-LocalMigrationVersions {
  param([string]$RepoRoot)
  $dir = Join-Path $RepoRoot 'supabase\migrations'
  if (-not (Test-Path $dir)) { return @() }
  return @(
    Get-ChildItem -Path $dir -Filter '*.sql' |
      ForEach-Object { ($_.BaseName -split '_', 2)[0] } |
      Where-Object { $_ -match '^\d{14}$' } |
      Sort-Object
  )
}

<#
.SYNOPSIS
  Local migration versions with no row on the server.
.DESCRIPTION
  Direction matters: this reports what the REPO has and the server does not.
  A version on the server that is absent locally is somebody else's problem and
  is deliberately not treated as a failure here.
#>
function Get-MissingMigrations {
  param([string[]]$Local, [string[]]$Applied)
  $have = @{}
  foreach ($version in $Applied) {
    $trimmed = $version.Trim()
    if ($trimmed -ne '') { $have[$trimmed] = $true }
  }
  return @($Local | Where-Object { -not $have.ContainsKey($_) })
}

<#
.SYNOPSIS
  Everything wrong with a state read. Empty means PASS.
.DESCRIPTION
  Returns prose rather than a boolean so a failure says WHICH check failed —
  the difference between "nothing was applied" and "the function was replaced
  but its trigger was not" needs different responses, and a bare $false makes
  them look identical.
#>
function Get-ProdStateFailures {
  param([string]$State, [string[]]$Missing)

  $problems = @()

  if ($Missing -and $Missing.Count -gt 0) {
    $problems += ("migrations with no row on this server: " + ($Missing -join ', '))
  }

  # --- 20260916104500_pre_apps_guard_insert ---------------------------------
  # Two checks, not one, because the migration does `create or replace function`
  # and then `drop trigger` / `create trigger`. If the first committed and the
  # second did not, prod holds a function that branches on tg_op behind a trigger
  # that never fires on insert -- worse than before the push, and invisible
  # unless asked for directly.
  if ($State -notmatch 'fn_has_insert_branch=yes') {
    $problems += 'pre_apps_guard_transitions does not carry the tg_op branch'
  }
  if ($State -notmatch 'BEFORE INSERT OR UPDATE') {
    $problems += 'pre_apps_guard_transitions trigger is not BEFORE INSERT OR UPDATE'
  }

  # --- 20260918141129_user_imports ------------------------------------------
  # Measured on the local database with the migration applied. Tables, RLS,
  # policies, the profiles FK, the grants and the partial index are checked
  # separately so a partial apply names the part that is missing. RLS and grants
  # especially: a table that arrives with RLS off is a leak, and one that arrives
  # with no grant answers every request with "permission denied" -- opposite
  # failures that a table-existence check alone would miss.
  $expected = @(
    @{ key = 'ui_tables';   want = 2; what = 'user_import tables' },
    @{ key = 'ui_rls';      want = 2; what = 'user_import tables with RLS enabled' },
    @{ key = 'ui_policies'; want = 3; what = 'policies across the user_import tables' },
    @{ key = 'ui_fk';       want = 1; what = 'user_import_batches -> profiles foreign key' },
    @{ key = 'ui_grants';   want = 3; what = 'grants to authenticated on the user_import tables' },
    @{ key = 'ui_idx';      want = 1; what = 'idx_user_import_rows_pending partial index' }
  )

  foreach ($check in $expected) {
    $pattern = $check.key + '=(\d+)'
    if ($State -match $pattern) {
      $got = [int]$Matches[1]
      if ($got -ne $check.want) {
        $problems += ("{0}: found {1}, expected {2}" -f $check.what, $got, $check.want)
      }
    } else {
      $problems += ("could not read {0} from the server state" -f $check.key)
    }
  }

  # anon must hold NOTHING. Asserted rather than assumed: the deprecated
  # auto-exposure of new objects is exactly the accident this catches.
  if ($State -match 'ui_anon=(\d+)') {
    $anon = [int]$Matches[1]
    if ($anon -ne 0) {
      $problems += ("anon holds {0} grant(s) on the user_import tables -- it must hold none" -f $anon)
    }
  } else {
    $problems += 'could not read ui_anon from the server state'
  }

  return $problems
}
