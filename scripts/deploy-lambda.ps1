<#
.SYNOPSIS
    Automated deployment script for Audiobookshelf Alexa Skill to AWS Lambda.

.DESCRIPTION
    Creates or updates the IAM role, Lambda function, environment variables,
    timeout settings, and Alexa Skills Kit trigger permissions using the AWS CLI.

.PARAMETER BaseUrl
    The public HTTPS URL of your Audiobookshelf server (e.g. https://abs.yourdomain.com).

.PARAMETER ApiKey
    The Audiobookshelf API token / key created in Settings -> Users -> API Keys.

.PARAMETER DefaultLibraryId
    Optional: The Audiobookshelf library ID to pin by default.

.PARAMETER Region
    AWS region. Default is 'us-east-1' (recommended for Alexa skills in DE & US).

.PARAMETER FunctionName
    Name of the Lambda function. Default is 'audiobookshelf-alexa'.

.PARAMETER SkipBuild
    Skip running build-package.ps1 before deploying.

.EXAMPLE
    .\scripts\deploy-lambda.ps1 -BaseUrl "https://abs.example.com" -ApiKey "eyJhbGc..."
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$BaseUrl = $env:ABS_BASE_URL,

    [Parameter(Mandatory = $false)]
    [string]$ApiKey = $env:ABS_API_KEY,

    [Parameter(Mandatory = $false)]
    [string]$DefaultLibraryId = $env:ABS_DEFAULT_LIBRARY_ID,

    [string]$Region = "us-east-1",
    [string]$FunctionName = "audiobookshelf-alexa",
    [string]$RoleName = "audiobookshelf-alexa-role",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

# Auto-add AWS CLI and Node to PATH if not already present
$pathsToAdd = @(
    "C:\Program Files\Amazon\AWSCLIV2",
    "C:\Program Files\nodejs"
)
foreach ($p in $pathsToAdd) {
    if ((Test-Path $p) -and ($env:PATH -notlike "*$p*")) {
        $env:PATH = "$p;$env:PATH"
    }
}

if (-not (Get-Command "aws" -ErrorAction SilentlyContinue)) {
    Write-Error "AWS CLI ('aws.exe') not found. Please verify AWS CLI is installed."
    exit 1
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$zipPath = Join-Path $repoRoot "audiobookshelf-alexa.zip"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Audiobookshelf Alexa Skill - AWS Lambda Deployment      " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Verify AWS Authentication
Write-Host "`n[1/5] Checking AWS credentials..." -ForegroundColor Yellow
try {
    $callerIdentityJson = aws sts get-caller-identity --output json 2>$null
    if (-not $callerIdentityJson) { throw "No credentials" }
    $identity = $callerIdentityJson | ConvertFrom-Json
    Write-Host "--> Authenticated as: $($identity.Arn)" -ForegroundColor Green
} catch {
    Write-Error "AWS CLI is not authenticated! Please run 'aws configure' and provide your AWS Access Key ID & Secret Access Key."
    exit 1
}

# 2. Check / Prompt for Audiobookshelf parameters
if (-not $BaseUrl) {
    $BaseUrl = Read-Host "Enter your Audiobookshelf base URL (e.g. https://abs.example.com)"
}
$BaseUrl = $BaseUrl.Trim().TrimEnd('/')
if (-not $BaseUrl.StartsWith("https://")) {
    Write-Warning "Alexa requires a secure HTTPS URL! Entered: $BaseUrl"
}

if (-not $ApiKey) {
    $ApiKey = Read-Host "Enter your Audiobookshelf API key (JWT token)"
}
$ApiKey = $ApiKey.Trim()

if (-not $BaseUrl -or -not $ApiKey) {
    Write-Error "BaseUrl and ApiKey are required for Audiobookshelf connection."
    exit 1
}

# 3. Ensure deployment ZIP exists
if (-not $SkipBuild -or -not (Test-Path $zipPath)) {
    Write-Host "`n[2/5] Building Lambda deployment package..." -ForegroundColor Yellow
    & "$PSScriptRoot\build-package.ps1"
} else {
    Write-Host "`n[2/5] Using existing package at $zipPath" -ForegroundColor DarkGray
}

if (-not (Test-Path $zipPath)) {
    Write-Error "ZIP package not found at $zipPath"
    exit 1
}

# 4. Check or Create IAM Role for Lambda
Write-Host "`n[3/5] Checking IAM Execution Role '$RoleName'..." -ForegroundColor Yellow
$roleArn = $null
try {
    $roleJson = aws iam get-role --role-name $RoleName --output json 2>$null
    if ($roleJson) {
        $roleObj = $roleJson | ConvertFrom-Json
        $roleArn = $roleObj.Role.Arn
        Write-Host "--> Found existing IAM Role: $roleArn" -ForegroundColor Green
    }
} catch {
    $roleArn = $null
}

if (-not $roleArn) {
    Write-Host "--> Creating IAM Role '$RoleName'..." -ForegroundColor Yellow
    $trustPolicy = @'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
'@
    $tempPolicyFile = [System.IO.Path]::GetTempFileName()
    Set-Content -Path $tempPolicyFile -Value $trustPolicy -Encoding utf8

    try {
        $newRoleJson = aws iam create-role --role-name $RoleName --assume-role-policy-document "file://$tempPolicyFile" --output json
        $newRoleObj = $newRoleJson | ConvertFrom-Json
        $roleArn = $newRoleObj.Role.Arn

        # Attach basic execution policy
        aws iam attach-role-policy --role-name $RoleName --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        Write-Host "--> Created IAM Role: $roleArn" -ForegroundColor Green
        Write-Host "--> Waiting 10s for IAM role replication across AWS regions..." -ForegroundColor DarkGray
        Start-Sleep -Seconds 10
    } finally {
        Remove-Item $tempPolicyFile -Force -ErrorAction SilentlyContinue
    }
}

# 5. Create or Update Lambda Function
Write-Host "`n[4/5] Deploying Lambda function '$FunctionName' in '$Region'..." -ForegroundColor Yellow

# Build environment variables string
$envVars = "ABS_BASE_URL=$BaseUrl,ABS_API_KEY=$ApiKey"
if ($DefaultLibraryId) {
    $envVars += ",ABS_DEFAULT_LIBRARY_ID=$DefaultLibraryId"
}

$functionExists = $false
try {
    $funcJson = aws lambda get-function --function-name $FunctionName --region $Region --output json 2>$null
    if ($funcJson) { $functionExists = $true }
} catch {
    $functionExists = $false
}

$functionArn = $null
if (-not $functionExists) {
    Write-Host "--> Creating new Lambda function..." -ForegroundColor Yellow
    $createJson = aws lambda create-function `
        --function-name $FunctionName `
        --runtime "nodejs22.x" `
        --role $roleArn `
        --handler "index.handler" `
        --zip-file "fileb://$zipPath" `
        --timeout 10 `
        --region $Region `
        --environment "Variables={$envVars}" `
        --output json
    $funcObj = $createJson | ConvertFrom-Json
    $functionArn = $funcObj.FunctionArn
    Write-Host "--> Lambda function created successfully!" -ForegroundColor Green
} else {
    Write-Host "--> Function exists. Updating code and configuration..." -ForegroundColor Yellow
    aws lambda update-function-code `
        --function-name $FunctionName `
        --zip-file "fileb://$zipPath" `
        --region $Region `
        --output json | Out-Null

    # Wait until update is active
    aws lambda wait function-updated --function-name $FunctionName --region $Region

    $updateConfigJson = aws lambda update-function-configuration `
        --function-name $FunctionName `
        --timeout 10 `
        --environment "Variables={$envVars}" `
        --region $Region `
        --output json
    $funcObj = $updateConfigJson | ConvertFrom-Json
    $functionArn = $funcObj.FunctionArn
    Write-Host "--> Lambda code and configuration updated successfully!" -ForegroundColor Green
}

# 6. Add Alexa Skills Kit trigger permission
Write-Host "`n[5/5] Configuring Alexa Skills Kit trigger..." -ForegroundColor Yellow
try {
    aws lambda add-permission `
        --function-name $FunctionName `
        --statement-id "alexa-skills-kit-permission" `
        --action "lambda:InvokeFunction" `
        --principal "alexa-appkit.amazon.com" `
        --region $Region `
        --output json 2>$null | Out-Null
    Write-Host "--> Alexa Skills Kit invocation permission granted." -ForegroundColor Green
} catch {
    Write-Host "--> Alexa Skills Kit permission already configured." -ForegroundColor DarkGray
}

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "  DEPLOYMENT SUCCESSFUL!                                  " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  Function Name: $FunctionName" -ForegroundColor White
Write-Host "  Region:        $Region" -ForegroundColor White
Write-Host "  Function ARN:  $functionArn" -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "`nNext Step in Alexa Developer Console (https://developer.amazon.com/alexa/console/ask):" -ForegroundColor Cyan
Write-Host "1. Go to your skill -> Endpoint -> AWS Lambda ARN." -ForegroundColor White
Write-Host "2. Paste the Function ARN above into Default Region." -ForegroundColor White
Write-Host "3. Save Endpoints." -ForegroundColor White
