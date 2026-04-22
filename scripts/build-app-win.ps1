# Master build script for the OpenSwarm desktop app on Windows.
#
# Usage:
#   pwsh scripts\build-app-win.ps1                Local dev build (unsigned)
#   pwsh scripts\build-app-win.ps1 -Sign          Signed build (no publish)
#   pwsh scripts\build-app-win.ps1 -Publish       Production build (sign + publish to GitHub Releases)
#
# Reads .env.windows (gitignored) for Azure Trusted Signing + GH_TOKEN if -Sign or -Publish.

[CmdletBinding()]
param(
    [switch]$Sign,
    [switch]$Publish
)

$ErrorActionPreference = 'Stop'
if ($Publish) { $Sign = $true }

$ScriptDir   = Split-Path -Parent $PSCommandPath
$ProjectRoot = Split-Path -Parent $ScriptDir

# --- Load .env.windows if present ---
$EnvFile = Join-Path $ProjectRoot '.env.windows'
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $idx = $line.IndexOf('=')
            $name  = $line.Substring(0, $idx).Trim()
            $value = $line.Substring($idx + 1).Trim()
            if ($value.StartsWith('"') -and $value.EndsWith('"')) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            Set-Item -Path "Env:$name" -Value $value
        }
    }
}

Write-Host "========================================"
Write-Host "  OpenSwarm Desktop App Builder (Windows)"
if     ($Publish) { Write-Host "  Mode: PRODUCTION (sign + publish to GitHub Releases)" }
elseif ($Sign)    { Write-Host "  Mode: SIGNED (sign, no publish)" }
else              { Write-Host "  Mode: LOCAL (unsigned)" }
Write-Host "========================================"
Write-Host ""

# --- Required env validation ---
if ($Sign) {
    $required = @(
        'AZURE_TENANT_ID','AZURE_CLIENT_ID','AZURE_CLIENT_SECRET',
        'AZURE_SIGNING_ENDPOINT','AZURE_SIGNING_ACCOUNT','AZURE_SIGNING_CERT_PROFILE'
    )
    if ($Publish) { $required += 'GH_TOKEN' }
    $missing = $required | Where-Object { -not [Environment]::GetEnvironmentVariable($_) }
    if ($missing.Count -gt 0) {
        Write-Host "ERROR: Missing required environment variables:" -ForegroundColor Red
        $missing | ForEach-Object { Write-Host "  - $_" }
        Write-Host "Copy .env.windows.example to .env.windows and fill in values."
        exit 1
    }
}

