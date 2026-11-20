const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pricing = require('../src/pricing.js');
const { validateOrderPayload, ValidationError } = require('../src/server/validation.js');

// A live catalogue with the seeded strap category and a yellow member.
const catalog = {
  source: 'database',
  groups: [{ id: 1, slug: 'twice', name: 'TWICE', tagline: 'ONCE', isActive: true }],
  members: [{
    id: 3,
    groupId: 1,
    groupSlug: 'twice',
    slug: 'jisoo',
    name: 'Jisoo',
    versionKey: 'yellow',
    isActive: true,
    designImageUrl: null,
  }],
  products: [],
  bundles: [{
    id: 7,
    slug: 'duo-paket',
    name: 'Duo Paket',
    price: 60000,
    freeAddonQuota: 2,
    allowedAddonKeys: ['pearl', 'star'],
    groupId: null,
    isActive: true,
  }],
  optionCategories: [
    { slug: 'addon', name: 'Universal Add-ons', selectionMode: 'multiple', isRequired: false, countsTowardBundleFree: true, sortOrder: 0, isActive: true },
    { slug: 'clasp', name: 'Clasps', selectionMode: 'single', isRequired: true, countsTowardBundleFree: false, sortOrder: 1, isActive: true },
    { slug: 'silicone-strap', name: 'Silicone Straps', selectionMode: 'single', isRequired: false, countsTowardBundleFree: false, bundleIncluded: true, sortOrder: 2, isActive: true },
  ],
  options: {
    base: { key: 'keychain', label: 'Keychain base', price: 45000, isActive: true },
    addons: [
      { key: 'pearl', label: 'Pearl drop', price: 8000, isActive: true },
      { key: 'star', label: 'Mini star', price: 12000, isActive: true },
      { key: 'initial', label: 'Your initial', price: 5000, isActive: true },
    ],
    clasps: [
      { key: 'silver', label: 'Silver clasp', price: 7000, isActive: true },
      { key: 'black', label: 'Black clasp', price: 5000, isActive: true },
    ],
    items: [
      { key: 'pearl', category: 'addon', label: 'Pearl drop', price: 8000, isActive: true },
      { key: 'star', category: 'addon', label: 'Mini star', price: 12000, isActive: true },
      { key: 'initial', category: 'addon', label: 'Your initial', price: 5000, isActive: true },
      { key: 'silver', category: 'clasp', label: 'Silver clasp', price: 7000, isActive: true },
      { key: 'black', category: 'clasp', label: 'Black clasp', price: 5000, isActive: true },
      { key: 'strap-white', category: 'silicone-strap', label: 'White silicone strap', price: 8000, isActive: true },
      { key: 'strap-black', category: 'silicone-strap', label: 'Black silicone strap', price: 8000, isActive: true },
    ],
  },
  product: { baseModel: 'heart', baseLabel: 'Heart', basePrice: 45000, baseKey: 'keychain' },
};

function orderPayload(overrides = {}) {
  return {
    customer: {
      name: 'Test Buyer',
      phone: '0812345678',
      email: '',
      address: 'Jl. Merdeka 10, Bandung',
      note: '',
    },
    order: {
      artist: { slug: 'twice' },
      member: { slug: 'jisoo' },
      version: 'yellow',
      configuration: {
        base: { id: 'heart' },
        clasp: { id: 'silver' },
        addons: ['pearl'],
        selections: { addon: ['pearl'], clasp: ['silver'], 'silicone-strap': ['strap-black'] },
        initial: '',
      },
      quantity: 1,
      ...overrides,
    },
  };
}

test('quoteSelections prices a category the codebase never hardcoded', () => {
  const quote = pricing.quoteSelections({
    basePrice: 45000,
    categories: catalog.optionCategories,
    items: catalog.options.items,
    selections: { addon: ['pearl'], clasp: ['silver'], 'silicone-strap': ['strap-black'] },
  });

  // base 45000 + pearl 8000 + silver 7000 + strap 8000
  assert.equal(quote.total, 68000);
  assert.deepEqual(quote.lines.map((line) => line.key), ['pearl', 'silver', 'strap-black']);
});

test('single-selection categories keep only one choice', () => {
  const quote = pricing.quoteSelections({
    basePrice: 45000,
    categories: catalog.optionCategories,
    items: catalog.options.items,
    selections: { clasp: ['silver', 'black'], 'silicone-strap': ['strap-white', 'strap-black'] },
  });

  assert.deepEqual(quote.lines.map((line) => line.key), ['silver', 'strap-white']);
  assert.equal(quote.total, 45000 + 7000 + 8000);
});

