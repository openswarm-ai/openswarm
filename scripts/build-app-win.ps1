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

# --- Step 0: Bundled uv + uvx for Windows ---
# IMPORTANT: uvx.exe is a tiny shim that requires sibling uv.exe at runtime.
# Without uv.exe, MCPs that use `command: uvx` (e.g. Google Workspace) fail
# with "Could not find the `uv` binary". A prior revision shipped only uvx
# to save ~30MB; that broke first-launch MCP discovery on fresh Macs and
# Windows machines without a system uv install. Ship both.
$UvBinDir = Join-Path $ProjectRoot 'backend\uv-bin'
New-Item -ItemType Directory -Force -Path $UvBinDir | Out-Null
$NeedUv = -not (Test-Path (Join-Path $UvBinDir 'uv.exe')) -or `
          -not (Test-Path (Join-Path $UvBinDir 'uvx.exe'))
if ($NeedUv) {
    Write-Host "[0] Downloading uv + uvx for Windows..."
    $UvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'
    $TmpZip = Join-Path $env:TEMP "uv-win-$([guid]::NewGuid()).zip"
    $TmpExtract = Join-Path $env:TEMP "uv-win-extract-$([guid]::NewGuid())"
    try {
        Invoke-WebRequest -Uri $UvUrl -OutFile $TmpZip -UseBasicParsing
        Expand-Archive -Path $TmpZip -DestinationPath $TmpExtract -Force
        Get-ChildItem -Path $TmpExtract -Recurse -Filter 'uv.exe'  | Select-Object -First 1 | ForEach-Object { Copy-Item $_.FullName (Join-Path $UvBinDir 'uv.exe')  -Force }
        Get-ChildItem -Path $TmpExtract -Recurse -Filter 'uvx.exe' | Select-Object -First 1 | ForEach-Object { Copy-Item $_.FullName (Join-Path $UvBinDir 'uvx.exe') -Force }
        Write-Host "uv.exe + uvx.exe downloaded and bundled."
    } finally {
        Remove-Item -Force $TmpZip -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $TmpExtract -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "[0] uv.exe + uvx.exe already present."
}
Write-Host ""

# --- Step 0a: Sync the splash icon ---
# electron-builder excludes `build/` from the shipped asar (it's the icon-
# source directory used to generate .ico). The splash window needs to read
# the icon at runtime, so we keep a copy at electron\splash\icon.png which
# IS shipped. See electron/main.js comment at iconPngPath for context.
Copy-Item -Force `
    (Join-Path $ProjectRoot 'electron\build\icon.png') `
    (Join-Path $ProjectRoot 'electron\splash\icon.png')

# --- Step 0b: Bundle npm MCP servers via esbuild ---
# Each bundle compiles down to a single ~5-15 MB CommonJS file under
# backend\mcp-bundles\, runs on Electron's bundled Node at runtime
# (ELECTRON_RUN_AS_NODE=1), and is preferred by tools_lib.py:521 over
# any pre-installed node_modules tree. Bundling instead of shipping
# node_modules cuts the installer file count from ~28k -> ~9k, which
# is the dominant lever on NSIS install time + Defender scan cost.
$McpBundleDir = Join-Path $ProjectRoot 'backend\mcp-bundles'
New-Item -ItemType Directory -Force -Path $McpBundleDir | Out-Null

# Single-file CJS bundle. Output path: mcp-bundles\<output>.js. Use for
# packages that don't read sibling files at runtime. The import.meta.url
# polyfill is applied uniformly because nearly every modern ESM package
# uses createRequire(import.meta.url) somewhere -- without the polyfill,
# esbuild's ESM->CJS transform leaves import.meta.url as undefined and
# the bundle crashes at module load.
function Build-McpBundleSingle($PackageName, $EntrySubpath, $OutputName) {
    $OutFile = Join-Path $McpBundleDir $OutputName
    if ((Test-Path $OutFile) -and -not $env:OPENSWARM_REBUILD_BUNDLES) {
        Write-Host "[0b] $PackageName bundle already present (set `$env:OPENSWARM_REBUILD_BUNDLES='1' to force rebuild)."
        return
    }
    Write-Host "[0b] Bundling $PackageName -> $OutputName ..."
    $TmpDir = Join-Path $env:TEMP "openswarm-mcp-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
    Push-Location $TmpDir
    try {
        & npm install $PackageName --silent 2>$null
        if ($LASTEXITCODE -ne 0) { throw "$PackageName install failed" }
        $EntryPath = Join-Path (Join-Path $TmpDir 'node_modules') $EntrySubpath
        if (-not (Test-Path $EntryPath)) { throw "$PackageName entry not found at $EntryPath" }
        $banner = 'const __OPENSWARM_IMPORT_META_URL__ = require("url").pathToFileURL(__filename).href;'
        & npx esbuild $EntryPath --bundle --platform=node --format=cjs --target=node22 --legal-comments=none `
            --define:import.meta.url=__OPENSWARM_IMPORT_META_URL__ `
            "--banner:js=$banner" `
            "--outfile=$OutFile"
        if ($LASTEXITCODE -ne 0) { throw "esbuild failed for $PackageName" }
        Write-Host "$PackageName bundled."
    } finally {
        Pop-Location
        Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
    }
}

# Multi-file bundle. Output is a directory mcp-bundles\<dir>\ that mirrors the
# upstream SDK's "package_root\dist\index.js + ..\package.json" layout. Use this
# for packages whose source reads __dirname\..\package.json (for --version) or
# other sibling data files (e.g. @softeria\ms-365-mcp-server reads endpoints.json).
function Build-McpBundleDir($PackageName, $EntrySubpath, $OutDirName, $Extras, $External) {
    $OutDir = Join-Path $McpBundleDir $OutDirName
    $OutBundle = Join-Path (Join-Path $OutDir 'dist') 'index.js'
    if ((Test-Path $OutBundle) -and -not $env:OPENSWARM_REBUILD_BUNDLES) {
        Write-Host "[0b] $PackageName bundle dir already present."
        return
    }
    Write-Host "[0b] Bundling $PackageName -> $OutDirName\ ..."
    $TmpDir = Join-Path $env:TEMP "openswarm-mcp-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
    if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
    New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'dist') | Out-Null
    Push-Location $TmpDir
    try {
        & npm install $PackageName --silent 2>$null
        if ($LASTEXITCODE -ne 0) { throw "$PackageName install failed" }
        $EntryPath = Join-Path (Join-Path $TmpDir 'node_modules') $EntrySubpath
        if (-not (Test-Path $EntryPath)) { throw "$PackageName entry not found at $EntryPath" }

        # Stripped sibling package.json (omits "type":"module" so Node treats the CJS bundle correctly)
        $SdkPkgPath = Join-Path (Join-Path $TmpDir 'node_modules') (Join-Path $PackageName 'package.json')
        $SdkPkgJson = Get-Content -Raw $SdkPkgPath | ConvertFrom-Json
        $SdkVersion = $SdkPkgJson.version
        $StrippedPkg = "{`"name`":`"$PackageName`",`"version`":`"$SdkVersion`"}"
        Set-Content -Path (Join-Path $OutDir 'package.json') -Value $StrippedPkg -NoNewline

        # Copy sibling data files
        if ($Extras) {
            foreach ($pair in $Extras) {
                $src, $dst = $pair -split '='
                $srcAbs = Join-Path (Join-Path $TmpDir 'node_modules') $src
                $dstAbs = Join-Path $OutDir $dst
                New-Item -ItemType Directory -Force -Path (Split-Path $dstAbs -Parent) | Out-Null
                Copy-Item -Force $srcAbs $dstAbs
            }
        }

        $banner = 'const __OPENSWARM_IMPORT_META_URL__ = require("url").pathToFileURL(__filename).href;'
        $esbuildArgs = @(
            $EntryPath, '--bundle', '--platform=node', '--format=cjs',
            '--target=node22', '--legal-comments=none',
            '--define:import.meta.url=__OPENSWARM_IMPORT_META_URL__',
            "--banner:js=$banner",
            "--outfile=$OutBundle"
        )
        if ($External) {
            foreach ($ext in $External) { $esbuildArgs += "--external:$ext" }
        }
        & npx esbuild @esbuildArgs
        if ($LASTEXITCODE -ne 0) { throw "esbuild failed for $PackageName" }
        Write-Host "$PackageName bundled."
    } finally {
        Pop-Location
        Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
    }
}

