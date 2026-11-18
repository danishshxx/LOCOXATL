-- LOCOXATL additive migration 009: bundle packages ("paketan")
-- Compatible with MySQL 8.0 - 8.4 LTS and MariaDB 10.4+.
-- Strictly additive and idempotent: no table is dropped and no row is rewritten.
--
-- Numbered 009 because 006_artist_groups_members.sql, 007 and 008 already shipped on this
-- branch; the table is exactly the one the original 006 request described.
--
-- `group_id` is NULL when the bundle applies to every collection; `allowed_addon_keys` is
-- NULL when any active add-on may be taken for free.

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

-- Confirmation for operators running this by hand: 1 means the table is in place.
SELECT COUNT(*) AS catalog_bundles_ready FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_bundles';
