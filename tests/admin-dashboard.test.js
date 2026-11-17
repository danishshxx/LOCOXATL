const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSchemaStatements } = require('../src/server/migrate');

const root = path.join(__dirname, '..');

// 1. Static asset and markup tests
test('admin dashboard markup and client scripts are present', () => {
  const adminHtmlPath = path.join(root, 'admin.html');
  const adminCssPath = path.join(root, 'assets', 'admin.css');
  const adminJsPath = path.join(root, 'src', 'admin.js');
  const migrationPath = path.join(root, 'database', 'migrations', '001_admin_dashboard.sql');

  assert.ok(fs.existsSync(adminHtmlPath), 'admin.html must exist');
  assert.ok(fs.existsSync(adminCssPath), 'assets/admin.css must exist');
  assert.ok(fs.existsSync(adminJsPath), 'src/admin.js must exist');
  assert.ok(fs.existsSync(migrationPath), 'migration SQL file must exist');

  const html = fs.readFileSync(adminHtmlPath, 'utf8');
  assert.match(html, /id="adminViewerCanvas"/, 'must contain 3D canvas for workshop viewer');
  assert.match(html, /id="adminViewerExplode"/, 'must contain Explode view button');
  assert.match(html, /id="adminViewerAssemble"/, 'must contain Assemble view button');
  assert.match(html, /id="bomList"/, 'must contain Bill of Materials section');
  assert.match(html, /id="adminLoginForm"/, 'must contain auth gate form');
  assert.match(html, /id="ordersTableBody"/, 'must contain orders table');
  assert.match(html, /id="customerWhatsAppBtn"/, 'must contain direct WhatsApp action button');
  assert.match(html, /importmap/, 'must declare Three.js import map');
});

test('additive migration SQL file is safe and preserves existing customer schema', () => {
  const sql = fs.readFileSync(path.join(root, 'database', 'migrations', '001_admin_dashboard.sql'), 'utf8');
  assert.match(sql, /orders/);
  assert.match(sql, /admin_notes/);
  assert.match(sql, /payment_verified_at/);
  assert.match(sql, /shipping_courier/);
  assert.match(sql, /tracking_number/);
  assert.match(sql, /order_status_history/);
  assert.doesNotMatch(sql, /DROP TABLE/i, 'migration must never drop tables');
  assert.doesNotMatch(sql, /TRUNCATE/i, 'migration must never truncate data');
});

