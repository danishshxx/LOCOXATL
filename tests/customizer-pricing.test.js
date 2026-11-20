const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const options = require('../src/options.js');
const pricing = require('../src/pricing.js');
const { validateOrderPayload, ValidationError } = require('../src/server/validation.js');

const html = fs.readFileSync(path.join(root, 'studio.html'), 'utf8');
const priceFor = (attribute, value) => {
  const match = html.match(new RegExp(`${attribute}="${value}"[^>]*data-price="(\\d+)"`));
  return match ? Number(match[1]) : null;
};

test('src/options.js stays the single source of truth for add-on and clasp prices shown in the studio', () => {
  for (const addon of options.addons) {
    const domPrice = priceFor('data-addon', addon.id);
    assert.equal(domPrice, addon.price, `${addon.id} price drifted between studio.html and src/options.js`);
  }
  for (const clasp of options.clasps) {
    const domPrice = priceFor('data-clasp', clasp.id);
    assert.equal(domPrice, clasp.price, `${clasp.id} price drifted between studio.html and src/options.js`);
  }
});

test('catalog base prices still drive the base charm price', () => {
  const catalog = require('../src/catalog.js');
  const prices = new Map(catalog.products.map((product) => [product.baseId, product.price]));
  assert.equal(prices.get('heart'), 45000);
  assert.equal(prices.get('star'), 45000);
  assert.equal(prices.get('bow'), 49000);
});

test('the server recomputes the studio total with the existing pricing module', () => {
  const payload = {
    customer: { name: 'Ayu Lestari', phone: '081234567890', email: 'ayu@example.com', address: 'Jl. Merdeka No. 12, Bandung' },
    order: {
      artist: { slug: 'blackpink' },
      product: { slug: 'blackpink-cloud-heart' },
      configuration: {
        base: { id: 'heart' },
        addons: [{ id: 'pearl', name: 'Pearl drop' }, { id: 'star', name: 'Mini star' }],
        initial: 'M',
        clasp: { id: 'silver' },
        components: [{ id: 'base', name: 'Base charm', type: 'base', finish: 'acrylic', visible: true }],
      },
      quantity: 1,
      total: 77000,
    },
  };

  const validated = validateOrderPayload(payload);
  // 45.000 base + 8.000 pearl + 12.000 mini star + 5.000 initial + 7.000 silver clasp
  assert.equal(validated.quote.unitPrice, 77000);
  assert.equal(validated.quote.total, 77000);
  assert.equal(validated.priceAdjusted, false);
  assert.equal(validated.productName, 'Cloud Heart — BLACKPINK');
  assert.equal(validated.configuration.components.length, 1);
});

test('a tampered browser total is corrected instead of trusted', () => {
  const validated = validateOrderPayload({
    customer: { name: 'Ayu', phone: '081234567890', address: 'Jl. Merdeka No. 12, Bandung' },
    order: {
      artist: { slug: 'bts' },
      product: { slug: 'bts-cloud-heart' },
      configuration: { base: { id: 'heart' }, addons: [], initial: '', clasp: { id: 'silver' } },
      quantity: 1,
      total: 1,
    },
  });
  assert.equal(validated.quote.total, 52000);
  assert.equal(validated.priceAdjusted, true);
});

test('the server prices the design named in the order, not a silhouette key', () => {
  const validated = validateOrderPayload({
    customer: { name: 'Ayu', phone: '081234567890', address: 'Jl. Merdeka No. 12, Bandung' },
    order: {
      artist: { slug: 'bts' },
      product: { slug: 'bts-soft-ribbon' },
      configuration: { base: { id: 'bow' }, addons: [], initial: '', clasp: { id: 'silver' } },
      quantity: 1,
      total: 56000,
    },
  });
  assert.equal(validated.quote.total, 56000, 'ribbon design 49.000 + silver clasp 7.000');
  assert.equal(validated.priceAdjusted, false);
  assert.equal(validated.productName, 'Soft Ribbon — BTS');
});

test('invalid orders are rejected with field level details', () => {
  assert.throws(() => validateOrderPayload({ order: {} }), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.ok(error.details.customer_name);
    assert.ok(error.details.product_slug);
    return true;
  });

  assert.throws(() => validateOrderPayload({
    customer: { name: 'Ayu', phone: '081234567890', address: 'Jl. Merdeka No. 12, Bandung' },
    order: {
      product: { slug: 'bts-cloud-heart' },
      configuration: { base: { id: 'heart' }, addons: [{ id: 'diamond' }], clasp: { id: 'gold' } },
      quantity: 0,
    },
  }), (error) => {
    assert.ok(error.details.addons, 'unknown add-on must be rejected');
    assert.ok(error.details.clasp, 'unknown clasp must be rejected');
    assert.ok(error.details.quantity);
    return true;
  });
});

test('the pricing module is still the only calculator used by the studio', () => {
  const studioScript = fs.readFileSync(path.join(root, 'src', 'studio.js'), 'utf8');
  assert.match(studioScript, /pricing\.(calculatePrice|quoteSelections)/);
  assert.doesNotMatch(studioScript, /45000|49000|8000|12000/, 'studio.js must not hardcode prices');
  assert.equal(typeof pricing.calculatePrice, 'function');
});