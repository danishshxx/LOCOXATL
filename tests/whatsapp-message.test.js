const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  VERIFICATION_TEMPLATE,
  buildVerificationMessage,
  buildChatUrl,
  buildCodMessage,
  normalizeWhatsAppNumber,
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
    assert.match(source, /buildChatUrl/, `${name} must use the shared chat-link builder`);
    assert.doesNotMatch(source, /Halo LOCOXATL/, `${name} must not keep the old message body`);
  }

  assert.match(fs.readFileSync(path.join(root, 'payment.html'), 'utf8'), /src\/whatsapp\.js/);
  assert.match(fs.readFileSync(path.join(root, 'order-success.html'), 'utf8'), /src\/whatsapp\.js/);
});
