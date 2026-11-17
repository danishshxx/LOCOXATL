const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { VERIFICATION_TEMPLATE, buildVerificationMessage, buildChatUrl } = require('../src/whatsapp.js');

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
