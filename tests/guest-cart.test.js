const test = require('node:test');
const assert = require('node:assert/strict');

// The guest cart lives entirely in the browser: a fingerprint decides whether a design is the
// same line, and the live catalogue decides what each line costs and whether it still exists.

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

globalThis.localStorage = fakeStorage();
const cart = require('../src/cart.js');

function catalog(overrides = {}) {
  return {
    source: 'database',
    groups: [{ id: 1, slug: 'blackpink', name: 'BLACKPINK' }],
    members: [{ id: 5, slug: 'jisoo', name: 'Jisoo', groupSlug: 'blackpink', designImageUrl: null, priceOverride: null }],
    products: [],
    bundles: [{ id: 7, slug: 'duo-paket', name: 'Duo Paket', price: 60000, freeAddonQuota: 1, isActive: true, groupId: null }],
    optionCategories: [
      { slug: 'addon', name: 'Universal Add-ons', selectionMode: 'multiple', isRequired: false, countsTowardBundleFree: true, sortOrder: 0 },
      { slug: 'clasp', name: 'Clasps', selectionMode: 'single', isRequired: true, countsTowardBundleFree: false, sortOrder: 1 },
    ],
    options: {
      base: { key: 'keychain', label: 'Keychain base', price: 45000 },
      items: [
        { key: 'pearl', category: 'addon', label: 'Pearl drop', price: 8000 },
        { key: 'initial', category: 'addon', label: 'Your initial', price: 5000, personalization: true },
        { key: 'silver', category: 'clasp', label: 'Silver clasp', price: 7000 },
        { key: 'black', category: 'clasp', label: 'Black clasp', price: 5000 },
      ],
    },
    product: { basePrice: 45000 },
    ...overrides,
  };
}

function design(overrides = {}) {
  return {
    artist: { slug: 'blackpink', name: 'BLACKPINK', fandom: 'BLINK' },
    member: { id: 5, slug: 'jisoo', name: 'Jisoo', designImageUrl: null },
    product: null,
    version: 'yellow',
    previewImage: 'assets/brand/locoxatl-symbol-black.png',
    selections: { addon: ['pearl'], clasp: ['silver'] },
    extraLabels: [],
    bundle: null,
    configuration: {
      base: { id: 'jisoo', name: 'Jisoo', price: 45000 },
      addons: [{ id: 'pearl', name: 'Pearl drop', price: 8000 }],
      initial: '',
      clasp: { id: 'silver', name: 'Silver clasp', price: 7000 },
      render: { engine: 'svg-fallback', version: 1 },
      components: [],
    },
    total: 60000,
    quantity: 1,
    ...overrides,
  };
}

function reset() {
  cart.clearCart();
  cart.clearDirectCheckout();
}

test('the same configuration increments its quantity instead of adding a line', () => {
  reset();
  const first = cart.addItem(design());
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].quantity, 1);

  const second = cart.addItem(design());
  assert.equal(second.items.length, 1, 'the identical configuration is one line');
  assert.equal(second.items[0].quantity, 2);
  assert.equal(cart.count(second.items), 2);
  assert.equal(cart.subtotal(second.items), 120000);
});

test('a different clasp, initial, bundle or custom choice is a separate line', () => {
  reset();
  cart.addItem(design());

  cart.addItem(design({
    selections: { addon: ['pearl'], clasp: ['black'] },
    configuration: {
      base: { id: 'jisoo', name: 'Jisoo', price: 45000 },
      addons: [{ id: 'pearl', name: 'Pearl drop', price: 8000 }],
      initial: '',
      clasp: { id: 'black', name: 'Black clasp', price: 5000 },
    },
    total: 58000,
  }));

  cart.addItem(design({
    selections: { addon: ['pearl', 'initial'], clasp: ['silver'] },
    configuration: {
      base: { id: 'jisoo', name: 'Jisoo', price: 45000 },
      addons: [{ id: 'pearl', name: 'Pearl drop', price: 8000 }, { id: 'initial', name: 'Your initial', price: 5000 }],
      initial: 'A',
      clasp: { id: 'silver', name: 'Silver clasp', price: 7000 },
    },
    total: 65000,
  }));

  cart.addItem(design({
    bundle: { id: 7, slug: 'duo-paket', name: 'Duo Paket', price: 60000, freeAddonQuota: 1 },
    total: 67000,
  }));

  const items = cart.readCart();
  assert.equal(items.length, 4, 'each distinct configuration keeps its own cartItemId');
  assert.equal(new Set(items.map((item) => item.cartItemId)).size, 4);
  assert.equal(cart.count(items), 4);
});

test('the fingerprint ignores the order choices were made in', () => {
  const a = design({ selections: { addon: ['pearl', 'initial'], clasp: ['silver'] } });
  const b = design({ selections: { addon: ['initial', 'pearl'], clasp: ['silver'] } });
  assert.equal(cart.fingerprint(cart.addItem(a).items[0]), cart.fingerprint(b));
});

test('quantity changes and removal rewrite the saved cart', () => {
  reset();
  const added = cart.addItem(design());
  const id = added.items[0].cartItemId;

  cart.setQuantity(id, 3);
  assert.equal(cart.readCart()[0].quantity, 3);

  cart.setQuantity(id, 0);
  assert.equal(cart.readCart().length, 0, 'zero removes the line');
});

test('clearCart empties the cart but never the direct-checkout snapshot', () => {
  reset();
  cart.addItem(design());
  cart.writeDirectCheckout(design({ total: 58000 }));

  cart.clearCart();
  assert.equal(cart.readCart().length, 0);
  const direct = cart.readDirectCheckout();
  assert.ok(direct, 'buy now keeps its own key');
  assert.equal(direct.total, 58000);

  cart.clearDirectCheckout();
  assert.equal(cart.readDirectCheckout(), null);
});

