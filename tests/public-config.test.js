const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createAppServer, listenWithFallback } = require('../server');
const { getPublicConfig, normalizeWhatsAppNumber, validateInstagramUrl } = require('../src/server/public-config');

test('normalizes valid Indonesian WhatsApp number formats and rejects invalid input', () => {
  assert.equal(normalizeWhatsAppNumber('0812 3456-7890'), '6281234567890');
  assert.equal(normalizeWhatsAppNumber('+62 (812) 3456-7890'), '6281234567890');
  assert.equal(normalizeWhatsAppNumber('6281234567890'), '6281234567890');
  assert.equal(normalizeWhatsAppNumber('whatsapp: 081234567890'), null);
  assert.equal(normalizeWhatsAppNumber('123'), null);
});

test('accepts only HTTPS Instagram profile URLs', () => {
  assert.equal(validateInstagramUrl('https://www.instagram.com/locoxatl/'), 'https://www.instagram.com/locoxatl/');
  assert.equal(validateInstagramUrl('http://www.instagram.com/locoxatl'), null);
  assert.equal(validateInstagramUrl('https://instagram.com.evil.example/locoxatl'), null);
  assert.equal(validateInstagramUrl('https://www.instagram.com/'), null);
});

test('public config contains only validated contact details', () => {
  assert.deepEqual(getPublicConfig({
    WHATSAPP_BUSINESS_NUMBER: '0812-3456-7890',
    INSTAGRAM_URL: 'https://www.instagram.com/locoxatl/',
    ADMIN_PASSWORD: 'not-public',
  }), {
    whatsappNumber: '6281234567890',
    instagramUrl: 'https://www.instagram.com/locoxatl/',
  });
});

test('shared footer renders the configured WhatsApp and Instagram contacts', async () => {
  const footerTarget = { innerHTML: '' };
  const elements = {
    whatsappContactLink: { hidden: true, href: '' },
    whatsappContactNumber: { textContent: '' },
    instagramProfileLink: { hidden: true, href: '' },
    footerContactStatus: { hidden: true, textContent: '' },
  };
  const context = {
    document: {
      querySelector: (selector) => selector === '[data-site-footer]' ? footerTarget : null,
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
    },
    window: {},
    fetch: async () => ({
      ok: true,
      json: async () => ({ whatsappNumber: '6281234567890', instagramUrl: 'https://www.instagram.com/locoxatl/' }),
    }),
  };

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'site-shell.js'), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(footerTarget.innerHTML, /Our story[\s\S]*Collections[\s\S]*Buy Now/);
  assert.doesNotMatch(footerTarget.innerHTML, />Contact</);
  assert.match(footerTarget.innerHTML, /footer-instagram-icon/);
  assert.match(footerTarget.innerHTML, /target="_blank" rel="noopener noreferrer"/);
  assert.equal(elements.whatsappContactLink.href, 'https://wa.me/6281234567890');
  assert.equal(elements.whatsappContactNumber.textContent, '+6281234567890');
  assert.equal(elements.whatsappContactLink.hidden, false);
  assert.equal(elements.instagramProfileLink.href, 'https://www.instagram.com/locoxatl/');
  assert.equal(elements.instagramProfileLink.hidden, false);
  assert.equal(elements.footerContactStatus.hidden, true);
});

test('shared footer explains when WhatsApp and Instagram configuration is missing', async () => {
  const footerTarget = { innerHTML: '' };
  const elements = {
    whatsappContactLink: { hidden: true, href: '' },
    whatsappContactNumber: { textContent: '' },
    instagramProfileLink: { hidden: true, href: '' },
    footerContactStatus: { hidden: true, textContent: '' },
  };
  const context = {
    document: {
      querySelector: (selector) => selector === '[data-site-footer]' ? footerTarget : null,
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
    },
    window: {},
    fetch: async () => ({ ok: true, json: async () => ({ whatsappNumber: null, instagramUrl: null }) }),
  };

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'site-shell.js'), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.whatsappContactLink.hidden, true);
  assert.equal(elements.instagramProfileLink.hidden, true);
  assert.match(elements.footerContactStatus.textContent, /WhatsApp contact is not configured/);
  assert.match(elements.footerContactStatus.textContent, /Instagram profile is not configured/);
  assert.equal(elements.footerContactStatus.hidden, false);
});