test('a strap order validates and prices from the live categories', () => {
  const result = validateOrderPayload(orderPayload(), { catalog });

  assert.equal(result.quote.total, 68000);
  assert.equal(result.version, 'yellow');
});

test('two choices in a single-mode category are rejected', () => {
  const payload = orderPayload();
  payload.order.configuration.selections['silicone-strap'] = ['strap-white', 'strap-black'];

  assert.throws(
    () => validateOrderPayload(payload, { catalog }),
    (error) => error instanceof ValidationError && Boolean(error.details['silicone-strap']),
  );
});

test('a bundle includes the silicone strap without spending the add-on quota', () => {
  const result = validateOrderPayload(orderPayload({ bundle: { id: 7 } }), { catalog });

  // bundle 60000 + free pearl + silver 7000 + free strap
  assert.equal(result.quote.total, 67000);
  assert.deepEqual(result.bundle.freeAddonIds, ['pearl'], 'the strap never consumes the add-on quota');
  const strapLine = result.quote.lines.find((line) => line.key === 'strap-black');
  assert.equal(strapLine.free, true, 'every bundle comes with a free strap');
});

test('the included strap stays free when the add-on quota is already spent', () => {
  const quote = pricing.quoteSelections({
    bundle: { price: 60000, freeAddonQuota: 1, allowedAddonKeys: ['pearl', 'star'] },
    categories: catalog.optionCategories,
    items: catalog.options.items,
    selections: {
      addon: ['pearl', 'star'],
      clasp: ['silver'],
      'silicone-strap': ['strap-white'],
    },
  });

  assert.deepEqual(quote.freeAddonIds, ['pearl']);
  const strap = quote.lines.find((line) => line.key === 'strap-white');
  const star = quote.lines.find((line) => line.key === 'star');
  assert.equal(strap.free, true);
  assert.equal(star.free, false);
  // bundle 60000 + silver 7000 + star 12000
  assert.equal(quote.total, 79000);
});

test('a strap is charged normally without a bundle', () => {
  const quote = pricing.quoteSelections({
    basePrice: 45000,
    categories: catalog.optionCategories,
    items: catalog.options.items,
    selections: { addon: [], clasp: ['silver'], 'silicone-strap': ['strap-black'] },
  });

  assert.equal(quote.lines.find((line) => line.key === 'strap-black').free, false);
  assert.equal(quote.total, 45000 + 7000 + 8000);
});

test('the version must match the design', () => {
  assert.throws(
    () => validateOrderPayload(orderPayload({ version: 'pink' }), { catalog }),
    (error) => error instanceof ValidationError && /another version/i.test(error.details.version),
  );

  assert.throws(
    () => validateOrderPayload(orderPayload({ version: 'green' }), { catalog }),
    (error) => error instanceof ValidationError && Boolean(error.details.version),
  );
});

test('migration 010 is guarded and seeds the strap category', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'migrations', '010_dynamic_option_categories.sql'),
    'utf8',
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS option_categories/i);
  assert.match(sql, /WHERE NOT EXISTS \(SELECT 1 FROM option_categories\)/i);
  assert.match(sql, /'silicone-strap'/i);
  assert.match(sql, /WHERE NOT EXISTS \(SELECT 1 FROM pricing_options WHERE category = 'silicone-strap'\)/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE/i);
});

test('migration 011 guards every column with INFORMATION_SCHEMA', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'migrations', '011_product_versions.sql'),
    'utf8',
  );

  const guards = sql.match(/SELECT COUNT\(\*\) FROM INFORMATION_SCHEMA\.COLUMNS/gi) || [];
  assert.equal(guards.length, 3, 'product, member and group columns each get a guard');
  assert.match(sql, /ADD COLUMN version_key VARCHAR\(32\) NOT NULL DEFAULT ''?yellow''?/i);
  assert.match(sql, /ADD COLUMN versions_json JSON NULL/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DROP COLUMN/i);
});

// ---------------------------------------------------------------------------
// The JavaScript migration, checked against a fake pool the same way the other
// migration tests do it. Each test file runs in its own process.
// ---------------------------------------------------------------------------
process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'dynamic-options-test';
process.env.DB_NAME = 'dynamic_options_test';

const statements = [];

