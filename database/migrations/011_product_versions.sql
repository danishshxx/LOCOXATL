-- LOCOXATL additive migration 011: Yellow / Pink product versions
-- Compatible with MySQL 8.0 - 8.4 LTS and MariaDB 10.4+.
-- Strictly additive and idempotent: no table is dropped and no row is rewritten.
--
-- Every column is added only when INFORMATION_SCHEMA says it is missing, which is the same
-- guard pattern migration 004 uses. Existing rows inherit version_key = 'yellow'.

SET @has_product_version := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_products' AND COLUMN_NAME = 'version_key'
);
SET @statement := IF(
  @has_product_version = 0,
  'ALTER TABLE catalog_products ADD COLUMN version_key VARCHAR(32) NOT NULL DEFAULT ''yellow'' AFTER template_key',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_member_version := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'artist_members' AND COLUMN_NAME = 'version_key'
);
SET @statement := IF(
  @has_member_version = 0,
  'ALTER TABLE artist_members ADD COLUMN version_key VARCHAR(32) NOT NULL DEFAULT ''yellow'' AFTER design_image_url',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_group_versions := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_groups' AND COLUMN_NAME = 'versions_json'
);
SET @statement := IF(
  @has_group_versions = 0,
  'ALTER TABLE catalog_groups ADD COLUMN versions_json JSON NULL AFTER hero_focal',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SELECT version_key AS default_product_version FROM catalog_products LIMIT 1;