function request(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    http.request({ hostname: '127.0.0.1', port, path: pathname, method }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
    }).on('error', reject).end();
  });
}

test('public config API exposes contacts but no server credentials', async (t) => {
  const previousNumber = process.env.WHATSAPP_BUSINESS_NUMBER;
  const previousInstagram = process.env.INSTAGRAM_URL;
  process.env.WHATSAPP_BUSINESS_NUMBER = '0812 3456 7890';
  process.env.INSTAGRAM_URL = 'https://www.instagram.com/locoxatl/';
  t.after(() => {
    if (previousNumber === undefined) delete process.env.WHATSAPP_BUSINESS_NUMBER;
    else process.env.WHATSAPP_BUSINESS_NUMBER = previousNumber;
    if (previousInstagram === undefined) delete process.env.INSTAGRAM_URL;
    else process.env.INSTAGRAM_URL = previousInstagram;
  });

  const server = createAppServer(path.join(__dirname, '..'));
  const { port } = await listenWithFallback(server, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await request(port, '/api/public-config');
  assert.equal(result.status, 200);
  assert.match(result.headers['cache-control'], /no-store/);
  assert.deepEqual(JSON.parse(result.body), {
    whatsappNumber: '6281234567890',
    instagramUrl: 'https://www.instagram.com/locoxatl/',
  });
  assert.doesNotMatch(result.body, /ADMIN_PASSWORD|DB_PASSWORD|not-public/);
  assert.equal((await request(port, '/api/public-config', 'POST')).status, 405);
});

test('success page creates a complete encoded WhatsApp message and retains copy fallback', async () => {
  const ids = ['successOrderNumber', 'successStatus', 'successMessage', 'successWhatsApp', 'copyOrderMessage', 'successActionStatus', 'orderMessageFallback'];
  const elements = Object.fromEntries(ids.map((id) => [id, {
    textContent: '',
    href: '',
    attributes: {},
    addEventListener(name, callback) { this[`on${name}`] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] || null; },
    removeAttribute(name) { delete this.attributes[name]; },
  }]));
  const order = {
    orderNumber: 'LX-ORDER-42',
    status: 'payment_confirmation_sent',
    customer: { name: 'Ayu Lestari' },
    artist: { name: 'BLACKPINK' },
    product: { name: 'Cloud Heart' },
    configuration: { base: { name: 'Heart' }, addons: [{ name: 'Pearl drop' }], initial: 'A', clasp: { name: 'Silver clasp' } },
    quantity: 2,
    total: 116000,
  };
  let copiedMessage = '';
  const context = {
    document: { getElementById: (id) => elements[id] },
    localStorage: { getItem: () => JSON.stringify(order) },
    window: { location: { search: '?order=LX-ORDER-42' }, locoxatlPublicConfig: Promise.resolve({ whatsappNumber: '6281234567890' }), isSecureContext: true },
    navigator: { clipboard: { writeText: async (value) => { copiedMessage = value; } } },
    URLSearchParams,
    Intl,
    fetch: () => { throw new Error('Public config should be reused from the site shell.'); },
  };

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'success.js'), 'utf8'), context);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(elements.successWhatsApp.href.split('?')[0], 'https://wa.me/6281234567890');
  const message = new URL(elements.successWhatsApp.href).searchParams.get('text');
  for (const detail of ['LX-ORDER-42', 'Ayu Lestari', 'BLACKPINK', 'Cloud Heart', 'Heart, Pearl drop, Initial A, Silver clasp', 'Kuantitas: 2', 'Total: Rp116.000']) {
    assert.ok(message.includes(detail), `message should include ${detail}`);
  }
  assert.equal(elements.successWhatsApp.getAttribute('aria-disabled'), null);
  await elements.copyOrderMessage.onclick();
  assert.equal(copiedMessage, message);
  assert.equal(elements.successActionStatus.textContent, 'Order message copied.');
});
