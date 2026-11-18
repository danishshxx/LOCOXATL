-- LOCOXATL — Migration 007: protect catalog products from group deletion
-- Replaces a cascading group/product foreign key with RESTRICT, preserving designs.
-- Execute after migration 005 and select the intended database first.

SET @product_group_fk_count := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'catalog_products'
    AND COLUMN_NAME = 'group_id'
    AND REFERENCED_TABLE_NAME = 'catalog_groups'
    AND REFERENCED_COLUMN_NAME = 'id'
);

SET @restrictive_fk_name := (
  SELECT kcu.CONSTRAINT_NAME
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
  JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
    ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
   AND rc.TABLE_NAME = kcu.TABLE_NAME
   AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
  WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
    AND kcu.TABLE_NAME = 'catalog_products'
    AND kcu.COLUMN_NAME = 'group_id'
    AND kcu.REFERENCED_TABLE_NAME = 'catalog_groups'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
    AND UPPER(rc.DELETE_RULE) = 'RESTRICT'
  LIMIT 1
);

SET @statement := IF(
  @product_group_fk_count = 0,
  'ALTER TABLE catalog_products ADD CONSTRAINT fk_catalog_product_group FOREIGN KEY (group_id) REFERENCES catalog_groups (id) ON DELETE RESTRICT',
  IF(
    @restrictive_fk_name IS NULL,
    'ALTER TABLE catalog_products ADD CONSTRAINT fk_catalog_product_group_restrict_007 FOREIGN KEY (group_id) REFERENCES catalog_groups (id) ON DELETE RESTRICT',
    'DO 0'
  )
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @drop_fk_clauses := (
  SELECT GROUP_CONCAT(
    CONCAT('DROP FOREIGN KEY `', REPLACE(kcu.CONSTRAINT_NAME, '`', '``'), '`')
    SEPARATOR ', '
  )
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
  JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
    ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
   AND rc.TABLE_NAME = kcu.TABLE_NAME
   AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
  WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
    AND kcu.TABLE_NAME = 'catalog_products'
    AND kcu.COLUMN_NAME = 'group_id'
    AND kcu.REFERENCED_TABLE_NAME = 'catalog_groups'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
    AND UPPER(rc.DELETE_RULE) <> 'RESTRICT'
);

SET @statement := IF(
  @drop_fk_clauses IS NULL,
  'DO 0',
  CONCAT('ALTER TABLE catalog_products ', @drop_fk_clauses)
);
PREPARE migration_stmt FROM @statement;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
