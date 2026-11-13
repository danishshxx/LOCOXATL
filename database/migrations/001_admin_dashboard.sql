-- LOCOXATL — Safe Additive Migration: Admin Dashboard, Auth & Status History
-- Compatible with MySQL 8.0 - 8.4 LTS and MariaDB 10.4+
-- Strictly additive and idempotent. NEVER drops customer tables or alters existing data.

USE locoxatl;

-- 1. Safely add admin & fulfillment columns to orders if not already present
DROP PROCEDURE IF EXISTS add_locoxatl_admin_columns;

DELIMITER $$

CREATE PROCEDURE add_locoxatl_admin_columns()
BEGIN
  -- admin_notes
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'admin_notes'
  ) THEN
    ALTER TABLE orders ADD COLUMN admin_notes TEXT NULL AFTER customer_note;
  END IF;

  -- payment_verified_at
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'payment_verified_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN payment_verified_at TIMESTAMP NULL AFTER order_status;
  END IF;

  -- shipping_courier
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'shipping_courier'
  ) THEN
    ALTER TABLE orders ADD COLUMN shipping_courier VARCHAR(60) NULL AFTER payment_verified_at;
  END IF;

  -- tracking_number
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'tracking_number'
  ) THEN
    ALTER TABLE orders ADD COLUMN tracking_number VARCHAR(100) NULL AFTER shipping_courier;
  END IF;

  -- shipped_at
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'shipped_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN shipped_at TIMESTAMP NULL AFTER tracking_number;
  END IF;

  -- completed_at
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'completed_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN completed_at TIMESTAMP NULL AFTER shipped_at;
  END IF;
END$$

DELIMITER ;

CALL add_locoxatl_admin_columns();
DROP PROCEDURE IF EXISTS add_locoxatl_admin_columns;

-- 2. Audit history table
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

-- 3. Admin users table with scrypt hash storage
CREATE TABLE IF NOT EXISTS admin_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Database-backed admin sessions
CREATE TABLE IF NOT EXISTS admin_sessions (
  id VARCHAR(64) NOT NULL,
  admin_id BIGINT UNSIGNED NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_admin FOREIGN KEY (admin_id) REFERENCES admin_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
