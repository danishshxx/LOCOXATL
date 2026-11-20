const test = require('node:test');
const assert = require('node:assert/strict');

// Catalogue groups: database-backed collections with a static fallback, plus the admin CRUD
// that curates them and the order-time check that refuses hidden collections.

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'catalog-test';
process.env.DB_NAME = 'catalog_test';

const staticCatalog = require('../src/catalog.js');

const groups = [
  { id: 1, slug: 'blackpink', name: 'BLACKPINK', tagline: 'BLINK', description: 'Bold energy. Personal details.', is_active: 1, sort_order: 0 },
  { id: 2, slug: 'bts', name: 'BTS', tagline: 'ARMY', description: 'A little reminder of what moves you.', is_active: 1, sort_order: 1 },
  { id: 3, slug: 'seventeen', name: 'SEVENTEEN', tagline: 'CARAT', description: 'Made of many little moments.', is_active: 0, sort_order: 2 },
];
let nextId = 4;

// Product designs for the two active collections, mirroring what migration 005 seeds.
const products = [];
let nextProductId = 1;
for (const group of groups.filter((row) => row.is_active)) {
  for (const [index, template] of staticCatalog.productTemplates.entries()) {
    products.push({
      id: nextProductId++,
      group_id: group.id,
      slug: template.templateSlug,
      name: template.name,
      template_key: template.templateKey,
      description: template.description,
      base_price: template.price,
      image_url: null,
      is_active: 1,
      sort_order: index,
    });
  }
}

const pricing = [
  { id: 1, category: 'addon', option_key: 'pearl', label: 'Pearl drop', price: 8000, is_active: 1, sort_order: 0 },
  { id: 2, category: 'addon', option_key: 'star', label: 'Mini star', price: 12000, is_active: 1, sort_order: 1 },
  { id: 3, category: 'addon', option_key: 'initial', label: 'Your initial', price: 5000, is_active: 1, sort_order: 2 },
  { id: 4, category: 'clasp', option_key: 'silver', label: 'Silver clasp', price: 7000, is_active: 1, sort_order: 0 },
  { id: 5, category: 'clasp', option_key: 'black', label: 'Black clasp', price: 5000, is_active: 1, sort_order: 1 },
];

const COLUMNS = 'id, slug, name, tagline, eyebrow, description, image_url, hero_image_url, cover_focal, hero_focal, is_active, sort_order, created_at, updated_at, versions_json, has_versions, is_custom_design';
const PRODUCT_COLUMNS = 'id, group_id, slug, name, template_key, description, base_price, image_url, is_active, sort_order, created_at, updated_at, version_key';
const MEMBER_COLUMNS = 'id, group_id, slug, name, portrait_url, design_image_url, is_active, sort_order, created_at, updated_at, version_key';
const PRICING_COLUMNS = 'id, category, option_key, label, price, is_active, sort_order, updated_at';

function withTimestamps(row) {
  return { created_at: '2026-11-17 09:00:00', updated_at: '2026-11-17 09:00:00', ...row };
}

