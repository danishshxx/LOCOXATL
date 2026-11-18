const crypto = require('node:crypto');
const { withTransaction, getPool } = require('./db');
const { validateOrderPayload, ValidationError } = require('./validation');
const serverCatalog = require('./catalog');
const { SYSTEM_INCOME_CATEGORY, SYSTEM_REFUND_CATEGORY } = require('./cashbook');

const ORDER_STATUSES = ['waiting_for_payment', 'payment_confirmation_sent', 'paid', 'in_production', 'shipped', 'completed', 'cancelled'];

// Dashboard shortcuts: "unpaid" groups every order that still needs money before production.
const STATUS_GROUPS = {
  unpaid: ['waiting_for_payment', 'payment_confirmation_sent'],
};

// Customers may only move their own order from "waiting for payment" to
// "confirmation sent". Everything after that is an admin responsibility.
const CUSTOMER_TRANSITIONS = {
  waiting_for_payment: ['payment_confirmation_sent'],
  payment_confirmation_sent: ['payment_confirmation_sent'],
};

class OrderNotFoundError extends Error {
  constructor(orderNumber) {
    super(`Order ${orderNumber} was not found.`);
    this.code = 'ORDER_NOT_FOUND';
    this.statusCode = 404;
  }
}

class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`Cannot change status from ${from} to ${to}.`);
    this.code = 'INVALID_TRANSITION';
    this.statusCode = 409;
  }
}

function generateOrderNumber() {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `LX-${stamp}-${random}`;
}

function isDuplicateKeyError(error) {
  return error && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062);
}

