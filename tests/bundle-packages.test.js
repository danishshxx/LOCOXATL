const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pricing = require('../src/pricing.js');
const { validateOrderPayload, ValidationError } = require('../src/server/validation.js');

// A live catalogue shaped like serverCatalog.loadCatalog({ activeOnly: true }) would return it.
const catalog = {
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
  }],
  products: [],
  bundles: [
    {
      id: 7,
      slug: 'duo-paket',
      name: 'Duo Paket',
      price: 60000,
      freeAddonQuota: 2,
      allowedAddonKeys: ['pearl', 'star'],
      groupId: null,
      isActive: true,
    },
    {
      id: 8,
      slug: 'hidden-paket',
      name: 'Hidden Paket',
      price: 50000,
      freeAddonQuota: 1,
      allowedAddonKeys: null,
      groupId: null,
      isActive: false,
    },
    {
      id: 9,
      slug: 'other-collection',
      name: 'Other Collection',
      price: 55000,
      freeAddonQuota: 1,
      allowedAddonKeys: null,
      groupId: 2,
      isActive: true,
    },
    {
      id: 10,
      slug: 'star-only',
      name: 'Star Only',
      price: 60000,
      freeAddonQuota: 2,
      allowedAddonKeys: ['star'],
      groupId: null,
      isActive: true,
    },
  ],
  options: {
    base: { key: 'keychain', label: 'Keychain base', price: 45000, isActive: true },
    addons: [
      { key: 'pearl', label: 'Pearl drop', price: 8000, isActive: true },
      { key: 'star', label: 'Mini star', price: 12000, isActive: true },
      { key: 'initial', label: 'Your initial', price: 5000, isActive: true },
    ],
    clasps: [{ key: 'silver', label: 'Silver clasp', price: 7000, isActive: true }],
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
      configuration: { base: { id: 'heart' }, clasp: { id: 'silver' }, addons: ['pearl', 'star'], initial: '' },
      quantity: 1,
      ...overrides,
    },
  };
}

test('freeAddonIds covers the quota, respects the allow-list and never frees the initial', () => {
  assert.deepEqual(
    pricing.freeAddonIds({ addonIds: ['pearl', 'initial', 'star'], quota: 2 }),
    ['pearl', 'star'],
  );
  assert.deepEqual(
    pricing.freeAddonIds({ addonIds: ['pearl', 'star'], quota: 1 }),
    ['pearl'],
  );
  assert.deepEqual(
    pricing.freeAddonIds({ addonIds: ['pearl', 'star'], quota: 2, allowedAddonKeys: ['star'] }),
    ['star'],
  );
  assert.deepEqual(
    pricing.freeAddonIds({ addonIds: ['pearl'], quota: 0 }),
    [],
    'a zero quota frees nothing',
  );
});

test('calculatePrice charges a bundled add-on Rp 0 and prices the rest normally', () => {
  const withoutBundle = pricing.calculatePrice({
    basePrice: 45000,
    addonIds: ['pearl', 'star'],
    claspPrice: 7000,
  });
  assert.equal(withoutBundle.total, 45000 + 8000 + 12000 + 7000);

  const withBundle = pricing.calculatePrice({
    basePrice: 45000,
    bundle: { price: 60000, freeAddonIds: ['pearl', 'star'] },
    addonIds: ['pearl', 'star'],
    claspPrice: 7000,
  });
  // The bundle price replaces the base, both add-ons are free, the clasp is still charged.
  assert.equal(withBundle.total, 60000 + 7000);
});

test('a valid bundle sets the authoritative total from the live catalogue', () => {
  const result = validateOrderPayload(orderPayload({ bundle: { id: 7 } }), { catalog });

  assert.equal(result.source, 'database');
  assert.equal(result.bundle.slug, 'duo-paket');
  assert.deepEqual(result.bundle.freeAddonIds, ['pearl', 'star']);
  assert.equal(result.quote.total, 67000);
  assert.match(result.productName, /Duo Paket/);
});

test('the same order without a bundle keeps the standard price', () => {
  const result = validateOrderPayload(orderPayload({ bundle: undefined }), { catalog });

  assert.equal(result.bundle, null);
  assert.deepEqual(result.bundle === null ? [] : result.bundle.freeAddonIds, []);
  assert.equal(result.quote.total, 72000);
});

