const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Migration 015 adds the multi-item columns to order_items on three paths: database/schema.sql
// (fresh install), the guarded .sql file (deploy) and the JS migrator (every boot). The JS path
// is the one tests can execute, so it is run twice against a database that only knows the
// historical columns.

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'order-items-migration-test';
process.env.DB_NAME = 'order_items_migration_test';

const statements = [];

// Columns each table already has before migration 015 runs.
const columns = new Map([
  ['orders', new Set(['id', 'order_number', 'total_amount', 'order_status', 'created_at', 'updated_at', 'customer_note', 'admin_notes', 'payment_verified_at', 'shipping_courier', 'tracking_number', 'shipped_at', 'completed_at', 'fulfillment_method', 'payment_method'])],
  ['order_items', new Set(['id', 'order_id', 'product_name', 'quantity', 'unit_price', 'subtotal'])],
  ['customizer_configurations', new Set(['id', 'order_item_id', 'configuration_json', 'created_at'])],
  ['order_status_history', new Set(['id', 'order_id', 'previous_status', 'new_status', 'changed_by', 'notes', 'created_at'])],
  ['admin_users', new Set(['id', 'username', 'password_hash', 'created_at', 'updated_at'])],
  ['admin_sessions', new Set(['id', 'admin_id', 'expires_at', 'created_at'])],
  ['cashbook_categories', new Set(['id', 'name', 'entry_type', 'is_active', 'created_at'])],
  ['cashbook_entries', new Set(['id', 'entry_type', 'amount', 'category_id', 'description', 'payment_method', 'notes', 'transaction_date', 'order_id', 'source_key', 'admin_user_id', 'supersedes_entry_id', 'created_at', 'updated_at'])],
  ['catalog_groups', new Set(['id', 'slug', 'name', 'tagline', 'eyebrow', 'description', 'image_url', 'hero_image_url', 'cover_focal', 'hero_focal', 'is_active', 'sort_order', 'created_at', 'updated_at', 'has_versions', 'is_custom_design'])],
  ['artist_members', new Set(['id', 'group_id', 'slug', 'name', 'portrait_url', 'design_image_url', 'price_override', 'version_key', 'is_active', 'sort_order', 'created_at', 'updated_at'])],
  ['catalog_products', new Set(['id', 'group_id', 'slug', 'name', 'key_name', 'template_key', 'base_id', 'description', 'image_url', 'price_override', 'version_key', 'is_active', 'sort_order', 'created_at', 'updated_at'])],
  ['product_settings', new Set(['id', 'base_model', 'updated_at'])],
  ['pricing_options', new Set(['id', 'category', 'option_key', 'label', 'price', 'is_active', 'sort_order', 'updated_at'])],
  ['option_categories', new Set(['id', 'slug', 'name', 'selection_mode', 'is_required', 'counts_toward_bundle_free', 'bundle_included', 'sort_order', 'is_active', 'created_at', 'updated_at'])],
  ['catalog_bundles', new Set(['id', 'group_id', 'slug', 'name', 'description', 'bundle_price', 'free_addon_quota', 'allowed_addon_keys', 'image_url', 'is_active', 'sort_order', 'created_at', 'updated_at'])],
  ['payment_methods', new Set(['id', 'code', 'label', 'instructions', 'image_url', 'is_active', 'sort_order', 'created_at', 'updated_at'])],
]);

function tableFromQuery(sql, params) {
  const literal = sql.match(/TABLE_NAME\s*=\s*'([A-Za-z_]+)'/);
  if (literal) return literal[1];
  return params && typeof params[0] === 'string' ? params[0] : '';
}

