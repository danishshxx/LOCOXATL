const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Per-design price override: a design may replace the global base price, a bundle still replaces
// both, and a NULL override keeps the global price. Migration 014 adds the column additively.

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'price-override-test';
process.env.DB_NAME = 'price_override_test';

// The migration mirror runs against a fake connection, so mysql2 is stubbed before any module
// that opens a pool is loaded.
const statements = [];
const tableColumns = new Map();

function respond(sql, params) {
  const query = sql.replace(/\s+/g, ' ').trim();
  statements.push({ sql: query, params });

  if (/^SELECT DATABASE\(\) AS databaseName$/i.test(query)) {
    return [[{ databaseName: process.env.DB_NAME }]];
  }
  if (/FROM INFORMATION_SCHEMA\.COLUMNS/i.test(query) && /TABLE_NAME = \?/i.test(query)) {
    const table = String(params && params[0]).toLowerCase();
    return [(tableColumns.get(table) || []).map((name) => ({ COLUMN_NAME: name }))];
  }
  const added = /^ALTER TABLE (\w+) ADD COLUMN (?:IF NOT EXISTS )?(\w+)/i.exec(query);
  if (added) {
    const table = added[1].toLowerCase();
    const names = tableColumns.get(table) || [];
    if (!names.includes(added[2])) names.push(added[2]);
    tableColumns.set(table, names);
  }
  return [[]];
}

const connection = {
  query: async (sql, params) => respond(sql, params),
  execute: async (sql, params) => respond(sql, params),
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
        async getConnection() { return connection; },
        query: connection.query,
        execute: connection.execute,
        async end() {},
      };
    },
  },
};

const pricing = require('../src/pricing.js');
const { validateOrderPayload } = require('../src/server/validation.js');
const { runAdditiveMigrations } = require('../src/server/migrate.js');

// ---------------------------------------------------------------------------
// Pricing engine
// ---------------------------------------------------------------------------
test('calculatePrice falls back to the global base price when no override is set', () => {
  const quote = pricing.calculatePrice({ basePrice: 45000, priceOverride: null });
  assert.equal(quote.unitPrice, 45000);
});

test('calculatePrice uses the design override instead of the global base price', () => {
  const quote = pricing.calculatePrice({ basePrice: 45000, priceOverride: 52000 });
  assert.equal(quote.unitPrice, 52000);
});

test('a bundle price still replaces the base price, override or not', () => {
  const quote = pricing.calculatePrice({
    basePrice: 45000,
    priceOverride: 52000,
    bundle: { price: 60000, freeAddonIds: [] },
  });
  assert.equal(quote.unitPrice, 60000);
});

test('quoteSelections applies the override and still charges the add-ons on top', () => {
  const categories = [
    { slug: 'addon', selectionMode: 'multiple', isActive: true },
    { slug: 'clasp', selectionMode: 'single', isActive: true },
  ];
  const items = [
    { key: 'pearl', category: 'addon', price: 8000 },
    { key: 'silver', category: 'clasp', price: 7000 },
  ];
  const selections = { addon: ['pearl'], clasp: ['silver'] };

  const plain = pricing.quoteSelections({ basePrice: 45000, categories, items, selections });
  assert.equal(plain.total, 45000 + 8000 + 7000);

  const overridden = pricing.quoteSelections({ basePrice: 45000, priceOverride: 52000, categories, items, selections });
  assert.equal(overridden.total, 52000 + 8000 + 7000);

  const bundled = pricing.quoteSelections({
    basePrice: 45000,
    priceOverride: 52000,
    bundle: { price: 60000, freeAddonQuota: 1, allowedAddonKeys: ['pearl'] },
    categories,
    items,
    selections,
  });
  assert.equal(bundled.total, 60000 + 0 + 7000, 'the bundle price wins and covers the free add-on');
});

