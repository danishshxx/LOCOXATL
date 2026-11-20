const staticCatalog = require('../catalog.js');
const staticOptions = require('../options.js');
const { getPool, isConfigured, withTransaction } = require('./db');
const uploads = require('./uploads');

// Catalogue groups are the K-Pop artists/collections shown on the storefront, catalog_products
// are the designs inside each collection, and pricing_options are the studio add-on/clasp
// prices. All three live in MySQL so the shop can be curated without a deploy, but the bundled
// data in src/catalog.js and src/options.js stays authoritative whenever the database is
// unreachable, the tables are missing, or they are still empty.

const GROUP_FIELDS = 'id, slug, name, tagline, eyebrow, description, image_url, hero_image_url, cover_focal, hero_focal, is_active, sort_order, created_at, updated_at, versions_json, has_versions, is_custom_design';
const PRODUCT_FIELDS = 'id, group_id, slug, name, template_key, description, base_price, price_override, image_url, is_active, sort_order, created_at, updated_at, version_key';
const MEMBER_FIELDS = 'id, group_id, slug, name, portrait_url, design_image_url, price_override, is_active, sort_order, created_at, updated_at, version_key';
const PRICING_FIELDS = 'id, category, option_key, label, price, is_active, sort_order, updated_at';
const BUNDLE_FIELDS = 'id, group_id, slug, name, description, bundle_price, free_addon_quota, allowed_addon_keys, image_url, is_active, sort_order, created_at, updated_at';
const CATEGORY_FIELDS = 'id, slug, name, selection_mode, is_required, counts_toward_bundle_free, bundle_included, sort_order, is_active, created_at, updated_at';

// The two product versions the storefront offers as cards before the member list.
const VERSION_KEYS = ['yellow', 'pink'];
const VERSION_LABELS = { yellow: 'Yellow Version', pink: 'Pink Version' };
const DEFAULT_VERSION = 'yellow';

// One shared keychain: a single base price row that every design uses. The designs themselves are
// catalog_products rows and artist_members artwork, so an order resolves a design by its id or
// slug and never by a legacy silhouette key.
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

// A blank or null override means "use the global base price", so it is stored as NULL.
function parsePriceOverride(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > MAX_PRICE) {
    throw new CatalogError('invalid_price_override', `priceOverride must be a whole number between 1 and ${MAX_PRICE}, or empty to clear.`);
  }
  return number;
}

function parseVersionKey(value) {
  const key = cleanText(value, 32).toLowerCase();
  return VERSION_KEYS.includes(key) ? key : DEFAULT_VERSION;
}

function normalizeVersionInput(value) {
  const key = cleanText(value, 32).toLowerCase();
  if (!VERSION_KEYS.includes(key)) {
    throw new CatalogError('invalid_version', `version must be one of: ${VERSION_KEYS.join(', ')}.`);
  }
  return key;
}

function safeFocal(value) {
  const text = cleanText(value, 32).toLowerCase();
  return FOCAL_PATTERN.test(text) ? text : DEFAULT_FOCAL;
}

/** Yellow/Pink card copy stored per group. Missing keys fall back to empty labels. */
function parseVersions(value) {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      source = null;
    }
  }
  const raw = source && typeof source === 'object' ? source : {};
  const result = {};
  for (const key of VERSION_KEYS) {
    const entry = raw[key] && typeof raw[key] === 'object' ? raw[key] : {};
    result[key] = {
      key,
      label: VERSION_LABELS[key],
      title: cleanText(entry.title, MAX_NAME_LENGTH),
      tagline: cleanText(entry.tagline, MAX_TAGLINE_LENGTH),
      coverImageUrl: entry.coverImageUrl ? String(entry.coverImageUrl) : null,
      coverFocal: safeFocal(entry.coverFocal),
    };
  }
  return result;
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
    versions: parseVersions(row.versions_json),
    hasVersions: row.has_versions === undefined || row.has_versions === null ? true : Boolean(Number(row.has_versions)),
    isCustomDesign: Boolean(Number(row.is_custom_design || 0)),
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
    priceOverride: row.price_override == null ? null : Number(row.price_override),
    versionKey: parseVersionKey(row.version_key),
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
    versionKey: parseVersionKey(row.version_key),
    description: row.description || '',
    price: Number(row.base_price) || 0,
    priceOverride: row.price_override == null ? null : Number(row.price_override),
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

