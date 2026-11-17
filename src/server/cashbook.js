const { getPool, withTransaction } = require('./db');

const SYSTEM_INCOME_CATEGORY = 'Verified Order Income';
// Cancelling a verified order writes a refund against this category so the cashbook keeps an
// append-only trail and the balance drops back to zero for that order.
const SYSTEM_REFUND_CATEGORY = 'Order Refunds';
const SYSTEM_EXPENSE_CATEGORIES = new Set([SYSTEM_REFUND_CATEGORY]);
const DEFAULT_EXPENSE_CATEGORIES = [
  'Material',
  'Production',
  'Packaging',
  'Shipping',
  'Marketing',
  'Operational',
  'Other',
  SYSTEM_REFUND_CATEGORY,
];

const EFFECTIVE_ENTRY_SQL = `NOT EXISTS (
  SELECT 1 FROM cashbook_entries replacement
  WHERE replacement.supersedes_entry_id = e.id
)`;

function requestError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function parseIsoDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw requestError('invalid_date', `${field} must be a date in YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw requestError('invalid_date', `${field} is not a valid calendar date.`);
  }
  return value;
}

function currentIsoDate() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function resolveDateRange({ period, from, to } = {}) {
  const requestedPeriod = String(period || (from || to ? 'custom' : 'month')).toLowerCase();
  const today = currentIsoDate();
  let start;
  let end = today;

  if (requestedPeriod === 'today') {
    start = today;
  } else if (requestedPeriod === 'week') {
    const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    start = shiftDate(today, -((weekday + 6) % 7));
  } else if (requestedPeriod === 'month') {
    start = `${today.slice(0, 7)}-01`;
  } else if (requestedPeriod === 'year') {
    start = `${today.slice(0, 4)}-01-01`;
  } else if (requestedPeriod === 'custom') {
    if (!from || !to) {
      throw requestError('invalid_date_range', 'Custom date ranges require both from and to dates.');
    }
    start = parseIsoDate(String(from), 'from');
    end = parseIsoDate(String(to), 'to');
    if (start > end) {
      throw requestError('invalid_date_range', 'from must not be later than to.');
    }
  } else {
    throw requestError('invalid_period', 'period must be today, week, month, year, or custom.');
  }

  return { period: requestedPeriod, from: start, to: end };
}

function parsePositiveId(value, field = 'id') {
  const id = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw requestError('invalid_id', `${field} must be a positive integer.`);
  }
  return id;
}

function parseAmount(value) {
  const amountString = typeof value === 'number' ? String(value) : String(value || '').trim();
  if (!/^[1-9]\d{0,15}$/.test(amountString)) {
    throw requestError('invalid_amount', 'amount must be a positive whole number of IDR.');
  }
  const amount = Number(amountString);
  if (!Number.isSafeInteger(amount)) {
    throw requestError('invalid_amount', 'amount exceeds the supported IDR range.');
  }
  return amount;
}

function parseText(value, field, { required = false, maxLength = 255 } = {}) {
  const text = String(value == null ? '' : value).trim();
  if (required && !text) throw requestError('invalid_input', `${field} is required.`);
  if (text.length > maxLength) throw requestError('invalid_input', `${field} must be ${maxLength} characters or fewer.`);
  return text;
}

function parseExpenseInput(input, existing = null) {
  const values = { ...(existing || {}), ...(input || {}) };
  const categoryId = parsePositiveId(values.categoryId ?? values.category_id, 'categoryId');
  const transactionDate = parseIsoDate(String(values.transactionDate ?? values.transaction_date ?? ''), 'transactionDate');
  if (transactionDate > currentIsoDate()) {
    throw requestError('invalid_date', 'transactionDate cannot be in the future.');
  }
  const amount = parseAmount(values.amount);
  const description = parseText(values.description, 'description', { required: true, maxLength: 255 });
  const paymentMethod = parseText(values.paymentMethod ?? values.payment_method, 'paymentMethod', { required: true, maxLength: 80 });
  const notes = parseText(values.notes, 'notes', { maxLength: 2000 });
  return { categoryId, transactionDate, amount, description, paymentMethod, notes };
}

function parseListFilters(filters = {}) {
  const dateRange = resolveDateRange(filters);
  const pageText = String(filters.page == null ? '1' : filters.page);
  const limitText = String(filters.limit == null ? '20' : filters.limit);
  if (!/^\d+$/.test(pageText) || !/^\d+$/.test(limitText)) {
    throw requestError('invalid_pagination', 'page and limit must be positive integers.');
  }
  const page = Number(pageText);
  const limit = Number(limitText);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw requestError('invalid_pagination', 'page must be positive and limit must be between 1 and 100.');
  }
  const entryType = filters.type ? String(filters.type).toLowerCase() : '';
  if (entryType && !['income', 'expense'].includes(entryType)) {
    throw requestError('invalid_type', 'type must be income or expense.');
  }
  return {
    ...dateRange,
    page,
    limit,
    offset: (page - 1) * limit,
    entryType,
    search: parseText(filters.search || '', 'search', { maxLength: 100 }),
  };
}

function effectiveWhere(filters, includeDateRange = true) {
  const clauses = [EFFECTIVE_ENTRY_SQL];
  const params = [];
  if (includeDateRange) {
    clauses.push('e.transaction_date >= ? AND e.transaction_date <= ?');
    params.push(filters.from, filters.to);
  }
  if (filters.entryType) {
    clauses.push('e.entry_type = ?');
    params.push(filters.entryType);
  }
  if (filters.search) {
    clauses.push('(e.description LIKE ? OR c.name LIKE ? OR e.payment_method LIKE ? OR o.order_number LIKE ?)');
    const query = `%${filters.search}%`;
    params.push(query, query, query, query);
  }
  return { where: clauses.join(' AND '), params };
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

function mapEntry(row) {
  return {
    id: Number(row.id),
    entryType: row.entry_type,
    amount: Number(row.amount),
    categoryId: Number(row.category_id),
    category: row.category_name,
    description: row.description,
    paymentMethod: row.payment_method || '',
    notes: row.notes || '',
    transactionDate: dateOnly(row.transaction_date),
    orderId: row.order_id == null ? null : Number(row.order_id),
    orderNumber: row.order_number || '',
    adminUsername: row.admin_username || '',
    supersedesEntryId: row.supersedes_entry_id == null ? null : Number(row.supersedes_entry_id),
    correctionNote: row.correction_note || '',
    createdAt: row.created_at,
  };
}

async function getCategories({ includeInactive = false } = {}) {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT id, name, entry_type, is_active, created_at
     FROM cashbook_categories
     ${includeInactive ? '' : 'WHERE is_active = 1'}
     ORDER BY entry_type ASC, name ASC`,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    entryType: row.entry_type,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  }));
}

