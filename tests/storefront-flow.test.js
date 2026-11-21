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
  assert.match(html, /href="shop\.html"[^>]*>\s*(?:Explore Collections|Buy Now|Shop the collection)/i);
  assert.doesNotMatch(html, /id="customStudio"|id="productGrid"/);
});

test('homepage hero plays the existing brand teaser with a poster and safe settings', () => {
  const html = read('index.html');
  assert.ok(exists('assets/video/LOCOXATL_hero_teaser.mp4'), 'the supplied hero video is kept in the repo');
  assert.ok(exists('assets/video/LOCOXATL_hero_teaser_poster.jpg'), 'a poster frame is shipped');
  assert.match(html, /<video[^>]*class="hero-video"/);
  assert.match(html, /assets\/video\/LOCOXATL_hero_teaser\.mp4/);
  assert.match(html, /poster="assets\/video\/LOCOXATL_hero_teaser_poster\.jpg"/);
  assert.match(html, /autoplay/);
  assert.match(html, /muted/);
  assert.match(html, /loop/);
  assert.match(html, /playsinline/);
  assert.match(html, /preload="metadata"/);
  assert.match(html, /locoxatl-wordmark-white\.png/, 'the hero carries the large brand wordmark');
  assert.match(html, /class="hero-cinema-poster"/, 'a static fallback sits behind the video');
});

test('artist directory links to artist-specific product collections', () => {
  const html = read('shop.html');
  const script = read('src/shop-page.js');
  // Cards are rendered from /api/catalog (with the bundled catalogue as the first paint), so the
  // link shape lives in the page script and no artist name is hardcoded in the markup.
  assert.match(script, /artist\.html\?artist=/);
  assert.match(html, /id="artistGrid"/);
  assert.doesNotMatch(html, /artist\.html\?artist=blackpink/, 'collections must not be hardcoded');
  assert.doesNotMatch(html, /BLACKPINK|SEVENTEEN/, 'collections must not be hardcoded');
});

test('artist member page carries the selected member into the custom studio', () => {
  const html = read('artist.html');
  const script = read('src/artist-page.js');
  // Member cards are rendered from the live catalogue, so the studio link lives in the page
  // script rather than in hardcoded markup.
  assert.match(script, /studio\.html\?artist=/);
  assert.match(script, /member=\$\{encodeURIComponent\(member\.slug\)\}/);
  assert.match(html, /id="artistMemberGrid"/);
  assert.doesNotMatch(html, /id="artistProductGrid"/, 'product design choices are removed');
  assert.doesNotMatch(html, /data-product="blackpink-cloud-heart"/, 'no design may be hardcoded in the page');
});

test('custom studio offers add to cart and a direct checkout that leaves the cart alone', () => {
  const html = read('studio.html');
  const script = read('src/studio.js');
  assert.match(html, /id="continueToCheckout"/);
  assert.match(html, /id="addToCart"/);
  assert.match(script, /checkout\.html\?mode=direct/);
  assert.match(script, /writeDirectCheckout/, 'buy now keeps its own storage key');
  assert.doesNotMatch(html, /id="fulfillmentStep"/, 'fulfillment moved to the checkout page');
});

test('checkout advances to payment and payment page provides QRIS and WhatsApp confirmation flow', () => {
  const checkout = read('checkout.html');
  const checkoutScript = read('src/checkout.js');
  const payment = read('payment.html');
  const paymentScript = read('src/payment.js');
  assert.match(checkout, /id="checkoutForm"/);
  assert.match(checkoutScript, /payment\.html/);
  assert.match(payment, /QRIS/i);
  assert.match(payment, /id="whatsappConfirm"/);
  assert.match(payment, /src\/whatsapp\.js/, 'the page arms its chat link from the shared helper');
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
