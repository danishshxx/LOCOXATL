const test = require('node:test');
const assert = require('node:assert/strict');

// A guest cart posts one `items` array. Every line is validated and priced by the same code path
// the single-item order already used, so a multi-item order cannot smuggle in a design, an option
// or a price the single-item path would have refused.

process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '1';
process.env.DB_USER = 'multi-item-test';
process.env.DB_PASSWORD = '';
process.env.DB_NAME = 'locoxatl_multi_item_test';

const { validateOrderPayload, ValidationError, MAX_ITEMS } = require('../src/server/validation.js');

function catalog(overrides = {}) {
  return {
    source: 'database',
    groups: [{ id: 1, slug: 'blackpink', name: 'BLACKPINK', tagline: 'BLINK', isActive: true }],
    members: [
      { id: 5, groupId: 1, groupSlug: 'blackpink', slug: 'jisoo', name: 'Jisoo', versionKey: 'yellow', isActive: true, designImageUrl: null, priceOverride: null },
      { id: 6, groupId: 1, groupSlug: 'blackpink', slug: 'lisa', name: 'Lisa', versionKey: 'yellow', isActive: true, designImageUrl: null, priceOverride: 50000 },
    ],
    products: [],
    bundles: [{ id: 7, slug: 'duo-paket', name: 'Duo Paket', price: 60000, freeAddonQuota: 1, allowedAddonKeys: null, isActive: true, groupId: null }],
    optionCategories: [
      { slug: 'addon', name: 'Universal Add-ons', selectionMode: 'multiple', isRequired: false, countsTowardBundleFree: true, sortOrder: 0 },
      { slug: 'clasp', name: 'Clasps', selectionMode: 'single', isRequired: true, countsTowardBundleFree: false, sortOrder: 1 },
    ],
    options: {
      base: { key: 'keychain', label: 'Keychain base', price: 45000, isActive: true },
      items: [
        { key: 'pearl', category: 'addon', label: 'Pearl drop', price: 8000, isActive: true },
        { key: 'initial', category: 'addon', label: 'Your initial', price: 5000, isActive: true, personalization: true },
        { key: 'silver', category: 'clasp', label: 'Silver clasp', price: 7000, isActive: true },
        { key: 'black', category: 'clasp', label: 'Black clasp', price: 5000, isActive: true },
      ],
    },
    paymentMethods: [
      { code: 'qris', label: 'QRIS', isActive: true },
      { code: 'cash', label: 'Cash', isActive: true },
    ],
    product: { basePrice: 45000 },
    ...overrides,
  };
}

const CUSTOMER = {
  name: 'Ayu Lestari',
  phone: '081234567890',
  email: 'ayu@example.com',
  address: 'Jl. Merdeka No. 12, Bandung',
};

function line(overrides = {}) {
  return {
    artist: { slug: 'blackpink' },
    member: { slug: 'jisoo' },
    version: 'yellow',
    configuration: {
      base: { id: 'jisoo' },
      addons: [{ id: 'pearl' }],
      selections: { addon: ['pearl'], clasp: ['silver'] },
      clasp: { id: 'silver' },
    },
    quantity: 1,
    total: 60000,
    ...overrides,
  };
}

function order(items, overrides = {}) {
  return {
    customer: { ...CUSTOMER },
    fulfillmentMethod: 'campus_delivery',
    paymentMethod: 'qris',
    items,
    total: items.reduce((sum, item) => sum + (Number(item.total) || 0), 0),
    ...overrides,
  };
}

test('every line is priced from the live catalogue and the order total is their sum', () => {
  const result = validateOrderPayload(order([
    line(),
    line({
      member: { slug: 'lisa' },
      configuration: { base: { id: 'lisa' }, addons: [], selections: { addon: [], clasp: ['black'] }, clasp: { id: 'black' } },
      total: 55000,
    }),
  ]), { catalog: catalog() });

  assert.equal(result.items.length, 2);
  // 45.000 base + 8.000 pearl + 7.000 silver clasp
  assert.equal(result.items[0].quote.unitPrice, 60000);
  // 50.000 member override + 5.000 black clasp
  assert.equal(result.items[1].quote.unitPrice, 55000);
  assert.equal(result.total, 115000);
  assert.equal(result.priceAdjusted, false);
  assert.equal(result.productName, 'Jisoo Keychain — BLACKPINK + Lisa Keychain — BLACKPINK');
});

