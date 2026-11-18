const staticCatalog = require('../catalog.js');
const staticOptions = require('../options.js');
const { getPool, isConfigured, withTransaction } = require('./db');
const uploads = require('./uploads');

// Catalogue groups are the K-Pop artists/collections shown on the storefront, catalog_products
// are the designs inside each collection, and pricing_options are the studio add-on/clasp
// prices. All three live in MySQL so the shop can be curated without a deploy, but the bundled
// data in src/catalog.js and src/options.js stays authoritative whenever the database is
// unreachable, the tables are missing, or they are still empty.

const GROUP_FIELDS = 'id, slug, name, tagline, eyebrow, description, image_url, hero_image_url, cover_focal, hero_focal, is_active, sort_order, created_at, updated_at';
const PRODUCT_FIELDS = 'id, group_id, slug, name, template_key, description, base_price, image_url, is_active, sort_order, created_at, updated_at';
const MEMBER_FIELDS = 'id, group_id, slug, name, portrait_url, design_image_url, is_active, sort_order, created_at, updated_at';
const PRICING_FIELDS = 'id, category, option_key, label, price, is_active, sort_order, updated_at';

// One shared keychain product: a single global base silhouette plus one shared base price row.
// Member artwork (artist_members.design_image_url) is a design applied to this product, never a
// separate product record.
const BASE_MODELS = ['heart', 'star', 'bow'];
const BASE_MODEL_LABELS = { heart: 'Heart', star: 'Star', bow: 'Ribbon' };
const DEFAULT_BASE_MODEL = 'heart';
// The bundled studio opens on the heart silhouette at Rp45.000 (src/catalog.js productTemplates
// and studio.html), so that is the current default rather than an invented value.
const DEFAULT_BASE_PRICE = 45000;
const BASE_OPTION_KEY = 'keychain';
const BASE_OPTION_LABEL = 'Keychain base';

const MAX_NAME_LENGTH = 120;
const MAX_SLUG_LENGTH = 64;
const MAX_TAGLINE_LENGTH = 255;
const MAX_EYEBROW_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_LABEL_LENGTH = 120;
const MAX_SORT_ORDER = 9999;
const MAX_PRICE = 100000000;
const DEFAULT_FOCAL = '50% 50%';
// The focal crop is rendered straight into a CSS background-position, so only a keyword or a
// pair of percentages is ever accepted.
const FOCAL_PATTERN = /^(?:center|(?:100|[1-9]?\d)% (?:100|[1-9]?\d)%)$/;
const PRICING_CATEGORIES = ['base', 'addon', 'clasp'];

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
    eyebrow: row.eyebrow || '',
    description: row.description || '',
    imageUrl: row.image_url || null,
    heroImageUrl: row.hero_image_url || null,
    coverFocal: row.cover_focal || DEFAULT_FOCAL,
    heroFocal: row.hero_focal || DEFAULT_FOCAL,
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapMember(row) {
  return {
    id: Number(row.id),
    groupId: Number(row.group_id),
    slug: row.slug,
    name: row.name,
    portraitUrl: row.portrait_url || null,
    designImageUrl: row.design_image_url || null,
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
    eyebrow: '',
    description: artist.note,
    imageUrl: null,
    heroImageUrl: null,
    coverFocal: DEFAULT_FOCAL,
    heroFocal: DEFAULT_FOCAL,
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
function defaultBaseOption() {
  return {
    id: null,
    category: 'base',
    key: BASE_OPTION_KEY,
    label: BASE_OPTION_LABEL,
    price: DEFAULT_BASE_PRICE,
    isActive: true,
    sortOrder: 0,
    updatedAt: null,
  };
}

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
    base: defaultBaseOption(),
    addons: staticOptions.addons.map((addon, index) => toOption(addon, 'addon', index)),
    clasps: staticOptions.clasps.map((clasp, index) => toOption(clasp, 'clasp', index)),
  };
}

