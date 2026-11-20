const pricing = require('../pricing.js');
const options = require('../options.js');
const serverCatalog = require('./catalog.js');

// Order validation and server-side price calculation.
// The browser total is never trusted: the same pricing module that feeds the Custom Studio is
// used here to recompute the amount that gets persisted, against the live MySQL catalogue when
// one is available.

const ALLOWED_CLASPS = new Set(options.clasps.map((clasp) => clasp.id));
const ALLOWED_ADDONS = new Set(options.addons.map((addon) => addon.id));
const MAX_QUANTITY = 20;
const MAX_CONFIGURATION_BYTES = 20000;
const VERSION_KEYS = ['yellow', 'pink'];
// Delivery paths the storefront offers. Only the two campus options collect money through the
// site; Shopee is settled on Shopee, so it never carries a payment method.
const FULFILLMENT_METHODS = ['campus_delivery', 'cod_telkom', 'shopee_external'];
const DEFAULT_FULFILLMENT_METHOD = 'campus_delivery';

class ValidationError extends Error {
  constructor(details) {
    super('Order payload is invalid.');
    this.name = 'ValidationError';
    this.code = 'VALIDATION_ERROR';
    this.details = details;
  }
}

const cleanText = (value, maxLength) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);

// Kept for callers that still import them; option validation now reads the live inventory so a
// dashboard category needs no code change.
const DEFAULT_CATEGORIES = [
  { slug: 'addon', name: 'Universal Add-ons', selectionMode: 'multiple', isRequired: false, countsTowardBundleFree: true, sortOrder: 0 },
  { slug: 'clasp', name: 'Clasps', selectionMode: 'single', isRequired: true, countsTowardBundleFree: false, sortOrder: 1 },
];

/**
 * Every priced option in the catalogue, in the category-agnostic shape the pricing engine reads.
 * A catalogue that only knows addons/clasps is upgraded here, so older payloads keep working.
 */
function optionInventory(catalogData) {
  const options = catalogData && catalogData.options ? catalogData.options : serverCatalog.staticPricingTable();
  // Inactive rows are never offered, so they are never priced or required.
  if (Array.isArray(options.items) && options.items.length) {
    return options.items
      .filter((item) => item && item.isActive !== false)
      .map((item) => ({
        key: String(item.key ?? item.id ?? '').toLowerCase(),
        category: String(item.category || 'addon').toLowerCase(),
        price: Number(item.price) || 0,
        personalization: Boolean(item.personalization),
      }));
  }

  const items = [];
  for (const addon of options.addons || []) {
    if (!addon || addon.isActive === false) continue;
    items.push({
      key: String(addon.key ?? addon.id ?? '').toLowerCase(),
      category: 'addon',
      price: Number(addon.price) || 0,
      personalization: Boolean(addon.personalization),
    });
  }
  for (const clasp of options.clasps || []) {
    if (!clasp || clasp.isActive === false) continue;
    items.push({
      key: String(clasp.key ?? clasp.id ?? '').toLowerCase(),
      category: 'clasp',
      price: Number(clasp.price) || 0,
      personalization: false,
    });
  }
  return items;
}

function optionCategoriesFor(catalogData) {
  const categories = catalogData && Array.isArray(catalogData.optionCategories) && catalogData.optionCategories.length
    ? catalogData.optionCategories
    : DEFAULT_CATEGORIES;
  // A category the dashboard switched off is not offered at all, so it cannot be required.
  return categories.filter((category) => category && category.isActive !== false);
}

/**
 * Payment methods the buyer may pick. A catalogue payload always carries the full list, so an
 * empty list means "the admin switched everything off" and must not be replaced by defaults.
 */
function activePaymentMethods(catalogData) {
  if (catalogData && Array.isArray(catalogData.paymentMethods)) {
    return catalogData.paymentMethods.filter((method) => method && method.isActive !== false);
  }
  return serverCatalog.staticPaymentMethods();
}

/** Selections by category slug; legacy payloads expose a flat addon list plus one clasp id. */
function configurationSelections(configuration) {
  const source = configuration && configuration.selections && typeof configuration.selections === 'object'
    ? configuration.selections
    : null;

  if (source) {
    const result = {};
    for (const [slug, value] of Object.entries(source)) {
      const keys = (Array.isArray(value) ? value : [value])
        .map((entry) => cleanText(typeof entry === 'string' ? entry : (entry && (entry.key ?? entry.id)), 64).toLowerCase())
        .filter(Boolean);
      result[String(slug).toLowerCase()] = keys;
    }
    return result;
  }

  return {
    addon: Array.isArray(configuration && configuration.addons) ? configuration.addons.slice() : [],
    clasp: configuration && configuration.clasp ? [configuration.clasp] : [],
  };
}

