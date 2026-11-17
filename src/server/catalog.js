const staticCatalog = require('../catalog.js');
const staticOptions = require('../options.js');
const { getPool, isConfigured } = require('./db');
const uploads = require('./uploads');

// Catalogue groups are the K-Pop artists/collections shown on the storefront, catalog_products
// are the designs inside each collection, and pricing_options are the studio add-on/clasp
// prices. All three live in MySQL so the shop can be curated without a deploy, but the bundled
// data in src/catalog.js and src/options.js stays authoritative whenever the database is
// unreachable, the tables are missing, or they are still empty.

const GROUP_FIELDS = 'id, slug, name, tagline, description, image_url, is_active, sort_order, created_at, updated_at';
const PRODUCT_FIELDS = 'id, group_id, slug, name, template_key, description, base_price, image_url, is_active, sort_order, created_at, updated_at';
const PRICING_FIELDS = 'id, category, option_key, label, price, is_active, sort_order, updated_at';

const MAX_NAME_LENGTH = 120;
const MAX_SLUG_LENGTH = 64;
const MAX_TAGLINE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_LABEL_LENGTH = 120;
const MAX_SORT_ORDER = 9999;
const MAX_PRICE = 100000000;
const PRICING_CATEGORIES = ['addon', 'clasp'];

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

function parseProductId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new CatalogError('invalid_id', 'Product id must be a positive integer.');
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

