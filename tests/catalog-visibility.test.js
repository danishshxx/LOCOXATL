const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Live visibility: a row the dashboard switches off must leave the public catalogue, the studio,
// the checkout and the order API, while the admin loaders keep showing it.

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'catalog-visibility-test';
process.env.DB_NAME = 'catalog_visibility_test';

function seededState() {
  return {
    groups: [
      { id: 1, slug: 'blackpink', name: 'BLACKPINK', tagline: '', eyebrow: '', description: '', image_url: null, hero_image_url: null, cover_focal: '50% 50%', hero_focal: '50% 50%', versions_json: null, has_versions: 1, is_custom_design: 0, is_active: 1, sort_order: 0 },
      { id: 2, slug: 'retired', name: 'Retired', tagline: '', eyebrow: '', description: '', image_url: null, hero_image_url: null, cover_focal: '50% 50%', hero_focal: '50% 50%', versions_json: null, has_versions: 1, is_custom_design: 0, is_active: 0, sort_order: 1 },
    ],
    members: [
      { id: 1, group_id: 1, slug: 'jisoo', name: 'Jisoo', portrait_url: null, design_image_url: null, price_override: null, version_key: 'yellow', is_active: 1, sort_order: 0 },
      { id: 2, group_id: 1, slug: 'rose', name: 'Rose', portrait_url: null, design_image_url: null, price_override: null, version_key: 'yellow', is_active: 0, sort_order: 1 },
      { id: 3, group_id: 2, slug: 'ghost', name: 'Ghost', portrait_url: null, design_image_url: null, price_override: null, version_key: 'yellow', is_active: 1, sort_order: 0 },
    ],
    products: [
      { id: 1, group_id: 1, slug: 'cloud-heart', name: 'Cloud Heart', template_key: 'heart', version_key: 'yellow', description: '', base_price: 45000, price_override: null, image_url: null, is_active: 1, sort_order: 0 },
      { id: 2, group_id: 1, slug: 'old-star', name: 'Old Star', template_key: 'star', version_key: 'yellow', description: '', base_price: 45000, price_override: null, image_url: null, is_active: 0, sort_order: 1 },
    ],
    options: [
      { id: 1, category: 'base', option_key: 'keychain', label: 'Keychain', price: 45000, is_active: 1, sort_order: 0 },
      { id: 2, category: 'addon', option_key: 'pearl', label: 'Pearl drop', price: 8000, is_active: 1, sort_order: 0 },
      { id: 6, category: 'addon', option_key: 'star', label: 'Mini star', price: 12000, is_active: 1, sort_order: 1 },
      { id: 3, category: 'addon', option_key: 'initial', label: 'Initial', price: 5000, is_active: 0, sort_order: 2 },
      { id: 4, category: 'clasp', option_key: 'silver', label: 'Silver clasp', price: 7000, is_active: 1, sort_order: 0 },
      { id: 5, category: 'strap', option_key: 'silicone', label: 'Silicone strap', price: 0, is_active: 1, sort_order: 0 },
    ],
    categories: [
      { id: 1, slug: 'addon', name: 'Add-ons', selection_mode: 'multiple', is_required: 0, counts_toward_bundle_free: 1, bundle_included: 0, sort_order: 0, is_active: 1 },
      { id: 2, slug: 'clasp', name: 'Clasps', selection_mode: 'single', is_required: 1, counts_toward_bundle_free: 0, bundle_included: 0, sort_order: 1, is_active: 1 },
      { id: 3, slug: 'strap', name: 'Straps', selection_mode: 'single', is_required: 0, counts_toward_bundle_free: 0, bundle_included: 0, sort_order: 2, is_active: 0 },
    ],
    bundles: [
      { id: 1, group_id: null, slug: 'duo', name: 'Duo', description: '', bundle_price: 60000, free_addon_quota: 1, allowed_addon_keys: null, image_url: null, is_active: 1, sort_order: 0 },
      { id: 2, group_id: null, slug: 'retired-pack', name: 'Retired pack', description: '', bundle_price: 60000, free_addon_quota: 1, allowed_addon_keys: null, image_url: null, is_active: 0, sort_order: 1 },
      { id: 3, group_id: 2, slug: 'hidden-group-pack', name: 'Hidden group pack', description: '', bundle_price: 60000, free_addon_quota: 1, allowed_addon_keys: null, image_url: null, is_active: 1, sort_order: 2 },
    ],
    payments: [
      { id: 1, code: 'qris', label: 'QRIS', instructions: 'Scan.', image_url: null, is_active: 1, sort_order: 0 },
    ],
  };
}

