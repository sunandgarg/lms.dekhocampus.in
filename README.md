# DekhoCampus LMS

React frontend and Node.js API for lead intake, partner delivery, CRM, reporting, and URL shortening. MySQL stores application records. Every new lead delivery writes its request and response to a private S3 archive; uploaded source files are archived before processing. Each new batch has a downloadable ZIP with its source files, transactions, and `report.csv`.

## Local development

Requirements: Node.js 20+, MySQL 8, a private S3 bucket, and AWS credentials limited to that bucket. The API binds to localhost.

```sh
npm ci
cd backend && npm ci
mysql -u root -p -e 'CREATE DATABASE lms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;'
# Create a dedicated MySQL user with permissions only on lms.
# Set DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, AWS_REGION, ARCHIVE_BUCKET and AWS credentials.
node backend/server.mjs
npm run dev
```

The backend creates its tables at startup from `backend/schema.sql`. Bootstrap the first administrator with `BOOTSTRAP_EMAIL` and `BOOTSTRAP_PASSWORD` set in the environment:

```sh
node backend/bootstrap-admin.mjs
```

Only run bootstrap once. Keep credentials out of Git. Build the frontend with `npm run build` and serve `dist/` through Nginx, proxying `/api/` to the Node service. The production deployment is on the dedicated `lms-dekhocampus-in` Lightsail instance in Mumbai; it does not share the server or database of `dekhocampus.com`.

## Operations

- Meta Instant Forms use a Meta for Developers app with Page `leadgen` Webhooks. Set its callback to the LMS Meta webhook URL and its verify token to that integration's webhook key. Set `META_APP_SECRET`, `META_ACCESS_TOKEN` (a Page token with lead retrieval access), and `META_PAGE_ID` on the Node service; then subscribe the app to the Page's `leadgen` field. For additional Pages, set `META_PAGE_TOKENS` to a JSON object mapping Page IDs to their Page tokens. If an additional Page uses a separate Meta app, also map its Page ID to that app's secret in `META_PAGE_APP_SECRETS`. Subscribe each Page to `leadgen`. The LMS verifies Meta's SHA-256 signature against the Page's app secret and accepts only configured Page IDs before fetching each lead through Graph API and storing it in All Leads. Keep app secrets and access tokens out of Git. Meta app registration, required permissions, and any app review are managed in Meta.
- In Connections, create a Generic Lead API connection. Its bearer key is shown once. POST one JSON lead to `/api/inbound/generic-lead`; send `Idempotency-Key` (or `external_id`) so provider retries do not create duplicate leads. The body needs an email or mobile; names, source, campaign, and other fields are optional. Nested provider fields can be mapped in the connection settings.
- Generic leads appear as original receipts in All Leads. Create Lead automation rules there to route every new lead or match city, state, course, source, campaign, or a custom incoming field. Multiple rules can route one lead to multiple universities. The receipt and matching partner queue jobs are committed together in MySQL, then the Node workers begin delivery immediately. The original payload is archived in S3 and downloadable as a ZIP from All Leads; destination request and response ZIPs remain in Upload History.
- Uploads are committed to the server queue before any partner request. A batch continues after the browser closes.
- The server sends at most two partner requests at once. A delivery interrupted by a server restart is marked for review to avoid an automatic duplicate send.
- Download a batch ZIP from Upload History. Source files and each transaction are read from S3; the CSV report is generated from MySQL.
- MySQL and S3 both incur storage charges as usage grows. The 2 GB swap file is on the included Lightsail disk.
- Create and manage users from the admin panel. The production database includes the application records from the November 20, 2026 backup. The original backup and pre-import MySQL snapshot are retained in the private S3 bucket under `migrations/2026-11-20/`.
- The backup contained historical batch summaries but no original uploaded CSVs, lead rows, or transaction files. ZIPs for those batches include a migration note and a summary report. New uploads archive their source files and transactions in S3.

## Checks

```sh
cd backend && npm test
cd .. && npx tsc --noEmit -p tsconfig.app.json && npm run build
```