function respond(sql) {
  const query = String(sql).replace(/\s+/g, ' ').trim();
  statements.push(query);
  if (/^SELECT DATABASE\(\) AS databaseName$/i.test(query)) {
    return [[{ databaseName: process.env.DB_NAME }]];
  }
  if (/^SELECT COUNT\(\*\) AS total FROM option_categories$/i.test(query)) {
    return [[{ total: 0 }]];
  }
  return [[]];
}

const connection = {
  query: async (sql) => respond(sql),
  execute: async (sql) => respond(sql),
  async beginTransaction() {},
  async commit() {},
  async rollback() {},
  release() {},
};

const mysqlPath = require.resolve('mysql2/promise');
require.cache[mysqlPath] = {
  id: mysqlPath,
  filename: mysqlPath,
  loaded: true,
  exports: {
    createPool() {
      return {
        async getConnection() {
          return connection;
        },
        query: connection.query,
        async end() {},
      };
    },
  },
};

const catalogPath = require.resolve('../src/server/catalog');
require.cache[catalogPath] = {
  id: catalogPath,
  filename: catalogPath,
  loaded: true,
  exports: {
    seedCatalogGroups: async () => ({ seeded: 0 }),
    seedCatalogProducts: async () => ({ seeded: 0 }),
    seedPricingOptions: async () => ({ seeded: 0 }),
  },
};

const { runAdditiveMigrations } = require('../src/server/migrate');

test('migration 013 adds the bundle-included flag behind a guard', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'migrations', '013_bundle_included_options.sql'),
    'utf8',
  );

  const guards = sql.match(/SELECT COUNT\(\*\) FROM INFORMATION_SCHEMA\.COLUMNS/gi) || [];
  assert.equal(guards.length, 1);
  assert.match(sql, /ADD COLUMN bundle_included TINYINT\(1\) NOT NULL DEFAULT 0/i);
  assert.match(sql, /WHERE slug = ''?silicone-strap''?/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DROP COLUMN/i);
});

test('the JavaScript migration creates the category table and seeds it once', async () => {
  statements.length = 0;
  const first = await runAdditiveMigrations();
  assert.equal(first.success, true);

  assert.ok(
    statements.some((query) => /CREATE TABLE IF NOT EXISTS option_categories/i.test(query)),
    'the migration must create option_categories',
  );
  assert.ok(
    statements.some((query) => /ADD COLUMN bundle_included/i.test(query)),
    'option_categories.bundle_included must be added',
  );
  assert.ok(
    statements.some((query) => /INSERT IGNORE INTO option_categories/i.test(query)),
    'an empty table must be seeded',
  );
  assert.ok(
    statements.some((query) => /silicone-strap/i.test(query)),
    'the strap category and its items must be seeded',
  );

  statements.length = 0;
  const second = await runAdditiveMigrations();
  assert.equal(second.success, true);
  assert.ok(
    statements.some((query) => /CREATE TABLE IF NOT EXISTS option_categories/i.test(query)),
    'a second run repeats only the guarded statement',
  );
  assert.ok(
    !statements.some((query) => /CREATE TABLE option_categories/i.test(query)
      && !/CREATE TABLE IF NOT EXISTS option_categories/i.test(query)),
    'a second run must never emit a plain CREATE TABLE',
  );
});

// ---------------------------------------------------------------------------
// Deactivated categories and items
// ---------------------------------------------------------------------------

test('an inactive option item is never priced', () => {
  const withInactiveSilver = {
    ...catalog,
    options: {
      ...catalog.options,
      items: catalog.options.items.map((item) => (item.key === 'silver' ? { ...item, isActive: false } : item)),
    },
  };

  const quote = pricing.quoteSelections({
    basePrice: 45000,
    categories: withInactiveSilver.optionCategories,
    items: withInactiveSilver.options.items,
    selections: { addon: [], clasp: ['silver'] },
  });

  assert.equal(quote.total, 45000, 'the deactivated clasp must not be charged');
  assert.deepEqual(quote.lines, []);
});

