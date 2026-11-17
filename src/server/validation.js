const pricing = require('../pricing.js');
const options = require('../options.js');
const serverCatalog = require('./catalog.js');

// Order validation and server-side price calculation.
// The browser total is never trusted: the same pricing module that feeds the Custom Studio is
// used here to recompute the amount that gets persisted, against the live MySQL catalogue when
// one is available.

const ALLOWED_BASES = new Set(['heart', 'star', 'bow']);
const ALLOWED_CLASPS = new Set(options.clasps.map((clasp) => clasp.id));
const ALLOWED_ADDONS = new Set(options.addons.map((addon) => addon.id));
const MAX_QUANTITY = 20;
const MAX_CONFIGURATION_BYTES = 20000;

class ValidationError extends Error {
  constructor(details) {
    super('Order payload is invalid.');
    this.name = 'ValidationError';
    this.code = 'VALIDATION_ERROR';
    this.details = details;
  }
}

const cleanText = (value, maxLength) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
const cleanMultiline = (value, maxLength) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, maxLength);

function normalizeCustomer(input = {}, errors) {
  const name = cleanText(input.name, 120);
  const phone = cleanText(input.phone, 40).replace(/[^\d+\-\s()]/g, '');
  const email = cleanText(input.email, 180);
  const address = cleanMultiline(input.address, 500);
  const note = cleanMultiline(input.note, 500);

  if (name.length < 2) errors.customer_name = 'Name must be at least 2 characters.';
  if (phone.replace(/\D/g, '').length < 6) errors.customer_phone = 'A valid WhatsApp number is required.';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.customer_email = 'Email address is not valid.';
  if (address.length < 8) errors.customer_address = 'Delivery address must be at least 8 characters.';

  return { name, phone, email, address, note };
}

function normalizeConfiguration(input = {}, errors) {
  const configuration = input && typeof input === 'object' ? input : {};

  const baseId = cleanText(configuration.base?.id, 20).toLowerCase();
  if (baseId && !ALLOWED_BASES.has(baseId)) errors.base = 'Unknown base charm.';

  const claspId = cleanText(configuration.clasp?.id, 20).toLowerCase() || 'silver';
  if (!ALLOWED_CLASPS.has(claspId)) errors.clasp = 'Unknown clasp.';

  const addonIds = Array.isArray(configuration.addons)
    ? [...new Set(configuration.addons
      .map((addon) => cleanText(typeof addon === 'string' ? addon : addon?.id, 20).toLowerCase())
      .filter(Boolean))]
    : [];
  const unknownAddon = addonIds.find((id) => !ALLOWED_ADDONS.has(id));
  if (unknownAddon) errors.addons = `Unknown add-on: ${unknownAddon}.`;

  const initial = cleanText(configuration.initial, 1).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const components = Array.isArray(configuration.components)
    ? configuration.components.slice(0, 12).map((component) => ({
      id: cleanText(component?.id, 24),
      name: cleanText(component?.name, 60),
      type: cleanText(component?.type, 24),
      finish: cleanText(component?.finish, 24),
      visible: Boolean(component?.visible),
      original: sanitizeTransform(component?.original),
      current: sanitizeTransform(component?.current),
    }))
    : [];

  return {
    base: baseId,
    clasp: claspId,
    addons: addonIds,
    initial,
    components,
    render: {
      engine: cleanText(configuration.render?.engine, 40) || 'unknown',
      version: Number(configuration.render?.version) || 1,
    },
  };
}

function sanitizeTransform(transform) {
  if (!transform || typeof transform !== 'object') return null;
  const vector = (value, size) => (Array.isArray(value) && value.length === size
    ? value.map((item) => {
      const number = Number(item);
      return Number.isFinite(number) ? Math.round(number * 10000) / 10000 : 0;
    })
    : null);
  return {
    position: vector(transform.position, 3),
    rotation: vector(transform.rotation, 4),
    scale: vector(transform.scale, 3),
  };
}

function quoteFor({ product, configuration, quantity, pricingTable }) {
  // When a live table is supplied the prices come from pricing_options; otherwise
  // src/pricing.js falls back to src/options.js, so both paths agree on the same total.
  return pricing.calculatePrice({
    basePrice: product.price,
    addonIds: configuration.addons.filter((id) => id !== 'initial'),
    claspId: configuration.clasp,
    initial: configuration.initial,
    pricing: pricingTable || undefined,
    quantity,
  });
}

