# Build an embedded Windows Python environment for the Electron app.
#
# Downloads a standalone CPython build for Windows from python-build-standalone,
# installs backend deps, and leaves it under electron\python-env\.
# Bundled into the .exe installer by electron-builder via extraResources.

$ErrorActionPreference = 'Stop'

$ScriptDir   = Split-Path -Parent $PSCommandPath
$ProjectRoot = Split-Path -Parent $ScriptDir
$ElectronDir = Join-Path $ProjectRoot 'electron'
$PythonEnvDir = Join-Path $ElectronDir 'python-env'

$PythonVersion     = '3.13'
$PythonFullVersion = '3.13.2'
$ReleaseTag        = '20250212'
$PlatformTag       = 'x86_64-pc-windows-msvc-shared'
$Tarball           = "cpython-$PythonFullVersion+$ReleaseTag-$PlatformTag-install_only_stripped.tar.gz"
$DownloadUrl       = "https://github.com/indygreg/python-build-standalone/releases/download/$ReleaseTag/$Tarball"

Write-Host "=== Building Windows Python Environment ==="
Write-Host "Architecture: x64 ($PlatformTag)"
Write-Host "Python: $PythonFullVersion"

if (Test-Path $PythonEnvDir) {
    Write-Host "Removing old python-env..."
    Remove-Item -Recurse -Force $PythonEnvDir
}

$TempDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "openswarm-pyenv-$([guid]::NewGuid())") -Force
try {
    $ArchivePath = Join-Path $TempDir.FullName 'python.tar.gz'
    Write-Host "Downloading standalone Python..."
    Write-Host "URL: $DownloadUrl"
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ArchivePath -UseBasicParsing

    Write-Host "Extracting..."
    # tar is built-in on Windows 10+ (bsdtar) and handles .tar.gz natively.
    & tar -xzf $ArchivePath -C $TempDir.FullName
    if ($LASTEXITCODE -ne 0) { throw "tar extract failed" }

    $Extracted = Join-Path $TempDir.FullName 'python'
    if (-not (Test-Path $Extracted)) {
        Get-ChildItem $TempDir.FullName | Format-Table | Out-String | Write-Host
        throw "Expected extracted directory at $Extracted"
    }

    Move-Item -Path $Extracted -Destination $PythonEnvDir
    Write-Host "Python installed to $PythonEnvDir"
} finally {
    if (Test-Path $TempDir.FullName) {
        Remove-Item -Recurse -Force $TempDir.FullName
    }
}

$PythonBin = Join-Path $PythonEnvDir 'python.exe'
if (-not (Test-Path $PythonBin)) { throw "python.exe not found at $PythonBin" }

Write-Host "Python binary: $PythonBin"
& $PythonBin --version

# Ensure pip is present
& $PythonBin -m pip --version 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing pip..."
    & $PythonBin -m ensurepip --upgrade
    if ($LASTEXITCODE -ne 0) { throw "ensurepip failed" }
}

# Install from the fully-pinned, hash-locked file so the shipped python-env is
# byte-for-byte reproducible (pillar 3). requirements.txt is the human-edited
# source; regenerate the lock after editing it with:
#   uv pip compile backend/requirements.txt --python-version 3.13 `
#       --generate-hashes --output-file backend/requirements.lock
# --require-hashes is implied because every entry carries a hash.
Write-Host "Installing backend dependencies (from requirements.lock)..."
& $PythonBin -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed" }
& $PythonBin -m pip install -r (Join-Path $ProjectRoot 'backend\requirements.lock')
if ($LASTEXITCODE -ne 0) { throw "pip install requirements failed" }

Write-Host "Installing debugger module..."
& $PythonBin -m pip install (Join-Path $ProjectRoot 'debugger')
if ($LASTEXITCODE -ne 0) { throw "pip install debugger failed" }

Write-Host "Verifying claude-agent-sdk..."
& $PythonBin -c "import claude_agent_sdk; print('claude-agent-sdk installed')"
if ($LASTEXITCODE -ne 0) { throw "claude-agent-sdk verification failed" }

# Cleanup. Drop test packages and any stale __pycache__/.pyc from the
# upstream tarball — we want our own freshly-compiled bytecode (next
# step), not whatever the upstream build happened to ship.
Write-Host "Cleaning up..."
Get-ChildItem -Path $PythonEnvDir -Recurse -Force -Directory `
    | Where-Object { $_.Name -in @('__pycache__','tests','test') } `
    | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $PythonEnvDir -Recurse -Force -Filter '*.pyc' `
    | Remove-Item -Force -ErrorAction SilentlyContinue

# Strip parts of the Python distribution we provably don't use at runtime.
# Each removal here has been individually verified.
Write-Host "Stripping unused Python distribution files..."
$ToStrip = @(
    (Join-Path $PythonEnvDir 'include'),                          # C headers — never used at runtime
    (Join-Path $PythonEnvDir 'lib\python3.13\idlelib'),           # IDLE editor — headless backend has no GUI
    (Join-Path $PythonEnvDir 'lib\python3.13\tkinter'),           # Tk GUI toolkit — same
    (Join-Path $PythonEnvDir 'lib\python3.13\ensurepip'),         # Pip bootstrap — backend never installs at runtime
    (Join-Path $PythonEnvDir 'lib\python3.13\turtledemo'),        # Educational drawing examples
    (Join-Path $PythonEnvDir 'lib\python3.13\turtle.py'),         # Tk-based turtle graphics; imports stripped tkinter, backend never uses it
    (Join-Path $PythonEnvDir 'lib\python3.13\pydoc_data'),        # pydoc topics/keywords; only `help()` reads them
    (Join-Path $PythonEnvDir 'lib\python3.13\_pyrepl'),           # Python 3.13 interactive REPL, never started in packaged app
    (Join-Path $PythonEnvDir 'share')                             # Man pages / desktop integration
)
foreach ($p in $ToStrip) {
    if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}
$Sp = Join-Path $PythonEnvDir 'lib\python3.13\site-packages'
# pip itself: nothing in the packaged backend invokes it. uvx (used by
# MCPs) is a self-contained installer; the App Builder picks SYSTEM
# python via shutil.which (view_builder_templates.py:382), never this
# bundled one; backend code only mentions "pip install" in error strings.
Remove-Item -Recurse -Force (Join-Path $Sp 'pip') -ErrorAction SilentlyContinue
Get-ChildItem -Path $Sp -Directory -Filter 'pip-*.dist-info' -ErrorAction SilentlyContinue `
    | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
