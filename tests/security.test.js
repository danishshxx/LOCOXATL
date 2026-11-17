const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The order layer needs a configured pool before the scripted driver below can answer; these
// values are only used to satisfy the configuration check inside src/server/db.js.
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'security-test';
process.env.DB_NAME = process.env.DB_NAME || 'security_test';

const root = path.join(__dirname, '..');

// 1. Static audit: ensure secrets and tokens are never hardcoded or prefilled
test('no hardcoded tokens or default passwords in source files or frontend', () => {
  const filesToCheck = [
    'src/server/api.js',
    'src/server/orders.js',
    'src/server/auth.js',
    'admin.html',
    'src/admin.js',
  ];

  filesToCheck.forEach((rel) => {
    const content = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.doesNotMatch(content, /locoxatl-admin-2026/, `${rel} must not contain default token`);
    assert.doesNotMatch(content, /ADMIN_TOKEN\s*\|\|\s*['"][^'"]+['"]/, `${rel} must not have hardcoded token fallback`);
  });

  const adminHtml = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  assert.doesNotMatch(adminHtml, /<input[^>]+value=/i, 'admin.html inputs must not prefill credentials');
  assert.match(adminHtml, /id="adminUsernameInput"/, 'admin.html must use username input');
  assert.match(adminHtml, /id="adminPasswordInput"/, 'admin.html must use password input');
});

// 2. Customer endpoint lifecycle lockdown
const ordersModule = require('../src/server/orders');

test('customer public endpoint strictly permits ONLY waiting_for_payment -> payment_confirmation_sent', async () => {
  // Mock driver setup
  const MYSQL_PATH = require.resolve('mysql2/promise');
  const mockCalls = [];
  let scriptedRows = [];

  function mockStatement(sql, params) {
    mockCalls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/^UPDATE/i.test(sql)) return [{ affectedRows: 1 }];
    const next = scriptedRows.shift();
    if (next) return next;
    return [[]];
  }

  const fakeDriver = {
    createPool() {
      return {
        execute: mockStatement,
        query: mockStatement,
        async getConnection() {
          return {
            beginTransaction: async () => {},
            commit: async () => {},
            rollback: async () => {},
            release: () => {},
            execute: mockStatement,
            query: mockStatement,
          };
        },
        async end() {},
      };
    },
  };

  require.cache[MYSQL_PATH] = { id: MYSQL_PATH, filename: MYSQL_PATH, loaded: true, exports: fakeDriver };

  // A. Customer transitions from waiting_for_payment:
  // Allowed: payment_confirmation_sent
  scriptedRows = [[[{ id: 10, order_status: 'waiting_for_payment' }]]];
  const ok = await ordersModule.updateOrderStatus('LX-CUST-1', 'payment_confirmation_sent');
  assert.equal(ok.status, 'payment_confirmation_sent');

  // Forbidden: paid (Must throw InvalidTransitionError)
  scriptedRows = [[[{ id: 10, order_status: 'waiting_for_payment' }]]];
  await assert.rejects(
    () => ordersModule.updateOrderStatus('LX-CUST-1', 'paid'),
    (err) => err.code === 'INVALID_TRANSITION',
  );

  // Forbidden: in_production
  scriptedRows = [[[{ id: 10, order_status: 'waiting_for_payment' }]]];
  await assert.rejects(
    () => ordersModule.updateOrderStatus('LX-CUST-1', 'in_production'),
    (err) => err.code === 'INVALID_TRANSITION',
  );

  // Forbidden: shipped
  scriptedRows = [[[{ id: 10, order_status: 'waiting_for_payment' }]]];
  await assert.rejects(
    () => ordersModule.updateOrderStatus('LX-CUST-1', 'shipped'),
    (err) => err.code === 'INVALID_TRANSITION',
  );

  // Forbidden: completed
  scriptedRows = [[[{ id: 10, order_status: 'waiting_for_payment' }]]];
  await assert.rejects(
    () => ordersModule.updateOrderStatus('LX-CUST-1', 'completed'),
    (err) => err.code === 'INVALID_TRANSITION',
  );

  // Forbidden: cancelled
  scriptedRows = [[[{ id: 10, order_status: 'waiting_for_payment' }]]];
  await assert.rejects(
    () => ordersModule.updateOrderStatus('LX-CUST-1', 'cancelled'),
    (err) => err.code === 'INVALID_TRANSITION',
  );

  // B. Customer transitions when order is already 'paid':
  // No customer transition is permitted once paid
  scriptedRows = [[[{ id: 10, order_status: 'paid' }]]];
  await assert.rejects(
    () => ordersModule.updateOrderStatus('LX-CUST-1', 'payment_confirmation_sent'),
    (err) => err.code === 'INVALID_TRANSITION',
  );

  // C. Customer transitions when order is in_production:
  scriptedRows = [[[{ id: 10, order_status: 'in_production' }]]];
  await assert.rejects(
    () => ordersModule.updateOrderStatus('LX-CUST-1', 'cancelled'),
    (err) => err.code === 'INVALID_TRANSITION',
  );
});

