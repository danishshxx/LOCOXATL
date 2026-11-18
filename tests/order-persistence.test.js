const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The order layer is verified against a scripted MySQL driver. A live MySQL server is not
// available in this environment, so this test proves the code path: parameterised SQL,
// transaction boundaries, rollback on failure, duplicate order-number retry and status
// transitions. Configure a real database (see DATABASE-SETUP.md) to exercise the driver.

const MYSQL_PATH = require.resolve('mysql2/promise');
const calls = [];
let scripted = [];

function resetScript(responses = []) {
  calls.length = 0;
  scripted = [...responses];
}

function handleStatement(sql, params) {
  calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
  // The catalogue preflight reads catalog_groups; the scripted responses below describe the
  // order transaction itself.
  if (/FROM catalog_groups/i.test(sql)) return [[]];
  const next = scripted.shift();
  if (next instanceof Error) throw next;
  if (next) return next;
  if (/^INSERT/i.test(sql.trim())) return [{ insertId: 1, affectedRows: 1 }];
  return [[]];
}

const connection = {
  async beginTransaction() { calls.push({ sql: 'BEGIN' }); },
  async commit() { calls.push({ sql: 'COMMIT' }); },
  async rollback() { calls.push({ sql: 'ROLLBACK' }); },
  release() { calls.push({ sql: 'RELEASE' }); },
  execute: handleStatement,
  query: handleStatement,
};

const fakeMysql = {
  createPool() {
    return {
      execute: handleStatement,
      query: handleStatement,
      async getConnection() { return connection; },
      async end() {},
    };
  },
};

require.cache[MYSQL_PATH] = {
  id: MYSQL_PATH,
  filename: MYSQL_PATH,
  loaded: true,
  exports: fakeMysql,
};

process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'locoxatl_test';
process.env.DB_NAME = process.env.DB_NAME || 'locoxatl_test';

const orders = require('../src/server/orders.js');

const payload = () => ({
  customer: {
    name: 'Ayu Lestari',
    phone: '081234567890',
    email: 'ayu@example.com',
    address: 'Jl. Merdeka No. 12, Bandung 40111',
    note: 'Ring the bell',
  },
  order: {
    artist: { slug: 'blackpink' },
    product: { slug: 'blackpink-cloud-heart' },
    configuration: {
      base: { id: 'heart' },
      addons: [{ id: 'pearl' }, { id: 'star' }],
      initial: 'A',
      clasp: { id: 'black' },
      components: [{ id: 'base', name: 'Base charm', type: 'base', finish: 'acrylic', visible: true }],
    },
    quantity: 2,
    total: 59000,
  },
});

const statements = () => calls
  .filter((call) => !/catalog_groups/i.test(call.sql))
  .map((call) => call.sql);

test('an order is written as order + item + configuration inside one transaction', async () => {
  resetScript();

  const created = await orders.createOrder(payload());

  assert.match(created.orderNumber, /^LX-[0-9A-Z]+-[0-9A-F]{6}$/);
  // 45.000 base + 8.000 pearl + 12.000 star + 5.000 initial + 5.000 black clasp = 75.000
  assert.equal(created.unitPrice, 75000);
  assert.equal(created.total, 150000);
  assert.equal(created.quantity, 2);
  assert.equal(created.status, 'waiting_for_payment');

  const executed = statements();
  assert.equal(executed[0], 'BEGIN');
  assert.match(executed[1], /^INSERT INTO orders/);
  assert.match(executed[2], /^INSERT INTO order_items/);
  assert.match(executed[3], /^INSERT INTO customizer_configurations/);
  assert.deepEqual(executed.slice(4), ['COMMIT', 'RELEASE']);

  const orderInsert = calls.find((call) => /^INSERT INTO orders/.test(call.sql));
  assert.equal(orderInsert.params.length, 10);
  assert.equal(orderInsert.params[6], 'campus_delivery', 'a legacy order defaults to campus delivery');
  assert.equal(orderInsert.params[7], null, 'a legacy order carries no payment method');
  assert.ok(orderInsert.params.includes('Ayu Lestari'));
  assert.ok(orderInsert.params.includes(150000));
  assert.match(orderInsert.sql, /\?/);
  assert.ok(!orderInsert.sql.includes('Ayu'), 'values must never be interpolated into SQL');

  const configInsert = calls.find((call) => /^INSERT INTO customizer_configurations/.test(call.sql));
  assert.equal(configInsert.params.length, 2);
  const stored = JSON.parse(configInsert.params[1]);
  assert.equal(stored.configuration.initial, 'A');
  assert.equal(stored.product, 'blackpink-cloud-heart');
});

