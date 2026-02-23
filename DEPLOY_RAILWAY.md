# Deploy to Railway (No Cold Starts)

This app is already compatible with Railway. The included `railway.json` uses:

- `npm start` as the start command
- `/healthz` as the health check endpoint

## 1) Create project

1. Go to Railway and create a new project from your GitHub repo.
2. Select this folder: `weekly-checkin-tracker`.

## 2) Set environment variables

In Railway service variables, set:

- `APP_PASSWORD`
- `SHEET_ID`
- `SHEET_TAB` (optional, defaults to `Sheet1`)
- `STUDENTS_TAB` (optional, defaults to `Students`)
- `GOOGLE_SERVICE_ACCOUNT_JSON` (recommended; full JSON string of the service account)
- `GOOGLE_APPLICATION_CREDENTIALS=service-account.json` (optional fallback when using a file)

## 3) Add service account file

This app supports both secret JSON and on-disk file credentials:

- Preferred: set `GOOGLE_SERVICE_ACCOUNT_JSON` to the full JSON contents of your service account key.
- Simple: include `service-account.json` in the deploy environment (do not commit it to git).

## 4) Choose always-on plan

To avoid slow first loads, use a Railway plan/environment where the service does not sleep.

## 5) Verify

After deploy:

- Open `https://<your-domain>/healthz` and confirm it returns `{"ok":true,...}`.
- Open the app root and verify login/check-ins.
