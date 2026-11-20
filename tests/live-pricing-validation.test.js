const test = require('node:test');
const assert = require('node:assert/strict');

// Order validation against the live catalogue: the database decides which designs exist and
// what they cost, and the client's submitted total is never trusted.

const pricing = require('../src/pricing.js');
const options = require('../src/options.js');
const { validateOrderPayload, ValidationError } = require('../src/server/validation.js');

const liveCatalog = {
  source: 'database',
  groups: [
    { id: 1, slug: 'blackpink', name: 'BLACKPINK', tagline: 'BLINK', isActive: true },
    { id: 2, slug: 'bts', name: 'BTS', tagline: 'ARMY', isActive: true },
  ],
  products: [
    { id: 10, groupId: 1, groupSlug: 'blackpink', groupName: 'BLACKPINK', slug: 'blackpink-cloud-heart', key: 'cloud-heart', name: 'Cloud Heart', templateKey: 'acrylic-keychain', baseId: 'heart', description: '', price: 47000, isActive: true, sortOrder: 0 },
    { id: 11, groupId: 1, groupSlug: 'blackpink', groupName: 'BLACKPINK', slug: 'blackpink-soft-ribbon', key: 'soft-ribbon', name: 'Soft Ribbon', templateKey: 'phone-charm', baseId: 'bow', description: '', price: 51000, isActive: true, sortOrder: 1 },
    { id: 20, groupId: 2, groupSlug: 'bts', groupName: 'BTS', slug: 'bts-cloud-heart', key: 'cloud-heart', name: 'Cloud Heart', templateKey: 'acrylic-keychain', baseId: 'heart', description: '', price: 47000, isActive: true, sortOrder: 0 },
  ],
  options: {
    addons: [
      { key: 'pearl', price: 9000, isActive: true },
      { key: 'star', price: 13000, isActive: true },
      { key: 'initial', price: 6000, isActive: true },
    ],
    clasps: [{ key: 'silver', price: 8500, isActive: true }],
  },
};

const CUSTOMER = { name: 'Ayu Lestari', phone: '081234567890', email: 'ayu@example.com', address: 'Jl. Merdeka No. 12, Bandung' };

function order(overrides = {}) {
  return {
    customer: { ...CUSTOMER },
    order: {
      artist: { slug: 'blackpink' },
      product: { slug: 'blackpink-cloud-heart' },
      configuration: { base: { id: 'heart' }, addons: [], initial: '', clasp: { id: 'silver' } },
      quantity: 1,
      total: 0,
      ...overrides,
    },
  };
}

test('the server prices a live order from the database base price and pricing_options', () => {
  const validated = validateOrderPayload(order({
    configuration: {
      base: { id: 'heart' },
      addons: [{ id: 'pearl' }, { id: 'star' }],
      initial: 'M',
      clasp: { id: 'silver' },
    },
  }), { catalog: liveCatalog });

  // 47.000 base + 9.000 pearl + 13.000 star + 6.000 initial + 8.500 clasp
  assert.equal(validated.quote.unitPrice, 83500);
  assert.equal(validated.quote.total, 83500);
  assert.equal(validated.source, 'database');
  assert.equal(validated.productName, 'Cloud Heart — BLACKPINK');
  assert.equal(validated.product.price, 47000, 'the design price comes from base_price');
});

test('a tampered client total is replaced by the live total', () => {
  const cheap = validateOrderPayload(order({ total: 1000 }), { catalog: liveCatalog });
  assert.equal(cheap.quote.total, 55500, '47.000 base + 8.500 silver clasp');
  assert.equal(cheap.priceAdjusted, true);

  const honest = validateOrderPayload(order({ total: 55500 }), { catalog: liveCatalog });
  assert.equal(honest.priceAdjusted, false);
});

test('a design is resolved by product id inside the same collection', () => {
  const validated = validateOrderPayload(order({
    product: { id: 11 },
    configuration: { base: { id: 'bow' }, addons: [], initial: '', clasp: { id: 'silver' } },
    total: 59500,
  }), { catalog: liveCatalog });

  assert.equal(validated.product.slug, 'blackpink-soft-ribbon');
  assert.equal(validated.productName, 'Soft Ribbon — BLACKPINK');
  assert.equal(validated.quote.total, 59500, '51.000 ribbon + 8.500 clasp');
  assert.equal(validated.priceAdjusted, false);
});

test('a stale silhouette key never changes which design is priced', () => {
  const validated = validateOrderPayload(order({
    product: { slug: 'blackpink-cloud-heart' },
    configuration: { base: { id: 'bow' }, addons: [], initial: '', clasp: { id: 'silver' } },
    total: 55500,
  }), { catalog: liveCatalog });

  assert.equal(validated.product.slug, 'blackpink-cloud-heart');
  assert.equal(validated.quote.total, 55500, 'the named design is priced, not the base key');
});

test('a design from another collection is rejected', () => {
  assert.throws(
    () => validateOrderPayload(order({ product: { slug: 'bts-cloud-heart' } }), { catalog: liveCatalog }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.match(error.details.product_slug, /does not belong/);
      return true;
    },
  );
});

test('a hidden design or collection cannot be ordered', () => {
  assert.throws(
    () => validateOrderPayload(order({ product: { slug: 'blackpink-orbit-star' } }), { catalog: liveCatalog }),
    (error) => {
      assert.ok(error.details.product_slug);
      return true;
    },
  );

  assert.throws(
    () => validateOrderPayload(order({ artist: { slug: 'twice' }, product: { slug: 'twice-cloud-heart' } }), { catalog: liveCatalog }),
    (error) => {
      assert.ok(error.details.artist_slug, 'a collection missing from the database is not orderable');
      return true;
    },
  );
});

test('without a live catalogue the bundled prices still apply', () => {
  const validated = validateOrderPayload(order({
    configuration: { base: { id: 'heart' }, addons: [{ id: 'pearl' }], initial: '', clasp: { id: 'silver' } },
    total: 60000,
  }));

  // 45.000 bundled base + 8.000 pearl + 7.000 silver clasp
  assert.equal(validated.quote.total, 60000);
  assert.equal(validated.priceAdjusted, false);
  assert.equal(validated.source, 'bundled');
});

test('calculatePrice resolves ids through an optional pricing table', () => {
  const table = { addons: [{ key: 'pearl', price: 9100 }, { key: 'initial', price: 6100 }], clasps: [{ key: 'black', price: 5100 }] };

  const withTable = pricing.calculatePrice({
    basePrice: 50000,
    addonIds: ['pearl'],
    claspId: 'black',
    initial: 'A',
    pricing: table,
    quantity: 2,
  });
  assert.equal(withTable.unitPrice, 50000 + 9100 + 5100 + 6100);
  assert.equal(withTable.total, 140600);

  // Omitting the table keeps the bundled src/options.js prices.
  const bundled = pricing.calculatePrice({ basePrice: 50000, addonIds: ['pearl'], claspId: 'black', initial: 'A' });
  assert.equal(bundled.unitPrice, 50000 + 8000 + 5000 + 5000);
});

test('src/options.js quote accepts a live table too', () => {
  const table = { addons: [{ key: 'pearl', price: 9900, name: 'Pearl drop' }], clasps: [{ key: 'silver', price: 8800, name: 'Silver' }] };
  const quote = options.quote({ basePrice: 40000, addonIds: ['pearl'], claspId: 'silver', pricing: table });
  assert.equal(quote.total, 40000 + 9900 + 8800);

  const fallback = options.quote({ basePrice: 40000, addonIds: ['pearl'], claspId: 'silver' });
  assert.equal(fallback.total, 40000 + 8000 + 7000);
});