function groupPricingOptions(options) {
  const addons = [];
  const clasps = [];
  let base = null;
  for (const option of options) {
    if (option.category === 'base') {
      if (!base) base = option;
    } else if (option.category === 'clasp') clasps.push(option);
    else addons.push(option);
  }
  const byOrder = (a, b) => (a.sortOrder - b.sortOrder) || (a.key < b.key ? -1 : 1);
  return {
    base: base || defaultBaseOption(),
    addons: addons.sort(byOrder),
    clasps: clasps.sort(byOrder),
  };
}

/** The public product descriptor: one silhouette and one shared base price for every member. */
function productFromOptions(baseModel, options) {
  const model = BASE_MODELS.includes(baseModel) ? baseModel : DEFAULT_BASE_MODEL;
  const base = options && options.base ? options.base : defaultBaseOption();
  return {
    baseModel: model,
    baseLabel: BASE_MODEL_LABELS[model],
    basePrice: Number(base.price) || 0,
    baseKey: base.key || BASE_OPTION_KEY,
  };
}

function fallbackCatalog() {
  const options = staticPricingTable();
  return {
    source: 'fallback',
    groups: staticGroups(),
    members: [],
    products: staticProducts(),
    options,
    product: productFromOptions(DEFAULT_BASE_MODEL, options),
  };
}

async function queryGroups({ activeOnly }) {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT ${GROUP_FIELDS} FROM catalog_groups ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order ASC, id ASC`,
  );
  return rows.map(mapGroup);
}

async function queryMemberRows({ activeOnly = false } = {}) {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT ${MEMBER_FIELDS} FROM artist_members ${activeOnly ? 'WHERE is_active = 1 AND group_id IN (SELECT id FROM catalog_groups WHERE is_active = 1)' : ''} ORDER BY group_id ASC, sort_order ASC, id ASC`,
  );
  return rows;
}

/**
 * Members are optional: a storefront database that has not run migration 006 yet must keep
 * working, so a missing table simply yields no members instead of failing the catalogue.
 */
