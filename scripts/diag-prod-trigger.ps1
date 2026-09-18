# Diagnostic: which database are we actually talking to, and what does the
# pre_apps status-guard trigger look like there?
#
# READ-ONLY. One SELECT. No writes, no DDL, no migrations, nothing applied.
#
# Run it from the SAME terminal where SUPABASE_DB_PASSWORD is set, because a
# child process inherits that terminal's environment and nothing else:
#
#   powershell -File scripts\diag-prod-trigger.ps1
#
# The password is never printed. It is read from $env:SUPABASE_DB_PASSWORD,
# percent-encoded into the connection URL, and only its CHARACTER COUNT is
# reported -- enough to see that the variable is populated, not enough to
# disclose anything.
#
# EVERY LINE IS ALSO WRITTEN TO scripts\logs\, and that is not a convenience.
# This script was run three times in one session and left no artifact at all, so
# a later session could not tell whether prod had the migration: the answer
# existed only in a terminal nobody still had open, and the question had to be
# relayed through a person. Output that is only on screen is output that did not
# happen. The log directory is gitignored.
#
# Captured output is REDACTED before it is written or printed -- anything
# matching the password, encoded or raw, becomes ***. psql and the Supabase CLI
# both echo a connection string in some error messages, and a log written to
# stop evidence being lost must not become the thing that leaks the credential.
#
# WHY inet_server_addr() AND NOT THE MIGRATION VERSION:
# the migration list is not a reliable way to tell prod from local. Every
# database here shares the same list, so `latest=20260824120000` is equally
# consistent with "this is local" and with "this is prod and the new migration
# never applied" -- two very different situations. A unix-socket connection
# (the container's own Postgres) reports a NULL server address; anything
# reached over the pooler reports a real IP and port 5432. That field is the
# only one in this output that cannot be misread.
#
# The local Postgres container is borrowed purely as a psql CLIENT. The
# connection it opens goes to the remote pooler, not to itself.
#
# Safe to delete once we have an answer. It holds no secret -- only a
# reference to the environment variable.

$PROJECT_REF = 'zuvsdkjnfstrjahstsmg'            # tapwipe-crm-prod

# NOTE: CLAUDE.md documents aws-1-us-west-2 for this project; this script has
# always used aws-0, and the two have never been reconciled against a successful
# connection. Both hostnames resolve to real, distinct Supabase pooler IPs, so
# DNS will not tell you which is right -- the wrong one fails as "Tenant or user
# not found", which reads like a bad password. If this run fails that way, try
# the alternate before touching the credential. The hint at the bottom says so
# again at the moment it is relevant.
$POOLER_HOST = 'aws-0-us-west-2.pooler.supabase.com'
$POOLER_ALT  = 'aws-1-us-west-2.pooler.supabase.com'
$POOLER_PORT = '5432'                            # session mode; 6543 is transaction mode and breaks migrations
$CONTAINER   = 'supabase_db_tapswipe-crm'        # psql client only

# ---------- logging ----------
$LOG_DIR = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path $LOG_DIR)) {
  New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
}
$LOG = Join-Path $LOG_DIR ('diag-prod-trigger_' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

# Strips the credential out of anything captured from a child process, in both
# the percent-encoded form that goes into the URL and the raw form. Runs before
# the text reaches the console OR the log, because a pasted screenshot of a
# terminal leaks exactly as well as a file does.
function Redact {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return $Text }
  $out = $Text
  if (-not [string]::IsNullOrEmpty($env:SUPABASE_DB_PASSWORD)) {
    $raw = [string]$env:SUPABASE_DB_PASSWORD
    $out = $out -replace [regex]::Escape($raw), '***'
    $out = $out -replace [regex]::Escape([uri]::EscapeDataString($raw)), '***'
  }
  return $out
}

function Say {
  param([string]$Message)
  $clean = Redact $Message
  Write-Host $clean
  Add-Content -Path $LOG -Value $clean -Encoding utf8
}