function parsePrice(value, fieldName = 'price') {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > MAX_PRICE) {
    throw new CatalogError('invalid_price', `${fieldName} must be a whole number between 0 and ${MAX_PRICE}.`);
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

/**
 * A product row stores a short slug ("cloud-heart"). The storefront addresses it as
 * `<group-slug>-<slug>`, which is the URL shape the bundled catalogue has always used.
 */
function mapProduct(row, group) {
  const groupSlug = group ? group.slug : '';
  return {
    id: Number(row.id),
    groupId: Number(row.group_id),
    groupSlug,
    groupName: group ? group.name : '',
    artistSlug: groupSlug,
    slug: groupSlug ? `${groupSlug}-${row.slug}` : row.slug,
    key: row.slug,
    name: row.name,
    templateKey: row.template_key,
    baseId: staticCatalog.baseIdForTemplate(row.template_key),
    description: row.description || '',
    price: Number(row.base_price) || 0,
    imageUrl: row.image_url || null,
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapPricingOption(row) {
  return {
    id: Number(row.id),
    category: row.category,
    key: row.option_key,
    label: row.label,
    price: Number(row.price) || 0,
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order) || 0,
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

function normalizeStaticProduct(product) {
  return {
    id: null,
    groupId: null,
    groupSlug: product.artistSlug,
    groupName: product.artistName || '',
    artistSlug: product.artistSlug,
    slug: product.slug,
    key: product.templateSlug,
    name: product.name,
    templateKey: product.templateKey || null,
    baseId: product.baseId,
    description: product.description || '',
    price: Number(product.price) || 0,
    imageUrl: null,
    isActive: true,
    sortOrder: 0,
    createdAt: null,
    updatedAt: null,
  };
}

function staticProducts() {
  return staticCatalog.products.map(normalizeStaticProduct);
}

function productsForGroups(groups) {
  return groups.flatMap((group) => staticCatalog.productsForGroup(group)).map(normalizeStaticProduct);
}

/** Bundled add-on/clasp prices in the same shape as pricing_options rows. */
function staticPricingTable() {
  const toOption = (item, category, index) => ({
    id: null,
    category,
    key: item.id,
    label: item.name,
    price: Number(item.price) || 0,
    isActive: true,
    sortOrder: index,
    updatedAt: null,
  });
  return {
    addons: staticOptions.addons.map((addon, index) => toOption(addon, 'addon', index)),
    clasps: staticOptions.clasps.map((clasp, index) => toOption(clasp, 'clasp', index)),
  };
}

function groupPricingOptions(options) {
  const addons = [];
  const clasps = [];
  for (const option of options) {
    if (option.category === 'clasp') clasps.push(option);
    else addons.push(option);
  }
  const byOrder = (a, b) => (a.sortOrder - b.sortOrder) || (a.key < b.key ? -1 : 1);
  return { addons: addons.sort(byOrder), clasps: clasps.sort(byOrder) };
}

function fallbackCatalog() {
  return {
    source: 'fallback',
    groups: staticGroups(),
    products: staticProducts(),
    options: staticPricingTable(),
  };
}

async function queryGroups({ activeOnly }) {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT ${GROUP_FIELDS} FROM catalog_groups ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order ASC, id ASC`,
  );
  return rows.map(mapGroup);
}

async function queryProductRows({ activeOnly = false, groupId = null } = {}) {
  const conditions = [];
  const params = [];
  if (activeOnly) conditions.push('is_active = 1');
  if (groupId) {
    conditions.push('group_id = ?');
    params.push(groupId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT ${PRODUCT_FIELDS} FROM catalog_products ${where} ORDER BY group_id ASC, sort_order ASC, id ASC`,
    params,
  );
  return rows;
}

async function queryPricingRows({ activeOnly = false } = {}) {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT ${PRICING_FIELDS} FROM pricing_options ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY category ASC, sort_order ASC, id ASC`,
  );
  return rows.map(mapPricingOption);
}

function mapProducts(rows, groups) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  return rows.map((row) => mapProduct(row, byId.get(Number(row.group_id)) || null));
}

/**
 * A database upgraded before migration 005 has no catalog_products table yet. Falling back to
 * the bundled designs keeps the storefront working until the migration runs.
 */
async function loadProductsForGroups(groups, { activeOnly }) {
  try {
    const rows = await queryProductRows({ activeOnly });
    return mapProducts(rows, groups);
  } catch (error) {
    if (!isMissingDatabase(error)) throw error;
    return productsForGroups(groups);
  }
}

async function loadPricingTable({ activeOnly }) {
  try {
    const rows = await queryPricingRows({ activeOnly });
    if (!rows.length) return staticPricingTable();
    return groupPricingOptions(rows);
  } catch (error) {
    if (!isMissingDatabase(error)) throw error;
    return staticPricingTable();
  }
}

/**
 * Loads the storefront catalogue. Falls back to src/catalog.js + src/options.js when MySQL is
 * unconfigured, a table is missing, the connection fails, or the tables are still empty.
 */
async function loadCatalog({ activeOnly = true } = {}) {
  if (!isConfigured()) return fallbackCatalog();

  try {
    const groups = await queryGroups({ activeOnly });
    if (!groups.length) return fallbackCatalog();
    const products = await loadProductsForGroups(groups, { activeOnly });
    const options = await loadPricingTable({ activeOnly: true });
    return { source: 'database', groups, products, options };
  } catch (error) {
    if (!isMissingDatabase(error)) throw error;
    return fallbackCatalog();
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

// ---------------------------------------------------------------------------
// Product designs
// ---------------------------------------------------------------------------

async function getProductById(id) {
  const productId = parseProductId(id);
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT ${PRODUCT_FIELDS} FROM catalog_products WHERE id = ? LIMIT 1`,
    [productId],
  );
  if (!rows.length) throw new CatalogError('product_not_found', 'Product design was not found.', 404);
  const [groups] = await pool.execute(
    `SELECT ${GROUP_FIELDS} FROM catalog_groups WHERE id = ? LIMIT 1`,
    [rows[0].group_id],
  );
  return mapProduct(rows[0], groups.length ? mapGroup(groups[0]) : null);
}

async function listProducts({ groupId = null } = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Catalog management requires the MySQL connection.', 503);
  }
  const groups = await queryGroups({ activeOnly: false });
  const filter = groupId === null || groupId === undefined || groupId === '' ? null : parseGroupId(groupId);
  const rows = await queryProductRows({ groupId: filter });
  return mapProducts(rows, groups);
}

/** Appends -2, -3, ... until the short slug is free inside the group. */
async function uniqueProductSlug(groupId, baseSlug, excludeId = null) {
  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT id, slug FROM catalog_products WHERE group_id = ?',
    [groupId],
  );
  const taken = new Set(rows
    .filter((row) => Number(row.id) !== Number(excludeId || 0))
    .map((row) => String(row.slug)));

  if (!taken.has(baseSlug)) return baseSlug;
  let counter = 2;
  let candidate = `${baseSlug.slice(0, MAX_SLUG_LENGTH - 4)}-${counter}`;
  while (taken.has(candidate)) {
    counter += 1;
    candidate = `${baseSlug.slice(0, MAX_SLUG_LENGTH - 4)}-${counter}`;
  }
  return candidate;
}