async function loadMembers({ activeOnly }) {
  try {
    return (await queryMemberRows({ activeOnly })).map(mapMember);
  } catch (error) {
    if (!isMissingDatabase(error)) throw error;
    return [];
  }
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
 * The global silhouette row. A database upgraded before migration 008 has no product_settings
 * table yet, so a missing table simply means "use the bundled default" instead of a failure.
 */
async function loadProductSettingsRow() {
  try {
    const [rows] = await getPool().execute(
      'SELECT id, base_model, updated_at FROM product_settings WHERE id = 1 LIMIT 1',
    );
    return rows[0] || null;
  } catch (error) {
    if (!isMissingDatabase(error)) throw error;
    return null;
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
    const members = await loadMembers({ activeOnly });
    const products = await loadProductsForGroups(groups, { activeOnly });
    const options = await loadPricingTable({ activeOnly: true });
    // The storefront needs to group members by slug, and the browser never sees ids it should not
    // need. Attaching groupSlug here keeps the client rendering logic free of id lookups.
    const slugById = new Map(groups.map((group) => [group.id, group.slug]));
    const membersWithGroup = members.map((member) => ({
      ...member,
      groupSlug: slugById.get(member.groupId) || null,
    }));
    const settingsRow = await loadProductSettingsRow();
    const product = productFromOptions(settingsRow ? settingsRow.base_model : DEFAULT_BASE_MODEL, options);
    return { source: 'database', groups, members: membersWithGroup, products, options, product };
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

function normalizeImageInput(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const text = String(value).trim();
  if (text.startsWith('data:image/')) return text;
  if (uploads.isManagedUrl(text)) return text;
  throw new CatalogError('invalid_image', 'Image must be an uploaded file or an empty value.');
}

function normalizeFocal(value, fieldName) {
  if (value === undefined) return undefined;
  const text = cleanText(value, 32).toLowerCase();
  if (!text) return DEFAULT_FOCAL;
  if (!FOCAL_PATTERN.test(text)) {
    throw new CatalogError('invalid_focal', `${fieldName} must be a percentage pair like "50% 50%".`);
  }
  return text;
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
  if (values.eyebrow !== undefined) result.eyebrow = cleanText(values.eyebrow, MAX_EYEBROW_LENGTH);
  if (values.description !== undefined) result.description = cleanMultiline(values.description, MAX_DESCRIPTION_LENGTH);
  if (values.coverFocal !== undefined) result.coverFocal = normalizeFocal(values.coverFocal, 'coverFocal');
  if (values.heroFocal !== undefined) result.heroFocal = normalizeFocal(values.heroFocal, 'heroFocal');
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
      `INSERT INTO catalog_groups
        (slug, name, tagline, eyebrow, description, cover_focal, hero_focal, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.slug,
        values.name,
        values.tagline || '',
        values.eyebrow || '',
        values.description || '',
        values.coverFocal || DEFAULT_FOCAL,
        values.heroFocal || DEFAULT_FOCAL,
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
  if (values.eyebrow !== undefined) { assignments.push('eyebrow = ?'); params.push(values.eyebrow); }
  if (values.description !== undefined) { assignments.push('description = ?'); params.push(values.description); }
  if (values.coverFocal !== undefined) { assignments.push('cover_focal = ?'); params.push(values.coverFocal); }
  if (values.heroFocal !== undefined) { assignments.push('hero_focal = ?'); params.push(values.heroFocal); }
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
 * Stores an uploaded image for a group field and returns the refreshed row. `kind` picks which of
 * the two images is written: "cover" is the collection card, "hero" is the member-selection hero.
 * The previous file is deleted only after the new URL is committed, so a failed update never
 * leaves the group pointing at a missing image.
 */
const GROUP_IMAGE_COLUMNS = { cover: 'image_url', hero: 'hero_image_url' };

function groupImageColumn(kind) {
  const column = GROUP_IMAGE_COLUMNS[kind];
  if (!column) throw new CatalogError('invalid_image_kind', 'Image kind must be "cover" or "hero".');
  return column;
}

function groupImageValue(group, kind) {
  return kind === 'hero' ? group.heroImageUrl : group.imageUrl;
}

async function setGroupImage(id, dataUrl, kind = 'cover') {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Catalog management requires the MySQL connection.', 503);
  }

  const column = groupImageColumn(kind);
  const groupId = parseGroupId(id);
  const group = await getGroupById(groupId);
  const previous = groupImageValue(group, kind);
  // The cover keeps the plain group slug so existing uploads keep their names; the hero gets a
  // suffix so the two images never collide in storage.
  const assetName = kind === 'hero' ? `${group.slug}-hero` : group.slug;
  const imageUrl = await uploads.saveCatalogImage(assetName, dataUrl);

  try {
    await getPool().execute(`UPDATE catalog_groups SET ${column} = ? WHERE id = ?`, [imageUrl, groupId]);
  } catch (error) {
    await uploads.removeCatalogImage(imageUrl);
    throw error;
  }

  if (previous && previous !== imageUrl) await uploads.removeCatalogImage(previous);
  return getGroupById(groupId);
}

async function clearGroupImage(id, kind = 'cover') {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Catalog management requires the MySQL connection.', 503);
  }

  const column = groupImageColumn(kind);
  const groupId = parseGroupId(id);
  const group = await getGroupById(groupId);
  const previous = groupImageValue(group, kind);
  if (!previous) return group;

  await getPool().execute(`UPDATE catalog_groups SET ${column} = NULL WHERE id = ?`, [groupId]);
  await uploads.removeCatalogImage(previous);
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
    imageUrl = await uploads.saveCatalogImage(`product-${groupId}-${slug}`, values.imageUrl);
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
    if (imageUrl) await uploads.removeCatalogImage(imageUrl);
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
      storedImage = await uploads.saveCatalogImage(`product-${existing.groupId}-${existing.key}`, incomingImage);
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
    if (storedImage && storedImage !== incomingImage) await uploads.removeCatalogImage(storedImage);
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new CatalogError('product_exists', 'That slug is already used inside this collection.', 409);
    }
    throw error;
  }

  if (incomingImage !== undefined && previousImage && previousImage !== storedImage) {
    await uploads.removeCatalogImage(previousImage);
  }
  return getProductById(existing.id);
}

// ---------------------------------------------------------------------------
// Group members
// ---------------------------------------------------------------------------

function parseMemberId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new CatalogError('invalid_id', 'Member id must be a positive integer.');
  }
  return id;
}

async function getMemberById(id) {
  const memberId = parseMemberId(id);
  const [rows] = await getPool().execute(
    `SELECT ${MEMBER_FIELDS} FROM artist_members WHERE id = ? LIMIT 1`,
    [memberId],
  );
  if (!rows.length) throw new CatalogError('member_not_found', 'Group member was not found.', 404);
  return mapMember(rows[0]);
}

async function listMembers({ groupId = null } = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Member management requires the MySQL connection.', 503);
  }
  const filter = groupId === null || groupId === undefined || groupId === '' ? null : parseGroupId(groupId);
  const rows = await queryMemberRows({ activeOnly: false });
  const members = rows.map(mapMember);
  return filter ? members.filter((member) => member.groupId === filter) : members;
}

/** Appends -2, -3, ... until the short slug is free inside the group. */
async function uniqueMemberSlug(groupId, baseSlug, excludeId = null) {
  const [rows] = await getPool().execute(
    'SELECT id, slug FROM artist_members WHERE group_id = ?',
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

function normalizeMemberInput(input = {}, { partial = false } = {}) {
  const values = input && typeof input === 'object' ? input : {};
  const result = {};

  if (!partial || values.name !== undefined) {
    const name = cleanText(values.name, MAX_NAME_LENGTH);
    if (name.length < 2) throw new CatalogError('invalid_name', 'Member name must be at least 2 characters.');
    result.name = name;
  }

  if (!partial || values.slug !== undefined) {
    const rawSlug = cleanText(values.slug, MAX_SLUG_LENGTH);
    const slug = slugify(rawSlug || result.name || '');
    if (!slug) throw new CatalogError('invalid_slug', 'Member slug must contain letters or numbers.');
    result.slug = slug;
  }

  if (values.portraitUrl !== undefined) result.portraitUrl = normalizeImageInput(values.portraitUrl);
  if (values.designImageUrl !== undefined) result.designImageUrl = normalizeImageInput(values.designImageUrl);
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

async function nextMemberSortOrder(groupId) {
  const [rows] = await getPool().execute(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM artist_members WHERE group_id = ?',
    [groupId],
  );
  return Number(rows[0] && rows[0].next_order) || 0;
}

async function createMember(input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Member management requires the MySQL connection.', 503);
  }

  const groupId = parseGroupId(input.groupId ?? input.group_id);
  const group = await getGroupById(groupId);
  const values = normalizeMemberInput(input);
  const slug = await uniqueMemberSlug(groupId, values.slug);
  const sortOrder = values.sortOrder === undefined ? await nextMemberSortOrder(groupId) : values.sortOrder;

  let portraitUrl = null;
  if (values.portraitUrl && values.portraitUrl.startsWith('data:image/')) {
    portraitUrl = await uploads.saveCatalogImage(`member-${group.slug}-${slug}`, values.portraitUrl);
  } else if (values.portraitUrl) {
    portraitUrl = values.portraitUrl;
  }

  let designImageUrl = null;
  if (values.designImageUrl && values.designImageUrl.startsWith('data:image/')) {
    designImageUrl = await uploads.saveCatalogImage(`member-design-${group.slug}-${slug}`, values.designImageUrl);
  } else if (values.designImageUrl) {
    designImageUrl = values.designImageUrl;
  }

  try {
    const [result] = await getPool().execute(
      `INSERT INTO artist_members
        (group_id, slug, name, portrait_url, design_image_url, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [groupId, slug, values.name, portraitUrl, designImageUrl, values.isActive === false ? 0 : 1, sortOrder],
    );
    return getMemberById(result.insertId);
  } catch (error) {
    if (portraitUrl) await uploads.removeCatalogImage(portraitUrl);
    if (designImageUrl) await uploads.removeCatalogImage(designImageUrl);
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new CatalogError('member_exists', `"${slug}" already exists in ${group.name}.`, 409);
    }
    throw error;
  }
}

async function updateMember(id, input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Member management requires the MySQL connection.', 503);
  }

  const existing = await getMemberById(id);
  const values = normalizeMemberInput(input, { partial: true });

  const assignments = [];
  const params = [];
  if (values.name !== undefined) { assignments.push('name = ?'); params.push(values.name); }
  if (values.slug !== undefined && values.slug !== existing.slug) {
    const slug = await uniqueMemberSlug(existing.groupId, values.slug, existing.id);
    assignments.push('slug = ?');
    params.push(slug);
  }
  if (values.isActive !== undefined) { assignments.push('is_active = ?'); params.push(values.isActive ? 1 : 0); }
  if (values.sortOrder !== undefined) { assignments.push('sort_order = ?'); params.push(values.sortOrder); }

  // Portraits are written before the row update so a failed upload never leaves a dangling URL.
  const incomingImage = values.portraitUrl;
  const previousImage = existing.portraitUrl;
  let storedImage;
  if (incomingImage !== undefined) {
    if (incomingImage === null) {
      assignments.push('portrait_url = NULL');
      storedImage = null;
    } else if (incomingImage.startsWith('data:image/')) {
      storedImage = await uploads.saveCatalogImage(`member-${existing.groupId}-${existing.slug}`, incomingImage);
      assignments.push('portrait_url = ?');
      params.push(storedImage);
    } else {
      storedImage = incomingImage;
      assignments.push('portrait_url = ?');
      params.push(storedImage);
    }
  }

  // Keychain artwork follows the same write-before-update rule as the portrait.
  const incomingDesign = values.designImageUrl;
  const previousDesign = existing.designImageUrl;
  let storedDesign;
  if (incomingDesign !== undefined) {
    if (incomingDesign === null) {
      assignments.push('design_image_url = NULL');
      storedDesign = null;
    } else if (incomingDesign.startsWith('data:image/')) {
      storedDesign = await uploads.saveCatalogImage(
        `member-design-${existing.groupId}-${existing.slug}`,
        incomingDesign,
      );
      assignments.push('design_image_url = ?');
      params.push(storedDesign);
    } else {
      storedDesign = incomingDesign;
      assignments.push('design_image_url = ?');
      params.push(storedDesign);
    }
  }

  if (!assignments.length) {
    throw new CatalogError('no_changes', 'Provide at least one field to update.');
  }

  try {
    await getPool().execute(
      `UPDATE artist_members SET ${assignments.join(', ')} WHERE id = ?`,
      [...params, existing.id],
    );
  } catch (error) {
    if (storedImage && storedImage !== incomingImage) await uploads.removeCatalogImage(storedImage);
    if (storedDesign && storedDesign !== incomingDesign) await uploads.removeCatalogImage(storedDesign);
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new CatalogError('member_exists', 'That slug is already used inside this group.', 409);
    }
    throw error;
  }

  if (incomingImage !== undefined && previousImage && previousImage !== storedImage) {
    await uploads.removeCatalogImage(previousImage);
  }
  if (incomingDesign !== undefined && previousDesign && previousDesign !== storedDesign) {
    await uploads.removeCatalogImage(previousDesign);
  }
  return getMemberById(existing.id);
}

