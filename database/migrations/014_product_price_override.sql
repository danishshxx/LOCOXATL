-- LOCOXATL additive migration 014: optional per-design price override
-- Compatible with MySQL 8.0 - 8.4 LTS and MariaDB 10.4+.
-- Strictly additive and idempotent: each column is added only while it is missing, and no stored
-- price is rewritten. A NULL override keeps the global base price as the effective price.

SET @has_product_price_override := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_products' AND COLUMN_NAME = 'price_override'
);
SET @statement := IF(
  @has_product_price_override = 0,
  'ALTER TABLE catalog_products ADD COLUMN price_override INT UNSIGNED NULL DEFAULT NULL',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_member_price_override := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'artist_members' AND COLUMN_NAME = 'price_override'
);
SET @statement := IF(
  @has_member_price_override = 0,
  'ALTER TABLE artist_members ADD COLUMN price_override INT UNSIGNED NULL DEFAULT NULL',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SELECT TABLE_NAME AS price_override_table, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND COLUMN_NAME = 'price_override'
  AND TABLE_NAME IN ('catalog_products', 'artist_members')
ORDER BY TABLE_NAME;
