-- LOCOXATL — Additive migration 003: catalog groups and cashbook reversals
-- Compatible with MySQL 8.0 - 8.4 LTS and MariaDB 10.4+.
-- Strictly additive and idempotent: it never drops a table, truncates data, or switches
-- databases. Execute only after selecting the intended database.

-- ---------------------------------------------------------------------------
-- 1. Curated storefront collections
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog_groups (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  tagline VARCHAR(255) NOT NULL DEFAULT '',
  description TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_catalog_groups_slug (slug),
  KEY idx_catalog_groups_active_order (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the six static artists only when the table is still empty, so existing storefront
-- links and historical orders keep resolving after the upgrade.
INSERT INTO catalog_groups (slug, name, tagline, description, is_active, sort_order)
SELECT seed.slug, seed.name, seed.tagline, seed.description, seed.is_active, seed.sort_order
FROM (
  SELECT 'blackpink' AS slug, 'BLACKPINK' AS name, 'BLINK' AS tagline, 'Bold energy. Personal details.' AS description, 1 AS is_active, 0 AS sort_order
  UNION ALL SELECT 'bts', 'BTS', 'ARMY', 'A little reminder of what moves you.', 1, 1
  UNION ALL SELECT 'seventeen', 'SEVENTEEN', 'CARAT', 'Made of many little moments.', 1, 2
  UNION ALL SELECT 'newjeans', 'NewJeans', 'BUNNIES', 'Fresh shapes, everyday expression.', 1, 3
  UNION ALL SELECT 'nct', 'NCT', 'NCTzen', 'A signature combination, your way.', 1, 4
  UNION ALL SELECT 'riize', 'RIIZE', 'BRIIZE', 'Small pieces for new memories.', 1, 5
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM catalog_groups);

-- ---------------------------------------------------------------------------
-- 2. Cashbook: pointer from a refund back to the income it reverses
-- ---------------------------------------------------------------------------
SET @has_reverses_column := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cashbook_entries' AND COLUMN_NAME = 'reverses_entry_id'
);
SET @statement := IF(
  @has_reverses_column = 0,
  'ALTER TABLE cashbook_entries ADD COLUMN reverses_entry_id BIGINT UNSIGNED NULL AFTER supersedes_entry_id',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_reverses_index := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cashbook_entries' AND INDEX_NAME = 'uq_cashbook_reverses_entry'
);
SET @statement := IF(
  @has_reverses_index = 0,
  'ALTER TABLE cashbook_entries ADD UNIQUE KEY uq_cashbook_reverses_entry (reverses_entry_id)',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_reverses_fk := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cashbook_entries'
    AND CONSTRAINT_NAME = 'fk_cashbook_reverses' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @statement := IF(
  @has_reverses_fk = 0,
  'ALTER TABLE cashbook_entries ADD CONSTRAINT fk_cashbook_reverses FOREIGN KEY (reverses_entry_id) REFERENCES cashbook_entries (id) ON DELETE RESTRICT',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- fk_cashbook_order has no index of its own; InnoDB borrows the leftmost column of
-- uq_cashbook_order_entry_type to support the constraint. MariaDB refuses to drop a key that a
-- foreign key depends on, so the constraint gets a plain index before the legacy key goes.
SET @has_order_index := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cashbook_entries' AND INDEX_NAME = 'idx_cashbook_order'
);
SET @statement := IF(
  @has_order_index = 0,
  'ALTER TABLE cashbook_entries ADD INDEX idx_cashbook_order (order_id)',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- An order may now be verified, reversed and verified again, so the old "one income row per
-- order, ever" key has to go. Idempotency is enforced by uq_cashbook_source_key instead.
SET @has_legacy_order_key := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cashbook_entries' AND INDEX_NAME = 'uq_cashbook_order_entry_type'
);
SET @statement := IF(
  @has_legacy_order_key > 0,
  'ALTER TABLE cashbook_entries DROP INDEX uq_cashbook_order_entry_type',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- ---------------------------------------------------------------------------
-- 3. System category used by cancellation reversals
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO cashbook_categories (name, entry_type) VALUES ('Order Refunds', 'expense');
