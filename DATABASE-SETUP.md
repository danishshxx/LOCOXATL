# LOCOXATL — MySQL Setup Guide

The storefront runs without a database. Orders are only persisted when MySQL is
configured; when it is not, checkout reports the failure inline and keeps the design and the
typed details in browser `localStorage` so the customer can retry. No order number is ever
generated client side.

## 1. Requirements

| Item | Version |
|---|---|
| MySQL | 8.0 or newer (MariaDB 10.4+ also works) |
| Node.js | 18 or newer (the preview server uses `node:http`) |
| Node packages | `mysql2` and `exceljs` (`npm install` installs both) |

The 3D customizer needs no database and no extra dependency.

## 2. Select the existing database and initialize its tables

For local Laragon, create `locoxatl` once if it does not already exist:
```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS locoxatl CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
```

Railway's MySQL service already provides its `railway` database. Do not create another
database there. Apply the base schema only after selecting the desired existing database:

```bash
mysql -u root -p locoxatl < database/schema.sql
```

`database/schema.sql` creates the application tables with `CREATE TABLE IF NOT EXISTS`;
it never creates or switches databases. The migration command also applies this base
schema to the database selected by `DB_NAME` before applying additive changes.

The additive migrations are append-only and idempotent. Apply them **in order** on an
existing database, or just run `npm run db:migrate`, which applies all of them:

| File | Adds |
|---|---|
| `database/migrations/001_admin_dashboard.sql` | Admin columns on `orders`, `order_status_history`, `admin_users`, `admin_sessions` |
| `database/migrations/002_cashbook.sql` | `cashbook_categories`, `cashbook_entries` |
| `database/migrations/003_catalog_groups.sql` | `catalog_groups`, cashbook reversal pointer, `Order Refunds` category, drops the obsolete one-income-per-order key |
| `database/migrations/004_catalog_group_images.sql` | `catalog_groups.image_url` |

`003` supersedes part of `002`'s original definition: it drops
`uq_cashbook_order_entry_type` so a refunded order can be verified again. Because
`fk_cashbook_order` borrows that composite key as its only index on `order_id`, `003` first
adds `idx_cashbook_order (order_id)` and only then drops the key — otherwise MariaDB aborts
with `Cannot drop index ... needed in a foreign key constraint`. Applying `002` alone is not
enough — always finish with `003` and `004`.

The base schema includes:

| Table | Purpose |
|---|---|
| `orders` | One row per order: customer, total, status, timestamps |
| `order_items` | Line items of an order (product name, quantity, unit price, subtotal) |
| `customizer_configurations` | JSON snapshot of the 3D configuration for each line item |

The JSON column stores the same structure the Custom Studio sends to checkout:

```json
{
  "configuration": {
    "base": { "id": "heart", "name": "Cloud Heart" },
    "addons": [{ "id": "pearl", "name": "Pearl drop" }],
    "initial": "A",
    "clasp": { "id": "silver", "name": "Silver clasp" },
    "components": [
      {
        "id": "base",
        "name": "Base charm",
        "type": "base",
        "finish": "acrylic",
        "visible": true,
        "original": { "position": [0, 0, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },
        "current": { "position": [0, 0, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] }
      }
    ]
  },
  "product": "blackpink-cloud-heart"
}
```

## 3. Create a dedicated database user

```sql
CREATE USER 'locoxatl'@'localhost' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT SELECT, INSERT, UPDATE ON locoxatl.* TO 'locoxatl'@'localhost';
FLUSH PRIVILEGES;
```

The application runtime needs `SELECT`, `INSERT` and `UPDATE`. The one-time migration
command additionally needs the MySQL privileges required for `CREATE TABLE` and `ALTER
TABLE`; keep those privileges separate from the runtime account where practical.

## 4. Configure the application

```bash
cp .env.example .env
```