/**
 * Drops selections for categories the catalogue no longer offers. A category the dashboard hid
 * cannot be required or charged, however stale the page that submitted it. Choices inside a live
 * category are left alone so an unknown key is still rejected by validateSelections().
 */
function offeredSelections(selections, categories) {
  const activeSlugs = new Set(categories.map((category) => String(category.slug).toLowerCase()));
  const result = {};

  for (const [slug, keys] of Object.entries(selections)) {
    if (!activeSlugs.has(slug)) continue;
    result[slug] = keys;
  }

  return result;
}

/** Unknown keys, single-mode overflow and required categories are all order-level errors. */
function validateSelections(selections, categories, items, errors) {
  const byKey = new Map(items.map((item) => [item.key, item]));

  for (const [slug, keys] of Object.entries(selections)) {
    const category = categories.find((entry) => String(entry.slug).toLowerCase() === slug);
    if (!category) {
      errors[slug] = `Unknown option category: ${slug}.`;
      continue;
    }

    const valid = [];
    for (const key of keys) {
      const item = byKey.get(key);
      if (!item || item.category !== slug) {
        const detailKey = slug === 'addon' ? 'addons' : slug;
        errors[detailKey] = `Unknown option in ${slug}: ${key}.`;
        continue;
      }
      valid.push(key);
    }

    const label = category.name || slug;
    if (category.selectionMode === 'single' && valid.length > 1) {
      errors[slug] = `Choose at most one ${label}.`;
    }
    if (category.isRequired && !valid.length) {
      errors[slug] = `Choose a ${label}.`;
    }
  }

  for (const category of categories) {
    const slug = String(category.slug).toLowerCase();
    if (!category.isRequired || errors[slug]) continue;
    if (!(selections[slug] && selections[slug].length)) {
      errors[slug] = `Choose a ${category.name || slug}.`;
    }
  }
}
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

  // The selected design is the base now; the field is kept only so stored snapshots keep the
  // reference they were created with. Resolution never depends on it.
  const baseId = cleanText(configuration.base?.id, 64).toLowerCase();

  // A clasp is only assumed for older clients that send addons/clasp and no selections map;
  // with a selections map the absence of a clasp means the customer was offered none.
  const hasSelections = Boolean(configuration.selections && typeof configuration.selections === 'object');
  const claspId = cleanText(configuration.clasp?.id, 20).toLowerCase() || (hasSelections ? '' : 'silver');

  const addonIds = Array.isArray(configuration.addons)
    ? [...new Set(configuration.addons
      .map((addon) => cleanText(typeof addon === 'string' ? addon : addon?.id, 20).toLowerCase())
      .filter(Boolean))]
    : [];

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
    // Every category the buyer touched, by slug. Absent on older clients, which is why
    // configurationSelections() can still derive addon/clasp from the fields above.
    selections: configuration.selections && typeof configuration.selections === 'object'
      ? configuration.selections
      : undefined,
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

/**
 * Resolves a design from the active catalogue by id first and slug second, so a client that sends
 * either one lands on the same row. `extra` carries the collection and visibility checks.
 */
function findDesign(list, { id, slug }, extra = () => true) {
  const wanted = Number(id);
  if (Number.isInteger(wanted) && wanted > 0) {
    const byId = list.find((item) => Number(item.id) === wanted && extra(item));
    if (byId) return byId;
  }
  return slug ? list.find((item) => item.slug === slug && extra(item)) || null : null;
}

function catalogProducts(catalogData) {
  return catalogData && Array.isArray(catalogData.products)
    ? catalogData.products
    : serverCatalog.staticProducts();
}

