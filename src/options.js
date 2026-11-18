(function (root, factory) {
  const pricing = typeof module === 'object' && module.exports ? require('./pricing.js') : root && root.LocoxatlPricing;
  const api = factory(pricing);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LocoxatlOptions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (pricing) {
  const addons = [
    { id: 'pearl', name: 'Pearl drop', price: 8000, personalization: false },
    { id: 'star', name: 'Mini star', price: 12000, personalization: false },
    { id: 'initial', name: 'Your initial', price: 5000, personalization: true },
  ];

  const straps = [
    { id: 'strap-white', name: 'White silicone strap', price: 8000, personalization: false },
    { id: 'strap-black', name: 'Black silicone strap', price: 8000, personalization: false },
  ];

  /**
   * The bundled category list mirrors the seeded option_categories rows, so the studio renders
   * the same sections offline that the dashboard serves from MySQL.
   */
  const optionCategories = [
    { slug: 'addon', name: 'Universal Add-ons', selectionMode: 'multiple', isRequired: false, countsTowardBundleFree: true, sortOrder: 0, isActive: true },
    { slug: 'clasp', name: 'Clasps', selectionMode: 'single', isRequired: true, countsTowardBundleFree: false, sortOrder: 1, isActive: true },
    { slug: 'silicone-strap', name: 'Silicone Straps', selectionMode: 'single', isRequired: false, countsTowardBundleFree: false, bundleIncluded: true, sortOrder: 2, isActive: true },
  ];

  const clasps = [
    { id: 'silver', name: 'Silver clasp', price: 7000 },
    { id: 'black', name: 'Black clasp', price: 5000 },
  ];

  /**
   * The bundled table is the fallback whenever the dashboard table is missing, empty, or the
   * database is unreachable. Entries may use `id` or `key`, so both this module and the rows
   * returned by `/api/catalog` resolve through the same lookup.
   */
  function pricingTable(source) {
    const table = source && typeof source === 'object' ? source : {};
    return {
      addons: Array.isArray(table.addons) && table.addons.length ? table.addons : addons,
      clasps: Array.isArray(table.clasps) && table.clasps.length ? table.clasps : clasps,
      straps: Array.isArray(table.straps) && table.straps.length ? table.straps : straps,
    };
  }

  function getAddon(id, list = addons) {
    return list.find((addon) => addon.id === id || addon.key === id) || null;
  }

  function getStrap(id, list = straps) {
    return list.find((strap) => strap.id === id || strap.key === id) || null;
  }

  function getClasp(id, list = clasps) {
    return list.find((clasp) => clasp.id === id || clasp.key === id) || null;
  }

  function quote(input = {}) {
    if (!pricing || typeof pricing.calculatePrice !== 'function') {
      throw new Error('LocoxatlPricing must be loaded before LocoxatlOptions.');
    }
    const table = pricingTable(input.pricing);
    const addonIds = input.addonIds ?? [];
    const selectedAddons = addonIds.map((id) => getAddon(id, table.addons)).filter(Boolean);
    const clasp = getClasp(input.claspId ?? 'silver', table.clasps);
    if (!clasp) throw new RangeError(`Unknown clasp: ${input.claspId}`);
    const personalizationSelected = Boolean(input.initial) || selectedAddons.some((addon) => addon.personalization);
    const initialAddon = getAddon('initial', table.addons);

    return pricing.calculatePrice({
      basePrice: input.basePrice ?? 0,
      addonPrices: selectedAddons.filter((addon) => !addon.personalization).map((addon) => addon.price),
      claspPrice: clasp.price,
      personalizationPrice: personalizationSelected && initialAddon ? initialAddon.price : 0,
      quantity: input.quantity ?? 1,
      shipping: input.shipping ?? 0,
      discount: input.discount ?? 0,
    });
  }

  return { addons, clasps, straps, optionCategories, pricingTable, getAddon, getClasp, getStrap, quote };
});