function mapOptionCategory(row) {
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    selectionMode: row.selection_mode === 'single' ? 'single' : 'multiple',
    isRequired: Boolean(row.is_required),
    countsTowardBundleFree: Boolean(row.counts_toward_bundle_free),
    bundleIncluded: Boolean(row.bundle_included),
    sortOrder: Number(row.sort_order) || 0,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

/** The bundled category list, in the same shape as option_categories rows. */
function staticOptionCategories() {
  return staticOptions.optionCategories.map((category, index) => ({
    id: null,
    slug: category.slug,
    name: category.name,
    selectionMode: category.selectionMode === 'single' ? 'single' : 'multiple',
    isRequired: Boolean(category.isRequired),
    countsTowardBundleFree: category.countsTowardBundleFree !== false,
    bundleIncluded: category.bundleIncluded === true,
    sortOrder: Number.isInteger(category.sortOrder) ? category.sortOrder : index,
    isActive: true,
    createdAt: null,
    updatedAt: null,
  }));
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
    versions: parseVersions(null),
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
    versionKey: DEFAULT_VERSION,
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
  const addons = staticOptions.addons.map((addon, index) => toOption(addon, 'addon', index));
  const clasps = staticOptions.clasps.map((clasp, index) => toOption(clasp, 'clasp', index));
  const straps = (staticOptions.straps || []).map((strap, index) => toOption(strap, 'silicone-strap', index));
  return {
    base: defaultBaseOption(),
    addons,
    clasps,
    items: [...addons, ...clasps, ...straps],
  };
}

function groupPricingOptions(options) {
  const buckets = new Map();
  let base = null;
  for (const option of options) {
    if (option.category === 'base') {
      if (!base) base = option;
      continue;
    }
    const category = String(option.category || 'addon');
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push(option);
  }
  const byOrder = (a, b) => (a.sortOrder - b.sortOrder) || (a.key < b.key ? -1 : 1);
  // `items` is the category-agnostic list the pricing engine reads; addons/clasps stay for the
  // older callers that only know those two names.
  const items = [];
  for (const list of buckets.values()) items.push(...list);
  return {
    base: base || defaultBaseOption(),
    addons: (buckets.get('addon') || []).slice().sort(byOrder),
    clasps: (buckets.get('clasp') || []).slice().sort(byOrder),
    items: items.sort(byOrder),
  };
}

/** The public product descriptor: the shared base price every design uses. */
function productFromOptions(options) {
  const base = options && options.base ? options.base : defaultBaseOption();
  return {
    basePrice: Number(base.price) || 0,
    baseKey: base.key || BASE_OPTION_KEY,
    baseLabel: base.label || BASE_OPTION_LABEL,
  };
}

function fallbackCatalog() {
  const options = staticPricingTable();
  return {
    source: 'fallback',
    groups: staticGroups(),
    members: [],
    products: staticProducts(),
    bundles: [],
    options,
    optionCategories: staticOptionCategories(),
    paymentMethods: staticPaymentMethods(),
    product: productFromOptions(options),
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
 * The shared settings row. A database upgraded before migration 008 has no product_settings
 * table yet, so a missing table simply means "use the bundled default" instead of a failure.
 */
async function loadProductSettingsRow() {
  try {
    const [rows] = await getPool().execute(
      'SELECT id, updated_at FROM product_settings WHERE id = 1 LIMIT 1',
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
    // One global base price, with an optional per-design override on top. Resolving it here means
    // the storefront, the admin list and the order API all read the same effective number.
    const globalBasePrice = Number(options.base && options.base.price) || DEFAULT_BASE_PRICE;
    const effectivePrice = (override) => (override == null ? globalBasePrice : Number(override));
    const pricedProducts = products.map((item) => ({
      ...item,
      price: effectivePrice(item.priceOverride),
    }));
    const optionCategories = await loadOptionCategories({ activeOnly: true });
    const bundles = await loadBundles({ activeOnly, groups });
    // The storefront needs to group members by slug, and the browser never sees ids it should not
    // need. Attaching groupSlug here keeps the client rendering logic free of id lookups.
    const slugById = new Map(groups.map((group) => [group.id, group.slug]));
    const membersWithGroup = members.map((member) => ({
      ...member,
      groupSlug: slugById.get(member.groupId) || null,
      price: effectivePrice(member.priceOverride),
    }));
    const settingsRow = await loadProductSettingsRow();
    const product = productFromOptions(options);
    // Payment methods are ancillary: if that table cannot be read, the bundled defaults keep the
    // storefront and the order API usable instead of failing the whole catalogue.
    let paymentMethods = staticPaymentMethods();
    try {
      const allPaymentMethods = await listPaymentMethods({ activeOnly: false });
      paymentMethods = allPaymentMethods.some((method) => method.id === null)
        ? allPaymentMethods
        : allPaymentMethods.filter((method) => method.isActive);
    } catch { /* keep the defaults */ }
    return { source: 'database', groups, members: membersWithGroup, products: pricedProducts, bundles, options, optionCategories, paymentMethods, product };
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
  if (values.versions !== undefined) result.versions = values.versions;
  if (values.hasVersions !== undefined) {
    if (typeof values.hasVersions !== 'boolean') {
      throw new CatalogError('invalid_has_versions', 'hasVersions must be a boolean.');
    }
    result.hasVersions = values.hasVersions;
  }
  if (values.isCustomDesign !== undefined) {
    if (typeof values.isCustomDesign !== 'boolean') {
      throw new CatalogError('invalid_custom_design', 'isCustomDesign must be a boolean.');
    }
    result.isCustomDesign = values.isCustomDesign;
    // A custom design group has no Yellow/Pink step, so the version picker defaults off unless
    // the caller explicitly asked for both.
    if (values.isCustomDesign && values.hasVersions === undefined) result.hasVersions = false;
  }

  return result;
}

/**
 * Yellow/Pink card settings. A cover sent as a data URL goes through the same upload path the
 * other group images use, and the previous file is removed once the new URL is committed.
 */
async function resolveGroupVersions(groupSlug, incoming, previous) {
  const source = incoming && typeof incoming === 'object' ? incoming : {};
  const prior = previous && typeof previous === 'object' ? previous : {};
  const result = {};

  for (const key of VERSION_KEYS) {
    const next = source[key] && typeof source[key] === 'object' ? source[key] : {};
    const before = prior[key] && typeof prior[key] === 'object' ? prior[key] : {};
    let cover = next.coverImageUrl !== undefined ? next.coverImageUrl : (before.coverImageUrl || null);

    if (typeof cover === 'string' && cover.startsWith('data:image/')) {
      const stored = await uploads.saveCatalogImage(`group-${groupSlug}-${key}`, cover);
      if (before.coverImageUrl && before.coverImageUrl !== stored) {
        await uploads.removeCatalogImage(before.coverImageUrl);
      }
      cover = stored;
    }
    if (cover === '') cover = null;

    result[key] = {
      title: cleanText(next.title !== undefined ? next.title : before.title, MAX_NAME_LENGTH),
      tagline: cleanText(next.tagline !== undefined ? next.tagline : before.tagline, MAX_TAGLINE_LENGTH),
      coverImageUrl: cover,
      coverFocal: safeFocal(next.coverFocal !== undefined ? next.coverFocal : before.coverFocal),
    };
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
  const versions = values.versions === undefined
    ? null
    : await resolveGroupVersions(values.slug, values.versions, null);

  try {
    const [result] = await pool.execute(
      `INSERT INTO catalog_groups
        (slug, name, tagline, eyebrow, description, cover_focal, hero_focal, is_active, sort_order, versions_json, has_versions, is_custom_design)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        versions ? JSON.stringify(versions) : null,
        values.hasVersions === false ? 0 : 1,
        values.isCustomDesign ? 1 : 0,
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
  const existing = await getGroupById(groupId);
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
  if (values.hasVersions !== undefined) { assignments.push('has_versions = ?'); params.push(values.hasVersions ? 1 : 0); }
  if (values.isCustomDesign !== undefined) { assignments.push('is_custom_design = ?'); params.push(values.isCustomDesign ? 1 : 0); }
  if (values.versions !== undefined) {
    const versions = await resolveGroupVersions(existing.slug, values.versions, existing.versions);
    assignments.push('versions_json = ?');
    params.push(JSON.stringify(versions));
  }

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
// Bundle packages ("paketan")
//
// A bundle is a fixed price that covers up to `free_addon_quota` eligible add-ons for Rp 0.
// `group_id` is null for a bundle available in every collection, and `allowed_addon_keys` is
// null when any active add-on may be taken. A database that has not run migration 009 simply
// has no bundles, so the storefront keeps its plain per-add-on pricing.
// ---------------------------------------------------------------------------

const MAX_BUNDLE_QUOTA = 20;

function parseAllowedAddonKeys(value) {
  if (value === null || value === undefined || value === '') return null;
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  const keys = [...new Set(list.map((key) => cleanText(key, 64).toLowerCase()).filter(Boolean))];
  return keys.length ? keys : null;
}

function mapBundle(row, group) {
  return {
    id: Number(row.id),
    groupId: row.group_id === null || row.group_id === undefined ? null : Number(row.group_id),
    groupSlug: group ? group.slug : null,
    groupName: group ? group.name : null,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    price: Number(row.bundle_price) || 0,
    freeAddonQuota: Number(row.free_addon_quota) || 0,
    allowedAddonKeys: parseAllowedAddonKeys(row.allowed_addon_keys),
    imageUrl: row.image_url || null,
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapBundles(rows, groups) {
  const byId = new Map((groups || []).map((group) => [Number(group.id), group]));
  return rows.map((row) => mapBundle(row, row.group_id == null ? null : (byId.get(Number(row.group_id)) || null)));
}

async function queryBundleRows({ activeOnly = false } = {}) {
  const [rows] = await getPool().execute(
    `SELECT ${BUNDLE_FIELDS} FROM catalog_bundles ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order ASC, id ASC`,
  );
  return rows;
}

/**
 * Bundles are optional in the same way members are: a database upgraded before migration 009
 * has no table yet, which means "no bundles" rather than a broken catalogue.
 */
async function loadBundles({ activeOnly, groups }) {
  try {
    return mapBundles(await queryBundleRows({ activeOnly }), groups);
  } catch (error) {
    if (!isMissingDatabase(error)) throw error;
    return [];
  }
}

async function getBundleById(id) {
  const bundleId = Number(id);
  if (!Number.isSafeInteger(bundleId) || bundleId < 1) {
    throw new CatalogError('invalid_id', 'Bundle id must be a positive integer.');
  }
  const [rows] = await getPool().execute(
    `SELECT ${BUNDLE_FIELDS} FROM catalog_bundles WHERE id = ? LIMIT 1`,
    [bundleId],
  );
  if (!rows.length) throw new CatalogError('bundle_not_found', 'Bundle package was not found.', 404);

  let group = null;
  if (rows[0].group_id != null) {
    try {
      group = await getGroupById(rows[0].group_id);
    } catch {
      group = null;
    }
  }
  return mapBundle(rows[0], group);
}

async function listBundles() {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Bundle management requires the MySQL connection.', 503);
  }
  const groups = await queryGroups({ activeOnly: false });
  return mapBundles(await queryBundleRows({ activeOnly: false }), groups);
}

function normalizeBundleInput(input = {}, { partial = false } = {}) {
  const values = input && typeof input === 'object' ? input : {};
  const result = {};

  if (!partial || values.name !== undefined) {
    const name = cleanText(values.name, MAX_NAME_LENGTH);
    if (name.length < 2) throw new CatalogError('invalid_name', 'Bundle name must be at least 2 characters.');
    result.name = name;
  }

  if (!partial || values.slug !== undefined) {
    const rawSlug = cleanText(values.slug, MAX_SLUG_LENGTH);
    const slug = slugify(rawSlug || result.name || '');
    if (!slug) throw new CatalogError('invalid_slug', 'Bundle slug must contain letters or numbers.');
    result.slug = slug;
  }

  if (!partial || values.bundlePrice !== undefined) {
    result.bundlePrice = parsePrice(values.bundlePrice, 'bundlePrice');
  }

  if (values.freeAddonQuota !== undefined && values.freeAddonQuota !== null && values.freeAddonQuota !== '') {
    const quota = Number(values.freeAddonQuota);
    if (!Number.isInteger(quota) || quota < 0 || quota > MAX_BUNDLE_QUOTA) {
      throw new CatalogError('invalid_quota', `freeAddonQuota must be a whole number between 0 and ${MAX_BUNDLE_QUOTA}.`);
    }
    result.freeAddonQuota = quota;
  }

  if (values.allowedAddonKeys !== undefined) result.allowedAddonKeys = parseAllowedAddonKeys(values.allowedAddonKeys);
  if (values.description !== undefined) result.description = cleanMultiline(values.description, MAX_DESCRIPTION_LENGTH);
  if (values.imageUrl !== undefined) result.imageUrl = normalizeImageInput(values.imageUrl);
  if (values.groupId !== undefined) {
    result.groupId = values.groupId === null || values.groupId === '' ? null : parseGroupId(values.groupId);
  }
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

async function nextBundleSortOrder() {
  const [rows] = await getPool().execute('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM catalog_bundles');
  return Number(rows[0] && rows[0].next_order) || 0;
}

async function createBundle(input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Bundle management requires the MySQL connection.', 503);
  }

  const values = normalizeBundleInput(input);
  if (values.groupId) await getGroupById(values.groupId);
  const sortOrder = values.sortOrder === undefined ? await nextBundleSortOrder() : values.sortOrder;

  let imageUrl = null;
  if (values.imageUrl && values.imageUrl.startsWith('data:image/')) {
    imageUrl = await uploads.saveCatalogImage(`bundle-${values.slug}`, values.imageUrl);
  } else if (values.imageUrl) {
    imageUrl = values.imageUrl;
  }

  try {
    const [result] = await getPool().execute(
      `INSERT INTO catalog_bundles
        (group_id, slug, name, description, bundle_price, free_addon_quota, allowed_addon_keys, image_url, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.groupId || null,
        values.slug,
        values.name,
        values.description || '',
        values.bundlePrice,
        values.freeAddonQuota === undefined ? 1 : values.freeAddonQuota,
        values.allowedAddonKeys ? JSON.stringify(values.allowedAddonKeys) : null,
        imageUrl,
        values.isActive === false ? 0 : 1,
        sortOrder,
      ],
    );
    return getBundleById(result.insertId);
  } catch (error) {
    if (imageUrl) await uploads.removeCatalogImage(imageUrl);
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new CatalogError('bundle_exists', 'A bundle with that slug already exists.', 409);
    }
    throw error;
  }
}

async function updateBundle(id, input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Bundle management requires the MySQL connection.', 503);
  }

  const existing = await getBundleById(id);
  const values = normalizeBundleInput(input, { partial: true });

  const assignments = [];
  const params = [];
  if (values.name !== undefined) { assignments.push('name = ?'); params.push(values.name); }
  if (values.slug !== undefined) { assignments.push('slug = ?'); params.push(values.slug); }
  if (values.description !== undefined) { assignments.push('description = ?'); params.push(values.description); }
  if (values.bundlePrice !== undefined) { assignments.push('bundle_price = ?'); params.push(values.bundlePrice); }
  if (values.freeAddonQuota !== undefined) { assignments.push('free_addon_quota = ?'); params.push(values.freeAddonQuota); }
  if (values.allowedAddonKeys !== undefined) {
    assignments.push('allowed_addon_keys = ?');
    params.push(values.allowedAddonKeys ? JSON.stringify(values.allowedAddonKeys) : null);
  }
  if (values.groupId !== undefined) {
    if (values.groupId) await getGroupById(values.groupId);
    assignments.push('group_id = ?');
    params.push(values.groupId);
  }
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
      storedImage = await uploads.saveCatalogImage(`bundle-${existing.id}`, incomingImage);
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

  try {
    await getPool().execute(
      `UPDATE catalog_bundles SET ${assignments.join(', ')} WHERE id = ?`,
      [...params, existing.id],
    );
  } catch (error) {
    if (storedImage && storedImage !== incomingImage) await uploads.removeCatalogImage(storedImage);
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new CatalogError('bundle_exists', 'That slug is already used by another bundle.', 409);
    }
    throw error;
  }

  if (incomingImage !== undefined && previousImage && previousImage !== storedImage) {
    await uploads.removeCatalogImage(previousImage);
  }
  return getBundleById(existing.id);
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

  if (values.priceOverride !== undefined) {
    result.priceOverride = parsePriceOverride(values.priceOverride);
  }

  if (values.description !== undefined) result.description = cleanMultiline(values.description, MAX_DESCRIPTION_LENGTH);
  if (values.imageUrl !== undefined) result.imageUrl = normalizeImageInput(values.imageUrl);
  if (values.versionKey !== undefined) result.versionKey = normalizeVersionInput(values.versionKey);
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
        (group_id, slug, name, template_key, description, base_price, price_override, image_url, is_active, sort_order, version_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        groupId,
        slug,
        values.name,
        values.templateKey,
        values.description || '',
        values.basePrice,
        values.priceOverride === undefined ? null : values.priceOverride,
        imageUrl,
        values.isActive === false ? 0 : 1,
        sortOrder,
        values.versionKey || DEFAULT_VERSION,
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
  if (values.priceOverride !== undefined) { assignments.push('price_override = ?'); params.push(values.priceOverride); }
  if (values.versionKey !== undefined) { assignments.push('version_key = ?'); params.push(values.versionKey); }
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
  if (values.priceOverride !== undefined) result.priceOverride = parsePriceOverride(values.priceOverride);
  if (values.versionKey !== undefined) result.versionKey = normalizeVersionInput(values.versionKey);
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
        (group_id, slug, name, portrait_url, design_image_url, price_override, is_active, sort_order, version_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        groupId,
        slug,
        values.name,
        portraitUrl,
        designImageUrl,
        values.priceOverride === undefined ? null : values.priceOverride,
        values.isActive === false ? 0 : 1,
        sortOrder,
        values.versionKey || DEFAULT_VERSION,
      ],
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
  if (values.versionKey !== undefined) { assignments.push('version_key = ?'); params.push(values.versionKey); }
  if (values.priceOverride !== undefined) { assignments.push('price_override = ?'); params.push(values.priceOverride); }
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
// Option categories and their items
//
// pricing_options.category stores a slug from option_categories, so the dashboard can add a
// whole new choice group (a strap, a charm) without a deploy. `selection_mode` decides single
// versus multiple and `counts_toward_bundle_free` decides whether a bundle quota may cover it.
// ---------------------------------------------------------------------------

const LEGACY_CATEGORY_SLUGS = ['addon', 'clasp'];

function parseCategoryId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new CatalogError('invalid_id', 'Category id must be a positive integer.');
  }
  return id;
}

function normalizeSelectionMode(value, fallback = 'multiple') {
  const mode = cleanText(value, 16).toLowerCase();
  if (!mode) return fallback;
  if (mode !== 'single' && mode !== 'multiple') {
    throw new CatalogError('invalid_selection_mode', 'selectionMode must be "single" or "multiple".');
  }
  return mode;
}

function normalizeCategorySlug(value) {
  const slug = slugify(cleanText(value, 32));
  if (!slug) throw new CatalogError('invalid_slug', 'Category slug must contain letters or numbers.');
  return slug;
}

function normalizeOptionCategoryInput(input = {}, { partial = false } = {}) {
  const values = input && typeof input === 'object' ? input : {};
  const result = {};

  if (!partial || values.name !== undefined) {
    const name = cleanText(values.name, MAX_NAME_LENGTH);
    if (name.length < 2) throw new CatalogError('invalid_name', 'Category name must be at least 2 characters.');
    result.name = name;
  }
  if (!partial || values.slug !== undefined) {
    const raw = values.slug === undefined || values.slug === '' ? (result.name || '') : values.slug;
    result.slug = normalizeCategorySlug(raw);
  }
  if (!partial || values.selectionMode !== undefined) {
    result.selectionMode = normalizeSelectionMode(values.selectionMode);
  }
  for (const field of ['isRequired', 'countsTowardBundleFree', 'bundleIncluded', 'isActive']) {
    if (values[field] === undefined) continue;
    if (typeof values[field] !== 'boolean') {
      throw new CatalogError('invalid_flag', `${field} must be a boolean.`);
    }
    result[field] = values[field];
  }
  if (values.sortOrder !== undefined && values.sortOrder !== null && values.sortOrder !== '') {
    result.sortOrder = parseSortOrder(values.sortOrder);
  }
  return result;
}

function slugFromLabel(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function normalizePricingItemInput(input = {}, { partial = false } = {}) {
  const values = input && typeof input === 'object' ? input : {};
  const result = {};

  if (!partial || values.category !== undefined) {
    result.category = normalizeCategorySlug(values.category);
  }
  if (!partial || values.optionKey !== undefined || values.key !== undefined) {
    const rawKey = cleanText(values.optionKey ?? values.key, 64).toLowerCase();
    // The dashboard leaves the key blank and expects it derived from the label.
    const key = rawKey || slugFromLabel(values.label);
    if (!key) throw new CatalogError('invalid_option_key', 'optionKey is required.');
    result.optionKey = key;
  }
  if (!partial || values.label !== undefined) {
    const label = cleanText(values.label, MAX_LABEL_LENGTH);
    if (!label) throw new CatalogError('invalid_label', 'Option label cannot be empty.');
    result.label = label;
  }
  if (!partial || values.price !== undefined) {
    result.price = parsePrice(values.price, 'price');
  }
  if (values.isActive !== undefined) {
    if (typeof values.isActive !== 'boolean') {
      throw new CatalogError('invalid_active', 'isActive must be a boolean.');
    }
    result.isActive = values.isActive;
  }
  if (values.sortOrder !== undefined && values.sortOrder !== null && values.sortOrder !== '') {
    result.sortOrder = parseSortOrder(values.sortOrder);
  }
  return result;
}

async function queryCategoryRows({ activeOnly = false } = {}) {
  const [rows] = await getPool().execute(
    `SELECT ${CATEGORY_FIELDS} FROM option_categories ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order ASC, id ASC`,
  );
  return rows;
}

/**
 * Categories are optional in the same way members and bundles are: a database upgraded before
 * migration 010 keeps working with the two bundled categories.
 */
async function loadOptionCategories({ activeOnly }) {
  try {
    const rows = await queryCategoryRows({ activeOnly });
    return rows.length ? rows.map(mapOptionCategory) : staticOptionCategories();
  } catch (error) {
    if (!isMissingDatabase(error)) throw error;
    return staticOptionCategories();
  }
}

async function listOptionCategories() {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Option categories require the MySQL connection.', 503);
  }
  return (await queryCategoryRows({ activeOnly: false })).map(mapOptionCategory);
}

async function getOptionCategoryById(id) {
  const categoryId = parseCategoryId(id);
  const [rows] = await getPool().execute(
    `SELECT ${CATEGORY_FIELDS} FROM option_categories WHERE id = ? LIMIT 1`,
    [categoryId],
  );
  if (!rows.length) throw new CatalogError('category_not_found', 'Option category was not found.', 404);
  return mapOptionCategory(rows[0]);
}

async function createOptionCategory(input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Option categories require the MySQL connection.', 503);
  }

  const values = normalizeOptionCategoryInput(input);
  const pool = getPool();
  let sortOrder = values.sortOrder;
  if (sortOrder === undefined) {
    const [rows] = await pool.execute('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM option_categories');
    sortOrder = Number(rows[0] && rows[0].next_order) || 0;
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO option_categories
        (slug, name, selection_mode, is_required, counts_toward_bundle_free, bundle_included, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.slug,
        values.name,
        values.selectionMode || 'multiple',
        values.isRequired === true ? 1 : 0,
        values.countsTowardBundleFree === false ? 0 : 1,
        values.bundleIncluded === true ? 1 : 0,
        sortOrder,
        values.isActive === false ? 0 : 1,
      ],
    );
    return getOptionCategoryById(result.insertId);
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new CatalogError('category_exists', 'A category with that slug already exists.', 409);
    }
    throw error;
  }
}

