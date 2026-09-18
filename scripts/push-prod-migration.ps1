# Apply pending migrations to tapwipe-crm-prod, proving the target BEFORE the
# push and verifying EVERY pending migration after it, in this same process.
#
# Run from the SAME terminal where SUPABASE_DB_PASSWORD is set:
#
#   powershell -File scripts\push-prod-migration.ps1 -DryRun    # connect, list, change nothing
#   powershell -File scripts\push-prod-migration.ps1            # for real
#
# DO THE DRY RUN FIRST. It proves the credential, the pooler host, the target and
# the migration list against the real server without writing anything, which is
# most of what can go wrong.
#
# WHY --yes, AND WHY THE OUTPUT STREAMS.
#
# The first attempt at this hung for over thirty minutes with the CLI at
# near-zero CPU, and had to be killed. `supabase db push` asks "Do you want to
# push these migrations to the remote database?" -- the string is in the binary --
# and the script was capturing its output with `| Out-String`, which holds
# everything until the process exits. So the prompt never reached the terminal,
# nobody could answer it, and the CLI sat waiting on stdin forever. The read-only
# diagnostic confirmed afterwards that nothing had been applied.
#
# Two fixes, and both are needed. `--yes` (a global flag: "Answer yes to all
# prompts") means the question is answered without a human. Streaming the output
# line by line instead of buffering it means anything the CLI says -- a prompt, a
# progress line, an error -- is visible WHILE it happens rather than after. A
# command that can block on input must never have its output swallowed.
#
# Auto-confirming is safe here specifically because this script has already
# proved what it is talking to: it refuses to continue unless the server reports
# a real remote address, and it verifies the result against the catalog
# afterwards rather than trusting the CLI's exit code. The prompt was the CLI
# asking "are you sure you mean the remote database" -- a question this script
# answers more rigorously than a human at a keyboard could.
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
# WHY THE VERIFICATION IS NO LONGER PINNED TO ONE MIGRATION. This script was
# written when exactly one was pending, and hardcoded its version. `db push`
# applies EVERYTHING pending and has no target-version flag, so the moment a
# second migration was waiting the script would have pushed both while checking
# only the first -- and its pre-flight would have exited 0 with "nothing to push"
# as soon as the first was recorded, leaving the second silently missing. A
# verification narrower than the action it verifies is worse than none, because
# it reports PASS.
#
# The migration check now reads supabase/migrations/ and asserts that every
# version on disk has a row on the server, so adding a migration cannot leave it
# behind again. The per-feature structural checks live in scripts/prod-state.ps1
# and catch the other failure: a recorded version row with only some of its DDL.
#
# EVERY LINE IS ALSO WRITTEN TO scripts\logs\, including the CLI's own output and
# the computed PASS/FAIL. A prod migration that leaves no artifact is one nobody
# can audit later.
#
# Captured output is REDACTED before it is written or printed -- anything
# matching the password, encoded or raw, becomes ***. The Supabase CLI echoes the
# connection string in several of its error messages, so a log that records a
# failed push is exactly where a credential would otherwise end up.
#
# READ-ONLY UNTIL THE PUSH STEP, and it aborts before that step if the pre-flight
# cannot prove it is talking to a remote server.

param(
  # Connects to prod, lists what would be applied, and changes nothing. The CLI
  # does the listing itself, so this also proves the credential and the pooler
  # host before a real run touches anything.
  [switch]$DryRun
)

$PROJECT_REF = 'zuvsdkjnfstrjahstsmg'            # tapwipe-crm-prod

# NOTE: CLAUDE.md documents aws-1-us-west-2 for this project; this script has
# always used aws-0. Both resolve to real, distinct Supabase pooler IPs, so DNS
# will not disambiguate them -- the wrong one fails as "Tenant or user not
# found", which reads like a bad password. The pre-flight aborts before the push
# either way, so a wrong host here costs a confusing message and nothing else.
$POOLER_HOST = 'aws-0-us-west-2.pooler.supabase.com'
$POOLER_ALT  = 'aws-1-us-west-2.pooler.supabase.com'
$POOLER_PORT = '5432'                            # session mode; 6543 breaks migrations partway
$CONTAINER   = 'supabase_db_tapswipe-crm'        # borrowed as a psql client only
$REPO        = Split-Path $PSScriptRoot -Parent
$CLI         = Join-Path $REPO 'node_modules\.bin\supabase.cmd'

. (Join-Path $PSScriptRoot 'prod-state.ps1')