Build-McpBundleSingle 'reddit-mcp-buddy'              'reddit-mcp-buddy/dist/index.js'             'reddit-mcp-buddy.js'
Build-McpBundleDir    '@notionhq/notion-mcp-server'   '@notionhq/notion-mcp-server/bin/cli.mjs'    `
                      'notionhq-notion-mcp-server' `
                      @('@notionhq/notion-mcp-server/scripts/notion-openapi.json=scripts/notion-openapi.json') `
                      @()
Build-McpBundleDir    '@softeria/ms-365-mcp-server'   '@softeria/ms-365-mcp-server/dist/index.js' `
                      'softeria-ms-365-mcp-server' `
                      @('@softeria/ms-365-mcp-server/dist/endpoints.json=dist/endpoints.json') `
                      @('keytar')

# Wipe legacy single-file Notion bundle if the dir-style bundle now supersedes it.
$LegacyNotionFile = Join-Path $McpBundleDir 'notionhq-notion-mcp-server.js'
$NotionDir = Join-Path $McpBundleDir 'notionhq-notion-mcp-server'
if ((Test-Path $LegacyNotionFile) -and (Test-Path $NotionDir)) {
    Remove-Item -Force $LegacyNotionFile
}

# Defensively wipe any legacy npm-servers/ tree from prior builds so it
# doesn't ride along into the installer (would re-introduce the ~19k
# files we just removed by switching to bundling).
$LegacyNpmServers = Join-Path $ProjectRoot 'backend\npm-servers'
if (Test-Path $LegacyNpmServers) {
    Write-Host "[0b] Removing legacy backend\npm-servers\ (now superseded by mcp-bundles)..."
    Remove-Item -Recurse -Force $LegacyNpmServers
}
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

