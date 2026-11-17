# LOCOXATL — Editable Multi-Page Storefront

A responsive, monochrome, multi-page storefront for the LOCOXATL modular keychain brand. Each step of the customer journey is a separate editable HTML page with shared CSS and modular JavaScript files.

## Current technology

- Vanilla HTML pages, CSS, and browser JavaScript ES modules.
- Node.js HTTP server and API, with MySQL persistence through `mysql2`.
- Three.js for the lazy-loaded, procedural Custom Studio viewer.
- No frontend framework, bundler, or hosted database service is required.

## Active customer journey

| Step | File | Purpose |
|---|---|---|
| 1 | `index.html` | Homepage / brand introduction |
| 2 | `shop.html` | Artist and group directory |
| 3 | `artist.html?artist=<slug>` | Products for the selected artist |
| 4 | `studio.html?artist=<slug>&product=<slug>` | Custom Studio with live preview and pricing |
| 5 | `checkout.html` | Guest customer and delivery details |
| 6 | `payment.html` | QRIS instructions and WhatsApp handoff |
| 7 | `order-success.html` | Confirmation of payment notification |

**Navigation is page-to-page.** The homepage's Buy Now links to `shop.html`; each artist card links to `artist.html`; each Customize button links to `studio.html`; Custom Studio continues to checkout; checkout continues to payment.

## Run on Windows

1. Extract the ZIP completely.
2. Install Node.js LTS (18 or newer) from <https://nodejs.org/>.
3. Double-click `start-preview.bat`.
4. The preview opens in your browser. Default address is `http://localhost:4173`.

The local server automatically switches to the next available port if 4173 is occupied. This avoids accidentally opening an older preview already running on the computer. Keep the Command Prompt window open while using the site; press `Ctrl+C` to stop it.

`npm install` installs the server dependencies (`mysql2` for order persistence). The
browser-side 3D engine is vendored in `assets/vendor/three/`, so the Custom Studio needs no
build step and no bundler.

## Edit in VS Code

Open the extracted `LOCOXATL-EDITABLE-STOREFRONT` folder in VS Code. Main editable files:

- `index.html` — homepage content and brand story
- `shop.html` — artist directory cards
- `src/catalog.js` — artist and product data
- `artist.html` and `src/artist-page.js` — artist-specific product page
- `studio.html` and `src/studio.js` — customizer UI, pricing wiring, checkout payload
- `src/three/*.mjs` — procedural 3D models, materials, components and the studio scene
- `src/options.js` — add-on and clasp price table shared by the studio and the order API
- `src/server/*.js` — order validation, MySQL access and the `/api` routes
- `database/schema.sql` — MySQL schema for orders, items and configuration snapshots
- `src/pricing.js` — pricing calculation
- `checkout.html` and `src/checkout.js` — checkout form and order draft
- `payment.html` and `src/payment.js` — payment instructions and WhatsApp message
- `src/site-shell.js` — shared header, footer, mobile navigation, and reveal behavior
- `styles.css` — all typography, colors, layout, animation, and responsive styling
- `server.js` — local preview server

The old single-page HTML snapshots are in `archive/legacy-single-page/`. They are kept only as references and are not used by the active website.

## Test

```bash
npm test
```

The optional browser verification script uses `puppeteer-core` and an installed Chrome
browser. It is not a production dependency; install it when needed with
`npm install --no-save puppeteer-core`, then run `node tools/verify-studio.cjs`.
Set `CHROME_PATH` if Chrome is not at the script's Windows default. Screenshots are
temporary and are removed after the script finishes.

## Premium 3D custom studio

The Custom Studio preview is a real Three.js scene, not a flat SVG. Heart, Star and Ribbon
are extruded from the existing SVG silhouettes with beveled acrylic edges, and the product is
assembled from six independent components (base charm, connector ring, clasp, pearl drop,
mini star, initial letter). Customers can orbit, zoom, click a part to inspect it, change its
finish, hide it, and switch between exploded and assembled views. Prices, configuration
snapshots and the checkout journey are unchanged.

Three.js is lazy-loaded when the preview approaches the viewport, and the SVG preview stays
as a fallback when WebGL is unavailable. See `CUSTOMIZER-3D.md`.

## Order persistence (MySQL)

Checkout posts a structured JSON snapshot of the design to `POST /api/orders`, which stores
the order, its line item and the customizer configuration in MySQL inside a transaction.
Without a configured database the storefront still completes the journey and keeps the order
in `localStorage`.

See `DATABASE-SETUP.md` for schema import, environment variables, API reference and
verification steps.

## Customer contact links

Set `WHATSAPP_BUSINESS_NUMBER` to the official business number and `INSTAGRAM_URL` to
the official Instagram profile URL in the server environment (or local `.env`). Indonesian
numbers can be entered in local `08...` or international `+62...` format. Only validated,
public contact details are returned by `/api/public-config`; no WhatsApp API token is used.