# --- Step 0: Bundled uv/uvx (Windows zip) ---
$UvBinDir = Join-Path $ProjectRoot 'backend\uv-bin'
if (-not (Test-Path (Join-Path $UvBinDir 'uvx.exe'))) {
    Write-Host "[0] Downloading uv/uvx for Windows..."
    New-Item -ItemType Directory -Force -Path $UvBinDir | Out-Null
    $UvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'
    $TmpZip = Join-Path $env:TEMP "uv-win-$([guid]::NewGuid()).zip"
    $TmpExtract = Join-Path $env:TEMP "uv-win-extract-$([guid]::NewGuid())"
    try {
        Invoke-WebRequest -Uri $UvUrl -OutFile $TmpZip -UseBasicParsing
        Expand-Archive -Path $TmpZip -DestinationPath $TmpExtract -Force
        Get-ChildItem -Path $TmpExtract -Recurse -Filter 'uv.exe'  | Select-Object -First 1 | ForEach-Object { Copy-Item $_.FullName (Join-Path $UvBinDir 'uv.exe') -Force }
        Get-ChildItem -Path $TmpExtract -Recurse -Filter 'uvx.exe' | Select-Object -First 1 | ForEach-Object { Copy-Item $_.FullName (Join-Path $UvBinDir 'uvx.exe') -Force }
        Write-Host "uv/uvx downloaded and bundled."
    } finally {
        Remove-Item -Force $TmpZip -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $TmpExtract -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "[0] uv/uvx binaries already present."
}
Write-Host ""

# --- Step 0b: Bundle reddit-mcp-buddy via esbuild ---
$McpBundleDir = Join-Path $ProjectRoot 'backend\mcp-bundles'
New-Item -ItemType Directory -Force -Path $McpBundleDir | Out-Null
$RedditBundle = Join-Path $McpBundleDir 'reddit-mcp-buddy.js'
if (-not (Test-Path $RedditBundle)) {
    Write-Host "[0b] Bundling reddit-mcp-buddy..."
    $TmpDir = Join-Path $env:TEMP "openswarm-mcp-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
    Push-Location $TmpDir
    try {
        & npm install reddit-mcp-buddy --silent 2>$null
        & npx esbuild "node_modules/reddit-mcp-buddy/dist/index.js" --bundle --platform=node --format=cjs "--outfile=$RedditBundle"
        if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }
        Write-Host "reddit-mcp-buddy bundled."
    } finally {
        Pop-Location
        Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "[0b] reddit-mcp-buddy bundle already present."
}

# --- Step 0c: npm MCP servers that can't be bundled ---
$NpmServersDir = Join-Path $ProjectRoot 'backend\npm-servers'
New-Item -ItemType Directory -Force -Path $NpmServersDir | Out-Null

function Install-NpmServer($SubDir, $PackageName) {
    $TargetDir = Join-Path $NpmServersDir $SubDir
    $NodeModules = Join-Path $TargetDir 'node_modules'
    if (Test-Path $NodeModules) {
        Write-Host "[0c] $PackageName already present."
        return
    }
    Write-Host "[0c] Installing $PackageName..."
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    Push-Location $TargetDir
    try {
        & npm init -y *>$null
        & npm install $PackageName --silent 2>$null
        if ($LASTEXITCODE -ne 0) { throw "$PackageName install failed" }
        Write-Host "$PackageName installed."
    } finally {
        Pop-Location
    }
}
Install-NpmServer 'softeria-ms-365-mcp-server' '@softeria/ms-365-mcp-server'
Install-NpmServer 'notionhq-notion-mcp-server' '@notionhq/notion-mcp-server'
Write-Host ""

# --- Step 1: Frontend build ---
Write-Host "[1/5] Building frontend..."
Push-Location (Join-Path $ProjectRoot 'frontend')
try {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install (frontend) failed" }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
} finally { Pop-Location }
if (-not (Test-Path (Join-Path $ProjectRoot 'frontend\dist\index.html'))) {
    throw "Frontend build failed - dist\index.html not found"
}
Write-Host "Frontend build complete."
Write-Host ""

# --- Step 2: Python env ---
$PythonEnv = Join-Path $ProjectRoot 'electron\python-env'
$PythonExe = Join-Path $PythonEnv 'python.exe'
if ((Test-Path $PythonExe) -and -not $env:OPENSWARM_REBUILD_PYTHON) {
    Write-Host "[2/5] Python environment already present at $PythonEnv (set `$env:OPENSWARM_REBUILD_PYTHON='1' to force rebuild)."
} else {
    Write-Host "[2/5] Building Python environment..."
    & (Join-Path $ScriptDir 'build-python-env-win.ps1')
    if ($LASTEXITCODE -ne 0) { throw "Python env build failed" }
}
if (-not (Test-Path (Join-Path $ProjectRoot 'electron\python-env'))) {
    throw "Python environment not found at electron\python-env\"
}
Write-Host "Python environment ready."
Write-Host ""

# --- Step 3: 9Router build ---
Write-Host "[3/5] Building 9Router..."
Push-Location (Join-Path $ProjectRoot '9router')
try {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install (9router) failed" }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "9router build failed" }
} finally { Pop-Location }
$Standalone = Join-Path $ProjectRoot '9router\.next\standalone'
if (-not (Test-Path $Standalone)) { throw "9Router build failed - .next\standalone not found" }
$NextStatic = Join-Path $ProjectRoot '9router\.next\static'
if (Test-Path $NextStatic) {
    $StandaloneStatic = Join-Path $Standalone '.next\static'
    New-Item -ItemType Directory -Force -Path (Split-Path $StandaloneStatic -Parent) | Out-Null
    Copy-Item -Recurse -Force $NextStatic $StandaloneStatic
}
$NextPublic = Join-Path $ProjectRoot '9router\public'
if (Test-Path $NextPublic) {
    Copy-Item -Recurse -Force $NextPublic (Join-Path $Standalone 'public')
}
Write-Host "9Router build complete."
Write-Host ""

# --- Step 4: Snapshot source dirs into electron\build-staging\ ---
Write-Host "[4/5] Snapshotting source directories..."
$Staging = Join-Path $ProjectRoot 'electron\build-staging'
if (Test-Path $Staging) { Remove-Item -Recurse -Force $Staging }
New-Item -ItemType Directory -Force -Path $Staging | Out-Null

function Copy-Excluded($Source, $Dest, $Exclude) {
    # robocopy: built-in, fast, handles long paths.
    $args = @($Source, $Dest, '/E', '/NJH', '/NJS', '/NDL', '/NFL', '/NP', '/MT:8')
    foreach ($d in $Exclude.Dirs)  { $args += '/XD'; $args += $d }
    foreach ($f in $Exclude.Files) { $args += '/XF'; $args += $f }
    & robocopy @args | Out-Null
    # robocopy exit codes 0–7 are success
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($Source -> $Dest, exit $LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
}

Copy-Excluded `
    (Join-Path $ProjectRoot 'backend') (Join-Path $Staging 'backend') `
    @{ Dirs = @('__pycache__','.venv','tools','tests'); Files = @('*.pyc') }
New-Item -ItemType Directory -Force -Path (Join-Path $Staging 'backend\data\tools') | Out-Null

Copy-Excluded `
    (Join-Path $ProjectRoot 'debugger') (Join-Path $Staging 'debugger') `
    @{ Dirs = @('__pycache__','.venv','node_modules'); Files = @('*.pyc') }

Copy-Item -Recurse -Force (Join-Path $ProjectRoot 'frontend\dist\*') (New-Item -ItemType Directory -Force -Path (Join-Path $Staging 'frontend')).FullName

# 9Router standalone -> staging\9router
Copy-Excluded $Standalone (Join-Path $Staging '9router') @{ Dirs = @(); Files = @() }
if (Test-Path $NextStatic) {
    $TargetStatic = Join-Path $Staging '9router\.next\static'
    New-Item -ItemType Directory -Force -Path (Split-Path $TargetStatic -Parent) | Out-Null
    Copy-Item -Recurse -Force $NextStatic $TargetStatic
}

Write-Host ""
Write-Host "========================================" -BackgroundColor Green -ForegroundColor White
Write-Host "  SOURCE SNAPSHOT COMPLETE              " -BackgroundColor Green -ForegroundColor White
Write-Host "  Safe to modify your codebase now.     " -BackgroundColor Green -ForegroundColor White
Write-Host "========================================" -BackgroundColor Green -ForegroundColor White
Write-Host ""

# --- Step 5: Package with electron-builder ---
Write-Host "[5/5] Packaging with electron-builder..."
Push-Location (Join-Path $ProjectRoot 'electron')
try {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install (electron) failed" }

    if (-not $Sign) {
        $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    }

    if ($Publish) {
        # Safety check: warn if the matching Mac release isn't on GitHub yet.
        # Mac and Windows publishes don't conflict (different asset names,
        # different latest*.yml manifests), but a Windows-only release means
        # Mac users will skip this version entirely. Better to know now than
        # explain it after the fact. Non-fatal; sleeps 8s to let the user
        # Ctrl+C if it surprises them.
        try {
            $pkgJson = Get-Content -Raw (Join-Path $ProjectRoot 'electron\package.json') | ConvertFrom-Json
            $version = $pkgJson.version
            $macYmlUrl = "https://github.com/openswarm-ai/openswarm/releases/download/v$version/latest-mac.yml"
            $null = Invoke-WebRequest -Uri $macYmlUrl -Method Head -UseBasicParsing -ErrorAction Stop -TimeoutSec 10
            Write-Host "  > Mac release v$version detected on GitHub (latest-mac.yml present). OK to proceed."
        } catch {
            Write-Host ""
            Write-Host "WARNING: Mac release v$version is NOT yet published on GitHub." -ForegroundColor Yellow
            Write-Host "  -> Uploading Windows assets to a release with no Mac assets means" -ForegroundColor Yellow
            Write-Host "     Mac users will skip v$version entirely (electron-updater on Mac" -ForegroundColor Yellow
            Write-Host "     will see no latest-mac.yml). Recommended order:" -ForegroundColor Yellow
            Write-Host "       1. bash publish.sh   (on the Mac)" -ForegroundColor Yellow
            Write-Host "       2. pwsh publish-win.ps1   (here)" -ForegroundColor Yellow
            Write-Host "  -> Continuing in 8s. Press Ctrl+C to abort." -ForegroundColor Yellow
            Start-Sleep -Seconds 8
        }
        & npx electron-builder --win --x64 --publish always
    } else {
        & npx electron-builder --win --x64 --publish never
    }
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
} finally { Pop-Location }

Remove-Item -Recurse -Force $Staging -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "========================================"
Write-Host "  Build Complete!"
Write-Host "========================================"
Write-Host ""
Write-Host "Output files:"
Get-ChildItem -Path (Join-Path $ProjectRoot 'electron\dist') -Filter '*.exe' -ErrorAction SilentlyContinue | Format-Table Name, Length, LastWriteTime
Get-ChildItem -Path (Join-Path $ProjectRoot 'electron\dist') -Filter '*.zip' -ErrorAction SilentlyContinue | Format-Table Name, Length, LastWriteTime
