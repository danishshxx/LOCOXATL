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

  const clasps = [
    { id: 'silver', name: 'Silver clasp', price: 7000 },
    { id: 'black', name: 'Black clasp', price: 5000 },
  ];

  function getAddon(id) {
    return addons.find((addon) => addon.id === id) || null;
  }

  function getClasp(id) {
    return clasps.find((clasp) => clasp.id === id) || null;
  }

  function quote(input = {}) {
    if (!pricing || typeof pricing.calculatePrice !== 'function') {
      throw new Error('LocoxatlPricing must be loaded before LocoxatlOptions.');
    }
    const addonIds = input.addonIds ?? [];
    const selectedAddons = addonIds.map(getAddon).filter(Boolean);
    const clasp = getClasp(input.claspId ?? 'silver');
    if (!clasp) throw new RangeError(`Unknown clasp: ${input.claspId}`);
    const personalizationSelected = Boolean(input.initial) || selectedAddons.some((addon) => addon.personalization);

    return pricing.calculatePrice({
      basePrice: input.basePrice ?? 0,
      addonPrices: selectedAddons.filter((addon) => !addon.personalization).map((addon) => addon.price),
      claspPrice: clasp.price,
      personalizationPrice: personalizationSelected ? getAddon('initial').price : 0,
      quantity: input.quantity ?? 1,
      shipping: input.shipping ?? 0,
      discount: input.discount ?? 0,
    });
  }

  return { addons, clasps, getAddon, getClasp, quote };
});