test('a quantity multiplies only its own line', () => {
  const result = validateOrderPayload(order([
    line({ quantity: 2, total: 120000 }),
    line({ member: { slug: 'lisa' }, configuration: { base: { id: 'lisa' }, addons: [], selections: { addon: [], clasp: ['silver'] } }, total: 57000 }),
  ]), { catalog: catalog() });

  assert.equal(result.items[0].quote.total, 120000);
  assert.equal(result.items[1].quote.total, 57000);
  assert.equal(result.total, 177000);
});

test('a tampered multi-item total is replaced by the server total', () => {
  const result = validateOrderPayload(order([
    line(),
    line({ member: { slug: 'lisa' } }),
  ], { total: 1000 }), { catalog: catalog() });

  // 60.000 (Jisoo) + 65.000 (Lisa override 50.000 + pearl 8.000 + silver 7.000)
  assert.equal(result.total, 125000);
  assert.equal(result.priceAdjusted, true);
});

test('a disabled member, option or clasp is rejected on the line that carries it', () => {
  const live = catalog();
  live.members = live.members.filter((member) => member.slug !== 'lisa');

  assert.throws(
    () => validateOrderPayload(order([line(), line({ member: { slug: 'lisa' } })]), { catalog: live }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.details['items[1].member_slug'], 'the failing line is named');
      assert.equal(error.details['items[0].member_slug'], undefined, 'the healthy line is not blamed');
      return true;
    },
  );

  const noPearl = catalog();
  noPearl.options.items = noPearl.options.items.filter((item) => item.key !== 'pearl');
  assert.throws(
    () => validateOrderPayload(order([line()]), { catalog: noPearl }),
    (error) => {
      assert.ok(error.details['items[0].addons']);
      return true;
    },
  );

  const noBlack = catalog();
  noBlack.options.items = noBlack.options.items.filter((item) => item.key !== 'black');
  assert.throws(
    () => validateOrderPayload(order([line({ configuration: { base: { id: 'jisoo' }, addons: [], selections: { addon: [], clasp: ['black'] } } })]), { catalog: noBlack }),
    (error) => {
      assert.ok(error.details['items[0].clasp']);
      return true;
    },
  );
});

test('a dead custom category or bundle is rejected per line', () => {
  assert.throws(
    () => validateOrderPayload(order([line({
      configuration: {
        base: { id: 'jisoo' },
        addons: [],
        selections: { addon: [], clasp: ['silver'], 'silicone-strap': ['strap-white'] },
      },
    })]), { catalog: catalog() }),
    (error) => Boolean(error.details['items[0].silicone-strap']),
  );

  assert.throws(
    () => validateOrderPayload(order([line({ bundle: { id: 999 } })]), { catalog: catalog() }),
    (error) => Boolean(error.details['items[0].bundle']),
  );
});

test('an empty or oversized item list is rejected', () => {
  assert.throws(
    () => validateOrderPayload(order([]), { catalog: catalog() }),
    (error) => Boolean(error.details.items),
  );

  const many = Array.from({ length: MAX_ITEMS + 1 }, () => line());
  assert.throws(
    () => validateOrderPayload(order(many), { catalog: catalog() }),
    (error) => Boolean(error.details.items),
  );
});

test('an invalid quantity on any line is reported with its index', () => {
  assert.throws(
    () => validateOrderPayload(order([line({ quantity: 0 })]), { catalog: catalog() }),
    (error) => Boolean(error.details['items[0].quantity']),
  );
  assert.throws(
    () => validateOrderPayload(order([line({ quantity: 1.5 })]), { catalog: catalog() }),
    (error) => Boolean(error.details['items[0].quantity']),
  );
});

test('delivery and payment are decided once for the whole order', () => {
  const result = validateOrderPayload(order([line(), line({ member: { slug: 'lisa' } })], {
    fulfillmentMethod: 'cod_telkom',
    paymentMethod: 'cash',
  }), { catalog: catalog() });

  assert.equal(result.fulfillmentMethod, 'cod_telkom');
  assert.equal(result.paymentMethod, 'cash');
  assert.equal(result.items.length, 2);

  assert.throws(
    () => validateOrderPayload(order([line()], { paymentMethod: 'crypto' }), { catalog: catalog() }),
    (error) => Boolean(error.details.payment_method),
  );
});