function normalizeImageInput(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const text = String(value).trim();
  if (text.startsWith('data:image/')) return text;
  if (uploads.isManagedUrl(text)) return text;
  throw new CatalogError('invalid_image', 'Image must be an uploaded file or an empty value.');
}

function normalizeProductInput(input = {}, { partial = false } = {}) {
  const values = input && typeof input === 'object' ? input : {};
  const result = {};

  if (!partial || values.name !== undefined) {
    const name = cleanText(values.name, MAX_NAME_LENGTH);
    if (name.length < 2) throw new CatalogError('invalid_name', 'Design name must be at least 2 characters.');
    result.name = name;
  }

  if (!partial || values.slug !== undefined) {
    const rawSlug = cleanText(values.slug, MAX_SLUG_LENGTH);
    const slug = slugify(rawSlug || result.name || '');
    if (!slug) throw new CatalogError('invalid_slug', 'Design slug must contain letters or numbers.');
    result.slug = slug;
  }

  if (!partial || values.templateKey !== undefined) {
    const templateKey = cleanText(values.templateKey, 64).toLowerCase();
    if (!staticCatalog.TEMPLATE_KEYS.includes(templateKey)) {
      throw new CatalogError('invalid_template', `templateKey must be one of: ${staticCatalog.TEMPLATE_KEYS.join(', ')}.`);
    }
    result.templateKey = templateKey;
  }

  if (!partial || values.basePrice !== undefined) {
    result.basePrice = parsePrice(values.basePrice, 'basePrice');
  }

  if (values.description !== undefined) result.description = cleanMultiline(values.description, MAX_DESCRIPTION_LENGTH);
  if (values.imageUrl !== undefined) result.imageUrl = normalizeImageInput(values.imageUrl);
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

async function nextProductSortOrder(groupId) {
  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM catalog_products WHERE group_id = ?',
    [groupId],
  );
  return Number(rows[0] && rows[0].next_order) || 0;
}