async function updateOptionCategory(id, input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Option categories require the MySQL connection.', 503);
  }

  const existing = await getOptionCategoryById(id);
  const values = normalizeOptionCategoryInput(input, { partial: true });

  const assignments = [];
  const params = [];
  if (values.name !== undefined) { assignments.push('name = ?'); params.push(values.name); }
  if (values.slug !== undefined) { assignments.push('slug = ?'); params.push(values.slug); }
  if (values.selectionMode !== undefined) { assignments.push('selection_mode = ?'); params.push(values.selectionMode); }
  if (values.isRequired !== undefined) { assignments.push('is_required = ?'); params.push(values.isRequired ? 1 : 0); }
  if (values.countsTowardBundleFree !== undefined) {
    assignments.push('counts_toward_bundle_free = ?');
    params.push(values.countsTowardBundleFree ? 1 : 0);
  }
  if (values.bundleIncluded !== undefined) {
    assignments.push('bundle_included = ?');
    params.push(values.bundleIncluded ? 1 : 0);
  }
  if (values.isActive !== undefined) { assignments.push('is_active = ?'); params.push(values.isActive ? 1 : 0); }
  if (values.sortOrder !== undefined) { assignments.push('sort_order = ?'); params.push(values.sortOrder); }

  if (!assignments.length) {
    throw new CatalogError('no_changes', 'Provide at least one field to update.');
  }

  try {
    await getPool().execute(
      `UPDATE option_categories SET ${assignments.join(', ')} WHERE id = ?`,
      [...params, existing.id],
    );
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new CatalogError('category_exists', 'That slug is already used by another category.', 409);
    }
    throw error;
  }
  return getOptionCategoryById(existing.id);
}

