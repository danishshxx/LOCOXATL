-- LOCOXATL — Additive migration 004: card images for catalog groups
-- Compatible with MySQL 8.0 - 8.4 LTS and MariaDB 10.4+.
-- Strictly additive and idempotent: no table is dropped and no row is rewritten.

SET @has_image_column := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_groups' AND COLUMN_NAME = 'image_url'
);
SET @statement := IF(
  @has_image_column = 0,
  'ALTER TABLE catalog_groups ADD COLUMN image_url VARCHAR(255) NULL AFTER description',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Uploaded files live in assets/uploads/catalog/ and are served by the /assets allowlist.
-- image_url stores that public path; NULL means the card keeps its monochrome fallback.
