const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'cashbook-test';
process.env.DB_NAME = 'cashbook_test';

const today = (() => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
})();
const yesterday = (() => {
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
})();

const categories = [
  { id: 1, name: 'Verified Order Income', entry_type: 'income', is_active: 1 },
  { id: 2, name: 'Material', entry_type: 'expense', is_active: 1 },
  { id: 3, name: 'Operational', entry_type: 'expense', is_active: 1 },
];
const entries = [];
const orders = [];
const orderItems = [];
const configurations = [];
const statusHistory = [];
let nextEntryId = 1;
let nextCategoryId = 4;
let transactionSnapshot = null;
let failNextExpenseInsert = false;

function effectiveEntries() {
  const replacedIds = new Set(entries.map((entry) => entry.supersedes_entry_id).filter(Boolean));
  return entries.filter((entry) => !replacedIds.has(entry.id));
}

function joinedEntry(entry) {
  const category = categories.find((row) => row.id === entry.category_id);
  const order = orders.find((row) => row.id === entry.order_id);
  return {
    ...entry,
    category_name: category && category.name,
    order_number: order && order.order_number,
    admin_username: entry.admin_user_id ? 'cashbook-admin' : null,
  };
}

function reportRows(filters = {}) {
  let rows = effectiveEntries().filter((entry) => entry.transaction_date >= filters.from && entry.transaction_date <= filters.to);
  if (filters.entryType) rows = rows.filter((entry) => entry.entry_type === filters.entryType);
  return rows.sort((a, b) => a.transaction_date.localeCompare(b.transaction_date) || a.id - b.id).map(joinedEntry);
}

