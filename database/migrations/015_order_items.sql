-- LOCOXATL additive migration 015: multi-item order lines
-- Compatible with MySQL 8.0 - 8.4 LTS and MariaDB 10.4+.
-- Strictly additive and idempotent: every column is added only while it is missing, and the
-- historical single-item columns (product_name, subtotal) keep their values and meaning.

SET @has_item_name := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'item_name'
);
SET @statement := IF(
  @has_item_name = 0,
  'ALTER TABLE order_items ADD COLUMN item_name VARCHAR(160) NULL AFTER product_name',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_product_id := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'product_id'
);
SET @statement := IF(
  @has_product_id = 0,
  'ALTER TABLE order_items ADD COLUMN product_id INT UNSIGNED NULL AFTER item_name',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_member_id := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'member_id'
);
SET @statement := IF(
  @has_member_id = 0,
  'ALTER TABLE order_items ADD COLUMN member_id INT UNSIGNED NULL AFTER product_id',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_group_name := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'group_name'
);
SET @statement := IF(
  @has_group_name = 0,
  'ALTER TABLE order_items ADD COLUMN group_name VARCHAR(160) NULL AFTER member_id',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_version_name := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'version_name'
);
SET @statement := IF(
  @has_version_name = 0,
  'ALTER TABLE order_items ADD COLUMN version_name VARCHAR(32) NULL AFTER group_name',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_line_total := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'line_total'
);
SET @statement := IF(
  @has_line_total = 0,
  'ALTER TABLE order_items ADD COLUMN line_total INT UNSIGNED NULL AFTER subtotal',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_configuration_json := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'configuration_json'
);
SET @statement := IF(
  @has_configuration_json = 0,
  'ALTER TABLE order_items ADD COLUMN configuration_json JSON NULL AFTER line_total',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
ORDER BY ORDINAL_POSITION;
