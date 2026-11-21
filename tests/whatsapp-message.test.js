const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  VERIFICATION_TEMPLATE,
  buildVerificationMessage,
  buildOrderItemLines,
  buildChatUrl,
  buildCodMessage,
  buildStorefrontChatUrl,
  normalizeWhatsAppNumber,
  DEFAULT_WHATSAPP_NUMBER,
} = require('../src/whatsapp.js');

const root = path.join(__dirname, '..');
const EXPECTED = 'halo kak ingin memverifikasi pembelian dan pembayaran dengan nomor order : ';

test('the verification message matches the agreed template exactly', () => {
  assert.equal(
    buildVerificationMessage('LX-MWKHBLXN-811BB2'),
    `${EXPECTED}LX-MWKHBLXN-811BB2`,
  );
  assert.equal(VERIFICATION_TEMPLATE, `${EXPECTED}{orderNumber}`);
});

test('order numbers are trimmed, and a missing one falls back to the demo reference', () => {
  assert.equal(buildVerificationMessage('  LX-ABC-1  '), `${EXPECTED}LX-ABC-1`);
  assert.equal(buildVerificationMessage(''), `${EXPECTED}LX-DEMO`);
  assert.equal(buildVerificationMessage(null), `${EXPECTED}LX-DEMO`);
});

test('the chat link targets the configured number and encodes the message', () => {
  const message = buildVerificationMessage('LX-42');
  const link = buildChatUrl('6281282116351', message);

  assert.ok(link.startsWith('https://wa.me/6281282116351?text='), link);
  assert.doesNotMatch(link, / /, 'spaces must be encoded');
  assert.match(link, /%3A/, 'the colon before the order number must be encoded');

  const parsed = new URL(link);
  assert.equal(parsed.pathname, '/6281282116351');
  assert.equal(parsed.searchParams.get('text'), message, 'the decoded text must equal the template');
});

test('a formatted number is normalised, and a missing one falls back to the share sheet', () => {
  assert.ok(buildChatUrl('+62 812-8211-6351', 'x').startsWith('https://wa.me/6281282116351?text='));
  assert.equal(buildChatUrl('', 'x'), 'https://wa.me/?text=x');
  assert.equal(buildChatUrl('123', 'x'), 'https://wa.me/?text=x');
});

test('local Indonesian numbers never produce a broken or relative wa.me URL', () => {
  for (const input of ['0812-8211-6351', '81282116351', '0062 812 8211 6351', '+62 812 8211 6351']) {
    assert.equal(normalizeWhatsAppNumber(input), '6281282116351', input);
  }
  for (const input of [0, null, undefined, '', 'not a number', '0812']) {
    assert.equal(normalizeWhatsAppNumber(input), '', String(input));
  }

  const url = buildChatUrl('081282116351', 'halo');
  assert.match(url, /^https:\/\/wa\.me\/6281282116351\?text=halo$/);
  assert.ok(!url.includes('index.html') && !url.startsWith('/'), 'links are always absolute');
});

test('the COD message carries the saved order and asks for confirmation', () => {
  const message = buildCodMessage({
    orderNumber: 'LX-COD-1',
    name: 'Ayu Lestari',
    phone: '081234567890',
    artist: 'BLACKPINK',
    member: 'Jisoo',
    configuration: 'Heart · Black clasp',
    addons: 'Pearl drop, Initial A',
    bundle: 'Paket Duo',
    quantity: 1,
    fulfillment: 'COD / Ketemuan — Telkom University Jakarta',
    address: 'Jl. Merdeka 10, Bandung',
    total: 'Rp53.000',
  });

  assert.match(message, /Halo admin LOCOXATL!/);
  assert.match(message, /Order: LX-COD-1/);
  assert.match(message, /Nama: Ayu Lestari/);
  assert.match(message, /No\. WhatsApp: 081234567890/);
  assert.match(message, /Koleksi: BLACKPINK/);
  assert.match(message, /Member: Jisoo/);
  assert.match(message, /Konfigurasi: Heart · Black clasp/);
  assert.match(message, /Add-ons: Pearl drop, Initial A/);
  assert.match(message, /Paket: Paket Duo/);
  assert.match(message, /Jumlah: 1/);
  assert.match(message, /Pengiriman: COD \/ Ketemuan/);
  assert.match(message, /Total: Rp53\.000/);
  assert.match(message, /Metode pembayaran: COD\./);
  assert.match(message, /Mohon konfirmasi/);
});

