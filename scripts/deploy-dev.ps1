<#
.SYNOPSIS
    Automated deployment script for a parallel Audiobookshelf Alexa Development Skill & Lambda function.

.DESCRIPTION
    Creates or updates an independent development skill ("Bücherregal Dev", Invocation "mein testregal")
    and Lambda function ("audiobookshelf-alexa-dev") on your Amazon developer account.
    This allows testing feature branches, proactive notifications, and webhooks on your real Echo devices
    without affecting the production skill currently undergoing Amazon certification.

.PARAMETER BaseUrl
    Audiobookshelf public HTTPS base URL. If omitted, automatically copied from production Lambda.

.PARAMETER ApiKey
    Audiobookshelf API token / key. If omitted, automatically copied from production Lambda.

.PARAMETER InvocationNameDe
    German invocation name. Default: "mein testregal".

.PARAMETER InvocationNameEn
    English invocation name. Default: "my test bookshelf".

.EXAMPLE
    .\scripts\deploy-dev.ps1
#>

[CmdletBinding()]
param(
    [string]$BaseUrl,
    [string]$ApiKey,
    [string]$FunctionName = "audiobookshelf-alexa-dev",
    [string]$Region = "us-east-1",
    [string]$InvocationNameDe = "mein testregal",
    [string]$InvocationNameEn = "my test bookshelf"
)

$ErrorActionPreference = "Stop"

