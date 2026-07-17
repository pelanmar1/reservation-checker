param(
  [Parameter(Mandatory = $true)]
  [string]$ResourceGroup,

  [Parameter(Mandatory = $false)]
  [string]$Location = "eastus",

  [Parameter(Mandatory = $true)]
  [string]$AppName,

  [Parameter(Mandatory = $false)]
  [string]$PlanName = "asp-reservation-watcher",

  [Parameter(Mandatory = $false)]
  [string]$Sku = "B1",

  [Parameter(Mandatory = $false)]
  [string]$Runtime = "NODE|20-lts",

  [Parameter(Mandatory = $false)]
  [string]$Timezone = "America/Mexico_City",

  [Parameter(Mandatory = $false)]
  [int]$CheckIntervalMinutes = 5,

  [Parameter(Mandatory = $false)]
  [int]$PartySize = 2,

  [Parameter(Mandatory = $false)]
  [int]$NotifyCooldownMinutes = 60,

  [Parameter(Mandatory = $false)]
  [string]$UnavailableClasses = "complete,close_date",

  [Parameter(Mandatory = $false)]
  [string]$RestaurantUrl = "https://restaurante.covermanager.com/mantequilla-social-club/",

  [Parameter(Mandatory = $false)]
  [string]$SmtpHost,

  [Parameter(Mandatory = $false)]
  [int]$SmtpPort = 587,

  [Parameter(Mandatory = $false)]
  [string]$SmtpSecure = "false",

  [Parameter(Mandatory = $false)]
  [string]$SmtpUser,

  [Parameter(Mandatory = $false)]
  [string]$SmtpPass,

  [Parameter(Mandatory = $false)]
  [string]$AlertFrom,

  [Parameter(Mandatory = $false)]
  [string]$SubscriptionId
)

$ErrorActionPreference = "Stop"

function Invoke-AzCli {
  param([string]$Command)
  Write-Host "`n> $Command" -ForegroundColor Cyan
  Invoke-Expression $Command
}

if ($SubscriptionId) {
  Invoke-AzCli "az account set --subscription \"$SubscriptionId\""
}

$account = az account show --query "{subscription:id,name:name,user:user.name}" -o json | ConvertFrom-Json
Write-Host "Using subscription: $($account.name) ($($account.subscription))" -ForegroundColor Green
Write-Host "Signed in as: $($account.user)" -ForegroundColor Green

Invoke-AzCli "az group create --name \"$ResourceGroup\" --location \"$Location\""
Invoke-AzCli "az appservice plan create --name \"$PlanName\" --resource-group \"$ResourceGroup\" --sku \"$Sku\" --is-linux"
Invoke-AzCli "az webapp create --name \"$AppName\" --resource-group \"$ResourceGroup\" --plan \"$PlanName\" --runtime \"$Runtime\""

# Always On is required so periodic checks continue in the background.
Invoke-AzCli "az webapp config set --name \"$AppName\" --resource-group \"$ResourceGroup\" --always-on true"

$coreSettings = @(
  "SCM_DO_BUILD_DURING_DEPLOYMENT=true",
  "RESTAURANT_URL=$RestaurantUrl",
  "CHECK_INTERVAL_MINUTES=$CheckIntervalMinutes",
  "TIMEZONE=$Timezone",
  "PARTY_SIZE=$PartySize",
  "UNAVAILABLE_CLASSES=$UnavailableClasses",
  "NOTIFY_COOLDOWN_MINUTES=$NotifyCooldownMinutes"
)

Invoke-AzCli "az webapp config appsettings set --name \"$AppName\" --resource-group \"$ResourceGroup\" --settings $($coreSettings -join ' ')"

$hasSmtp = $SmtpHost -and $SmtpUser -and $SmtpPass -and $AlertFrom
if ($hasSmtp) {
  $smtpSettings = @(
    "SMTP_HOST=$SmtpHost",
    "SMTP_PORT=$SmtpPort",
    "SMTP_SECURE=$SmtpSecure",
    "SMTP_USER=$SmtpUser",
    "SMTP_PASS=$SmtpPass",
    "ALERT_FROM=$AlertFrom"
  )
  Invoke-AzCli "az webapp config appsettings set --name \"$AppName\" --resource-group \"$ResourceGroup\" --settings $($smtpSettings -join ' ')"
} else {
  Write-Host "SMTP settings were not fully supplied. Configure them later before expecting email notifications." -ForegroundColor Yellow
}

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  Invoke-AzCli "az webapp up --name \"$AppName\" --resource-group \"$ResourceGroup\" --runtime \"$Runtime\""
} finally {
  Pop-Location
}

$defaultHost = az webapp show --name "$AppName" --resource-group "$ResourceGroup" --query defaultHostName -o tsv
Write-Host "`nDeployment complete." -ForegroundColor Green
Write-Host "App URL: https://$defaultHost" -ForegroundColor Green
Write-Host "Open the site, set date range + destination email, then save the watch." -ForegroundColor Green
