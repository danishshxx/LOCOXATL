const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Product designs per collection and the editable studio price table: admin CRUD, seeding and
// the migration artifacts that back both.

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'catalog-products-test';
process.env.DB_NAME = 'catalog_products_test';

const staticCatalog = require('../src/catalog.js');

const GROUP_FIELDS = 'id, slug, name, tagline, eyebrow, description, image_url, hero_image_url, cover_focal, hero_focal, is_active, sort_order, created_at, updated_at';
const PRODUCT_FIELDS = 'id, group_id, slug, name, template_key, description, base_price, image_url, is_active, sort_order, created_at, updated_at';
const MEMBER_FIELDS = 'id, group_id, slug, name, portrait_url, design_image_url, is_active, sort_order, created_at, updated_at';
const PRICING_FIELDS = 'id, category, option_key, label, price, is_active, sort_order, updated_at';

const groups = [
  { id: 1, slug: 'blackpink', name: 'BLACKPINK', tagline: 'BLINK', description: 'Bold energy.', image_url: null, is_active: 1, sort_order: 0 },
  { id: 2, slug: 'bts', name: 'BTS', tagline: 'ARMY', description: 'Signal edit.', image_url: null, is_active: 1, sort_order: 1 },
];

let products = [];
let pricing = [];
let nextProductId = 1;
let nextPricingId = 1;

function stamps(row) {
  return { created_at: '2026-11-17 09:00:00', updated_at: '2026-11-17 09:00:00', ...row };
}

