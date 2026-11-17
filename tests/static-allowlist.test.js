const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { createAppServer, listenWithFallback, isPublicAssetPath } = require('../server');

// The static server must expose the storefront only. Everything that describes how the shop is
// built — API source, SQL, tests, tooling, package metadata, dotfiles — stays private.

const root = path.join(__dirname, '..');

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

test('the allowlist publishes the storefront pages, styles, client scripts and assets', () => {
  const allowed = [
    '/index.html',
    '/shop.html',
    '/artist.html',
    '/studio.html',
    '/checkout.html',
    '/payment.html',
    '/order-success.html',
    '/admin.html',
    '/styles.css',
    '/src/catalog.js',
    '/src/options.js',
    '/src/pricing.js',
    '/src/site-shell.js',
    '/src/shop-page.js',
    '/src/studio.js',
    '/src/checkout.js',
    '/src/payment.js',
    '/src/success.js',
    '/src/artist-page.js',
    '/src/admin.js',
    '/src/three/viewer.mjs',
    '/assets/admin.css',
    '/assets/brand/favicon.png',
    '/assets/fonts/Inter-Regular.otf',
    '/assets/vendor/three/three.module.js',
  ];

  for (const pathname of allowed) {
    assert.equal(isPublicAssetPath(pathname), true, `${pathname} must be served`);
  }
});

test('the allowlist blocks server source, SQL, tests, tooling and dotfiles', () => {
  const blocked = [
    '/src/server/api.js',
    '/src/server/auth.js',
    '/src/server/catalog.js',
    '/src/server/orders.js',
    '/src/server/db.js',
    '/database/schema.sql',
    '/database/migrations/003_catalog_groups.sql',
    '/tests/security.test.js',
    '/tools/verify-studio.cjs',
    '/package.json',
    '/package-lock.json',
    '/README.md',
    '/server.js',
    '/.env',
    '/.env.example',
    '/.git/config',
    '/.gitignore',
    '/.railwayignore',
    '/archive/legacy-single-page/app.js',
    '/assets/.hidden',
    '/src/../src/server/api.js',
  ];

  for (const pathname of blocked) {
    assert.equal(isPublicAssetPath(pathname), false, `${pathname} must not be served`);
  }
});

test('the HTTP server returns 404 for every non-public path', async (t) => {
  const server = createAppServer(root);
  const { port } = await listenWithFallback(server, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  for (const pathname of ['/', '/admin', '/shop.html', '/src/shop-page.js', '/src/three/viewer.mjs']) {
    const response = await request(port, pathname);
    assert.equal(response.status, 200, `${pathname} should be served`);
  }

  const blocked = [
    '/src/server/api.js',
    '/src/server/catalog.js',
    '/database/schema.sql',
    '/tests/catalog-groups.test.js',
    '/tools/verify-studio.cjs',
    '/package.json',
    '/package-lock.json',
    '/.env',
    '/.git/config',
  ];

  for (const pathname of blocked) {
    const response = await request(port, pathname);
    assert.equal(response.status, 404, `${pathname} must return 404`);
    assert.doesNotMatch(response.body, /require\(|CREATE TABLE|mysql2/i, `${pathname} must not leak content`);
  }
});
