const test = require('node:test');
const assert = require('node:assert/strict');

// Cashbook synchronisation for the two transitions that move money: verifying a payment from
// any unpaid state, and cancelling an order that was already verified.

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'reversal-test';
process.env.DB_NAME = 'reversal_test';

const today = (() => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
})();

const categories = [
  { id: 1, name: 'Verified Order Income', entry_type: 'income', is_active: 1 },
  { id: 9, name: 'Order Refunds', entry_type: 'expense', is_active: 1 },
];
const orders = [];
const orderItems = [];
const configurations = [];
const statusHistory = [];
const entries = [];
let nextEntryId = 1;

function addOrder({ orderNumber, status, amount }) {
  const id = orders.length + 1;
  orders.push({
    id,
    order_number: orderNumber,
    customer_name: 'Reversal Test',
    customer_email: 'reversal@example.test',
    customer_phone: '081234567890',
    customer_address: 'Jl. Test 1',
    customer_note: null,
    total_amount: amount,
    order_status: status,
    created_at: `${today} 09:00:00`,
    updated_at: `${today} 09:00:00`,
    admin_notes: '',
    payment_verified_at: null,
  });
  orderItems.push({ id, order_id: id, product_name: 'Test charm', quantity: 1, unit_price: amount, subtotal: amount });
  configurations.push({ id, order_item_id: id, configuration_json: JSON.stringify({ configuration: { base: { id: 'heart' } } }), created_at: `${today} 09:00:00` });
  return orders[orders.length - 1];
}

function totals(rows) {
  return {
    income: rows.filter((entry) => entry.entry_type === 'income').reduce((sum, entry) => sum + entry.amount, 0),
    expenses: rows.filter((entry) => entry.entry_type === 'expense').reduce((sum, entry) => sum + entry.amount, 0),
  };
}