async function execute(sql, params = []) {
  const query = sql.replace(/\s+/g, ' ').trim();

  if (new RegExp(`^SELECT ${COLUMNS} FROM catalog_groups WHERE is_active = 1 ORDER BY sort_order ASC, id ASC$`, 'i').test(query)) {
    return [groups.filter((row) => row.is_active).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map(withTimestamps)];
  }
  if (new RegExp(`^SELECT ${COLUMNS} FROM catalog_groups ORDER BY sort_order ASC, id ASC$`, 'i').test(query)) {
    return [groups.slice().sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map(withTimestamps)];
  }
  if (new RegExp(`^SELECT ${COLUMNS} FROM catalog_groups WHERE id = \\? LIMIT 1$`, 'i').test(query)) {
    return [groups.filter((row) => row.id === Number(params[0])).map(withTimestamps)];
  }
  if (/^SELECT COALESCE\(MAX\(sort_order\), -1\) \+ 1 AS next_order FROM catalog_groups$/i.test(query)) {
    return [[{ next_order: groups.reduce((max, row) => Math.max(max, row.sort_order), -1) + 1 }]];
  }
  if (/^SELECT COUNT\(\*\) AS total FROM catalog_groups$/i.test(query)) {
    return [[{ total: groups.length }]];
  }
  if (/^INSERT(?: IGNORE)? INTO catalog_groups/i.test(query)) {
    const columnList = /\(([^)]+)\)\s*VALUES/i.exec(query)[1].split(',').map((name) => name.trim());
    const row = { id: nextId++, image_url: null, hero_image_url: null, cover_focal: '50% 50%', hero_focal: '50% 50%' };
    columnList.forEach((column, index) => { row[column] = params[index]; });
    if (groups.some((entry) => entry.slug === row.slug)) {
      const error = new Error('Duplicate entry');
      error.code = 'ER_DUP_ENTRY';
      throw error;
    }
    if (/INSERT IGNORE/i.test(query)) row.is_active = 1;
    groups.push(row);
    return [{ insertId: row.id, affectedRows: 1 }];
  }
  if (/^UPDATE catalog_groups SET/i.test(query)) {
    const id = Number(params[params.length - 1]);
    const row = groups.find((entry) => entry.id === id);
    if (!row) return [{ affectedRows: 0 }];
    const assignments = query.replace(/^UPDATE catalog_groups SET /i, '').replace(/ WHERE id = \?$/, '').split(', ');
    assignments.forEach((assignment, index) => {
      const field = assignment.split(' = ')[0];
      row[field] = params[index];
    });
    return [{ affectedRows: 1 }];
  }

  // --- product designs and studio pricing (migration 005) --------------------
  if (new RegExp(`^SELECT ${PRODUCT_COLUMNS} FROM catalog_products WHERE is_active = 1 ORDER BY`, 'i').test(query)) {
    return [products.filter((row) => row.is_active).map(withTimestamps)];
  }
  if (new RegExp(`^SELECT ${PRODUCT_COLUMNS} FROM catalog_products ORDER BY`, 'i').test(query)) {
    return [products.map(withTimestamps)];
  }
  // Migration 006 members: this fixture has none, so the catalogue publishes an empty list.
  if (new RegExp(`^SELECT ${MEMBER_COLUMNS} FROM artist_members`, 'i').test(query)) {
    return [[]];
  }
  if (/^SELECT id, updated_at FROM product_settings WHERE id = 1 LIMIT 1$/i.test(query)) {
    return [[{ id: 1, base_model: 'heart', updated_at: '2026-11-17 09:00:00' }]];
  }
  if (new RegExp(`^SELECT ${PRICING_COLUMNS} FROM pricing_options WHERE is_active = 1 ORDER BY`, 'i').test(query)) {
    return [pricing.filter((row) => row.is_active).map(withTimestamps)];
  }
  if (new RegExp(`^SELECT ${PRICING_COLUMNS} FROM pricing_options ORDER BY`, 'i').test(query)) {
    return [pricing.map(withTimestamps)];
  }

  if (/FROM catalog_bundles/i.test(query)) return [[]];

  if (/FROM option_categories/i.test(query)) return [[]];

  throw new Error(`Unexpected catalog test SQL: ${query}`);
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
const { assertArtistAvailable, ValidationError } = require('../src/server/validation');
const ordersModule = require('../src/server/orders');
const { handleApiRequest } = require('../src/server/api');

function mockHttp(method, pathname, { headers = {}, body = null } = {}) {
  const req = {
    method,
    headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
    socket: { encrypted: false, remoteAddress: '203.0.113.10' },
    on(event, handler) {
      if (event === 'data' && body) handler(Buffer.from(JSON.stringify(body)));
      if (event === 'end') handler();
      return req;
    },
    destroy() {},
  };
  let statusCode = 200;
  let payload = '';
  const res = {
    writeHead(status) { statusCode = status; },
    end(data) { payload = data || ''; },
    get writableEnded() { return Boolean(payload); },
  };
  return {
    req,
    res,
    url: new URL(pathname, 'http://localhost'),
    result: () => ({ status: statusCode, body: payload ? JSON.parse(payload) : null }),
  };
}

test('the public catalogue returns only active groups in sort order with their products', async () => {
  const catalog = await serverCatalog.loadCatalog({ activeOnly: true });
  assert.equal(catalog.source, 'database');
  assert.deepEqual(catalog.groups.map((group) => group.slug), ['blackpink', 'bts']);
  assert.equal(catalog.products.length, 6, 'three product templates per active group');
  assert.ok(catalog.products.some((product) => product.slug === 'bts-soft-ribbon'));
  assert.ok(!catalog.products.some((product) => product.artistSlug === 'seventeen'));
});

test('GET /api/catalog is public while the admin group list requires a session', async () => {
  const publicCall = mockHttp('GET', '/api/catalog');
  await handleApiRequest(publicCall.req, publicCall.res, publicCall.url);
  const publicResult = publicCall.result();
  assert.equal(publicResult.status, 200);
  assert.equal(publicResult.body.source, 'database');
  assert.equal(publicResult.body.groups.length, 2);

  const adminCall = mockHttp('GET', '/api/admin/catalog/groups');
  await handleApiRequest(adminCall.req, adminCall.res, adminCall.url);
  assert.equal(adminCall.result().status, 401);

  const createCall = mockHttp('POST', '/api/admin/catalog/groups', {
    headers: { origin: 'http://localhost' },
    body: { name: 'TWICE' },
  });
  await handleApiRequest(createCall.req, createCall.res, createCall.url);
  assert.equal(createCall.result().status, 401, 'creating a group requires an admin session');
});

