const { getPool, isConfigured } = require('./db');

/**
 * Ensures admin columns, audit tables, and auth tables exist in MySQL without modifying
 * or deleting any existing customer orders or configurations.
 * Strictly additive, idempotent, and compatible with MySQL 8.0 - 8.4 LTS.
 */
async function runAdditiveMigrations() {
  if (!isConfigured()) return { skipped: true, reason: 'not_configured' };

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    // 1. Check existing columns in the orders table
    const [columns] = await connection.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'`
    );

    const existingColNames = new Set(columns.map((c) => c.COLUMN_NAME.toLowerCase()));

    const missingColumns = [
      { name: 'admin_notes', definition: 'TEXT NULL AFTER customer_note' },
      { name: 'payment_verified_at', definition: 'TIMESTAMP NULL AFTER order_status' },
      { name: 'shipping_courier', definition: 'VARCHAR(60) NULL AFTER payment_verified_at' },
      { name: 'tracking_number', definition: 'VARCHAR(100) NULL AFTER shipping_courier' },
      { name: 'shipped_at', definition: 'TIMESTAMP NULL AFTER tracking_number' },
      { name: 'completed_at', definition: 'TIMESTAMP NULL AFTER shipped_at' },
    ].filter((col) => !existingColNames.has(col.name));

    for (const col of missingColumns) {
      await connection.query(`ALTER TABLE orders ADD COLUMN ${col.name} ${col.definition}`);
    }

    // 2. Ensure order_status_history table exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS order_status_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        order_id BIGINT UNSIGNED NOT NULL,
        previous_status VARCHAR(40) NULL,
        new_status VARCHAR(40) NOT NULL,
        changed_by VARCHAR(60) NOT NULL DEFAULT 'admin',
        notes TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_history_order (order_id),
        KEY idx_history_new_status (new_status),
        KEY idx_history_created_at (created_at),
        CONSTRAINT fk_history_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 3. Ensure admin_users table exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        username VARCHAR(64) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_admin_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 4. Ensure admin_sessions table exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id VARCHAR(64) NOT NULL,
        admin_id BIGINT UNSIGNED NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_sessions_expires (expires_at),
        CONSTRAINT fk_sessions_admin FOREIGN KEY (admin_id) REFERENCES admin_users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS cashbook_categories (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        entry_type ENUM('income', 'expense') NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_cashbook_category (entry_type, name),
        KEY idx_cashbook_categories_active (entry_type, is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS cashbook_entries (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        entry_type ENUM('income', 'expense') NOT NULL,
        amount BIGINT UNSIGNED NOT NULL,
        category_id BIGINT UNSIGNED NOT NULL,
        description VARCHAR(255) NOT NULL,
        payment_method VARCHAR(80) NULL,
        notes TEXT NULL,
        transaction_date DATE NOT NULL,
        order_id BIGINT UNSIGNED NULL,
        source_key VARCHAR(120) NULL,
        admin_user_id BIGINT UNSIGNED NULL,
        supersedes_entry_id BIGINT UNSIGNED NULL,
        correction_note VARCHAR(500) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_cashbook_source_key (source_key),
        UNIQUE KEY uq_cashbook_order_entry_type (order_id, entry_type),
        UNIQUE KEY uq_cashbook_supersedes_entry (supersedes_entry_id),
        KEY idx_cashbook_type_date (entry_type, transaction_date),
        KEY idx_cashbook_date (transaction_date),
        KEY idx_cashbook_category_date (category_id, transaction_date),
        CONSTRAINT fk_cashbook_category FOREIGN KEY (category_id) REFERENCES cashbook_categories (id) ON DELETE RESTRICT,
        CONSTRAINT fk_cashbook_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
        CONSTRAINT fk_cashbook_admin FOREIGN KEY (admin_user_id) REFERENCES admin_users (id) ON DELETE SET NULL,
        CONSTRAINT fk_cashbook_supersedes FOREIGN KEY (supersedes_entry_id) REFERENCES cashbook_entries (id) ON DELETE RESTRICT,
        CONSTRAINT chk_cashbook_amount_positive CHECK (amount > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(
      `INSERT IGNORE INTO cashbook_categories (name, entry_type) VALUES
        ('Verified Order Income', 'income'),
        ('Material', 'expense'),
        ('Production', 'expense'),
        ('Packaging', 'expense'),
        ('Shipping', 'expense'),
        ('Marketing', 'expense'),
        ('Operational', 'expense'),
        ('Other', 'expense')`,
    );

    return {
      success: true,
      addedColumns: missingColumns.map((c) => c.name),
    };
  } finally {
    connection.release();
  }
}

module.exports = { runAdditiveMigrations };
