const staticCatalog = require('../catalog.js');
const { getPool, isConfigured } = require('./db');
const uploads = require('./uploads');

// Catalogue groups are the K-Pop artists/collections shown on the storefront. They live in
// MySQL so the shop can be curated without a deploy, but the static catalogue in
// src/catalog.js stays authoritative whenever the database is unreachable.

const GROUP_FIELDS = 'id, slug, name, tagline, description, image_url, is_active, sort_order, created_at, updated_at';
const MAX_NAME_LENGTH = 120;
const MAX_SLUG_LENGTH = 64;
const MAX_TAGLINE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_SORT_ORDER = 9999;

class CatalogError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const MISSING_DATABASE_CODES = new Set([
  'DB_NOT_CONFIGURED',
  'DB_DRIVER_MISSING',
  'ER_NO_SUCH_TABLE',
  'ER_BAD_DB_ERROR',
  'ER_ACCESS_DENIED_ERROR',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'PROTOCOL_CONNECTION_LOST',
]);

function isMissingDatabase(error) {
  return Boolean(error && MISSING_DATABASE_CODES.has(error.code));
}

function slugify(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

function cleanText(value, maxLength) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanMultiline(value, maxLength) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim().slice(0, maxLength);
}

function parseGroupId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new CatalogError('invalid_id', 'Group id must be a positive integer.');
  }
  return id;
}

function parseSortOrder(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || Math.abs(number) > MAX_SORT_ORDER) {
    throw new CatalogError('invalid_sort_order', `sortOrder must be an integer between -${MAX_SORT_ORDER} and ${MAX_SORT_ORDER}.`);
  }
  return number;
}