Say ('--- diag-prod-trigger (read-only) --- ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Say ('log: ' + $LOG)

if ([string]::IsNullOrEmpty($env:SUPABASE_DB_PASSWORD)) {
  Say 'ABORT: $env:SUPABASE_DB_PASSWORD is empty in this process.'
  Say 'Set it in the terminal you launch this from, WITHOUT typing it as a literal:'
  Say '  $sec = Read-Host -AsSecureString "prod db password"'
  Say '  $env:SUPABASE_DB_PASSWORD = (New-Object PSCredential 0, $sec).GetNetworkCredential().Password'
  exit 1
}

if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
  Say 'ABORT: docker not found on PATH.'
  exit 1
}

# The container is only a psql client, but it does have to be running. Checked
# explicitly because `docker exec` against a stopped container fails with a
# message about the container, which reads like a problem with prod.
$containerUp = docker ps --format '{{.Names}}' | Select-String -SimpleMatch $CONTAINER
if ($null -eq $containerUp) {
  Say ('ABORT: container ' + $CONTAINER + ' is not running.')
  Say '       Start the local stack first (npx supabase start). It is borrowed purely'
  Say '       as a psql client -- the connection still goes to the remote pooler.'
  exit 1
}

$enc      = [uri]::EscapeDataString([string]$env:SUPABASE_DB_PASSWORD)
$url      = "postgresql://postgres.${PROJECT_REF}:${enc}@${POOLER_HOST}:${POOLER_PORT}/postgres"
$expected = "postgresql://postgres.${PROJECT_REF}:@${POOLER_HOST}:${POOLER_PORT}/postgres".Length + $enc.Length

# Integrity line. pwchars=0 means the variable was empty; urlchars != expected
# means the string was mangled somewhere between here and psql.
Say ('CHECK pwchars=' + $enc.Length + ' urlchars=' + $url.Length + ' expected=' + $expected)
Say ('TARGET ' + $POOLER_HOST + ':' + $POOLER_PORT + ' as postgres.' + $PROJECT_REF)

# fn_has_insert_branch is the half-applied detector. The migration does
# `create or replace function` and then `drop trigger` / `create trigger`. If
# the first committed and the second did not, prod would hold a function that
# branches on tg_op = 'INSERT' behind a trigger that never fires on insert --
# worse than before the push, and invisible unless asked for directly.
$sql = "select 'server=' || coalesce(host(inet_server_addr()),'SOCKET-LOCAL') || ' | port=' || coalesce(inet_server_port()::text,'na') || ' | db=' || current_database() || ' | migration_row=' || (select count(*)::text from supabase_migrations.schema_migrations where version = '20260916104500') || ' | latest=' || coalesce((select max(version) from supabase_migrations.schema_migrations),'none') || ' | fn_has_insert_branch=' || coalesce((select case when prosrc like '%tg_op%' then 'yes' else 'no' end from pg_proc where proname = 'pre_apps_guard_transitions' limit 1),'no-function') || ' | trigger=' || coalesce((select pg_get_triggerdef(oid) from pg_trigger where tgname='pre_apps_guard_transitions'),'NONE')"

Say '--- result ---'

# Captured rather than streamed, so it reaches the log as well as the screen.
# 2>&1 so a connection failure is recorded too: that is the output most worth
# keeping and the one most likely to be lost.
$out  = (docker exec $CONTAINER psql -w -d "$url" -tA -c $sql 2>&1 | Out-String).TrimEnd()
$code = $LASTEXITCODE

Say $out
Say ('exit code: ' + $code)

if ($code -ne 0) {
  Say '--- hint ---'
  Say 'If that failed with "Tenant or user not found", the pooler host is the likelier'
  Say 'cause than the password. Re-run with $POOLER_HOST set to:'
  Say ('  ' + $POOLER_ALT)
  Say 'CLAUDE.md documents that one; this script has always used the other.'
}

Say ('--- end --- log written to ' + $LOG)

Remove-Variable enc, url, sql, out -ErrorAction SilentlyContinue
