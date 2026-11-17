# LOCOXATL — Current Architecture

## As-built application

LOCOXATL is a multi-page storefront built with vanilla HTML, shared CSS, browser
JavaScript and ES modules. A small Node.js HTTP server serves the customer pages and
provides the order API. MySQL is the persistence layer when configured; `mysql2` handles
database access and order creation uses a transaction. The 3D Custom Studio uses the
vendored Three.js build and loads its viewer modules only when the preview approaches the
viewport.

There is no active React, Next.js, Supabase, or PostgreSQL implementation in this codebase.
The storefront keeps working from the bundled catalogue in `src/catalog.js` when MySQL is not
configured; checkout refuses to fake an order and reports the failure inline.

## Project responsibilities

```text
HTML entry pages          Customer journey; root paths remain stable
styles.css                Shared design system and responsive layouts
src/
  site-shell.js            Shared navigation and page shell
  catalog.js               Artist and product data
  pricing.js, options.js   Shared price rules and option costs
  artist-page.js           Artist collection page behavior
  studio.js                Custom Studio controls and checkout handoff
  checkout.js              Customer details and order submission
  payment.js               Payment instructions and confirmation flow
  success.js               Order confirmation page
  three/                   3D model, materials, component, scene and viewer modules
  server/                  Environment, database, validation, order and API modules
server.js                  Static file server and API composition
database/schema.sql        MySQL orders, items and configuration schema
assets/vendor/three/       Pinned Three.js modules and OrbitControls
tests/                     Node.js built-in unit and integration-style tests
tools/                     Optional browser verification utility
archive/                   Inactive legacy single-page reference
```

## Runtime boundaries

- HTML and public assets stay at stable root-relative paths for the existing multi-page flow.
- Pricing and option values are shared by the browser and server-side order validation.
- `src/studio.js` does not load Three.js at initial parse time. The 3D viewer imports
  Three.js using the import map in `studio.html`; `OrbitControls` resolves the same
  `"three"` import-map entry, avoiding a second engine instance.
- Server modules are CommonJS and are not sent to the browser. MySQL credentials are loaded
  from the server environment and never exposed to client scripts.
- Orders, line items and customizer snapshots are written in one transaction. If MySQL is
  not configured, checkout retains its documented browser-local demo behavior.
- `archive/legacy-single-page/` is reference material and is not part of active routing.

## Historical proposal (obsolete; retained for reference)

The remainder of this document records an earlier proposed Next.js/React and
Supabase/PostgreSQL target. It is not a description of the current application, and none of
those technologies should be treated as active dependencies or implementation.

## 2. Proposed project structure

```text
locoxatl/
├── src/
│   ├── app/                         # Next.js routes and composition only
│   │   ├── (store)/                 # Public storefront route group
│   │   │   ├── page.tsx             # Homepage
│   │   │   ├── shop/page.tsx        # Product catalog
│   │   │   ├── studio/page.tsx      # Custom Studio
│   │   │   ├── cart/page.tsx        # Cart
│   │   │   ├── checkout/page.tsx    # Guest checkout
│   │   │   └── orders/[code]/page.tsx
│   │   ├── admin/                   # Protected admin routes
│   │   └── api/                     # Thin HTTP adapters, not business logic
│   │
│   ├── modules/                     # Business domains; each owns its rules
│   │   ├── catalog/
│   │   │   ├── domain/               # Product, category, availability rules
│   │   │   ├── application/          # List products, get product use cases
│   │   │   ├── infrastructure/       # Supabase product repository
│   │   │   ├── presentation/         # Catalog-specific UI
│   │   │   └── index.ts              # Public module API
│   │   ├── customizer/
│   │   │   ├── domain/               # Base charm, add-on, clasp, configuration
│   │   │   ├── application/          # Validate configuration, build preview model
│   │   │   ├── infrastructure/       # Component asset/config repository
│   │   │   ├── presentation/         # Builder controls and live preview
│   │   │   └── index.ts
│   │   ├── pricing/
│   │   │   ├── domain/               # Price rules and discounts
│   │   │   ├── application/          # Quote cart/order use cases
│   │   │   ├── infrastructure/       # Pricing rule persistence if required
│   │   │   └── index.ts
│   │   ├── cart/
│   │   │   ├── domain/               # Cart and cart item rules
│   │   │   ├── application/          # Add, update, remove, retrieve cart
│   │   │   ├── infrastructure/       # Guest session/cart persistence adapter
│   │   │   └── index.ts
│   │   ├── inventory/
│   │   │   ├── domain/               # Stock and reservation rules
│   │   │   ├── application/          # Check, reserve, release stock
│   │   │   ├── infrastructure/       # Supabase inventory repository
│   │   │   └── index.ts
│   │   ├── orders/
│   │   │   ├── domain/               # Order aggregate and lifecycle
│   │   │   ├── application/          # Place order, cancel, update status
│   │   │   ├── infrastructure/       # Supabase order repository
│   │   │   └── index.ts
│   │   ├── payments/
│   │   │   ├── domain/               # Payment status and verification rules
│   │   │   ├── application/          # Record payment proof, verify payment
│   │   │   ├── infrastructure/       # QRIS configuration and payment records
│   │   │   └── index.ts
│   │   ├── shipping/
│   │   │   ├── domain/               # Address, delivery option, shipping fee
│   │   │   ├── application/          # Validate address and calculate delivery
│   │   │   ├── infrastructure/       # Shipping provider adapter/manual rates
│   │   │   └── index.ts
│   │   ├── identity/
│   │   │   ├── domain/               # Admin/staff roles and permissions
│   │   │   ├── application/          # Authorize admin actions
│   │   │   ├── infrastructure/       # Supabase Auth adapter
│   │   │   └── index.ts
│   │   └── store-settings/
│   │       ├── domain/               # Store profile, WhatsApp, QRIS settings
│   │       ├── application/          # Read/update store settings
│   │       ├── infrastructure/       # Settings repository
│   │       └── index.ts
│   │
│   ├── shared/                      # Cross-cutting, business-agnostic code
│   │   ├── ui/                      # Buttons, dialogs, inputs, layout primitives
│   │   ├── lib/                     # Formatting, validation helpers
│   │   ├── config/                  # Environment/config validation
│   │   └── types/                   # Truly shared primitive types only
│   │
│   └── server/                      # Composition root and server-only adapters
│       ├── database/                # Supabase server client and transaction helpers
│       └── use-cases/               # Cross-module orchestration when needed
│
├── public/                          # Static public assets and brand assets
├── supabase/
│   └── migrations/                  # Versioned database schema changes
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── ARCHITECTURE.md
└── package.json
```