const state = seededState();

// The fake honours `WHERE is_active = 1` the way MySQL would, so a query that forgot the filter
// shows up as a leak in the assertions instead of being masked by the fake.
async function execute(sql, params = []) {
  const query = sql.replace(/\s+/g, ' ').trim();
  const activeOnly = /is_active = 1/i.test(query);
  const pick = (rows) => [rows.filter((row) => !activeOnly || row.is_active).map((row) => ({ ...row }))];

  // Members first: their query carries a `catalog_groups` subquery that would otherwise match the
  // group branch below.
  if (/FROM artist_members/i.test(query)) {
    const rows = state.members.filter((row) => !activeOnly || row.is_active);
    const liveGroups = new Set(state.groups.filter((row) => row.is_active).map((row) => row.id));
    return [rows.filter((row) => !activeOnly || liveGroups.has(row.group_id)).map((row) => ({ ...row }))];
  }
  if (/FROM catalog_groups/i.test(query)) return pick(state.groups);
  if (/FROM catalog_products/i.test(query)) {
    const ids = Array.isArray(params[0]) ? params[0] : null;
    const rows = state.products.filter((row) => !activeOnly || row.is_active);
    return [rows.filter((row) => !ids || ids.includes(row.group_id)).map((row) => ({ ...row }))];
  }
  if (/FROM pricing_options WHERE id = \?/i.test(query)) {
    const row = state.options.find((entry) => entry.id === Number(params[0]));
    return [row ? [{ ...row }] : []];
  }
  if (/FROM pricing_options/i.test(query)) return pick(state.options);
  if (/^UPDATE pricing_options SET/i.test(query)) {
    const row = state.options.find((entry) => entry.id === Number(params[params.length - 1]));
    if (!row) return [{ affectedRows: 0 }];
    const assignments = query.match(/SET (.*) WHERE/i)[1].split(',').map((part) => part.trim());
    assignments.forEach((assignment, index) => {
      row[assignment.split('=')[0].trim()] = params[index];
    });
    return [{ affectedRows: 1 }];
  }
  if (/FROM option_categories/i.test(query)) return pick(state.categories);
  if (/FROM catalog_bundles/i.test(query)) return pick(state.bundles);
  if (/FROM product_settings/i.test(query)) return [[{ id: 1, updated_at: '2026-01-01T00:00:00Z' }]];
  if (/FROM payment_methods/i.test(query)) return pick(state.payments);

  throw new Error(`Unexpected catalogue visibility SQL: ${query}`);
}

const mysqlPath = require.resolve('mysql2/promise');
require.cache[mysqlPath] = {
  id: mysqlPath,
  filename: mysqlPath,
  loaded: true,
  exports: {
    createPool() {
      return {
        execute,
        query: execute,
        async getConnection() {
          return {
            execute,
            query: execute,
            async beginTransaction() {},
            async commit() {},
            async rollback() {},
            release() {},
          };
        },
        async end() {},
      };
    },
  },
};

const serverCatalog = require('../src/server/catalog');
const { validateOrderPayload, ValidationError } = require('../src/server/validation');

const keys = (items) => items.map((item) => item.key || item.slug).sort();

test('the public catalogue drops every row the dashboard switched off', async () => {
  const payload = await serverCatalog.loadCatalog({ activeOnly: true });

  assert.deepEqual(payload.groups.map((group) => group.slug), ['blackpink']);
  assert.deepEqual(payload.members.map((member) => member.slug), ['jisoo']);
  // A design is addressed as <collection>-<design>.
  assert.deepEqual(payload.products.map((product) => product.slug), ['blackpink-cloud-heart']);
  // The strap category is off, so its item goes with it even though the item itself is on. The
  // base row is a price setting, so it is reported as options.base rather than as a selectable item.
  assert.deepEqual(keys(payload.options.items), ['pearl', 'silver', 'star']);
  assert.equal(payload.options.base.price, 45000);
  assert.deepEqual(payload.optionCategories.map((category) => category.slug), ['addon', 'clasp']);
  // A bundle scoped to a hidden collection is not offered anywhere either.
  assert.deepEqual(payload.bundles.map((bundle) => bundle.slug), ['duo']);
});

