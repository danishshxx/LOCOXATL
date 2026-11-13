const { loadEnv } = require('./env');

loadEnv();

// Single lazily-created connection pool. Credentials are read from the environment only;
// nothing here is ever exposed to the browser.

let pool = null;

function readSettings() {
  const settings = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
  };
  const required = [['host', 'DB_HOST'], ['user', 'DB_USER'], ['database', 'DB_NAME']];
  const missing = required
    .filter(([key]) => !settings[key] || String(settings[key]).trim() === '')
    .map(([, variable]) => variable);
  return { settings, missing };
}

function notConfiguredError(missing) {
  const error = new Error(`MySQL is not configured. Missing environment variables: ${missing.join(', ')}.`);
  error.code = 'DB_NOT_CONFIGURED';
  error.missing = missing;
  return error;
}

function getPool() {
  if (pool) return pool;
  const { settings, missing } = readSettings();
  if (missing.length) throw notConfiguredError(missing);

  let mysql;
  try {
    // eslint-disable-next-line global-require
    mysql = require('mysql2/promise');
  } catch {
    const error = new Error('The mysql2 package is not installed. Run: npm install mysql2');
    error.code = 'DB_DRIVER_MISSING';
    throw error;
  }

  pool = mysql.createPool({
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    waitForConnections: true,
    connectionLimit: Math.max(1, settings.connectionLimit),
    queueLimit: 0,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    decimalNumbers: true,
  });

  return pool;
}

function isConfigured() {
  return readSettings().missing.length === 0;
}

async function checkConnection() {
  const connection = await getPool().getConnection();
  try {
    await connection.query('SELECT 1');
    return true;
  } finally {
    connection.release();
  }
}

async function withTransaction(work) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* connection already unusable */ }
    throw error;
  } finally {
    connection.release();
  }
}

async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end().catch(() => {});
}

module.exports = { getPool, isConfigured, checkConnection, withTransaction, closePool };