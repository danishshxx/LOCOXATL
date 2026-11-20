# AGENTS.md — LOCOXATL

Read this file first. Do not scan the repository tree.

## Stack

Plain Node HTTP server (no framework) + vanilla JS pages + MySQL via `mysql2`.
Tests: `node --test` (`npm run test`). DB: `npm run db:migrate`. Run: `node server.js`.

## File map

- `server.js` (265 lines) — HTTP entry: routing, static allowlist, page serving.
- `src/server/` — backend modules, one concern per file:
  `api.js` (route table) · `db.js` (pool/query) · `auth.js` · `orders.js` ·
  `catalog.js` · `pricing` logic lives in `src/pricing.js` · `cashbook.js` ·
  `reports.js` · `uploads.js` · `validation.js` · `public-config.js` ·
  `env.js` (env loading) · `migrate.js` + `migrate-cli.js` (migrations).
- `src/` (front-end per page): `admin.js` (2923 lines) · `studio.js` (903) ·
  `checkout.js` · `shop-page.js` · `catalog.js` · `options.js` · `pricing.js` ·
  `payment.js` · `success.js` · `artist-page.js` · `site-shell.js` · `whatsapp.js`.
- `database/schema.sql` — current full schema.
- `database/migrations/001`–`013` — ordered SQL deltas (`013_bundle_included_options.sql`
  is newest). Read the highest numbers for recent changes; never replay all of them.
- HTML pages at root: `index` · `shop` · `studio` · `checkout` · `payment` ·
  `order-success` · `artist` · `admin`.
- `tests/` — 33 files, one per feature; find the matching test before editing a module.
- Design source of truth: `DESIGN.md` (fixed monochrome, no theme toggle).

## Hard rules

1. Never read, list, or grep inside `assets/vendor/`, `src/three/`,
   `node_modules/`, or `assets/uploads/`. Treat them as opaque binaries.
2. Never read `styles.css`, `assets/admin.css`, `src/admin.js`, or `src/studio.js`
   in full. Use `search_files` for a symbol, then `read_file` with a narrow
   `offset`/`limit` (≤120 lines) around the hit.
3. Never launch a live browser, dev server preview, or screenshot capture unless
   the user explicitly asks for it. Verify with `npm run test` instead.
4. Never open `.env` or print secrets. `env.js` reads it; that is enough.
5. Do not rewrite whole files to make a small change — use targeted patches.
6. No new dependencies without asking; the project is deliberately framework-free.

## Verify

`npm run test` must pass. For schema work also run `npm run db:migrate`.
