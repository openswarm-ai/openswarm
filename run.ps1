# Windows dev launcher - mirror of bash run.sh.
# Spins up backend (uvicorn --reload) + frontend (webpack dev server) + electron
# in one terminal. Hot-reload for Python and React. Ctrl+C to stop all three.
#
# Prereqs: Python 3.12+, Node 20+, npm. Everything else is installed on demand.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File run.ps1
#   (or)  pwsh run.ps1   if PowerShell 7 is installed.

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $PSCommandPath

# --- Locate Python ---
$python = $null
foreach ($name in @('python', 'python3', 'py')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $python = $cmd.Source; break }
}
if (-not $python) {
    throw "Python 3.12+ not found on PATH. Install from https://www.python.org/downloads/"
}

# --- Bundled uv/uvx (matches what build-app-win.ps1 does so MCP discovery works in dev) ---
$UvBinDir = Join-Path $ScriptDir 'backend\uv-bin'
if (-not (Test-Path (Join-Path $UvBinDir 'uvx.exe'))) {
    Write-Host "[setup] Downloading uv/uvx for Windows..."
    New-Item -ItemType Directory -Force -Path $UvBinDir | Out-Null
    $UvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'
    $TmpZip = Join-Path $env:TEMP "uv-win-$([guid]::NewGuid()).zip"
    $TmpExtract = Join-Path $env:TEMP "uv-win-extract-$([guid]::NewGuid())"
    try {
        Invoke-WebRequest -Uri $UvUrl -OutFile $TmpZip -UseBasicParsing
        Expand-Archive -Path $TmpZip -DestinationPath $TmpExtract -Force
        Get-ChildItem $TmpExtract -Recurse -Filter 'uv.exe'  | Select-Object -First 1 | ForEach-Object { Copy-Item $_.FullName (Join-Path $UvBinDir 'uv.exe') -Force }
        Get-ChildItem $TmpExtract -Recurse -Filter 'uvx.exe' | Select-Object -First 1 | ForEach-Object { Copy-Item $_.FullName (Join-Path $UvBinDir 'uvx.exe') -Force }
    } finally {
        Remove-Item -Force $TmpZip -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $TmpExtract -ErrorAction SilentlyContinue
    }
}

# --- Backend venv + deps ---
$Venv = Join-Path $ScriptDir 'backend\.venv'
$VenvPy = Join-Path $Venv 'Scripts\python.exe'
if (-not (Test-Path $VenvPy)) {
    Write-Host "[setup] Creating Python venv at $Venv ..."
    & $python -m venv $Venv
    if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
}
Write-Host "[setup] Installing backend deps (idempotent, fast if already up to date)..."
# Suppress PowerShell 5.1's native-stderr-as-error wrapping for these idempotent
# pip calls (deprecation warnings on stderr would otherwise terminate the script
# under $ErrorActionPreference=Stop). We still check $LASTEXITCODE for real failures.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & $VenvPy -m pip install --quiet --upgrade pip *>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed" }
    & $VenvPy -m pip install --quiet -r (Join-Path $ScriptDir 'backend\requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw "pip install backend reqs failed" }
} finally {
    $ErrorActionPreference = $prevEAP
}

# --- Frontend deps ---
$FrontendDir = Join-Path $ScriptDir 'frontend'
if (-not (Test-Path (Join-Path $FrontendDir 'node_modules'))) {
    Write-Host "[setup] Installing frontend deps..."
    Push-Location $FrontendDir
    try { & npm install } finally { Pop-Location }
}

# --- Electron deps ---
$ElectronDir = Join-Path $ScriptDir 'electron'
if (-not (Test-Path (Join-Path $ElectronDir 'node_modules'))) {
    Write-Host "[setup] Installing electron deps..."
    Push-Location $ElectronDir
    try { & npm install } finally { Pop-Location }
}

# --- Process tracking + cleanup ---
$script:childPids = New-Object System.Collections.ArrayList

function Stop-Tree($processId, $label) {
    if (-not $processId) { return }
    try {
        & taskkill /PID $processId /T /F 2>$null | Out-Null
        Write-Host "  killed $label (pid $processId)" -ForegroundColor DarkGray
    } catch {}
}

function Cleanup-All {
    Write-Host ""
    Write-Host "Shutting down all services..." -ForegroundColor Yellow
    foreach ($entry in $script:childPids) {
        Stop-Tree $entry.Pid $entry.Label
    }
    Write-Host "All services stopped." -ForegroundColor Green
}

# Opt-in dev telemetry: OPENSWARM_ANALYTICS=1 reports to the prod edge tagged with a -dev channel so it stays filterable from real installs; off by default so a stray run never phones home.
if ($env:OPENSWARM_ANALYTICS -eq '1') {
    if (-not $env:OPENSWARM_ANALYTICS_URL) { $env:OPENSWARM_ANALYTICS_URL = 'https://analytics.openswarm.com' }
    if (-not $env:OPENSWARM_APP_CHANNEL)   { $env:OPENSWARM_APP_CHANNEL = 'dev' }
}