test('a failure while writing the configuration rolls the whole order back', async () => {
  resetScript([
    [{ insertId: 7, affectedRows: 1 }], // orders
    [{ insertId: 9, affectedRows: 1 }], // order_items
    new Error('customizer table unavailable'), // configurations
  ]);

  await assert.rejects(() => orders.createOrder(payload()), /customizer table unavailable/);
  const executed = statements();
  assert.equal(executed[0], 'BEGIN');
  assert.ok(executed.includes('ROLLBACK'), 'transaction must roll back');
  assert.ok(!executed.includes('COMMIT'), 'nothing may be committed');
  assert.equal(executed.at(-1), 'RELEASE', 'the connection is always released');
});

test('a duplicate order number is retried with a new number', async () => {
  const duplicate = new Error('ER_DUP_ENTRY');
  duplicate.code = 'ER_DUP_ENTRY';
  resetScript([
    duplicate, // first orders insert
  ]);

  const created = await orders.createOrder(payload());
  assert.match(created.orderNumber, /^LX-/);
  assert.equal(calls.filter((call) => call.sql === 'BEGIN').length, 2, 'the failed attempt must be retried');
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'));
});

test('public order lookup omits private customer and customizer data', async () => {
  resetScript([
    [[{
      id: 12,
      order_number: 'LX-TEST-ABC123',
      total_amount: 59000,
      order_status: 'waiting_for_payment',
      created_at: '2026-11-12 10:00:00',
      updated_at: '2026-11-12 10:00:00',
    }]],
    [[{ id: 4, product_name: 'Cloud Heart — BLACKPINK', quantity: 1, unit_price: 59000, subtotal: 59000 }]],
  ]);

  const order = await orders.getOrderByNumber('LX-TEST-ABC123');
  assert.equal(order.orderNumber, 'LX-TEST-ABC123');
  assert.equal(order.total, 59000);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].productName, 'Cloud Heart — BLACKPINK');
  assert.equal(order.customer, undefined);
  assert.equal(order.configuration, undefined);
  assert.match(calls[0].sql, /FROM orders WHERE order_number = \?/);
  assert.doesNotMatch(calls[0].sql, /customer_(?:name|email|phone|address|note)/i);
  assert.deepEqual(calls[0].params, ['LX-TEST-ABC123']);
  assert.equal(calls.length, 2, 'public lookup does not read customizer configuration rows');
});

test('a missing order raises a 404 error and status transitions are guarded', async () => {
  resetScript([[[]]]);
  await assert.rejects(() => orders.getOrderByNumber('LX-NOPE'), (error) => {
    assert.equal(error.code, 'ORDER_NOT_FOUND');
    assert.equal(error.statusCode, 404);
    return true;
  });

  resetScript([[[{ id: 3, order_status: 'waiting_for_payment' }]]]);
  const updated = await orders.updateOrderStatus('LX-TEST-ABC123', 'payment_confirmation_sent');
  assert.equal(updated.status, 'payment_confirmation_sent');
  assert.ok(calls.some((call) => /^UPDATE orders SET order_status/.test(call.sql)));

  resetScript([[[{ id: 3, order_status: 'shipped' }]]]);
  await assert.rejects(() => orders.updateOrderStatus('LX-TEST-ABC123', 'payment_confirmation_sent'), (error) => {
    assert.equal(error.code, 'INVALID_TRANSITION');
    return true;
  });

  await assert.rejects(() => orders.updateOrderStatus('LX-TEST-ABC123', 'teleported'), (error) => {
    assert.equal(error.statusCode, 400);
    return true;
  });
});