Then edit `.env`:

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DB_HOST` | yes | — | MySQL host, e.g. `127.0.0.1` |
| `DB_PORT` | no | `3306` | MySQL port |
| `DB_USER` | yes | — | Database user |
| `DB_PASSWORD` | no | empty | Database password |
| `DB_NAME` | yes | — | Database name (`locoxatl`) |
| `DB_CONNECTION_LIMIT` | no | `5` | Pool size |
| `PORT` | no | `4173` | Preview server port |
| `OPEN_BROWSER` | no | unset | `1` opens the browser on start |

`.env` is read by `src/server/env.js` and is never sent to the browser. The file is
listed in `.gitignore`; credentials live only on the server.

Start the server:

```bash
npm start
```

The startup log prints one of:

```
MySQL orders API: connected.
MySQL orders API: not configured. Copy .env.example to .env to enable order persistence.
MySQL orders API: connection failed (<reason>).
```

### Railway production variables

For service `locoxatl-app` in the `production` environment, add these variables.
Railway's MySQL service exposes the referenced values internally; do not use a public
TCP proxy address for app-to-database connections:

```text
NODE_ENV=production
DB_HOST=${{MySQL.MYSQLHOST}}
DB_PORT=${{MySQL.MYSQLPORT}}
DB_USER=${{MySQL.MYSQLUSER}}
DB_PASSWORD=${{MySQL.MYSQLPASSWORD}}
DB_NAME=${{MySQL.MYSQLDATABASE}}
```

For the stated Railway service, `MYSQLDATABASE` is `railway`; do not override it to
`locoxatl` or create a second database.

Set `ADMIN_USERNAME` and a unique, strong `ADMIN_PASSWORD` as service secrets. Railway
sets `PORT` automatically. The server binds to `0.0.0.0` in production and to
`127.0.0.1` for local development. The Railway HTTPS proxy's `X-Forwarded-Proto`
continues to control the Secure admin-cookie attribute.

The application start command does not apply schema changes. `npm run db:migrate`
initializes missing tables in the selected database and applies additive migrations.
Local migrations are limited to `locoxatl`; production migrations are limited to
`railway` and require `CONFIRM_DB_MIGRATION=railway` for that invocation.

## 5. Verify

```bash
curl http://localhost:4173/api/health
```

On Railway, set the service healthcheck path to `/api/health`. It returns `200` only
when the configured MySQL connection responds, and `503` otherwise.

Healthy response:

```json
{ "database": { "configured": true, "connected": true, "message": "MySQL connection is healthy." }, "api": { "version": 1 } }
```

Create a real order:

```bash
curl -X POST http://localhost:4173/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customer": { "name": "Ayu Lestari", "phone": "081234567890", "email": "ayu@example.com", "address": "Jl. Merdeka No. 12, Bandung 40111" },
    "order": {
      "artist": { "slug": "blackpink" },
      "product": { "slug": "blackpink-cloud-heart" },
      "configuration": { "base": { "id": "heart" }, "addons": [{ "id": "pearl" }], "initial": "A", "clasp": { "id": "silver" }, "components": [] },
      "quantity": 1,
      "total": 58000
    }
  }'
```

Expected: `201` with `order.orderNumber`, `order.total`, and the recalculated prices.
Check the rows:

```sql
SELECT order_number, customer_name, total_amount, order_status, created_at FROM locoxatl.orders ORDER BY id DESC LIMIT 5;
SELECT product_name, quantity, unit_price, subtotal FROM locoxatl.order_items ORDER BY id DESC LIMIT 5;
SELECT JSON_EXTRACT(configuration_json, '$.configuration.initial') FROM locoxatl.customizer_configurations ORDER BY id DESC LIMIT 5;
```

## 6. API reference

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/health` | `200` when MySQL answers, `503` when not configured or unreachable |
| `GET` | `/api/public-config` | Validated WhatsApp/Instagram contact links for the storefront footer |
| `GET` | `/api/catalog` | Active catalog groups ordered by `sort_order`, plus the three product templates per group. Falls back to the bundled catalogue when MySQL is unavailable |
| `POST` | `/api/orders` | Validates, recomputes the price, writes order + item + configuration in one transaction. `201` on success, `400` on validation errors, `503` when the database is unavailable |
| `GET` | `/api/orders/:orderNumber` | Returns status, total, and product lines only; never returns customer PII or customizer data |
| `PATCH` | `/api/orders/:orderNumber/status` | Customer-side status update `waiting_for_payment → payment_confirmation_sent`; `409` for any other transition |
| `POST` | `/api/admin/auth/login` | Authenticate admin; sets an HttpOnly session cookie and returns user/expiry only. Five failures per username/IP inside 15 minutes return `429` with `Retry-After` |
| `GET` | `/api/admin/auth/verify` | Verify admin authentication status |
| `GET` | `/api/admin/metrics` | Operations overview metrics (order counts by status, verified revenue) |
| `GET` | `/api/admin/orders` | Paginated order list with `status` filter and `q` search query |
| `GET` | `/api/admin/orders/:orderNumber` | Order detail with 3D configuration snapshot, audit history, and admin notes |
| `PATCH` | `/api/admin/orders/:orderNumber/status` | Admin status transition with audit log (`waiting_for_payment`, `paid`, `in_production`, `shipped`, `completed`, `cancelled`) |
| `PATCH` | `/api/admin/orders/:orderNumber/notes` | Update internal workshop notes, shipping courier, and tracking number |
| `GET` | `/api/admin/cashbook` | Paginated effective cashbook entries with type, search, and date filters |
| `GET` | `/api/admin/cashbook/summary` | All-time balance, selected range, period summaries, and chart data |
| `GET/POST` | `/api/admin/cashbook/categories` | List or add expense categories |
| `PATCH` | `/api/admin/cashbook/categories/:id` | Activate or deactivate an expense category |
| `POST` | `/api/admin/cashbook/expenses` | Add a validated manual expense |
| `PATCH` | `/api/admin/cashbook/expenses/:id` | Append a correction record; keeps the original in history |
| `GET` | `/api/admin/cashbook/entries/:id/history` | Read the entry's immutable correction history |
| `GET` | `/api/admin/reports/summary` | Date-filtered order and cashbook totals |
| `GET` | `/api/admin/reports/export.xlsx` | Authenticated Excel workbook (`scope=summary|orders|income|expenses|cashbook`) |
| `GET` | `/api/admin/catalog/groups` | Every catalog group, including hidden ones, ordered by `sort_order` |
| `POST` | `/api/admin/catalog/groups` | Create a group; the slug is derived from the name when omitted, duplicates return `409` |
| `PATCH` | `/api/admin/catalog/groups/:id` | Update `name`, `slug`, `tagline`, `description`, `sortOrder`, or `isActive` |
| `POST` | `/api/admin/catalog/groups/:id/image` | Upload the card image (base64 data URL; PNG/JPEG/WebP, 3 MB max after the browser downscales it) |
| `DELETE` | `/api/admin/catalog/groups/:id/image` | Remove the card image and delete the stored file |