# --- Step 3: Fetch Router from npm ---
# The 9router Next.js server is published as an npm package with a pre-built
# standalone output. Stage it directly from npm instead of vendoring + rebuilding.
Write-Host "[3/5] Fetching Router from npm..."
$Staging = Join-Path $ProjectRoot 'electron\build-staging'
if (Test-Path $Staging) { Remove-Item -Recurse -Force $Staging }
New-Item -ItemType Directory -Force -Path $Staging | Out-Null

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot 'scripts\fetch-router.ps1') -Dest (Join-Path $Staging 'router')
if ($LASTEXITCODE -ne 0) { throw "fetch-router.ps1 failed" }

if (-not (Test-Path (Join-Path $Staging 'router\server.js'))) {
    throw "Router fetch failed - server.js not found in staging"
}
Write-Host "Router staged."
Write-Host ""

# --- Step 3b: Bundle a real Node.js binary so 9Router and MCP servers
# don't fall back to ELECTRON_RUN_AS_NODE on user machines without system
# node. Wins: (1) avoids the bouncing "exec" Dock icon (irrelevant on
# Windows but matches the macOS build for consistency); (2) shrinks
# 9Router cold-start from ~10s (Electron-as-Node) to ~1-2s (real node),
# which directly shrinks the splash window the user sees during boot.
# Pinned to Node 20 LTS, NODE_MODULE_VERSION 115. 9router 0.3.60 has
# no native bindings (sql.js, not better-sqlite3) so any Node 18+ works.
Write-Host "[3b/5] Bundling Node.js runtime..."
$NodeVersion = 'v20.18.1'
$NodeStageDir = Join-Path $Staging 'node\x64'
New-Item -ItemType Directory -Force -Path $NodeStageDir | Out-Null
$NodeZip = Join-Path $env:TEMP "node-win-$([guid]::NewGuid()).zip"
$NodeExtract = Join-Path $env:TEMP "node-win-extract-$([guid]::NewGuid())"
try {
    $NodeUrl = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
    Write-Host "[3b] Downloading $NodeUrl..."
    Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip -UseBasicParsing
    Expand-Archive -Path $NodeZip -DestinationPath $NodeExtract -Force
    # Ship just node.exe; npm/npx are unused at runtime (saves ~70 MB).
    $SrcNode = Join-Path $NodeExtract "node-$NodeVersion-win-x64\node.exe"
    if (-not (Test-Path $SrcNode)) { throw "node.exe not found at $SrcNode after extract" }
    Copy-Item -Force $SrcNode (Join-Path $NodeStageDir 'node.exe')
    $Size = (Get-Item (Join-Path $NodeStageDir 'node.exe')).Length / 1MB
    Write-Host ("[3b] Node {0} (x64) staged ({1:N1} MB)" -f $NodeVersion, $Size)
} finally {
    if (Test-Path $NodeZip) { Remove-Item -Force $NodeZip }
    if (Test-Path $NodeExtract) { Remove-Item -Recurse -Force $NodeExtract }
}
Write-Host ""