async function createCategory(name) {
  const categoryName = parseText(name, 'name', { required: true, maxLength: 100 });
  const pool = getPool();
  try {
    const [result] = await pool.execute(
      'INSERT INTO cashbook_categories (name, entry_type) VALUES (?, ?)',
      [categoryName, 'expense'],
    );
    return { id: Number(result.insertId), name: categoryName, entryType: 'expense', isActive: true };
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      throw requestError('category_exists', 'An expense category with that name already exists.', 409);
    }
    throw error;
  }
}

async function setCategoryActive(id, isActive) {
  const categoryId = parsePositiveId(id, 'categoryId');
  if (typeof isActive !== 'boolean') {
    throw requestError('invalid_input', 'isActive must be a boolean.');
  }
  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT id, name, entry_type FROM cashbook_categories WHERE id = ? LIMIT 1',
    [categoryId],
  );
  if (!rows.length) throw requestError('category_not_found', 'Category was not found.', 404);
  if (rows[0].entry_type === 'income') {
    throw requestError('system_category', 'The verified order income category cannot be disabled.');
  }
  if (SYSTEM_EXPENSE_CATEGORIES.has(rows[0].name)) {
    throw requestError('system_category', 'This system category cannot be disabled.');
  }
  await pool.execute('UPDATE cashbook_categories SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, categoryId]);
  return { id: categoryId, name: rows[0].name, entryType: rows[0].entry_type, isActive };
}

async function validateExpenseCategory(connection, categoryId) {
  const [rows] = await connection.execute(
    `SELECT id FROM cashbook_categories
     WHERE id = ? AND entry_type = 'expense' AND is_active = 1
     LIMIT 1 FOR UPDATE`,
    [categoryId],
  );
  if (!rows.length) throw requestError('invalid_category', 'Choose an active expense category.');
}

