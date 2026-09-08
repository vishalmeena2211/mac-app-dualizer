#Requires -Version 5.1
<#
.SYNOPSIS
  Clone a Windows app so you can run a second, fully independent instance —
  its own data directory, its own login.

.DESCRIPTION
  The Windows counterpart to clone-app.sh. Best support is for Electron apps
  (Slack, Claude, Notion, VS Code, Discord, ...).

  Two modes:
    clone  Copy the app, give it its own name and icon, and inject an isolated
           data directory into app.asar. An app auto-update overwrites the copy,
           so re-run `dualize repair` afterwards.
    link   Create only a shortcut that launches the original app with a separate
           --user-data-dir. Nothing is copied and nothing can be reverted by an
           update, but both instances share one taskbar icon.

  The real work lives in Node (src/win/clone.js); this script is a thin wrapper
  so the command line matches the macOS script.

.PARAMETER Source
  Path to the app's .exe, or the folder containing it. Required.

.PARAMETER Name
  Display name for the clone, e.g. "Slack Work". Required.

.PARAMETER DestDir
  Where to write the clone. Default: %LOCALAPPDATA%\Programs

.PARAMETER Mode
  'clone' (default) or 'link'.

.PARAMETER NoIsolate
  Do not inject a separate data directory into app.asar.

.PARAMETER Desktop
  Also create a Desktop shortcut.

.PARAMETER Tint
  Icon badge color as "#RRGGBB". Default: picked from the clone name.

.PARAMETER NoTint
  Do not badge the clone's icon.

.EXAMPLE
  .\clone-app.ps1 -Source "$env:LOCALAPPDATA\Programs\Slack\slack.exe" -Name "Slack Work"

.EXAMPLE
  .\clone-app.ps1 --source "C:\Program Files\Claude\Claude.exe" --name "Claude 2" --desktop

.NOTES
  Requires Node.js 18+. Run `npm install` in the repo first.
#>
# PowerShell matches parameter names case-insensitively, so `-source` already
# binds to $Source — declaring it as an alias too is an error. Only genuinely
# different spellings are aliased here; the GNU-style `--flag` forms are folded
# in from $Rest below.
#
# PositionalBinding is off on purpose. PowerShell does not recognise `--source`
# as a parameter name, so with positional binding on it would bind the *values*
# by position instead — quietly landing "Slack Work" in -Mode. With it off,
# every unrecognised token falls through to $Rest in order and is parsed there.
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Source,
  [string]$Name,
  [Alias('dest-dir')][string]$DestDir,
  # Deliberately no [ValidateSet]: the attribute binds to the *variable*, so a
  # later `$Mode = ...` from the --mode parser would throw a raw PowerShell
  # validation exception. Mode is checked explicitly below instead, which covers
  # the -Mode and --mode spellings alike.
  [string]$Mode = 'clone',
  [Alias('no-isolate')][switch]$NoIsolate,
  [switch]$Desktop,
  [string]$Tint,
  [Alias('no-tint')][switch]$NoTint,
  # Anything not matched above, so GNU-style `--source X` also works.
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Write-Error would be a *terminating* error under the Stop preference above,
# so a validation failure would surface as a PowerShell exception stack instead
# of a clean message and a 1 exit code. Report and exit explicitly.
function Fail([string]$Message) {
  [Console]::Error.WriteLine($Message)
  exit 1
}

# Fold any GNU-style flags from $Rest back into the typed parameters above, so
# the command line reads the same as the macOS script's.
if ($null -eq $Rest) { $Rest = @() }
$i = 0
while ($i -lt $Rest.Count) {
  $token = $Rest[$i]
  $needsValue = $token -in @('--source', '--name', '--dest-dir', '--mode', '--tint')
  if ($needsValue -and $i + 1 -ge $Rest.Count) {
    Fail "error: $token expects a value"
  }
  $value = if ($needsValue) { $Rest[$i + 1] } else { $null }

  switch ($token) {
    '--source'     { $Source = $value }
    '--name'       { $Name = $value }
    '--dest-dir'   { $DestDir = $value }
    '--mode'       { $Mode = $value }
    '--tint'       { $Tint = $value }
    '--no-isolate' { $NoIsolate = $true }
    '--desktop'    { $Desktop = $true }
    '--no-tint'    { $NoTint = $true }
    { $_ -in @('-h', '--help') } {
      Get-Help $MyInvocation.MyCommand.Path -Detailed
      exit 0
    }
    default { Fail "Unknown argument: $token" }
  }
  if ($needsValue) { $i += 2 } else { $i += 1 }
}

if (-not $Source -or -not $Name) {
  Fail 'error: -Source and -Name are required. Run with -? for help.'
}

# ValidateSet only runs when PowerShell binds the parameter, so a --mode value
# folded in from $Rest has to be checked here.
if ($Mode -notin @('clone', 'link')) {
  Fail "error: --mode must be 'clone' or 'link' (got '$Mode')"
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail 'error: Node.js 18+ is required but was not found on PATH. See https://nodejs.org'
}

$dualize = Join-Path $root 'bin\dualize.js'
if (-not (Test-Path $dualize)) {
  Fail "error: bin\dualize.js is missing at $dualize"
}

$argList = @('clone', '--source', $Source, '--name', $Name, '--mode', $Mode)
if ($DestDir)   { $argList += @('--dest-dir', $DestDir) }
if ($Tint)      { $argList += @('--tint', $Tint) }
if ($NoTint)    { $argList += '--no-tint' }
if ($NoIsolate) { $argList += '--no-isolate' }
if ($Desktop)   { $argList += '--desktop' }

& node $dualize @argList
exit $LASTEXITCODE
