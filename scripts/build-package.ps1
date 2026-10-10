<#
.SYNOPSIS
    Builds the AWS Lambda deployment ZIP package for the Audiobookshelf Alexa Skill.

.DESCRIPTION
    Runs dependencies installation and unit tests in lambda/, copies the production
    files to a temporary staging folder (excluding test files), and creates
    audiobookshelf-alexa.zip ready for upload to AWS Lambda.

.PARAMETER SkipTests
    Skips running 'npm test' before packaging.

.PARAMETER OutputPath
    Destination path for the zip file. Defaults to 'audiobookshelf-alexa.zip' in repo root.

.EXAMPLE
    .\scripts\build-package.ps1
    .\scripts\build-package.ps1 -SkipTests
#>

[CmdletBinding()]
param(
    [switch]$SkipTests,
    [string]$OutputPath = "audiobookshelf-alexa.zip"
)

$ErrorActionPreference = "Stop"

# Auto-detect node.exe if not yet in PATH
if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    $possibleNodePaths = @(
        "C:\Program Files\nodejs",
        "C:\Program Files (x86)\nodejs",
        "$env:LOCALAPPDATA\Programs\node"
    )
    foreach ($p in $possibleNodePaths) {
        if (Test-Path (Join-Path $p "node.exe")) {
            $env:PATH = "$p;$env:PATH"
            Write-Host "--> Added $p to PATH" -ForegroundColor DarkGray
            break
        }
    }
}

if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js (node.exe) was not found. Please install Node.js (https://nodejs.org) or add it to PATH."
    exit 1
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$lambdaDir = Join-Path $repoRoot "lambda"
$zipPath = if ([System.IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path $repoRoot $OutputPath }

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Building Audiobookshelf Alexa Skill Lambda Package      " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

if (-not (Test-Path $lambdaDir)) {
    Write-Error "Lambda source directory not found: $lambdaDir"
    exit 1
}

Push-Location $lambdaDir
try {
    Write-Host "`n[1/4] Installing dependencies..." -ForegroundColor Yellow
    npm install

    if (-not $SkipTests) {
        Write-Host "`n[2/4] Running test suite..." -ForegroundColor Yellow
        npm test
        Write-Host "--> All tests passed." -ForegroundColor Green
    } else {
        Write-Host "`n[2/4] Skipping tests (-SkipTests flag set)..." -ForegroundColor DarkGray
    }
} finally {
    Pop-Location
}

# Temporary staging directory
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("abs-alexa-build-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

try {
    Write-Host "`n[3/4] Staging production files..." -ForegroundColor Yellow

    # Copy files excluding test directories and logs
    Get-ChildItem -Path $lambdaDir -Exclude "test" | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $tempDir -Recurse -Force
    }

    # Clean any accidental test files from temp
    $testFolderInTemp = Join-Path $tempDir "test"
    if (Test-Path $testFolderInTemp) {
        Remove-Item $testFolderInTemp -Recurse -Force
    }

    Write-Host "`n[4/4] Creating ZIP package..." -ForegroundColor Yellow
    $tempZip = Join-Path ([System.IO.Path]::GetTempPath()) ("abs-pkg-" + [System.Guid]::NewGuid().ToString("N") + ".zip")
    Compress-Archive -Path (Join-Path $tempDir "*") -DestinationPath $tempZip -Force

    # Move to target with retry logic in case of transient file locks (antivirus, indexer, explorer)
    $maxAttempts = 5
    $attempt = 0
    $success = $false
    while (-not $success -and $attempt -lt $maxAttempts) {
        $attempt++
        try {
            if (Test-Path $zipPath) {
                Remove-Item $zipPath -Force -ErrorAction Stop
            }
            Move-Item -Path $tempZip -Destination $zipPath -Force -ErrorAction Stop
            $success = $true
        } catch {
            if ($attempt -lt $maxAttempts) {
                Write-Host "--> Target '$zipPath' temporarily in use. Retrying in 1s ($attempt/$maxAttempts)..." -ForegroundColor DarkYellow
                Start-Sleep -Seconds 1
            } else {
                # Fallback: if destination zip is locked by an open process, save under timestamped name
                $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
                $altZipPath = Join-Path $repoRoot "audiobookshelf-alexa-$timestamp.zip"
                Copy-Item -Path $tempZip -Destination $altZipPath -Force
                Write-Warning "Could not overwrite '$zipPath' because another process has it open."
                Write-Host "--> Saved package to alternative file: $altZipPath" -ForegroundColor Cyan
                $zipPath = $altZipPath
                $success = $true
            }
        }
    }

    $zipItem = Get-Item $zipPath
    $sizeKb = [Math]::Round($zipItem.Length / 1KB, 2)
    $sizeMb = [Math]::Round($zipItem.Length / 1MB, 2)

    Write-Host "`n==========================================================" -ForegroundColor Green
    Write-Host "  SUCCESS! Package created successfully:                  " -ForegroundColor Green
    Write-Host "  Path: $zipPath" -ForegroundColor White
    Write-Host "  Size: $sizeKb KB ($sizeMb MB)" -ForegroundColor White
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "Ready to be uploaded to AWS Lambda." -ForegroundColor Green
}
finally {
    if (Test-Path $tempDir) {
        Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($tempZip -and (Test-Path $tempZip)) {
        Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
    }
}
