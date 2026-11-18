-- LOCOXATL additive migration 012: payment methods, group display modes, fulfillment columns
-- Compatible with MySQL 8.0 - 8.4 LTS and MariaDB 10.4+.
-- Strictly additive and idempotent: no table is dropped and no row is rewritten except the
-- payment_methods seed, which only runs while that table is still empty.

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

INSERT INTO payment_methods (code, label, instructions, sort_order, is_active)
SELECT * FROM (
  SELECT 'qris' AS code, 'QRIS' AS label, 'Scan the QRIS code below with any mobile banking or e-wallet app, then send the payment proof to our WhatsApp CS.' AS instructions, 0 AS sort_order, 1 AS is_active
  UNION ALL SELECT 'cash', 'Cash', 'Pay in cash when we meet on campus or at the COD point. Our CS will confirm the time and place on WhatsApp.', 1, 1
  UNION ALL SELECT 'transfer', 'Bank Transfer', 'Transfer to the account our CS confirms on WhatsApp, then send the transfer receipt as payment proof.', 2, 1
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM payment_methods);

SET @has_group_has_versions := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_groups' AND COLUMN_NAME = 'has_versions'
);
SET @statement := IF(
  @has_group_has_versions = 0,
  'ALTER TABLE catalog_groups ADD COLUMN has_versions TINYINT(1) NOT NULL DEFAULT 1 AFTER versions_json',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_group_custom := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_groups' AND COLUMN_NAME = 'is_custom_design'
);
SET @statement := IF(
  @has_group_custom = 0,
  'ALTER TABLE catalog_groups ADD COLUMN is_custom_design TINYINT(1) NOT NULL DEFAULT 0 AFTER has_versions',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_fulfillment := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'fulfillment_method'
);
SET @statement := IF(
  @has_fulfillment = 0,
  'ALTER TABLE orders ADD COLUMN fulfillment_method VARCHAR(32) NOT NULL DEFAULT ''campus_delivery'' AFTER admin_notes',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_payment_method := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'payment_method'
);
SET @statement := IF(
  @has_payment_method = 0,
  'ALTER TABLE orders ADD COLUMN payment_method VARCHAR(32) NULL AFTER fulfillment_method',
  'DO 0'
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SELECT code AS seeded_payment_method, label FROM payment_methods ORDER BY sort_order ASC;
