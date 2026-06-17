<#
.SYNOPSIS
  #9 item 1 (DRAFT, build-gated): collapse the bundled Python stdlib into a single
  python313.zip so Windows Defender scans one file instead of hundreds of loose
  .py/.pyc on every cold launch after an update (the 54-138s cold-start spikes).

.WHY IT WORKS
  CPython always puts "<prefix>\python313.zip" on sys.path automatically (the zip
  import path), so placing the stdlib there needs NO python._pth. We keep
  Lib\site-packages and DLLs\ loose (native .pyd can't be imported from a zip),
  and keep a small keep-list of stdlib dirs that read data files via __file__.

.STATUS
  UNVALIDATED. Default is -DryRun (reports only, changes nothing). Run -Apply on a
  throwaway python-env copy, then boot the packaged backend and confirm every
  import works + measure cold start (Task #10) BEFORE wiring this into a release.
  It is intentionally NOT called by build-app-win.ps1 yet.

.USAGE
  pwsh scripts\zip-python-stdlib.ps1 -PythonEnv electron\python-env            # dry run
  pwsh scripts\zip-python-stdlib.ps1 -PythonEnv <copy>\python-env -Apply       # perform
#>
param(
    [Parameter(Mandatory = $true)][string]$PythonEnv,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$Lib = Join-Path $PythonEnv 'Lib'
$SitePkgs = Join-Path $Lib 'site-packages'
$ZipPath = Join-Path $PythonEnv 'python313.zip'

if (-not (Test-Path $Lib)) { throw "no Lib\ under $PythonEnv" }

# Stdlib dirs known to read data/grammar files relative to __file__ -> keep loose
# (zipimport gives them no real path). Conservative; expand if validation flags more.
$KeepLoose = @('site-packages', 'lib2to3', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'venv', 'test', '__pycache__')

# Pure-stdlib set = everything directly under Lib\ EXCEPT the keep-list. Native
# stdlib extensions live in DLLs\ (not Lib\) on Windows, so Lib-minus-keeplist is
# pure python and safe to zip.
$entries = Get-ChildItem -Force $Lib | Where-Object { $KeepLoose -notcontains $_.Name }
$pyFiles = $entries | ForEach-Object {
    if ($_.PSIsContainer) { Get-ChildItem -Recurse -File $_.FullName -Include *.py, *.pyc -ErrorAction SilentlyContinue }
    elseif ($_.Extension -in '.py', '.pyc') { $_ }
}
$count = ($pyFiles | Measure-Object).Count
$bytes = ($pyFiles | Measure-Object -Property Length -Sum).Sum
Write-Host ("#9 item 1: {0} stdlib .py/.pyc files ({1:N1} MB) would be zipped into python313.zip" -f $count, ($bytes / 1MB))
Write-Host ("keep-loose dirs: {0}" -f ($KeepLoose -join ', '))

if (-not $Apply) {
    Write-Host "DRY RUN. Re-run with -Apply on a COPY of python-env, then validate (Task #10):"
    Write-Host "  1. python.exe -c 'import backend.main' (full import tree resolves)"
    Write-Host "  2. python.exe -X importtime -c 'import backend.main' parity vs loose"
    Write-Host "  3. boot the packaged backend, exercise agents/app-builder/skills"
    Write-Host "  4. measure cold backend-http-ready vs baseline_startup.csv"
    return
}

# --- Apply: build the zip, then remove the now-redundant loose copies. ---
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($ZipPath, 'Create')
try {
    foreach ($f in $pyFiles) {
        # Archive entry path must be relative to Lib\ so it resolves as a top-level
        # module (e.g. Lib\json\__init__.py -> json/__init__.py in the zip root).
        $rel = $f.FullName.Substring($Lib.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel) | Out-Null
    }
} finally {
    $zip.Dispose()
}
Write-Host ("Wrote {0} ({1:N1} MB)" -f $ZipPath, ((Get-Item $ZipPath).Length / 1MB))

# Remove the loose stdlib we just zipped (keep the keep-list dirs untouched).
foreach ($e in $entries) {
    if ($e.PSIsContainer) { Remove-Item -Recurse -Force $e.FullName }
    elseif ($e.Extension -in '.py', '.pyc') { Remove-Item -Force $e.FullName }
}
Write-Host "Removed loose stdlib copies. VALIDATE on the packaged EXE before shipping (this is unvalidated)."
