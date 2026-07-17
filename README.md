# CoverManager Availability Watcher (Web + Scheduler)

This project provides a web UI where you configure:

- start date
- end date
- email for alerts

The app then checks CoverManager periodically and sends an email when at least one date in the range is available.

## Local setup

If you do not want any secrets in local files, skip `.env` and use environment variables in your shell session.

1. Install dependencies:

```bash
npm install
```

2. Install Playwright Chromium:

```bash
npx playwright install chromium
```

3. Create and edit env file:

```powershell
copy .env.example .env
```

4. Configure SMTP (required for email notifications):

Option A: local `.env` (quick)

Option B: shell env vars only (no secrets written to disk), for example in PowerShell:

```powershell
$env:SMTP_HOST="..."
$env:SMTP_PORT="587"
$env:SMTP_SECURE="false"
$env:SMTP_USER="..."
$env:SMTP_PASS="..."
$env:ALERT_FROM="..."
```

Required keys:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `ALERT_FROM`

5. Start the web app:

```bash
npm start
```

6. Open `http://localhost:3000`, fill the form, and click `Save watch`.

## One-shot CLI test

If you want a quick check from env values:

```bash
npm run check-once
```

## Run on GitHub Actions (free-friendly)

This repo includes a scheduled workflow at [.github/workflows/reservation-check.yml](.github/workflows/reservation-check.yml) that runs every 15 minutes and sends email when availability is found.

### 1. Configure repository Variables

In GitHub -> Settings -> Secrets and variables -> Actions -> Variables, add:

- `RESTAURANT_URL` (fixed URL)
- `START_DATE` (YYYY-MM-DD)
- `END_DATE` (YYYY-MM-DD)
- `TIMEZONE` (for example `America/Mexico_City`)
- `PARTY_SIZE` (for example `2`)
- `UNAVAILABLE_CLASSES` (for example `complete,close_date`)
- `ALERT_TO` (destination email)

### 2. Configure repository Secrets

In GitHub -> Settings -> Secrets and variables -> Actions -> Secrets, add:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `ALERT_FROM`

### 3. Run manually (optional)

Go to Actions -> `Reservation Availability Check` -> `Run workflow`.

You can optionally override date range and party size per run.

### Notes

- GitHub Actions mode does not host the web UI; config is managed in GitHub Variables/Secrets.
- The workflow sends an email only when at least one date is available.

## Deploy to Azure App Service

For Azure, prefer App Service Application Settings (or Key Vault references) instead of `.env`.

Fastest path from this repo:

```powershell
pwsh ./scripts/deploy-azure.ps1 \
  -ResourceGroup rg-reservation-watcher \
  -Location eastus \
  -PlanName asp-reservation-watcher \
  -AppName reservation-watcher-<unique> \
  -SmtpHost <smtp-host> \
  -SmtpPort 587 \
  -SmtpSecure false \
  -SmtpUser <smtp-user> \
  -SmtpPass <smtp-pass> \
  -AlertFrom <from@email.com>
```

This script will:

- create resource group + Linux app service plan + web app
- enable Always On
- set app settings
- deploy current folder with `az webapp up`

After deployment, open the app URL and configure date range + destination email in the UI.

### Secrets without `.env` (recommended)

Set SMTP values directly in App Service settings:

```bash
az webapp config appsettings set --name <app-name> --resource-group <rg> --settings \
  SMTP_HOST=<smtp-host> \
  SMTP_PORT=587 \
  SMTP_SECURE=false \
  SMTP_USER=<smtp-user> \
  SMTP_PASS=<smtp-pass> \
  ALERT_FROM=<from@email.com>
```

Optional stronger security: store SMTP secret in Key Vault and reference it from App Service settings.

If you prefer manual CLI commands, use the section below.

1. Create Azure resources (replace names):

```bash
az group create --name rg-reservation-watcher --location eastus
az appservice plan create --name asp-reservation-watcher --resource-group rg-reservation-watcher --sku B1 --is-linux
az webapp create --name reservation-watcher-<unique> --resource-group rg-reservation-watcher --plan asp-reservation-watcher --runtime "NODE|20-lts"
```

2. Enable Always On so periodic checks keep running:

```bash
az webapp config set --name reservation-watcher-<unique> --resource-group rg-reservation-watcher --always-on true
```

3. Set app settings (examples):

```bash
az webapp config appsettings set --name reservation-watcher-<unique> --resource-group rg-reservation-watcher --settings \
  CHECK_INTERVAL_MINUTES=5 \
  TIMEZONE=America/Mexico_City \
  PARTY_SIZE=2 \
  UNAVAILABLE_CLASSES=complete,close_date \
  NOTIFY_COOLDOWN_MINUTES=60 \
  SMTP_HOST=<your-smtp-host> \
  SMTP_PORT=587 \
  SMTP_SECURE=false \
  SMTP_USER=<your-smtp-user> \
  SMTP_PASS=<your-smtp-pass> \
  ALERT_FROM=<from@email.com>
```

4. Deploy code from this folder:

```bash
az webapp up --name reservation-watcher-<unique> --resource-group rg-reservation-watcher --runtime "NODE|20-lts"
```

5. Open the deployed site, set your watch, and the scheduler will run automatically.

## Notes

- Keep App Service instance count at 1 unless you add distributed locking, otherwise multiple instances can run the same periodic check.
- If CoverManager changes widget internals, selector/class rules might need updates.
- The build runs `playwright install chromium` via `postinstall` so browser automation works in App Service.