test('a legacy single-item payload still validates and reports one line', () => {
  const result = validateOrderPayload({
    customer: { ...CUSTOMER },
    order: {
      artist: { slug: 'blackpink' },
      member: { slug: 'jisoo' },
      configuration: { base: { id: 'jisoo' }, addons: [{ id: 'pearl' }], clasp: { id: 'silver' } },
      quantity: 1,
      total: 60000,
    },
  }, { catalog: catalog() });

  assert.equal(result.items.length, 1);
  assert.equal(result.quantity, 1);
  assert.equal(result.quote.unitPrice, 60000);
  assert.equal(result.productName, 'Jisoo Keychain — BLACKPINK');
});

// ---------------------------------------------------------------------------
// Persistence: one order_items row per line, inside the same transaction
// ---------------------------------------------------------------------------

const mysqlPath = require.resolve('mysql2/promise');
const calls = [];
let scripted = [];

function handleStatement(sql, params) {
  calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  if (/FROM catalog_groups/i.test(sql)) return [[]];
  if (/FROM artist_members/i.test(sql)) return [[]];
  if (/FROM catalog_products/i.test(sql)) return [[]];
  if (/FROM pricing_options/i.test(sql)) return [[]];
  if (/FROM option_categories/i.test(sql)) return [[]];
  if (/FROM catalog_bundles/i.test(sql)) return [[]];
  if (/FROM payment_methods/i.test(sql)) return [[]];
  const next = scripted.shift();
  if (next instanceof Error) throw next;
  if (next) return next;
  if (/^INSERT/i.test(sql.trim())) return [{ insertId: calls.length, affectedRows: 1 }];
  return [[]];
}

const connection = {
  async beginTransaction() { calls.push({ sql: 'BEGIN' }); },
  async commit() { calls.push({ sql: 'COMMIT' }); },
  async rollback() { calls.push({ sql: 'ROLLBACK' }); },
  release() {},
  execute: handleStatement,
  query: handleStatement,
};

require.cache[mysqlPath] = {
  id: mysqlPath,
  filename: mysqlPath,
  loaded: true,
  exports: {
    createPool() {
      return {
        execute: handleStatement,
        query: handleStatement,
        async getConnection() { return connection; },
        async end() {},
      };
    },
  },
};

test('a multi-item order writes one order_items row per line with its own price', async () => {
  calls.length = 0;
  scripted = [];
  const orders = require('../src/server/orders.js');

  // No database: loadCatalog() falls back to the bundled catalogue, which is what the fake
  // pool below describes. Two designs from the same collection keep the check strict.
  const created = await orders.createOrder({
    customer: { ...CUSTOMER },
    fulfillmentMethod: 'campus_delivery',
    paymentMethod: 'qris',
    items: [
      {
        artist: { slug: 'blackpink' },
        product: { slug: 'blackpink-cloud-heart' },
        configuration: { base: { id: 'heart' }, addons: [{ id: 'pearl' }], selections: { addon: ['pearl'], clasp: ['silver'] } },
        quantity: 1,
        total: 60000,
      },
      {
        artist: { slug: 'blackpink' },
        product: { slug: 'blackpink-soft-ribbon' },
        configuration: { base: { id: 'bow' }, addons: [], selections: { addon: [], clasp: ['black'] } },
        quantity: 2,
        total: 108000,
      },
    ],
    total: 168000,
  });

  const itemInserts = calls.filter((call) => /^INSERT INTO order_items/.test(call.sql));
  assert.equal(itemInserts.length, 2, 'every line is persisted');
  assert.equal(itemInserts[0].params[8], 60000, 'unit price of the first line');
  assert.equal(itemInserts[1].params[8], 54000, 'unit price of the second line');
  assert.equal(itemInserts[1].params[7], 2, 'the line keeps its own quantity');
  assert.equal(itemInserts[1].params[10], 108000, 'line total honours the quantity');
  assert.equal(itemInserts[0].params[1], 'Cloud Heart — BLACKPINK');
  assert.equal(itemInserts[0].params[5], 'BLACKPINK', 'the collection name is stored with the line');

  const orderInsert = calls.find((call) => /^INSERT INTO orders/.test(call.sql));
  assert.equal(orderInsert.params[8], 168000, 'the order header carries the summed total, not the first line');

  const configInserts = calls.filter((call) => /^INSERT INTO customizer_configurations/.test(call.sql));
  assert.equal(configInserts.length, 2, 'each line keeps its configuration snapshot');

  assert.equal(created.items.length, 2);
  assert.equal(created.total, 168000);
  assert.equal(created.status, 'waiting_for_payment');
});
