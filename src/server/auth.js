const crypto = require('node:crypto');
const { getPool, isConfigured } = require('./db');

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SESSION_TTL_SECONDS = 8 * 60 * 60;

// Online brute-force protection: five failures per username and per client address inside a
// rolling fifteen-minute window. State is intentionally in-process; a restart clears it.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const MAX_TRACKED_BUCKETS = 2000;
const loginFailureBuckets = new Map();

// A throwaway hash used to keep "unknown username" responses as slow as a real password
// check, so the endpoint cannot be used to enumerate admin accounts by timing.
const DUMMY_PASSWORD = crypto.randomBytes(32).toString('hex');
let dummyHashPromise = null;

function dummyPasswordHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(DUMMY_PASSWORD);
  return dummyHashPromise;
}

function clientAddress(request) {
  const forwarded = String((request && request.headers && request.headers['x-forwarded-for']) || '')
    .split(',')[0]
    .trim();
  if (forwarded) return forwarded;
  return (request && request.socket && request.socket.remoteAddress) || 'unknown';
}

function loginRateLimitKeys(request, username) {
  const user = String(username == null ? '' : username).trim().toLowerCase().slice(0, 64);
  return [`user:${user || '-'}`, `ip:${clientAddress(request)}`];
}

function readBucket(key, now) {
  const bucket = loginFailureBuckets.get(key);
  if (!bucket) return null;
  if (now - bucket.startedAt >= LOGIN_WINDOW_MS) {
    loginFailureBuckets.delete(key);
    return null;
  }
  return bucket;
}

function pruneLoginBuckets(now) {
  if (loginFailureBuckets.size <= MAX_TRACKED_BUCKETS) return;
  for (const [key, bucket] of loginFailureBuckets) {
    if (now - bucket.startedAt >= LOGIN_WINDOW_MS) loginFailureBuckets.delete(key);
  }
}

function checkLoginRateLimit(request, username) {
  const now = Date.now();
  let retryAfter = 0;

  for (const key of loginRateLimitKeys(request, username)) {
    const bucket = readBucket(key, now);
    if (!bucket || bucket.failures < LOGIN_MAX_FAILURES) continue;
    retryAfter = Math.max(retryAfter, Math.ceil((bucket.startedAt + LOGIN_WINDOW_MS - now) / 1000));
  }

  return { blocked: retryAfter > 0, retryAfter };
}

function recordLoginFailure(request, username) {
  const now = Date.now();
  pruneLoginBuckets(now);

  for (const key of loginRateLimitKeys(request, username)) {
    const bucket = readBucket(key, now);
    if (bucket) {
      bucket.failures += 1;
    } else {
      loginFailureBuckets.set(key, { failures: 1, startedAt: now });
    }
  }
}

function clearLoginFailures(request, username) {
  for (const key of loginRateLimitKeys(request, username)) loginFailureBuckets.delete(key);
}

function resetLoginRateLimit() {
  loginFailureBuckets.clear();
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    if (!password || typeof password !== 'string') {
      return reject(new Error('Password must be a non-empty string.'));
    }
    const salt = crypto.randomBytes(16);
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION },
      (err, derivedKey) => {
        if (err) return reject(err);
        resolve(`scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`);
      },
    );
  });
}

function verifyPassword(password, storedHash) {
  return new Promise((resolve) => {
    if (!password || !storedHash || typeof storedHash !== 'string') return resolve(false);
    const parts = storedHash.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return resolve(false);

    const salt = Buffer.from(parts[1], 'hex');
    const expectedKey = Buffer.from(parts[2], 'hex');

    crypto.scrypt(
      password,
      salt,
      expectedKey.length,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION },
      (err, derivedKey) => {
        if (err) return resolve(false);
        try {
          const matches = crypto.timingSafeEqual(expectedKey, derivedKey);
          resolve(matches);
        } catch {
          resolve(false);
        }
      },
    );
  });
}

async function seedAdminUser() {
  if (!isConfigured()) return null;
  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password = process.env.ADMIN_PASSWORD;

  if (!password || !password.trim()) {
    process.stdout.write('Admin auth: ADMIN_PASSWORD is not set in environment. Admin login is disabled.\n');
    return null;
  }

  const pool = getPool();
  try {
    const [rows] = await pool.execute(
      'SELECT id FROM admin_users LIMIT 1',
    );

    if (rows.length === 0) {
      const hash = await hashPassword(password);
      await pool.execute(
        'INSERT INTO admin_users (username, password_hash) VALUES (?, ?)',
        [username, hash],
      );
      process.stdout.write(`Admin auth: created initial admin user "${username}".\n`);
    }
    return username;
  } catch (err) {
    process.stdout.write(`Admin auth: note (${err.message}).\n`);
    return null;
  }
}

async function authenticateAdmin(username, password) {
  if (!isConfigured()) {
    const err = new Error('Database is not configured.');
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }

  const user = String(username || '').trim();
  const pass = String(password || '');
  if (!user || !pass) return null;

  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT id, username, password_hash FROM admin_users WHERE username = ? LIMIT 1',
    [user],
  );
  if (!rows.length) {
    // Spend the same scrypt work as a real verification so response time does not reveal
    // whether the username exists.
    await verifyPassword(pass, await dummyPasswordHash());
    return null;
  }

  const isValid = await verifyPassword(pass, rows[0].password_hash);
  if (!isValid) return null;

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  await pool.execute(
    'INSERT INTO admin_sessions (id, admin_id, expires_at) VALUES (?, ?, ?)',
    [sessionHash, rows[0].id, expiresAt],
  );

  return {
    token: sessionToken,
    expiresAt,
    user: { id: rows[0].id, username: rows[0].username },
  };
}

async function validateAdminSession(sessionToken) {
  const token = String(sessionToken || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(token) || !isConfigured()) return null;

  const pool = getPool();
  const sessionHash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    const [rows] = await pool.execute(
      `SELECT s.id, s.admin_id, s.expires_at, u.username
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.admin_id
       WHERE s.id = ? AND s.expires_at > CURRENT_TIMESTAMP
       LIMIT 1`,
      [sessionHash],
    );

    if (!rows.length) {
      await pool.execute('DELETE FROM admin_sessions WHERE id = ? OR expires_at <= CURRENT_TIMESTAMP', [sessionHash]).catch(() => {});
      return null;
    }

    return {
      sessionId: rows[0].id,
      adminId: rows[0].admin_id,
      username: rows[0].username,
      expiresAt: rows[0].expires_at,
    };
  } catch {
    return null;
  }
}

async function destroyAdminSession(sessionToken) {
  const token = String(sessionToken || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(token) || !isConfigured()) return;
  const pool = getPool();
  const sessionHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.execute('DELETE FROM admin_sessions WHERE id = ?', [sessionHash]).catch(() => {});
}

function extractAdminToken(request) {
  const cookie = String(request.headers['cookie'] || '');
  const match = cookie.match(/(?:^|;\s*)admin_session=([^;]+)/);
  return match && /^[a-f0-9]{64}$/i.test(match[1]) ? match[1] : '';
}

module.exports = {
  hashPassword,
  verifyPassword,
  seedAdminUser,
  authenticateAdmin,
  validateAdminSession,
  destroyAdminSession,
  extractAdminToken,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
  resetLoginRateLimit,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  SESSION_TTL_SECONDS,
};