test('cashbook migration creates only additive tables with positive amounts', () => {
  const sql = fs.readFileSync(path.join(root, 'database', 'migrations', '002_cashbook.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS cashbook_categories/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS cashbook_entries/i);
  assert.match(sql, /amount BIGINT UNSIGNED NOT NULL/i);
  assert.match(sql, /CHECK \(amount > 0\)/i);
  assert.match(sql, /UNIQUE KEY uq_cashbook_source_key \(source_key\)/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM\s+(?:orders|order_items|customizer_configurations)/i);
});

test('base schema and SQL migrations use the selected database without creating or switching databases', () => {
  const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
  const migrationFiles = [
    'database/migrations/001_admin_dashboard.sql',
    'database/migrations/002_cashbook.sql',
  ];

  assert.doesNotMatch(schema, /CREATE\s+DATABASE|^\s*USE\s+/im);
  assert.doesNotMatch(schema, /DROP\s+TABLE|TRUNCATE/i);
  assert.ok(parseSchemaStatements(schema).every((statement) => /^CREATE TABLE IF NOT EXISTS/i.test(statement)));
  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(sql, /^\s*USE\s+/im, `${file} must not switch databases`);
    assert.doesNotMatch(sql, /DROP\s+TABLE|TRUNCATE/i, `${file} must not erase data`);
  }
});

// 2. Unit and business logic tests with mocked MySQL driver
const MYSQL_PATH = require.resolve('mysql2/promise');
const mockCalls = [];
let mockScripted = [];

function resetMock(responses = []) {
  mockCalls.length = 0;
  mockScripted = [...responses];
}

function mockStatement(sql, params) {
  const cleanSql = sql.replace(/\s+/g, ' ').trim();
  mockCalls.push({ sql: cleanSql, params });
  if (/^UPDATE/i.test(cleanSql)) return [{ affectedRows: 1 }];
  if (/^INSERT/i.test(cleanSql)) return [{ insertId: 10, affectedRows: 1 }];
  const next = mockScripted.shift();
  if (next instanceof Error) throw next;
  if (next) return next;
  return [[]];
}

const mockConn = {
  async beginTransaction() { mockCalls.push({ sql: 'BEGIN' }); },
  async commit() { mockCalls.push({ sql: 'COMMIT' }); },
  async rollback() { mockCalls.push({ sql: 'ROLLBACK' }); },
  release() { mockCalls.push({ sql: 'RELEASE' }); },
  execute: mockStatement,
  query: mockStatement,
};

const fakeDriver = {
  createPool() {
    return {
      execute: mockStatement,
      query: mockStatement,
      async getConnection() { return mockConn; },
      async end() {},
    };
  },
};

require.cache[MYSQL_PATH] = {
  id: MYSQL_PATH,
  filename: MYSQL_PATH,
  loaded: true,
  exports: fakeDriver,
};

process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'locoxatl_admin_test';
process.env.DB_NAME = process.env.DB_NAME || 'locoxatl_admin_test';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test-admin-password';

const ordersModule = require('../src/server/orders');
const authModule = require('../src/server/auth');

test('ORDER_STATUSES includes all required lifecycle statuses including completed', () => {
  assert.ok(ordersModule.ORDER_STATUSES.includes('waiting_for_payment'));
  assert.ok(ordersModule.ORDER_STATUSES.includes('payment_confirmation_sent'));
  assert.ok(ordersModule.ORDER_STATUSES.includes('paid'));
  assert.ok(ordersModule.ORDER_STATUSES.includes('in_production'));
  assert.ok(ordersModule.ORDER_STATUSES.includes('shipped'));
  assert.ok(ordersModule.ORDER_STATUSES.includes('completed'));
  assert.ok(ordersModule.ORDER_STATUSES.includes('cancelled'));
});

test('admin can list orders with pagination, status filters, and search query', async () => {
  resetMock([
    // COUNT
    [[{ total: 2 }]],
    // ORDERS
    [[
      {
        id: 1,
        order_number: 'LX-TEST-001',
        customer_name: 'Dewi Lestari',
        customer_email: 'dewi@example.com',
        customer_phone: '0811111111',
        customer_address: 'Bandung',
        customer_note: 'Ring bell',
        total_amount: 58000,
        order_status: 'payment_confirmation_sent',
        created_at: '2026-11-12 10:00:00',
        updated_at: '2026-11-12 10:00:00',
      },
    ]],
    // ITEMS & CONFIGURATIONS
    [[
      {
        id: 101,
        order_id: 1,
        product_name: 'Cloud Heart',
        quantity: 1,
        unit_price: 58000,
        subtotal: 58000,
        configuration_json: JSON.stringify({ configuration: { base: { id: 'heart' }, initial: 'D' } }),
      },
    ]],
  ]);

  const result = await ordersModule.listOrdersAdmin({ page: 1, limit: 10, status: 'payment_confirmation_sent', search: 'Dewi' });
  assert.equal(result.pagination.total, 2);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].orderNumber, 'LX-TEST-001');
  assert.equal(result.orders[0].customer.name, 'Dewi Lestari');
  assert.equal(result.orders[0].items[0].configuration.configuration.initial, 'D');

  const countQuery = mockCalls.find((c) => c.sql.includes('COUNT'));
  assert.ok(countQuery.sql.includes('o.order_status = ?'));
  assert.ok(countQuery.params.includes('payment_confirmation_sent'));
});

test('admin can retrieve full order details including 3D config, audit history, and admin notes', async () => {
  resetMock([
    // SELECT from orders
    [[{
      id: 2,
      order_number: 'LX-ADMIN-999',
      customer_name: 'Budi Santoso',
      customer_email: 'budi@example.com',
      customer_phone: '0822222222',
      customer_address: 'Jakarta Selatan',
      customer_note: 'Fragile',
      total_amount: 75000,
      order_status: 'paid',
      created_at: '2026-11-12 12:00:00',
      updated_at: '2026-11-12 12:00:00',
    }]],
    // SELECT extra admin fields
    [[{
      admin_notes: 'Payment verified via BCA transfer Rp 75.000',
      payment_verified_at: '2026-11-12 12:30:00',
      shipping_courier: 'JNE',
      tracking_number: 'JNE123456',
      shipped_at: null,
      completed_at: null,
    }]],
    // SELECT order_items
    [[{ id: 201, product_name: 'Star Keychain', quantity: 1, unit_price: 75000, subtotal: 75000 }]],
    // SELECT customizer_configurations
    [[{
      id: 301,
      order_item_id: 201,
      configuration_json: JSON.stringify({ configuration: { base: { id: 'star' }, clasp: { id: 'black' } } }),
      created_at: '2026-11-12 12:00:00',
    }]],
    // SELECT order_status_history
    [[{
      id: 1,
      previous_status: 'payment_confirmation_sent',
      new_status: 'paid',
      changed_by: 'admin',
      notes: 'BCA transfer confirmed',
      created_at: '2026-11-12 12:30:00',
    }]],
  ]);

  const detail = await ordersModule.getOrderDetailAdmin('LX-ADMIN-999');
  assert.equal(detail.orderNumber, 'LX-ADMIN-999');
  assert.equal(detail.status, 'paid');
  assert.equal(detail.adminNotes, 'Payment verified via BCA transfer Rp 75.000');
  assert.equal(detail.shippingCourier, 'JNE');
  assert.equal(detail.trackingNumber, 'JNE123456');
  assert.equal(detail.items[0].configuration.configuration.base.id, 'star');
  assert.equal(detail.history.length, 1);
  assert.equal(detail.history[0].newStatus, 'paid');
});