# --- Step 4: Snapshot source dirs into electron\build-staging\ ---
# (Router was already staged in step 3; do not wipe or re-copy it here.)
Write-Host "[4/5] Snapshotting source directories..."

function Copy-Excluded($Source, $Dest, $Exclude) {
    # robocopy: built-in, fast, handles long paths.
    $args = @($Source, $Dest, '/E', '/NJH', '/NJS', '/NDL', '/NFL', '/NP', '/MT:8')
    foreach ($d in $Exclude.Dirs)  { $args += '/XD'; $args += $d }
    foreach ($f in $Exclude.Files) { $args += '/XF'; $args += $f }
    & robocopy @args | Out-Null
    # robocopy exit codes 0-7 are success
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($Source -> $Dest, exit $LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
}

Copy-Excluded `
    (Join-Path $ProjectRoot 'backend') (Join-Path $Staging 'backend') `
    @{ Dirs = @('__pycache__','.venv','data','uv-bin','tests'); Files = @('*.pyc','.env','.env.*') }
# data: backend/config/paths.py points DATA_ROOT at %APPDATA%/OpenSwarm/data in
# packaged mode and no code seeds from the bundle, so the entire shipped
# backend/data/ tree was dead weight (and was leaking the dev machine's
# auth.token + install_id + dev session artifacts).
# uv-bin: source dir holds the binary so dev works; staged separately below
# so extraResources can substitute ${arch} (matches the mac build).

# Production .env: OAuth helper base URL + Google credentials. See
# scripts/build-app.sh for the rationale; v1.0.29 cloud-proxied the OAuth flow,
# but the bundled google_workspace_mcp still needs CLIENT_SECRET at startup.
# v1.0.30 plans to fork or replace that MCP and drop the secret here.
$ShipOauthBaseUrl = if ($env:OPENSWARM_OAUTH_BASE_URL_OVERRIDE) {
    $env:OPENSWARM_OAUTH_BASE_URL_OVERRIDE
} else {
    'https://api.openswarm.com'
}
$GoogleClientIdShip     = $env:GOOGLE_OAUTH_CLIENT_ID
$GoogleClientSecretShip = $env:GOOGLE_OAUTH_CLIENT_SECRET
if (-not $GoogleClientIdShip -or -not $GoogleClientSecretShip) {
    Write-Host "ERROR: GOOGLE_OAUTH_CLIENT_ID/SECRET missing in backend\.env -- required for Google MCP." -ForegroundColor Red
    exit 1
}
$ShipEnvPath = Join-Path $Staging 'backend\.env'
New-Item -ItemType Directory -Force -Path (Split-Path $ShipEnvPath -Parent) | Out-Null
@(
    "# OAuth helper base URL + Google OAuth credentials.",
    "OPENSWARM_OAUTH_BASE_URL=$ShipOauthBaseUrl",
    "GOOGLE_OAUTH_CLIENT_ID=$GoogleClientIdShip",
    "GOOGLE_OAUTH_CLIENT_SECRET=$GoogleClientSecretShip"
) | Set-Content -Path $ShipEnvPath
Write-Host "Staged production .env"

# Stage uv-bin into per-arch staging so package.json extraResources can
# substitute ${arch} and ship only the matching slice. Windows is x64-only
# today; matches the mac build's per-arch staging shape.
$UvStageX64 = Join-Path $Staging 'uv-bin\x64'
New-Item -ItemType Directory -Force -Path $UvStageX64 | Out-Null
Copy-Item -Force (Join-Path $UvBinDir 'uv.exe')  (Join-Path $UvStageX64 'uv.exe')
Copy-Item -Force (Join-Path $UvBinDir 'uvx.exe') (Join-Path $UvStageX64 'uvx.exe')

Copy-Excluded `
    (Join-Path $ProjectRoot 'debugger') (Join-Path $Staging 'debugger') `
    @{ Dirs = @('__pycache__','.venv','node_modules'); Files = @('*.pyc') }

Copy-Item -Recurse -Force (Join-Path $ProjectRoot 'frontend\dist\*') (New-Item -ItemType Directory -Force -Path (Join-Path $Staging 'frontend')).FullName

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
