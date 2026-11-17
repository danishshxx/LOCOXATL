-- LOCOXATL — Additive Cashbook Migration
-- Creates only cashbook tables and standard categories. Existing order and customizer
-- records are never reset, dropped, or rewritten.
-- Execute only after selecting the intended database.

CREATE TABLE IF NOT EXISTS cashbook_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  entry_type ENUM('income', 'expense') NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cashbook_category (entry_type, name),
  KEY idx_cashbook_categories_active (entry_type, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cashbook_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entry_type ENUM('income', 'expense') NOT NULL,
  amount BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  description VARCHAR(255) NOT NULL,
  payment_method VARCHAR(80) NULL,
  notes TEXT NULL,
  transaction_date DATE NOT NULL,
  order_id BIGINT UNSIGNED NULL,
  source_key VARCHAR(120) NULL,
  admin_user_id BIGINT UNSIGNED NULL,
  supersedes_entry_id BIGINT UNSIGNED NULL,
  correction_note VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cashbook_source_key (source_key),
  UNIQUE KEY uq_cashbook_order_entry_type (order_id, entry_type),
  UNIQUE KEY uq_cashbook_supersedes_entry (supersedes_entry_id),
  KEY idx_cashbook_type_date (entry_type, transaction_date),
  KEY idx_cashbook_date (transaction_date),
  KEY idx_cashbook_category_date (category_id, transaction_date),
  CONSTRAINT fk_cashbook_category FOREIGN KEY (category_id) REFERENCES cashbook_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_cashbook_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
  CONSTRAINT fk_cashbook_admin FOREIGN KEY (admin_user_id) REFERENCES admin_users (id) ON DELETE SET NULL,
  CONSTRAINT fk_cashbook_supersedes FOREIGN KEY (supersedes_entry_id) REFERENCES cashbook_entries (id) ON DELETE RESTRICT,
  CONSTRAINT chk_cashbook_amount_positive CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO cashbook_categories (name, entry_type) VALUES
  ('Verified Order Income', 'income'),
  ('Material', 'expense'),
  ('Production', 'expense'),
  ('Packaging', 'expense'),
  ('Shipping', 'expense'),
  ('Marketing', 'expense'),
  ('Operational', 'expense'),
  ('Other', 'expense');