# ---------- logging ----------
$LOG_DIR = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path $LOG_DIR)) {
  New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
}
$LOG = Join-Path $LOG_DIR ('push-prod-migration_' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

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

function Get-ProdState {
  param([string]$Url)
  return (docker exec $CONTAINER psql -w -d "$Url" -tA -c $PROD_STATE_SQL 2>&1 | Out-String).Trim()
}

function Get-AppliedVersions {
  param([string]$Url)
  $raw = (docker exec $CONTAINER psql -w -d "$Url" -tA -c $PROD_VERSIONS_SQL 2>&1 | Out-String)
  return @($raw -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d{14}$' })
}

function Report-State {
  param([string]$State, [string[]]$Missing)
  Say $State
  if ($Missing.Count -gt 0) {
    Say ("pending on this server: " + ($Missing -join ', '))
  } else {
    Say 'pending on this server: none'
  }
}

Say ('--- push-prod-migration --- ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
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
  Say 'ABORT: docker not found on PATH (needed as a psql client).'
  exit 1
}

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
$before        = Get-ProdState -Url $url
$appliedBefore = Get-AppliedVersions -Url $url
$missingBefore = Get-MissingMigrations -Local $localVersions -Applied $appliedBefore

Report-State -State $before -Missing $missingBefore

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

# "Nothing to push" is now decided by the FULL check, not by one version row.
# The old script exited 0 here the moment its one hardcoded migration was
# recorded -- which, with a second one pending, would have been a PASS over an
# unapplied migration.
$problemsBefore = Get-ProdStateFailures -State $before -Missing $missingBefore

if ($missingBefore.Count -eq 0) {
  if ($problemsBefore.Count -eq 0) {
    Say 'NOTE: every migration in the repo is already recorded here, and the structure checks pass.'
    Say 'RESULT: PASS -- nothing to push.'
    Say ('--- end --- log written to ' + $LOG)
    Remove-Variable enc, url -ErrorAction SilentlyContinue
    exit 0
  }

  # Every version row present but the structure wrong: a half-applied migration.
  # Pushing again would not fix it -- db push skips versions already recorded.
  Say 'RESULT: FAIL -- every migration is recorded, but the schema does not match:'
  foreach ($problem in $problemsBefore) { Say ("  - " + $problem) }
  Say 'Nothing was pushed. db push skips recorded versions, so this needs a look rather than a re-run.'
  Say ('--- end --- log written to ' + $LOG)
  Remove-Variable enc, url -ErrorAction SilentlyContinue
  exit 1
}

# ---------- PUSH ----------
Say '--- push ---'
Say ('Pending: ' + $missingBefore.Count + ' migration(s). db push applies everything pending and has no')
Say ('target-version flag, so all of them go in this one command: ' + ($missingBefore -join ', '))

if ($DryRun) {
  Say 'DRY RUN: --dry-run is set, so the CLI will list and change nothing.'
}

# Streamed, not captured. Buffering with Out-String is what made the first
# attempt hang for thirty minutes: the CLI's confirmation prompt never reached
# the terminal. Each line is redacted and logged as it arrives, so a prompt or a
# stall is visible immediately.
#
# 2>&1 sends the CLI's stderr down the same pipeline, but PowerShell 5.1 wraps
# each of those lines in an ErrorRecord -- which renders with "At line:N char:M"
# noise and a stack trace around what is really just a status message. Flattened
# with ToString() so the log reads like the terminal does.
$pushArgs = @('db', 'push', '--db-url', $url, '--yes')
if ($DryRun) { $pushArgs += '--dry-run' }

& $CLI @pushArgs 2>&1 | ForEach-Object {
  if ($_ -is [System.Management.Automation.ErrorRecord]) {
    Say $_.ToString()
  } else {
    Say ([string]$_)
  }
}
$pushExit = $LASTEXITCODE

Say ('cli exit code: ' + $pushExit)

if ($DryRun) {
  Say '--- end of dry run ---'
  Say 'Nothing was applied. Re-run without -DryRun to apply, and the result will be'
  Say 'verified against the server catalog rather than against the exit code above.'
  Say ('--- end --- log written to ' + $LOG)
  exit 0
}

# ---------- VERIFY (read-only, same process, same connection shape) ----------
Say '--- after ---'
$after        = Get-ProdState -Url $url
$appliedAfter = Get-AppliedVersions -Url $url
$missingAfter = Get-MissingMigrations -Local $localVersions -Applied $appliedAfter

Report-State -State $after -Missing $missingAfter

Remove-Variable enc, url -ErrorAction SilentlyContinue

$problems = Get-ProdStateFailures -State $after -Missing $missingAfter

if ($problems.Count -eq 0) {
  Say ('RESULT: PASS -- all ' + $localVersions.Count + ' migrations are recorded, and every structure check passes:')
  Say '  - pre_apps_guard_transitions carries the tg_op branch, behind a BEFORE INSERT OR UPDATE trigger'
  Say '  - both user_import tables exist with RLS on, 3 policies, the profiles FK, 3 grants to authenticated,'
  Say '    no grant to anon, and the partial index'
  Say ('--- end --- log written to ' + $LOG)
  exit 0
}

# Named individually, because the responses differ: nothing applied at all is a
# re-run, a half-applied migration is not.
Say 'RESULT: FAIL -- prod does not match what was pushed:'
foreach ($problem in $problems) { Say ("  - " + $problem) }

if ($missingAfter.Count -eq $missingBefore.Count) {
  Say 'Nothing landed at all. Report this output.'
} elseif ($missingAfter.Count -gt 0) {
  Say 'SOME migrations landed and some did not. Do not re-run blindly; report this output.'
} else {
  Say 'Every version row is present but the schema does not match -- a HALF-APPLIED migration.'
  Say 'Do not re-run: db push skips recorded versions. Report this output.'
}

Say ('--- end --- log written to ' + $LOG)
exit 1