async function assertCategoryExists(slug) {
  const normalized = normalizeCategorySlug(slug);
  try {
    const [rows] = await getPool().execute(
      'SELECT id FROM option_categories WHERE slug = ? LIMIT 1',
      [normalized],
    );
    if (!rows.length) {
      throw new CatalogError('unknown_category', `Unknown option category: ${normalized}.`, 404);
    }
  } catch (error) {
    if (!isMissingDatabase(error)) throw error;
    // A database without migration 010 still accepts the two categories it has always had.
    if (!LEGACY_CATEGORY_SLUGS.includes(normalized)) {
      throw new CatalogError('unknown_category', `Unknown option category: ${normalized}.`, 404);
    }
  }
  return normalized;
}

async function getPricingOptionById(id) {
  const optionId = Number(id);
  if (!Number.isSafeInteger(optionId) || optionId < 1) {
    throw new CatalogError('invalid_id', 'Option id must be a positive integer.');
  }
  const [rows] = await getPool().execute(
    `SELECT ${PRICING_FIELDS} FROM pricing_options WHERE id = ? LIMIT 1`,
    [optionId],
  );
  if (!rows.length) throw new CatalogError('option_not_found', 'Pricing option was not found.', 404);
  return mapPricingOption(rows[0]);
}

async function createPricingOption(input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Pricing options require the MySQL connection.', 503);
  }

  const values = normalizePricingItemInput(input);
  const category = await assertCategoryExists(values.category);
  const pool = getPool();
  let sortOrder = values.sortOrder;
  if (sortOrder === undefined) {
    const [rows] = await pool.execute(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM pricing_options WHERE category = ?',
      [category],
    );
    sortOrder = Number(rows[0] && rows[0].next_order) || 0;
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO pricing_options (category, option_key, label, price, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [category, values.optionKey, values.label, values.price, values.isActive === false ? 0 : 1, sortOrder],
    );
    return getPricingOptionById(result.insertId);
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new CatalogError('option_exists', 'An option with that key already exists.', 409);
    }
    throw error;
  }
}

