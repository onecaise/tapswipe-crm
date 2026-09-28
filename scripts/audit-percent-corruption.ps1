<#
.SYNOPSIS
  READ-ONLY audit of a deployed project for percentage values corrupted by the
  pre-fix caret bug in lib/masks.ts. Writes nothing, ever.

.DESCRIPTION
  THE BUG. Until the fix, `isSignificant` in lib/masks.ts excluded ".", so the
  caret machinery treated a TYPED decimal point like a mask-inserted separator
  and parked the caret before it. Every digit typed after the point landed to
  its LEFT:

      typed 0.5  -> stored 5        typed 12.5 -> stored 125
      typed 1.5  -> stored 15       typed 60.5 -> stored 605
      typed 9.9  -> stored 99       typed 99.9 -> stored 999

  Two properties make this detectable, and one makes it partly undetectable.

  DETECTABLE: maskPercent caps the whole part at three digits and the fraction
  ends up EMPTY, so a corrupted value is always a WHOLE NUMBER and always <= 999.
  Anything > 100 in a percentage column is therefore corruption -- no legitimate
  path writes it, and every one of these columns is a percentage.

  ALSO DETECTABLE, in the negative: the buggy wizard could never store a value
  with a fractional part. So any column holding a genuine decimal proves that
  value did NOT come through the bug -- and that reps do enter decimals there,
  which raises rather than lowers concern about the band below.

  NOT DETECTABLE from the value alone: an input under 10 corrupts into the 1-100
  band (5.5 -> 55) where it is indistinguishable from someone typing 55. That is
  what `whole_1_100` counts. It is an EXPOSURE figure, not a finding.

  WHICH COLUMNS. Only the four pre-app wizard steps route through maskPercent +
  MaskedInput, so only these ten columns could be affected:
    pre_apps.split_agent_pct / split_company_pct   (0-100 gated in toPayload,
                                                    so only the <10 band lands)
    pre_app_owners.percent_owned                   (NaN-only gate)
    pre_app_terminal.tax_rate                      (NaN-only gate; numeric(5,3)
                                                    so >99.999 overflows and the
                                                    save FAILS -- only the <10
                                                    band can land here)
    pre_app_business_profile.* (six columns)       (NaN-only gate; numeric(5,2),
                                                    so the full 101-999 range
                                                    lands -- most exposed)
  merchants.split_*_pct is NOT affected: that form uses a native type="number"
  input and never touches the mask. rep_payout_rows.rep_split_pct is NOT
  affected: it goes through parseFigureInput, not the masks.

.PARAMETER ProjectRef
  The Supabase project ref to audit. Pass the dev or prod ref explicitly --
  there is no default, because "which database am I about to read" is exactly
  the question this estate has got wrong before.

.NOTES
  Run from the SAME terminal where SUPABASE_DB_PASSWORD is set, and set it with
  Read-Host -AsSecureString rather than a literal assignment: PSReadLine's
  sensitive-input filter catches the word "password" but NOT a credential
  embedded in a URL, which is how three of them ended up in shell history.

      $sec = Read-Host 'db password' -AsSecureString
      $env:SUPABASE_DB_PASSWORD = (New-Object PSCredential 0, $sec).GetNetworkCredential().Password

  The local Postgres container is borrowed purely as a psql CLIENT; the
  connection it opens goes to the remote pooler, not to itself. inet_server_addr()
  is printed so the target cannot be misread.
#>
param(
  [Parameter(Mandatory = $true)][string]$ProjectRef
)

$ErrorActionPreference = 'Stop'

# aws-0, not aws-1. Both resolve and both accept TCP, so DNS will not tell you
# which is right; the wrong one fails as "Tenant or user not found", which reads
# exactly like a bad password. aws-0 is what has actually authenticated.
$POOLER_HOST = 'aws-0-us-west-2.pooler.supabase.com'
$POOLER_ALT  = 'aws-1-us-west-2.pooler.supabase.com'
$POOLER_PORT = '5432'                      # session mode
$CONTAINER   = 'supabase_db_tapswipe-crm'  # psql client only

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir   = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir ("audit-percent-{0}-{1}.log" -f $ProjectRef, (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Redact {
  param([string]$Message)
  $out = $Message
  if (-not [string]::IsNullOrEmpty($env:SUPABASE_DB_PASSWORD)) {
    $raw = [string]$env:SUPABASE_DB_PASSWORD
    $out = $out.Replace($raw, '<redacted>')
    $out = $out.Replace([uri]::EscapeDataString($raw), '<redacted>')
  }
  return $out
}

function Say {
  param([string]$Message)
  $clean = Redact $Message
  Write-Host $clean
  Add-Content -Path $logFile -Value $clean -Encoding utf8
}

if ([string]::IsNullOrEmpty($env:SUPABASE_DB_PASSWORD)) {
  Say 'ABORT: $env:SUPABASE_DB_PASSWORD is empty in this process.'
  Say '  $sec = Read-Host ''db password'' -AsSecureString'
  Say '  $env:SUPABASE_DB_PASSWORD = (New-Object PSCredential 0, $sec).GetNetworkCredential().Password'
  exit 1
}

$enc = [uri]::EscapeDataString([string]$env:SUPABASE_DB_PASSWORD)
$url = "postgresql://postgres.${ProjectRef}:${enc}@${POOLER_HOST}:${POOLER_PORT}/postgres"

Say "audit-percent-corruption -- READ ONLY"
Say "project ref : $ProjectRef"
Say "pooler      : ${POOLER_HOST}:${POOLER_PORT} (session mode)"
Say "log         : $logFile"
Say ''

$auditSql = Get-Content -Raw (Join-Path $PSScriptRoot 'audit-percent-corruption.sql')

# -w so psql never prompts: a prompt here would hang on a wrong password
# rather than failing. Piped in rather than copied into the container.
$result = ($auditSql | docker exec -i $CONTAINER psql -w -d "$url" -f - 2>&1 | Out-String)
$result = Redact $result

if ($result -match 'Tenant or user not found') {
  Say 'FAILED: "Tenant or user not found".'
  Say "That usually means the pooler host is wrong, not the password."
  Say "Try $POOLER_ALT before rotating any credential."
  Say $result
  exit 1
}

Say $result

if ($result -match 'could not connect|FATAL|error:') {
  Say 'FAILED: see above.'
  exit 1
}

Say ''
Say 'Read complete. Interpretation:'
Say '  over_100     > 0  => DEFINITE corruption. Stop and report.'
Say '  has_decimals > 0  => that column holds genuine decimals the bug could not'
Say '                       have produced; reps DO type decimals there.'
Say '  whole_1_100       => exposure only, not a finding. A value in this band'
Say '                       is indistinguishable from someone typing it.'