test('switching one accessory off keeps its siblings and persists the row', async () => {
  const pearl = state.options.find((row) => row.option_key === 'pearl');
  try {
    const updated = await serverCatalog.updatePricingOption(pearl.id, { isActive: false });
    assert.equal(updated.isActive, false, 'the admin toggle writes is_active = 0');
    assert.equal(state.options.find((row) => row.option_key === 'pearl').is_active, 0);

    const payload = await serverCatalog.loadCatalog({ activeOnly: true });
    assert.deepEqual(keys(payload.options.items), ['silver', 'star'], 'pearl leaves, its siblings stay');
    assert.ok(payload.optionCategories.some((category) => category.slug === 'addon'), 'the category still has items');
  } finally {
    pearl.is_active = 1;
  }
});

test('a category whose items are all switched off is not published', async () => {
  const addons = state.options.filter((row) => row.category === 'addon');
  const previous = addons.map((row) => row.is_active);
  addons.forEach((row) => { row.is_active = 0; });

  try {
    const payload = await serverCatalog.loadCatalog({ activeOnly: true });
    assert.deepEqual(payload.optionCategories.map((category) => category.slug), ['clasp']);
    assert.ok(!payload.options.items.some((item) => item.category === 'addon'));
  } finally {
    addons.forEach((row, index) => { row.is_active = previous[index]; });
  }
});

test('the admin catalogue still lists a switched-off accessory', async () => {
  const pearl = state.options.find((row) => row.option_key === 'pearl');
  pearl.is_active = 0;
  try {
    const options = await serverCatalog.listPricing();
    const row = options.find((option) => option.key === 'pearl');
    assert.equal(row.isActive, false, 'the dashboard must still see and re-enable the row');
  } finally {
    pearl.is_active = 1;
  }
});


test('the admin loaders keep every row, live or not', async () => {
  const groups = await serverCatalog.listAllGroups();
  const products = await serverCatalog.listProducts();
  const members = await serverCatalog.listMembers();

  assert.ok(groups.some((group) => group.slug === 'retired'));
  assert.ok(products.some((product) => product.slug.endsWith('-old-star')));
  assert.ok(members.some((member) => member.slug === 'rose'));
});

test('a catalogue whose rows all exist but are switched off publishes nothing', async () => {
  const previous = state.groups.map((group) => group.is_active);
  state.groups.forEach((group) => { group.is_active = 0; });

  try {
    // No bundled fallback: the database answered, it just has nothing live.
    const payload = await serverCatalog.loadCatalog({ activeOnly: true });
    assert.equal(payload.source, 'database');
    assert.deepEqual(payload.groups, []);
    assert.deepEqual(payload.members, []);
    assert.deepEqual(payload.products, []);
    // A bundle with no collection scope is not tied to a hidden row, so it is still listed; there
    // is simply no design left to apply it to.
    assert.ok(!payload.bundles.some((bundle) => bundle.slug === 'hidden-group-pack'));
  } finally {
    state.groups.forEach((group, index) => { group.is_active = previous[index]; });
  }
});

test('an emptied option table is not refilled with the bundled options', async () => {
  const previous = state.options.map((row) => row.is_active);
  state.options.forEach((row) => { row.is_active = row.category === 'base'; });

  try {
    const payload = await serverCatalog.loadCatalog({ activeOnly: true });
    // Every option row is off, so nothing is offered and the bundled table is not refilled. The
    // base row is a price setting rather than an option, so the global price survives.
    assert.deepEqual(payload.options.items, []);
    assert.deepEqual(payload.options.addons, []);
    assert.equal(payload.options.base.price, 45000);
    assert.equal(payload.product.basePrice, 45000);
  } finally {
    state.options.forEach((row, index) => { row.is_active = previous[index]; });
  }
});

test('a visibility change is visible on the next load without a restart', async () => {
  state.groups.find((group) => group.slug === 'retired').is_active = 1;
  try {
    const payload = await serverCatalog.loadCatalog({ activeOnly: true });
    assert.deepEqual(payload.groups.map((group) => group.slug), ['blackpink', 'retired']);
    // The bundle scoped to that collection comes back with it.
    assert.ok(payload.bundles.some((bundle) => bundle.slug === 'hidden-group-pack'));
  } finally {
    state.groups.find((group) => group.slug === 'retired').is_active = 0;
  }
});

// ---------------------------------------------------------------------------
// Order validation
// ---------------------------------------------------------------------------

