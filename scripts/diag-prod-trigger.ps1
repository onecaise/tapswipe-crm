# Diagnostic: which database are we actually talking to, and what is on it?
#
# READ-ONLY. Two SELECTs. No writes, no DDL, no migrations, nothing applied.
#
# Run it from the SAME terminal where SUPABASE_DB_PASSWORD is set, because a
# child process inherits that terminal's environment and nothing else:
#
#   powershell -File scripts\diag-prod-trigger.ps1
#
# The password is never printed. It is read from $env:SUPABASE_DB_PASSWORD,
# percent-encoded into the connection URL, and only its CHARACTER COUNT is
# reported -- enough to see the variable is populated, not enough to disclose
# anything.
#
# EVERY LINE IS ALSO WRITTEN TO scripts\logs\, and that is not a convenience.
# This script was run three times in one session and left no artifact at all, so
# a later session could not tell whether prod had a migration: the answer existed
# only in a terminal nobody still had open, and the question had to be relayed
# through a person. Output that is only on screen is output that did not happen.
#
# Captured output is REDACTED before it is written or printed -- anything
# matching the password, encoded or raw, becomes ***.
#
# WHAT IT CHECKS, AND WHY IT IS NO LONGER ABOUT ONE TRIGGER. This started as a
# probe for a single pending migration and hardcoded its version. That does not
# survive a second migration, so the checks now live in scripts/prod-state.ps1
# and are shared with push-prod-migration.ps1 -- one probe, so the thing that
# verifies a push cannot drift from the thing that reports the state. The
# migration check is derived from supabase/migrations/ rather than hardcoded, so
# adding a migration cannot leave it behind.
#
# WHY inet_server_addr() AND NOT THE MIGRATION LIST, to tell prod from local:
# every database in this estate shares the same migration list, so `latest=...`
# is equally consistent with "this is local" and with "this is prod and the
# migration never applied" -- two very different situations. A unix-socket
# connection (the container's own Postgres) reports a NULL server address;
# anything over the pooler reports a real IP. That field is the only one in this
# output that cannot be misread.
#
# The local Postgres container is borrowed purely as a psql CLIENT. The
# connection it opens goes to the remote pooler, not to itself.

$PROJECT_REF = 'zuvsdkjnfstrjahstsmg'            # tapwipe-crm-prod

# NOTE: CLAUDE.md documents aws-1-us-west-2 for this project; this script has
# always used aws-0, and the two have never been reconciled against a successful
# connection. Both resolve to real, distinct Supabase pooler IPs, so DNS will not
# tell you which is right -- the wrong one fails as "Tenant or user not found",
# which reads like a bad password. If this run fails that way, try the alternate
# before touching the credential.
$POOLER_HOST = 'aws-0-us-west-2.pooler.supabase.com'
$POOLER_ALT  = 'aws-1-us-west-2.pooler.supabase.com'
$POOLER_PORT = '5432'                            # session mode; 6543 is transaction mode and breaks migrations
$CONTAINER   = 'supabase_db_tapswipe-crm'        # psql client only
$REPO        = Split-Path $PSScriptRoot -Parent

. (Join-Path $PSScriptRoot 'prod-state.ps1')

# ---------- logging ----------
$LOG_DIR = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path $LOG_DIR)) {
  New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
}
$LOG = Join-Path $LOG_DIR ('diag-prod-trigger_' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

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

$localVersions = Get-LocalMigrationVersions -RepoRoot $REPO
Say ('migrations in the repo: ' + $localVersions.Count + ' (newest ' + $localVersions[-1] + ')')

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

# Checked explicitly because `docker exec` against a stopped container fails with
# a message about the container, which reads like a problem with prod.
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

Say '--- state ---'

# Captured rather than streamed, so it reaches the log as well as the screen.
# 2>&1 so a connection failure is recorded too: that is the output most worth
# keeping and the one most likely to be lost.
$state = (docker exec $CONTAINER psql -w -d "$url" -tA -c $PROD_STATE_SQL 2>&1 | Out-String).Trim()
$code  = $LASTEXITCODE
Say $state
Say ('exit code: ' + $code)

if ($code -ne 0 -or $state -notmatch 'server=') {
  Say '--- hint ---'
  Say 'If that failed with "Tenant or user not found", the pooler host is the likelier'
  Say 'cause than the password. Re-run with $POOLER_HOST set to:'
  Say ('  ' + $POOLER_ALT)
  Say 'CLAUDE.md documents that one; this script has always used the other.'
  Say ('--- end --- log written to ' + $LOG)
  Remove-Variable enc, url -ErrorAction SilentlyContinue
  exit 1
}

if ($state -match 'SOCKET-LOCAL') {
  Say 'WARNING: this connection reached a local unix socket, NOT prod. Everything'
  Say '         below describes the local database and says nothing about production.'
}

# ---------- what is pending ----------
$rawVersions = (docker exec $CONTAINER psql -w -d "$url" -tA -c $PROD_VERSIONS_SQL 2>&1 | Out-String)
$applied     = @($rawVersions -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d{14}$' })
$missing     = Get-MissingMigrations -Local $localVersions -Applied $applied

Say '--- migrations ---'
Say ('recorded on this server: ' + $applied.Count + ' of ' + $localVersions.Count + ' in the repo')
if ($missing.Count -gt 0) {
  Say ('PENDING: ' + ($missing -join ', '))
} else {
  Say 'PENDING: none'
}

# ---------- verdict ----------
$problems = Get-ProdStateFailures -State $state -Missing $missing

Say '--- verdict ---'
if ($problems.Count -eq 0) {
  Say 'UP TO DATE -- every migration is recorded and every structure check passes.'
} else {
  Say 'NOT UP TO DATE:'
  foreach ($problem in $problems) { Say ("  - " + $problem) }
  if ($missing.Count -gt 0) {
    Say ''
    Say 'To apply them: powershell -File scripts\push-prod-migration.ps1'
    Say '(from this same terminal, so it inherits the password)'
  }
}

Say ('--- end --- log written to ' + $LOG)

Remove-Variable enc, url, state -ErrorAction SilentlyContinue

if ($problems.Count -eq 0) { exit 0 } else { exit 1 }