# Launcher .exe shims for the now-removed tools. Windows installs them under
# Scripts\; ignore missing.
foreach ($exe in @('pip.exe','pip3.exe','pip3.13.exe','idle3.exe','idle3.13.exe','pydoc3.exe','pydoc3.13.exe')) {
    $p = Join-Path $PythonEnvDir "Scripts\$exe"
    if (Test-Path $p) { Remove-Item -Force $p -ErrorAction SilentlyContinue }
}

# ----- Babel locale-data trim (~30 MB / ~900 files) -----
# Babel ships 1,084 CLDR locale .dat files. Trafilatura's transitive dep
# courlan/filters.py:184 calls Locale.parse(seg) on URL path segments. UnknownLocaleError IS caught at line 188, so stripped locales just skip language-filtering for that URL.
$Sp = Join-Path $PythonEnvDir 'lib\python3.13\site-packages'
$LocaleDir = Join-Path $Sp 'babel\locale-data'
if (Test-Path $LocaleDir) {
    Write-Host "Trimming babel/locale-data..."
    $KeepLangs = @('ar','de','es','fr','it','ja','ko','nl','pl','pt','ru','sv','tr','zh','hi','th','vi','id','da','no','fi','cs','el','he','uk')
    Get-ChildItem -Path $LocaleDir -File -ErrorAction SilentlyContinue | ForEach-Object {
        $name = $_.Name
        $keep = $false
        if ($name -eq 'root.dat' -or $name -eq 'LICENSE.unicode') { $keep = $true }
        elseif ($name -match '^en($|_)') { $keep = $true }
        else {
            foreach ($l in $KeepLangs) {
                if ($name -eq "$l.dat") { $keep = $true; break }
            }
        }
        if (-not $keep) { Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue }
    }
}

# ----- dist-info noise trim (~2 MB / ~280 files) -----
# pip-only metadata. METADATA is kept (some packages call importlib.metadata).
Write-Host "Trimming pip dist-info noise..."
foreach ($pattern in @('RECORD','INSTALLER','WHEEL','top_level.txt','entry_points.txt')) {
    Get-ChildItem -Path $Sp -Recurse -Filter $pattern -File -ErrorAction SilentlyContinue `
        | Where-Object { $_.FullName -match '\.dist-info[\\/]' } `
        | Remove-Item -Force -ErrorAction SilentlyContinue
}

# ----- type stubs (.pyi) — read only by type-checkers, never at runtime -----
Write-Host "Trimming .pyi type stubs..."
Get-ChildItem -Path $PythonEnvDir -Recurse -Filter '*.pyi' -File -ErrorAction SilentlyContinue `
    | Remove-Item -Force -ErrorAction SilentlyContinue

# Pre-compile bytecode so cold backend startup skips parse+compile per import.
# invalidation-mode unchecked-hash is load-bearing: the default timestamp mode
# ties each .pyc to its source mtime, but the installer rewrites mtimes on extract,
# so every .pyc looks stale and Python recompiles the whole stdlib+deps from source
# on EVERY launch (and runtime PYTHONDONTWRITEBYTECODE means it never caches the
# result), which is the multi-minute Windows cold-start. unchecked-hash makes the
# .pyc valid regardless of mtime, which is the correct mode for a frozen bundle.
# Concurrency capped at 4; missing .pyc is non-fatal (runtime in-memory fallback).
Write-Host "Pre-compiling bytecode..."
& $PythonBin -m compileall -q -j 4 --invalidation-mode unchecked-hash (Join-Path $PythonEnvDir 'lib')
if ($LASTEXITCODE -ne 0) {
    Write-Host "WARNING: some files failed to compile; runtime will fall back to in-memory compile." -ForegroundColor Yellow
}

$Size = (Get-ChildItem -Path $PythonEnvDir -Recurse -File `
    | Measure-Object -Property Length -Sum).Sum
$SizeMB = [math]::Round($Size / 1MB, 1)
$PycCount = (Get-ChildItem -Path $PythonEnvDir -Recurse -File -Filter '*.pyc' | Measure-Object).Count

Write-Host ""
Write-Host "=== Python Environment Ready ==="
Write-Host "Location: $PythonEnvDir"
Write-Host ("Size: {0} MB ({1} .pyc files)" -f $SizeMB, $PycCount)
Write-Host ""