function catalogProducts(catalogData) {
  return catalogData && Array.isArray(catalogData.products)
    ? catalogData.products
    : serverCatalog.staticProducts();
}

function catalogGroups(catalogData) {
  return catalogData && Array.isArray(catalogData.groups)
    ? catalogData.groups
    : serverCatalog.staticGroups();
}

/**
 * Validates an order and computes the authoritative total.
 *
 * `context.catalog` is the payload from serverCatalog.loadCatalog(). When it is omitted the
 * bundled catalogue is used, which keeps this function synchronous for callers that only need
 * shape validation. When the catalogue came from MySQL (`source: 'database'`) the checks are
 * strict: the collection must be active, the design must exist inside that collection, and the
 * prices come from the live tables instead of the client payload.
 */
function validateOrderPayload(payload = {}, context = {}) {
  const errors = {};
  if (!payload || typeof payload !== 'object') throw new ValidationError({ body: 'A JSON object is required.' });

  const catalogData = context && context.catalog ? context.catalog : null;
  const strict = Boolean(catalogData && catalogData.source === 'database');
  const products = catalogProducts(catalogData);
  const groups = catalogGroups(catalogData);
  const pricingTable = catalogData && catalogData.options ? catalogData.options : null;

  const customer = normalizeCustomer(payload.customer || payload.order?.customer || {}, errors);
  const configuration = normalizeConfiguration(payload.order?.configuration || payload.configuration || {}, errors);

  const productSlug = cleanText(payload.order?.product?.slug || payload.productSlug, 80);
  const artistSlug = cleanText(payload.order?.artist?.slug, 60);

  const group = artistSlug ? groups.find((item) => item.slug === artistSlug) || null : null;
  const product = productSlug ? products.find((item) => item.slug === productSlug) || null : null;

  if (!product) {
    errors.product_slug = strict ? 'That design is not available right now.' : 'Unknown product.';
  }
  if (strict && artistSlug && !group) {
    errors.artist_slug = 'That collection is not available right now.';
  }
  if (product && group && product.groupSlug && product.groupSlug !== group.slug) {
    errors.product_slug = 'That design does not belong to the selected collection.';
  }

  const quantity = Number(payload.order?.quantity ?? payload.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    errors.quantity = `Quantity must be an integer between 1 and ${MAX_QUANTITY}.`;
  }

  const configurationJson = JSON.stringify({ configuration, product: productSlug });
  if (configurationJson.length > MAX_CONFIGURATION_BYTES) {
    errors.configuration = 'The configuration snapshot is too large.';
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);

  // Swapping the silhouette in the studio moves the price to that design, not the page the
  // journey started from. Designs are matched inside the same collection.
  const baseSwap = configuration.base && group
    ? products.find((item) => item.groupSlug === group.slug && item.baseId === configuration.base) || null
    : null;
  const pricedProduct = baseSwap || product;

  const quote = quoteFor({ product: pricedProduct, configuration, quantity, pricingTable });
  const submittedTotal = Number(payload.order?.total);
  const artistName = group ? group.name : (pricedProduct.groupName || null);

  return {
    customer,
    product: pricedProduct,
    artist: group ? { slug: group.slug, name: group.name, fandom: group.tagline || group.name.toUpperCase() } : null,
    configuration,
    configurationJson,
    quantity,
    quote,
    submittedTotal: Number.isFinite(submittedTotal) ? submittedTotal : null,
    priceAdjusted: Number.isFinite(submittedTotal) && submittedTotal !== quote.total,
    productName: artistName ? `${pricedProduct.name} — ${artistName}` : pricedProduct.name,
    source: strict ? 'database' : 'bundled',
  };
}

/**
 * Confirms the submitted collection is still active. When MySQL is unavailable the static
 * catalogue is authoritative and the product-slug check above already proved the collection
 * exists, so the order is allowed through instead of failing closed.
 */
async function assertArtistAvailable(artistSlug) {
  const { source, groups } = await serverCatalog.loadCatalog({ activeOnly: true });
  if (source !== 'database') return;

  const slug = cleanText(artistSlug, 64).toLowerCase();
  if (!slug) throw new ValidationError({ artist_slug: 'Choose an available collection.' });
  if (!groups.some((group) => group.slug === slug)) {
    throw new ValidationError({ artist_slug: 'That collection is not available right now.' });
  }
}

module.exports = {
  validateOrderPayload,
  assertArtistAvailable,
  ValidationError,
  ALLOWED_BASES,
  ALLOWED_CLASPS,
  ALLOWED_ADDONS,
  MAX_QUANTITY,
};