async function insertExpense(connection, input, adminUserId, supersedesEntryId = null, correctionNote = null) {
  await validateExpenseCategory(connection, input.categoryId);
  const [result] = await connection.execute(
    `INSERT INTO cashbook_entries
    (entry_type, amount, category_id, description, payment_method, notes, transaction_date,
     admin_user_id, supersedes_entry_id, correction_note)
     VALUES ('expense', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.amount,
      input.categoryId,
      input.description,
      input.paymentMethod,
      input.notes,
      input.transactionDate,
      adminUserId || null,
      supersedesEntryId,
      correctionNote,
    ],
  );
  return Number(result.insertId);
}

async function getEntryById(id) {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT e.id, e.entry_type, e.amount, e.category_id, c.name AS category_name,
            e.description, e.payment_method, e.notes, e.transaction_date, e.order_id, o.order_number,
            u.username AS admin_username, e.supersedes_entry_id, e.correction_note, e.created_at
     FROM cashbook_entries e
     JOIN cashbook_categories c ON c.id = e.category_id
     LEFT JOIN orders o ON o.id = e.order_id
     LEFT JOIN admin_users u ON u.id = e.admin_user_id
     WHERE e.id = ? LIMIT 1`,
    [id],
  );
  return rows.length ? mapEntry(rows[0]) : null;
}

async function createExpense(input, adminUserId) {
  const values = parseExpenseInput(input);
  const savedId = await withTransaction(async (connection) => insertExpense(connection, values, adminUserId));
  return getEntryById(savedId);
}

async function correctExpense(id, input, adminUserId) {
  const entryId = parsePositiveId(id, 'entryId');
  const correctionNote = parseText(input && input.correctionNote, 'correctionNote', { required: true, maxLength: 500 });
  const savedId = await withTransaction(async (connection) => {
    const [rows] = await connection.execute(
      `SELECT id, entry_type, amount, category_id, description, payment_method, notes, transaction_date
       FROM cashbook_entries WHERE id = ? LIMIT 1 FOR UPDATE`,
      [entryId],
    );
    if (!rows.length) throw requestError('entry_not_found', 'Cashbook entry was not found.', 404);
    if (rows[0].entry_type !== 'expense') {
      throw requestError('not_editable', 'Only manual expense entries can be corrected.', 409);
    }
    const [replacements] = await connection.execute(
      'SELECT id FROM cashbook_entries WHERE supersedes_entry_id = ? LIMIT 1',
      [entryId],
    );
    if (replacements.length) {
      throw requestError('entry_superseded', 'This expense already has a correction. Edit its latest version.', 409);
    }
    const inputValues = parseExpenseInput(input, {
      categoryId: rows[0].category_id,
      amount: rows[0].amount,
      description: rows[0].description,
      paymentMethod: rows[0].payment_method,
      notes: rows[0].notes,
      transactionDate: dateOnly(rows[0].transaction_date),
    });
    return insertExpense(connection, inputValues, adminUserId, entryId, correctionNote);
  });
  return getEntryById(savedId);
}

async function getEntryHistory(id) {
  const entryId = parsePositiveId(id, 'entryId');
  const pool = getPool();
  const [rows] = await pool.execute(
    `WITH RECURSIVE entry_history AS (
       SELECT id, entry_type, amount, category_id, description, payment_method, notes, transaction_date,
              supersedes_entry_id, correction_note, created_at
       FROM cashbook_entries WHERE id = ?
       UNION ALL
       SELECT parent.id, parent.entry_type, parent.amount, parent.category_id, parent.description,
              parent.payment_method, parent.notes, parent.transaction_date, parent.supersedes_entry_id,
              parent.correction_note, parent.created_at
       FROM cashbook_entries parent
       JOIN entry_history child ON child.supersedes_entry_id = parent.id
     )
     SELECT h.id, h.entry_type, h.amount, h.category_id, c.name AS category_name,
            h.description, h.payment_method, h.notes, h.transaction_date, NULL AS order_id,
            NULL AS order_number, NULL AS admin_username, h.supersedes_entry_id,
            h.correction_note, h.created_at
     FROM entry_history h
     JOIN cashbook_categories c ON c.id = h.category_id
     ORDER BY h.id ASC`,
    [entryId],
  );
  if (!rows.length) throw requestError('entry_not_found', 'Cashbook entry was not found.', 404);
  return rows.map(mapEntry);
}