`src/server/public-config.js` ships working defaults, so the storefront renders contact links
on a fresh clone with no `.env` at all. A real value in `process.env` always wins, and the
`.env.example` placeholders (`[ISI_NOMOR_WA_628XXX]`, `[ISI_LINK_INSTAGRAM]`) fall back to
those defaults instead of producing broken links.

Both the payment and order-success pages build their WhatsApp text from one shared template in
`src/whatsapp.js`:

```
halo kak ingin memverifikasi pembelian dan pembayaran dengan nomor order : <orderNumber>
```

The link opens a direct chat with the configured number. Customers can use **Copy Message**
as a fallback.

## Payment verification

The admin Orders view has a **Needs Payment** filter that groups `waiting_for_payment` and
`payment_confirmation_sent` orders (`GET /api/admin/orders?status=unpaid`), and unpaid rows are
flagged in the table. Opening an order exposes **Verify Payment**, which moves it to `paid`,
stamps `payment_verified_at` once, writes an `order_status_history` row, and books the income in
`cashbook_entries` — all in one transaction.

## Brand and implementation

- Font: locally hosted Inter.
- Palette: black, white, and grayscale.
- Brand assets: the team's supplied LOCOXATL wordmark and LXL mark.
- Frontend: multi-page HTML, shared CSS, classic page scripts and ES modules for the 3D viewer.
- Backend: Node.js HTTP server, API validation, and MySQL order persistence.

## Admin & Workshop Dashboard

Access the operations and workshop dashboard at:
`http://localhost:4173/admin` (or `http://localhost:4173/admin.html`)

- **Authentication**: Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the server environment. They provision an account only when `admin_users` is empty; restarting the server does not overwrite existing credentials.
- **Session security**: Login sessions use random tokens in an HttpOnly, SameSite=Strict cookie. Only a SHA-256 hash is stored in MySQL; sessions expire after eight hours. The Secure cookie attribute is enabled for HTTPS requests.
- **Request protection**: State-changing admin API requests require a same-origin `Origin` header.
- **Network access**: Local development listens on loopback; production listens on `0.0.0.0` and uses the platform's HTTPS proxy.
- **Operations Control**: KPI metrics (Total Orders, Pending Verification, Waiting Payment, In Workshop, Shipped, Revenue).
- **Orders Management**: Live search, status filter tabs, and paginated order table.
- **Workshop 3D Inspector**: Reuses Three.js Custom Studio engine to inspect the customer's exact 3D design snapshot with OrbitControls, explode view, assemble view, and full Bill of Materials (BOM).
- **Order Lifecycle**: Advance orders through `waiting_for_payment` → `payment_confirmation_sent` → `paid` → `in_production` → `shipped` → `completed` (or `cancelled`). Verifying a payment books cashbook income from any unpaid status; cancelling a verified order appends a refund that reverses it.
- **Catalog Groups**: Publish, rename, reorder and hide the storefront collections without a deploy, and give each one a card image that becomes the background of its shop card. Hidden groups leave the shop immediately but stay attached to historical orders; the storefront falls back to the bundled catalogue whenever MySQL is unavailable. Uploaded images are resized in the browser, validated server-side, and stored in `assets/uploads/catalog/` (gitignored).
- **Fulfillment & Notes**: Record internal notes, courier names, and tracking numbers with audit history logging.
- **WhatsApp Direct Action**: One-click WhatsApp link pre-filled with customer greeting and order status.
- **Accounting Cashbook**: Verified payment income, auditable expense corrections, categories, date-filtered balances, summaries, and Excel exports.

Apply database changes using `npm run db:migrate` after configuring MySQL. Locally it
only targets `locoxatl`; in production it only targets Railway's existing `railway`
database and requires `CONFIRM_DB_MIGRATION=railway`. The command initializes missing
tables and applies additive migrations. Migrations are never run by `npm start`. See
`DATABASE-SETUP.md` for cashbook APIs, reporting, and isolated `locoxatl_test` integration
instructions.

## Current prototype limitations

- QRIS is a placeholder; insert the merchant's official QRIS before launch.
- WhatsApp requires the official admin number.
- Payment status is verified by the admin in the Admin Dashboard upon checking payment proof.
- Shipping carrier rates are confirmed manually via WhatsApp and recorded in the dashboard.
- Orders are persisted in MySQL when the database is configured. Without it the checkout page shows an inline error, keeps the design snapshot and typed details in `localStorage`, and never invents an order number — the customer can retry once the connection is restored.
- Automatic inventory decrement, carrier API webhooks, and live stock reservation are planned for subsequent phases.
- The 3D models are procedural and generated in code; there are no GLB/GLTF assets yet.
- The vendored Three.js modules are unminified (about 2.1 MB total) and lazy-loaded only in
  the Custom Studio. They are unchanged from the installed Three.js version; minification
  or bundling remains a deployment optimization, not a requirement for local operation.
- Artist names are sample catalog data; use only artwork and likeness assets approved for commercial use.

See `ARCHITECTURE.md` for the current implementation and superseded architecture notes, and
`START-HERE.txt` for the quick start guide.