async function createProduct(input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Catalog management requires the MySQL connection.', 503);
  }

  const groupId = parseGroupId(input.groupId ?? input.group_id);
  const group = await getGroupById(groupId);
  const values = normalizeProductInput(input);
  const slug = await uniqueProductSlug(groupId, values.slug);
  const sortOrder = values.sortOrder === undefined ? await nextProductSortOrder(groupId) : values.sortOrder;

  let imageUrl = null;
  if (values.imageUrl && values.imageUrl.startsWith('data:image/')) {
    imageUrl = uploads.saveCatalogImage(`product-${groupId}-${slug}`, values.imageUrl);
  } else if (values.imageUrl) {
    imageUrl = values.imageUrl;
  }

  const pool = getPool();
  try {
    const [result] = await pool.execute(
      `INSERT INTO catalog_products
        (group_id, slug, name, template_key, description, base_price, image_url, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        groupId,
        slug,
        values.name,
        values.templateKey,
        values.description || '',
        values.basePrice,
        imageUrl,
        values.isActive === false ? 0 : 1,
        sortOrder,
      ],
    );
    return getProductById(result.insertId);
  } catch (error) {
    if (imageUrl) uploads.removeCatalogImage(imageUrl);
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new CatalogError('product_exists', `"${slug}" already exists in ${group.name}.`, 409);
    }
    throw error;
  }
}

async function updateProduct(id, input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Catalog management requires the MySQL connection.', 503);
  }

  const existing = await getProductById(id);
  const values = normalizeProductInput(input, { partial: true });

  const assignments = [];
  const params = [];
  if (values.name !== undefined) { assignments.push('name = ?'); params.push(values.name); }
  if (values.slug !== undefined && values.slug !== existing.key) {
    const slug = await uniqueProductSlug(existing.groupId, values.slug, existing.id);
    assignments.push('slug = ?');
    params.push(slug);
  }
  if (values.templateKey !== undefined) { assignments.push('template_key = ?'); params.push(values.templateKey); }
  if (values.description !== undefined) { assignments.push('description = ?'); params.push(values.description); }
  if (values.basePrice !== undefined) { assignments.push('base_price = ?'); params.push(values.basePrice); }
  if (values.isActive !== undefined) { assignments.push('is_active = ?'); params.push(values.isActive ? 1 : 0); }
  if (values.sortOrder !== undefined) { assignments.push('sort_order = ?'); params.push(values.sortOrder); }

  // Images are written before the row update so a failed upload never leaves a dangling URL.
  const incomingImage = values.imageUrl;
  const previousImage = existing.imageUrl;
  let storedImage;
  if (incomingImage !== undefined) {
    if (incomingImage === null) {
      assignments.push('image_url = NULL');
      storedImage = null;
    } else if (incomingImage.startsWith('data:image/')) {
      storedImage = uploads.saveCatalogImage(`product-${existing.groupId}-${existing.key}`, incomingImage);
      assignments.push('image_url = ?');
      params.push(storedImage);
    } else {
      storedImage = incomingImage;
      assignments.push('image_url = ?');
      params.push(storedImage);
    }
  }

  if (!assignments.length) {
    throw new CatalogError('no_changes', 'Provide at least one field to update.');
  }

  const pool = getPool();
  try {
    await pool.execute(
      `UPDATE catalog_products SET ${assignments.join(', ')} WHERE id = ?`,
      [...params, existing.id],
    );
  } catch (error) {
    if (storedImage && storedImage !== incomingImage) uploads.removeCatalogImage(storedImage);
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new CatalogError('product_exists', 'That slug is already used inside this collection.', 409);
    }
    throw error;
  }

  if (incomingImage !== undefined && previousImage && previousImage !== storedImage) {
    uploads.removeCatalogImage(previousImage);
  }
  return getProductById(existing.id);
}

// ---------------------------------------------------------------------------
// Studio pricing
// ---------------------------------------------------------------------------

async function listPricing() {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Pricing management requires the MySQL connection.', 503);
  }
  const rows = await queryPricingRows({ activeOnly: false });
  if (!rows.length) {
    // An installation that has not seeded yet still shows the bundled prices.
    const fallback = staticPricingTable();
    return [...fallback.addons, ...fallback.clasps];
  }
  return rows;
}

function normalizePricingUpdates(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const list = Array.isArray(source.options)
    ? source.options
    : Array.isArray(source.updates)
      ? source.updates
      : [source];

  const entries = [];
  for (const raw of list) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const key = cleanText(item.optionKey ?? item.key ?? item.option_key, 64).toLowerCase();
    if (!key) throw new CatalogError('invalid_option_key', 'Every update needs an optionKey.');

    const entry = { optionKey: key };
    if (item.price !== undefined) entry.price = parsePrice(item.price, `price for ${key}`);
    if (item.label !== undefined) {
      const label = cleanText(item.label, MAX_LABEL_LENGTH);
      if (label.length < 1) throw new CatalogError('invalid_label', `Label for ${key} cannot be empty.`);
      entry.label = label;
    }
    if (item.isActive !== undefined) {
      if (typeof item.isActive !== 'boolean') {
        throw new CatalogError('invalid_active', `isActive for ${key} must be a boolean.`);
      }
      entry.isActive = item.isActive;
    }
    if (entry.price === undefined && entry.label === undefined && entry.isActive === undefined) {
      throw new CatalogError('no_changes', `Nothing to update for ${key}.`);
    }
    entries.push(entry);
  }

  if (!entries.length) throw new CatalogError('no_changes', 'Provide at least one pricing option to update.');
  return entries;
}

async function updatePricing(payload) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Pricing management requires the MySQL connection.', 503);
  }

  const entries = normalizePricingUpdates(payload);
  const existing = new Map((await queryPricingRows({ activeOnly: false })).map((row) => [row.key, row]));

  const unknown = entries.filter((entry) => !existing.has(entry.optionKey));
  if (unknown.length) {
    throw new CatalogError(
      'unknown_option',
      `Unknown pricing option: ${unknown.map((entry) => entry.optionKey).join(', ')}.`,
      404,
    );
  }

  const pool = getPool();
  for (const entry of entries) {
    const assignments = [];
    const params = [];
    if (entry.price !== undefined) { assignments.push('price = ?'); params.push(entry.price); }
    if (entry.label !== undefined) { assignments.push('label = ?'); params.push(entry.label); }
    if (entry.isActive !== undefined) { assignments.push('is_active = ?'); params.push(entry.isActive ? 1 : 0); }
    await pool.execute(
      `UPDATE pricing_options SET ${assignments.join(', ')} WHERE option_key = ?`,
      [...params, entry.optionKey],
    );
  }

  return listPricing();
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

/** Seeds the bundled add-on and clasp prices the first time pricing_options is empty. */
async function seedPricingOptions() {
  if (!isConfigured()) return { seeded: 0, reason: 'not_configured' };

  const pool = getPool();
  try {
    const [rows] = await pool.execute('SELECT COUNT(*) AS total FROM pricing_options');
    if (Number(rows[0] && rows[0].total) > 0) return { seeded: 0, reason: 'already_seeded' };

    const table = staticPricingTable();
    let seeded = 0;
    for (const option of [...table.addons, ...table.clasps]) {
      await pool.execute(
        'INSERT IGNORE INTO pricing_options (category, option_key, label, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, ?)',
        [option.category, option.key, option.label, option.price, option.sortOrder],
      );
      seeded += 1;
    }
    return { seeded };
  } catch (error) {
    if (isMissingDatabase(error)) return { seeded: 0, reason: 'table_missing' };
    throw error;
  }
}

/**
 * Seeds the three standard designs for every collection the first time catalog_products is
 * empty, so the storefront keeps the URLs and prices it had before the table existed.
 */
async function seedCatalogProducts() {
  if (!isConfigured()) return { seeded: 0, reason: 'not_configured' };

  const pool = getPool();
  try {
    const [rows] = await pool.execute('SELECT COUNT(*) AS total FROM catalog_products');
    if (Number(rows[0] && rows[0].total) > 0) return { seeded: 0, reason: 'already_seeded' };

    const groups = await queryGroups({ activeOnly: false });
    if (!groups.length) return { seeded: 0, reason: 'no_groups' };

    let seeded = 0;
    for (const group of groups) {
      for (const [index, template] of staticCatalog.productTemplates.entries()) {
        await pool.execute(
          `INSERT IGNORE INTO catalog_products
            (group_id, slug, name, template_key, description, base_price, is_active, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
          [group.id, template.templateSlug, template.name, template.templateKey, template.description, template.price, index],
        );
        seeded += 1;
      }
    }
    return { seeded };
  } catch (error) {
    if (isMissingDatabase(error)) return { seeded: 0, reason: 'table_missing' };
    throw error;
  }
}

/** Boot-time helper: groups first, then the designs and prices that hang off them. */
async function seedStorefrontCatalog() {
  const groups = await seedCatalogGroups();
  const products = await seedCatalogProducts();
  const options = await seedPricingOptions();
  return { groups, products, options };
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
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  listPricing,
  updatePricing,
  seedCatalogGroups,
  seedCatalogProducts,
  seedPricingOptions,
  seedStorefrontCatalog,
  staticGroups,
  staticProducts,
  staticPricingTable,
  productsForGroups,
  groupPricingOptions,
  MAX_NAME_LENGTH,
  MAX_SLUG_LENGTH,
  MAX_TAGLINE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PRICE,
  PRICING_CATEGORIES,
};
