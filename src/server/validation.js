const catalog = require('../catalog.js');
const pricing = require('../pricing.js');
const options = require('../options.js');
const serverCatalog = require('./catalog.js');

// Order validation and server-side price calculation.
// The browser total is never trusted: the same src/options.js price table that feeds the
// Custom Studio is used here to recompute the amount that gets persisted.

const ALLOWED_BASES = new Set(['heart', 'star', 'bow']);
const ALLOWED_CLASPS = new Set(options.clasps.map((clasp) => clasp.id));
const ALLOWED_ADDONS = new Set(options.addons.map((addon) => addon.id));
// The Custom Studio lets a customer swap the base silhouette, and the base price follows
// the silhouette, not the page the journey started from.
const TEMPLATE_BY_BASE = { heart: 'cloud-heart', star: 'orbit-star', bow: 'soft-ribbon' };
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

function quoteFor({ product, configuration, quantity }) {
  const addonPrices = configuration.addons
    .filter((id) => id !== 'initial')
    .map((id) => options.getAddon(id))
    .filter(Boolean)
    .map((addon) => addon.price);
  const clasp = options.getClasp(configuration.clasp);
  const personalizationPrice = configuration.initial ? options.getAddon('initial').price : 0;

  return pricing.calculatePrice({
    basePrice: product.price,
    addonPrices,
    claspPrice: clasp ? clasp.price : 0,
    personalizationPrice,
    quantity,
  });
}

function validateOrderPayload(payload = {}) {
  const errors = {};
  if (!payload || typeof payload !== 'object') throw new ValidationError({ body: 'A JSON object is required.' });

  const customer = normalizeCustomer(payload.customer || payload.order?.customer || {}, errors);
  const configuration = normalizeConfiguration(payload.order?.configuration || payload.configuration || {}, errors);

  const productSlug = cleanText(payload.order?.product?.slug || payload.productSlug, 80);
  const product = productSlug ? catalog.getProduct(productSlug) : null;
  if (!product) errors.product_slug = 'Unknown product.';

  const quantity = Number(payload.order?.quantity ?? payload.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    errors.quantity = `Quantity must be an integer between 1 and ${MAX_QUANTITY}.`;
  }

  const configurationJson = JSON.stringify({ configuration, product: productSlug });
  if (configurationJson.length > MAX_CONFIGURATION_BYTES) {
    errors.configuration = 'The configuration snapshot is too large.';
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);

  const artistSlug = cleanText(payload.order?.artist?.slug, 60);
  const artist = artistSlug ? catalog.getArtist(artistSlug) : null;
  const templateSlug = TEMPLATE_BY_BASE[configuration.base];
  const pricedProduct = (artist && templateSlug && catalog.getProduct(`${artist.slug}-${templateSlug}`)) || product;
  const quote = quoteFor({ product: pricedProduct, configuration, quantity });
  const submittedTotal = Number(payload.order?.total);

  return {
    customer,
    product: pricedProduct,
    artist: artist ? { slug: artist.slug, name: artist.name, fandom: artist.fandom } : null,
    configuration,
    configurationJson,
    quantity,
    quote,
    submittedTotal: Number.isFinite(submittedTotal) ? submittedTotal : null,
    priceAdjusted: Number.isFinite(submittedTotal) && submittedTotal !== quote.total,
    productName: artist ? `${pricedProduct.name} — ${artist.name}` : pricedProduct.name,
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