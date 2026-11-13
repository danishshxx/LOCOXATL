# LOCOXATL — MySQL Setup Guide

The storefront runs without a database. Orders are only persisted when MySQL is
configured; when it is not, the checkout still completes and the order stays in browser
`localStorage` with `persistence.mode = "local-demo"`.

## 1. Requirements

| Item | Version |
|---|---|
| MySQL | 8.0 or newer (MariaDB 10.4+ also works) |
| Node.js | 18 or newer (the preview server uses `node:http`) |
| Node packages | `mysql2` and `exceljs` (`npm install` installs both) |

The 3D customizer needs no database and no extra dependency.

## 2. Create the database

```bash
mysql -u root -p < database/schema.sql
```

The script creates the `locoxatl` database (utf8mb4) and three tables:

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

Only `SELECT`, `INSERT` and `UPDATE` are needed: orders are created, read back, and
their status is updated. Nothing in the application deletes rows.

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

## 5. Verify

```bash
curl http://localhost:4173/api/health
```

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
| `POST` | `/api/orders` | Validates, recomputes the price, writes order + item + configuration in one transaction. `201` on success, `400` on validation errors, `503` when the database is unavailable |
| `GET` | `/api/orders/:orderNumber` | Returns status, total, and product lines only; never returns customer PII or customizer data |
| `PATCH` | `/api/orders/:orderNumber/status` | Customer-side status update `waiting_for_payment → payment_confirmation_sent`; `409` for any other transition |
| `POST` | `/api/admin/auth/login` | Authenticate admin; sets an HttpOnly session cookie and returns user/expiry only |
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

Notes:

- All SQL is parameterised; no value is interpolated into a query string.
- The order total is always recomputed server side from `src/pricing.js` + `src/options.js`
  and the catalog price of the chosen base silhouette. A tampered browser total is
  corrected, and the response sets `priceAdjusted: true`.
- Order creation uses `connection.beginTransaction()` / `commit()` / `rollback()`.
  The connection is always released.
- Order numbers look like `LX-M4Z1QA-9F3C21` and are retried on duplicate key errors.
- Public order lookups intentionally omit customer contact/address fields and configuration
  snapshots. Full private order details are available only in authenticated admin routes.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `database_unavailable` / `Missing environment variables` | `.env` incomplete | copy `.env.example`, fill `DB_HOST`, `DB_USER`, `DB_NAME` |
| `ECONNREFUSED` | MySQL not running | start the MySQL service |
| `ER_ACCESS_DENIED_ERROR` | wrong user/password or host grant | recreate the user with `'locoxatl'@'localhost'` |
| `ER_NO_SUCH_TABLE` | schema not imported | `mysql -u root -p < database/schema.sql` |
| `ER_BAD_DB_ERROR` | database missing | run the schema script (it creates the database) |
| Checkout stays in `local-demo` mode | API returned 503 | check `/api/health`, then re-submit the order |

## 8. Safe Additive Migration for Admin

For existing MySQL databases with customer orders:
```bash
mysql -u root -p locoxatl < database/migrations/001_admin_dashboard.sql
```
This migration is strictly additive:
- Adds `admin_notes`, `payment_verified_at`, `shipping_courier`, `tracking_number`, `shipped_at`, `completed_at` to `orders`.
- Adds `order_status_history` table for transition auditing.
- Never drops or truncates any existing orders or configurations.
- `npm run db:migrate` applies the idempotent additive migrations to the configured
  `locoxatl` database. It refuses to run unless `DB_NAME` is exactly `locoxatl`.
- The server also attempts additive migrations on startup when MySQL is connected.

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

The live integration test requires a **separate** database named exactly
`locoxatl_test`. Create it manually in Laragon/MySQL, then create a test-only MySQL user
with privileges scoped only to that database. Never point integration settings to
`locoxatl`; the test runner refuses to use any other database name.

```sql
CREATE DATABASE locoxatl_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'locoxatl_test'@'localhost' IDENTIFIED BY 'use-a-dedicated-test-password';
GRANT ALL PRIVILEGES ON locoxatl_test.* TO 'locoxatl_test'@'localhost';
```

In PowerShell, set the dedicated test connection variables and run:

```powershell
$env:MYSQL_TEST_DATABASE = 'locoxatl_test'
$env:MYSQL_TEST_HOST = '127.0.0.1'
$env:MYSQL_TEST_PORT = '3306'
$env:MYSQL_TEST_USER = 'locoxatl_test'
$env:MYSQL_TEST_PASSWORD = '<dedicated-test-password>'
npm run test:mysql
```

The integration test creates missing base tables with `CREATE TABLE IF NOT EXISTS`, runs
the additive migration against the fixed test database, exercises payment income,
duplicate protection, rollback, expenses, balances, order/customizer preservation, and
Excel workbook generation, then removes only its uniquely tagged fixture rows. It never
drops or truncates a database. Without the explicit `MYSQL_TEST_DATABASE=locoxatl_test`
opt-in, it is reported as skipped. If `MYSQL_TEST_HOST` or `MYSQL_TEST_USER` is omitted,
the runner may reuse server connection settings from `.env`, but it always overrides the
target database to `locoxatl_test`.

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