async function deleteMember(id) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Member management requires the MySQL connection.', 503);
  }

  const existing = await getMemberById(id);
  await getPool().execute('DELETE FROM artist_members WHERE id = ?', [existing.id]);
  if (existing.portraitUrl) await uploads.removeCatalogImage(existing.portraitUrl);
  if (existing.designImageUrl) await uploads.removeCatalogImage(existing.designImageUrl);
  return { deleted: true, id: existing.id };
}

/**
 * Deletes a group and everything that belongs to it. catalog_products and artist_members both
 * cascade on the foreign key, so the rows go together; the stored images are removed afterwards
 * because the filesystem/object store has no foreign key.
 */
async function deleteGroup(id) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Catalog management requires the MySQL connection.', 503);
  }

  const groupId = parseGroupId(id);
  const group = await getGroupById(groupId);
  const members = await queryMemberRows({ activeOnly: false });
  const products = await queryProductRows({ groupId });

  // catalog_products is retired, but the table and its RESTRICT foreign key are preserved. An
  // explicit admin deletion removes only that group's legacy rows in the same transaction; the
  // table itself and every historical order stay untouched.
  try {
    await withTransaction(async (connection) => {
      await connection.execute('DELETE FROM catalog_products WHERE group_id = ?', [groupId]);
      await connection.execute('DELETE FROM catalog_groups WHERE id = ?', [groupId]);
    });
  } catch (error) {
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      throw new CatalogError(
        'group_in_use',
        'This group is referenced by another record; deactivate it instead of deleting it.',
        409,
      );
    }
    throw error;
  }

  for (const image of [group.imageUrl, group.heroImageUrl]) {
    if (image) await uploads.removeCatalogImage(image);
  }
  for (const member of members.filter((row) => Number(row.group_id) === groupId)) {
    if (member.portrait_url) await uploads.removeCatalogImage(member.portrait_url);
    if (member.design_image_url) await uploads.removeCatalogImage(member.design_image_url);
  }
  for (const product of products) {
    if (product.image_url) await uploads.removeCatalogImage(product.image_url);
  }

  return { deleted: true, id: groupId };
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

