-- LOCOXATL — Product designs per collection + editable studio pricing
-- Additive and safe to re-run: every statement is guarded by INFORMATION_SCHEMA or by a
-- "only seed when empty" count, so existing rows are never rewritten.
-- Execute only after selecting the intended database.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
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
  CONSTRAINT fk_catalog_product_group FOREIGN KEY (group_id) REFERENCES catalog_groups (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. Seed the bundled add-on and clasp prices (only when the table is empty)
-- ---------------------------------------------------------------------------
SET @pricing_rows := (SELECT COUNT(*) FROM pricing_options);

INSERT INTO pricing_options (category, option_key, label, price, is_active, sort_order)
SELECT defaults.category, defaults.option_key, defaults.label, defaults.price, 1, defaults.sort_order
FROM (
  SELECT 'addon' AS category, 'pearl' AS option_key, 'Pearl drop' AS label, 8000 AS price, 0 AS sort_order
  UNION ALL SELECT 'addon', 'star', 'Mini star', 12000, 1
  UNION ALL SELECT 'addon', 'initial', 'Your initial', 5000, 2
  UNION ALL SELECT 'clasp', 'silver', 'Silver clasp', 7000, 0
  UNION ALL SELECT 'clasp', 'black', 'Black clasp', 5000, 1
) AS defaults
WHERE @pricing_rows = 0;

-- ---------------------------------------------------------------------------
-- 3. Seed the three standard designs for every existing collection
--    Slugs stay short; the storefront addresses a design as <group-slug>-<slug>, which is
--    exactly the URL shape the bundled catalogue used, so no existing link breaks.
-- ---------------------------------------------------------------------------
SET @product_rows := (SELECT COUNT(*) FROM catalog_products);

INSERT INTO catalog_products (group_id, slug, name, template_key, description, base_price, is_active, sort_order)
SELECT
  g.id,
  templates.slug,
  templates.name,
  templates.template_key,
  templates.description,
  templates.base_price,
  1,
  templates.sort_order
FROM catalog_groups AS g
CROSS JOIN (
  SELECT 'cloud-heart' AS slug, 'Cloud Heart' AS name, 'acrylic-keychain' AS template_key,
         'A clean heart silhouette in glossy white acrylic.' AS description, 45000 AS base_price, 0 AS sort_order
  UNION ALL SELECT 'orbit-star', 'Orbit Star', 'photocard-holder',
         'A star-shaped base with a polished finish.', 45000, 1
  UNION ALL SELECT 'soft-ribbon', 'Soft Ribbon', 'phone-charm',
         'A soft ribbon silhouette made for your combination.', 49000, 2
) AS templates
WHERE @product_rows = 0;
