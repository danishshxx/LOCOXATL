# LOCOXATL release notes

## 0.3.0 — 2026-11-18

This release turns the storefront into a managed shop: the catalogue, its option categories,
bundle packages, Yellow/Pink version cards, payment methods and delivery routing are all data
the admin dashboard owns, and every order now records how it is delivered and how it is paid.

### Storefront

- **Fulfillment choice in the studio.** A new "How to receive it" step offers Kirim ke Kampus
  (Telkom University Jakarta), COD / Ketemuan (Telkom University Jakarta) and Eksternal: Order
  via Shopee. The choice travels with the pending order.
- **Shopee handoff.** Choosing Shopee opens a summary dialog instead of the checkout form: the
  configuration, the total and a "Chat CS untuk Link CO Shopee" button that opens WhatsApp with
  the item, add-ons, bundle and total already typed. No payment method is shown or offered on
  that path, and a stale checkout URL for a Shopee order returns to the builder.
- **Payment page.** `payment.html` shows only the method the buyer picked: the uploaded QRIS
  image when there is one, otherwise the method mark, its label and the admin instructions,
  followed by the existing WhatsApp confirmation flow. Cash, QRIS and transfer all render from
  the same template.
- **Custom design notice.** Groups marked as custom design show a prominent notice in the studio
  explaining that artwork is arranged through WhatsApp CS after payment rather than uploaded to
  the form.
- **Version picker is optional.** Groups with versions switched off skip the Yellow/Pink step and
  go straight to their designs, both on the collection page and in the studio.
- **Bundle packages (Paketan).** Bundles replace the base price, cover up to their quota of
  eligible add-ons at Rp 0 and are listed in the studio when they apply to the chosen collection.
- **Collection cards.** The card overlay shifts left, drops to 50% opacity and halves its type
  size on hover and keyboard focus so the artwork stays visible.

### Admin dashboard

- **Payment methods.** QRIS, Cash and Bank Transfer can be switched on or off, relabelled, given
  instructions and, for QRIS, given an uploaded image. Inactive methods disappear from checkout
  and are refused by the order API.
- **Group display modes.** "Enable Yellow / Pink versions" and "Custom design group" toggles in
  the group dialog. Custom design groups default to no version step, and the Yellow/Pink cover
  fields hide when versions are off.
- **Order drawer.** Every order now shows its FULFILLMENT and PAYMENT METHOD, with Shopee orders
  reading "Paid on Shopee".
- **Option categories and items.** Categories can be added, edited, reordered and switched off;
  items can be created, repriced, renamed and deleted inside any category.
- **Bundle management.** A Paketan section in the catalog view with price, free add-on quota,
  eligible add-on selection and an active toggle.

### Pricing and validation

- Pricing is category-driven: `quoteSelections()` reads the live categories, honours single and
  multiple selection, applies the bundle quota only to categories flagged for it and never
  discounts the personalization letter.
- Deactivated categories and items are never charged and are hidden in the studio. A deactivated
  clasp category makes the clasp optional; a deactivated clasp item inside a live category is
  rejected rather than silently repriced.
- Bundle totals are computed once from `bundlePrice`; the standard base price is never added on
  top, and repeated add-on toggles do not accumulate.
- Fulfillment and payment are validated server-side: an inactive or unknown payment method is
  refused, a Shopee order never carries one, and payloads from older clients (no fulfillment or
  payment fields) still validate as campus delivery with no method recorded.

### Database

- New additive migrations, all guarded by `INFORMATION_SCHEMA` and safe to re-run:
  - `010_dynamic_option_categories.sql` (`option_categories` plus the seeded strap category)
  - `011_product_versions.sql` (`version_key` on designs and members, `versions_json` on groups)
  - `012_payments_fulfillment_custom_groups.sql` (`payment_methods`, `has_versions`,
    `is_custom_design`, `fulfillment_method`, `payment_method`)
- `database/schema.sql` reflects the final shape for fresh installs, and `src/server/migrate.js`
  carries the same steps for deployments that migrate from Node.

### Fixes

- The 3D viewport is disabled behind `ENABLE_3D_PREVIEW = false` without deleting any three.js
  module, vendor asset or stored snapshot field. The stage reports `data-viewer="off"` and the
  flat preview and specification list stay in charge.
- An optional single-choice category can be cleared again; required categories still hold one.
- Dynamic option rows no longer inherit the silver clasp price.
- Creating a pricing option with a blank key derives it from the label instead of failing.

### Upgrade notes

1. Back up the database, then run `npm run db:migrate` (or apply the three new SQL files in
   order). All three are idempotent and only add tables, columns and seed rows.
2. Existing orders keep working: `fulfillment_method` defaults to `campus_delivery` and
   `payment_method` stays `NULL` on historical rows.
3. `payment_methods` seeds QRIS, Cash and Bank Transfer on an empty table only, so custom labels
   are never overwritten. Set the real QRIS image and bank details in the dashboard after the
   first deploy.
4. No environment variable was added or removed.

### Verification

- `node --test`: 232 tests, 230 passing, 0 failing, 2 skipped (the MySQL integration suite skips
  when no test database is configured).
- Migration 012 applied to a live MySQL instance twice and re-applied as raw SQL with no
  duplicate rows; `database/schema.sql` plus 012 was also loaded into an empty database, giving
  14 tables and the three seeded payment methods.
- Live smoke test against MySQL: health reports the schema ready, `/api/catalog` serves the
  payment methods and the group display flags, `/api/payment-methods` lists the active methods,
  `/api/admin/payment-methods` answers 401 without a session, and an order posted with
  `campus_delivery` plus `qris` persisted both columns.

### Known limitations

- The studio's version picker reads the group flags from the catalogue payload, so a page loaded
  before an admin flips the toggle keeps its picker until reload.
- Shipping cost is still confirmed manually by the admin; only the product total is collected on
  the site.
- Custom design files are exchanged on WhatsApp by design, so nothing about them is stored in
  the database.
