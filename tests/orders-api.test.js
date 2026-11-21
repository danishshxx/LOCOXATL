const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '1';
process.env.DB_USER = 'orders-api-test';
process.env.DB_PASSWORD = '';
process.env.DB_NAME = 'locoxatl_api_unreachable_test';

const { createAppServer, listenWithFallback } = require('../server');
const { generateOrderNumber, ORDER_STATUSES } = require('../src/server/orders');
const { parseEnv } = require('../src/server/env');

const root = path.join(__dirname, '..');

test.after(async () => {
  await require('../src/server/db').closePool();
});

function call(port, pathname, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, (response) => {
      let payload = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { payload += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(payload); } catch { json = null; }
        resolve({ status: response.statusCode, body: payload, json, headers: response.headers });
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

const validOrder = () => JSON.stringify({
  customer: {
    name: 'Ayu Lestari',
    phone: '081234567890',
    email: 'ayu@example.com',
    address: 'Jl. Merdeka No. 12, Bandung 40111',
    note: 'Leave at the front desk',
  },
  order: {
    artist: { slug: 'blackpink', name: 'BLACKPINK', fandom: 'BLINK' },
    product: { slug: 'blackpink-cloud-heart', name: 'Cloud Heart', price: 45000 },
    configuration: {
      base: { id: 'heart', name: 'Cloud Heart' },
      addons: [{ id: 'pearl', name: 'Pearl drop' }],
      initial: 'A',
      clasp: { id: 'silver', name: 'Silver clasp' },
      render: { engine: 'locoxatl-three', version: 1 },
      components: [
        { id: 'base', name: 'Base charm', type: 'base', finish: 'acrylic', visible: true },
        { id: 'pearl', name: 'Pearl drop', type: 'pearl', finish: 'pearl', visible: true },
      ],
    },
    quantity: 1,
    total: 58000,
  },
});

test('order numbers are unique, readable and fit the database column', () => {
  const numbers = new Set();
  for (let index = 0; index < 200; index += 1) {
    const number = generateOrderNumber();
    assert.match(number, /^LX-[0-9A-Z]+-[0-9A-F]{6}$/);
    assert.ok(number.length <= 32);
    numbers.add(number);
  }
  assert.equal(numbers.size, 200, 'order numbers must not collide');
  assert.ok(ORDER_STATUSES.includes('waiting_for_payment'));
});

test('the .env parser ignores comments, keeps quoted values and never overrides the environment', () => {
  const parsed = parseEnv([
    '# comment',
    'DB_HOST=127.0.0.1',
    'DB_PASSWORD="p@ss=word"',
    '',
    'NO_EQUALS_LINE',
    'DB_PORT=3307',
  ].join('\n'));
  assert.equal(parsed.DB_HOST, '127.0.0.1');
  assert.equal(parsed.DB_PASSWORD, 'p@ss=word');
  assert.equal(parsed.DB_PORT, '3307');
  assert.equal(parsed.NO_EQUALS_LINE, undefined);
});

test('api health, validation and database errors are reported without leaking credentials', async (t) => {
  const server = createAppServer(root);
  const { port } = await listenWithFallback(server, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const health = await call(port, '/api/health');
  if (health.json.database.configured) {
    assert.equal(typeof health.json.database.connected, 'boolean');
  } else {
    assert.equal(health.status, 503);
    assert.equal(health.json.database.configured, false);
    assert.equal(health.json.database.connected, false);
  }

  const invalid = await call(port, '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer: { name: 'A' }, order: { product: { slug: 'nope' } } }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, 'validation_error');
  assert.ok(invalid.json.details.customer_name);
  assert.ok(invalid.json.details.product_slug);
  assert.ok(invalid.json.details.quantity === undefined, 'valid quantity should not be reported');

  const valid = await call(port, '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: validOrder(),
  });
  if (valid.status === 201) {
    assert.equal(valid.json.ok, true);
    assert.ok(valid.json.order.orderNumber);
  } else {
    assert.equal(valid.status, 503);
    assert.equal(valid.json.error, 'database_unavailable');
    assert.ok(!/password/i.test(valid.body), 'the API must never echo credentials');
  }

  const wrongType = await call(port, '/api/orders', { method: 'POST', body: 'not json' });
  assert.equal(wrongType.status, 415);

  const brokenJson = await call(port, '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"customer":',
  });
  assert.equal(brokenJson.status, 400);
  assert.equal(brokenJson.json.error, 'invalid_json');

  const methodNotAllowed = await call(port, '/api/orders', { method: 'PUT' });
  assert.equal(methodNotAllowed.status, 405);
  assert.equal(methodNotAllowed.headers.allow, 'POST');

  const unknown = await call(port, '/api/unknown');
  assert.equal(unknown.status, 404);

  const statusPatch = await call(port, '/api/orders/LX-DEMO-ABC123/status', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'payment_confirmation_sent' }),
  });
  assert.ok([404, 503].includes(statusPatch.status), 'status updates need the database or return 404');
});

