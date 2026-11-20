-- LOCOXATL — MySQL schema for order persistence
-- Run against an already selected database; this file never creates or selects a database.
-- Example: mysql -h 127.0.0.1 -u locoxatl -p locoxatl < database/schema.sql
-- The schema is intentionally minimal: orders, their line items, and the 3D
-- customizer snapshot that belongs to each line item.

CREATE TABLE IF NOT EXISTS orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_number VARCHAR(32) NOT NULL,
  customer_name VARCHAR(120) NOT NULL,
  customer_email VARCHAR(180) NULL,
  customer_phone VARCHAR(40) NOT NULL,
  customer_address TEXT NOT NULL,
  customer_note TEXT NULL,
  admin_notes TEXT NULL,
  fulfillment_method VARCHAR(32) NOT NULL DEFAULT 'campus_delivery',
  payment_method VARCHAR(32) NULL,
  total_amount INT UNSIGNED NOT NULL,
  order_status VARCHAR(40) NOT NULL DEFAULT 'waiting_for_payment',
  payment_verified_at TIMESTAMP NULL,
  shipping_courier VARCHAR(60) NULL,
  tracking_number VARCHAR(100) NULL,
  shipped_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_order_number (order_number),
  KEY idx_orders_status (order_status),
  KEY idx_orders_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NOT NULL,
  product_name VARCHAR(160) NOT NULL,
  quantity SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  unit_price INT UNSIGNED NOT NULL,
  subtotal INT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  KEY idx_order_items_order (order_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customizer_configurations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_item_id BIGINT UNSIGNED NOT NULL,
  configuration_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_customizer_order_item (order_item_id),
  CONSTRAINT fk_customizer_order_item FOREIGN KEY (order_item_id) REFERENCES order_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_sessions (
  id VARCHAR(64) NOT NULL,
  admin_id BIGINT UNSIGNED NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_admin FOREIGN KEY (admin_id) REFERENCES admin_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Curated storefront collections. Rows are seeded from the six artists in src/catalog.js the
-- first time the table is empty, so existing links and historical orders keep resolving.
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
  versions_json JSON NULL,
  has_versions TINYINT(1) NOT NULL DEFAULT 1,
  is_custom_design TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_catalog_groups_slug (slug),
  KEY idx_catalog_groups_active_order (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- People inside a group. `slug` is unique per group, so two groups can each have a member with
-- the same short name. Rows cascade away with their group, never the other way around.
CREATE TABLE IF NOT EXISTS artist_members (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  group_id INT UNSIGNED NOT NULL,
  slug VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  portrait_url VARCHAR(512) NULL,
  design_image_url VARCHAR(512) NULL,
  price_override INT UNSIGNED NULL DEFAULT NULL,
  version_key VARCHAR(32) NOT NULL DEFAULT 'yellow',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_artist_member_slug (group_id, slug),
  KEY idx_artist_members_group_order (group_id, is_active, sort_order),
  KEY idx_artist_members_active_order (is_active, sort_order),
  CONSTRAINT fk_artist_member_group FOREIGN KEY (group_id) REFERENCES catalog_groups (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The single shared keychain product. One row (id = 1) selects the base silhouette every member
-- uses; member artwork lives on artist_members.design_image_url, never in a per-member product.
CREATE TABLE IF NOT EXISTS product_settings (
  id TINYINT UNSIGNED NOT NULL,
  base_model VARCHAR(20) NOT NULL DEFAULT 'heart',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT chk_product_settings_base_model CHECK (base_model IN ('heart', 'star', 'bow'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Product designs inside a collection. `slug` is unique per group and stays short
-- ("cloud-heart"); the storefront addresses a design as `<group-slug>-<slug>`, which is the
-- same URL shape the bundled catalogue used before this table existed.
CREATE TABLE IF NOT EXISTS catalog_products (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  group_id INT UNSIGNED NOT NULL,
  slug VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  template_key VARCHAR(64) NOT NULL,
  version_key VARCHAR(32) NOT NULL DEFAULT 'yellow',
  description TEXT NULL,
  base_price INT UNSIGNED NOT NULL,
  price_override INT UNSIGNED NULL DEFAULT NULL,
  image_url VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_group_product_slug (group_id, slug),
  KEY idx_catalog_product_group (group_id),
  CONSTRAINT fk_catalog_product_group FOREIGN KEY (group_id) REFERENCES catalog_groups (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Studio add-on and clasp prices. `option_key` matches the ids in src/options.js so historical
-- order snapshots keep resolving after a price change.
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

-- Bundle packages ("paketan"): a fixed price that includes a number of add-ons for free.
-- `group_id` is NULL when the bundle is available in every collection; `allowed_addon_keys`
-- is NULL when any active add-on may be taken for free.
CREATE TABLE IF NOT EXISTS catalog_bundles (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  group_id INT UNSIGNED NULL,
  slug VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT NULL,
  bundle_price INT UNSIGNED NOT NULL,
  free_addon_quota INT UNSIGNED NOT NULL DEFAULT 1,
  allowed_addon_keys JSON NULL,
  image_url VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_catalog_bundles_slug (slug),
  KEY idx_catalog_bundles_active_order (is_active, sort_order),
  KEY idx_catalog_bundles_group (group_id),
  CONSTRAINT fk_bundle_group FOREIGN KEY (group_id) REFERENCES catalog_groups (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Customer-facing option groups. pricing_options.category stores one of these slugs, so a new
-- category (a strap, a charm) is a data change rather than a deploy.
CREATE TABLE IF NOT EXISTS option_categories (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug VARCHAR(32) NOT NULL,
  name VARCHAR(120) NOT NULL,
  selection_mode VARCHAR(16) NOT NULL DEFAULT 'multiple',
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  counts_toward_bundle_free TINYINT(1) NOT NULL DEFAULT 1,
  bundle_included TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_option_category_slug (slug),
  KEY idx_option_categories_active_order (is_active, sort_order),
  CONSTRAINT chk_option_category_selection_mode CHECK (selection_mode IN ('single', 'multiple'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- How a buyer pays. The admin dashboard edits the label, instructions and QRIS image, and can
-- switch a method off without deleting it, so historical orders keep their code.
CREATE TABLE IF NOT EXISTS payment_methods (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(32) NOT NULL,
  label VARCHAR(80) NOT NULL,
  instructions TEXT NULL,
  image_url VARCHAR(512) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_method_code (code),
  KEY idx_payment_methods_active_order (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
