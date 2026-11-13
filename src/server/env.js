const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader so the project keeps a zero-dependency server entry point.
// Existing process.env values always win, which keeps container/host configuration
// authoritative over the file.

function parseEnv(contents) {
  const result = {};
  contents.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const separator = trimmed.indexOf('=');
    if (separator === -1) return;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  });
  return result;
}

function loadEnv(rootDir = path.join(__dirname, '..', '..')) {
  const file = path.join(rootDir, '.env');
  if (!fs.existsSync(file)) return {};
  const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
  Object.entries(parsed).forEach(([key, value]) => {
    if (process.env[key] === undefined) process.env[key] = value;
  });
  return parsed;
}

module.exports = { loadEnv, parseEnv };