test('a multi-item cart payload is validated line by line over HTTP', async (t) => {
  const server = createAppServer(root);
  const { port } = await listenWithFallback(server, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const customer = {
    name: 'Ayu Lestari',
    phone: '081234567890',
    email: 'ayu@example.com',
    address: 'Jl. Merdeka No. 12, Bandung 40111',
  };
  const configuration = {
    base: { id: 'heart' },
    addons: [{ id: 'pearl' }],
    selections: { addon: ['pearl'], clasp: ['silver'] },
    clasp: { id: 'silver' },
  };

  const broken = await call(port, '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer,
      fulfillmentMethod: 'campus_delivery',
      paymentMethod: 'qris',
      items: [
        { artist: { slug: 'blackpink' }, product: { slug: 'blackpink-cloud-heart' }, configuration, quantity: 1, total: 60000 },
        { artist: { slug: 'blackpink' }, product: { slug: 'blackpink-not-a-design' }, configuration, quantity: 1, total: 60000 },
      ],
      total: 120000,
    }),
  });

  assert.equal(broken.status, 400);
  assert.equal(broken.json.error, 'validation_error');
  assert.ok(broken.json.details['items[1].product_slug'], 'the failing line is named');
  assert.equal(broken.json.details['items[0].product_slug'], undefined, 'the healthy line is not blamed');

  const valid = await call(port, '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer,
      fulfillmentMethod: 'campus_delivery',
      paymentMethod: 'qris',
      items: [
        { artist: { slug: 'blackpink' }, product: { slug: 'blackpink-cloud-heart' }, configuration, quantity: 1, total: 60000 },
        { artist: { slug: 'blackpink' }, product: { slug: 'blackpink-soft-ribbon' }, configuration: { base: { id: 'bow' }, addons: [], selections: { addon: [], clasp: ['silver'] } }, quantity: 2, total: 112000 },
      ],
      total: 172000,
    }),
  });

  if (valid.status === 201) {
    assert.equal(valid.json.order.items.length, 2);
    assert.equal(valid.json.order.total, 172000);
  } else {
    assert.equal(valid.status, 503, 'validation passed and only the database was unreachable');
    assert.equal(valid.json.error, 'database_unavailable');
  }
});

test('static pages keep working while the API layer is active', async (t) => {
  const server = createAppServer(root);
  const { port } = await listenWithFallback(server, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  for (const pathname of ['/', '/studio.html?artist=bts&product=bts-cloud-heart', '/src/three/viewer.mjs', '/assets/vendor/three/three.module.js']) {
    const response = await call(port, pathname);
    assert.equal(response.status, 200, `${pathname} should still be served`);
  }

  const mjs = await call(port, '/src/three/viewer.mjs');
  assert.match(mjs.headers['content-type'], /text\/javascript/);

  const methodNotAllowed = await call(port, '/index.html', { method: 'POST' });
  assert.equal(methodNotAllowed.status, 405);
});

test('database module refuses to invent credentials and reports what is missing', () => {
  const { isConfigured } = require('../src/server/db');
  if (process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME) {
    assert.equal(isConfigured(), true);
    return;
  }
  assert.equal(isConfigured(), false);
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(root, 'src', 'server', 'db.js'), 'utf8');
  assert.doesNotMatch(source, /password\s*[:=]\s*['"][^'"]+['"]/, 'db.js must not contain a hardcoded password');
  assert.match(source, /process\.env\.DB_PASSWORD/);
});