// ---------------------------------------------------------------------------
// Order validation
// ---------------------------------------------------------------------------
function catalogFixture(memberOverride) {
  return {
    source: 'database',
    groups: [{ id: 1, slug: 'twice', name: 'TWICE', tagline: 'ONCE', isActive: true }],
    members: [{
      id: 3,
      groupId: 1,
      groupSlug: 'twice',
      slug: 'jisoo',
      name: 'Jisoo',
      isActive: true,
      designImageUrl: null,
      priceOverride: memberOverride,
    }],
    products: [{
      id: 5,
      slug: 'twice-moon',
      key: 'moon',
      name: 'Moon Drop',
      groupSlug: 'twice',
      groupName: 'TWICE',
      baseId: 'heart',
      price: 45000,
      priceOverride: 61000,
      isActive: true,
    }],
    bundles: [{
      id: 7,
      slug: 'duo-paket',
      name: 'Duo Paket',
      price: 60000,
      freeAddonQuota: 1,
      allowedAddonKeys: ['pearl'],
      groupId: null,
      isActive: true,
    }],
    options: {
      base: { key: 'keychain', label: 'Keychain base', price: 45000, isActive: true },
      addons: [
        { key: 'pearl', label: 'Pearl drop', price: 8000, isActive: true },
        { key: 'initial', label: 'Your initial', price: 5000, isActive: true },
      ],
      clasps: [{ key: 'silver', label: 'Silver clasp', price: 7000, isActive: true }],
    },
    optionCategories: [
      { slug: 'addon', selectionMode: 'multiple', isRequired: false, countsTowardBundleFree: true, isActive: true },
      { slug: 'clasp', selectionMode: 'single', isRequired: true, countsTowardBundleFree: false, isActive: true },
    ],
    product: { baseModel: 'heart', baseLabel: 'Heart', basePrice: 45000, baseKey: 'keychain' },
    paymentMethods: [{ code: 'cash', label: 'Cash', isActive: true }],
  };
}

function memberOrder(overrides = {}) {
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
      configuration: { base: { id: 'heart' }, clasp: { id: 'silver' }, addons: ['pearl'] },
      fulfillmentMethod: 'campus_delivery',
      paymentMethod: 'cash',
      quantity: 1,
      ...overrides,
    },
  };
}

test('a member without an override is priced from the global base price', () => {
  const result = validateOrderPayload(memberOrder(), { catalog: catalogFixture(null) });
  assert.equal(result.quote.total, 45000 + 8000 + 7000);
});

test('a member override replaces the global base price in the authoritative total', () => {
  const result = validateOrderPayload(memberOrder(), { catalog: catalogFixture(52000) });
  assert.equal(result.quote.total, 52000 + 8000 + 7000);
});

test('a bundle still replaces the base price for an overridden member', () => {
  const result = validateOrderPayload(
    memberOrder({ bundle: { id: 7 } }),
    { catalog: catalogFixture(52000) },
  );
  assert.equal(result.quote.total, 60000 + 0 + 7000, 'bundle price wins and the pearl is free');
});

test('a product override replaces the global base price', () => {
  const payload = memberOrder();
  delete payload.order.member;
  payload.order.product = { slug: 'twice-moon' };

  const result = validateOrderPayload(payload, { catalog: catalogFixture(null) });
  assert.equal(result.quote.total, 61000 + 8000 + 7000);
});

// ---------------------------------------------------------------------------
// Migration 014
// ---------------------------------------------------------------------------
test('migration 014 guards both columns behind INFORMATION_SCHEMA and never rewrites a price', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'migrations', '014_product_price_override.sql'),
    'utf8',
  );

  assert.match(sql, /INFORMATION_SCHEMA\.COLUMNS/i);
  assert.match(sql, /TABLE_NAME = 'catalog_products' AND COLUMN_NAME = 'price_override'/);
  assert.match(sql, /TABLE_NAME = 'artist_members' AND COLUMN_NAME = 'price_override'/);
  assert.equal(
    (sql.match(/ADD COLUMN price_override INT UNSIGNED NULL DEFAULT NULL/g) || []).length,
    2,
    'one guarded column per table',
  );
  assert.match(sql, /'DO 0'/);
  assert.doesNotMatch(sql, /UPDATE\s+\w+\s+SET\s+price/i, 'no stored price is ever rewritten');
});

test('the schema and the JavaScript mirror both carry the override column', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
  assert.equal((schema.match(/price_override INT UNSIGNED NULL DEFAULT NULL/g) || []).length, 2);

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'migrate.js'), 'utf8');
  assert.match(source, /catalog_products ADD COLUMN price_override/);
  assert.match(source, /artist_members ADD COLUMN price_override/);
});

test('the migration mirror adds each override column once and is idempotent', async () => {
  statements.length = 0;
  const first = await runAdditiveMigrations();
  assert.equal(first.success, true);

  const firstRun = statements.filter((entry) => /ADD COLUMN price_override/i.test(entry.sql));
  assert.equal(firstRun.length, 2, 'catalog_products and artist_members are both upgraded');

  statements.length = 0;
  const second = await runAdditiveMigrations();
  assert.equal(second.success, true);
  assert.equal(
    statements.filter((entry) => /ADD COLUMN price_override/i.test(entry.sql)).length,
    0,
    'a second run must not re-add an existing column',
  );
});
