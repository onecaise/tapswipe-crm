# Apply pending migrations to tapwipe-crm-prod, proving the target BEFORE the
# push and verifying the result AFTER it, in this same process.
#
# Run from the SAME terminal where SUPABASE_DB_PASSWORD is set:
#
#   powershell -File scripts\push-prod-migration.ps1
#
# WHY THIS EXISTS RATHER THAN A PASTED COMMAND:
# a pasted `db push --db-url $dbUrl` reported "Applying migration ... exit code
# 0" while prod never received it, and no database in the estate did. Two CLI
# behaviours make that failure silent and are worth knowing:
#
#   1. `--db-url ""` does NOT error. It falls back to libpq defaults --
#      measured: `host=localhost user=owen database=owen`. An empty variable
#      therefore aims the push at an entirely different machine, quietly.
#   2. The CLI's own success message is not evidence of anything. It reports
#      what it believes it did, against whatever target it resolved.
#
# So this script never trusts the exit message. It asks the server directly,
# before and after, and calls the push a failure unless prod's catalog changed.
#
# EVERY LINE IS ALSO WRITTEN TO scripts\logs\, including the CLI's own output
# and the computed PASS/FAIL. A prod migration that leaves no artifact is a prod
# migration nobody can audit later -- and the companion diagnostic already
# proved that point the hard way, having been run three times in one session
# with its answer surviving only in a terminal that was then closed. The log
# directory is gitignored.
#
# Captured output is REDACTED before it is written or printed -- anything
# matching the password, encoded or raw, becomes ***. The Supabase CLI echoes
# the connection string in several of its error messages, so a log that records
# a failed push is exactly where a credential would otherwise end up.
#
# The password is never printed -- only its character count, so an empty or
# mangled variable is visible without disclosing the value. No credential is
# stored in this file.
#
# READ-ONLY UNTIL THE PUSH STEP, and it aborts before that step if the
# pre-flight cannot prove it is talking to a remote server.

$PROJECT_REF = 'zuvsdkjnfstrjahstsmg'            # tapwipe-crm-prod

# NOTE: CLAUDE.md documents aws-1-us-west-2 for this project; this script has
# always used aws-0, and the two have never been reconciled against a successful
# connection. Both resolve to real, distinct Supabase pooler IPs, so DNS will not
# disambiguate them -- the wrong one fails as "Tenant or user not found", which
# reads like a bad password. The pre-flight below aborts before the push either
# way, so a wrong host here costs a confusing message and nothing else.
$POOLER_HOST = 'aws-0-us-west-2.pooler.supabase.com'
$POOLER_ALT  = 'aws-1-us-west-2.pooler.supabase.com'
$POOLER_PORT = '5432'                            # session mode; 6543 breaks migrations partway
$CONTAINER   = 'supabase_db_tapswipe-crm'        # borrowed as a psql client only
$MIGRATION   = '20260916104500'
$REPO        = Split-Path $PSScriptRoot -Parent
$CLI         = Join-Path $REPO 'node_modules\.bin\supabase.cmd'

