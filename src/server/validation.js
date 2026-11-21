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
const MAX_ITEMS = 20;
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
  // A live payload always carries the items list, even when it is empty: an empty list means the
  // dashboard switched everything off, not "fall back to the bundled options".
  if (Array.isArray(options.items)) {
    return options.items
      .filter((item) => item && item.isActive !== false && item.isLive !== false)
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
  // A live payload always carries the categories array, even when it is empty: an empty list
  // means the dashboard switched every category off, not "fall back to the bundled defaults".
  const categories = catalogData && Array.isArray(catalogData.optionCategories)
    ? catalogData.optionCategories
    : DEFAULT_CATEGORIES;
  // A category the dashboard switched off is not offered at all, so it cannot be required.
  return categories.filter((category) => category && category.isActive !== false && category.isLive !== false);
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

/** Everything the per-line checks read, resolved once per order. */
function catalogContext(catalogData) {
  return {
    strict: Boolean(catalogData && catalogData.source === 'database'),
    products: catalogProducts(catalogData),
    members: catalogMembers(catalogData),
    groups: catalogGroups(catalogData),
    pricingTable: catalogData && catalogData.options ? catalogData.options : null,
    productSettings: catalogData && catalogData.product ? catalogData.product : null,
    bundles: catalogData && Array.isArray(catalogData.bundles) ? catalogData.bundles : [],
    categories: optionCategoriesFor(catalogData),
    items: optionInventory(catalogData),
    paymentMethods: activePaymentMethods(catalogData),
  };
}

/**
 * Validates one design line and computes its authoritative price. `prefix` namespaces the error
 * keys of a multi-item order; a single-item order passes '' so the field names stay exactly what
 * an older client already reports.
 */
function validateItem(input, ctx, prefix, errors) {
  const item = input && typeof input === 'object' ? input : {};
  const local = {};
  const configuration = normalizeConfiguration(item.configuration || {}, local);

  const productId = Number(item.product?.id ?? item.productId);
  const productSlug = cleanText(item.product?.slug || item.productSlug, 80);
  const memberId = Number(item.member?.id ?? item.memberId);
  const memberSlug = cleanText(item.member?.slug || item.memberSlug, 64);
  const artistSlug = cleanText(item.artist?.slug, 60);
  // Member-based designs are the new path; a product id or slug keeps older clients working.
  const memberMode = Boolean(memberSlug) || (Number.isInteger(memberId) && memberId > 0);

  let group = artistSlug ? ctx.groups.find((row) => row.slug === artistSlug) || null : null;
  let member = null;
  let product = null;

  if (memberMode) {
    member = findDesign(ctx.members, { id: memberId, slug: memberSlug }, (row) => (
      (!artistSlug || row.groupSlug === artistSlug) && row.isActive !== false
    ));

    if (!member) {
      local.member_slug = ctx.strict ? 'That member design is not available right now.' : 'Unknown member design.';
    }
    if (!group && member && member.groupSlug) {
      group = ctx.groups.find((row) => row.slug === member.groupSlug) || null;
    }
    if (ctx.strict && artistSlug && !group) {
      local.artist_slug = 'That collection is not available right now.';
    }
    if (ctx.strict && member && group && member.groupSlug && member.groupSlug !== group.slug) {
      local.member_slug = 'That member does not belong to the selected collection.';
    }
  } else {
    product = findDesign(ctx.products, { id: productId, slug: productSlug });

    if (!product) {
      local.product_slug = ctx.strict ? 'That design is not available right now.' : 'Unknown product.';
    }
    if (ctx.strict && artistSlug && !group) {
      local.artist_slug = 'That collection is not available right now.';
    }
    if (product && group && product.groupSlug && product.groupSlug !== group.slug) {
      local.product_slug = 'That design does not belong to the selected collection.';
    }
  }

  // A bundle package is only usable when it is active, exists in the live catalogue, and either
  // applies to every collection or to the collection this order belongs to.
  const bundleId = Number(item.bundle?.id ?? item.bundleId);
  const bundleSlug = cleanText(item.bundle?.slug || item.bundleSlug, 64).toLowerCase();
  const wantsBundle = (Number.isSafeInteger(bundleId) && bundleId > 0) || Boolean(bundleSlug);

  let bundle = null;
  if (wantsBundle) {
    bundle = Number.isSafeInteger(bundleId) && bundleId > 0
      ? ctx.bundles.find((row) => Number(row.id) === bundleId) || null
      : ctx.bundles.find((row) => String(row.slug).toLowerCase() === bundleSlug) || null;

    if (!bundle) {
      local.bundle = 'That bundle package is not available right now.';
    } else if (bundle.isActive === false) {
      local.bundle = 'That bundle package is not available right now.';
    } else if (bundle.groupId != null && (!group || Number(group.id) !== Number(bundle.groupId))) {
      local.bundle = 'That bundle package belongs to another collection.';
    }
  }

  const quantity = Number(item.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    local.quantity = `Quantity must be an integer between 1 and ${MAX_QUANTITY}.`;
  }

  // The version the buyer picked must be the version the design belongs to.
  const requestedVersion = cleanText(item.version, 32).toLowerCase();
  const chosenEntity = memberMode ? member : product;
  const entityVersion = chosenEntity && chosenEntity.versionKey
    ? String(chosenEntity.versionKey).toLowerCase()
    : null;
  if (requestedVersion && !VERSION_KEYS.includes(requestedVersion)) {
    local.version = 'Unknown version selection.';
  } else if (requestedVersion && entityVersion && entityVersion !== requestedVersion) {
    local.version = 'That design belongs to another version.';
  }

  const categories = ctx.categories;
  const items = ctx.items;
  // A category or item the dashboard switched off is rejected, never silently dropped: an order
  // must not carry a choice the storefront is no longer offering.
  const requestedSelections = configurationSelections(configuration);
  const liveSlugs = new Set(categories.map((category) => String(category.slug).toLowerCase()));
  for (const [slug, keys] of Object.entries(requestedSelections)) {
    if (!keys.length || liveSlugs.has(slug)) continue;
    local[slug === 'addon' ? 'addons' : slug] = 'That option is not available right now.';
  }
  if (configuration.initial && !items.some((option) => option.key === 'initial')) {
    local.initial = 'Personalization is not available right now.';
  }
  const selections = offeredSelections(requestedSelections, categories);
  // The stored snapshot must not claim a clasp or add-on the catalogue never offered.
  if (!(selections.clasp && selections.clasp.length)) configuration.clasp = '';
  if (!(selections.addon && selections.addon.length)) configuration.addons = [];
  validateSelections(selections, categories, items, local);

  if (Object.keys(local).length) {
    for (const [key, message] of Object.entries(local)) errors[prefix + key] = message;
    return null;
  }

  let pricedProduct = null;
  let memberInfo = null;
  let basePrice;
  let artistName;

  if (memberMode) {
    // The global base price is the fallback; a design-level override wins when one is set.
    const globalBasePrice = ctx.productSettings && Number.isFinite(Number(ctx.productSettings.basePrice))
      ? Number(ctx.productSettings.basePrice)
      : (ctx.pricingTable && ctx.pricingTable.base && Number.isFinite(Number(ctx.pricingTable.base.price))
        ? Number(ctx.pricingTable.base.price)
        : 45000);
    const memberOverride = member ? member.priceOverride : null;
    basePrice = memberOverride == null ? globalBasePrice : Number(memberOverride);
    artistName = group ? group.name : null;
    memberInfo = {
      slug: member.slug,
      name: member.name,
      groupSlug: group ? group.slug : (member.groupSlug || null),
      designImageUrl: member.designImageUrl || null,
    };
  } else {
    // The order names one design by id or slug; that row is what gets priced. A design-level
    // override replaces the global base price, and a bundle replaces both.
    pricedProduct = product;
    basePrice = pricedProduct.priceOverride == null
      ? Number(pricedProduct.price)
      : Number(pricedProduct.priceOverride);
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
    errors[prefix + 'configuration'] = 'The configuration snapshot is too large.';
    return null;
  }
  const submittedTotal = Number(item.total);

  const bundleSuffix = bundle ? ` · ${bundle.name}` : '';
  const productName = memberMode
    ? (artistName ? `${member.name} Keychain — ${artistName}${bundleSuffix}` : `${member.name} Keychain${bundleSuffix}`)
    : (artistName ? `${pricedProduct.name} — ${artistName}${bundleSuffix}` : `${pricedProduct.name}${bundleSuffix}`);

  return {
    product: pricedProduct,
    member: memberInfo,
    artist: group ? { slug: group.slug, name: group.name, fandom: group.tagline || group.name.toUpperCase() } : null,
    bundle: bundle
      ? { id: bundle.id, slug: bundle.slug, name: bundle.name, price: Number(bundle.price), freeAddonIds }
      : null,
    configuration,
    configurationJson,
    version: requestedVersion || entityVersion || null,
    quantity,
    quote,
    submittedTotal: Number.isFinite(submittedTotal) ? submittedTotal : null,
    priceAdjusted: Number.isFinite(submittedTotal) && submittedTotal !== quote.total,
    productName,
    productId: memberMode ? null : (pricedProduct.id ?? null),
    memberId: memberMode ? (member.id ?? null) : null,
    groupName: artistName || null,
    source: ctx.strict ? 'database' : 'bundled',
  };
}

/**
 * Delivery and payment are decisions for the whole order: one method and one payment per
 * checkout, however many designs the cart holds. Shopee orders are settled on Shopee, so they
 * never carry a payment method; every other path that names a delivery option must name one too.
 * A payload with neither field predates this flow and keeps working with campus delivery.
 */
function validateFulfillment(payload, ctx, errors) {
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
    if (!ctx.paymentMethods.some((method) => method.code === requestedPayment)) {
      errors.payment_method = 'That payment method is not available right now.';
    }
  } else if (requestedFulfillment) {
    errors.payment_method = 'Choose a payment method.';
  }

  return { fulfillmentMethod, paymentMethod };
}

