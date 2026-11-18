const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const whatsapp = require('../src/whatsapp.js');
const { validateOrderPayload, ValidationError } = require('../src/server/validation.js');

function baseCatalog(overrides = {}) {
  const catalog = {
    source: 'database',
    groups: [{
      id: 1,
      slug: 'blackpink',
      name: 'BLACKPINK',
      tagline: 'BLINK',
      isActive: true,
      hasVersions: false,
      isCustomDesign: true,
    }],
    members: [{
      id: 5,
      groupId: 1,
      groupSlug: 'blackpink',
      slug: 'jisoo',
      name: 'Jisoo',
      versionKey: 'yellow',
      isActive: true,
      designImageUrl: null,
    }],
    products: [],
    bundles: [],
    optionCategories: [
      { slug: 'addon', name: 'Universal Add-ons', selectionMode: 'multiple', isRequired: false, countsTowardBundleFree: true, sortOrder: 0, isActive: true },
    ],
    options: {
      base: { key: 'keychain', label: 'Keychain base', price: 45000, isActive: true },
      addons: [],
      clasps: [],
      items: [
        { key: 'pearl', category: 'addon', label: 'Pearl drop', price: 8000, isActive: true },
      ],
    },
    paymentMethods: [
      { code: 'qris', label: 'QRIS', instructions: 'Scan the code.', imageUrl: null, isActive: true, sortOrder: 0 },
      { code: 'cash', label: 'Cash', instructions: 'Pay in person.', imageUrl: null, isActive: true, sortOrder: 1 },
      { code: 'transfer', label: 'Bank Transfer', instructions: 'Transfer to BCA 123.', imageUrl: null, isActive: false, sortOrder: 2 },
    ],
    product: { baseModel: 'heart', baseLabel: 'Heart', basePrice: 45000 },
  };
  return { ...catalog, ...overrides };
}

function orderPayload(orderOverrides = {}) {
  return {
    customer: {
      name: 'Test Buyer',
      phone: '0812345678',
      email: '',
      address: 'Jl. Merdeka 10, Bandung',
      note: '',
    },
    order: {
      artist: { slug: 'blackpink' },
      member: { slug: 'jisoo' },
      configuration: {
        base: { id: 'heart' },
        addons: [],
        selections: { addon: [], clasp: [] },
        initial: '',
      },
      quantity: 1,
      ...orderOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Migration 012
// ---------------------------------------------------------------------------

test('migration 012 guards every addition with INFORMATION_SCHEMA', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'migrations', '012_payments_fulfillment_custom_groups.sql'),
    'utf8',
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS payment_methods/i);
  assert.match(sql, /WHERE NOT EXISTS \(SELECT 1 FROM payment_methods\)/i);
  assert.match(sql, /'qris'/i);
  assert.match(sql, /'cash'/i);
  assert.match(sql, /'transfer'/i);

  const guards = sql.match(/SELECT COUNT\(\*\) FROM INFORMATION_SCHEMA\.COLUMNS/gi) || [];
  assert.equal(guards.length, 4, 'two group columns and two order columns each get a guard');
  assert.match(sql, /ADD COLUMN has_versions TINYINT\(1\) NOT NULL DEFAULT 1/i);
  assert.match(sql, /ADD COLUMN is_custom_design TINYINT\(1\) NOT NULL DEFAULT 0/i);
  assert.match(sql, /ADD COLUMN fulfillment_method VARCHAR\(32\) NOT NULL DEFAULT ''?campus_delivery''?/i);
  assert.match(sql, /ADD COLUMN payment_method VARCHAR\(32\) NULL/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DROP COLUMN/i);
});

// The JavaScript migration, checked against a fake pool the way the other migration tests do it.
process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'payments-test';
process.env.DB_NAME = 'payments_test';

const statements = [];