test('a deactivated clasp category rejects a stale clasp and charges nothing for it', () => {
  // What loadCatalog({ activeOnly: true }) returns once the clasp category is switched off.
  const catalogWithoutClasp = {
    ...catalog,
    optionCategories: catalog.optionCategories.filter((category) => category.slug !== 'clasp'),
    options: {
      ...catalog.options,
      items: catalog.options.items.filter((item) => item.category !== 'clasp'),
    },
  };

  const stale = orderPayload();
  stale.order.configuration.selections = { addon: ['pearl'], clasp: ['silver'] };
  assert.throws(
    () => validateOrderPayload(stale, { catalog: catalogWithoutClasp }),
    (error) => error instanceof ValidationError && Boolean(error.details.clasp),
    'a clasp the storefront no longer offers is rejected',
  );

  const clean = orderPayload();
  clean.order.configuration.selections = { addon: ['pearl'] };
  delete clean.order.configuration.clasp;
  const result = validateOrderPayload(clean, { catalog: catalogWithoutClasp });

  assert.equal(result.quote.total, 45000 + 8000, 'base plus the add-on only');
  assert.equal(result.configuration.clasp, '', 'no clasp is recorded for an order that offered none');
  assert.ok(
    !result.quote.lines.some((line) => line.category === 'clasp'),
    'the stale clasp selection must not be priced',
  );
});

test('a deactivated item inside a live category is rejected, not silently repriced', () => {
  const silverOff = {
    ...catalog,
    options: {
      ...catalog.options,
      items: catalog.options.items.map((item) => (item.key === 'silver' ? { ...item, isActive: false } : item)),
    },
  };

  const payload = orderPayload();
  payload.order.configuration.selections = { addon: [], clasp: ['silver'] };

  assert.throws(
    () => validateOrderPayload(payload, { catalog: silverOff }),
    (error) => error instanceof ValidationError && Boolean(error.details.clasp),
  );
});

// ---------------------------------------------------------------------------
// Bundle packages
// ---------------------------------------------------------------------------

test('a bundle replaces the base price instead of adding to it', () => {
  const withBase = pricing.quoteSelections({
    basePrice: 45000,
    bundle: { price: 60000, freeAddonQuota: 2, allowedAddonKeys: ['pearl', 'star'] },
    categories: catalog.optionCategories,
    items: catalog.options.items,
    selections: { addon: [], clasp: [] },
  });

  assert.equal(withBase.unitPrice, 60000, 'the standard base is not added on top of the bundle');

  const withoutBase = pricing.quoteSelections({
    bundle: { price: 60000, freeAddonQuota: 2, allowedAddonKeys: ['pearl', 'star'] },
    categories: catalog.optionCategories,
    items: catalog.options.items,
    selections: { addon: [], clasp: [] },
  });

  assert.equal(withoutBase.unitPrice, withBase.unitPrice);
});

test('bundle-covered add-ons are Rp 0 and repeated selections never accumulate', () => {
  const bundle = { price: 60000, freeAddonQuota: 2, allowedAddonKeys: ['pearl', 'star'] };
  const quoteFor = (addonSelection) => pricing.quoteSelections({
    basePrice: 45000,
    bundle,
    categories: catalog.optionCategories,
    items: catalog.options.items,
    selections: { addon: addonSelection, clasp: ['silver'] },
  });

  // bundle 60000 + pearl free + silver 7000
  const first = quoteFor(['pearl']);
  assert.equal(first.total, 67000);
  assert.deepEqual(first.freeAddonIds, ['pearl']);
  assert.equal(first.lines.find((line) => line.key === 'pearl').free, true);

  // Toggling, duplicating and clearing the add-on selection must land on the same clean total.
  assert.equal(quoteFor(['pearl', 'pearl']).total, 67000);
  assert.equal(quoteFor(['star']).total, 67000);
  assert.equal(quoteFor([]).total, 67000);
  assert.equal(quoteFor(['pearl']).total, first.total, 'a second pass must not add the first one again');

  // The quota covers two, so both are free and only the clasp is charged.
  const both = quoteFor(['pearl', 'star']);
  assert.deepEqual(both.freeAddonIds.sort(), ['pearl', 'star']);
  assert.equal(both.total, 67000);
});

test('a deactivated add-on neither charges nor consumes the bundle quota', () => {
  const pearlOff = {
    ...catalog,
    options: {
      ...catalog.options,
      items: catalog.options.items.map((item) => (item.key === 'pearl' ? { ...item, isActive: false } : item)),
    },
  };

  const quote = pricing.quoteSelections({
    basePrice: 45000,
    bundle: { price: 60000, freeAddonQuota: 1, allowedAddonKeys: ['pearl', 'star'] },
    categories: pearlOff.optionCategories,
    items: pearlOff.options.items,
    selections: { addon: ['pearl', 'star'], clasp: [] },
  });

  assert.deepEqual(quote.freeAddonIds, ['star'], 'the quota goes to the offered add-on');
  assert.equal(quote.total, 60000, 'the inactive pearl is neither free nor charged');
  assert.ok(!quote.lines.some((line) => line.key === 'pearl'), 'the inactive pearl is not a line');
});