async function createOrder(payload) {
  // The live catalogue decides which designs exist, which collection they belong to, and what
  // they cost. When MySQL is unavailable loadCatalog() returns the bundled fallback, so the
  // storefront keeps working and the static prices apply.
  const liveCatalog = await serverCatalog.loadCatalog({ activeOnly: true });
  const order = validateOrderPayload(payload, { catalog: liveCatalog });
  let lastError = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const orderNumber = generateOrderNumber();
    try {
      const created = await withTransaction(async (connection) => {
        const [orderResult] = await connection.execute(
          `INSERT INTO orders
            (order_number, customer_name, customer_email, customer_phone, customer_address, customer_note, fulfillment_method, payment_method, total_amount, order_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderNumber,
            order.customer.name,
            order.customer.email || null,
            order.customer.phone,
            order.customer.address,
            order.customer.note || null,
            order.fulfillmentMethod,
            order.paymentMethod,
            order.quote.total,
            'waiting_for_payment',
          ],
        );
        const orderId = orderResult.insertId;

        const [itemResult] = await connection.execute(
          `INSERT INTO order_items (order_id, product_name, quantity, unit_price, subtotal)
           VALUES (?, ?, ?, ?, ?)`,
          [orderId, order.productName, order.quantity, order.quote.unitPrice, order.quote.subtotal],
        );
        const orderItemId = itemResult.insertId;

        await connection.execute(
          `INSERT INTO customizer_configurations (order_item_id, configuration_json)
           VALUES (?, ?)`,
          [orderItemId, order.configurationJson],
        );

        return { orderId, orderItemId };
      });

      return {
        orderNumber,
        orderId: created.orderId,
        orderItemId: created.orderItemId,
        status: 'waiting_for_payment',
        total: order.quote.total,
        unitPrice: order.quote.unitPrice,
        subtotal: order.quote.subtotal,
        quantity: order.quantity,
        priceAdjusted: order.priceAdjusted,
        submittedTotal: order.submittedTotal,
        customer: order.customer,
        product: order.product ? { slug: order.product.slug, name: order.product.name } : null,
        member: order.member || null,
        artist: order.artist,
        fulfillmentMethod: order.fulfillmentMethod,
        paymentMethod: order.paymentMethod,
        configuration: order.configuration,
      };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      lastError = error;
    }
  }

  throw lastError || new Error('Unable to allocate a unique order number.');
}

async function getOrderByNumber(orderNumber) {
  const number = String(orderNumber || '').trim();
  if (!number || number.length > 32) throw new OrderNotFoundError(orderNumber);

  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT id, order_number, total_amount, order_status, created_at, updated_at
     FROM orders WHERE order_number = ? LIMIT 1`,
    [number],
  );
  if (!rows.length) throw new OrderNotFoundError(number);
  const order = rows[0];

  const [items] = await pool.execute(
    `SELECT id, product_name, quantity, unit_price, subtotal
     FROM order_items WHERE order_id = ? ORDER BY id ASC`,
    [order.id],
  );

  return {
    orderNumber: order.order_number,
    status: order.order_status,
    total: Number(order.total_amount),
    items: items.map((item) => ({
      productName: item.product_name,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
      subtotal: Number(item.subtotal),
    })),
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

async function updateOrderStatus(orderNumber, nextStatus) {
  const number = String(orderNumber || '').trim();
  const status = String(nextStatus || '').trim();
  if (!ORDER_STATUSES.includes(status)) {
    const error = new Error(`Unknown order status: ${status}`);
    error.code = 'INVALID_STATUS';
    error.statusCode = 400;
    throw error;
  }

  const pool = getPool();
  const [rows] = await pool.execute('SELECT id, order_status FROM orders WHERE order_number = ? LIMIT 1', [number]);
  if (!rows.length) throw new OrderNotFoundError(number);

  const current = rows[0].order_status;
  const allowed = CUSTOMER_TRANSITIONS[current] || [];
  if (!allowed.includes(status)) throw new InvalidTransitionError(current, status);

  await pool.execute('UPDATE orders SET order_status = ? WHERE id = ?', [status, rows[0].id]);
  return { orderNumber: number, status: current === status ? current : status };
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

async function listOrdersAdmin({ page = 1, limit = 20, status = '', search = '' } = {}) {
  const pool = getPool();
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;

  const conditions = [];
  const params = [];

  const trimmedStatus = String(status || '').trim();
  const groupedStatuses = STATUS_GROUPS[trimmedStatus];
  if (groupedStatuses) {
    conditions.push(`o.order_status IN (${groupedStatuses.map(() => '?').join(', ')})`);
    params.push(...groupedStatuses);
  } else if (trimmedStatus && ORDER_STATUSES.includes(trimmedStatus)) {
    conditions.push('o.order_status = ?');
    params.push(trimmedStatus);
  }

  const trimmedSearch = String(search || '').trim();
  if (trimmedSearch) {
    conditions.push('(o.order_number LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ? OR o.customer_email LIKE ?)');
    const wildcard = `%${trimmedSearch}%`;
    params.push(wildcard, wildcard, wildcard, wildcard);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countRows] = await pool.execute(
    `SELECT COUNT(DISTINCT o.id) AS total FROM orders o ${whereClause}`,
    params,
  );
  const total = Number(countRows[0]?.total || 0);
  const totalPages = Math.ceil(total / safeLimit) || 1;

  const [rows] = await pool.execute(
    `SELECT o.id, o.order_number, o.customer_name, o.customer_email, o.customer_phone,
            o.customer_address, o.customer_note, o.fulfillment_method, o.payment_method,
            o.total_amount, o.order_status, o.created_at, o.updated_at
     FROM orders o
     ${whereClause}
     ORDER BY o.id DESC
     LIMIT ${safeLimit} OFFSET ${offset}`,
    params,
  );

  if (!rows.length) {
    return {
      orders: [],
      pagination: { total: 0, page: safePage, limit: safeLimit, totalPages: 1 },
    };
  }

  const orderIds = rows.map((r) => r.id);
  const [itemRows] = await pool.execute(
    `SELECT oi.id, oi.order_id, oi.product_name, oi.quantity, oi.unit_price, oi.subtotal,
            cc.configuration_json
     FROM order_items oi
     LEFT JOIN customizer_configurations cc ON cc.order_item_id = oi.id
     WHERE oi.order_id IN (${orderIds.map(() => '?').join(', ')})
     ORDER BY oi.id ASC`,
    orderIds,
  );

  const itemsByOrder = new Map();
  itemRows.forEach((item) => {
    if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
    let config = null;
    if (item.configuration_json) {
      config = typeof item.configuration_json === 'string'
        ? safeParse(item.configuration_json)
        : item.configuration_json;
    }
    itemsByOrder.get(item.order_id).push({
      id: item.id,
      productName: item.product_name,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
      subtotal: Number(item.subtotal),
      configuration: config,
    });
  });

  const orders = rows.map((r) => ({
    id: r.id,
    orderNumber: r.order_number,
    status: r.order_status,
    total: Number(r.total_amount),
    fulfillmentMethod: r.fulfillment_method || 'campus_delivery',
    paymentMethod: r.payment_method || null,
    customer: {
      name: r.customer_name,
      email: r.customer_email || '',
      phone: r.customer_phone,
      address: r.customer_address,
      note: r.customer_note || '',
    },
    items: itemsByOrder.get(r.id) || [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return {
    orders,
    pagination: {
      total,
      page: safePage,
      limit: safeLimit,
      totalPages,
    },
  };
}

async function getOrderDetailAdmin(orderNumber) {
  const number = String(orderNumber || '').trim();
  if (!number || number.length > 32) throw new OrderNotFoundError(orderNumber);

  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT id, order_number, customer_name, customer_email, customer_phone, customer_address,
            customer_note, total_amount, order_status, created_at, updated_at
     FROM orders WHERE order_number = ? LIMIT 1`,
    [number],
  );
  if (!rows.length) throw new OrderNotFoundError(number);
  const order = rows[0];

  let adminNotes = '';
  let paymentVerifiedAt = null;
  let shippingCourier = '';
  let trackingNumber = '';
  let shippedAt = null;
  let completedAt = null;
  let fulfillmentMethod = 'campus_delivery';
  let paymentMethod = null;

  try {
    const [extra] = await pool.execute(
      `SELECT admin_notes, payment_verified_at, shipping_courier, tracking_number, shipped_at, completed_at,
              fulfillment_method, payment_method
       FROM orders WHERE id = ? LIMIT 1`,
      [order.id],
    );
    if (extra.length) {
      adminNotes = extra[0].admin_notes || '';
      paymentVerifiedAt = extra[0].payment_verified_at || null;
      shippingCourier = extra[0].shipping_courier || '';
      trackingNumber = extra[0].tracking_number || '';
      shippedAt = extra[0].shipped_at || null;
      completedAt = extra[0].completed_at || null;
      fulfillmentMethod = extra[0].fulfillment_method || 'campus_delivery';
      paymentMethod = extra[0].payment_method || null;
    }
  } catch {
    // Columns might not exist yet if unmigrated
  }

  const [items] = await pool.execute(
    `SELECT id, product_name, quantity, unit_price, subtotal
     FROM order_items WHERE order_id = ? ORDER BY id ASC`,
    [order.id],
  );

  let configuration = null;
  const itemsWithConfig = [];
  if (items.length) {
    const [configurations] = await pool.execute(
      `SELECT id, order_item_id, configuration_json, created_at
       FROM customizer_configurations WHERE order_item_id IN (${items.map(() => '?').join(', ')})
       ORDER BY id ASC`,
      items.map((item) => item.id),
    );
    const configMap = new Map();
    configurations.forEach((c) => {
      const parsed = typeof c.configuration_json === 'string' ? safeParse(c.configuration_json) : c.configuration_json;
      configMap.set(c.order_item_id, parsed);
    });

    items.forEach((item) => {
      const cfg = configMap.get(item.id) || null;
      if (!configuration && cfg) configuration = cfg;
      itemsWithConfig.push({
        id: item.id,
        productName: item.product_name,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unit_price),
        subtotal: Number(item.subtotal),
        configuration: cfg,
      });
    });
  }

  let history = [];
  try {
    const [historyRows] = await pool.execute(
      `SELECT id, previous_status, new_status, changed_by, notes, created_at
       FROM order_status_history WHERE order_id = ? ORDER BY id ASC`,
      [order.id],
    );
    history = historyRows.map((h) => ({
      id: h.id,
      previousStatus: h.previous_status,
      newStatus: h.new_status,
      changedBy: h.changed_by,
      notes: h.notes || '',
      createdAt: h.created_at,
    }));
  } catch {
    // History table might not exist yet if unmigrated
  }

  return {
    id: order.id,
    orderNumber: order.order_number,
    status: order.order_status,
    total: Number(order.total_amount),
    fulfillmentMethod,
    paymentMethod,
    customer: {
      name: order.customer_name,
      email: order.customer_email || '',
      phone: order.customer_phone,
      address: order.customer_address,
      note: order.customer_note || '',
    },
    items: itemsWithConfig,
    configuration,
    adminNotes,
    paymentVerifiedAt,
    shippingCourier,
    trackingNumber,
    shippedAt,
    completedAt,
    history,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

function cashbookUnavailableError() {
  const error = new Error('Cashbook tables are unavailable. Run npm run db:migrate and retry.');
  error.code = 'CASHBOOK_NOT_MIGRATED';
  error.statusCode = 503;
  return error;
}

async function requireSystemCategory(connection, name, entryType) {
  const [rows] = await connection.execute(
    `SELECT id FROM cashbook_categories
     WHERE name = ? AND entry_type = ? AND is_active = 1
     LIMIT 1 FOR UPDATE`,
    [name, entryType],
  );
  if (!rows.length) throw cashbookUnavailableError();
  return rows[0].id;
}

/**
 * Returns the order's income entries plus the newest one that has not been reversed. The
 * caller already holds a FOR UPDATE lock on the order row, so this read is serialised.
 */
async function findEffectiveIncome(connection, orderId) {
  const [incomeRows] = await connection.execute(
    `SELECT id, amount FROM cashbook_entries
     WHERE order_id = ? AND entry_type = 'income'
     ORDER BY id ASC`,
    [orderId],
  );
  if (!incomeRows.length) return { incomeRows: [], effective: null };

  const [reversalRows] = await connection.execute(
    'SELECT reverses_entry_id FROM cashbook_entries WHERE order_id = ? AND reverses_entry_id IS NOT NULL',
    [orderId],
  );
  const reversed = new Set(reversalRows.map((row) => Number(row.reverses_entry_id)));
  const effective = incomeRows.find((row) => !reversed.has(Number(row.id))) || null;
  return { incomeRows, effective };
}

/**
 * Writes the verified-payment income entry. Any unpaid status is accepted, so an order
 * verified straight from "waiting for payment" still reaches the cashbook. Re-verifying an
 * order that already carries unreversed income is a no-op, which keeps `order-paid:<id>`
 * idempotent; a payment that was reversed and is verified again gets the next cycle key.
 */
async function recordVerifiedIncome(connection, { orderId, orderNumber, amount, adminUserId }) {
  const { incomeRows, effective } = await findEffectiveIncome(connection, orderId);
  if (effective) return { created: false, entryId: Number(effective.id) };

  const categoryId = await requireSystemCategory(connection, SYSTEM_INCOME_CATEGORY, 'income');
  const cycle = incomeRows.length;
  const sourceKey = cycle === 0 ? `order-paid:${orderId}` : `order-paid:${orderId}:${cycle}`;

  await connection.execute(
    `INSERT INTO cashbook_entries
      (entry_type, amount, category_id, description, payment_method, transaction_date,
       order_id, source_key, admin_user_id)
     VALUES ('income', ?, ?, ?, NULL, CURRENT_DATE(), ?, ?, ?)
     ON DUPLICATE KEY UPDATE source_key = source_key`,
    [amount, categoryId, `Verified payment for ${orderNumber}`, orderId, sourceKey, adminUserId || null],
  );

  return { created: true, sourceKey };
}

/**
 * Cancelling a verified order books a refund against the original income entry. The income
 * row is left untouched (append-only history) and the refund is an expense row pointing back
 * at it through reverses_entry_id, so the balance returns to zero for that order.
 */
async function recordCancellationReversal(connection, { orderId, orderNumber, adminUserId, notes }) {
  const { effective } = await findEffectiveIncome(connection, orderId);
  if (!effective) return { created: false };

  const categoryId = await requireSystemCategory(connection, SYSTEM_REFUND_CATEGORY, 'expense');

  await connection.execute(
    `INSERT INTO cashbook_entries
      (entry_type, amount, category_id, description, payment_method, notes, transaction_date,
       order_id, source_key, admin_user_id, reverses_entry_id)
     VALUES ('expense', ?, ?, ?, NULL, ?, CURRENT_DATE(), ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE source_key = source_key`,
    [
      effective.amount,
      categoryId,
      `Cancellation reversal for ${orderNumber}`,
      notes ? String(notes).slice(0, 2000) : null,
      orderId,
      `order-cancelled:${effective.id}`,
      adminUserId || null,
      Number(effective.id),
    ],
  );

  return { created: true, reversesEntryId: Number(effective.id) };
}

async function updateOrderStatusAdmin(orderNumber, nextStatus, {
  changedBy = 'admin',
  adminUserId = null,
  notes = '',
  courier = null,
  trackingNumber = null,
} = {}) {
  const number = String(orderNumber || '').trim();
  const status = String(nextStatus || '').trim();

  if (!ORDER_STATUSES.includes(status)) {
    const error = new Error(`Unknown order status: ${status}`);
    error.code = 'INVALID_STATUS';
    error.statusCode = 400;
    throw error;
  }

  await withTransaction(async (connection) => {
    const [rows] = await connection.execute(
      'SELECT id, order_status, total_amount FROM orders WHERE order_number = ? LIMIT 1 FOR UPDATE',
      [number],
    );
    if (!rows.length) throw new OrderNotFoundError(number);

    const orderId = rows[0].id;
    const currentStatus = rows[0].order_status;
    const updates = ['order_status = ?'];
    const params = [status];

    // Stamp the verification time only on the transition into paid, so re-saving an already
    // verified order keeps the original audit timestamp.
    if (status === 'paid' && currentStatus !== 'paid') {
      updates.push('payment_verified_at = CURRENT_TIMESTAMP');
    } else if (status === 'shipped') {
      updates.push('shipped_at = CURRENT_TIMESTAMP');
    } else if (status === 'completed') {
      updates.push('completed_at = CURRENT_TIMESTAMP');
    }

    if (courier !== null) {
      updates.push('shipping_courier = ?');
      params.push(String(courier).trim());
    }
    if (trackingNumber !== null) {
      updates.push('tracking_number = ?');
      params.push(String(trackingNumber).trim());
    }

    params.push(orderId);
    await connection.execute(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`, params);

    try {
      await connection.execute(
        `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, currentStatus, status, String(changedBy || 'admin').slice(0, 60), notes ? String(notes) : null],
      );
    } catch {
      // safe fallback if table is not yet migrated
    }

    if (status === 'paid' && currentStatus !== 'paid') {
      await recordVerifiedIncome(connection, {
        orderId,
        orderNumber: number,
        amount: rows[0].total_amount,
        adminUserId,
      });
    }

    if (status === 'cancelled') {
      await recordCancellationReversal(connection, {
        orderId,
        orderNumber: number,
        adminUserId,
        notes,
      });
    }
  });

  return getOrderDetailAdmin(number);
}

async function updateOrderAdminNotes(orderNumber, { adminNotes, shippingCourier, trackingNumber } = {}) {
  const number = String(orderNumber || '').trim();
  const pool = getPool();
  const [rows] = await pool.execute('SELECT id FROM orders WHERE order_number = ? LIMIT 1', [number]);
  if (!rows.length) throw new OrderNotFoundError(number);

  const updates = [];
  const params = [];

  if (adminNotes !== undefined) {
    updates.push('admin_notes = ?');
    params.push(adminNotes ? String(adminNotes) : null);
  }
  if (shippingCourier !== undefined) {
    updates.push('shipping_courier = ?');
    params.push(shippingCourier ? String(shippingCourier).trim() : null);
  }
  if (trackingNumber !== undefined) {
    updates.push('tracking_number = ?');
    params.push(trackingNumber ? String(trackingNumber).trim() : null);
  }

  if (updates.length) {
    params.push(rows[0].id);
    await pool.execute(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  return getOrderDetailAdmin(number);
}

async function getAdminMetrics() {
  const pool = getPool();

  const [statusCounts] = await pool.execute(
    `SELECT order_status, COUNT(*) AS count, SUM(total_amount) AS revenue
     FROM orders
     GROUP BY order_status`,
  );

  const metrics = {
    totalOrders: 0,
    totalRevenue: 0,
    countsByStatus: {
      waiting_for_payment: 0,
      payment_confirmation_sent: 0,
      paid: 0,
      in_production: 0,
      shipped: 0,
      completed: 0,
      cancelled: 0,
    },
    revenueByStatus: {},
  };

  const revenueEligibleStatuses = ['paid', 'in_production', 'shipped', 'completed'];

  statusCounts.forEach((row) => {
    const s = row.order_status;
    const count = Number(row.count) || 0;
    const rev = Number(row.revenue) || 0;

    metrics.totalOrders += count;
    metrics.countsByStatus[s] = count;
    metrics.revenueByStatus[s] = rev;

    if (revenueEligibleStatuses.includes(s)) {
      metrics.totalRevenue += rev;
    }
  });

  return metrics;
}

module.exports = {
  createOrder,
  getOrderByNumber,
  updateOrderStatus,
  listOrdersAdmin,
  getOrderDetailAdmin,
  updateOrderStatusAdmin,
  updateOrderAdminNotes,
  getAdminMetrics,
  generateOrderNumber,
  ORDER_STATUSES,
  OrderNotFoundError,
  InvalidTransitionError,
  ValidationError,
};