async function updatePricingOption(id, input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Pricing options require the MySQL connection.', 503);
  }

  const existing = await getPricingOptionById(id);
  const values = normalizePricingItemInput(input, { partial: true });
  if (values.category !== undefined) values.category = await assertCategoryExists(values.category);

  const assignments = [];
  const params = [];
  if (values.category !== undefined) { assignments.push('category = ?'); params.push(values.category); }
  if (values.optionKey !== undefined) { assignments.push('option_key = ?'); params.push(values.optionKey); }
  if (values.label !== undefined) { assignments.push('label = ?'); params.push(values.label); }
  if (values.price !== undefined) { assignments.push('price = ?'); params.push(values.price); }
  if (values.isActive !== undefined) { assignments.push('is_active = ?'); params.push(values.isActive ? 1 : 0); }
  if (values.sortOrder !== undefined) { assignments.push('sort_order = ?'); params.push(values.sortOrder); }

  if (!assignments.length) {
    throw new CatalogError('no_changes', 'Provide at least one field to update.');
  }

  try {
    await getPool().execute(
      `UPDATE pricing_options SET ${assignments.join(', ')} WHERE id = ?`,
      [...params, existing.id],
    );
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new CatalogError('option_exists', 'That option key is already used.', 409);
    }
    throw error;
  }
  return getPricingOptionById(existing.id);
}

