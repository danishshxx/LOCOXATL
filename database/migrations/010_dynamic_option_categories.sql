-- LOCOXATL additive migration 010: dynamic option categories
-- Compatible with MySQL 8.0 - 8.4 LTS and MariaDB 10.4+.
-- Strictly additive and idempotent: no table is dropped and no row is rewritten.
--
-- pricing_options.category already stores a free-form slug (VARCHAR 32), so adding a category
-- here is enough for the studio and the order validation to pick it up. Both seed blocks are
-- guarded by an emptiness check, which is what makes a second run a no-op.

CREATE TABLE IF NOT EXISTS option_categories (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug VARCHAR(32) NOT NULL,
  name VARCHAR(120) NOT NULL,
  selection_mode VARCHAR(16) NOT NULL DEFAULT 'multiple',
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  counts_toward_bundle_free TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_option_category_slug (slug),
  KEY idx_option_categories_active_order (is_active, sort_order),
  CONSTRAINT chk_option_category_selection_mode CHECK (selection_mode IN ('single', 'multiple'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the three default categories only when the table is still empty.
INSERT INTO option_categories
  (slug, name, selection_mode, is_required, counts_toward_bundle_free, sort_order, is_active)
SELECT seed.slug, seed.name, seed.selection_mode, seed.is_required, seed.counts_toward_bundle_free, seed.sort_order, 1
FROM (
  SELECT 'addon' AS slug, 'Universal Add-ons' AS name, 'multiple' AS selection_mode, 0 AS is_required, 1 AS counts_toward_bundle_free, 0 AS sort_order
  UNION ALL SELECT 'clasp', 'Clasps', 'single', 1, 0, 1
  UNION ALL SELECT 'silicone-strap', 'Silicone Straps', 'single', 0, 0, 2
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM option_categories);

-- The strap category ships with two choices so it works the moment it appears in the studio.
INSERT INTO pricing_options (category, option_key, label, price, is_active, sort_order)
SELECT seed.category, seed.option_key, seed.label, seed.price, 1, seed.sort_order
FROM (
  SELECT 'silicone-strap' AS category, 'strap-white' AS option_key, 'White silicone strap' AS label, 8000 AS price, 10 AS sort_order
  UNION ALL SELECT 'silicone-strap', 'strap-black', 'Black silicone strap', 8000, 11
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM pricing_options WHERE category = 'silicone-strap');

SELECT COUNT(*) AS option_categories_ready FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'option_categories';