# Auto-add AWS CLI and Node to PATH
$pathsToAdd = @(
    "C:\Program Files\Amazon\AWSCLIV2",
    "C:\Program Files\nodejs",
    (Join-Path $env:APPDATA "npm")
)
foreach ($p in $pathsToAdd) {
    if ((Test-Path $p) -and ($env:PATH -notlike "*$p*")) {
        $env:PATH = "$p;$env:PATH"
    }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$DevResourcesPath = Join-Path $ProjectRoot "ask-resources.dev.json"
$SkillPackagePath = Join-Path $ProjectRoot "skill-package"
$DeModelPath = Join-Path $SkillPackagePath "interactionModels\custom\de-DE.json"
$EnModelPath = Join-Path $SkillPackagePath "interactionModels\custom\en-US.json"
$SkillManifestPath = Join-Path $SkillPackagePath "skill.json"
$ZipPath = Join-Path $ProjectRoot "audiobookshelf-alexa.zip"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Audiobookshelf Alexa Skill - DEV CLONE DEPLOYMENT TOOL  " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check AWS & ASK CLIs
Write-Host "[1/7] Verifying CLI tools and authentication..." -ForegroundColor Yellow

if (-not (Get-Command "aws" -ErrorAction SilentlyContinue)) {
    Write-Error "AWS CLI ('aws.exe') not found in PATH."
    exit 1
}

$askCmd = "ask"
$askFound = $false
try {
    $testAsk = & ask --version 2>$null
    if ($testAsk) { $askFound = $true }
} catch {}

if (-not $askFound) {
    $npmAsk = Join-Path $env:APPDATA "npm\ask.cmd"
    if (Test-Path $npmAsk) {
        $askCmd = $npmAsk
        $askFound = $true
    }
}

if (-not $askFound) {
    Write-Error "ASK CLI ('ask') not found. Please run 'npm install -g ask-cli'."
    exit 1
}

try {
    $caller = aws sts get-caller-identity --output json | ConvertFrom-Json
    Write-Host "--> AWS Authenticated as: $($caller.Arn)" -ForegroundColor Green
} catch {
    Write-Error "AWS credentials invalid or expired. Please configure 'aws configure'."
    exit 1
}

$vendorListRaw = & $askCmd smapi get-vendor-list 2>&1
if ($LASTEXITCODE -ne 0 -or $vendorListRaw -match "Please run 'ask configure'") {
    Write-Error "ASK CLI is not configured! Please run 'ask configure'."
    exit 1
}
$vendorId = ($vendorListRaw | ConvertFrom-Json).vendors[0].id
Write-Host "--> ASK CLI Authenticated for Vendor ID: $vendorId" -ForegroundColor Green

# 2. Get environment configuration (from params or copy from prod Lambda)
Write-Host "`n[2/7] Resolving Audiobookshelf configuration..." -ForegroundColor Yellow
if (-not $BaseUrl -or -not $ApiKey) {
    try {
        $prodConfig = aws lambda get-function-configuration --function-name "audiobookshelf-alexa" --region $Region --output json 2>$null | ConvertFrom-Json
        if ($prodConfig -and $prodConfig.Environment -and $prodConfig.Environment.Variables) {
            if (-not $BaseUrl) { $BaseUrl = $prodConfig.Environment.Variables.ABS_BASE_URL }
            if (-not $ApiKey) { $ApiKey = $prodConfig.Environment.Variables.ABS_API_KEY }
            Write-Host "--> Reusing ABS settings from production Lambda: $BaseUrl" -ForegroundColor Green
        }
    } catch {}
}

if (-not $BaseUrl -or -not $ApiKey) {
    Write-Error "BaseUrl and ApiKey must be provided if production Lambda is not configured."
    exit 1
}

# 3. Build ZIP package
Write-Host "`n[3/7] Building Lambda deployment package..." -ForegroundColor Yellow
& "$ScriptDir\build-package.ps1"
if (-not (Test-Path $ZipPath)) {
    Write-Error "ZIP package build failed."
    exit 1
}

# 4. Deploy Dev Lambda function
Write-Host "`n[4/7] Deploying Lambda function '$FunctionName' in '$Region'..." -ForegroundColor Yellow
$roleArn = "arn:aws:iam::397379264657:role/audiobookshelf-alexa-role"
$envVars = "ABS_BASE_URL=$BaseUrl,ABS_API_KEY=$ApiKey,ALLOW_ENV_FALLBACK=true"

$devFuncArn = $null
$funcExists = $false
try {
    $fJson = aws lambda get-function --function-name $FunctionName --region $Region --output json 2>$null
    if ($fJson) { $funcExists = $true }
} catch {
    $funcExists = $false
}

if (-not $funcExists) {
    Write-Host "--> Creating new Dev Lambda function..." -ForegroundColor Yellow
    $createJson = aws lambda create-function `
        --function-name $FunctionName `
        --runtime "nodejs22.x" `
        --role $roleArn `
        --handler "index.handler" `
        --zip-file "fileb://$ZipPath" `
        --timeout 30 `
        --region $Region `
        --environment "Variables={$envVars}" `
        --output json | ConvertFrom-Json
    $devFuncArn = $createJson.FunctionArn
    Write-Host "--> Dev Lambda created: $devFuncArn" -ForegroundColor Green
} else {
    Write-Host "--> Updating existing Dev Lambda function..." -ForegroundColor Yellow
    aws lambda update-function-code `
        --function-name $FunctionName `
        --zip-file "fileb://$ZipPath" `
        --region $Region `
        --output json | Out-Null

    aws lambda wait function-updated --function-name $FunctionName --region $Region

    $updConfig = aws lambda update-function-configuration `
        --function-name $FunctionName `
        --timeout 30 `
        --environment "Variables={$envVars}" `
        --region $Region `
        --output json | ConvertFrom-Json
    $devFuncArn = $updConfig.FunctionArn
    Write-Host "--> Dev Lambda updated: $devFuncArn" -ForegroundColor Green
}

# Add ASK trigger permission
try {
    aws lambda add-permission `
        --function-name $FunctionName `
        --statement-id "alexa-skills-kit-dev-permission" `
        --action "lambda:InvokeFunction" `
        --principal "alexa-appkit.amazon.com" `
        --region $Region `
        --output json 2>$null | Out-Null
} catch {}

# Create/Ensure Lambda Function URL (for ABS webhooks)
$funcUrl = $null
try {
    $urlObj = aws lambda get-function-url-config --function-name $FunctionName --region $Region --output json 2>$null | ConvertFrom-Json
    $funcUrl = $urlObj.FunctionUrl
} catch {
    Write-Host "--> Creating Lambda Function URL for webhooks..." -ForegroundColor Yellow
    $urlObj = aws lambda create-function-url-config --function-name $FunctionName --auth-type NONE --region $Region --output json | ConvertFrom-Json
    $funcUrl = $urlObj.FunctionUrl

    # Grant public access to Function URL
    aws lambda add-permission `
        --function-name $FunctionName `
        --statement-id "FunctionURLAllowPublicAccess" `
        --action "lambda:InvokeFunctionUrl" `
        --principal "*" `
        --function-url-auth-type NONE `
        --region $Region `
        --output json 2>$null | Out-Null
}
Write-Host "--> Dev Webhook Function URL: ${funcUrl}webhook" -ForegroundColor Green

# 5. Check or Create Dev Skill via SMAPI
Write-Host "`n[5/7] Checking Dev Skill registration..." -ForegroundColor Yellow
$devSkillId = $null

if (Test-Path $DevResourcesPath) {
    try {
        $devRes = Get-Content $DevResourcesPath -Raw | ConvertFrom-Json
        if ($devRes.skillId) { $devSkillId = $devRes.skillId }
    } catch {}
}

if (-not $devSkillId) {
    # Check if a skill with name "Bücherregal Dev" already exists on the vendor account
    try {
        $existingSkills = & $askCmd smapi list-skills-for-vendor | ConvertFrom-Json
        foreach ($sk in $existingSkills.skills) {
            if ($sk.nameByLocale.'de-DE' -eq "Bücherregal Dev" -or $sk.nameByLocale.'en-US' -eq "Bookshelf Dev") {
                $devSkillId = $sk.skillId
                Write-Host "--> Found existing Dev Skill on account: $devSkillId" -ForegroundColor Green
                break
            }
        }
    } catch {}
}

# Prepare Dev Manifest
$prodManifestObj = Get-Content $SkillManifestPath -Raw | ConvertFrom-Json
$devManifestObj = $prodManifestObj

# Customize names and endpoints for Dev
$devManifestObj.manifest.publishingInformation.locales.'de-DE'.name = "Bücherregal Dev"
$devManifestObj.manifest.publishingInformation.locales.'de-DE'.summary = "Dev-Version zum Testen neuer Features."
$devManifestObj.manifest.publishingInformation.locales.'en-US'.name = "Bookshelf Dev"
$devManifestObj.manifest.publishingInformation.locales.'en-US'.summary = "Dev version for testing new features."

$devManifestObj.manifest.apis.custom.endpoint = @{ uri = $devFuncArn }
if ($devManifestObj.manifest.events) {
    $devManifestObj.manifest.events.endpoint = @{ uri = $devFuncArn }
}

$tempManifestFile = [System.IO.Path]::GetTempFileName()
$devManifestObj | ConvertTo-Json -Depth 10 | Set-Content -Path $tempManifestFile -Encoding utf8

try {
    if (-not $devSkillId) {
        Write-Host "--> Creating new Dev Skill in Alexa Developer Console..." -ForegroundColor Yellow
        $createSkillRaw = & $askCmd smapi create-skill-for-vendor --manifest "file:$tempManifestFile" 2>&1
        $jsonOnly = ($createSkillRaw | Where-Object { $_ -notmatch '^\[' }) -join "`n"
        $createSkillObj = $jsonOnly | ConvertFrom-Json
        $devSkillId = $createSkillObj.skillId
        Write-Host "--> Created Dev Skill ID: $devSkillId" -ForegroundColor Green
    } else {
        Write-Host "--> Updating Dev Skill Manifest ($devSkillId)..." -ForegroundColor Yellow
        & $askCmd smapi update-skill-manifest -s $devSkillId -g development --manifest "file:$tempManifestFile" | Out-Null
    }
} finally {
    Remove-Item $tempManifestFile -Force -ErrorAction SilentlyContinue
}

# Save Dev Skill ID to ask-resources.dev.json
@{ skillId = $devSkillId; functionName = $FunctionName; functionArn = $devFuncArn } | ConvertTo-Json | Set-Content -Path $DevResourcesPath -Encoding utf8

# 6. Upload Custom Interaction Models with Dev Invocation Names
Write-Host "`n[6/7] Uploading Interaction Models with Dev Invocation Names..." -ForegroundColor Yellow

# German model with "mein testregal"
$deModelObj = Get-Content $DeModelPath -Raw | ConvertFrom-Json
$deModelObj.interactionModel.languageModel.invocationName = $InvocationNameDe
$tempDeFile = [System.IO.Path]::GetTempFileName()
$deModelObj | ConvertTo-Json -Depth 10 | Set-Content -Path $tempDeFile -Encoding utf8

try {
    Write-Host "--> Uploading de-DE model (Invocation: '$InvocationNameDe')..." -ForegroundColor Cyan
    & $askCmd smapi set-interaction-model -s $devSkillId -g development -l de-DE --interaction-model "file:$tempDeFile" | Out-Null
} finally {
    Remove-Item $tempDeFile -Force -ErrorAction SilentlyContinue
}

# English model with "my test bookshelf"
$enModelObj = Get-Content $EnModelPath -Raw | ConvertFrom-Json
$enModelObj.interactionModel.languageModel.invocationName = $InvocationNameEn
$tempEnFile = [System.IO.Path]::GetTempFileName()
$enModelObj | ConvertTo-Json -Depth 10 | Set-Content -Path $tempEnFile -Encoding utf8

try {
    Write-Host "--> Uploading en-US model (Invocation: '$InvocationNameEn')..." -ForegroundColor Cyan
    & $askCmd smapi set-interaction-model -s $devSkillId -g development -l en-US --interaction-model "file:$tempEnFile" | Out-Null
} finally {
    Remove-Item $tempEnFile -Force -ErrorAction SilentlyContinue
}

# 6b. Deploy Account Linking for Dev Skill
if ($funcUrl) {
    Write-Host "`n[*] Configuring Account Linking for Dev Skill..." -ForegroundColor Cyan
    $baseUrlClean = $funcUrl.TrimEnd('/')
    $devAccountLinking = @{
        accountLinkingRequest = @{
            type = "AUTH_CODE"
            authorizationUrl = "$baseUrlClean/auth"
            accessTokenUrl = "$baseUrlClean/token"
            clientId = "audiobookshelf-alexa"
            clientSecret = "audiobookshelf-secret-2026"
            accessTokenScheme = "REQUEST_BODY_CREDENTIALS"
            defaultTokenExpirationInSeconds = 315360000
            skipOnEnablement = $true
            domains = @(
                ([System.Uri]$baseUrlClean).Host,
                "raw.githubusercontent.com"
            )
            scopes = @()
        }
    }
    $tempAlFile = [System.IO.Path]::GetTempFileName()
    $devAccountLinking | ConvertTo-Json -Depth 10 | Set-Content -Path $tempAlFile -Encoding utf8
    try {
        & $askCmd smapi update-account-linking-info -s $devSkillId -g development --account-linking-request "file:$tempAlFile" | Out-Null
        Write-Host "--> Account Linking successfully configured (Function URL: $baseUrlClean)!" -ForegroundColor Green
    } catch {
        Write-Warning "Failed to update Account Linking: $_"
    } finally {
        Remove-Item $tempAlFile -Force -ErrorAction SilentlyContinue
    }
}

# 7. Wait for Model Build & Enable Testing
Write-Host "`n[7/7] Waiting for interaction model build..." -ForegroundColor Yellow
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 5
    $statusJson = & $askCmd smapi get-skill-status -s $devSkillId 2>$null
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
                Write-Error "Model build failed: $statusJson"
                exit 1
            }
        } catch {}
    }
}

# Enable skill for testing on dev's Amazon account
try {
    & $askCmd smapi set-skill-enablement -s $devSkillId -g development 2>$null | Out-Null
    Write-Host "--> Dev Skill enabled for your Echo devices!" -ForegroundColor Green
} catch {}

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "  DEV SKILL DEPLOYMENT COMPLETE & READY FOR TESTING!      " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  Skill Name:       Bücherregal Dev" -ForegroundColor White
Write-Host "  Skill ID:         $devSkillId" -ForegroundColor Yellow
Write-Host "  Lambda Function:  $FunctionName" -ForegroundColor White
Write-Host "  Lambda ARN:       $devFuncArn" -ForegroundColor DarkGray
Write-Host "  Webhook URL:      ${funcUrl}webhook" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Sprachbefehle zum Testen auf deinen Echos:" -ForegroundColor White
Write-Host "  • 'Alexa, öffne $InvocationNameDe'" -ForegroundColor Green
Write-Host "  • 'Alexa, frage $InvocationNameDe was gibt es Neues'" -ForegroundColor Green
Write-Host "  • 'Alexa, sage $InvocationNameDe mache weiter'" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