try {
    # --- Start backend (NoNewWindow so logs interleave into this terminal) ---
    # No --reload on Windows: uvicorn's reload mode forces use_subprocess=True
    # which pins the worker to WindowsSelectorEventLoop. That loop raises
    # NotImplementedError on asyncio.create_subprocess_exec — and the Claude
    # Agent SDK uses exactly that to spawn the `claude` CLI, so sending a
    # chat message crashes with "Failed to start Claude Code" under --reload.
    # Mac doesn't hit it (no Proactor/Selector split). Packaged Windows doesn't
    # hit it either (electron/main.js launches uvicorn without --reload).
    # Tradeoff: no backend hot-reload in dev on Windows — Ctrl+C and re-run
    # `.\run.ps1` after backend code changes. Frontend hot-reload is
    # unaffected (webpack-dev-server handles its own watching).
    Write-Host ""
    Write-Host "[backend]  Starting uvicorn on http://localhost:8324 ..." -ForegroundColor Blue
    $backend = Start-Process -PassThru -NoNewWindow `
        -FilePath $VenvPy `
        -WorkingDirectory $ScriptDir `
        -ArgumentList @(
            '-m', 'uvicorn', 'backend.main:app',
            '--host', '127.0.0.1', '--port', '8324'
        )
    [void]$script:childPids.Add(@{ Pid = $backend.Id; Label = 'backend' })

    Write-Host "Waiting for backend (max 90s)..." -ForegroundColor Yellow
    $deadline = (Get-Date).AddSeconds(90)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if ($backend.HasExited) { throw "Backend exited prematurely (code $($backend.ExitCode))" }
        try {
            # Hit 127.0.0.1 (not `localhost`) so we don't waste time on the
            # IPv6 ::1 fallback — uvicorn is IPv4-only. TimeoutSec 5 because
            # PS 5.1's first Invoke-WebRequest call pays ~1-2s of .NET
            # network-stack warm-up, and Windows Defender adds scan latency
            # on the first localhost connect from a new process.
            Invoke-WebRequest -Uri 'http://127.0.0.1:8324/api/health/check' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null
            $ready = $true
            break
        } catch {}
        Start-Sleep -Milliseconds 1500
    }
    if (-not $ready) { throw "Backend did not become ready within 90s" }
    Write-Host "Backend ready." -ForegroundColor Green

    # --- Start frontend ---
    Write-Host ""
    Write-Host "[frontend] Starting webpack dev server on http://localhost:3000 ..." -ForegroundColor Green
    $frontend = Start-Process -PassThru -NoNewWindow `
        -FilePath 'npm.cmd' `
        -WorkingDirectory $FrontendDir `
        -ArgumentList @('run', 'dev')
    [void]$script:childPids.Add(@{ Pid = $frontend.Id; Label = 'frontend' })

    Write-Host "Waiting for frontend (max 90s)..." -ForegroundColor Yellow
    $deadline = (Get-Date).AddSeconds(90)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if ($frontend.HasExited) { throw "Frontend exited prematurely (code $($frontend.ExitCode))" }
        try {
            # See backend probe above — same 127.0.0.1 + 5s timeout reasoning.
            Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null
            $ready = $true
            break
        } catch {}
        Start-Sleep -Milliseconds 1500
    }
    if (-not $ready) { throw "Frontend did not become ready within 90s" }
    Write-Host "Frontend ready." -ForegroundColor Green

    # --- Start electron in dev mode (npm run dev = cross-env ELECTRON_DEV=1 electron .) ---
    Write-Host ""
    Write-Host "[electron] Launching dev shell..." -ForegroundColor Magenta
    $electron = Start-Process -PassThru -NoNewWindow `
        -FilePath 'npm.cmd' `
        -WorkingDirectory $ElectronDir `
        -ArgumentList @('run', 'dev')
    [void]$script:childPids.Add(@{ Pid = $electron.Id; Label = 'electron' })

    Write-Host ""
    Write-Host "All services running. Press Ctrl+C to stop." -ForegroundColor Cyan
    Write-Host "  Backend:  http://localhost:8324" -ForegroundColor Blue
    Write-Host "  Frontend: http://localhost:3000" -ForegroundColor Green
    Write-Host "  Electron: dev shell (pid $($electron.Id))" -ForegroundColor Magenta
    Write-Host ""

    # --- Supervise: if any dies, tear down all ---
    while ($true) {
        Start-Sleep -Seconds 3
        if ($backend.HasExited) {
            Write-Host "[backend] exited unexpectedly (code $($backend.ExitCode)). Tearing down..." -ForegroundColor Red
            break
        }
        if ($frontend.HasExited) {
            Write-Host "[frontend] exited unexpectedly (code $($frontend.ExitCode)). Tearing down..." -ForegroundColor Red
            break
        }
        if ($electron.HasExited) {
            Write-Host "[electron] exited (normal close). Tearing down..." -ForegroundColor Yellow
            break
        }
    }
} finally {
    Cleanup-All
}