# ---------- logging ----------
$LOG_DIR = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path $LOG_DIR)) {
  New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
}
$LOG = Join-Path $LOG_DIR ('push-prod-migration_' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

# Strips the credential out of anything captured from a child process, in both
# the percent-encoded form that goes into the URL and the raw form. Runs before
# the text reaches the console OR the log.
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

$STATE_SQL = "select 'server=' || coalesce(host(inet_server_addr()),'SOCKET-LOCAL') || ' | port=' || coalesce(inet_server_port()::text,'na') || ' | migration_row=' || (select count(*)::text from supabase_migrations.schema_migrations where version = '$MIGRATION') || ' | latest=' || coalesce((select max(version) from supabase_migrations.schema_migrations),'none') || ' | fn_has_insert_branch=' || coalesce((select case when prosrc like '%tg_op%' then 'yes' else 'no' end from pg_proc where proname = 'pre_apps_guard_transitions' limit 1),'no-function') || ' | trigger=' || coalesce((select pg_get_triggerdef(oid) from pg_trigger where tgname='pre_apps_guard_transitions'),'NONE')"

function Get-ProdState {
  param([string]$Url)
  return (docker exec $CONTAINER psql -w -d "$Url" -tA -c $STATE_SQL 2>&1 | Out-String).Trim()
}

Say ('--- push-prod-migration --- ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Say ('log: ' + $LOG)
Say ('migration: ' + $MIGRATION)

if ([string]::IsNullOrEmpty($env:SUPABASE_DB_PASSWORD)) {
  Say 'ABORT: $env:SUPABASE_DB_PASSWORD is empty in this process.'
  Say 'Set it in the terminal you launch this from, WITHOUT typing it as a literal:'
  Say '  $sec = Read-Host -AsSecureString "prod db password"'
  Say '  $env:SUPABASE_DB_PASSWORD = (New-Object PSCredential 0, $sec).GetNetworkCredential().Password'
  exit 1
}
if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
  Say 'ABORT: docker not found on PATH (needed as a psql client).'
  exit 1
}

# Checked explicitly: `docker exec` against a stopped container fails with a
# message about the container, which reads like a problem with prod.
$containerUp = docker ps --format '{{.Names}}' | Select-String -SimpleMatch $CONTAINER
if ($null -eq $containerUp) {
  Say ('ABORT: container ' + $CONTAINER + ' is not running. Start the local stack (npx supabase start).')
  Say '       It is borrowed purely as a psql client -- the push still goes to the remote pooler.'
  exit 1
}
if (-not (Test-Path $CLI)) {
  Say ('ABORT: supabase CLI not found at ' + $CLI)
  exit 1
}

$enc      = [uri]::EscapeDataString([string]$env:SUPABASE_DB_PASSWORD)
$url      = "postgresql://postgres.${PROJECT_REF}:${enc}@${POOLER_HOST}:${POOLER_PORT}/postgres"
$expected = "postgresql://postgres.${PROJECT_REF}:@${POOLER_HOST}:${POOLER_PORT}/postgres".Length + $enc.Length

Say ('CHECK pwchars=' + $enc.Length + ' urlchars=' + $url.Length + ' expected=' + $expected)
Say ('TARGET ' + $POOLER_HOST + ':' + $POOLER_PORT + ' as postgres.' + $PROJECT_REF)

if ($url.Length -ne $expected) {
  Say 'ABORT: connection string length does not match expected -- it was mangled in transit.'
  exit 1
}

# ---------- PRE-FLIGHT (read-only) ----------
Say '--- before ---'
$before = Get-ProdState -Url $url
Say $before

if ($before -notmatch 'server=') {
  Say 'ABORT: could not read server state. Nothing was pushed.'
  if ($before -match 'Tenant or user not found') {
    Say ('HINT: that error usually means the wrong pooler host, not the wrong password. Try ' + $POOLER_ALT)
  }
  exit 1
}
if ($before -match 'SOCKET-LOCAL') {
  Say 'ABORT: this connection reached a local unix socket, not prod. Nothing was pushed.'
  exit 1
}
if ($before -match 'migration_row=1') {
  Say ('NOTE: ' + $MIGRATION + ' is already recorded on this server. Nothing to push.')
  Say 'RESULT: PASS -- already applied.'
  Say ('--- end --- log written to ' + $LOG)
  Remove-Variable enc, url -ErrorAction SilentlyContinue
  exit 0
}

# ---------- PUSH ----------
Say '--- push ---'
Say 'Running supabase db push (output is captured, so nothing appears until it finishes).'

$pushOut  = (& $CLI db push --db-url $url 2>&1 | Out-String).TrimEnd()
$pushExit = $LASTEXITCODE

Say $pushOut
Say ('cli exit code: ' + $pushExit)

# ---------- VERIFY (read-only, same process, same connection shape) ----------
Say '--- after ---'
$after = Get-ProdState -Url $url
Say $after

Remove-Variable enc, url -ErrorAction SilentlyContinue

$ok = ($after -match "migration_row=1") -and
      ($after -match 'fn_has_insert_branch=yes') -and
      ($after -match 'BEFORE INSERT OR UPDATE')

if ($ok) {
  Say 'RESULT: PASS -- prod now has the migration row, the tg_op branch, and a BEFORE INSERT OR UPDATE trigger.'
  Say ('--- end --- log written to ' + $LOG)
  exit 0
}

# Deliberately distinguishes the two failure shapes, because they need
# different responses: nothing happened, versus the function was replaced
# without the trigger.
if ($after -match 'fn_has_insert_branch=yes') {
  Say 'RESULT: FAIL -- HALF APPLIED. The function carries the tg_op branch but the trigger is not BEFORE INSERT OR UPDATE. Do not re-run; report this output.'
} else {
  Say 'RESULT: FAIL -- prod is unchanged. Nothing was applied. Report this output.'
}

Say ('--- end --- log written to ' + $LOG)
exit 1
