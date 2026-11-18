const fs = require('node:fs');
const path = require('node:path');
const { getPool, isConfigured } = require('./db');
const { seedCatalogGroups, seedCatalogProducts, seedPricingOptions } = require('./catalog');

function parseSchemaStatements(sql) {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function tableColumns(connection, table) {
  const [rows] = await connection.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return new Set(rows.map((row) => String(row.COLUMN_NAME).toLowerCase()));
}

async function tableIndexes(connection, table) {
  const [rows] = await connection.query(
    `SELECT DISTINCT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return new Set(rows.map((row) => String(row.INDEX_NAME).toLowerCase()));
}

async function tableConstraints(connection, table) {
  const [rows] = await connection.query(
    `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [table],
  );
  return new Set(rows.map((row) => String(row.CONSTRAINT_NAME).toLowerCase()));
}

/** Character length of a column, or null when the column (or its table) does not exist. */
async function columnLength(connection, table, column) {
  const [rows] = await connection.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS columnLength FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  const length = rows[0] && rows[0].columnLength;
  return length === undefined || length === null ? null : Number(length);
}

async function assertSelectedDatabase(connection) {
  const [rows] = await connection.query('SELECT DATABASE() AS databaseName');
  const databaseName = rows[0] && rows[0].databaseName;
  if (!databaseName || databaseName !== process.env.DB_NAME) {
    throw new Error('The active MySQL database does not match DB_NAME.');
  }
  return databaseName;
}

async function runBaseSchema() {
  if (!isConfigured()) return { skipped: true, reason: 'not_configured' };

  const pool = getPool();
  const connection = await pool.getConnection();
  try {
    const databaseName = await assertSelectedDatabase(connection);
    const schemaPath = path.join(__dirname, '..', '..', 'database', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    for (const statement of parseSchemaStatements(schema)) {
      await connection.query(statement);
    }
    return { success: true, databaseName };
  } finally {
    connection.release();
  }
}

/**
 * Ensures admin columns, audit tables, and auth tables exist in MySQL without modifying
 * or deleting any existing customer orders or configurations.
 * Strictly additive, idempotent, and compatible with MySQL 8.0 - 8.4 LTS.
 */
async function runAdditiveMigrations() {
  if (!isConfigured()) return { skipped: true, reason: 'not_configured' };

  const baseSchema = await runBaseSchema();
  if (!baseSchema.success) return baseSchema;

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    const databaseName = await assertSelectedDatabase(connection);
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
        reverses_entry_id BIGINT UNSIGNED NULL,
        correction_note VARCHAR(500) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_cashbook_source_key (source_key),
        UNIQUE KEY uq_cashbook_supersedes_entry (supersedes_entry_id),
        UNIQUE KEY uq_cashbook_reverses_entry (reverses_entry_id),
        KEY idx_cashbook_type_date (entry_type, transaction_date),
        KEY idx_cashbook_date (transaction_date),
        KEY idx_cashbook_category_date (category_id, transaction_date),
        KEY idx_cashbook_order (order_id),
        CONSTRAINT fk_cashbook_category FOREIGN KEY (category_id) REFERENCES cashbook_categories (id) ON DELETE RESTRICT,
        CONSTRAINT fk_cashbook_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
        CONSTRAINT fk_cashbook_admin FOREIGN KEY (admin_user_id) REFERENCES admin_users (id) ON DELETE SET NULL,
        CONSTRAINT fk_cashbook_supersedes FOREIGN KEY (supersedes_entry_id) REFERENCES cashbook_entries (id) ON DELETE RESTRICT,
        CONSTRAINT fk_cashbook_reverses FOREIGN KEY (reverses_entry_id) REFERENCES cashbook_entries (id) ON DELETE RESTRICT,
        CONSTRAINT chk_cashbook_amount_positive CHECK (amount > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Existing installations carry the older unique key that allowed one income row per order
    // for ever. Reversal + re-verification needs multiple income rows, so the key is dropped;
    // idempotency now comes from uq_cashbook_source_key and the reversal pointer.
    //
    // fk_cashbook_order has no index of its own: InnoDB borrows the leftmost column of
    // uq_cashbook_order_entry_type to support it. Dropping the key therefore fails with
    // "Cannot drop index ... needed in a foreign key constraint" on any database upgraded from
    // 002. Give the constraint a plain index first, then drop the legacy key.
    const cashbookIndexes = await tableIndexes(connection, 'cashbook_entries');
    if (!cashbookIndexes.has('idx_cashbook_order')) {
      await connection.query('ALTER TABLE cashbook_entries ADD INDEX idx_cashbook_order (order_id)');
    }
    if (cashbookIndexes.has('uq_cashbook_order_entry_type')) {
      await connection.query('ALTER TABLE cashbook_entries DROP INDEX uq_cashbook_order_entry_type');
    }

    const cashbookColumns = await tableColumns(connection, 'cashbook_entries');
    if (!cashbookColumns.has('reverses_entry_id')) {
      await connection.query(
        'ALTER TABLE cashbook_entries ADD COLUMN reverses_entry_id BIGINT UNSIGNED NULL AFTER supersedes_entry_id',
      );
    }

    const cashbookConstraints = await tableConstraints(connection, 'cashbook_entries');
    if (!cashbookConstraints.has('fk_cashbook_reverses')) {
      const refreshedIndexes = await tableIndexes(connection, 'cashbook_entries');
      if (!refreshedIndexes.has('uq_cashbook_reverses_entry')) {
        await connection.query(
          'ALTER TABLE cashbook_entries ADD UNIQUE KEY uq_cashbook_reverses_entry (reverses_entry_id)',
        );
      }
      await connection.query(
        `ALTER TABLE cashbook_entries
         ADD CONSTRAINT fk_cashbook_reverses FOREIGN KEY (reverses_entry_id)
         REFERENCES cashbook_entries (id) ON DELETE RESTRICT`,
      );
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS catalog_groups (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        slug VARCHAR(64) NOT NULL,
        name VARCHAR(120) NOT NULL,
        tagline VARCHAR(255) NOT NULL DEFAULT '',
        eyebrow VARCHAR(120) NOT NULL DEFAULT '',
        description TEXT NULL,
        image_url VARCHAR(512) NULL,
        hero_image_url VARCHAR(512) NULL,
        cover_focal VARCHAR(32) NOT NULL DEFAULT '50% 50%',
        hero_focal VARCHAR(32) NOT NULL DEFAULT '50% 50%',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_catalog_groups_slug (slug),
        KEY idx_catalog_groups_active_order (is_active, sort_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const catalogColumns = await tableColumns(connection, 'catalog_groups');
    // Migration 006 presentation fields. Each is added only when missing, so a database created
    // from an older schema.sql, 003 or 004 is upgraded in place without rewriting any row.
    const presentationColumns = [
      { name: 'image_url', definition: 'VARCHAR(512) NULL AFTER description' },
      { name: 'eyebrow', definition: "VARCHAR(120) NOT NULL DEFAULT '' AFTER tagline" },
      { name: 'hero_image_url', definition: 'VARCHAR(512) NULL AFTER image_url' },
      { name: 'cover_focal', definition: "VARCHAR(32) NOT NULL DEFAULT '50% 50%' AFTER hero_image_url" },
      { name: 'hero_focal', definition: "VARCHAR(32) NOT NULL DEFAULT '50% 50%' AFTER cover_focal" },
    ];
    for (const column of presentationColumns) {
      if (catalogColumns.has(column.name)) continue;
      await connection.query(`ALTER TABLE catalog_groups ADD COLUMN ${column.name} ${column.definition}`);
    }

    // Cloudinary delivery URLs are longer than the 255 characters migration 004 allowed.
    // Widening a VARCHAR is metadata-only and never rewrites stored values.
    const groupImageLength = await columnLength(connection, 'catalog_groups', 'image_url');
    if (groupImageLength !== null && groupImageLength < 512) {
      await connection.query('ALTER TABLE catalog_groups MODIFY COLUMN image_url VARCHAR(512) NULL');
    }
    const productImageLength = await columnLength(connection, 'catalog_products', 'image_url');
    if (productImageLength !== null && productImageLength < 512) {
      await connection.query('ALTER TABLE catalog_products MODIFY COLUMN image_url VARCHAR(512) NULL');
    }

    // 6. Group members (migration 006). Additive: the table is created only when missing.
    await connection.query(`
      CREATE TABLE IF NOT EXISTS artist_members (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        group_id INT UNSIGNED NOT NULL,
        slug VARCHAR(64) NOT NULL,
        name VARCHAR(120) NOT NULL,
        portrait_url VARCHAR(512) NULL,
        design_image_url VARCHAR(512) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_artist_member_slug (group_id, slug),
        KEY idx_artist_members_group_order (group_id, is_active, sort_order),
        KEY idx_artist_members_active_order (is_active, sort_order),
        CONSTRAINT fk_artist_member_group FOREIGN KEY (group_id) REFERENCES catalog_groups (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Migration 008: the member's keychain artwork column and the single global product setting.
    // Both are additive and guarded, so an older database is upgraded in place.
    const memberColumns = await tableColumns(connection, 'artist_members');
    if (!memberColumns.has('design_image_url')) {
      await connection.query(
        'ALTER TABLE artist_members ADD COLUMN design_image_url VARCHAR(512) NULL AFTER portrait_url',
      );
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS product_settings (
        id TINYINT UNSIGNED NOT NULL,
        base_model VARCHAR(20) NOT NULL DEFAULT 'heart',
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        CONSTRAINT chk_product_settings_base_model CHECK (base_model IN ('heart', 'star', 'bow'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    // 'heart' is the silhouette the bundled studio already opens on, so it stays the default.
    await connection.query("INSERT IGNORE INTO product_settings (id, base_model) VALUES (1, 'heart')");

    // 5. Product designs per collection and the editable studio price table (migration 005).
    //    Both are additive: existing rows are never rewritten, and the seeders below only run
    //    when their table is still empty.
    await connection.query(`
      CREATE TABLE IF NOT EXISTS catalog_products (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        group_id INT UNSIGNED NOT NULL,
        slug VARCHAR(64) NOT NULL,
        name VARCHAR(120) NOT NULL,
        template_key VARCHAR(64) NOT NULL,
        description TEXT NULL,
        base_price INT UNSIGNED NOT NULL,
        image_url VARCHAR(255) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_group_product_slug (group_id, slug),
        KEY idx_catalog_product_group (group_id),
        CONSTRAINT fk_catalog_product_group FOREIGN KEY (group_id) REFERENCES catalog_groups (id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [productGroupFks] = await connection.query(`
      SELECT kcu.CONSTRAINT_NAME AS constraintName, rc.DELETE_RULE AS deleteRule
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
      JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
        ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
       AND rc.TABLE_NAME = kcu.TABLE_NAME
       AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
        AND kcu.TABLE_NAME = 'catalog_products'
        AND kcu.COLUMN_NAME = 'group_id'
        AND kcu.REFERENCED_TABLE_NAME = 'catalog_groups'
        AND kcu.REFERENCED_COLUMN_NAME = 'id'
    `);

    const restrictiveProductGroupFk = productGroupFks.find(
      (foreignKey) => String(foreignKey.deleteRule).toUpperCase() === 'RESTRICT',
    );
    if (!productGroupFks.length) {
      await connection.query(`
        ALTER TABLE catalog_products
        ADD CONSTRAINT fk_catalog_product_group
        FOREIGN KEY (group_id) REFERENCES catalog_groups (id) ON DELETE RESTRICT
      `);
    } else if (!restrictiveProductGroupFk) {
      await connection.query(`
        ALTER TABLE catalog_products
        ADD CONSTRAINT fk_catalog_product_group_restrict_007
        FOREIGN KEY (group_id) REFERENCES catalog_groups (id) ON DELETE RESTRICT
      `);
    }

    for (const foreignKey of productGroupFks) {
      if (foreignKey === restrictiveProductGroupFk) continue;
      const oldName = String(foreignKey.constraintName).replace(/`/g, '``');
      await connection.query(`
        ALTER TABLE catalog_products
        DROP FOREIGN KEY \`${oldName}\`
      `);
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS pricing_options (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        category VARCHAR(32) NOT NULL,
        option_key VARCHAR(64) NOT NULL,
        label VARCHAR(120) NOT NULL,
        price INT UNSIGNED NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_pricing_option_key (option_key),
        KEY idx_pricing_category_order (category, sort_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const catalogSeed = await seedCatalogGroups();
    const pricingSeed = await seedPricingOptions();
    const productSeed = await seedCatalogProducts();

    await connection.query(
      `INSERT IGNORE INTO cashbook_categories (name, entry_type) VALUES
        ('Verified Order Income', 'income'),
        ('Material', 'expense'),
        ('Production', 'expense'),
        ('Packaging', 'expense'),
        ('Shipping', 'expense'),
        ('Marketing', 'expense'),
        ('Operational', 'expense'),
        ('Other', 'expense'),
        ('Order Refunds', 'expense')`,
    );

    return {
      success: true,
      databaseName,
      addedColumns: missingColumns.map((c) => c.name),
      catalogGroupsSeeded: catalogSeed.seeded || 0,
      pricingOptionsSeeded: pricingSeed.seeded || 0,
      catalogProductsSeeded: productSeed.seeded || 0,
    };
  } finally {
    connection.release();
  }
}

module.exports = { runBaseSchema, runAdditiveMigrations, parseSchemaStatements };
