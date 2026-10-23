# Connection plumbing shared by the scripts that talk to a hosted database
# (diag-prod-trigger.ps1, push-prod-migration.ps1, audit-percent-corruption.ps1).
# Dot-source it; it defines functions and runs nothing.
#
# THE PASSWORD NEVER GOES ON A COMMAND LINE. These scripts used to percent-encode
# $env:SUPABASE_DB_PASSWORD into the connection URL and pass that URL as an
# argument to `docker exec ... psql -d <url>` and to `supabase db push --db-url
# <url>`. A process's command line is readable by every other process of the
# same user (Get-CimInstance Win32_Process shows it in full), and inside the
# container by anything that can run `ps`. Measured 23 Oct 2026 with a canary:
# the encoded value sat in docker.exe's CommandLine for as long as psql ran.
#
# So the URL carries no password at all, and the value travels in PGPASSWORD:
#
#   - psql: `docker exec -e PGPASSWORD ...` -- the NAME only. Docker copies the
#     value from the docker client's own environment. `-e PGPASSWORD=<value>`
#     would put it straight back on docker.exe's command line.
#   - the Supabase CLI: with --db-url it honours PGPASSWORD and IGNORES
#     SUPABASE_DB_PASSWORD (measured on CLI 2.111.0 against the local stack: a
#     wrong SUPABASE_DB_PASSWORD still connected, a wrong PGPASSWORD failed with
#     28P01). With neither set it silently tries a default password, so an unset
#     variable fails at authentication rather than at the variable.
#
# PGPASSWORD is set only for the duration of each call that needs it, and put
# back the way it was found afterwards, so nothing else the script launches
# (docker ps, Test-Path, ...) inherits it.

<#
.SYNOPSIS
  The session-mode pooler URL for a project, with NO password in it.
#>
function Get-PoolerUrl {
  param([string]$ProjectRef, [string]$PoolerHost, [string]$Port)
  return "postgresql://postgres.${ProjectRef}@${PoolerHost}:${Port}/postgres"
}

<#
.SYNOPSIS
  Throws if a connection URL carries a password (user:password@).
.DESCRIPTION
  A last check before anything is launched, so a future edit that builds the URL
  by hand cannot quietly put the credential back on a command line. The message
  names the problem, never the URL.
#>
function Assert-NoPasswordInUrl {
  param([string]$Url)
  if ($Url -match '^[a-z]+://[^@/]*:[^@/]*@') {
    throw 'ABORT: the connection URL carries a password. It must travel in PGPASSWORD, never on a command line.'
  }
}

<#
.SYNOPSIS
  Arguments for `docker exec` running psql against $Url, password via PGPASSWORD.
#>
function Get-PsqlDockerArgs {
  param([string]$Container, [string]$Url, [string[]]$PsqlArgs, [switch]$Stdin)
  Assert-NoPasswordInUrl -Url $Url
  $a = @('exec')
  if ($Stdin) { $a += '-i' }
  # -e with the NAME only: docker reads the value from its own environment.
  $a += @('-e', 'PGPASSWORD', $Container, 'psql', '-w', '-d', $Url)
  return $a + $PsqlArgs
}

<#
.SYNOPSIS
  Arguments for `supabase db push` against $Url, password via PGPASSWORD.
#>
function Get-DbPushArgs {
  param([string]$Url, [switch]$DryRun)
  Assert-NoPasswordInUrl -Url $Url
  $a = @('db', 'push', '--db-url', $Url, '--yes')
  if ($DryRun) { $a += '--dry-run' }
  return $a
}

<#
.SYNOPSIS
  Runs $Script with PGPASSWORD set from $env:SUPABASE_DB_PASSWORD, then restores
  PGPASSWORD to exactly what it was (removed, if it was not set).
.DESCRIPTION
  The script block's output is returned unchanged, so a streaming pipeline inside
  it still streams. $LASTEXITCODE is left as the block's last native command set it.
#>
function Invoke-WithDbPassword {
  param([scriptblock]$Script)
  $had  = Test-Path Env:PGPASSWORD
  $prev = $env:PGPASSWORD
  $env:PGPASSWORD = $env:SUPABASE_DB_PASSWORD
  try {
    & $Script
  } finally {
    if ($had) { $env:PGPASSWORD = $prev } else { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
  }
}