test('creating a group slugifies the name and rejects duplicates', async () => {
  const created = await serverCatalog.createGroup({ name: 'New Jeans!', tagline: 'BUNNIES', description: 'Fresh shapes.' });
  assert.equal(created.slug, 'new-jeans');
  assert.equal(created.name, 'New Jeans!');
  assert.equal(created.isActive, true);
  assert.equal(created.sortOrder, 3, 'appended after the existing groups');

  await assert.rejects(
    () => serverCatalog.createGroup({ name: 'BLACKPINK' }),
    (error) => error.code === 'group_exists' && error.statusCode === 409,
  );

  await assert.rejects(
    () => serverCatalog.createGroup({ name: ' ' }),
    (error) => error.code === 'invalid_name' && error.statusCode === 400,
  );

  await assert.rejects(
    () => serverCatalog.createGroup({ name: 'Valid name', sortOrder: 'first' }),
    (error) => error.code === 'invalid_sort_order',
  );
});

test('updating a group toggles visibility, reorders it and reports missing ids', async () => {
  const hidden = await serverCatalog.updateGroup(2, { isActive: false });
  assert.equal(hidden.slug, 'bts');
  assert.equal(hidden.isActive, false);

  const activeCatalog = await serverCatalog.loadCatalog({ activeOnly: true });
  assert.deepEqual(activeCatalog.groups.map((group) => group.slug), ['blackpink', 'new-jeans']);

  const moved = await serverCatalog.updateGroup(1, { sortOrder: 7, tagline: 'BLINK FOREVER' });
  assert.equal(moved.sortOrder, 7);
  assert.equal(moved.tagline, 'BLINK FOREVER');

  await assert.rejects(
    () => serverCatalog.updateGroup(999, { name: 'Nope' }),
    (error) => error.code === 'group_not_found' && error.statusCode === 404,
  );

  await assert.rejects(
    () => serverCatalog.updateGroup(1, { isActive: 'yes' }),
    (error) => error.code === 'invalid_active',
  );

  await serverCatalog.updateGroup(2, { isActive: true });
});

test('a hidden collection cannot be ordered, while active ones still can', async () => {
  await serverCatalog.updateGroup(2, { isActive: false });

  await assert.rejects(
    () => assertArtistAvailable('bts'),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.details.artist_slug);
      return true;
    },
  );

  const payload = {
    customer: { name: 'Ayu Lestari', phone: '081234567890', address: 'Jl. Merdeka No. 12, Bandung' },
    order: {
      artist: { slug: 'bts' },
      product: { slug: 'bts-cloud-heart' },
      configuration: { base: { id: 'heart' }, addons: [], initial: '', clasp: { id: 'silver' } },
      quantity: 1,
      total: 52000,
    },
  };

  await assert.rejects(
    () => ordersModule.createOrder(payload),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.details.artist_slug, 'That collection is not available right now.');
      return true;
    },
  );

  await assert.doesNotReject(() => assertArtistAvailable('blackpink'));
  await serverCatalog.updateGroup(2, { isActive: true });
});

test('an unconfigured database falls back to the bundled catalogue', async () => {
  const host = process.env.DB_HOST;
  delete process.env.DB_HOST;

  try {
    const catalog = await serverCatalog.loadCatalog({ activeOnly: true });
    assert.equal(catalog.source, 'fallback');
    assert.equal(catalog.groups.length, staticCatalog.artists.length);
    assert.equal(catalog.products.length, staticCatalog.products.length);
    assert.equal(catalog.groups[0].slug, staticCatalog.artists[0].slug);

    // The static catalogue is authoritative in fallback mode, so ordering still works.
    await assert.doesNotReject(() => assertArtistAvailable('bts'));

    await assert.rejects(
      () => serverCatalog.createGroup({ name: 'Offline Group' }),
      (error) => error.code === 'database_not_configured' && error.statusCode === 503,
    );
  } finally {
    process.env.DB_HOST = host;
  }
});

test('an empty group table is seeded with the six bundled artists', async () => {
  const snapshot = groups.splice(0, groups.length);

  try {
    const result = await serverCatalog.seedCatalogGroups();
    assert.equal(result.seeded, staticCatalog.artists.length);
    assert.deepEqual(groups.map((group) => group.slug), staticCatalog.artists.map((artist) => artist.slug));

    const repeated = await serverCatalog.seedCatalogGroups();
    assert.equal(repeated.seeded, 0, 'seeding is idempotent');
    assert.equal(groups.length, staticCatalog.artists.length);
  } finally {
    groups.splice(0, groups.length, ...snapshot);
  }
});
