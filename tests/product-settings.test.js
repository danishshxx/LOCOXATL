const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { validateOrderPayload, ValidationError } = require('../src/server/validation');
const catalog = require('../src/server/catalog');

// One shared keychain: the member supplies the artwork, the base price is global, and
// add-ons/clasp still price through the shared pricing module.

const product = { basePrice: 45000, baseKey: 'keychain' };

function catalogPayload(overrides = {}) {
  return {
    source: 'database',
    groups: [{ slug: 'blackpink', name: 'BLACKPINK', tagline: 'BLINK', isActive: true }],
    members: [{
      slug: 'jisoo', name: 'Jisoo', groupSlug: 'blackpink', isActive: true,
      designImageUrl: '/assets/uploads/catalog/member-design-jisoo-0123456789ab.webp',
    }],
    products: [],
    options: {
      base: { key: 'keychain', label: 'Keychain base', price: 45000, category: 'base' },
      addons: [
        { key: 'pearl', label: 'Pearl drop', price: 8000, category: 'addon' },
        { key: 'initial', label: 'Your initial', price: 5000, category: 'addon' },
      ],
      clasps: [{ key: 'silver', label: 'Silver clasp', price: 7000, category: 'clasp' }],
    },
    product,
    ...overrides,
  };
}

function memberPayload(overrides = {}) {
  return {
    customer: { name: 'Ayu Lestari', phone: '081234567890', address: 'Jl. Merdeka No. 12, Bandung' },
    order: {
      artist: { slug: 'blackpink' },
      member: { slug: 'jisoo' },
      configuration: { base: { id: 'heart' }, addons: [{ id: 'pearl' }], initial: '', clasp: { id: 'silver' } },
      quantity: 1,
      total: 60000,
      ...overrides.order,
    },
    ...overrides,
  };
}

test('a member order prices from the shared base price plus universal options', () => {
  const result = validateOrderPayload(memberPayload(), { catalog: catalogPayload() });

  assert.equal(result.quote.unitPrice, 60000, '45000 base + 8000 pearl + 7000 clasp');
  assert.equal(result.quote.total, 60000);
  assert.equal(result.priceAdjusted, false);
  assert.equal(result.product, null, 'a member order is not a product record');
  assert.equal(result.member.slug, 'jisoo');
  assert.equal(result.member.designImageUrl, '/assets/uploads/catalog/member-design-jisoo-0123456789ab.webp');
  assert.equal(result.productName, 'Jisoo Keychain — BLACKPINK');
});

test('a member order resolves by member id and ignores a legacy silhouette key', () => {
  const payload = memberPayload();
  payload.order.configuration.base = { id: 'star' };
  const result = validateOrderPayload(payload, { catalog: catalogPayload() });

  assert.equal(result.member.slug, 'jisoo');
  assert.equal(result.quote.unitPrice, 60000, 'the design is priced, the base key is not consulted');
});

test('an inactive or mis-parented member is rejected', () => {
  const inactive = catalogPayload({
    members: [{ slug: 'jisoo', name: 'Jisoo', groupSlug: 'blackpink', isActive: false }],
  });
  assert.throws(
    () => validateOrderPayload(memberPayload(), { catalog: inactive }),
    (error) => error instanceof ValidationError && Boolean(error.details.member_slug),
  );

  const otherGroup = catalogPayload({
    groups: [
      { slug: 'blackpink', name: 'BLACKPINK', isActive: true },
      { slug: 'bts', name: 'BTS', isActive: true },
    ],
    members: [{ slug: 'jisoo', name: 'Jisoo', groupSlug: 'bts', isActive: true }],
  });
  assert.throws(
    () => validateOrderPayload(memberPayload(), { catalog: otherGroup }),
    (error) => error instanceof ValidationError && Boolean(error.details.member_slug),
  );
});

test('a legacy product-slug order still validates for backward compatibility', () => {
  const legacy = catalogPayload({
    products: [{
      slug: 'blackpink-cloud-heart', groupSlug: 'blackpink', name: 'Cloud Heart',
      baseId: 'heart', price: 45000, isActive: true,
    }],
  });
  const payload = {
    customer: { name: 'Ayu Lestari', phone: '081234567890', address: 'Jl. Merdeka No. 12, Bandung' },
    order: {
      artist: { slug: 'blackpink' },
      product: { slug: 'blackpink-cloud-heart' },
      configuration: { base: { id: 'heart' }, addons: [], initial: '', clasp: { id: 'silver' } },
      quantity: 1,
      total: 52000,
    },
  };

  const result = validateOrderPayload(payload, { catalog: legacy });
  assert.equal(result.member, null);
  assert.equal(result.quote.unitPrice, 52000);
  assert.equal(result.productName, 'Cloud Heart — BLACKPINK');
});

test('the shared product descriptor exposes the base price without a silhouette', () => {
  const options = catalog.groupPricingOptions([
    { category: 'base', key: 'keychain', label: 'Keychain base', price: 47000, isActive: true, sortOrder: 0 },
    { category: 'addon', key: 'pearl', label: 'Pearl drop', price: 8000, isActive: true, sortOrder: 0 },
    { category: 'clasp', key: 'silver', label: 'Silver clasp', price: 7000, isActive: true, sortOrder: 0 },
  ]);
  assert.equal(options.base.price, 47000);
  assert.deepEqual(options.addons.map((option) => option.key), ['pearl']);
  assert.deepEqual(options.clasps.map((option) => option.key), ['silver']);

  const built = catalog.productFromOptions(options);
  assert.equal(built.basePrice, 47000);
  assert.equal(built.baseKey, 'keychain');
  assert.equal(built.baseLabel, 'Keychain base');
  assert.equal(built.baseModel, undefined, 'no silhouette key is published');

  // An empty table still resolves to the shared base option rather than inventing a shape.
  const empty = catalog.productFromOptions({ base: null });
  assert.equal(empty.basePrice, 45000);
  assert.equal(empty.baseModel, undefined);
});

test('migration 008 is additive, idempotent and keeps catalog_products', () => {
  const sql = fs.readFileSync(
    path.join(root, 'database', 'migrations', '008_catalog_simplification.sql'),
    'utf8',
  );
  const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
  const migrate = fs.readFileSync(path.join(root, 'src', 'server', 'migrate.js'), 'utf8');

  for (const source of [sql, schema, migrate]) {
    assert.match(source, /design_image_url/);
    assert.match(source, /product_settings/);
  }

  assert.match(sql, /ADD COLUMN design_image_url VARCHAR\(512\) NULL AFTER portrait_url/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS product_settings/);
  assert.match(sql, /base_model IN \('heart', 'star', 'bow'\)/);
  assert.match(sql, /INSERT IGNORE INTO product_settings \(id, base_model\) VALUES \(1, 'heart'\)/);
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.match(sql, /option_key = ''keychain'' OR category = ''base''/);
  assert.doesNotMatch(sql, /DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM/i, '008 must never drop or truncate data');
});

test('the server exposes Product Setup and schema-aware health', () => {
  const api = fs.readFileSync(path.join(root, 'src', 'server', 'api.js'), 'utf8');
  assert.match(api, /api\/admin\/product-settings|'product-settings'/);
  assert.match(api, /schemaReady/);
  assert.match(api, /missingTables/);
  assert.match(api, /npm run db:migrate/);
});