test('the allow-list limits which add-ons a bundle frees', () => {
  const result = validateOrderPayload(orderPayload({ bundle: { id: 10 } }), { catalog });

  assert.deepEqual(result.bundle.freeAddonIds, ['star']);
  // 60000 bundle + 8000 for the pearl outside the allow-list + 7000 clasp.
  assert.equal(result.quote.total, 75000);
});

test('an unknown or spoofed bundle is rejected', () => {
  assert.throws(
    () => validateOrderPayload(orderPayload({ bundle: { id: 999 } }), { catalog }),
    (error) => error instanceof ValidationError && Boolean(error.details.bundle),
  );
  assert.throws(
    () => validateOrderPayload(orderPayload({ bundle: { slug: 'made-up-paket' } }), { catalog }),
    (error) => error instanceof ValidationError && Boolean(error.details.bundle),
  );
});

test('an inactive bundle cannot be used to claim free add-ons', () => {
  assert.throws(
    () => validateOrderPayload(orderPayload({ bundle: { id: 8 } }), { catalog }),
    (error) => error instanceof ValidationError && Boolean(error.details.bundle),
  );
});

test('a bundle scoped to another collection is rejected', () => {
  assert.throws(
    () => validateOrderPayload(orderPayload({ bundle: { id: 9 } }), { catalog }),
    (error) => error instanceof ValidationError && /another collection/i.test(error.details.bundle),
  );
});

test('a bundle submitted against the bundled fallback catalogue is rejected', () => {
  const fallback = { ...catalog, source: 'fallback', bundles: [] };
  assert.throws(
    () => validateOrderPayload(orderPayload({ bundle: { id: 7 } }), { catalog: fallback }),
    (error) => error instanceof ValidationError && Boolean(error.details.bundle),
  );
});

test('migration 009 is a guarded CREATE TABLE IF NOT EXISTS', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'migrations', '009_bundle_packages.sql'),
    'utf8',
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS catalog_bundles/i);
  assert.match(sql, /free_addon_quota/i);
  assert.match(sql, /allowed_addon_keys/i);
  assert.match(sql, /fk_bundle_group/i);
  assert.match(sql, /ON DELETE SET NULL/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE/i, 'the migration must preserve tables and rows');
});

// ---------------------------------------------------------------------------
// The JavaScript migration is checked with a fake MySQL pool, the same way
// tests/migration-upgrade.test.js does it. Each test file runs in its own process.
// ---------------------------------------------------------------------------
process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'bundle-packages-test';
process.env.DB_NAME = 'bundle_packages_test';

const statements = [];

function respond(sql) {
  const query = String(sql).replace(/\s+/g, ' ').trim();
  statements.push(query);

  if (/^SELECT DATABASE\(\) AS databaseName$/i.test(query)) {
    return [[{ databaseName: process.env.DB_NAME }]];
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

// Seeds are out of scope for this check; stubbing them keeps the migration offline.
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

test('the JavaScript migration creates catalog_bundles idempotently', async () => {
  statements.length = 0;
  const first = await runAdditiveMigrations();
  assert.equal(first.success, true);

  const bundleStatement = statements.find((query) => /catalog_bundles/i.test(query));
  assert.ok(bundleStatement, 'the migration must create catalog_bundles');
  assert.match(bundleStatement, /CREATE TABLE IF NOT EXISTS catalog_bundles/i);
  assert.doesNotMatch(bundleStatement, /CREATE TABLE catalog_bundles/i);

  statements.length = 0;
  const second = await runAdditiveMigrations();
  assert.equal(second.success, true);

  const repeat = statements.filter((query) => /CREATE TABLE IF NOT EXISTS catalog_bundles/i.test(query));
  assert.ok(repeat.length >= 1, 'a second run still creates the table through the guarded statement');
  assert.ok(
    !statements.some((query) => /CREATE TABLE catalog_bundles/i.test(query)
      && !/CREATE TABLE IF NOT EXISTS catalog_bundles/i.test(query)),
    'a second run must never emit a plain CREATE TABLE',
  );
});