/**
 * Validates an order and computes the authoritative total.
 *
 * A payload either carries an `items` array (a guest cart) or the legacy single `order` object.
 * Both paths run the same per-line checks, so a multi-item order cannot carry a design, an option
 * or a price the single-item path would have rejected.
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

  const ctx = catalogContext(context && context.catalog ? context.catalog : null);
  const customer = normalizeCustomer(payload.customer || payload.order?.customer || {}, errors);
  const { fulfillmentMethod, paymentMethod } = validateFulfillment(payload, ctx, errors);

  const hasItemList = Array.isArray(payload.items);
  const requestedItems = hasItemList ? payload.items : [];
  if (hasItemList && !requestedItems.length) {
    errors.items = 'Add at least one design to the order.';
  } else if (requestedItems.length > MAX_ITEMS) {
    errors.items = `An order can hold at most ${MAX_ITEMS} designs.`;
  }

  const inputs = hasItemList
    ? requestedItems
    : [payload.order && typeof payload.order === 'object' ? { ...payload, ...payload.order } : payload];

  const items = [];
  inputs.forEach((input, index) => {
    const validated = validateItem(input, ctx, hasItemList ? `items[${index}].` : '', errors);
    if (validated) items.push(validated);
  });

  if (Object.keys(errors).length) throw new ValidationError(errors);

  const total = items.reduce((sum, item) => sum + item.quote.total, 0);
  const first = items[0];
  const submittedTotal = Number(hasItemList ? payload.total : payload.order?.total);

  return {
    customer,
    items,
    total,
    fulfillmentMethod,
    paymentMethod,
    // The first line is mirrored at the top level so every existing caller keeps reading the
    // fields it already knows.
    product: first.product,
    member: first.member,
    artist: first.artist,
    bundle: first.bundle,
    configuration: first.configuration,
    configurationJson: first.configurationJson,
    version: first.version,
    quantity: first.quantity,
    quote: first.quote,
    submittedTotal: Number.isFinite(submittedTotal) ? submittedTotal : null,
    priceAdjusted: Number.isFinite(submittedTotal)
      ? submittedTotal !== total
      : items.some((item) => item.priceAdjusted),
    productName: items.map((item) => item.productName).join(' + '),
    source: ctx.strict ? 'database' : 'bundled',
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
  MAX_ITEMS,
  FULFILLMENT_METHODS,
  DEFAULT_FULFILLMENT_METHOD,
};