// ---------------------------------------------------------------------------
// Single shared product settings (global silhouette + base price)
// ---------------------------------------------------------------------------

function normalizeBaseModel(value) {
  const model = cleanText(value, 20).toLowerCase();
  if (!BASE_MODELS.includes(model)) {
    throw new CatalogError('invalid_base_model', `baseModel must be one of: ${BASE_MODELS.join(', ')}.`);
  }
  return model;
}

async function getProductSettings() {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Product settings require the MySQL connection.', 503);
  }

  const settingsRow = await loadProductSettingsRow();
  const baseModel = settingsRow && BASE_MODELS.includes(settingsRow.base_model)
    ? settingsRow.base_model
    : DEFAULT_BASE_MODEL;

  const rows = await queryPricingRows({ activeOnly: false });
  const baseOption = rows.find((option) => option.category === 'base') || null;
  const basePrice = baseOption ? baseOption.price : DEFAULT_BASE_PRICE;

  return {
    baseModel,
    baseLabel: BASE_MODEL_LABELS[baseModel],
    basePrice,
    baseKey: baseOption ? baseOption.key : BASE_OPTION_KEY,
    baseLabelText: baseOption ? baseOption.label : BASE_OPTION_LABEL,
    baseIsActive: baseOption ? baseOption.isActive : true,
    baseModels: BASE_MODELS.map((model) => ({ key: model, label: BASE_MODEL_LABELS[model] })),
    updatedAt: settingsRow ? settingsRow.updated_at || null : null,
  };
}