async function deletePricingOption(id) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Pricing options require the MySQL connection.', 503);
  }
  const existing = await getPricingOptionById(id);
  await getPool().execute('DELETE FROM pricing_options WHERE id = ?', [existing.id]);
  return { deleted: true, id: existing.id };
}

// ---------------------------------------------------------------------------
// Single shared product settings (base price)
// ---------------------------------------------------------------------------

async function getProductSettings() {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Product settings require the MySQL connection.', 503);
  }

  const settingsRow = await loadProductSettingsRow();
  const rows = await queryPricingRows({ activeOnly: false });
  const baseOption = rows.find((option) => option.category === 'base') || null;
  const basePrice = baseOption ? baseOption.price : DEFAULT_BASE_PRICE;

  return {
    basePrice,
    baseKey: baseOption ? baseOption.key : BASE_OPTION_KEY,
    baseLabelText: baseOption ? baseOption.label : BASE_OPTION_LABEL,
    baseIsActive: baseOption ? baseOption.isActive : true,
    updatedAt: settingsRow ? settingsRow.updated_at || null : null,
  };
}

/**
 * Updates the shared base price. Only the fields present in the payload are written; an operator's
 * existing price is never replaced unless they send a new one.
 */
async function updateProductSettings(input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Product settings require the MySQL connection.', 503);
  }

  const values = input && typeof input === 'object' ? input : {};
  const hasPrice = values.basePrice !== undefined;
  const hasLabel = values.label !== undefined;

  if (!hasPrice && !hasLabel) {
    throw new CatalogError('no_changes', 'Provide a basePrice to update.');
  }

  const basePrice = hasPrice ? parsePrice(values.basePrice, 'basePrice') : null;
  const label = hasLabel ? cleanText(values.label, MAX_LABEL_LENGTH) : null;
  if (hasLabel && !label) throw new CatalogError('invalid_label', 'Base label cannot be empty.');

  const pool = getPool();

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