## 3. Module ownership and boundaries

| Module | Owns | Must not own |
|---|---|---|
| Catalog | Product information, categories, published status | Stock movements, payment status |
| Customizer | Allowed component combinations and custom configuration | Order lifecycle and payment verification |
| Pricing | Authoritative price calculation, discounts and quote breakdown | UI display state |
| Cart | Temporary guest cart and cart item operations | Final order status or trusted final price |
| Inventory | Stock quantities, reservations and stock movements | Product marketing copy |
| Orders | Order record, order number and order lifecycle | QRIS verification rules |
| Payments | Payment instructions, proof and manual verification | Product and inventory master data |
| Shipping | Delivery address, shipping option and shipping fee | Order payment status |
| Identity | Admin/staff authentication and authorization | Customer registration (not required for guest checkout) |
| Store Settings | Store identity, operational WhatsApp number and QRIS display configuration | Secrets embedded in client-side code |

## 4. Dependency rules

1. A module may access its own `domain`, `application` and `infrastructure` internals.
2. Other modules may import only the module's public `index.ts` API or explicitly exported contracts.
3. A module must never query another module's tables directly from its own UI or repository.
4. Route handlers and React components must call application use cases; they must not contain business rules or direct database queries.
5. `shared/` must remain business-agnostic. Do not move domain logic into shared utilities.
6. Cross-module workflows are coordinated by an application use case in `server/use-cases/`, not by circular imports.
7. No module may import from another module's private folder.

## 5. Main checkout workflow

The checkout flow is orchestrated by one server-side use case:

1. Validate the guest cart and customizer configuration.
2. Recalculate all prices on the server using the Pricing module. Never trust a browser-submitted total.
3. Ask Inventory to validate and reserve required components/stock.
4. Ask Shipping to validate the destination and calculate delivery cost.
5. Create the Order with a server-generated order number and immutable item/price snapshots.
6. Create a Payment record with `waiting_for_payment` status and the configured static QRIS instructions.
7. Return the order summary and WhatsApp handoff URL to the storefront.
8. Admin verifies the payment. Only the Payments application use case can mark a payment as verified; the Orders module then advances the order through its allowed lifecycle.

If order creation fails after inventory reservation, the orchestration must release the reservation. The final implementation should use a database transaction for changes that share the same database boundary and an explicit compensation path for steps that cannot be included in that transaction.

## 6. Order and payment lifecycle

Suggested order statuses:

`pending` → `waiting_for_payment` → `paid` → `in_production` → `shipped` → `completed`

Alternative terminal states: `cancelled`, `expired`.

Suggested payment statuses:

`waiting_for_payment` → `proof_submitted` → `verified`

Alternative status: `rejected`.

A customer pressing a confirmation button or opening WhatsApp must never cause a payment to become `verified`. QRIS static payment verification remains a manual admin action unless a future payment provider integration is approved.

## 7. Database ownership

Use one Supabase PostgreSQL database. Tables are grouped by module ownership and use explicit names, for example:

- Catalog: `catalog_products`, `catalog_categories`
- Customizer: `customizer_components`, `customizer_compatibility_rules`
- Inventory: `inventory_stock_items`, `inventory_movements`, `inventory_reservations`
- Orders: `orders`, `order_items`, `order_status_history`
- Payments: `payments`, `payment_verification_history`
- Shipping: `shipping_addresses`, `shipping_options`
- Store settings: `store_settings`

Names are a proposed convention, not a finalized migration. Foreign keys and read access must respect module ownership. Use database constraints and Row Level Security; privileged service-role credentials must remain server-only.

## 8. Security and operational requirements

- Admin routes and mutations require server-side authentication and role authorization.
- Supabase service-role keys must never be exposed to browser bundles.
- Validate all incoming data at the server boundary.
- Recalculate prices and check stock on the server at order creation.
- Use Row Level Security for browser-accessible data; deny public access to private order, payment and customer data.
- Store only necessary customer information and publish privacy/terms information before launch.
- Keep payment proof and admin verification actions auditable.
- Keep secrets in environment variables; provide `.env.example` without real credentials.
- Apply database migrations in version control.

## 9. Testing strategy

- Unit tests: price calculation, customizer compatibility, cart rules, order transitions and payment verification rules.
- Integration tests: repositories, database constraints, inventory reservation and checkout orchestration.
- End-to-end tests: guest customizer → cart → checkout → payment waiting → admin verification → production status.
- Architecture tests/lint rules: prohibit imports from another module's private folders and prevent circular module dependencies.

## 10. Migration plan from the current prototype

The current prototype remains the visual reference while production code is introduced in controlled steps:

1. Initialize Next.js App Router + TypeScript and move brand assets into `public/`.
2. Rebuild the current homepage and catalog presentation without changing the approved brand direction (Inter, monochrome, Apple-inspired motion).
3. Extract Custom Studio rules into the Customizer and Pricing modules; add unit tests before replacing prototype logic.
4. Add Catalog and Cart modules, preserving guest shopping.
5. Add Supabase schema, repositories, Inventory and Orders modules.
6. Add Payments, Shipping, Store Settings and protected Admin modules.
7. Integrate the checkout orchestration and test the complete order lifecycle.
8. Deploy the single Next.js application and managed PostgreSQL database.

The current prototype is not represented as production-ready backend code. Migration should preserve working visual interactions and replace demo persistence only when the corresponding module is implemented and tested.


## 11. Storefront page boundaries and customer journey

The customer-facing storefront is separated into distinct route-level experiences. The homepage is a brand introduction, not a full product catalog. The Buy Now action moves the customer into artist discovery.

| Prototype page | Responsibility | Production App Router route | Owning module(s) |
|---|---|---|---|
| `index.html` | Brand story, positioning, materials, Buy Now CTA | `/` | Storefront presentation / Store Settings |
| `shop.html` | Artist and group directory | `/collections` | Catalog |
| `artist.html?artist=[slug]` | Products for one artist/group | `/collections/[artistSlug]` | Catalog |
| `studio.html?artist=[slug]&product=[slug]` | Customize selected product and preview price | `/studio/[artistSlug]/[productSlug]` | Catalog, Customizer, Pricing |
| `checkout.html` | Guest details, delivery address, order review | `/checkout` | Orders, Shipping, Pricing |
| `payment.html` | QRIS instruction and WhatsApp handoff | `/payment/[orderCode]` | Payments, Store Settings |
| `order-success.html` | Customer confirmation and pending-verification status | `/order/[orderCode]` | Orders, Payments |

### Journey rules

1. Homepage navigation must not expose the full product grid or Custom Studio as homepage sections. Its primary purchase CTA is Buy Now → artist directory.
2. Artist directory cards must resolve to an artist-specific collection using a stable artist slug.
3. Product selection must carry both `artistSlug` and `productSlug` into Custom Studio. Do not ask the customer to select the artist again.
4. Custom Studio owns the selected base, add-ons, initial/personalization, clasp, preview state, and client-side price estimate. The production backend must recalculate the authoritative price.
5. The main Custom Studio CTA proceeds to checkout. Checkout collects customer and delivery data before the payment instructions are displayed.
6. Payment confirmation submitted by a customer is not equivalent to verified payment. The order remains `waiting_for_payment` or `proof_submitted` until an admin verifies it.
7. The artist directory and artist pages are data-driven. Adding an artist should require a Catalog record and approved assets, not a new hand-coded route page.

### Prototype state and production boundary

The static prototype passes the selected artist, product, and custom configuration through query parameters and browser `localStorage`. This is for demonstration only. Production should persist a guest cart/order through a server-generated guest token or order reference, store immutable product and price snapshots, and validate all values server-side. Do not treat browser `localStorage` values as trusted order or payment records.