/**
 * Updates the one global silhouette and/or the shared base price. Only the fields present in the
 * payload are written; an operator's existing price is never replaced unless they send a new one.
 */
async function updateProductSettings(input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Product settings require the MySQL connection.', 503);
  }

  const values = input && typeof input === 'object' ? input : {};
  const hasModel = values.baseModel !== undefined;
  const hasPrice = values.basePrice !== undefined;
  const hasLabel = values.label !== undefined;

  if (!hasModel && !hasPrice && !hasLabel) {
    throw new CatalogError('no_changes', 'Provide a baseModel or basePrice to update.');
  }

  const baseModel = hasModel ? normalizeBaseModel(values.baseModel) : null;
  const basePrice = hasPrice ? parsePrice(values.basePrice, 'basePrice') : null;
  const label = hasLabel ? cleanText(values.label, MAX_LABEL_LENGTH) : null;
  if (hasLabel && !label) throw new CatalogError('invalid_label', 'Base label cannot be empty.');

  const pool = getPool();

  if (baseModel) {
    // Avoid VALUES() in ON DUPLICATE KEY (deprecated on MySQL 8.4); update, then insert if absent.
    await pool.execute('UPDATE product_settings SET base_model = ? WHERE id = 1', [baseModel]);
    const [settingsRows] = await pool.execute('SELECT id FROM product_settings WHERE id = 1 LIMIT 1');
    if (!settingsRows.length) {
      await pool.execute('INSERT INTO product_settings (id, base_model) VALUES (1, ?)', [baseModel]);
    }
  }

  if (hasPrice || hasLabel) {
    const [rows] = await pool.execute(
      "SELECT id, option_key FROM pricing_options WHERE category = 'base' OR option_key = ? LIMIT 1",
      [BASE_OPTION_KEY],
    );
    if (rows.length) {
      const assignments = [];
      const params = [];
      if (hasPrice) { assignments.push('price = ?'); params.push(basePrice); }
      if (hasLabel) { assignments.push('label = ?'); params.push(label); }
      assignments.push("category = 'base'");
      await pool.execute(
        `UPDATE pricing_options SET ${assignments.join(', ')} WHERE id = ?`,
        [...params, rows[0].id],
      );
    } else {
      await pool.execute(
        `INSERT INTO pricing_options (category, option_key, label, price, is_active, sort_order)
         VALUES ('base', ?, ?, ?, 1, 0)`,
        [BASE_OPTION_KEY, label || BASE_OPTION_LABEL, hasPrice ? basePrice : DEFAULT_BASE_PRICE],
      );
    }
  }

  return getProductSettings();
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