async function execute(sql, params = []) {
  const query = sql.replace(/\s+/g, ' ').trim();

  // --- order status transition -------------------------------------------------
  if (/^SELECT id, order_status, total_amount FROM orders WHERE order_number = \? LIMIT 1 FOR UPDATE$/i.test(query)) {
    return [orders.filter((order) => order.order_number === params[0]).map((order) => ({
      id: order.id,
      order_status: order.order_status,
      total_amount: order.total_amount,
    }))];
  }
  if (/^UPDATE orders SET/i.test(query)) {
    const orderId = Number(params[params.length - 1]);
    const order = orders.find((row) => row.id === orderId);
    if (!order) return [{ affectedRows: 0 }];
    order.order_status = params[0];
    if (query.includes('payment_verified_at = CURRENT_TIMESTAMP')) order.payment_verified_at = new Date();
    return [{ affectedRows: 1 }];
  }
  if (/^INSERT INTO order_status_history/i.test(query)) {
    statusHistory.push({ order_id: Number(params[0]), previous_status: params[1], new_status: params[2], changed_by: params[3], notes: params[4], created_at: new Date() });
    return [{ insertId: statusHistory.length, affectedRows: 1 }];
  }

  // --- cashbook reads -----------------------------------------------------------
  if (/^SELECT id, amount FROM cashbook_entries WHERE order_id = \? AND entry_type = 'income'/i.test(query)) {
    return [entries
      .filter((entry) => entry.order_id === Number(params[0]) && entry.entry_type === 'income')
      .map(({ id, amount }) => ({ id, amount }))];
  }
  if (/^SELECT reverses_entry_id FROM cashbook_entries WHERE order_id = \?/i.test(query)) {
    return [entries
      .filter((entry) => entry.order_id === Number(params[0]) && entry.reverses_entry_id)
      .map(({ reverses_entry_id }) => ({ reverses_entry_id }))];
  }
  if (/^SELECT id FROM cashbook_categories WHERE name = \? AND entry_type = \? AND is_active = 1/i.test(query)) {
    return [categories
      .filter((row) => row.name === params[0] && row.entry_type === params[1] && row.is_active)
      .map(({ id }) => ({ id }))];
  }

  // --- cashbook writes ----------------------------------------------------------
  if (/^INSERT INTO cashbook_entries/i.test(query)) {
    const sourceKey = query.includes('reverses_entry_id') ? params[5] : params[4];
    const existing = entries.find((entry) => entry.source_key === sourceKey);
    if (existing) return [{ insertId: existing.id, affectedRows: 0 }];

    if (query.includes('reverses_entry_id')) {
      const [amount, categoryId, description, notes, orderId, key, adminUserId, reversesEntryId] = params;
      const entry = {
        id: nextEntryId++,
        entry_type: 'expense',
        amount: Number(amount),
        category_id: Number(categoryId),
        description,
        payment_method: null,
        notes,
        transaction_date: today,
        order_id: Number(orderId),
        source_key: key,
        admin_user_id: adminUserId,
        reverses_entry_id: Number(reversesEntryId),
        supersedes_entry_id: null,
      };
      entries.push(entry);
      return [{ insertId: entry.id, affectedRows: 1 }];
    }

    const [amount, categoryId, description, orderId, key, adminUserId] = params;
    const entry = {
      id: nextEntryId++,
      entry_type: 'income',
      amount: Number(amount),
      category_id: Number(categoryId),
      description,
      payment_method: null,
      notes: null,
      transaction_date: today,
      order_id: Number(orderId),
      source_key: key,
      admin_user_id: adminUserId,
      reverses_entry_id: null,
      supersedes_entry_id: null,
    };
    entries.push(entry);
    return [{ insertId: entry.id, affectedRows: 1 }];
  }

  // --- order detail (returned by updateOrderStatusAdmin) ------------------------
  if (/^SELECT id, order_number, customer_name, customer_email, customer_phone,/i.test(query)) {
    return [orders.filter((order) => order.order_number === params[0]).map((order) => ({ ...order }))];
  }
  if (/^SELECT admin_notes, payment_verified_at/i.test(query)) {
    const order = orders.find((row) => row.id === Number(params[0]));
    return [[order ? {
      admin_notes: order.admin_notes || '',
      payment_verified_at: order.payment_verified_at,
      shipping_courier: null,
      tracking_number: null,
      shipped_at: null,
      completed_at: null,
    } : {}]];
  }
  if (/^SELECT id, product_name.* FROM order_items/i.test(query)) {
    return [orderItems.filter((item) => item.order_id === Number(params[0])).map((item) => ({ ...item }))];
  }
  if (/^SELECT id, order_item_id, configuration_json, created_at FROM customizer_configurations/i.test(query)) {
    return [configurations.filter((row) => params.map(Number).includes(row.order_item_id)).map((row) => ({ ...row }))];
  }
  if (/^SELECT id, previous_status, new_status, changed_by, notes, created_at FROM order_status_history/i.test(query)) {
    return [statusHistory.filter((row) => row.order_id === Number(params[0])).map((row, index) => ({ id: index + 1, ...row }))];
  }

  // --- cashbook summary ---------------------------------------------------------
  if (/^SELECT COALESCE\(SUM\(CASE WHEN e\.entry_type = 'income' THEN e\.amount ELSE 0 END\), 0\) AS income/i.test(query)) {
    const scoped = params.length >= 2
      ? entries.filter((entry) => entry.transaction_date >= params[0] && entry.transaction_date <= params[1])
      : entries;
    return [[totals(scoped)]];
  }
  if (/AS daily_income/i.test(query)) {
    const scoped = totals(entries);
    return [[{
      daily_income: scoped.income,
      daily_expenses: scoped.expenses,
      weekly_income: scoped.income,
      weekly_expenses: scoped.expenses,
      monthly_income: scoped.income,
      monthly_expenses: scoped.expenses,
      yearly_income: scoped.income,
      yearly_expenses: scoped.expenses,
    }]];
  }
  if (/DATE_FORMAT\(e\.transaction_date/i.test(query)) return [[]];

  throw new Error(`Unexpected reversal test SQL: ${query}`);
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
const cashbook = require('../src/server/cashbook');

const order = addOrder({ orderNumber: 'LX-REV-0001', status: 'payment_confirmation_sent', amount: 75000 });

test('verifying payment from an unpaid state books exactly one income entry', async () => {
  const paid = await ordersModule.updateOrderStatusAdmin(order.order_number, 'paid', { changedBy: 'admin', adminUserId: 4 });
  assert.equal(paid.status, 'paid');

  const income = entries.filter((entry) => entry.order_id === order.id);
  assert.equal(income.length, 1);
  assert.equal(income[0].entry_type, 'income');
  assert.equal(income[0].amount, 75000);
  assert.equal(income[0].source_key, `order-paid:${order.id}`);
  assert.equal(income[0].category_id, 1);
});

test('cancelling a verified order books one append-only refund pointing at the income', async () => {
  const cancelled = await ordersModule.updateOrderStatusAdmin(order.order_number, 'cancelled', { adminUserId: 4, notes: 'Customer changed their mind' });
  assert.equal(cancelled.status, 'cancelled');

  const orderEntries = entries.filter((entry) => entry.order_id === order.id);
  assert.equal(orderEntries.length, 2, 'the income row is preserved and one refund is added');

  const income = orderEntries.find((entry) => entry.entry_type === 'income');
  const refund = orderEntries.find((entry) => entry.entry_type === 'expense');
  assert.ok(refund, 'a refund row must exist');
  assert.equal(refund.amount, income.amount);
  assert.equal(refund.reverses_entry_id, income.id, 'the refund points at the income it reverses');
  assert.equal(refund.category_id, 9, 'the refund uses the system refund category');
  assert.equal(refund.source_key, `order-cancelled:${income.id}`);

  // Cancelling again must not duplicate the refund.
  order.order_status = 'paid';
  await ordersModule.updateOrderStatusAdmin(order.order_number, 'cancelled', { adminUserId: 4 });
  assert.equal(entries.filter((entry) => entry.order_id === order.id && entry.entry_type === 'expense').length, 1);
});

test('re-verifying a cancelled order records a new income cycle instead of hitting a duplicate key', async () => {
  const before = entries.filter((entry) => entry.order_id === order.id && entry.entry_type === 'income').length;

  const repaid = await ordersModule.updateOrderStatusAdmin(order.order_number, 'paid', { adminUserId: 4 });
  assert.equal(repaid.status, 'paid');

  const incomes = entries.filter((entry) => entry.order_id === order.id && entry.entry_type === 'income');
  assert.equal(incomes.length, before + 1, 'a new income row is created for the new payment cycle');
  assert.deepEqual(incomes.map((entry) => entry.source_key), [`order-paid:${order.id}`, `order-paid:${order.id}:1`]);
});

test('the cashbook balance reflects the refund and the re-verification', async () => {
  const summary = await cashbook.getCashbookSummary({ period: 'today' });
  // Two verified payments of 75.000 and one 75.000 refund.
  assert.equal(summary.totals.income, 150000);
  assert.equal(summary.totals.expenses, 75000);
  assert.equal(summary.totals.balance, 75000);
});