function respond(sql, params) {
  const query = String(sql).replace(/\s+/g, ' ').trim();
  statements.push({ sql: query, params });

  if (/^SELECT DATABASE\(\) AS databaseName$/i.test(query)) {
    return [[{ databaseName: process.env.DB_NAME }]];
  }
  if (/CHARACTER_MAXIMUM_LENGTH/i.test(query)) {
    return [[{ columnLength: 1024 }]];
  }
  if (/FROM INFORMATION_SCHEMA\.COLUMNS/i.test(query)) {
    const table = tableFromQuery(query, params);
    const known = columns.get(table) || new Set();
    return [[...known].map((name) => ({ COLUMN_NAME: name }))];
  }
  if (/FROM INFORMATION_SCHEMA\.(?:STATISTICS|KEY_COLUMN_USAGE|TABLE_CONSTRAINTS)/i.test(query)) {
    return [[]];
  }
  if (/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i.test(query)) {
    const [, table, column] = query.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
    if (!columns.has(table)) columns.set(table, new Set());
    columns.get(table).add(column);
    return [{ affectedRows: 0 }];
  }
  if (/^SELECT COUNT\(\*\) AS total FROM option_categories/i.test(query)) {
    return [[{ total: 1 }]];
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
        async end() {},
      };
    },
  },
};

// Catalog seeding is not part of this check.
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

const EXPECTED_COLUMNS = ['item_name', 'product_id', 'member_id', 'group_name', 'version_name', 'line_total', 'configuration_json'];

const orderItemAlters = () => statements
  .map((entry) => entry.sql.match(/^ALTER TABLE order_items ADD COLUMN (\w+)/i))
  .filter(Boolean)
  .map((match) => match[1]);

test('the first run adds every multi-item column to order_items', async () => {
  statements.length = 0;
  const result = await runAdditiveMigrations();
  assert.equal(result.success, true);

  const added = orderItemAlters();
  for (const column of EXPECTED_COLUMNS) {
    assert.ok(added.includes(column), `migration 015 must add ${column}`);
  }
  for (const column of EXPECTED_COLUMNS) {
    assert.ok(columns.get('order_items').has(column));
  }
  assert.ok(columns.get('order_items').has('product_name'), 'the historical column is untouched');
  assert.ok(columns.get('order_items').has('subtotal'), 'the historical column is untouched');
});

test('a second run is a no-op for order_items', async () => {
  statements.length = 0;
  const result = await runAdditiveMigrations();
  assert.equal(result.success, true);

  assert.deepEqual(orderItemAlters(), [], 'no column is added twice');
  assert.ok(
    !statements.some((entry) => /DROP TABLE|TRUNCATE|DELETE FROM/i.test(entry.sql)),
    'the migration never destroys stored orders',
  );
});

test('migration 015 is a guarded, additive SQL file', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', '015_order_items.sql'), 'utf8');

  for (const column of EXPECTED_COLUMNS) {
    assert.match(sql, new RegExp(`COLUMN_NAME = '${column}'`), `${column} needs its own guard`);
  }
  assert.match(sql, /INFORMATION_SCHEMA\.COLUMNS/);
  assert.match(sql, /PREPARE migration_stmt FROM @statement/);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM|DROP COLUMN/i);
});

test('the fresh-install schema carries the same columns as the migration', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
  const block = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS order_items'), schema.indexOf('CREATE TABLE IF NOT EXISTS customizer_configurations'));

  for (const column of EXPECTED_COLUMNS) {
    assert.match(block, new RegExp(`\\b${column}\\b`), `schema.sql must declare ${column}`);
  }
  assert.match(block, /product_name VARCHAR\(160\) NOT NULL/, 'the historical column keeps its definition');
  assert.match(block, /FOREIGN KEY \(order_id\) REFERENCES orders \(id\)/);
});

test('the JS migrator and the SQL file list the same columns', () => {
  const migrator = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'migrate.js'), 'utf8');
  const block = migrator.slice(migrator.indexOf('const missingOrderItemColumns'), migrator.indexOf('const catalogSeed'));

  for (const column of EXPECTED_COLUMNS) {
    assert.ok(block.includes(`['${column}'`), `migrate.js must guard ${column}`);
  }
});
