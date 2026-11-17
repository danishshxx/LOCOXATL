const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const TEST_DATABASE = 'locoxatl_test';
const RAILWAY_TEST_DATABASE = 'railway_test';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const testHost = process.env.MYSQL_TEST_HOST;
const testUser = process.env.MYSQL_TEST_USER;
const testDatabaseConfigured = process.env.MYSQL_TEST_DATABASE === TEST_DATABASE
  && LOOPBACK_HOSTS.has(testHost)
  && Boolean(testUser);
const railwayTestHost = process.env.MYSQL_RAILWAY_TEST_HOST;
const railwayTestUser = process.env.MYSQL_RAILWAY_TEST_USER;
const railwayTestDatabaseConfigured = process.env.MYSQL_RAILWAY_TEST_DATABASE === RAILWAY_TEST_DATABASE
  && LOOPBACK_HOSTS.has(railwayTestHost)
  && Boolean(railwayTestUser);

test('MySQL cashbook integration runs only against locoxatl_test', {
  skip: testDatabaseConfigured
    ? false
    : 'Set MYSQL_TEST_DATABASE=locoxatl_test and loopback-only MYSQL_TEST_HOST and MYSQL_TEST_USER for a dedicated test database.',
}, async () => {
  process.env.DB_HOST = testHost;
  process.env.DB_PORT = process.env.MYSQL_TEST_PORT || '3306';
  process.env.DB_USER = testUser;
  process.env.DB_PASSWORD = process.env.MYSQL_TEST_PASSWORD || '';
  process.env.DB_NAME = TEST_DATABASE;

  const { getPool, closePool } = require('../src/server/db');
  const { runAdditiveMigrations, runBaseSchema } = require('../src/server/migrate');
  const cashbook = require('../src/server/cashbook');
  const orders = require('../src/server/orders');
  const { createReportWorkbook } = require('../src/server/reports');
  const ExcelJS = require('exceljs');
  const pool = getPool();
  const marker = `cashbook-it-${crypto.randomBytes(6).toString('hex')}`;
  const sentinelOrder = `LX-IT-${crypto.randomBytes(5).toString('hex')}`;
  const verifiedOrder = `LX-IT-${crypto.randomBytes(5).toString('hex')}`;
  const unpaidOrder = `LX-IT-${crypto.randomBytes(5).toString('hex')}`;
  const rollbackOrder = `LX-IT-${crypto.randomBytes(5).toString('hex')}`;
  const expenseDescription = `${marker} expense`;
  const currentDate = new Date();
  const transactionDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;

  async function insertOrder(orderNumber, status, total) {
    const [orderResult] = await pool.execute(
      `INSERT INTO orders
       (order_number, customer_name, customer_email, customer_phone, customer_address, total_amount, order_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [orderNumber, marker, `${marker}@example.test`, '0800000000', 'Integration test address', total, status],
    );
    const [itemResult] = await pool.execute(
      `INSERT INTO order_items (order_id, product_name, quantity, unit_price, subtotal)
       VALUES (?, ?, 1, ?, ?)`,
      [orderResult.insertId, 'Integration test charm', total, total],
    );
    await pool.execute(
      'INSERT INTO customizer_configurations (order_item_id, configuration_json) VALUES (?, ?)',
      [itemResult.insertId, JSON.stringify({ configuration: { base: { id: 'integration-test' } } })],
    );
    return Number(orderResult.insertId);
  }

  try {
    assert.equal(process.env.DB_NAME, TEST_DATABASE);
    await pool.query('SELECT 1');
    const baseSchema = await runBaseSchema();
    assert.equal(baseSchema.databaseName, TEST_DATABASE);

    const sentinelId = await insertOrder(sentinelOrder, 'waiting_for_payment', 41000);
    const [beforeMigration] = await pool.execute(
      `SELECT o.order_number, o.total_amount, c.configuration_json
       FROM orders o
       JOIN order_items i ON i.order_id = o.id
       JOIN customizer_configurations c ON c.order_item_id = i.id
       WHERE o.id = ?`,
      [sentinelId],
    );
    assert.equal(beforeMigration.length, 1);

    const migration = await runAdditiveMigrations();
    assert.equal(migration.success, true);
    const [afterMigration] = await pool.execute(
      `SELECT o.order_number, o.total_amount, c.configuration_json
       FROM orders o
       JOIN order_items i ON i.order_id = o.id
       JOIN customizer_configurations c ON c.order_item_id = i.id
       WHERE o.id = ?`,
      [sentinelId],
    );
    assert.deepEqual(afterMigration, beforeMigration, 'migration must preserve existing order and customizer data');
    const repeatedMigration = await runAdditiveMigrations();
    assert.equal(repeatedMigration.databaseName, TEST_DATABASE);
    assert.deepEqual(repeatedMigration.addedColumns, [], 're-running migrations must remain idempotent');

    const verifiedId = await insertOrder(verifiedOrder, 'payment_confirmation_sent', 125000);
    const unpaidId = await insertOrder(unpaidOrder, 'waiting_for_payment', 55000);
    const rollbackId = await insertOrder(rollbackOrder, 'payment_confirmation_sent', 87000);

    await pool.execute(
      `UPDATE cashbook_categories SET is_active = 0
       WHERE name = 'Verified Order Income' AND entry_type = 'income'`,
    );
    await assert.rejects(() => orders.updateOrderStatusAdmin(rollbackOrder, 'paid'));
    const [rolledBackOrder] = await pool.execute('SELECT order_status FROM orders WHERE id = ?', [rollbackId]);
    const [rolledBackIncome] = await pool.execute(
      `SELECT id FROM cashbook_entries WHERE order_id = ? AND entry_type = 'income'`,
      [rollbackId],
    );
    assert.equal(rolledBackOrder[0].order_status, 'payment_confirmation_sent');
    assert.equal(rolledBackIncome.length, 0, 'cashbook failure must roll back the payment status update');
    await pool.execute(
      `UPDATE cashbook_categories SET is_active = 1
       WHERE name = 'Verified Order Income' AND entry_type = 'income'`,
    );

    await orders.updateOrderStatusAdmin(verifiedOrder, 'paid');
    let [incomeRows] = await pool.execute(
      `SELECT id, amount, source_key FROM cashbook_entries
       WHERE order_id = ? AND entry_type = 'income'`,
      [verifiedId],
    );
    assert.equal(incomeRows.length, 1);
    assert.equal(Number(incomeRows[0].amount), 125000);
    assert.equal(incomeRows[0].source_key, `order-paid:${verifiedId}`);

    await pool.execute('UPDATE orders SET order_status = ? WHERE id = ?', ['payment_confirmation_sent', verifiedId]);
    await orders.updateOrderStatusAdmin(verifiedOrder, 'paid');
    [incomeRows] = await pool.execute(
      `SELECT id FROM cashbook_entries WHERE order_id = ? AND entry_type = 'income'`,
      [verifiedId],
    );
    assert.equal(incomeRows.length, 1, 'replayed payment verification must not duplicate income');

    await orders.updateOrderStatusAdmin(unpaidOrder, 'payment_confirmation_sent');
    const [unpaidIncome] = await pool.execute(
      `SELECT id FROM cashbook_entries WHERE order_id = ? AND entry_type = 'income'`,
      [unpaidId],
    );
    assert.equal(unpaidIncome.length, 0, 'payment confirmation alone must not count as income');

    const [categoryRows] = await pool.execute(
      `SELECT id FROM cashbook_categories
       WHERE name = 'Material' AND entry_type = 'expense' AND is_active = 1`,
    );
    const expense = await cashbook.createExpense({
      categoryId: Number(categoryRows[0].id),
      transactionDate,
      amount: '22000',
      description: expenseDescription,
      paymentMethod: 'Cash',
      notes: marker,
    }, null);
    assert.equal(expense.amount, 22000);

    const summary = await cashbook.getCashbookSummary({ period: 'custom', from: transactionDate, to: transactionDate });
    assert.ok(summary.totals.income >= 125000);
    assert.ok(summary.totals.expenses >= 22000);
    assert.equal(summary.totals.balance, summary.totals.income - summary.totals.expenses);

    const workbookBuffer = await createReportWorkbook({ period: 'today', scope: 'cashbook' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(workbookBuffer);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Summary', 'Orders', 'Income', 'Expenses', 'Cashbook']);
    assert.ok(workbook.getWorksheet('Cashbook').rowCount >= 4);
  } finally {
    await pool.execute('UPDATE cashbook_categories SET is_active = 1 WHERE name = ? AND entry_type = ?', ['Verified Order Income', 'income'])
      .catch(() => {});
    await pool.execute('DELETE FROM cashbook_entries WHERE order_id IN (SELECT id FROM orders WHERE order_number IN (?, ?, ?, ?))', [sentinelOrder, verifiedOrder, unpaidOrder, rollbackOrder])
      .catch(() => {});
    await pool.execute('DELETE FROM cashbook_entries WHERE description = ?', [expenseDescription])
      .catch(() => {});
    await pool.execute('DELETE FROM orders WHERE order_number IN (?, ?, ?, ?)', [sentinelOrder, verifiedOrder, unpaidOrder, rollbackOrder])
      .catch(() => {});
    await closePool();
  }
});

test('Railway-compatible schema migration targets only the disposable railway_test schema', {
  skip: railwayTestDatabaseConfigured
    ? false
    : 'Set MYSQL_RAILWAY_TEST_DATABASE=railway_test and loopback-only MYSQL_RAILWAY_TEST_HOST and MYSQL_RAILWAY_TEST_USER.',
}, async () => {
  process.env.DB_HOST = railwayTestHost;
  process.env.DB_PORT = process.env.MYSQL_RAILWAY_TEST_PORT || '3306';
  process.env.DB_USER = railwayTestUser;
  process.env.DB_PASSWORD = process.env.MYSQL_RAILWAY_TEST_PASSWORD || '';
  process.env.DB_NAME = RAILWAY_TEST_DATABASE;

  const { getPool, closePool } = require('../src/server/db');
  const { runAdditiveMigrations } = require('../src/server/migrate');
  const pool = getPool();

  try {
    const [activeDatabase] = await pool.query('SELECT DATABASE() AS databaseName');
    assert.equal(activeDatabase[0].databaseName, RAILWAY_TEST_DATABASE);

    const firstMigration = await runAdditiveMigrations();
    assert.equal(firstMigration.success, true);
    assert.equal(firstMigration.databaseName, RAILWAY_TEST_DATABASE);

    const repeatedMigration = await runAdditiveMigrations();
    assert.equal(repeatedMigration.success, true);
    assert.equal(repeatedMigration.databaseName, RAILWAY_TEST_DATABASE);
    assert.deepEqual(repeatedMigration.addedColumns, []);
  } finally {
    await closePool();
  }
});
