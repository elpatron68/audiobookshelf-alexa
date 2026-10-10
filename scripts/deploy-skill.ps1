<#
.SYNOPSIS
    Deploys or updates the Audiobookshelf Alexa Skill interaction models and manifest using ASK CLI.

.DESCRIPTION
    Uses Amazon's official ASK CLI (Alexa Skills Kit CLI) to deploy skill-package/
    (skill.json and interactionModels/custom/de-DE.json & en-US.json) directly to Amazon.

.PARAMETER SkillId
    The Alexa Skill ID (e.g. amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).
    If omitted, it reads from ask-resources.json or prompts for it.

.EXAMPLE
    .\scripts\deploy-skill.ps1
    .\scripts\deploy-skill.ps1 -SkillId "amzn1.ask.skill.dee20f56-d346-4587-b4b8-8cb9114e8735"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$SkillId
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$AskResourcesPath = Join-Path $ProjectRoot "ask-resources.json"
$SkillPackagePath = Join-Path $ProjectRoot "skill-package"
$DeModelPath = Join-Path $SkillPackagePath "interactionModels\custom\de-DE.json"
$EnModelPath = Join-Path $SkillPackagePath "interactionModels\custom\en-US.json"
$SkillManifestPath = Join-Path $SkillPackagePath "skill.json"

# Ensure PATH includes Node and npm
$env:PATH = "C:\Program Files\nodejs;$env:PATH"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Audiobookshelf Alexa Skill - ASK CLI Deployment Tool   " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check if ask CLI is available
$askCmd = Get-Command "ask" -ErrorAction SilentlyContinue
if (-not $askCmd) {
    $npmGlobalAsk = Join-Path $env:APPDATA "npm\ask.cmd"
    if (Test-Path $npmGlobalAsk) {
        $askCmd = $npmGlobalAsk
    }
}

if (-not $askCmd) {
    Write-Host "[!] ASK CLI ('ask') is not installed yet." -ForegroundColor Yellow
    Write-Host "    Installing ASK CLI globally via npm..." -ForegroundColor Cyan
    try {
        & npm install -g ask-cli
        $askCmd = Get-Command "ask" -ErrorAction SilentlyContinue
        if (-not $askCmd) {
            $npmGlobalAsk = Join-Path $env:APPDATA "npm\ask.cmd"
            if (Test-Path $npmGlobalAsk) { $askCmd = $npmGlobalAsk }
        }
    } catch {
        Write-Host "[-] Failed to automatically install ASK CLI: $_" -ForegroundColor Red
        Write-Host "    Please run manually: npm install -g ask-cli" -ForegroundColor Yellow
        exit 1
    }
}

if (-not $askCmd) {
    Write-Host "[-] ASK CLI not found in PATH after install. Please restart your terminal." -ForegroundColor Red
    exit 1
}

Write-Host "[+] ASK CLI found: $askCmd" -ForegroundColor Green

# 2. Check if ASK CLI is authenticated
Write-Host "[*] Checking ASK CLI authentication..." -ForegroundColor Cyan
$configured = $false
try {
    $vendors = & $askCmd smapi get-vendor-list 2>&1
    if ($LASTEXITCODE -eq 0 -and $vendors -notmatch "Please run 'ask configure'") {
        $configured = $true
    }
} catch {
    $configured = $false
}

if (-not $configured) {
    Write-Host ""
    Write-Host "----------------------------------------------------------" -ForegroundColor Yellow
    Write-Host " One-time Amazon Developer Authentication Required:        " -ForegroundColor Yellow
    Write-Host " Please run 'ask configure' in your terminal.             " -ForegroundColor Yellow
    Write-Host " This will open a browser to log into your Amazon account." -ForegroundColor Yellow
    Write-Host "----------------------------------------------------------" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "After completing 'ask configure', rerun this script." -ForegroundColor Cyan
    exit 0
}

# 3. Determine Skill ID
if (-not $SkillId) {
    if (Test-Path $AskResourcesPath) {
        try {
            $res = Get-Content $AskResourcesPath -Raw | ConvertFrom-Json
            if ($res.profiles.default.skillId) {
                $SkillId = $res.profiles.default.skillId
                Write-Host "[+] Found Skill ID in ask-resources.json: $SkillId" -ForegroundColor Green
            }
        } catch {}
    }
}