// 3. Scrypt password hashing & validation
const authModule = require('../src/server/auth');

test('scrypt hashing produces salted hashes and verifies timing-safely', async () => {
  const password = 'my-super-secure-admin-pass-2026';
  const hash = await authModule.hashPassword(password);

  assert.match(hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);

  // Correct password matches
  const match = await authModule.verifyPassword(password, hash);
  assert.equal(match, true);

  // Incorrect password rejected
  const wrongMatch = await authModule.verifyPassword('wrong-password', hash);
  assert.equal(wrongMatch, false);

  // Empty or malformed hash rejected
  assert.equal(await authModule.verifyPassword(password, ''), false);
  assert.equal(await authModule.verifyPassword(password, 'invalid-hash'), false);
});

// 4. API layer unauthorized access rejection
const { handleApiRequest } = require('../src/server/api');

function mockHttp(method, pathname, { headers = {}, body = null } = {}) {
  const req = {
    method,
    headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
    on(event, handler) {
      if (event === 'data' && body) handler(Buffer.from(JSON.stringify(body)));
      if (event === 'end') handler();
      return req;
    },
    destroy() {},
  };
  let statusCode = 200;
  let headersSent = {};
  let payload = '';
  const res = {
    writeHead(status, hdrs) {
      statusCode = status;
      headersSent = { ...headersSent, ...hdrs };
    },
    end(data) {
      payload = data || '';
    },
    get writableEnded() { return Boolean(payload || statusCode); },
  };
  const url = new URL(pathname, 'http://localhost');
  return {
    req,
    res,
    url,
    result: () => ({ status: statusCode, body: payload ? JSON.parse(payload) : null, headers: headersSent }),
  };
}

test('all admin API endpoints strictly reject unauthenticated requests with 401', async () => {
  const protectedEndpoints = [
    { method: 'GET', path: '/api/admin/metrics' },
    { method: 'GET', path: '/api/admin/orders' },
    { method: 'GET', path: '/api/admin/orders/LX-DEMO-123' },
    { method: 'PATCH', path: '/api/admin/orders/LX-DEMO-123/status', body: { status: 'paid' } },
    { method: 'PATCH', path: '/api/admin/orders/LX-DEMO-123/notes', body: { adminNotes: 'test' } },
    { method: 'GET', path: '/api/admin/auth/verify' },
  ];

  for (const ep of protectedEndpoints) {
    const originHeaders = ['GET', 'HEAD', 'OPTIONS'].includes(ep.method)
      ? {}
      : { origin: 'http://localhost' };
    // A. No token or cookie provided
    const noAuth = mockHttp(ep.method, ep.path, { body: ep.body, headers: originHeaders });
    await handleApiRequest(noAuth.req, noAuth.res, noAuth.url);
    const r1 = noAuth.result();
    assert.equal(r1.status, 401, `${ep.method} ${ep.path} must return 401 without auth`);

    // B. Forged/invalid session token provided
    const fakeAuth = mockHttp(ep.method, ep.path, {
      body: ep.body,
      headers: {
        ...originHeaders,
        authorization: 'Bearer 0000000000000000000000000000000000000000000000000000000000000000',
      },
    });
    await handleApiRequest(fakeAuth.req, fakeAuth.res, fakeAuth.url);
    const r2 = fakeAuth.result();
    assert.equal(r2.status, 401, `${ep.method} ${ep.path} must return 401 with invalid token`);
  }
});

