-- LOCOXATL additive migration 013: options included with every bundle
-- Compatible with MySQL 8.0 - 8.4 LTS and MariaDB 10.4+.
-- Strictly additive and idempotent: one guarded column, and the strap category adopts the rule
-- only while that column is being created, so a later admin decision is never overwritten.

SET @has_bundle_included := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'option_categories' AND COLUMN_NAME = 'bundle_included'
);
SET @statement := IF(
  @has_bundle_included = 0,
  'ALTER TABLE option_categories ADD COLUMN bundle_included TINYINT(1) NOT NULL DEFAULT 0 AFTER counts_toward_bundle_free',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @statement := IF(
  @has_bundle_included = 0,
  'UPDATE option_categories SET bundle_included = 1 WHERE slug = ''silicone-strap''',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SELECT slug AS bundle_included_category FROM option_categories WHERE bundle_included = 1;
