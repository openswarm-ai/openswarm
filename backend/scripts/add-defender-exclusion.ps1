<#
.SYNOPSIS
  #9 item 5 (DRAFT, opt-in, NEVER silent): add a Windows Defender exclusion for
  OpenSwarm's install + data dirs. This is the nuclear cold-start fix -- it stops
  Defender real-time-scanning those folders entirely, which is the root of the
  54-138s post-update cold launch AND the ~14s first-app extract.

.SECURITY
  Excluding a folder from Defender reduces AV coverage of it. This must ALWAYS be
  an explicit, informed user choice -- never auto-run, never a startup prompt. The
  install is Azure code-signed, so the risk is bounded, but the user owns the
  call. Fully reversible with -Remove. Requires admin (Add/Remove-MpPreference do).

.USAGE
  pwsh scripts\add-defender-exclusion.ps1            # show plan + paths, change nothing
  pwsh scripts\add-defender-exclusion.ps1 -Status    # list current openswarm exclusions
  pwsh scripts\add-defender-exclusion.ps1 -Apply     # add (run elevated)
  pwsh scripts\add-defender-exclusion.ps1 -Remove    # undo (run elevated)
#>
param(
    [switch]$Apply,
    [switch]$Remove,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'

# The three trees Defender rescans on launch / first-app: the Squirrel install
# (executables + python-env + node_modules), the Electron user data, and the
# warm caches.
$paths = @(
    (Join-Path $env:LOCALAPPDATA 'openswarm'),
    (Join-Path $env:APPDATA 'openswarm'),
    (Join-Path $env:USERPROFILE '.openswarm')
) | Where-Object { $_ }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

if ($Status) {
    try {
        $ex = (Get-MpPreference).ExclusionPath | Where-Object { $_ -match 'openswarm' }
        if ($ex) { $ex | ForEach-Object { Write-Host "  excluded: $_" } } else { Write-Host "  (no openswarm Defender exclusions set)" }
    } catch {
        Write-Warning "Defender not queryable here (non-Defender AV, or needs elevation): $_"
    }
    return
}

Write-Host "OpenSwarm Defender exclusion (OPT-IN). Would apply to:"
$paths | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "SECURITY: this stops Windows Defender from real-time-scanning those folders."
Write-Host "Only do this if you trust this install (it is code-signed). Reversible with -Remove."

if (-not ($Apply -or $Remove)) {
    Write-Host ""
    Write-Host "DRY RUN -- nothing changed. Re-run ELEVATED with -Apply (add), -Remove (undo), or -Status (list)."
    return
}

if (-not (Test-Admin)) {
    throw "Needs admin. Re-run from an elevated PowerShell (Add/Remove-MpPreference require elevation)."
}

foreach ($p in $paths) {
    if ($Apply) { Add-MpPreference -ExclusionPath $p; Write-Host "added exclusion: $p" }
    else { Remove-MpPreference -ExclusionPath $p; Write-Host "removed exclusion: $p" }
}
Write-Host "Done. Verify with -Status."