function catalogPayload(overrides = {}) {
  return {
    groups: [{ id: 1, slug: 'blackpink', name: 'BLACKPINK', isActive: true }],
    members: [{ id: 1, slug: 'jisoo', name: 'Jisoo', groupSlug: 'blackpink', price: 45000, versionKey: 'yellow', isActive: true }],
    products: [],
    bundles: [{ id: 1, slug: 'duo', name: 'Duo', price: 60000, groupId: null, freeAddonQuota: 1, allowedAddonKeys: null, isActive: true }],
    optionCategories: [
      { slug: 'addon', name: 'Add-ons', selectionMode: 'multiple', isRequired: false, countsTowardBundleFree: true, isActive: true },
      { slug: 'clasp', name: 'Clasps', selectionMode: 'single', isRequired: true, countsTowardBundleFree: false, isActive: true },
    ],
    options: {
      base: { key: 'keychain', label: 'Keychain', price: 45000, isActive: true },
      addons: [],
      clasps: [],
      items: [
        { key: 'keychain', category: 'base', label: 'Keychain', price: 45000, isActive: true },
        { key: 'pearl', category: 'addon', label: 'Pearl drop', price: 8000, isActive: true },
        { key: 'silver', category: 'clasp', label: 'Silver clasp', price: 7000, isActive: true },
      ],
    },
    paymentMethods: [{ code: 'qris', label: 'QRIS', instructions: 'Scan.', imageUrl: null, isActive: true, sortOrder: 0 }],
    ...overrides,
  };
}

function orderPayload(configuration = {}) {
  return {
    customer: { name: 'Ayu Lestari', phone: '081234567890', email: '', address: 'Jl. Merdeka 10, Bandung', note: '' },
    order: {
      artist: { slug: 'blackpink' },
      member: { slug: 'jisoo' },
      configuration: { base: { id: 'heart' }, addons: [{ id: 'pearl' }], clasp: { id: 'silver' }, initial: '', components: [], ...configuration },
      quantity: 1,
      fulfillmentMethod: 'pickup',
      paymentMethod: 'qris',
    },
  };
}

test('an order that still names a switched-off option is rejected, not silently stripped', () => {
  const payload = orderPayload({ selections: { addon: ['pearl'], clasp: ['silver'], strap: ['silicone'] } });

  assert.throws(
    () => validateOrderPayload(payload, { catalog: catalogPayload() }),
    (error) => error instanceof ValidationError && Boolean(error.details.strap),
  );
});

test('an initial is rejected once the personalization option is switched off', () => {
  const catalog = catalogPayload();
  catalog.options.items = catalog.options.items.filter((item) => item.key !== 'initial');
  catalog.options.items.push({ key: 'initial', category: 'addon', label: 'Initial', price: 5000, isActive: false });

  const payload = orderPayload({ initial: 'AYU' });

  assert.throws(
    () => validateOrderPayload(payload, { catalog }),
    (error) => error instanceof ValidationError && Boolean(error.details.initial),
  );
});

test('an order naming a switched-off accessory inside a live category is rejected', () => {
  const catalog = catalogPayload();
  catalog.options.items = [
    { key: 'keychain', category: 'base', label: 'Keychain', price: 45000, isActive: true },
    { key: 'star', category: 'addon', label: 'Mini star', price: 12000, isActive: true },
    { key: 'pearl', category: 'addon', label: 'Pearl drop', price: 8000, isActive: false },
    { key: 'silver', category: 'clasp', label: 'Silver clasp', price: 7000, isActive: true },
  ];

  const payload = orderPayload();
  payload.order.configuration.addons = [{ id: 'pearl' }];

  assert.throws(
    () => validateOrderPayload(payload, { catalog }),
    (error) => error instanceof ValidationError && Boolean(error.details.addons),
    'the sibling item being live does not make the switched-off one orderable',
  );
});

test('the pricing table saves an accessory toggle without pressing Save pricing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin.js'), 'utf8');

  assert.match(source, /querySelectorAll\('\[data-pricing-active\]'\)/, 'the switch is wired');
  assert.match(source, /function setPricingOptionLive\(/, 'a single-row update exists');
  assert.match(source, /\/api\/admin\/pricing\/\$\{option\.id\}/, 'it PATCHes that one option');
  assert.match(source, /JSON\.stringify\(\{ isActive \}\)/, 'and sends the new live state');
});

test('a switched-off bundle is rejected', () => {
  const payload = orderPayload();
  payload.order.bundle = { id: 2, name: 'Retired pack' };

  assert.throws(
    () => validateOrderPayload(payload, { catalog: catalogPayload() }),
    (error) => error instanceof ValidationError && Boolean(error.details.bundle),
  );
});

test('a switched-off member design is rejected', () => {
  const payload = orderPayload();
  payload.order.member = { slug: 'rose' };

  assert.throws(
    () => validateOrderPayload(payload, { catalog: catalogPayload() }),
    (error) => error instanceof ValidationError && Boolean(error.details.member_slug),
  );
});
