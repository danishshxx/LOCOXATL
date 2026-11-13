(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LocoxatlPricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function calculatePrice(input = {}) {
    const basePrice = input.basePrice ?? 0;
    const addonPrices = input.addonPrices ?? [];
    const claspPrice = input.claspPrice ?? 0;
    const personalizationPrice = input.personalizationPrice ?? 0;
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

  return { calculatePrice };
});