function respond(sql) {
  const query = String(sql).replace(/\s+/g, ' ').trim();
  statements.push(query);
  if (/^SELECT DATABASE\(\) AS databaseName$/i.test(query)) {
    return [[{ databaseName: process.env.DB_NAME }]];
  }
  if (/^SELECT COUNT\(\*\) AS total FROM payment_methods$/i.test(query)) {
    return [[{ total: 0 }]];
  }
  if (/^SELECT COUNT\(\*\) AS total FROM option_categories$/i.test(query)) {
    return [[{ total: 3 }]];
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

test('the JavaScript migration creates and seeds payment methods idempotently', async () => {
  statements.length = 0;
  const first = await runAdditiveMigrations();
  assert.equal(first.success, true);

  assert.ok(
    statements.some((query) => /CREATE TABLE IF NOT EXISTS payment_methods/i.test(query)),
    'payment_methods must be created',
  );
  assert.ok(
    statements.some((query) => /INSERT IGNORE INTO payment_methods/i.test(query)),
    'an empty table must be seeded',
  );
  assert.ok(
    statements.some((query) => /ADD COLUMN has_versions/i.test(query)),
    'catalog_groups.has_versions must be added',
  );
  assert.ok(
    statements.some((query) => /ADD COLUMN is_custom_design/i.test(query)),
    'catalog_groups.is_custom_design must be added',
  );
  assert.ok(
    statements.some((query) => /ADD COLUMN fulfillment_method/i.test(query)),
    'orders.fulfillment_method must be added',
  );
  assert.ok(
    statements.some((query) => /ADD COLUMN payment_method/i.test(query)),
    'orders.payment_method must be added',
  );

  statements.length = 0;
  const second = await runAdditiveMigrations();
  assert.equal(second.success, true);
  assert.ok(
    statements.some((query) => /CREATE TABLE IF NOT EXISTS payment_methods/i.test(query)),
    'a second run repeats only the guarded create',
  );
  assert.ok(
    !statements.some((query) => /CREATE TABLE payment_methods/i.test(query)
      && !/CREATE TABLE IF NOT EXISTS payment_methods/i.test(query)),
    'a second run must never emit a plain CREATE TABLE',
  );
});

// ---------------------------------------------------------------------------
// Version bypass for groups without a Yellow/Pink step
// ---------------------------------------------------------------------------

test('a group without versions accepts an order with no version key', () => {
  const result = validateOrderPayload(orderPayload({ fulfillmentMethod: 'campus_delivery', paymentMethod: 'qris' }), {
    catalog: baseCatalog(),
  });

  assert.equal(result.quote.total, 45000);
  assert.equal(result.version, 'yellow', 'the design keeps its stored version');
});

test('a version is still rejected when it contradicts the design', () => {
  assert.throws(
    () => validateOrderPayload(orderPayload({
      version: 'pink',
      fulfillmentMethod: 'campus_delivery',
      paymentMethod: 'qris',
    }), { catalog: baseCatalog() }),
    (error) => error instanceof ValidationError && Boolean(error.details.version),
  );
});

// ---------------------------------------------------------------------------
// Fulfillment and payment method validation
// ---------------------------------------------------------------------------

test('campus delivery accepts an active payment method', () => {
  const result = validateOrderPayload(orderPayload({ fulfillmentMethod: 'campus_delivery', paymentMethod: 'cash' }), {
    catalog: baseCatalog(),
  });

  assert.equal(result.fulfillmentMethod, 'campus_delivery');
  assert.equal(result.paymentMethod, 'cash');
});

test('cod_telkom accepts an active payment method', () => {
  const result = validateOrderPayload(orderPayload({ fulfillmentMethod: 'cod_telkom', paymentMethod: 'qris' }), {
    catalog: baseCatalog(),
  });

  assert.equal(result.fulfillmentMethod, 'cod_telkom');
  assert.equal(result.paymentMethod, 'qris');
});

test('a deactivated payment method is refused', () => {
  assert.throws(
    () => validateOrderPayload(orderPayload({ fulfillmentMethod: 'campus_delivery', paymentMethod: 'transfer' }), {
      catalog: baseCatalog(),
    }),
    (error) => error instanceof ValidationError && Boolean(error.details.payment_method),
  );
});

test('a campus order without a payment method is refused', () => {
  assert.throws(
    () => validateOrderPayload(orderPayload({ fulfillmentMethod: 'cod_telkom' }), { catalog: baseCatalog() }),
    (error) => error instanceof ValidationError && Boolean(error.details.payment_method),
  );
});

test('shopee external never carries a payment method', () => {
  const result = validateOrderPayload(orderPayload({
    fulfillmentMethod: 'shopee_external',
    paymentMethod: 'qris',
  }), { catalog: baseCatalog() });

  assert.equal(result.fulfillmentMethod, 'shopee_external');
  assert.equal(result.paymentMethod, null, 'Shopee is settled off-site');
});

test('an unknown fulfillment option is refused', () => {
  assert.throws(
    () => validateOrderPayload(orderPayload({ fulfillmentMethod: 'drone_drop', paymentMethod: 'qris' }), {
      catalog: baseCatalog(),
    }),
    (error) => error instanceof ValidationError && Boolean(error.details.fulfillment_method),
  );
});

test('a catalogue without payment methods falls back to the bundled defaults', () => {
  const catalog = baseCatalog();
  delete catalog.paymentMethods;

  const result = validateOrderPayload(orderPayload({ fulfillmentMethod: 'campus_delivery', paymentMethod: 'transfer' }), {
    catalog,
  });

  assert.equal(result.paymentMethod, 'transfer');
});

// ---------------------------------------------------------------------------
// WhatsApp messages for the Shopee and custom design paths
// ---------------------------------------------------------------------------

test('the Shopee message carries the item, total and the checkout link request', () => {
  const message = whatsapp.buildShopeeMessage({
    selection: 'Jisoo keychain · Pearl drop',
    artist: 'BLACKPINK',
    total: 'Rp60.000',
  });

  assert.match(message, /Shopee/);
  assert.match(message, /Jisoo keychain/);
  assert.match(message, /Rp60\.000/);
  assert.match(message, /link CO Shopee/i);
});

test('the custom design message asks for the file after payment', () => {
  const message = whatsapp.buildCustomDesignMessage('Jisoo');

  assert.match(message, /custom design/i);
  assert.match(message, /pembayaran/i);
  assert.match(message, /Jisoo/);
});

test('the chat link uses the configured number', () => {
  const url = whatsapp.buildChatUrl('628123456789', whatsapp.buildShopeeMessage({ total: 'Rp1' }));
  assert.match(url, /^https:\/\/wa\.me\/628123456789\?text=/);
});
