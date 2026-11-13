const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

test('publishes separate pages for the complete customer journey', () => {
  for (const page of ['index.html', 'shop.html', 'artist.html', 'studio.html', 'checkout.html', 'payment.html', 'order-success.html']) {
    assert.ok(exists(page), `${page} should exist`);
  }
});

test('homepage introduces the brand and sends shopping intent to artist collections', () => {
  const html = read('index.html');
  assert.match(html, /Meet LOCOXATL/i);
  assert.match(html, /href="shop\.html"[^>]*>\s*(?:Buy Now|Shop the collection)/i);
  assert.doesNotMatch(html, /id="customStudio"|id="productGrid"/);
});

test('artist directory links to artist-specific product collections', () => {
  const html = read('shop.html');
  assert.match(html, /artist\.html\?artist=/);
  assert.match(html, /BLACKPINK/);
  assert.match(html, /SEVENTEEN/);
});

test('artist product page carries selected artist and product into custom studio', () => {
  const html = read('artist.html');
  assert.match(html, /studio\.html\?artist=/);
  assert.match(html, /data-product=/);
});

test('custom studio sends the selected configuration directly to checkout', () => {
  const html = read('studio.html');
  const script = read('src/studio.js');
  assert.match(html, /id="continueToCheckout"/);
  assert.match(script, /checkout\.html/);
  assert.match(script, /locoxatl-pending-order/);
});

test('checkout advances to payment and payment page provides QRIS and WhatsApp confirmation flow', () => {
  const checkout = read('checkout.html');
  const checkoutScript = read('src/checkout.js');
  const payment = read('payment.html');
  const paymentScript = read('src/payment.js');
  assert.match(checkout, /id="checkoutForm"/);
  assert.match(checkoutScript, /payment\.html/);
  assert.match(payment, /QRIS/i);
  assert.match(payment, /wa\.me/);
  assert.match(paymentScript, /order-success\.html/);
});

test('catalog data contains unique artist and product slugs', () => {
  const catalog = require('../src/catalog.js');
  const artistSlugs = catalog.artists.map((artist) => artist.slug);
  const productSlugs = catalog.products.map((product) => product.slug);
  assert.equal(new Set(artistSlugs).size, artistSlugs.length);
  assert.equal(new Set(productSlugs).size, productSlugs.length);
  assert.ok(artistSlugs.includes('blackpink'));
  assert.ok(productSlugs.includes('blackpink-cloud-heart'));
  assert.equal(catalog.getProductsByArtist('blackpink').length, 3);
  assert.equal(catalog.getProductsByArtist('bts').length, 3);
});
