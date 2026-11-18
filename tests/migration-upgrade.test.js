const test = require('node:test');
const assert = require('node:assert/strict');

// Regression guard for the Railway deploy failure:
//   Database migration failed: Cannot drop index 'uq_cashbook_order_entry_type':
//   needed in a foreign key constraint
//
// fk_cashbook_order has no index of its own and borrows uq_cashbook_order_entry_type, so the
// legacy key can only be dropped once a plain (order_id) index exists.

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'migration-upgrade-test';
process.env.DB_NAME = 'migration_upgrade_test';

const statements = [];
let productGroupDeleteRule = 'CASCADE';

function respond(sql, params) {
  const query = sql.replace(/\s+/g, ' ').trim();
  statements.push({ sql: query, params });

  if (/^SELECT DATABASE\(\) AS databaseName$/i.test(query)) {
    return [[{ databaseName: process.env.DB_NAME }]];
  }
  if (/FROM INFORMATION_SCHEMA\.STATISTICS/i.test(query)) {
    // Simulate a database upgraded from 002: the composite key is the only index on order_id.
    if (params && params[0] === 'cashbook_entries') {
      return [[{ INDEX_NAME: 'uq_cashbook_order_entry_type' }]];
    }
    return [[]];
  }
  if (/FROM INFORMATION_SCHEMA\.KEY_COLUMN_USAGE/i.test(query)) {
    return [[{
      constraintName: 'fk_catalog_product_group',
      deleteRule: productGroupDeleteRule,
    }]];
  }
  if (
    /^ALTER TABLE catalog_products\b/i.test(query)
    && /ON DELETE RESTRICT/i.test(query)
  ) {
    productGroupDeleteRule = 'RESTRICT';
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

test('a 002 database gets a supporting index before the legacy cashbook key is dropped', async () => {
  statements.length = 0;
  const result = await runAdditiveMigrations();

  assert.equal(result.success, true);

  const addIndexAt = statements.findIndex((entry) => /ADD INDEX idx_cashbook_order \(order_id\)/i.test(entry.sql));
  const dropIndexAt = statements.findIndex((entry) => /DROP INDEX uq_cashbook_order_entry_type/i.test(entry.sql));

  assert.ok(addIndexAt >= 0, 'the plain (order_id) index must be created');
  assert.ok(dropIndexAt >= 0, 'the legacy unique key must still be dropped');
  assert.ok(
    addIndexAt < dropIndexAt,
    'the supporting index must exist before the drop, otherwise MariaDB rejects it with "needed in a foreign key constraint"',
  );
});

test('catalog product group FK migration changes CASCADE to RESTRICT idempotently', async () => {
  statements.length = 0;
  productGroupDeleteRule = 'CASCADE';

  const firstResult = await runAdditiveMigrations();
  assert.equal(firstResult.success, true);

  const firstRunAdd = statements.find((entry) =>
    /^ALTER TABLE catalog_products\b/i.test(entry.sql)
    && /ADD CONSTRAINT fk_catalog_product_group_restrict_007/i.test(entry.sql)
    && /ON DELETE RESTRICT/i.test(entry.sql),
  );
  const firstRunDrop = statements.find((entry) =>
    /^ALTER TABLE catalog_products\b/i.test(entry.sql) && /DROP FOREIGN KEY/i.test(entry.sql),
  );
  assert.ok(firstRunAdd, 'a restrictive FK must be added before removing the cascading FK');
  assert.ok(firstRunDrop, 'the old cascading FK must be removed');
  assert.ok(
    statements.indexOf(firstRunAdd) < statements.indexOf(firstRunDrop),
    'the RESTRICT FK must exist before the cascading FK is removed',
  );
  assert.equal(productGroupDeleteRule, 'RESTRICT');

  statements.length = 0;
  const secondResult = await runAdditiveMigrations();
  assert.equal(secondResult.success, true);
  assert.equal(productGroupDeleteRule, 'RESTRICT');
  assert.ok(
    !statements.some((entry) =>
      /^ALTER TABLE catalog_products\b/i.test(entry.sql)
      && (/DROP FOREIGN KEY/i.test(entry.sql) || /ADD CONSTRAINT fk_catalog_product_group_restrict_007/i.test(entry.sql)),
    ),
    'a second run must not replace an already-RESTRICT FK',
  );
});

test('007 SQL migration converts the catalog product FK to RESTRICT idempotently', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'migrations', '007_catalog_product_group_restrict.sql'),
    'utf8',
  );

  assert.match(sql, /INFORMATION_SCHEMA\.(?:KEY_COLUMN_USAGE|REFERENTIAL_CONSTRAINTS)/i);
  assert.match(sql, /fk_catalog_product_group/i);
  assert.match(sql, /ON DELETE RESTRICT/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE/i, '007 must preserve tables and rows');
});

test('the SQL migration follows the same order as the JavaScript migration', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', '003_catalog_groups.sql'), 'utf8');

  const addIndexAt = sql.indexOf('ADD INDEX idx_cashbook_order (order_id)');
  const dropIndexAt = sql.indexOf('DROP INDEX uq_cashbook_order_entry_type');

  assert.ok(addIndexAt >= 0, '003 must create the supporting index');
  assert.ok(dropIndexAt >= 0, '003 must drop the legacy key');
  assert.ok(addIndexAt < dropIndexAt, '003 must create the index before dropping the key');
});
