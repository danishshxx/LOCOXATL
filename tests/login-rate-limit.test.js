const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'ratelimit-test';
process.env.DB_NAME = 'ratelimit_test';

const users = [];
const sessions = [];

async function execute(sql, params = []) {
  const query = sql.replace(/\s+/g, ' ').trim();

  if (/^SELECT id, username, password_hash FROM admin_users WHERE username = \? LIMIT 1$/i.test(query)) {
    return [users.filter((user) => user.username === params[0]).map(({ id, username, password_hash }) => ({ id, username, password_hash }))];
  }
  if (/^INSERT INTO admin_sessions/i.test(query)) {
    sessions.push({ id: params[0], admin_id: params[1], expires_at: params[2] });
    return [{ affectedRows: 1 }];
  }
  if (/^SELECT s\.id, s\.admin_id/i.test(query)) return [[]];
  if (/^DELETE FROM admin_sessions/i.test(query)) return [{ affectedRows: 1 }];

  throw new Error(`Unexpected rate-limit test SQL: ${query}`);
}

const mysqlPath = require.resolve('mysql2/promise');
require.cache[mysqlPath] = {
  id: mysqlPath,
  filename: mysqlPath,
  loaded: true,
  exports: {
    createPool() {
      return {
        execute,
        query: execute,
        async getConnection() {
          return {
            execute,
            query: execute,
            async beginTransaction() {},
            async commit() {},
            async rollback() {},
            release() {},
          };
        },
        async end() {},
      };
    },
  },
};

const auth = require('../src/server/auth');
const { handleApiRequest } = require('../src/server/api');

function mockHttp(method, pathname, { headers = {}, body = null } = {}) {
  const req = {
    method,
    headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
    socket: { encrypted: false, remoteAddress: headers['x-forwarded-for'] || '203.0.113.10' },
    on(event, handler) {
      if (event === 'data' && body) handler(Buffer.from(JSON.stringify(body)));
      if (event === 'end') handler();
      return req;
    },
    destroy() {},
  };
  let statusCode = 200;
  let responseHeaders = {};
  let payload = '';
  const res = {
    writeHead(status, headersArg) {
      statusCode = status;
      responseHeaders = { ...headersArg };
    },
    end(data) { payload = data || ''; },
    get writableEnded() { return Boolean(payload); },
  };
  return {
    req,
    res,
    url: new URL(pathname, 'http://localhost'),
    result: () => ({ status: statusCode, body: payload ? JSON.parse(payload) : null, headers: responseHeaders }),
  };
}

async function login({ username, password, ip = '203.0.113.10' }) {
  const call = mockHttp('POST', '/api/admin/auth/login', {
    headers: { origin: 'http://localhost', 'x-forwarded-for': ip },
    body: { username, password },
  });
  await handleApiRequest(call.req, call.res, call.url);
  return call.result();
}

test('repeated failed logins return 429 with a Retry-After header', async () => {
  auth.resetLoginRateLimit();

  for (let attempt = 1; attempt <= auth.LOGIN_MAX_FAILURES; attempt += 1) {
    const response = await login({ username: 'ghost-admin', password: 'wrong-password' });
    assert.equal(response.status, 401, `attempt ${attempt} must be rejected as invalid credentials`);
    assert.equal(response.body.error, 'invalid_credentials');
  }

  const blocked = await login({ username: 'ghost-admin', password: 'wrong-password' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'too_many_attempts');

  const retryAfter = Number(blocked.headers['Retry-After']);
  assert.ok(Number.isInteger(retryAfter), 'Retry-After must be an integer number of seconds');
  assert.ok(retryAfter > 0, 'Retry-After must point into the future');
  assert.ok(retryAfter <= auth.LOGIN_WINDOW_MS / 1000, 'Retry-After must not exceed the window');
  assert.equal(sessions.length, 0, 'no session may be created for a blocked attempt');
});

test('the limiter is keyed on the username, so rotating the client address does not bypass it', async () => {
  auth.resetLoginRateLimit();

  for (let attempt = 0; attempt < auth.LOGIN_MAX_FAILURES; attempt += 1) {
    await login({ username: 'spray-target', password: 'nope', ip: `198.51.100.${attempt + 1}` });
  }

  const blocked = await login({ username: 'spray-target', password: 'nope', ip: '198.51.100.99' });
  assert.equal(blocked.status, 429);
});

test('a successful login clears the failure counter for that account', async () => {
  auth.resetLoginRateLimit();
  const hash = await auth.hashPassword('correct-horse-battery');
  users.push({ id: 1, username: 'rate-admin', password_hash: hash });

  for (let attempt = 0; attempt < auth.LOGIN_MAX_FAILURES - 1; attempt += 1) {
    const response = await login({ username: 'rate-admin', password: 'wrong' });
    assert.equal(response.status, 401);
  }

  const success = await login({ username: 'rate-admin', password: 'correct-horse-battery' });
  assert.equal(success.status, 200);
  assert.match(success.headers['Set-Cookie'], /^admin_session=[a-f0-9]{64};/);

  const afterReset = await login({ username: 'rate-admin', password: 'wrong' });
  assert.equal(afterReset.status, 401, 'the counter restarts after a successful sign-in');
});

test('an unknown username is rejected without revealing that it does not exist', async () => {
  auth.resetLoginRateLimit();

  const response = await login({ username: 'does-not-exist', password: 'whatever' });
  assert.equal(response.status, 401);
  assert.equal(response.body.message, 'Invalid admin username or password.');
  assert.equal(sessions.length, 1, 'only the successful login above may have created a session');
});