// ---------------------------------------------------------------------------
// Payment methods (migration 012)
// ---------------------------------------------------------------------------

const PAYMENT_METHOD_CODES = ['qris', 'cash', 'transfer'];
const PAYMENT_METHOD_FIELDS = 'id, code, label, instructions, image_url, is_active, sort_order, updated_at';

const DEFAULT_PAYMENT_METHODS = [
  {
    code: 'qris',
    label: 'QRIS',
    instructions: 'Scan the QRIS code below with any mobile banking or e-wallet app, then send the payment proof to our WhatsApp CS.',
    sortOrder: 0,
  },
  {
    code: 'cash',
    label: 'Cash',
    instructions: 'Pay in cash when we meet on campus or at the COD point. Our CS will confirm the time and place on WhatsApp.',
    sortOrder: 1,
  },
  {
    code: 'transfer',
    label: 'Bank Transfer',
    instructions: 'Transfer to the account our CS confirms on WhatsApp, then send the transfer receipt as payment proof.',
    sortOrder: 2,
  },
];

function mapPaymentMethod(row) {
  return {
    id: row.id === undefined ? null : Number(row.id),
    code: String(row.code),
    label: row.label,
    instructions: row.instructions || '',
    imageUrl: row.image_url || null,
    isActive: Boolean(Number(row.is_active === undefined ? 1 : row.is_active)),
    sortOrder: Number(row.sort_order) || 0,
    updatedAt: row.updated_at || null,
  };
}