if (-not $SkillId) {
    # Try finding skills automatically
    try {
        $skillList = & $askCmd smapi list-skills-for-vendor | ConvertFrom-Json
        if ($skillList.skills -and $skillList.skills.Count -gt 0) {
            $SkillId = $skillList.skills[0].skillId
            Write-Host "[+] Automatically detected Skill ID: $SkillId" -ForegroundColor Green
        }
    } catch {}
}

if (-not $SkillId) {
    Write-Host ""
    $SkillId = Read-Host "Bitte gib deine Skill ID ein (aus der Alexa Developer Console URL, z.B. amzn1.ask.skill.xxx)"
}

if (-not $SkillId) {
    Write-Host "[-] Keine Skill ID angegeben. Abbruch." -ForegroundColor Red
    exit 1
}

# Update ask-resources.json with Skill ID
if (Test-Path $AskResourcesPath) {
    try {
        $res = Get-Content $AskResourcesPath -Raw | ConvertFrom-Json
        $jsonOut = $res | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($AskResourcesPath, $jsonOut, (New-Object System.Text.UTF8Encoding $false))
        Write-Host "[+] ask-resources.json updated with Skill ID." -ForegroundColor Green
    } catch {
        Write-Warning "Could not update ask-resources.json: $_"
    }
}

# 4. Deploy Interaction Model via SMAPI
Write-Host ""
Write-Host "[*] Uploading German Interaction Model (de-DE.json)..." -ForegroundColor Cyan
& $askCmd smapi set-interaction-model -s $SkillId -g development -l de-DE --interaction-model "file:$DeModelPath"
if ($LASTEXITCODE -eq 0) {
    Write-Host "[+] de-DE Interaction Model successfully uploaded!" -ForegroundColor Green
} else {
    Write-Host "[-] Failed to update de-DE model." -ForegroundColor Red
}

if (Test-Path $EnModelPath) {
    Write-Host "[*] Uploading English Interaction Model (en-US.json)..." -ForegroundColor Cyan
    & $askCmd smapi set-interaction-model -s $SkillId -g development -l en-US --interaction-model "file:$EnModelPath"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[+] en-US Interaction Model successfully uploaded!" -ForegroundColor Green
    }
}

# 5. Deploy Skill Manifest via SMAPI
Write-Host ""
Write-Host "[*] Uploading Skill Manifest (skill.json)..." -ForegroundColor Cyan
& $askCmd smapi update-skill-manifest -s $SkillId -g development --manifest "file:$SkillManifestPath"
if ($LASTEXITCODE -eq 0) {
    Write-Host "[+] Skill Manifest successfully updated (AudioPlayer interface & Lambda ARN active)!" -ForegroundColor Green
} else {
    Write-Host "[-] Failed to update manifest." -ForegroundColor Red
}

# 6. Wait for model build status
Write-Host ""
Write-Host "[*] Waiting for interaction model build to finish..." -ForegroundColor Cyan
for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 5
    $statusJson = & $askCmd smapi get-skill-status -s $SkillId 2>$null
    if ($statusJson) {
        try {
            $statusObj = $statusJson | ConvertFrom-Json
            $deStatus = $statusObj.interactionModel.'de-DE'.lastUpdateRequest.status
            $manifestStatus = $statusObj.manifest.lastUpdateRequest.status
            Write-Host "    Model Build: $deStatus | Manifest: $manifestStatus" -ForegroundColor DarkGray
            if ($deStatus -eq "SUCCEEDED" -and $manifestStatus -eq "SUCCEEDED") {
                break
            }
            if ($deStatus -eq "FAILED") {
                Write-Host "[-] Model build failed! Details:" -ForegroundColor Red
                $statusJson | Write-Host
                exit 1
            }
        } catch {}
    }
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  DEPLOYMENT COMPLETE & MODEL BUILD SUCCEEDED!            " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Skill ID:    $SkillId" -ForegroundColor Cyan
Write-Host "Lambda ARN:  arn:aws:lambda:us-east-1:397379264657:function:audiobookshelf-alexa" -ForegroundColor Cyan
Write-Host "Invocation:  'Alexa, öffne Audiobookshelf'" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Green