async function execute(sql, params = []) {
  const query = sql.replace(/\s+/g, ' ').trim();

  // --- groups ---------------------------------------------------------------
  if (new RegExp(`^SELECT ${GROUP_FIELDS} FROM catalog_groups WHERE id = \\? LIMIT 1$`, 'i').test(query)) {
    return [groups.filter((row) => row.id === Number(params[0])).map(stamps)];
  }
  if (new RegExp(`^SELECT ${GROUP_FIELDS} FROM catalog_groups ORDER BY sort_order ASC, id ASC$`, 'i').test(query)) {
    return [groups.slice().sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map(stamps)];
  }
  if (new RegExp(`^SELECT ${GROUP_FIELDS} FROM catalog_groups WHERE is_active = 1 ORDER BY`, 'i').test(query)) {
    return [groups.filter((row) => row.is_active).map(stamps)];
  }

  // --- products -------------------------------------------------------------
  if (/^SELECT COUNT\(\*\) AS total FROM catalog_products$/i.test(query)) {
    return [[{ total: products.length }]];
  }
  if (new RegExp(`^SELECT ${PRODUCT_FIELDS} FROM catalog_products WHERE is_active = 1 ORDER BY`, 'i').test(query)) {
    return [products.filter((row) => row.is_active).map(stamps)];
  }
  if (new RegExp(`^SELECT ${PRODUCT_FIELDS} FROM catalog_products WHERE group_id = \\? ORDER BY`, 'i').test(query)) {
    return [products.filter((row) => row.group_id === Number(params[0])).map(stamps)];
  }
  if (new RegExp(`^SELECT ${PRODUCT_FIELDS} FROM catalog_products ORDER BY`, 'i').test(query)) {
    return [products.map(stamps)];
  }
  if (new RegExp(`^SELECT ${PRODUCT_FIELDS} FROM catalog_products WHERE id = \\? LIMIT 1$`, 'i').test(query)) {
    return [products.filter((row) => row.id === Number(params[0])).map(stamps)];
  }
  if (/^SELECT id, slug FROM catalog_products WHERE group_id = \?$/i.test(query)) {
    return [products.filter((row) => row.group_id === Number(params[0])).map(({ id, slug }) => ({ id, slug }))];
  }
  if (/^SELECT COALESCE\(MAX\(sort_order\), -1\) \+ 1 AS next_order FROM catalog_products WHERE group_id = \?$/i.test(query)) {
    const rows = products.filter((row) => row.group_id === Number(params[0]));
    return [[{ next_order: rows.reduce((max, row) => Math.max(max, row.sort_order), -1) + 1 }]];
  }
  if (/^INSERT(?: IGNORE)? INTO catalog_products/i.test(query)) {
    const slug = params[1];
    const groupId = Number(params[0]);
    if (products.some((row) => row.group_id === groupId && row.slug === slug)) {
      const error = new Error('Duplicate entry');
      error.code = 'ER_DUP_ENTRY';
      throw error;
    }
    const row = {
      id: nextProductId++,
      group_id: groupId,
      slug,
      name: params[2],
      template_key: params[3],
      description: params[4] || '',
      base_price: Number(params[5]),
      image_url: params[6] || null,
      is_active: /INSERT IGNORE/i.test(query) ? 1 : Number(params[7]),
      sort_order: Number(params[params.length - 1]),
    };
    products.push(row);
    return [{ insertId: row.id, affectedRows: 1 }];
  }
  if (/^UPDATE catalog_products SET/i.test(query)) {
    const id = Number(params[params.length - 1]);
    const row = products.find((entry) => entry.id === id);
    if (!row) return [{ affectedRows: 0 }];
    const assignments = query.replace(/^UPDATE catalog_products SET /i, '').replace(/ WHERE id = \?$/, '').split(', ');
    assignments.forEach((assignment, index) => {
      if (assignment === 'image_url = NULL') {
        row.image_url = null;
        return;
      }
      const field = assignment.split(' = ')[0];
      row[field] = params[index];
    });
    return [{ affectedRows: 1 }];
  }

  // --- members (migration 006) ---------------------------------------------
  // This fixture has no members, so the public catalogue publishes an empty list.
  if (new RegExp(`^SELECT ${MEMBER_FIELDS} FROM artist_members`, 'i').test(query)) {
    return [[]];
  }

  // --- single product settings (migration 008) ------------------------------
  if (/^SELECT id, base_model, updated_at FROM product_settings WHERE id = 1 LIMIT 1$/i.test(query)) {
    return [[{ id: 1, base_model: 'heart', updated_at: '2026-11-17 09:00:00' }]];
  }
  if (/^SELECT base_price FROM catalog_products WHERE template_key = 'acrylic-keychain'/i.test(query)) {
    const heart = products.find((row) => row.template_key === 'acrylic-keychain');
    return [heart ? [{ base_price: heart.base_price }] : []];
  }

  // --- pricing --------------------------------------------------------------
  if (/^SELECT COUNT\(\*\) AS total FROM pricing_options$/i.test(query)) {
    return [[{ total: pricing.length }]];
  }
  if (new RegExp(`^SELECT ${PRICING_FIELDS} FROM pricing_options WHERE is_active = 1 ORDER BY`, 'i').test(query)) {
    return [pricing.filter((row) => row.is_active).map(stamps)];
  }
  if (new RegExp(`^SELECT ${PRICING_FIELDS} FROM pricing_options ORDER BY`, 'i').test(query)) {
    return [pricing.map(stamps)];
  }
  if (/^INSERT(?: IGNORE)? INTO pricing_options/i.test(query)) {
    const key = params[1];
    // INSERT IGNORE never throws on a duplicate; it simply reports 0 affected rows.
    if (pricing.some((row) => row.option_key === key)) {
      return [{ insertId: 0, affectedRows: 0 }];
    }
    const row = {
      id: nextPricingId++,
      category: params[0],
      option_key: key,
      label: params[2],
      price: Number(params[3]),
      is_active: 1,
      sort_order: Number(params[params.length - 1]),
    };
    pricing.push(row);
    return [{ insertId: row.id, affectedRows: 1 }];
  }
  if (/^UPDATE pricing_options SET/i.test(query)) {
    const key = params[params.length - 1];
    const row = pricing.find((entry) => entry.option_key === key);
    if (!row) return [{ affectedRows: 0 }];
    const assignments = query.replace(/^UPDATE pricing_options SET /i, '').replace(/ WHERE option_key = \?$/, '').split(', ');
    assignments.forEach((assignment, index) => {
      row[assignment.split(' = ')[0]] = params[index];
    });
    return [{ affectedRows: 1 }];
  }

  throw new Error(`Unexpected catalog product test SQL: ${query}`);
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

const catalog = require('../src/server/catalog');

test('seeding fills the design and price tables once, then leaves them alone', async () => {
  const first = await catalog.seedCatalogProducts();
  assert.equal(first.seeded, 6, 'three standard designs for each of the two collections');
  assert.equal(products.length, 6);
  assert.deepEqual(
    products.filter((row) => row.group_id === 1).map((row) => row.slug),
    ['cloud-heart', 'orbit-star', 'soft-ribbon'],
  );

  const again = await catalog.seedCatalogProducts();
  assert.equal(again.seeded, 0);
  assert.equal(again.reason, 'already_seeded');
  assert.equal(products.length, 6, 're-running must not duplicate designs');

  const priceSeed = await catalog.seedPricingOptions();
  assert.equal(priceSeed.seeded, 6, 'one shared base price, three add-ons and two clasps');

  const priceAgain = await catalog.seedPricingOptions();
  assert.equal(priceAgain.seeded, 0);
  assert.equal(pricing.length, 6);
});

test('the seeded designs keep the storefront slugs and prices', async () => {
  const { products: listed } = await catalog.loadCatalog({ activeOnly: true });

  assert.equal(listed.length, 6);
  const cloudHeart = listed.find((product) => product.slug === 'blackpink-cloud-heart');
  assert.equal(cloudHeart.name, 'Cloud Heart');
  assert.equal(cloudHeart.price, 45000);
  assert.equal(cloudHeart.templateKey, 'acrylic-keychain');
  assert.equal(cloudHeart.baseId, 'heart');
  assert.equal(cloudHeart.groupSlug, 'blackpink');
  assert.equal(cloudHeart.artistSlug, 'blackpink');
});

test('creating a design slugifies the name and keeps slugs unique inside the collection', async () => {
  const created = await catalog.createProduct({
    groupId: 1,
    name: 'Star Burst!',
    templateKey: 'photocard-holder',
    basePrice: 61000,
    description: 'Limited run.',
  });

  assert.equal(created.slug, 'blackpink-star-burst');
  assert.equal(created.key, 'star-burst');
  assert.equal(created.price, 61000);
  assert.equal(created.templateKey, 'photocard-holder');
  assert.equal(created.isActive, true);
  assert.equal(created.groupId, 1);

  const duplicate = await catalog.createProduct({
    groupId: 1,
    name: 'Star Burst',
    templateKey: 'photocard-holder',
    basePrice: 61000,
  });
  assert.equal(duplicate.key, 'star-burst-2', 'a second design with the same name gets a suffix');

  const otherGroup = await catalog.createProduct({
    groupId: 2,
    name: 'Star Burst',
    templateKey: 'photocard-holder',
    basePrice: 61000,
  });
  assert.equal(otherGroup.key, 'star-burst', 'slugs are only unique per collection');
});

test('design input is validated before it reaches the database', async () => {
  await assert.rejects(
    () => catalog.createProduct({ groupId: 1, name: 'X', templateKey: 'photocard-holder', basePrice: 1000 }),
    (error) => error.code === 'invalid_name',
  );
  await assert.rejects(
    () => catalog.createProduct({ groupId: 1, name: 'Valid name', templateKey: 'not-a-template', basePrice: 1000 }),
    (error) => error.code === 'invalid_template',
  );
  await assert.rejects(
    () => catalog.createProduct({ groupId: 1, name: 'Valid name', templateKey: 'phone-charm', basePrice: -5 }),
    (error) => error.code === 'invalid_price',
  );
  await assert.rejects(
    () => catalog.createProduct({ groupId: 99, name: 'Valid name', templateKey: 'phone-charm', basePrice: 1000 }),
    (error) => error.code === 'group_not_found',
  );
});

test('updating a design can rename, reprice, reorder, hide and clear its image', async () => {
  const created = await catalog.createProduct({
    groupId: 1,
    name: 'Moon Drop',
    templateKey: 'phone-charm',
    basePrice: 55000,
    imageUrl: '/assets/uploads/catalog/product-1-moon-drop-abcdef123456.webp',
  });
  assert.equal(created.imageUrl, '/assets/uploads/catalog/product-1-moon-drop-abcdef123456.webp');

  const updated = await catalog.updateProduct(created.id, {
    name: 'Moon Drop Deluxe',
    basePrice: 59000,
    sortOrder: 7,
    isActive: false,
    imageUrl: null,
  });

  assert.equal(updated.name, 'Moon Drop Deluxe');
  assert.equal(updated.price, 59000);
  assert.equal(updated.sortOrder, 7);
  assert.equal(updated.isActive, false);
  assert.equal(updated.imageUrl, null);

  const listed = await catalog.listProducts({ groupId: 1 });
  assert.ok(listed.every((product) => product.groupId === 1), 'the group filter is applied');
  assert.ok(listed.some((product) => product.name === 'Moon Drop Deluxe' && product.isActive === false));
});

test('pricing updates are validated and applied per option key', async () => {
  const updated = await catalog.updatePricing({
    options: [
      { optionKey: 'pearl', price: 9500 },
      { optionKey: 'silver', price: 8000, label: 'Silver clasp (premium)' },
      { optionKey: 'black', isActive: false },
    ],
  });

  const pearl = updated.find((option) => option.key === 'pearl');
  const silver = updated.find((option) => option.key === 'silver');
  const black = updated.find((option) => option.key === 'black');

  assert.equal(pearl.price, 9500);
  assert.equal(silver.price, 8000);
  assert.equal(silver.label, 'Silver clasp (premium)');
  assert.equal(black.isActive, false);

  await assert.rejects(
    () => catalog.updatePricing({ options: [{ optionKey: 'pearl', price: -1 }] }),
    (error) => error.code === 'invalid_price',
  );
  await assert.rejects(
    () => catalog.updatePricing({ options: [{ optionKey: 'diamond', price: 1000 }] }),
    (error) => error.code === 'unknown_option',
  );
  await assert.rejects(
    () => catalog.updatePricing({ options: [] }),
    (error) => error.code === 'no_changes',
  );

  const single = await catalog.updatePricing({ optionKey: 'star', price: 13000 });
  assert.equal(single.find((option) => option.key === 'star').price, 13000, 'single-key updates work too');
});

test('the catalogue exposes the live price table grouped for the studio', async () => {
  const { options } = await catalog.loadCatalog({ activeOnly: true });
  assert.deepEqual(options.addons.map((option) => option.key).sort(), ['initial', 'pearl', 'star']);
  // The black clasp was switched off by the previous test, so only the live one is published.
  assert.deepEqual(options.clasps.map((option) => option.key), ['silver']);
  assert.equal(options.addons.find((option) => option.key === 'pearl').price, 9500);
});

test('migration 005 and the schema create both tables and seed them only when empty', () => {
  const root = path.join(__dirname, '..');
  const sql = fs.readFileSync(path.join(root, 'database', 'migrations', '005_products_and_pricing.sql'), 'utf8');
  const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
  const migrate = fs.readFileSync(path.join(root, 'src', 'server', 'migrate.js'), 'utf8');

  for (const source of [sql, schema, migrate]) {
    assert.match(source, /catalog_products/);
    assert.match(source, /pricing_options/);
  }

  assert.match(sql, /UNIQUE KEY uq_group_product_slug \(group_id, slug\)/);
  assert.match(sql, /CONSTRAINT fk_catalog_product_group FOREIGN KEY \(group_id\) REFERENCES catalog_groups \(id\) ON DELETE CASCADE/);
  assert.match(sql, /UNIQUE KEY uq_pricing_option_key \(option_key\)/);

  // The seeders must be guarded so re-running the migration never duplicates rows.
  assert.match(sql, /SET @product_rows := \(SELECT COUNT\(\*\) FROM catalog_products\)/);
  assert.match(sql, /WHERE @product_rows = 0/);
  assert.match(sql, /SET @pricing_rows := \(SELECT COUNT\(\*\) FROM pricing_options\)/);
  assert.match(sql, /WHERE @pricing_rows = 0/);

  // Every template key referenced by the seed must exist in the bundled catalogue.
  for (const template of staticCatalog.productTemplates) {
    assert.ok(sql.includes(template.templateKey), `${template.templateKey} must be seeded`);
    assert.ok(staticCatalog.TEMPLATE_KEYS.includes(template.templateKey));
  }
});

test('the dashboard exposes Product Setup and no duplicate product-design manager', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'src', 'admin.js'), 'utf8');

  assert.match(html, /data-view="product"/, 'the Product Setup view tab exists');
  assert.match(html, /id="productSettingsForm"/);
  assert.match(html, /id="baseModelSelect"/);
  assert.match(html, /id="basePriceInput"/);
  assert.match(html, /id="pricingBody"/);
  assert.match(html, /id="savePricingBtn"/);

  assert.doesNotMatch(html, /id="catalogProductsBody"/, 'Product Designs management is removed');
  assert.doesNotMatch(html, /id="productModalBackdrop"/, 'the design modal is removed');
  assert.doesNotMatch(html, /data-catalog-tab="groups"/, 'the duplicate Collections tab is removed');

  assert.match(script, /\/api\/admin\/product-settings/);
  assert.match(script, /\/api\/admin\/pricing/);
  assert.match(script, /saveProductSettings/);
  assert.match(script, /savePricing/);
  assert.match(script, /loadProductSettings/);
});

test('the storefront reads the shared product, member artwork and live prices', () => {
  const root = path.join(__dirname, '..');
  const artistPage = fs.readFileSync(path.join(root, 'src', 'artist-page.js'), 'utf8');
  const studio = fs.readFileSync(path.join(root, 'src', 'studio.js'), 'utf8');

  assert.match(artistPage, /member\.designImageUrl/, 'member cards use the uploaded keychain artwork');
  assert.match(artistPage, /member=\$\{encodeURIComponent\(member\.slug\)\}/, 'member selection forwards the member slug');

  assert.match(studio, /payload\.options/, 'the studio reads the live price table');
  assert.match(studio, /pricing\.priceOf/, 'the studio resolves prices through the shared module');
  assert.match(studio, /payload\.product|activeProduct/, 'the studio applies the global base product');
  assert.match(studio, /designImageUrl/, 'the studio shows the member artwork');
  assert.doesNotMatch(studio, /applyLiveDesign|data-base/, 'product design switching is removed');
});