test('a base64 image is dropped so the cart only ever stores URLs', () => {
  reset();
  const added = cart.addItem(design({ previewImage: 'data:image/png;base64,AAAA' }));
  assert.equal(added.items[0].imageUrl, '', 'a data URL is never copied into storage');
});

test('reconciliation reprices a line from the live catalogue and says so', () => {
  reset();
  cart.addItem(design({ total: 50000, unitPrice: 50000 }));

  const result = cart.reconcileCartWithCatalog(cart.readCart(), catalog());
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].unitPrice, 60000, '45.000 base + 8.000 pearl + 7.000 clasp');
  assert.match(result.notices.join(' '), /price updated to Rp60\.000/);
  assert.equal(cart.readCart()[0].unitPrice, 60000, 'the corrected price is written back');
});

test('reconciliation drops a design the dashboard switched off', () => {
  reset();
  cart.addItem(design());
  cart.addItem(design({ member: { id: 6, slug: 'lisa', name: 'Lisa' }, selections: { addon: [], clasp: ['silver'] } }));

  const live = catalog();
  const result = cart.reconcileCartWithCatalog(cart.readCart(), live);
  assert.equal(result.items.length, 1);
  assert.match(result.notices.join(' '), /Lisa Keychain is no longer available/);
});

test('reconciliation strips a dead option and keeps the rest of the line', () => {
  reset();
  cart.addItem(design({
    selections: { addon: ['pearl'], clasp: ['black'] },
    configuration: {
      base: { id: 'jisoo', name: 'Jisoo', price: 45000 },
      addons: [{ id: 'pearl', name: 'Pearl drop', price: 8000 }],
      initial: '',
      clasp: { id: 'black', name: 'Black clasp', price: 5000 },
    },
    total: 58000,
  }));

  const live = catalog();
  live.options.items = live.options.items.filter((item) => item.key !== 'black');

  const result = cart.reconcileCartWithCatalog(cart.readCart(), live);
  assert.equal(result.items.length, 1, 'the design itself is still orderable');
  assert.deepEqual(result.items[0].selections.clasp || [], []);
  assert.equal(result.items[0].configuration.clasp, null, 'the dead clasp is no longer in the snapshot');
  assert.equal(result.items[0].unitPrice, 53000, '45.000 base + 8.000 pearl, no clasp');
  assert.match(result.notices.join(' '), /no longer available/);
});

test('reconciliation drops a dead custom category and a dead bundle', () => {
  reset();
  cart.addItem(design({
    selections: { addon: ['pearl'], clasp: ['silver'], 'silicone-strap': ['strap-white'] },
    bundle: { id: 9, slug: 'gone', name: 'Gone Paket', price: 50000 },
    total: 70000,
  }));

  const result = cart.reconcileCartWithCatalog(cart.readCart(), catalog());
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].bundle, null, 'a bundle that no longer exists is stripped');
  assert.equal(result.items[0].selections['silicone-strap'], undefined);
  assert.equal(result.items[0].unitPrice, 60000, 'the line falls back to base + options');
});

test('reconciliation prices a live bundle at the bundle price', () => {
  reset();
  cart.addItem(design({
    bundle: { id: 7, slug: 'duo-paket', name: 'Duo Paket', price: 60000, freeAddonQuota: 1 },
    total: 67000,
  }));

  const result = cart.reconcileCartWithCatalog(cart.readCart(), catalog());
  // 60.000 bundle (the pearl is free inside the quota) + 7.000 clasp
  assert.equal(result.items[0].unitPrice, 67000);
  assert.equal(result.notices.length, 0);
});

test('the cart falls back to memory when localStorage throws', () => {
  const modulePath = require.resolve('../src/cart.js');
  const previous = globalThis.localStorage;
  delete require.cache[modulePath];
  globalThis.localStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };

  try {
    const fallback = require('../src/cart.js');
    const added = fallback.addItem(design());
    assert.equal(added.items.length, 1, 'the in-memory cart still works');
    assert.equal(fallback.readCart()[0].quantity, 1);
    fallback.clearCart();
    assert.equal(fallback.readCart().length, 0);
  } finally {
    globalThis.localStorage = previous;
    delete require.cache[modulePath];
    require('../src/cart.js');
  }
});

test('the drawer markup is present in the shared shell contract', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const shell = fs.readFileSync(path.join(root, 'src', 'site-shell.js'), 'utf8');
  const cartSource = fs.readFileSync(path.join(root, 'src', 'cart.js'), 'utf8');

  assert.match(shell, /id="cartButton"/, 'every page gets the cart button from the shared header');
  assert.match(shell, /id="cartCount"/, 'the badge is part of the header');
  for (const marker of ['id="cartDrawer"', 'data-cart-step', 'data-cart-remove', 'checkout.html']) {
    assert.ok(cartSource.includes(marker), `the drawer renders ${marker}`);
  }
  assert.match(cartSource, /addEventListener\('storage'/, 'other tabs keep the badge in sync');
});

test('every storefront page loads the cart module before its own script', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');

  for (const page of ['index.html', 'shop.html', 'artist.html', 'studio.html', 'checkout.html', 'payment.html', 'order-success.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.ok(html.includes('src="src/cart.js"'), `${page} must load the shared cart`);
    assert.ok(html.includes('src="src/pricing.js"'), `${page} needs the shared pricing module for the cart total`);
    assert.ok(html.indexOf('src="src/cart.js"') < html.indexOf('src="src/site-shell.js"'), `${page} loads the cart before the shell`);
  }
});