Notes:

- All SQL is parameterised; no value is interpolated into a query string.
- The order total is always recomputed server side from `src/pricing.js` + `src/options.js`
  and the catalog price of the chosen base silhouette. A tampered browser total is
  corrected, and the response sets `priceAdjusted: true`.
- Order creation uses `connection.beginTransaction()` / `commit()` / `rollback()`.
  The connection is always released.
- Order numbers look like `LX-M4Z1QA-9F3C21` and are retried on duplicate key errors.
- Verifying payment (`→ paid`) books one income entry from any unpaid status, keyed
  `order-paid:<orderId>`; cancelling a verified order appends a refund in the
  `Order Refunds` category that points back at that income through `reverses_entry_id`.
  Re-verifying after a cancellation creates the next cycle (`order-paid:<orderId>:1`).
- Public order lookups intentionally omit customer contact/address fields and configuration
  snapshots. Full private order details are available only in authenticated admin routes.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `database_unavailable` / `Missing environment variables` | `.env` incomplete | copy `.env.example`, fill `DB_HOST`, `DB_USER`, `DB_NAME` |
| `ECONNREFUSED` | MySQL not running | start the MySQL service |
| `ER_ACCESS_DENIED_ERROR` | wrong user/password or host grant | recreate the user with `'locoxatl'@'localhost'` |
| `ER_NO_SUCH_TABLE` | schema not imported | run `npm run db:migrate` against the selected database |
| `ER_BAD_DB_ERROR` | selected database missing | select the existing database; schema setup does not create one |
| Checkout shows "We could not save your order" | API returned `503` (MySQL not configured or unreachable) | check `/api/health`, fix the connection, then re-submit — the design and typed details are preserved |

## 8. Safe Additive Migration for Admin

For existing MySQL databases with customer orders:
```bash
mysql -u root -p locoxatl < database/migrations/001_admin_dashboard.sql
```
This migration is strictly additive:
- Adds `admin_notes`, `payment_verified_at`, `shipping_courier`, `tracking_number`, `shipped_at`, `completed_at` to `orders`.
- Adds `order_status_history` table for transition auditing.
- Never drops or truncates any existing orders or configurations.
- `npm run db:migrate` initializes the base schema and applies idempotent additive
  migrations to the database selected by `DB_NAME`.
- The server does not run migrations at startup. Run the migration command explicitly
  after reviewing and backing up the target database.

