(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LocoxatlPricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  /**
   * A pricing table is `{ addons: [{ id, price }], clasps: [{ id, price }] }`. Live tables come
   * from `pricing_options` in MySQL and are passed in by the server and the studio; when a caller
   * omits one, src/options.js stays the default so nothing changes for existing configurations.
   */
  function defaultTable() {
    if (typeof module === 'object' && module.exports) {
      try {
        return require('./options.js');
      } catch {
        return null;
      }
    }
    return root && root.LocoxatlOptions ? root.LocoxatlOptions : null;
  }

  // The personalization option is priced apart from the regular option lines, whichever
  // category the dashboard places it in.
  const PERSONALIZATION_KEYS = new Set(['initial']);

  function normalizeTable(table) {
    const source = table && typeof table === 'object' ? table : null;
    if (!source) return { addons: [], clasps: [] };
    return {
      addons: Array.isArray(source.addons) ? source.addons : [],
      clasps: Array.isArray(source.clasps) ? source.clasps : [],
    };
  }

  function priceOf(list, id) {
    if (!id || !Array.isArray(list)) return null;
    const key = String(id).trim().toLowerCase();
    if (!key) return null;
    // Database rows carry a numeric `id` and the option key in `key`; the bundled options use
    // `id` for the key. Both are accepted so the same table shape works everywhere.
    const match = list.find((item) => item
      && (String(item.key ?? '').toLowerCase() === key || String(item.id ?? '').toLowerCase() === key));
    if (!match) return null;
    const price = Number(match.price);
    return Number.isFinite(price) && price >= 0 ? price : null;
  }

  /**
   * Which selected add-ons a bundle covers for free. The bundle's own allow-list decides
   * eligibility (absent means any add-on), the quota caps how many are free, and the
   * personalization "initial" add-on is never free because it is priced separately.
   */
  function freeAddonIds(input = {}) {
    const quota = Number(input.quota);
    if (!Number.isInteger(quota) || quota < 1) return [];
    const allowed = Array.isArray(input.allowedAddonKeys) && input.allowedAddonKeys.length
      ? new Set(input.allowedAddonKeys.map((key) => String(key).trim().toLowerCase()).filter(Boolean))
      : null;

    const free = [];
    for (const id of Array.isArray(input.addonIds) ? input.addonIds : []) {
      if (free.length >= quota) break;
      const key = String(id == null ? '' : id).trim().toLowerCase();
      if (!key || key === 'initial' || free.includes(key)) continue;
      if (allowed && !allowed.has(key)) continue;
      free.push(key);
    }
    return free;
  }

  function calculatePrice(input = {}) {
    const table = normalizeTable(input.pricing || defaultTable());
    // A bundle replaces the base price and covers up to its quota of eligible add-ons; every
    // add-on outside the free set is still charged normally.
    const bundle = input.bundle && typeof input.bundle === 'object' ? input.bundle : null;
    const freeIds = bundle && Array.isArray(bundle.freeAddonIds)
      ? new Set(bundle.freeAddonIds.map((key) => String(key).trim().toLowerCase()))
      : null;

    const bundlePrice = bundle && bundle.price !== undefined && bundle.price !== null
      ? Number(bundle.price)
      : null;
    // A bundle owns the base price outright. Without one, a design-level override replaces the
    // global base price, and only then does the caller's base price apply.
    const override = input.priceOverride == null ? null : Number(input.priceOverride);
    const basePrice = bundlePrice !== null
      ? bundlePrice
      : (override !== null && Number.isFinite(override) ? override : (input.basePrice ?? 0));
    const addonPrices = Array.isArray(input.addonIds)
      ? input.addonIds.map((id) => {
        if (freeIds && freeIds.has(String(id == null ? '' : id).trim().toLowerCase())) return 0;
        return priceOf(table.addons, id);
      }).filter((price) => price !== null)
      : (input.addonPrices ?? []);

    const claspPrice = input.claspPrice ?? (input.claspId ? (priceOf(table.clasps, input.claspId) ?? 0) : 0);
    const personalizationPrice = input.personalizationPrice
      ?? (input.initial ? (priceOf(table.addons, 'initial') ?? 0) : 0);
    const quantity = input.quantity ?? 1;
    const shipping = input.shipping ?? 0;
    const discount = input.discount ?? 0;

    const prices = [basePrice, ...addonPrices, claspPrice, personalizationPrice, shipping, discount];
    if (prices.some((price) => !Number.isFinite(price) || price < 0)) {
      throw new RangeError('All prices must be finite and non-negative.');
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new RangeError('quantity must be a positive integer.');
    }

    const unitPrice = basePrice + addonPrices.reduce((sum, price) => sum + price, 0) + claspPrice + personalizationPrice;
    const subtotal = unitPrice * quantity;
    const total = Math.max(0, subtotal + shipping - discount);

    return { unitPrice, subtotal, total };
  }

  /**
   * Category-agnostic quote. Every choice is a key inside a category, and the category row
   * decides single versus multiple and whether a bundle may cover it for free, so a new
   * dashboard category needs no code change here.
   */
  function quoteSelections(input = {}) {
    const items = Array.isArray(input.items) ? input.items : [];
    const categories = (Array.isArray(input.categories) ? input.categories : [])
      .slice()
      .sort((a, b) => (Number(a && a.sortOrder) || 0) - (Number(b && b.sortOrder) || 0));
    const selections = input.selections && typeof input.selections === 'object' ? input.selections : {};

    const byKey = new Map();
    for (const item of items) {
      // An item the dashboard switched off is not offered, so it can never be priced.
      if (!item || item.isActive === false) continue;
      const raw = item && item.key !== undefined && item.key !== null ? item.key : (item ? item.id : '');
      const key = String(raw == null ? '' : raw).trim().toLowerCase();
      if (!key) continue;
      byKey.set(key, {
        key,
        price: Number(item.price) || 0,
        category: String(item.category || '').trim().toLowerCase(),
        personalization: Boolean(item.personalization) || PERSONALIZATION_KEYS.has(key),
      });
    }

    const lines = [];
    const chosen = new Set();
    for (const category of categories) {
      const slug = String((category && category.slug) || '').trim().toLowerCase();
      if (!slug || category.isActive === false) continue;

      const requested = selections[slug];
      const keys = (Array.isArray(requested) ? requested : [requested])
        .map((key) => String(key == null ? '' : key).trim().toLowerCase())
        .filter((key) => key && byKey.has(key) && byKey.get(key).category === slug);
      const limit = category.selectionMode === 'single' ? 1 : keys.length;

      for (const key of keys.slice(0, limit)) {
        if (chosen.has(key)) continue;
        chosen.add(key);
        const entry = byKey.get(key);
        if (entry.personalization) continue;
        lines.push({
          key,
          category: slug,
          price: entry.price,
          free: false,
          countsTowardBundleFree: category.countsTowardBundleFree !== false,
        });
      }
    }

    const freeIds = input.bundle
      ? freeAddonIds({
        addonIds: lines.filter((line) => line.countsTowardBundleFree).map((line) => line.key),
        quota: input.bundle.freeAddonQuota,
        allowedAddonKeys: input.bundle.allowedAddonKeys,
      })
      : [];
    // A category flagged as included comes with every bundle: free, and outside the quota.
    const includedCategories = new Set(
      categories
        .filter((category) => category && category.bundleIncluded)
        .map((category) => String(category.slug || '').trim().toLowerCase()),
    );
    for (const line of lines) {
      line.free = freeIds.includes(line.key) || (Boolean(input.bundle) && includedCategories.has(line.category));
    }

    const personalizationKey = String(
      input.personalization && input.personalization.active ? input.personalization.key || '' : '',
    ).trim().toLowerCase();
    const personalizationEntry = personalizationKey ? byKey.get(personalizationKey) : null;
    // A bundle owns the base price outright; the standard base is never added on top of it.
    const bundlePrice = input.bundle && input.bundle.price !== undefined && input.bundle.price !== null
      ? Number(input.bundle.price)
      : null;
    const override = input.priceOverride == null ? null : Number(input.priceOverride);
    const baseForQuote = bundlePrice !== null
      ? bundlePrice
      : (override !== null && Number.isFinite(override) ? override : (input.basePrice ?? 0));

    const quote = calculatePrice({
      basePrice: baseForQuote,
      addonPrices: lines.map((line) => (line.free ? 0 : line.price)),
      personalizationPrice: personalizationEntry && personalizationEntry.personalization
        ? personalizationEntry.price
        : 0,
      claspPrice: 0,
      quantity: input.quantity ?? 1,
      shipping: input.shipping ?? 0,
      discount: input.discount ?? 0,
    });

    return { ...quote, freeAddonIds: freeIds, lines };
  }

  return { calculatePrice, quoteSelections, priceOf, normalizeTable, freeAddonIds };
});
