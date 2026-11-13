const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'auth-test';
process.env.DB_NAME = 'auth_test';
process.env.ADMIN_USERNAME = 'auth-test-admin';
process.env.ADMIN_PASSWORD = 'first-test-password';

const users = [];
const sessions = new Map();
const statements = [];
let nextUserId = 1;

async function execute(sql, params = []) {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  statements.push({ sql: normalized, params });

  if (/^SELECT id FROM admin_users LIMIT 1$/i.test(normalized)) {
    return [users.map(({ id }) => ({ id }))];
  }
  if (/^SELECT id, username, password_hash FROM admin_users WHERE username = \? LIMIT 1$/i.test(normalized)) {
    return [users.filter((user) => user.username === params[0])];
  }
  if (/^INSERT INTO admin_users/i.test(normalized)) {
    users.push({ id: nextUserId++, username: params[0], password_hash: params[1] });
    return [{ insertId: users[users.length - 1].id }];
  }
  if (/^INSERT INTO admin_sessions/i.test(normalized)) {
    sessions.set(params[0], { id: params[0], admin_id: params[1], expires_at: new Date(params[2]) });
    return [{ affectedRows: 1 }];
  }
  if (/^SELECT s\.id, s\.admin_id, s\.expires_at, u\.username/i.test(normalized)) {
    const stored = sessions.get(params[0]);
    if (!stored || stored.expires_at <= new Date()) return [[]];
    const user = users.find(({ id }) => id === stored.admin_id);
    return [[{
      ...stored,
      username: user.username,
    }]];
  }
  if (/^DELETE FROM admin_sessions WHERE id = \? OR expires_at <= CURRENT_TIMESTAMP$/i.test(normalized)) {
    sessions.delete(params[0]);
    for (const [id, session] of sessions) {
      if (session.expires_at <= new Date()) sessions.delete(id);
    }
    return [{ affectedRows: 1 }];
  }
  if (/^DELETE FROM admin_sessions WHERE id = \?$/i.test(normalized)) {
    sessions.delete(params[0]);
    return [{ affectedRows: 1 }];
  }

  throw new Error(`Unexpected test SQL: ${normalized}`);
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
const root = path.join(__dirname, '..');

function mockHttp(method, pathname, { headers = {}, body = null, encrypted = false } = {}) {
  const req = {
    method,
    headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
    socket: { encrypted },
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
    writeHead(status, responseHeadersArg) {
      statusCode = status;
      responseHeaders = { ...responseHeadersArg };
    },
    end(data) {
      payload = data || '';
    },
    get writableEnded() { return Boolean(payload); },
  };
  const url = new URL(pathname, encrypted ? 'https://localhost' : 'http://localhost');
  return {
    req,
    res,
    url,
    result: () => ({
      status: statusCode,
      body: payload ? JSON.parse(payload) : null,
      headers: responseHeaders,
    }),
  };
}

async function requestApi(method, pathname, options) {
  const call = mockHttp(method, pathname, options);
  await handleApiRequest(call.req, call.res, call.url);
  return call.result();
}

function currentAdminSession() {
  return [...sessions.values()][sessions.size - 1];
}

test('admin provisioning only creates the first account and does not reset credentials on restart', async () => {
  assert.equal(await auth.seedAdminUser(), 'auth-test-admin');
  assert.equal(users.length, 1);
  const originalPasswordHash = users[0].password_hash;

  process.env.ADMIN_PASSWORD = 'changed-after-initial-provisioning';
  delete require.cache[require.resolve('../src/server/auth')];
  const restartedAuth = require('../src/server/auth');
  assert.equal(await restartedAuth.seedAdminUser(), 'auth-test-admin');

  assert.equal(users.length, 1);
  assert.equal(users[0].password_hash, originalPasswordHash);
  assert.equal(await restartedAuth.authenticateAdmin('auth-test-admin', 'first-test-password') !== null, true);
  assert.equal(await restartedAuth.authenticateAdmin('auth-test-admin', 'changed-after-initial-provisioning'), null);
  assert.equal(statements.some(({ sql }) => /^UPDATE admin_users/i.test(sql)), false);
});

test('sessions store only SHA-256 token hashes and reject invalid and expired tokens', async () => {
  const session = await auth.authenticateAdmin('auth-test-admin', 'first-test-password');
  assert.ok(session);
  assert.match(session.token, /^[a-f0-9]{64}$/);

  const sessionHash = crypto.createHash('sha256').update(session.token).digest('hex');
  assert.equal(sessions.has(sessionHash), true);
  assert.equal(sessions.has(session.token), false);
  assert.equal(currentAdminSession().expires_at.getTime(), session.expiresAt.getTime());
  assert.ok(session.expiresAt.getTime() - Date.now() <= 8 * 60 * 60 * 1000);
  assert.ok(session.expiresAt.getTime() - Date.now() > 8 * 60 * 60 * 1000 - 5000);
  assert.equal((await auth.validateAdminSession(session.token)).username, 'auth-test-admin');
  assert.equal(await auth.validateAdminSession('invalid'), null);
  assert.equal(auth.extractAdminToken({
    headers: { authorization: `Bearer ${session.token}` },
  }), '');

  sessions.get(sessionHash).expires_at = new Date(Date.now() - 1000);
  assert.equal(await auth.validateAdminSession(session.token), null);
});

test('login sends the raw token only in an HttpOnly Strict cookie with matching eight-hour lifetime', async () => {
  const local = await requestApi('POST', '/api/admin/auth/login', {
    headers: { origin: 'http://localhost' },
    body: { username: 'auth-test-admin', password: 'first-test-password' },
  });

  assert.equal(local.status, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(local.body, 'token'), false);
  const localCookie = local.headers['Set-Cookie'];
  assert.match(localCookie, /; HttpOnly/);
  assert.match(localCookie, /; SameSite=Strict/);
  assert.match(localCookie, /; Max-Age=28800(?:;|$)/);
  assert.doesNotMatch(localCookie, /; Secure(?:;|$)/);

  const rawToken = localCookie.match(/^admin_session=([a-f0-9]{64});/)[1];
  const storedHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  assert.equal(sessions.has(storedHash), true);
  assert.equal(sessions.has(rawToken), false);
  assert.equal(currentAdminSession().expires_at.getTime() - new Date(local.body.expiresAt).getTime(), 0);

  const https = await requestApi('POST', '/api/admin/auth/login', {
    encrypted: true,
    headers: { origin: 'https://localhost' },
    body: { username: 'auth-test-admin', password: 'first-test-password' },
  });
  assert.equal(https.status, 200);
  assert.match(https.headers['Set-Cookie'], /; Secure(?:;|$)/);

  const proxiedHttps = await requestApi('POST', '/api/admin/auth/login', {
    headers: {
      origin: 'https://localhost',
      'x-forwarded-proto': 'https',
    },
    body: { username: 'auth-test-admin', password: 'first-test-password' },
  });
  assert.equal(proxiedHttps.status, 200);
  assert.match(proxiedHttps.headers['Set-Cookie'], /; Secure(?:;|$)/);
});

test('admin state-changing requests reject missing and cross-origin Origin headers', async () => {
  const loginWithoutOrigin = await requestApi('POST', '/api/admin/auth/login', {
    body: { username: 'auth-test-admin', password: 'first-test-password' },
  });
  assert.equal(loginWithoutOrigin.status, 403);

  const crossOriginLogout = await requestApi('POST', '/api/admin/auth/logout', {
    headers: { origin: 'https://attacker.example' },
  });
  assert.equal(crossOriginLogout.status, 403);

  const session = await auth.authenticateAdmin('auth-test-admin', 'first-test-password');
  const crossOriginMutation = await requestApi('PATCH', '/api/admin/orders/LX-TEST-1/notes', {
    headers: {
      origin: 'https://attacker.example',
      cookie: `admin_session=${session.token}`,
    },
    body: { adminNotes: 'blocked' },
  });
  assert.equal(crossOriginMutation.status, 403);

  const sameOriginUnauthenticatedMutation = await requestApi('PATCH', '/api/admin/orders/LX-TEST-1/notes', {
    headers: { origin: 'http://localhost' },
    body: { adminNotes: 'not authorized' },
  });
  assert.equal(sameOriginUnauthenticatedMutation.status, 401);
});

test('admin frontend never persists or sends the raw session token outside the cookie', () => {
  const frontend = fs.readFileSync(path.join(root, 'src', 'admin.js'), 'utf8');
  assert.doesNotMatch(frontend, /sessionStorage|localStorage|Authorization|data\.token/);
  assert.match(frontend, /credentials:\s*'same-origin'/);
});