function catalogMembers(catalogData) {
  return catalogData && Array.isArray(catalogData.members) ? catalogData.members : [];
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
  const members = catalogMembers(catalogData);
  const groups = catalogGroups(catalogData);
  const pricingTable = catalogData && catalogData.options ? catalogData.options : null;
  const productSettings = catalogData && catalogData.product ? catalogData.product : null;
  const bundles = catalogData && Array.isArray(catalogData.bundles) ? catalogData.bundles : [];

  const customer = normalizeCustomer(payload.customer || payload.order?.customer || {}, errors);
  const configuration = normalizeConfiguration(payload.order?.configuration || payload.configuration || {}, errors);

  const productId = Number(payload.order?.product?.id ?? payload.productId);
  const productSlug = cleanText(payload.order?.product?.slug || payload.productSlug, 80);
  const memberId = Number(payload.order?.member?.id ?? payload.memberId);
  const memberSlug = cleanText(payload.order?.member?.slug || payload.memberSlug, 64);
  const artistSlug = cleanText(payload.order?.artist?.slug, 60);
  // Member-based designs are the new path; a product id or slug keeps older clients working.
  const memberMode = Boolean(memberSlug) || (Number.isInteger(memberId) && memberId > 0);

  let group = artistSlug ? groups.find((item) => item.slug === artistSlug) || null : null;
  let member = null;
  let product = null;

  if (memberMode) {
    member = findDesign(members, { id: memberId, slug: memberSlug }, (item) => (
      (!artistSlug || item.groupSlug === artistSlug) && item.isActive !== false
    ));

    if (!member) {
      errors.member_slug = strict ? 'That member design is not available right now.' : 'Unknown member design.';
    }
    if (!group && member && member.groupSlug) {
      group = groups.find((item) => item.slug === member.groupSlug) || null;
    }
    if (strict && artistSlug && !group) {
      errors.artist_slug = 'That collection is not available right now.';
    }
    if (strict && member && group && member.groupSlug && member.groupSlug !== group.slug) {
      errors.member_slug = 'That member does not belong to the selected collection.';
    }
  } else {
    product = findDesign(products, { id: productId, slug: productSlug });

    if (!product) {
      errors.product_slug = strict ? 'That design is not available right now.' : 'Unknown product.';
    }
    if (strict && artistSlug && !group) {
      errors.artist_slug = 'That collection is not available right now.';
    }
    if (product && group && product.groupSlug && product.groupSlug !== group.slug) {
      errors.product_slug = 'That design does not belong to the selected collection.';
    }
  }

  // A bundle package is only usable when it is active, exists in the live catalogue, and either
  // applies to every collection or to the collection this order belongs to.
  const bundleId = Number(payload.order?.bundle?.id ?? payload.bundleId);
  const bundleSlug = cleanText(payload.order?.bundle?.slug || payload.bundleSlug, 64).toLowerCase();
  const wantsBundle = (Number.isSafeInteger(bundleId) && bundleId > 0) || Boolean(bundleSlug);

  let bundle = null;
  if (wantsBundle) {
    bundle = Number.isSafeInteger(bundleId) && bundleId > 0
      ? bundles.find((item) => Number(item.id) === bundleId) || null
      : bundles.find((item) => String(item.slug).toLowerCase() === bundleSlug) || null;

    if (!bundle) {
      errors.bundle = 'That bundle package is not available right now.';
    } else if (bundle.isActive === false) {
      errors.bundle = 'That bundle package is not available right now.';
    } else if (bundle.groupId != null && (!group || Number(group.id) !== Number(bundle.groupId))) {
      errors.bundle = 'That bundle package belongs to another collection.';
    }
  }

  const quantity = Number(payload.order?.quantity ?? payload.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    errors.quantity = `Quantity must be an integer between 1 and ${MAX_QUANTITY}.`;
  }

  // The version the buyer picked must be the version the design belongs to.
  const requestedVersion = cleanText(payload.order?.version, 32).toLowerCase();
  const chosenEntity = memberMode ? member : product;
  const entityVersion = chosenEntity && chosenEntity.versionKey
    ? String(chosenEntity.versionKey).toLowerCase()
    : null;
  if (requestedVersion && !VERSION_KEYS.includes(requestedVersion)) {
    errors.version = 'Unknown version selection.';
  } else if (requestedVersion && entityVersion && entityVersion !== requestedVersion) {
    errors.version = 'That design belongs to another version.';
  }

  // How the order is delivered and paid. Shopee orders are settled on Shopee, so they never
  // carry a payment method; every other path that names a delivery option must name one too.
  // A payload with neither field predates this flow and keeps working with campus delivery.
  const requestedFulfillment = cleanText(payload.order?.fulfillmentMethod ?? payload.fulfillmentMethod, 32).toLowerCase();
  const fulfillmentMethod = requestedFulfillment || DEFAULT_FULFILLMENT_METHOD;
  if (!FULFILLMENT_METHODS.includes(fulfillmentMethod)) {
    errors.fulfillment_method = 'Choose a valid delivery option.';
  }

  const requestedPayment = cleanText(payload.order?.paymentMethod ?? payload.paymentMethod, 32).toLowerCase();
  let paymentMethod = requestedPayment || null;
  if (fulfillmentMethod === 'shopee_external') {
    paymentMethod = null;
  } else if (requestedPayment) {
    if (!activePaymentMethods(catalogData).some((method) => method.code === requestedPayment)) {
      errors.payment_method = 'That payment method is not available right now.';
    }
  } else if (requestedFulfillment) {
    errors.payment_method = 'Choose a payment method.';
  }

  const categories = optionCategoriesFor(catalogData);
  const items = optionInventory(catalogData);
  const selections = offeredSelections(configurationSelections(configuration), categories);
  // The stored snapshot must not claim a clasp or add-on the catalogue never offered.
  if (!(selections.clasp && selections.clasp.length)) configuration.clasp = '';
  if (!(selections.addon && selections.addon.length)) configuration.addons = [];
  validateSelections(selections, categories, items, errors);

  if (Object.keys(errors).length) throw new ValidationError(errors);

  let pricedProduct = null;
  let memberInfo = null;
  let basePrice;
  let artistName;

  if (memberMode) {
    // One shared base price from pricing_options; member artwork never creates a product variant.
    basePrice = productSettings && Number.isFinite(Number(productSettings.basePrice))
      ? Number(productSettings.basePrice)
      : (pricingTable && pricingTable.base && Number.isFinite(Number(pricingTable.base.price))
        ? Number(pricingTable.base.price)
        : 45000);
    artistName = group ? group.name : null;
    memberInfo = {
      slug: member.slug,
      name: member.name,
      groupSlug: group ? group.slug : (member.groupSlug || null),
      designImageUrl: member.designImageUrl || null,
    };
  } else {
    // The order names one design by id or slug; that row is what gets priced.
    pricedProduct = product;
    basePrice = pricedProduct.price;
    artistName = group ? group.name : (pricedProduct.groupName || null);
  }

  // A bundle replaces the shared base price, and the free quota is recomputed here so a client
  // cannot mark its own options as included.
  if (bundle) basePrice = Number(bundle.price);
  const quote = pricing.quoteSelections({
    basePrice,
    bundle: bundle
      ? {
        price: Number(bundle.price),
        freeAddonQuota: bundle.freeAddonQuota,
        allowedAddonKeys: bundle.allowedAddonKeys,
      }
      : null,
    categories,
    items,
    selections,
    personalization: { key: 'initial', active: Boolean(configuration.initial) },
    quantity,
  });
  const freeAddonIds = quote.freeAddonIds;

  const configurationJson = JSON.stringify({
    configuration,
    version: requestedVersion || entityVersion || undefined,
    member: memberMode ? memberSlug : undefined,
    product: memberMode ? undefined : productSlug,
    bundle: bundle
      ? { id: bundle.id, slug: bundle.slug, name: bundle.name, price: bundle.price, freeAddonIds }
      : undefined,
  });
  if (configurationJson.length > MAX_CONFIGURATION_BYTES) {
    throw new ValidationError({ configuration: 'The configuration snapshot is too large.' });
  }
  const submittedTotal = Number(payload.order?.total);

  const bundleSuffix = bundle ? ` · ${bundle.name}` : '';
  const productName = memberMode
    ? (artistName ? `${member.name} Keychain — ${artistName}${bundleSuffix}` : `${member.name} Keychain${bundleSuffix}`)
    : (artistName ? `${pricedProduct.name} — ${artistName}${bundleSuffix}` : `${pricedProduct.name}${bundleSuffix}`);

  return {
    customer,
    product: pricedProduct,
    member: memberInfo,
    artist: group ? { slug: group.slug, name: group.name, fandom: group.tagline || group.name.toUpperCase() } : null,
    bundle: bundle
      ? { id: bundle.id, slug: bundle.slug, name: bundle.name, price: Number(bundle.price), freeAddonIds }
      : null,
    configuration,
    configurationJson,
    version: requestedVersion || entityVersion || null,
    fulfillmentMethod,
    paymentMethod,
    quantity,
    quote,
    submittedTotal: Number.isFinite(submittedTotal) ? submittedTotal : null,
    priceAdjusted: Number.isFinite(submittedTotal) && submittedTotal !== quote.total,
    productName,
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
  ALLOWED_CLASPS,
  ALLOWED_ADDONS,
  MAX_QUANTITY,
  FULFILLMENT_METHODS,
  DEFAULT_FULFILLMENT_METHOD,
};