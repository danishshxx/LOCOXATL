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

    const basePrice = bundle && bundle.price !== undefined && bundle.price !== null
      ? Number(bundle.price)
      : (input.basePrice ?? 0);
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

  return { calculatePrice, priceOf, normalizeTable, freeAddonIds };
});