test('both storefront pages use the shared template instead of their own copy', () => {
  const pages = [
    ['payment.js', fs.readFileSync(path.join(root, 'src', 'payment.js'), 'utf8')],
    ['success.js', fs.readFileSync(path.join(root, 'src', 'success.js'), 'utf8')],
  ];

  for (const [name, source] of pages) {
    assert.match(source, /buildVerificationMessage/, `${name} must use the shared template`);
    assert.match(source, /buildStorefrontChatUrl/, `${name} must use the storefront chat-link builder`);
    assert.doesNotMatch(source, /Halo LOCOXATL/, `${name} must not keep the old message body`);
  }

  assert.match(fs.readFileSync(path.join(root, 'payment.html'), 'utf8'), /src\/whatsapp\.js/);
  assert.match(fs.readFileSync(path.join(root, 'order-success.html'), 'utf8'), /src\/whatsapp\.js/);
});

test('the storefront chat link always targets a real number', () => {
  assert.ok(
    buildStorefrontChatUrl({ whatsappNumber: '628111111111' }, 'x').startsWith('https://wa.me/628111111111?text='),
    'the configured number wins',
  );
  for (const config of [null, undefined, {}, { whatsappNumber: '' }]) {
    const url = buildStorefrontChatUrl(config, 'x');
    assert.ok(
      url.startsWith(`https://wa.me/${DEFAULT_WHATSAPP_NUMBER}?text=`),
      'a missing configuration still resolves the shop number',
    );
    assert.ok(!url.includes('wa.me/?'), 'the generic share sheet is never used');
  }
});

test('a multi-item order lists every line with its quantity, configuration and total', () => {
  const items = [
    { name: 'Jisoo Keychain', quantity: 2, configuration: 'Pearl drop · Silver clasp', total: 104000 },
    { name: 'Lisa Keychain', quantity: 1, configuration: 'Mini star · Black clasp', total: 57000 },
  ];

  const lines = buildOrderItemLines(items);
  assert.deepEqual(lines, [
    '1. Jisoo Keychain (×2) — Pearl drop · Silver clasp — Rp104.000',
    '2. Lisa Keychain — Mini star · Black clasp — Rp57.000',
  ]);

  const message = buildVerificationMessage('LX-MULTI-1', items, 161000);
  assert.ok(message.startsWith(EXPECTED + 'LX-MULTI-1'), 'the agreed template still opens the message');
  assert.match(message, /1\. Jisoo Keychain \(×2\) — Pearl drop · Silver clasp — Rp104\.000/);
  assert.match(message, /2\. Lisa Keychain — Mini star · Black clasp — Rp57\.000/);
  assert.match(message, /Total: Rp161\.000/);
});

test('a single-item message keeps the bare template', () => {
  const message = buildVerificationMessage('LX-ONE-1', [{ name: 'Jisoo Keychain', quantity: 1 }], 60000);
  assert.match(message, /1\. Jisoo Keychain/);
  assert.doesNotMatch(message, /×1/, 'a quantity of one is not printed');
  assert.match(message, /Total: Rp60\.000/);

  assert.equal(buildVerificationMessage('LX-ONE-1', [], 60000), `${EXPECTED}LX-ONE-1`);
  assert.equal(buildVerificationMessage('LX-ONE-1'), `${EXPECTED}LX-ONE-1`);
});

test('the COD message prints the numbered order instead of a single design', () => {
  const message = buildCodMessage({
    orderNumber: 'LX-COD-2',
    name: 'Ayu Lestari',
    phone: '081234567890',
    items: [
      { name: 'Jisoo Keychain', quantity: 2, configuration: 'Pearl drop · Silver clasp', total: 104000 },
      { name: 'Lisa Keychain', quantity: 1, configuration: 'Black clasp', total: 50000 },
    ],
    fulfillment: 'COD / Ketemuan',
    address: 'Jl. Merdeka 10',
    total: 'Rp154.000',
  });

  assert.match(message, /Pesanan:/);
  assert.match(message, /1\. Jisoo Keychain \(×2\) — Pearl drop · Silver clasp — Rp104\.000/);
  assert.match(message, /2\. Lisa Keychain — Black clasp — Rp50\.000/);
  assert.match(message, /Total: Rp154\.000/);
  assert.match(message, /Metode pembayaran: COD\./);
  assert.doesNotMatch(message, /Member:/, 'the numbered list replaces the single-design fields');
});