/** Fallback used whenever MySQL is unreachable, so the payment page always has content. */
function staticPaymentMethods() {
  return DEFAULT_PAYMENT_METHODS.map((method, index) => ({
    id: null,
    code: method.code,
    label: method.label,
    instructions: method.instructions,
    imageUrl: null,
    isActive: true,
    sortOrder: index,
    updatedAt: null,
  }));
}

async function listPaymentMethods({ activeOnly = false } = {}) {
  if (!isConfigured()) return staticPaymentMethods();
  try {
    const [rows] = await getPool().execute(
      `SELECT ${PAYMENT_METHOD_FIELDS} FROM payment_methods ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order ASC, id ASC`,
    );
    if (!rows.length) return activeOnly ? [] : staticPaymentMethods();
    return rows.map(mapPaymentMethod);
  } catch (error) {
    if (isMissingDatabase(error)) return staticPaymentMethods();
    throw error;
  }
}

function parsePaymentMethodCode(value) {
  const code = cleanText(value, 32).toLowerCase();
  if (!PAYMENT_METHOD_CODES.includes(code)) {
    throw new CatalogError('invalid_payment_method', `Payment method must be one of: ${PAYMENT_METHOD_CODES.join(', ')}.`);
  }
  return code;
}

async function getPaymentMethodByCode(code) {
  const [rows] = await getPool().execute(
    `SELECT ${PAYMENT_METHOD_FIELDS} FROM payment_methods WHERE code = ? LIMIT 1`,
    [parsePaymentMethodCode(code)],
  );
  if (!rows.length) throw new CatalogError('payment_method_not_found', 'Payment method was not found.', 404);
  return mapPaymentMethod(rows[0]);
}

async function updatePaymentMethod(code, input = {}) {
  if (!isConfigured()) {
    throw new CatalogError('database_not_configured', 'Payment methods require the MySQL connection.', 503);
  }

  const methodCode = parsePaymentMethodCode(code);
  const existing = await getPaymentMethodByCode(methodCode);
  const values = input && typeof input === 'object' ? input : {};
  const assignments = [];
  const params = [];

  if (values.label !== undefined) {
    const label = cleanText(values.label, 80);
    if (!label) throw new CatalogError('invalid_label', 'Payment method label cannot be empty.');
    assignments.push('label = ?');
    params.push(label);
  }
  if (values.instructions !== undefined) {
    assignments.push('instructions = ?');
    params.push(cleanMultiline(values.instructions, 2000) || null);
  }
  if (values.isActive !== undefined) {
    if (typeof values.isActive !== 'boolean') {
      throw new CatalogError('invalid_active', 'isActive must be a boolean.');
    }
    assignments.push('is_active = ?');
    params.push(values.isActive ? 1 : 0);
  }
  if (values.sortOrder !== undefined && values.sortOrder !== null && values.sortOrder !== '') {
    assignments.push('sort_order = ?');
    params.push(parseSortOrder(values.sortOrder));
  }
  if (values.imageUrl !== undefined) {
    let imageUrl = values.imageUrl;
    if (typeof imageUrl === 'string' && imageUrl.startsWith('data:image/')) {
      imageUrl = await uploads.saveCatalogImage(`payment-${methodCode}`, imageUrl);
      if (existing.imageUrl && existing.imageUrl !== imageUrl) {
        await uploads.removeCatalogImage(existing.imageUrl);
      }
    }
    if (imageUrl === '') imageUrl = null;
    assignments.push('image_url = ?');
    params.push(imageUrl || null);
  }

  if (!assignments.length) {
    throw new CatalogError('no_changes', 'Provide at least one field to update.');
  }

  await getPool().execute(
    `UPDATE payment_methods SET ${assignments.join(', ')} WHERE code = ?`,
    [...params, methodCode],
  );
  return getPaymentMethodByCode(methodCode);
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
  listBundles,
  getBundleById,
  createBundle,
  updateBundle,
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
  listOptionCategories,
  createOptionCategory,
  updateOptionCategory,
  createPricingOption,
  updatePricingOption,
  deletePricingOption,
  staticOptionCategories,
  VERSION_KEYS,
  DEFAULT_VERSION,
  getProductSettings,
  updateProductSettings,
  seedCatalogGroups,
  seedCatalogProducts,
  seedPricingOptions,
  seedStorefrontCatalog,
  staticGroups,
  staticProducts,
  staticPricingTable,
  listPaymentMethods,
  getPaymentMethodByCode,
  updatePaymentMethod,
  staticPaymentMethods,
  PAYMENT_METHOD_CODES,
  productsForGroups,
  groupPricingOptions,
  productFromOptions,
  DEFAULT_BASE_PRICE,
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
