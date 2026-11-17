const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Admin payment verification: the unpaid filter, the paid transition (timestamp + audit +
// cashbook income) and the dashboard affordances that expose it.

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'payment-verify-test';
process.env.DB_NAME = 'payment_verify_test';

const root = path.join(__dirname, '..');
const today = (() => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
})();

const orders = [{
  id: 5,
  order_number: 'LX-PAY-0001',
  customer_name: 'Siti Rahma',
  customer_email: 'siti@example.test',
  customer_phone: '081234567890',
  customer_address: 'Jl. Asia Afrika 8, Bandung',
  customer_note: null,
  total_amount: 52000,
  order_status: 'waiting_for_payment',
  created_at: `${today} 09:00:00`,
  updated_at: `${today} 09:00:00`,
  admin_notes: '',
  payment_verified_at: null,
}];

const history = [];
const entries = [];
const calls = [];

function record(sql, params) {
  calls.push({ sql, params });
}

async function execute(sql, params = []) {
  const query = sql.replace(/\s+/g, ' ').trim();

  // --- admin order list -------------------------------------------------------
  if (/^SELECT COUNT\(DISTINCT o\.id\) AS total FROM orders o/i.test(query)) {
    record(query, params);
    return [[{ total: orders.length }]];
  }
  if (/^SELECT o\.id, o\.order_number, o\.customer_name/i.test(query)) {
    record(query, params);
    return [orders.map((order) => ({ ...order }))];
  }
  if (/^SELECT oi\.id, oi\.order_id/i.test(query)) {
    record(query, params);
    return [[]];
  }

  // --- status transition ------------------------------------------------------
  if (/^SELECT id, order_status, total_amount FROM orders WHERE order_number = \? LIMIT 1 FOR UPDATE$/i.test(query)) {
    record(query, params);
    return [orders.filter((order) => order.order_number === params[0]).map((order) => ({
      id: order.id,
      order_status: order.order_status,
      total_amount: order.total_amount,
    }))];
  }
  if (/^UPDATE orders SET/i.test(query)) {
    record(query, params);
    const order = orders.find((row) => row.id === Number(params[params.length - 1]));
    if (!order) return [{ affectedRows: 0 }];
    order.order_status = params[0];
    if (query.includes('payment_verified_at = CURRENT_TIMESTAMP')) order.payment_verified_at = new Date();
    return [{ affectedRows: 1 }];
  }
  if (/^INSERT INTO order_status_history/i.test(query)) {
    record(query, params);
    history.push({ previous_status: params[1], new_status: params[2], changed_by: params[3] });
    return [{ insertId: history.length }];
  }

  // --- cashbook ---------------------------------------------------------------
  if (/^SELECT id, amount FROM cashbook_entries WHERE order_id = \? AND entry_type = 'income'/i.test(query)) {
    record(query, params);
    return [entries
      .filter((entry) => entry.order_id === Number(params[0]) && entry.entry_type === 'income')
      .map(({ id, amount }) => ({ id, amount }))];
  }
  if (/^SELECT reverses_entry_id FROM cashbook_entries WHERE order_id = \?/i.test(query)) {
    record(query, params);
    return [[]];
  }
  if (/^SELECT id FROM cashbook_categories WHERE name = \? AND entry_type = \? AND is_active = 1/i.test(query)) {
    record(query, params);
    return [[{ id: 1 }]];
  }
  if (/^INSERT INTO cashbook_entries/i.test(query)) {
    record(query, params);
    const entry = {
      id: entries.length + 1,
      entry_type: 'income',
      amount: Number(params[0]),
      order_id: Number(params[3]),
      source_key: params[4],
    };
    entries.push(entry);
    return [{ insertId: entry.id }];
  }

  // --- order detail returned after the transition ------------------------------
  if (/^SELECT id, order_number, customer_name, customer_email, customer_phone,/i.test(query)) {
    record(query, params);
    return [orders.filter((order) => order.order_number === params[0]).map((order) => ({ ...order }))];
  }
  if (/^SELECT admin_notes, payment_verified_at/i.test(query)) {
    record(query, params);
    const order = orders.find((row) => row.id === Number(params[0]));
    return [[{
      admin_notes: order.admin_notes || '',
      payment_verified_at: order.payment_verified_at,
      shipping_courier: null,
      tracking_number: null,
      shipped_at: null,
      completed_at: null,
    }]];
  }
  if (/^SELECT id, product_name, quantity, unit_price, subtotal FROM order_items/i.test(query)) {
    record(query, params);
    return [[{ id: 1, product_name: 'Cloud Heart', quantity: 1, unit_price: 52000, subtotal: 52000 }]];
  }
  if (/^SELECT id, order_item_id, configuration_json, created_at FROM customizer_configurations/i.test(query)) {
    record(query, params);
    return [[{ id: 1, order_item_id: 1, configuration_json: '{}', created_at: `${today} 09:00:00` }]];
  }
  if (/^SELECT id, previous_status, new_status, changed_by, notes, created_at FROM order_status_history/i.test(query)) {
    record(query, params);
    return [history.map((row, index) => ({ id: index + 1, ...row, notes: null, created_at: `${today} 09:30:00` }))];
  }

  throw new Error(`Unexpected payment verification SQL: ${query}`);
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

const ordersModule = require('../src/server/orders');

test('the unpaid filter groups waiting and proof-sent orders in one query', async () => {
  calls.length = 0;
  await ordersModule.listOrdersAdmin({ status: 'unpaid' });

  const countCall = calls.find((call) => /^SELECT COUNT/i.test(call.sql));
  assert.ok(countCall, 'the count query must run');
  assert.match(countCall.sql, /o\.order_status IN \(\?, \?\)/, 'both unpaid statuses must be in the WHERE clause');
  assert.deepEqual(countCall.params, ['waiting_for_payment', 'payment_confirmation_sent']);

  const listCall = calls.find((call) => /^SELECT o\.id, o\.order_number/i.test(call.sql));
  assert.match(listCall.sql, /o\.order_status IN \(\?, \?\)/);
  assert.deepEqual(listCall.params, ['waiting_for_payment', 'payment_confirmation_sent']);
});

test('verifying payment stamps the time, writes history and books the income', async () => {
  calls.length = 0;
  history.length = 0;
  entries.length = 0;
  orders[0].order_status = 'waiting_for_payment';
  orders[0].payment_verified_at = null;

  const verified = await ordersModule.updateOrderStatusAdmin('LX-PAY-0001', 'paid', {
    changedBy: 'admin',
    adminUserId: 3,
    notes: 'Transfer verified on WhatsApp',
  });

  assert.equal(verified.status, 'paid');
  assert.ok(verified.paymentVerifiedAt, 'the drawer must be able to show when payment was verified');

  const updateCall = calls.find((call) => /^UPDATE orders SET/i.test(call.sql));
  assert.match(updateCall.sql, /payment_verified_at = CURRENT_TIMESTAMP/, 'the verification timestamp must be written');

  assert.equal(history.length, 1);
  assert.deepEqual(history[0], {
    previous_status: 'waiting_for_payment',
    new_status: 'paid',
    changed_by: 'admin',
  });

  assert.equal(entries.length, 1, 'verifying from waiting_for_payment must book income');
  assert.equal(entries[0].amount, 52000);
  assert.equal(entries[0].source_key, 'order-paid:5');
});

test('saving an already verified order again does not overwrite the timestamp or double-book income', async () => {
  calls.length = 0;

  const again = await ordersModule.updateOrderStatusAdmin('LX-PAY-0001', 'paid', { changedBy: 'admin' });

  assert.equal(again.status, 'paid');
  const updateCall = calls.find((call) => /^UPDATE orders SET/i.test(call.sql));
  assert.doesNotMatch(updateCall.sql, /payment_verified_at/, 'the original verification time must be preserved');
  assert.equal(entries.length, 1, 'income must not be booked twice');
});

test('the dashboard exposes the unpaid filter and a verify action for those orders', () => {
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'src', 'admin.js'), 'utf8');

  assert.match(html, /data-status="unpaid"/, 'the Orders view must offer a combined unpaid filter');
  assert.match(html, /id="countUnpaid"/);
  assert.match(html, /id="detailStatusMeta"/, 'the drawer must show verification context');

  assert.match(script, /Verify Payment/, 'the drawer must offer a verify action');
  assert.match(script, /income booked in the cashbook/, 'verifying must confirm the cashbook booking');
  assert.match(script, /row-attention/, 'unpaid rows must be visually flagged in the table');
});