function mapGroup(row) {
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    tagline: row.tagline || '',
    description: row.description || '',
    imageUrl: row.image_url || null,
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

/** The static catalogue expressed in the same shape as a database group. */
function staticGroups() {
  return staticCatalog.artists.map((artist, index) => ({
    id: null,
    slug: artist.slug,
    name: artist.name,
    tagline: artist.fandom,
    description: artist.note,
    imageUrl: null,
    isActive: true,
    sortOrder: index,
    createdAt: null,
    updatedAt: null,
  }));
}

function staticProducts() {
  return staticCatalog.products;
}

function productsForGroups(groups) {
  return groups.flatMap((group) => staticCatalog.productsForGroup(group));
}

async function queryGroups({ activeOnly }) {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT ${GROUP_FIELDS} FROM catalog_groups ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order ASC, id ASC`,
  );
  return rows.map(mapGroup);
}

/**
 * Loads the storefront catalogue. Falls back to src/catalog.js when MySQL is unconfigured,
 * the table is missing, the connection fails, or the table is still empty.
 */
async function loadCatalog({ activeOnly = true } = {}) {
  if (!isConfigured()) {
    return { source: 'fallback', groups: staticGroups(), products: staticProducts() };
  }

  try {
    const groups = await queryGroups({ activeOnly });
    if (!groups.length) {
      return { source: 'fallback', groups: staticGroups(), products: staticProducts() };
    }
    return { source: 'database', groups, products: productsForGroups(groups) };
  } catch (error) {
    if (!isMissingDatabase(error)) throw error;
    return { source: 'fallback', groups: staticGroups(), products: staticProducts() };
  }
}

async function getGroupById(id) {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT ${GROUP_FIELDS} FROM catalog_groups WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) throw new CatalogError('group_not_found', 'Catalog group was not found.', 404);
  return mapGroup(rows[0]);
}

async function listAllGroups() {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Catalog management requires the MySQL connection.', 503);
  }
  return queryGroups({ activeOnly: false });
}

function normalizeGroupInput(input = {}, { partial = false } = {}) {
  const values = input && typeof input === 'object' ? input : {};
  const result = {};

  if (!partial || values.name !== undefined) {
    const name = cleanText(values.name, MAX_NAME_LENGTH);
    if (name.length < 2) throw new CatalogError('invalid_name', 'Group name must be at least 2 characters.');
    result.name = name;
  }

  if (!partial || values.slug !== undefined) {
    const rawSlug = cleanText(values.slug, MAX_SLUG_LENGTH);
    const slug = slugify(rawSlug || result.name || '');
    if (!slug) throw new CatalogError('invalid_slug', 'Group slug must contain letters or numbers.');
    result.slug = slug;
  }

  if (values.tagline !== undefined) result.tagline = cleanText(values.tagline, MAX_TAGLINE_LENGTH);
  if (values.description !== undefined) result.description = cleanMultiline(values.description, MAX_DESCRIPTION_LENGTH);
  if (values.sortOrder !== undefined && values.sortOrder !== null && values.sortOrder !== '') {
    result.sortOrder = parseSortOrder(values.sortOrder);
  }
  if (values.isActive !== undefined) {
    if (typeof values.isActive !== 'boolean') {
      throw new CatalogError('invalid_active', 'isActive must be a boolean.');
    }
    result.isActive = values.isActive;
  }

  return result;
}

async function nextSortOrder() {
  const pool = getPool();
  const [rows] = await pool.execute('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM catalog_groups');
  return Number(rows[0] && rows[0].next_order) || 0;
}

async function createGroup(input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Catalog management requires the MySQL connection.', 503);
  }

  const values = normalizeGroupInput(input);
  const sortOrder = values.sortOrder === undefined ? await nextSortOrder() : values.sortOrder;
  const pool = getPool();

  try {
    const [result] = await pool.execute(
      'INSERT INTO catalog_groups (slug, name, tagline, description, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [
        values.slug,
        values.name,
        values.tagline || '',
        values.description || '',
        values.isActive === false ? 0 : 1,
        sortOrder,
      ],
    );
    return getGroupById(result.insertId);
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new CatalogError('group_exists', 'A catalog group with that slug already exists.', 409);
    }
    throw error;
  }
}

async function updateGroup(id, input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Catalog management requires the MySQL connection.', 503);
  }

  const groupId = parseGroupId(id);
  const values = normalizeGroupInput(input, { partial: true });

  const assignments = [];
  const params = [];
  if (values.name !== undefined) { assignments.push('name = ?'); params.push(values.name); }
  if (values.slug !== undefined) { assignments.push('slug = ?'); params.push(values.slug); }
  if (values.tagline !== undefined) { assignments.push('tagline = ?'); params.push(values.tagline); }
  if (values.description !== undefined) { assignments.push('description = ?'); params.push(values.description); }
  if (values.isActive !== undefined) { assignments.push('is_active = ?'); params.push(values.isActive ? 1 : 0); }
  if (values.sortOrder !== undefined) { assignments.push('sort_order = ?'); params.push(values.sortOrder); }

  if (!assignments.length) {
    throw new CatalogError('no_changes', 'Provide at least one field to update.');
  }

  const pool = getPool();
  try {
    const [result] = await pool.execute(
      `UPDATE catalog_groups SET ${assignments.join(', ')} WHERE id = ?`,
      [...params, groupId],
    );
    if (!result.affectedRows) {
      // A no-op update reports 0 affected rows; confirm the row still exists.
      await getGroupById(groupId);
    }
    return getGroupById(groupId);
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new CatalogError('group_exists', 'A catalog group with that slug already exists.', 409);
    }
    throw error;
  }
}

/**
 * Stores an uploaded card image for the group and returns the refreshed row. The previous file
 * is deleted only after the new one is committed, so a failed update never leaves the group
 * pointing at a missing image.
 */
async function setGroupImage(id, dataUrl) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Catalog management requires the MySQL connection.', 503);
  }

  const groupId = parseGroupId(id);
  const group = await getGroupById(groupId);
  const imageUrl = uploads.saveCatalogImage(group.slug, dataUrl);

  try {
    await getPool().execute('UPDATE catalog_groups SET image_url = ? WHERE id = ?', [imageUrl, groupId]);
  } catch (error) {
    uploads.removeCatalogImage(imageUrl);
    throw error;
  }

  if (group.imageUrl && group.imageUrl !== imageUrl) uploads.removeCatalogImage(group.imageUrl);
  return getGroupById(groupId);
}

async function clearGroupImage(id) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Catalog management requires the MySQL connection.', 503);
  }

  const groupId = parseGroupId(id);
  const group = await getGroupById(groupId);
  if (!group.imageUrl) return group;

  await getPool().execute('UPDATE catalog_groups SET image_url = NULL WHERE id = ?', [groupId]);
  uploads.removeCatalogImage(group.imageUrl);
  return getGroupById(groupId);
}

/**
 * Seeds the six static artists the first time the table is empty, so existing storefront
 * links and historical orders keep resolving after the migration.
 */
async function seedCatalogGroups() {
  if (!isConfigured()) return { seeded: 0, reason: 'not_configured' };

  const pool = getPool();
  try {
    const [rows] = await pool.execute('SELECT COUNT(*) AS total FROM catalog_groups');
    if (Number(rows[0] && rows[0].total) > 0) return { seeded: 0, reason: 'already_seeded' };

    let seeded = 0;
    for (const [index, artist] of staticCatalog.artists.entries()) {
      await pool.execute(
        'INSERT IGNORE INTO catalog_groups (slug, name, tagline, description, is_active, sort_order) VALUES (?, ?, ?, ?, 1, ?)',
        [artist.slug, artist.name, artist.fandom, artist.note, index],
      );
      seeded += 1;
    }
    return { seeded };
  } catch (error) {
    if (isMissingDatabase(error)) return { seeded: 0, reason: 'table_missing' };
    throw error;
  }
}

module.exports = {
  CatalogError,
  slugify,
  loadCatalog,
  listAllGroups,
  getGroupById,
  createGroup,
  updateGroup,
  setGroupImage,
  clearGroupImage,
  seedCatalogGroups,
  staticGroups,
  staticProducts,
  productsForGroups,
  MAX_NAME_LENGTH,
  MAX_SLUG_LENGTH,
  MAX_TAGLINE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
};
