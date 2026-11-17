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

  function calculatePrice(input = {}) {
    const table = normalizeTable(input.pricing || defaultTable());

    const basePrice = input.basePrice ?? 0;
    const addonPrices = Array.isArray(input.addonIds)
      ? input.addonIds.map((id) => priceOf(table.addons, id)).filter((price) => price !== null)
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

  return { calculatePrice, priceOf, normalizeTable };
});