test('admin can transition status across full lifecycle and records audit log', async () => {
  resetMock([
    // Check order exists
    [[{ id: 5, order_status: 'paid' }]],
    // getOrderDetailAdmin after update
    [[{
      id: 5,
      order_number: 'LX-STATUS-TRANS',
      customer_name: 'Siti',
      customer_email: '',
      customer_phone: '0833333333',
      customer_address: 'Surabaya',
      customer_note: '',
      total_amount: 52000,
      order_status: 'in_production',
      created_at: '2026-11-12 14:00:00',
      updated_at: '2026-11-12 14:00:00',
    }]],
    [[{ admin_notes: '', payment_verified_at: null, shipping_courier: '', tracking_number: '', shipped_at: null, completed_at: null }]],
    [[{ id: 501, product_name: 'Keychain', quantity: 1, unit_price: 52000, subtotal: 52000 }]],
    [[{ id: 601, order_item_id: 501, configuration_json: '{}', created_at: '2026-11-12 14:00:00' }]],
    [[]], // history
  ]);

  const updated = await ordersModule.updateOrderStatusAdmin('LX-STATUS-TRANS', 'in_production', {
    changedBy: 'artisan_team',
    notes: 'Moved to batch 1 production',
  });

  assert.equal(updated.status, 'in_production');
  const updateCall = mockCalls.find((c) => c.sql.startsWith('UPDATE orders SET'));
  assert.ok(updateCall, 'must update orders table');

  const historyCall = mockCalls.find((c) => c.sql.includes('INSERT INTO order_status_history'));
  assert.ok(historyCall, 'must log to status history table');
  assert.ok(historyCall.params.includes('paid'));
  assert.ok(historyCall.params.includes('in_production'));
  assert.ok(historyCall.params.includes('artisan_team'));
});

test('admin metrics correctly calculates aggregates and revenue', async () => {
  resetMock([
    [[
      { order_status: 'waiting_for_payment', count: 3, revenue: 150000 },
      { order_status: 'payment_confirmation_sent', count: 2, revenue: 100000 },
      { order_status: 'paid', count: 5, revenue: 260000 },
      { order_status: 'in_production', count: 4, revenue: 220000 },
      { order_status: 'shipped', count: 2, revenue: 110000 },
      { order_status: 'completed', count: 10, revenue: 550000 },
      { order_status: 'cancelled', count: 1, revenue: 50000 },
    ]],
  ]);

  const metrics = await ordersModule.getAdminMetrics();
  assert.equal(metrics.totalOrders, 27);
  assert.equal(metrics.countsByStatus.waiting_for_payment, 3);
  assert.equal(metrics.countsByStatus.payment_confirmation_sent, 2);
  assert.equal(metrics.countsByStatus.paid, 5);
  assert.equal(metrics.countsByStatus.in_production, 4);
  assert.equal(metrics.countsByStatus.shipped, 2);
  assert.equal(metrics.countsByStatus.completed, 10);
  assert.equal(metrics.countsByStatus.cancelled, 1);
  // Revenue is sum of paid (260k) + in_prod (220k) + shipped (110k) + completed (550k) = 1.140.000
  assert.equal(metrics.totalRevenue, 1140000);
});

test('admin authentication and session creation with scrypt hash', async () => {
  const hash = await authModule.hashPassword('secret-123');
  resetMock([
    // SELECT admin_users
    [[{ id: 1, username: 'admin', password_hash: hash }]],
  ]);

  const session = await authModule.authenticateAdmin('admin', 'secret-123');
  assert.ok(session);
  assert.equal(session.user.username, 'admin');
  assert.match(session.token, /^[0-9a-f]{64}$/);

  // Wrong password returns null
  resetMock([
    [[{ id: 1, username: 'admin', password_hash: hash }]],
  ]);
  const invalidSession = await authModule.authenticateAdmin('admin', 'wrong-pass');
  assert.equal(invalidSession, null);
});
