-- LOCOXATL — Additive migration 008: one shared keychain product + member artwork
-- Compatible with MySQL 8.0 - 8.4 LTS and MariaDB 10.4+.
-- Strictly additive and idempotent: no table, column or row is dropped, truncated or rewritten.
-- catalog_products and every historical order stay exactly as they are.
-- Execute only after selecting the intended database.
--
-- What this migration adds:
--   1. artist_members.design_image_url — the member's keychain artwork (the design applied to the
--      one shared product), alongside the existing portrait_url.
--   2. product_settings — a single row selecting the one global base silhouette.
--   3. A single shared base price row in pricing_options (category 'base', option_key 'keychain')
--      seeded from the existing catalogue when possible. Existing prices are never overwritten.

-- ---------------------------------------------------------------------------
-- 1. Member keychain artwork
-- ---------------------------------------------------------------------------
SET @has_members_table := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'artist_members'
);
SET @has_design_column := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'artist_members' AND COLUMN_NAME = 'design_image_url'
);
SET @statement := IF(
  @has_members_table > 0 AND @has_design_column = 0,
  'ALTER TABLE artist_members ADD COLUMN design_image_url VARCHAR(512) NULL AFTER portrait_url',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- ---------------------------------------------------------------------------
-- 2. The one global base silhouette (single row, id = 1)
--    `heart` stays the default because it is the silhouette the bundled studio opens on.
--    INSERT IGNORE never overwrites an explicit admin setting on re-run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_settings (
  id TINYINT UNSIGNED NOT NULL,
  base_model VARCHAR(20) NOT NULL DEFAULT 'heart',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT chk_product_settings_base_model CHECK (base_model IN ('heart', 'star', 'bow'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO product_settings (id, base_model) VALUES (1, 'heart');

-- ---------------------------------------------------------------------------
-- 3. Shared base price in pricing_options
--    The price is derived from the existing catalogue (the default heart design) so no value is
--    invented. Only when that data does not exist yet does it fall back to the bundled studio
--    default of 45000, which is the price the storefront already renders today.
--    The INSERT is skipped entirely when a base price row (or the 'keychain' key) already exists,
--    so an operator's price is never silently overwritten.
-- ---------------------------------------------------------------------------
SET @base_price := 45000;

SET @has_products_table := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_products'
);
SET @statement := IF(
  @has_products_table > 0,
  'SET @base_price := COALESCE((SELECT base_price FROM catalog_products WHERE template_key = ''acrylic-keychain'' ORDER BY id ASC LIMIT 1), 45000)',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_pricing_table := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pricing_options'
);
SET @statement := IF(
  @has_pricing_table > 0,
  'INSERT INTO pricing_options (category, option_key, label, price, is_active, sort_order)
   SELECT ''base'', ''keychain'', ''Keychain base'', @base_price, 1, 0
   FROM DUAL
   WHERE NOT EXISTS (
     SELECT 1 FROM pricing_options WHERE option_key = ''keychain'' OR category = ''base''
   )',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Images themselves live in Cloudinary or the local upload fallback; the member row only stores
-- the public URL of its keychain artwork.