/**
 * Seeds the bundled prices (the single shared base price plus add-ons and clasps) with INSERT
 * IGNORE, so re-running never duplicates a row and never overwrites an operator's price. The base
 * price is derived from the existing catalogue (the default heart design) where available.
 */
function seedBasePrice(pool) {
  return pool
    .execute(
      "SELECT base_price FROM catalog_products WHERE template_key = 'acrylic-keychain' ORDER BY id ASC LIMIT 1",
    )
    .then(([rows]) => (rows.length && rows[0].base_price != null ? Number(rows[0].base_price) : DEFAULT_BASE_PRICE))
    .catch((error) => {
      if (isMissingDatabase(error)) return DEFAULT_BASE_PRICE;
      throw error;
    });
}

async function seedPricingOptions() {
  if (!isConfigured()) return { seeded: 0, reason: 'not_configured' };

  const pool = getPool();
  try {
    const basePrice = await seedBasePrice(pool);
    const base = { ...defaultBaseOption(), price: basePrice };
    const table = { ...staticPricingTable(), base };

    let seeded = 0;
    for (const option of [table.base, ...table.addons, ...table.clasps]) {
      const [result] = await pool.execute(
        'INSERT IGNORE INTO pricing_options (category, option_key, label, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, ?)',
        [option.category, option.key, option.label, option.price, option.sortOrder],
      );
      if (result && Number(result.affectedRows) > 0) seeded += 1;
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
  deleteGroup,
  setGroupImage,
  clearGroupImage,
  listMembers,
  getMemberById,
  createMember,
  updateMember,
  deleteMember,
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  listPricing,
  updatePricing,
  getProductSettings,
  updateProductSettings,
  seedCatalogGroups,
  seedCatalogProducts,
  seedPricingOptions,
  seedStorefrontCatalog,
  staticGroups,
  staticProducts,
  staticPricingTable,
  productsForGroups,
  groupPricingOptions,
  productFromOptions,
  DEFAULT_BASE_MODEL,
  DEFAULT_BASE_PRICE,
  BASE_MODELS,
  MAX_NAME_LENGTH,
  MAX_SLUG_LENGTH,
  MAX_TAGLINE_LENGTH,
  MAX_EYEBROW_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PRICE,
  DEFAULT_FOCAL,
  PRICING_CATEGORIES,
};
