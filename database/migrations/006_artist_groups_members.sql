-- LOCOXATL — Additive migration 006: artist group presentation + group members
-- Compatible with MySQL 8.0 - 8.4 LTS and MariaDB 10.4+.
-- Strictly additive and idempotent: no table or row is dropped and no existing row is rewritten.
-- Execute only after selecting the intended database.
--
-- catalog_groups is the artist/group table the storefront already uses: it owns the slug, name,
-- description, collection cover image, visibility and display order that catalog_products and
-- order validation reference. This migration extends that table with the presentation fields the
-- Artist & Group Management CMS edits, and adds artist_members for the people inside a group.

SET @has_eyebrow := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_groups' AND COLUMN_NAME = 'eyebrow'
);
SET @statement := IF(
  @has_eyebrow = 0,
  'ALTER TABLE catalog_groups ADD COLUMN eyebrow VARCHAR(120) NOT NULL DEFAULT '''' AFTER tagline',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_hero := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_groups' AND COLUMN_NAME = 'hero_image_url'
);
SET @statement := IF(
  @has_hero = 0,
  'ALTER TABLE catalog_groups ADD COLUMN hero_image_url VARCHAR(512) NULL AFTER image_url',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_cover_focal := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_groups' AND COLUMN_NAME = 'cover_focal'
);
SET @statement := IF(
  @has_cover_focal = 0,
  'ALTER TABLE catalog_groups ADD COLUMN cover_focal VARCHAR(32) NOT NULL DEFAULT ''50% 50%'' AFTER hero_image_url',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_hero_focal := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_groups' AND COLUMN_NAME = 'hero_focal'
);
SET @statement := IF(
  @has_hero_focal = 0,
  'ALTER TABLE catalog_groups ADD COLUMN hero_focal VARCHAR(32) NOT NULL DEFAULT ''50% 50%'' AFTER cover_focal',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Cloudinary delivery URLs are longer than the 255 characters migration 004 allowed. Widening a
-- VARCHAR is a metadata-only change on MySQL/MariaDB and never touches stored values. Each
-- change is guarded so this file also applies to a database that skipped 004 or 005.
SET @image_len := (
  SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_groups' AND COLUMN_NAME = 'image_url'
);
SET @statement := IF(
  @image_len IS NOT NULL AND @image_len < 512,
  'ALTER TABLE catalog_groups MODIFY COLUMN image_url VARCHAR(512) NULL',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @product_image_len := (
  SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_products' AND COLUMN_NAME = 'image_url'
);
SET @statement := IF(
  @product_image_len IS NOT NULL AND @product_image_len < 512,
  'ALTER TABLE catalog_products MODIFY COLUMN image_url VARCHAR(512) NULL',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Members belong to exactly one group. A member slug is unique inside its group, mirroring the
-- catalog_products convention, so two groups may both have a member called "main".
CREATE TABLE IF NOT EXISTS artist_members (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  group_id INT UNSIGNED NOT NULL,
  slug VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  portrait_url VARCHAR(512) NULL,
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

-- Images themselves live in external object storage (Cloudinary) or the local upload fallback;
-- the row only stores the public URL plus the focal crop used by the storefront.