async function execute(sql, params = []) {
  const query = sql.replace(/\s+/g, ' ').trim();

  if (/^SELECT id, name, entry_type FROM cashbook_categories WHERE id = \? LIMIT 1$/i.test(query)) {
    return [categories.filter((row) => row.id === Number(params[0])).map(({ id, name, entry_type }) => ({ id, name, entry_type }))];
  }
  if (/^SELECT id FROM cashbook_categories WHERE id = \? AND entry_type = 'expense'/i.test(query)) {
    return [categories.filter((row) => row.id === Number(params[0]) && row.entry_type === 'expense' && row.is_active)];
  }
  if (/^SELECT id FROM cashbook_categories WHERE name = \? AND entry_type = 'income'/i.test(query)) {
    return [categories.filter((row) => row.name === params[0] && row.entry_type === 'income' && row.is_active)];
  }
  if (/^SELECT id, name, entry_type, is_active, created_at FROM cashbook_categories/i.test(query)) {
    return [categories.map((row) => ({ ...row, created_at: new Date() })).sort((a, b) => a.entry_type.localeCompare(b.entry_type) || a.name.localeCompare(b.name))];
  }
  if (/^INSERT INTO cashbook_categories/i.test(query)) {
    if (categories.some((row) => row.entry_type === params[1] && row.name.toLowerCase() === String(params[0]).toLowerCase())) {
      const error = new Error('Duplicate category');
      error.code = 'ER_DUP_ENTRY';
      throw error;
    }
    const category = { id: nextCategoryId++, name: params[0], entry_type: params[1], is_active: 1 };
    categories.push(category);
    return [{ insertId: category.id, affectedRows: 1 }];
  }
  if (/^UPDATE cashbook_categories SET is_active = \? WHERE id = \?$/i.test(query)) {
    const category = categories.find((row) => row.id === Number(params[1]));
    if (category) category.is_active = Number(params[0]);
    return [{ affectedRows: category ? 1 : 0 }];
  }
  if (/^SELECT id, entry_type, amount, category_id, description, payment_method, notes, transaction_date FROM cashbook_entries WHERE id = \? LIMIT 1 FOR UPDATE$/i.test(query)) {
    return [entries.filter((row) => row.id === Number(params[0])).map((row) => ({ ...row }))];
  }
  if (/^SELECT id, amount FROM cashbook_entries WHERE order_id = \? AND entry_type = 'income'/i.test(query)) {
    return [entries
      .filter((row) => row.order_id === Number(params[0]) && row.entry_type === 'income')
      .map(({ id, amount }) => ({ id, amount }))];
  }
  if (/^SELECT reverses_entry_id FROM cashbook_entries WHERE order_id = \?/i.test(query)) {
    return [entries
      .filter((row) => row.order_id === Number(params[0]) && row.reverses_entry_id)
      .map(({ reverses_entry_id }) => ({ reverses_entry_id }))];
  }
  if (/^SELECT id FROM cashbook_categories WHERE name = \? AND entry_type = \? AND is_active = 1/i.test(query)) {
    return [categories
      .filter((row) => row.name === params[0] && row.entry_type === params[1] && row.is_active)
      .map(({ id }) => ({ id }))];
  }
  if (/^SELECT id FROM cashbook_entries WHERE supersedes_entry_id = \? LIMIT 1$/i.test(query)) {
    return [entries.filter((row) => row.supersedes_entry_id === Number(params[0])).map(({ id }) => ({ id }))];
  }
  if (/^INSERT INTO cashbook_entries/i.test(query)) {
    if (failNextExpenseInsert && /VALUES \('expense'/i.test(query)) {
      failNextExpenseInsert = false;
      throw new Error('Simulated cashbook insert failure');
    }
    if (/VALUES \('expense'/i.test(query)) {
      const [amount, categoryId, description, paymentMethod, notes, transactionDate, adminUserId, supersedesEntryId, correctionNote] = params;
      const entry = {
        id: nextEntryId++,
        entry_type: 'expense',
        amount: Number(amount),
        category_id: Number(categoryId),
        description,
        payment_method: paymentMethod,
        notes,
        transaction_date: transactionDate,
        order_id: null,
        source_key: null,
        admin_user_id: adminUserId,
        supersedes_entry_id: supersedesEntryId,
        correction_note: correctionNote,
        created_at: new Date(),
      };
      entries.push(entry);
      return [{ insertId: entry.id, affectedRows: 1 }];
    }
    const [amount, categoryId, description, orderId, sourceKey, adminUserId] = params;
    const existing = entries.find((entry) => entry.source_key === sourceKey || (entry.order_id === orderId && entry.entry_type === 'income'));
    if (existing) return [{ insertId: existing.id, affectedRows: 0 }];
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
      source_key: sourceKey,
      admin_user_id: adminUserId,
      supersedes_entry_id: null,
      correction_note: null,
      created_at: new Date(),
    };
    entries.push(entry);
    return [{ insertId: entry.id, affectedRows: 1 }];
  }
  if (/^SELECT e\.id, e\.entry_type, e\.amount, e\.category_id, c\.name AS category_name/i.test(query) && /WHERE e\.id = \? LIMIT 1$/i.test(query)) {
    return [entries.filter((entry) => entry.id === Number(params[0])).map(joinedEntry)];
  }
  if (/^WITH RECURSIVE entry_history AS/i.test(query)) {
    let current = entries.find((entry) => entry.id === Number(params[0]));
    const history = [];
    while (current) {
      history.push(joinedEntry(current));
      current = current.supersedes_entry_id
        ? entries.find((entry) => entry.id === current.supersedes_entry_id)
        : null;
    }
    return [history.reverse()];
  }
  if (/^SELECT COUNT\(\*\) AS total FROM cashbook_entries e/i.test(query)) {
    const from = params[0];
    const to = params[1];
    let rows = effectiveEntries().filter((entry) => entry.transaction_date >= from && entry.transaction_date <= to);
    let index = 2;
    if (/e\.entry_type = \?/i.test(query)) {
      rows = rows.filter((entry) => entry.entry_type === params[index]);
      index += 1;
    }
    if (/e\.description LIKE \?/i.test(query)) {
      const term = String(params[index]).replace(/%/g, '').toLowerCase();
      rows = rows.filter((entry) => entry.description.toLowerCase().includes(term));
    }
    return [[{ total: rows.length }]];
  }
  if (/^SELECT e\.id, e\.entry_type, e\.amount, e\.category_id, c\.name AS category_name/i.test(query)) {
    let range = { from: today.slice(0, 7) + '-01', to: today };
    if (params.length >= 2) range = { from: params[0], to: params[1] };
    return [reportRows(range)];
  }
  if (/^SELECT COALESCE\(SUM\(CASE WHEN e\.entry_type = 'income' THEN e\.amount/i.test(query)) {
    const filtered = params.length
      ? effectiveEntries().filter((entry) => entry.transaction_date >= params[0] && entry.transaction_date <= params[1])
      : effectiveEntries();
    return [[{
      income: filtered.filter((entry) => entry.entry_type === 'income').reduce((sum, entry) => sum + entry.amount, 0),
      expenses: filtered.filter((entry) => entry.entry_type === 'expense').reduce((sum, entry) => sum + entry.amount, 0),
    }]];
  }
  if (/AS daily_income/i.test(query)) {
    const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    const weekStart = (() => {
      const date = new Date(`${today}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() - ((weekday + 6) % 7));
      return date.toISOString().slice(0, 10);
    })();
    const currentMonth = today.slice(0, 7);
    const currentYear = today.slice(0, 4);
    const current = effectiveEntries();
    const total = (type, predicate) => current
      .filter((entry) => entry.entry_type === type && predicate(entry.transaction_date))
      .reduce((sum, entry) => sum + entry.amount, 0);
    return [[{
      daily_income: total('income', (date) => date === today),
      daily_expenses: total('expense', (date) => date === today),
      weekly_income: total('income', (date) => date >= weekStart && date <= today),
      weekly_expenses: total('expense', (date) => date >= weekStart && date <= today),
      monthly_income: total('income', (date) => date.startsWith(currentMonth)),
      monthly_expenses: total('expense', (date) => date.startsWith(currentMonth)),
      yearly_income: total('income', (date) => date.startsWith(currentYear)),
      yearly_expenses: total('expense', (date) => date.startsWith(currentYear)),
    }]];
  }
  if (/DATE_FORMAT\(e\.transaction_date/i.test(query)) {
    const grouped = new Map();
    effectiveEntries()
      .filter((entry) => entry.transaction_date >= params[0] && entry.transaction_date <= params[1])
      .forEach((entry) => {
        const key = `${entry.transaction_date}:${entry.entry_type}`;
        grouped.set(key, (grouped.get(key) || 0) + entry.amount);
      });
    return [[...grouped.entries()].map(([key, amount]) => {
      const [transaction_date, entry_type] = key.split(':');
      return { transaction_date, entry_type, amount };
    })];
  }
  if (/^SELECT id, order_status, total_amount FROM orders WHERE order_number = \? LIMIT 1 FOR UPDATE$/i.test(query)) {
    return [orders.filter((order) => order.order_number === params[0]).map((order) => ({
      id: order.id,
      order_status: order.order_status,
      total_amount: order.total_amount,
    }))];
  }
  if (/^SELECT id, order_number, customer_name, customer_email, customer_phone,/i.test(query)) {
    if (/WHERE order_number = \? LIMIT 1 FOR UPDATE/i.test(query)) {
      return [orders.filter((order) => order.order_number === params[0]).map((order) => ({
        id: order.id,
        order_status: order.order_status,
        total_amount: order.total_amount,
      }))];
    }
    if (/WHERE order_number = \? LIMIT 1$/i.test(query)) {
      return [orders.filter((order) => order.order_number === params[0]).map((order) => ({ ...order }))];
    }
    if (/WHERE created_at >= \?/i.test(query)) {
      const from = String(params[0]).slice(0, 10);
      const to = String(params[1]).slice(0, 10);
      return [orders.filter((order) => order.created_at.slice(0, 10) >= from && order.created_at.slice(0, 10) <= to).map((order) => ({
        id: order.id,
        order_number: order.order_number,
        customer_name: order.customer_name,
        customer_email: order.customer_email,
        customer_phone: order.customer_phone,
        total_amount: order.total_amount,
        order_status: order.order_status,
        created_at: order.created_at,
        payment_verified_at: order.payment_verified_at,
      }))];
    }
  }
  if (/^SELECT order_status, COUNT\(\*\) AS order_count/i.test(query)) {
    return [[...new Set(orders.map((order) => order.order_status))].map((status) => {
      const matching = orders.filter((order) => order.order_status === status && order.created_at.slice(0, 10) >= params[0] && order.created_at.slice(0, 10) <= params[1]);
      return { order_status: status, order_count: matching.length, order_value: matching.reduce((sum, order) => sum + order.total_amount, 0) };
    }).filter((row) => row.order_count)];
  }
  if (/^UPDATE orders SET/i.test(query)) {
    const orderId = Number(params[params.length - 1]);
    const order = orders.find((row) => row.id === orderId);
    if (order) {
      order.order_status = params[0];
      if (params.includes(orderId) && query.includes('payment_verified_at = CURRENT_TIMESTAMP')) order.payment_verified_at = new Date();
    }
    return [{ affectedRows: order ? 1 : 0 }];
  }
  if (/^INSERT INTO order_status_history/i.test(query)) {
    statusHistory.push({ order_id: Number(params[0]), previous_status: params[1], new_status: params[2], changed_by: params[3], notes: params[4], created_at: new Date() });
    return [{ insertId: statusHistory.length, affectedRows: 1 }];
  }
  if (/^SELECT admin_notes, payment_verified_at/i.test(query)) {
    const order = orders.find((row) => row.id === Number(params[0]));
    return [[order ? {
      admin_notes: order.admin_notes || '',
      payment_verified_at: order.payment_verified_at || null,
      shipping_courier: null,
      tracking_number: null,
      shipped_at: null,
      completed_at: null,
    } : {}]];
  }
  if (/^SELECT id, product_name, quantity, unit_price, subtotal FROM order_items/i.test(query)) {
    return [orderItems.filter((item) => item.order_id === Number(params[0])).map((item) => ({ ...item }))];
  }
  if (/^SELECT id, order_item_id, configuration_json, created_at FROM customizer_configurations/i.test(query)) {
    return [configurations.filter((row) => params.map(Number).includes(row.order_item_id)).map((row) => ({ ...row }))];
  }
  if (/^SELECT id, previous_status, new_status, changed_by, notes, created_at FROM order_status_history/i.test(query)) {
    return [statusHistory.filter((row) => row.order_id === Number(params[0])).map((row, id) => ({ id: id + 1, ...row }))];
  }

  throw new Error(`Unexpected cashbook test SQL: ${query}`);
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
            async beginTransaction() {
              transactionSnapshot = structuredClone({ categories, entries, orders, orderItems, configurations, statusHistory });
            },
            async commit() {
              transactionSnapshot = null;
            },
            async rollback() {
              if (!transactionSnapshot) return;
              for (const [target, key] of [
                [categories, 'categories'],
                [entries, 'entries'],
                [orders, 'orders'],
                [orderItems, 'orderItems'],
                [configurations, 'configurations'],
                [statusHistory, 'statusHistory'],
              ]) {
                target.splice(0, target.length, ...transactionSnapshot[key]);
              }
              transactionSnapshot = null;
            },
            release() {},
          };
        },
        async end() {},
      };
    },
  },
};

const cashbook = require('../src/server/cashbook');
const ordersModule = require('../src/server/orders');
const reports = require('../src/server/reports');
const { handleApiRequest } = require('../src/server/api');

function addOrder({ orderNumber, status, amount, createdAt = `${today} 10:00:00`, config = { base: { id: 'heart' } } }) {
  const id = orders.length + 1;
  const itemId = orderItems.length + 1;
  const order = {
    id,
    order_number: orderNumber,
    customer_name: 'Cashbook Test',
    customer_email: 'cashbook@example.test',
    customer_phone: '0800000000',
    customer_address: 'Test address',
    customer_note: null,
    total_amount: amount,
    order_status: status,
    created_at: createdAt,
    updated_at: createdAt,
    admin_notes: '',
    payment_verified_at: null,
  };
  orders.push(order);
  orderItems.push({ id: itemId, order_id: id, product_name: 'Test charm', quantity: 1, unit_price: amount, subtotal: amount });
  configurations.push({ id: itemId, order_item_id: itemId, configuration_json: JSON.stringify(config), created_at: createdAt });
  return order;
}

test('verifying payment writes one income from any unpaid status and preserves order configuration', async () => {
  const order = addOrder({ orderNumber: `LX-CASH-${crypto.randomBytes(3).toString('hex')}`, status: 'payment_confirmation_sent', amount: 125000 });
  const originalConfiguration = configurations.find((row) => row.order_item_id === order.id).configuration_json;

  const paid = await ordersModule.updateOrderStatusAdmin(order.order_number, 'paid', { changedBy: 'cashbook-admin', adminUserId: 7 });
  assert.equal(paid.status, 'paid');
  const income = entries.filter((entry) => entry.order_id === order.id);
  assert.equal(income.length, 1);
  assert.equal(income[0].entry_type, 'income');
  assert.equal(income[0].amount, 125000);
  assert.equal(income[0].source_key, `order-paid:${order.id}`);
  assert.equal(configurations.find((row) => row.order_item_id === order.id).configuration_json, originalConfiguration);

  order.order_status = 'payment_confirmation_sent';
  await ordersModule.updateOrderStatusAdmin(order.order_number, 'paid', { adminUserId: 7 });
  assert.equal(entries.filter((entry) => entry.order_id === order.id).length, 1);

  const unpaid = addOrder({ orderNumber: `LX-UNPAID-${crypto.randomBytes(3).toString('hex')}`, status: 'waiting_for_payment', amount: 99000 });
  await ordersModule.updateOrderStatusAdmin(unpaid.order_number, 'paid', { adminUserId: 7 });
  const unpaidIncome = entries.filter((entry) => entry.order_id === unpaid.id);
  assert.equal(unpaidIncome.length, 1, 'verifying straight from waiting_for_payment must still book income');
  assert.equal(unpaidIncome[0].amount, 99000);
  assert.equal(unpaidIncome[0].source_key, `order-paid:${unpaid.id}`);

  // Re-verifying the same order stays idempotent even when the status was moved back.
  unpaid.order_status = 'waiting_for_payment';
  await ordersModule.updateOrderStatusAdmin(unpaid.order_number, 'paid', { adminUserId: 7 });
  assert.equal(entries.filter((entry) => entry.order_id === unpaid.id).length, 1, 'no duplicate income rows');
});

test('verified payment and income record roll back together when cashbook setup is unavailable', async () => {
  const order = addOrder({ orderNumber: `LX-ROLLBACK-${crypto.randomBytes(3).toString('hex')}`, status: 'payment_confirmation_sent', amount: 50000 });
  categories[0].is_active = 0;
  await assert.rejects(
    () => ordersModule.updateOrderStatusAdmin(order.order_number, 'paid', { adminUserId: 7 }),
    (error) => error.code === 'CASHBOOK_NOT_MIGRATED',
  );
  categories[0].is_active = 1;
  assert.equal(orders.find((row) => row.id === order.id).order_status, 'payment_confirmation_sent');
  assert.equal(entries.some((entry) => entry.order_id === order.id), false);
});

test('expenses validate, persist notes, support append-only correction, and calculate balances', async () => {
  const income = entries.filter((entry) => entry.entry_type === 'income').reduce((sum, entry) => sum + entry.amount, 0);
  const first = await cashbook.createExpense({
    categoryId: 2,
    transactionDate: today,
    description: 'Acrylic sheets',
    amount: '22000',
    paymentMethod: 'Bank transfer',
    notes: 'Supplier invoice A-1',
  }, 7);
  assert.equal(first.amount, 22000);
  assert.equal(first.notes, 'Supplier invoice A-1');

  const correction = await cashbook.correctExpense(first.id, {
    categoryId: 3,
    transactionDate: yesterday,
    description: 'Corrected acrylic sheets',
    amount: '24000',
    paymentMethod: 'Cash',
    notes: 'Corrected invoice total',
    correctionNote: 'Entered the wrong invoice amount',
  }, 7);
  assert.equal(correction.supersedesEntryId, first.id);
  assert.equal(entries.filter((entry) => entry.entry_type === 'expense').length, 2);
  const history = await cashbook.getEntryHistory(correction.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].amount, 22000);
  assert.equal(history[1].amount, 24000);

  const summary = await cashbook.getCashbookSummary({ period: 'custom', from: yesterday, to: today });
  assert.equal(summary.totals.income, income);
  assert.equal(summary.totals.expenses, 24000);
  assert.equal(summary.totals.balance, income - 24000);
  assert.equal(summary.range.expenses, 24000);
});

test('expenses reject invalid amounts and failed inserts roll back', async () => {
  const countBefore = entries.length;
  await assert.rejects(
    () => cashbook.createExpense({
      categoryId: 2,
      transactionDate: today,
      description: 'Invalid',
      amount: 0,
      paymentMethod: 'Cash',
    }, 7),
    (error) => error.code === 'invalid_amount' && error.statusCode === 400,
  );
  failNextExpenseInsert = true;
  await assert.rejects(
    () => cashbook.createExpense({
      categoryId: 2,
      transactionDate: today,
      description: 'Rollback check',
      amount: 1,
      paymentMethod: 'Cash',
    }, 7),
    /Simulated cashbook insert failure/,
  );
  assert.equal(entries.length, countBefore);
});

test('date filters support standard periods and validate custom ranges', () => {
  assert.equal(cashbook.resolveDateRange({ period: 'today' }).from, today);
  assert.equal(cashbook.resolveDateRange({ period: 'month' }).from, `${today.slice(0, 7)}-01`);
  assert.equal(cashbook.resolveDateRange({ period: 'year' }).from, `${today.slice(0, 4)}-01-01`);
  assert.throws(() => cashbook.resolveDateRange({ period: 'custom', from: today }), { code: 'invalid_date_range' });
  assert.throws(() => cashbook.resolveDateRange({ period: 'custom', from: today, to: yesterday }), { code: 'invalid_date_range' });
});

test('Excel workbook contains five styled worksheets with real order and cashbook rows', async () => {
  const workbookBuffer = await reports.createReportWorkbook({ period: 'custom', from: yesterday, to: today, scope: 'expenses' });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(workbookBuffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Summary', 'Orders', 'Income', 'Expenses', 'Cashbook']);
  const orderSheet = workbook.getWorksheet('Orders');
  assert.equal(orderSheet.getCell('A4').value.startsWith('LX-CASH-'), true);
  assert.match(orderSheet.getCell('G4').numFmt, /Rp/);
  assert.equal(workbook.getWorksheet('Income').getCell('F4').value, 125000);
  assert.equal(workbook.getWorksheet('Expenses').getCell('C4').value, 'Corrected acrylic sheets');
  assert.equal(workbook.views[0].activeTab, 3);
  assert.equal(workbook.getWorksheet('Cashbook').views[0].state, 'frozen');
});

test('cashbook and report APIs reject unauthenticated access', async () => {
  const paths = [
    { method: 'GET', path: '/api/admin/cashbook' },
    { method: 'GET', path: '/api/admin/cashbook/summary' },
    { method: 'POST', path: '/api/admin/cashbook/expenses', body: { amount: 100 } },
    { method: 'GET', path: '/api/admin/reports/summary' },
    { method: 'GET', path: '/api/admin/reports/export.xlsx' },
  ];
  for (const item of paths) {
    const payload = item.body ? JSON.stringify(item.body) : '';
    const request = {
      method: item.method,
      headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
      on(event, handler) {
        if (event === 'data' && payload) handler(Buffer.from(payload));
        if (event === 'end') handler();
        return request;
      },
    };
    let status = 200;
    const response = {
      writeHead(code) { status = code; },
      end() {},
    };
    await handleApiRequest(request, response, new URL(item.path, 'http://localhost'));
    assert.equal(status, 401, `${item.method} ${item.path} must require admin authentication`);
  }
});

test('cashbook mutation rejects requests with an untrusted Origin', async () => {
  const payload = JSON.stringify({ categoryId: 2, amount: 100, transactionDate: today, description: 'CSRF check', paymentMethod: 'Cash' });
  const request = {
    method: 'POST',
    headers: { host: 'localhost', origin: 'https://attacker.example', 'content-type': 'application/json' },
    on() { return request; },
  };
  let status = 200;
  const response = {
    writeHead(code) { status = code; },
    end() {},
  };
  await handleApiRequest(request, response, new URL('/api/admin/cashbook/expenses', 'http://localhost'));
  assert.equal(status, 403);
});
