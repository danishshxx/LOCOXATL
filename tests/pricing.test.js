const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePrice } = require('../src/pricing.js');

test('calculates a base charm with selected add-ons, clasp, personalization, quantity, shipping and discount', () => {
  const result = calculatePrice({
    basePrice: 45000,
    addonPrices: [10000, 5000],
    claspPrice: 7000,
    personalizationPrice: 5000,
    quantity: 2,
    shipping: 12000,
    discount: 10000,
  });

  assert.deepEqual(result, {
    unitPrice: 72000,
    subtotal: 144000,
    total: 146000,
  });
});

test('treats omitted optional prices as zero', () => {
  const result = calculatePrice({ basePrice: 30000, quantity: 1 });
  assert.deepEqual(result, { unitPrice: 30000, subtotal: 30000, total: 30000 });
});

test('rejects negative prices and invalid quantities', () => {
  assert.throws(() => calculatePrice({ basePrice: -1, quantity: 1 }), /non-negative/);
  assert.throws(() => calculatePrice({ basePrice: 30000, quantity: 0 }), /quantity/);
});
