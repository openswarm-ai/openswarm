# Generates an electron-updater latest.yml for a Squirrel.Windows build.
#
# Squirrel's electron-builder target emits RELEASES + .nupkg + Setup.exe but NO
# latest.yml. Existing NSIS clients poll latest.yml, so without this file every
# already-installed NSIS user is silently stranded on the old build and never
# migrates. This writes the latest.yml that points those clients at the Squirrel
# Setup.exe (electron-updater runs it with `--updated /S --force-run`, which the
# migration proof confirmed installs Squirrel and triggers the firstrun cleanup).
param(
    [Parameter(Mandatory = $true)][string]$SetupPath,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OutPath
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path $SetupPath)) { throw "Setup not found: $SetupPath" }

$fileName = Split-Path $SetupPath -Leaf

# electron-updater wants base64(sha512(file)), not hex. Stream it so a ~560MB
# installer doesn't get slurped whole into memory.
$sha = [System.Security.Cryptography.SHA512]::Create()
$fs = [System.IO.File]::OpenRead($SetupPath)
try { $hashBytes = $sha.ComputeHash($fs) } finally { $fs.Dispose(); $sha.Dispose() }
$sha512 = [System.Convert]::ToBase64String($hashBytes)
$size = (Get-Item $SetupPath).Length
$date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

$yml = @"
version: $Version
files:
  - url: $fileName
    sha512: $sha512
    size: $size
path: $fileName
sha512: $sha512
releaseDate: '$date'
"@

# electron-updater parses LF yaml; force LF + UTF-8 without BOM so the parser
# doesn't choke on a leading 0xEF 0xBB 0xBF.
$yml = $yml -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($OutPath, $yml, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Wrote $OutPath"
Write-Host "  version=$Version  file=$fileName  size=$size"
Write-Host "  sha512=$($sha512.Substring(0,24))..."