The migration CLI allows `DB_NAME=locoxatl` only outside production. In production it
requires `DB_NAME=railway`, Railway's `RAILWAY_PROJECT_NAME=Locoxatl`,
`RAILWAY_ENVIRONMENT_NAME=production`, and `RAILWAY_SERVICE_NAME=locoxatl-app`, plus an explicit
`CONFIRM_DB_MIGRATION=railway`. Other environment/database combinations are refused
before connecting.

After confirming the Railway database and taking a backup, run the production migration
manually inside the app service; do not add the confirmation variable as a permanent
service variable:

```bash
railway ssh --service locoxatl-app --environment production
CONFIRM_DB_MIGRATION=railway npm run db:migrate
```

This initializes the existing `railway` database from `schema.sql` and then applies
idempotent additive changes. It never issues `CREATE DATABASE`, drops tables, truncates
rows, or runs as part of `npm start`.

## 9. Cashbook and Excel reports

For an existing `locoxatl` database, configure `.env` and run:

```powershell
npm run db:migrate
npm start
```

`database/migrations/002_cashbook.sql` creates the income/expense categories and entries
tables using InnoDB, foreign keys, indexes, BIGINT IDR amounts, duplicate-income keys, and
an append-only correction chain. It does not drop, truncate, or rewrite existing orders,
items, or customizer configurations. Standard expense categories are seeded idempotently.

Income is recorded only within the transaction that changes an order from
`payment_confirmation_sent` to `paid`; repeat submissions cannot create a second income
entry. Expenses are manually recorded and edited by appending an auditable correction,
never by deleting the prior record. Totals and balances come from effective cashbook rows,
not frontend-supplied values. All accounting and report routes require an admin session;
admin mutations also validate the request Origin.

The admin Accounting section supports Today, This Week, This Month, This Year, and custom
date ranges. All exports are generated from MySQL and contain Summary, Orders, Income,
Expenses, and Cashbook worksheets.

## 10. Tests and safe MySQL integration

Run the unit/API suite:

```powershell
npm test
```

The live integration tests use two **local disposable** databases: `locoxatl_test` and
`railway_test`. The second exercises the Railway database name/connection behavior
without contacting Railway production. Create both in Laragon/MySQL, then use a test-only
account with privileges scoped to those databases. The test runner accepts loopback
hosts only and never uses `.env` database credentials as fallbacks.

```sql
CREATE DATABASE locoxatl_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE railway_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'locoxatl_test'@'localhost' IDENTIFIED BY 'use-a-dedicated-test-password';
GRANT ALL PRIVILEGES ON locoxatl_test.* TO 'locoxatl_test'@'localhost';
GRANT ALL PRIVILEGES ON railway_test.* TO 'locoxatl_test'@'localhost';
```

In PowerShell, set the dedicated local test connection variables and run:

```powershell
$env:MYSQL_TEST_DATABASE = 'locoxatl_test'
$env:MYSQL_TEST_HOST = '127.0.0.1'
$env:MYSQL_TEST_PORT = '3306'
$env:MYSQL_TEST_USER = 'locoxatl_test'
$env:MYSQL_TEST_PASSWORD = '<dedicated-test-password>'
$env:MYSQL_RAILWAY_TEST_DATABASE = 'railway_test'
$env:MYSQL_RAILWAY_TEST_HOST = '127.0.0.1'
$env:MYSQL_RAILWAY_TEST_PORT = '3306'
$env:MYSQL_RAILWAY_TEST_USER = 'locoxatl_test'
$env:MYSQL_RAILWAY_TEST_PASSWORD = '<dedicated-test-password>'
npm run test:mysql
```

The integration tests create missing base tables with `CREATE TABLE IF NOT EXISTS`, run
the migration repeatedly against both fixed local test databases, verify the selected
database name, and exercise payment income,
duplicate protection, rollback, expenses, balances, order/customizer preservation, and
Excel workbook generation, then removes only its uniquely tagged fixture rows. It never
drops or truncates either database. Without both explicit test database opt-ins, the
respective integration tests are skipped.

`npm start` starts the local server. Confirm `/api/health` reports a database connection
before treating live MySQL functionality as verified. The server stays usable for the
storefront when MySQL is unavailable, but database-backed orders and accounting will not
work.

## 11. Scope and remaining operational integrations

Included: order creation, customer checkout, payment-confirmation flow, 3D configuration snapshot,
Admin Dashboard, workshop 3D inspection, order lifecycle management, search, filtering,
status history, operational cashbook, and Excel reports.

Deliberately out of scope: automatic inventory decrement, live third-party carrier API webhooks,
automated payment gateway integration (Midtrans/Xendit), and inventory accounting.