async function listCashbookEntries(filters = {}) {
  const parsed = parseListFilters(filters);
  const { where, params } = effectiveWhere(parsed);
  const pool = getPool();
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total
     FROM cashbook_entries e
     JOIN cashbook_categories c ON c.id = e.category_id
     LEFT JOIN orders o ON o.id = e.order_id
     WHERE ${where}`,
    params,
  );
  const total = Number(countRows[0] && countRows[0].total || 0);
  const [rows] = await pool.execute(
    `SELECT e.id, e.entry_type, e.amount, e.category_id, c.name AS category_name,
            e.description, e.payment_method, e.notes, e.transaction_date, e.order_id, o.order_number,
            u.username AS admin_username, e.supersedes_entry_id, e.correction_note, e.created_at
     FROM cashbook_entries e
     JOIN cashbook_categories c ON c.id = e.category_id
     LEFT JOIN orders o ON o.id = e.order_id
     LEFT JOIN admin_users u ON u.id = e.admin_user_id
     WHERE ${where}
     ORDER BY e.transaction_date DESC, e.id DESC
     LIMIT ? OFFSET ?`,
    [...params, parsed.limit, parsed.offset],
  );
  return {
    entries: rows.map(mapEntry),
    pagination: { total, page: parsed.page, limit: parsed.limit, totalPages: Math.ceil(total / parsed.limit) || 1 },
    dateRange: { from: parsed.from, to: parsed.to, period: parsed.period },
  };
}

function numberValue(value) {
  return Number(value) || 0;
}

function totalsFromRow(row = {}) {
  const income = numberValue(row.income);
  const expenses = numberValue(row.expenses);
  return { income, expenses, balance: income - expenses };
}

async function getCashbookSummary(filters = {}) {
  const dateRange = resolveDateRange(filters);
  const pool = getPool();
  const [allTimeRows] = await pool.execute(
    `SELECT
       COALESCE(SUM(CASE WHEN e.entry_type = 'income' THEN e.amount ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN e.entry_type = 'expense' THEN e.amount ELSE 0 END), 0) AS expenses
     FROM cashbook_entries e
     WHERE ${EFFECTIVE_ENTRY_SQL}`,
  );
  const [rangeRows] = await pool.execute(
    `SELECT
       COALESCE(SUM(CASE WHEN e.entry_type = 'income' THEN e.amount ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN e.entry_type = 'expense' THEN e.amount ELSE 0 END), 0) AS expenses
     FROM cashbook_entries e
     WHERE ${EFFECTIVE_ENTRY_SQL} AND e.transaction_date >= ? AND e.transaction_date <= ?`,
    [dateRange.from, dateRange.to],
  );
  const [periodRows] = await pool.execute(
    `SELECT
       COALESCE(SUM(CASE WHEN e.entry_type = 'income' AND e.transaction_date = CURDATE() THEN e.amount ELSE 0 END), 0) AS daily_income,
       COALESCE(SUM(CASE WHEN e.entry_type = 'expense' AND e.transaction_date = CURDATE() THEN e.amount ELSE 0 END), 0) AS daily_expenses,
       COALESCE(SUM(CASE WHEN e.entry_type = 'income' AND e.transaction_date >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY) THEN e.amount ELSE 0 END), 0) AS weekly_income,
       COALESCE(SUM(CASE WHEN e.entry_type = 'expense' AND e.transaction_date >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY) THEN e.amount ELSE 0 END), 0) AS weekly_expenses,
       COALESCE(SUM(CASE WHEN e.entry_type = 'income' AND YEAR(e.transaction_date) = YEAR(CURDATE()) AND MONTH(e.transaction_date) = MONTH(CURDATE()) THEN e.amount ELSE 0 END), 0) AS monthly_income,
       COALESCE(SUM(CASE WHEN e.entry_type = 'expense' AND YEAR(e.transaction_date) = YEAR(CURDATE()) AND MONTH(e.transaction_date) = MONTH(CURDATE()) THEN e.amount ELSE 0 END), 0) AS monthly_expenses,
       COALESCE(SUM(CASE WHEN e.entry_type = 'income' AND YEAR(e.transaction_date) = YEAR(CURDATE()) THEN e.amount ELSE 0 END), 0) AS yearly_income,
       COALESCE(SUM(CASE WHEN e.entry_type = 'expense' AND YEAR(e.transaction_date) = YEAR(CURDATE()) THEN e.amount ELSE 0 END), 0) AS yearly_expenses
     FROM cashbook_entries e
     WHERE ${EFFECTIVE_ENTRY_SQL}`,
  );
  const [chartRows] = await pool.execute(
    `SELECT DATE_FORMAT(e.transaction_date, '%Y-%m-%d') AS transaction_date,
            e.entry_type, SUM(e.amount) AS amount
     FROM cashbook_entries e
     WHERE ${EFFECTIVE_ENTRY_SQL} AND e.transaction_date >= ? AND e.transaction_date <= ?
     GROUP BY e.transaction_date, e.entry_type
     ORDER BY e.transaction_date ASC`,
    [dateRange.from, dateRange.to],
  );
  const periods = periodRows[0] || {};
  return {
    totals: totalsFromRow(allTimeRows[0]),
    range: {
      ...dateRange,
      ...totalsFromRow(rangeRows[0]),
    },
    periods: {
      daily: totalsFromRow({ income: periods.daily_income, expenses: periods.daily_expenses }),
      weekly: totalsFromRow({ income: periods.weekly_income, expenses: periods.weekly_expenses }),
      monthly: totalsFromRow({ income: periods.monthly_income, expenses: periods.monthly_expenses }),
      yearly: totalsFromRow({ income: periods.yearly_income, expenses: periods.yearly_expenses }),
    },
    chart: chartRows.map((row) => ({
      date: dateOnly(row.transaction_date),
      entryType: row.entry_type,
      amount: numberValue(row.amount),
    })),
  };
}

async function getReportData(filters = {}) {
  const dateRange = resolveDateRange(filters);
  const pool = getPool();
  const [orderRows] = await pool.execute(
    `SELECT id, order_number, customer_name, customer_email, customer_phone, total_amount,
            order_status, created_at, payment_verified_at
     FROM orders
     WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
     ORDER BY created_at ASC, id ASC`,
    [dateRange.from, dateRange.to],
  );
  const [entryRows] = await pool.execute(
    `SELECT e.id, e.entry_type, e.amount, e.category_id, c.name AS category_name,
            e.description, e.payment_method, e.notes, e.transaction_date, e.order_id, o.order_number,
            u.username AS admin_username, e.supersedes_entry_id, e.correction_note, e.created_at
     FROM cashbook_entries e
     JOIN cashbook_categories c ON c.id = e.category_id
     LEFT JOIN orders o ON o.id = e.order_id
     LEFT JOIN admin_users u ON u.id = e.admin_user_id
     WHERE ${EFFECTIVE_ENTRY_SQL} AND e.transaction_date >= ? AND e.transaction_date <= ?
     ORDER BY e.transaction_date ASC, e.id ASC`,
    [dateRange.from, dateRange.to],
  );
  const entries = entryRows.map(mapEntry);
  const income = entries.filter((entry) => entry.entryType === 'income').reduce((sum, entry) => sum + entry.amount, 0);
  const expenses = entries.filter((entry) => entry.entryType === 'expense').reduce((sum, entry) => sum + entry.amount, 0);
  return {
    dateRange,
    orders: orderRows.map((row) => ({
      id: Number(row.id),
      orderNumber: row.order_number,
      customerName: row.customer_name,
      email: row.customer_email || '',
      phone: row.customer_phone || '',
      total: numberValue(row.total_amount),
      status: row.order_status,
      createdAt: row.created_at,
      paymentVerifiedAt: row.payment_verified_at,
    })),
    entries,
    totals: { income, expenses, balance: income - expenses },
  };
}

module.exports = {
  SYSTEM_INCOME_CATEGORY,
  SYSTEM_REFUND_CATEGORY,
  DEFAULT_EXPENSE_CATEGORIES,
  resolveDateRange,
  parseAmount,
  getCategories,
  createCategory,
  setCategoryActive,
  createExpense,
  correctExpense,
  getEntryHistory,
  listCashbookEntries,
  getCashbookSummary,
  getReportData,
};
