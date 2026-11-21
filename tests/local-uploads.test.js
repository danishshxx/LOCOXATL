const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// Persistent local image storage: category folders, UUID filenames, validation, traversal
// protection, serving from a directory outside the application, and a restart that keeps the
// files readable.

process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '1';
process.env.DB_USER = 'local-uploads-test';
process.env.DB_PASSWORD = '';
process.env.DB_NAME = 'locoxatl_local_uploads_test';

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locoxatl-local-uploads-'));
process.env.UPLOAD_DIR = uploadDir;
process.env.UPLOAD_DRIVER = 'local';
delete process.env.CATALOG_UPLOAD_DIR;
delete process.env.CLOUDINARY_CLOUD_NAME;
delete process.env.CLOUDINARY_API_KEY;
delete process.env.CLOUDINARY_API_SECRET;
delete process.env.CLOUDINARY_FOLDER;
delete process.env.RAILWAY_PROJECT_ID;

const root = path.join(__dirname, '..');
const uploads = require('../src/server/uploads');
const { createAppServer, listenWithFallback } = require('../server');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const pngDataUrl = () => `data:image/png;base64,${PNG_BASE64}`;
const jpegDataUrl = () => `data:image/jpeg;base64,${JPEG_BASE64}`;
const webpDataUrl = () => {
  const header = Buffer.alloc(16);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(8, 4);
  header.write('WEBP', 8, 'ascii');
  return `data:image/webp;base64,${header.toString('base64')}`;
};

const UUID_FILE = /^\/uploads\/(catalog|members|groups|products)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:webp|png|jpg|jpeg)$/;

const storedFile = (url) => {
  const [, , category, filename] = String(url).split('/');
  return path.join(uploadDir, category, filename);
};

function call(port, pathname, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname, method }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

test.after(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Storage layout
// ---------------------------------------------------------------------------

test('every category writes into its own folder with a UUID filename', async () => {
  const cases = [
    ['catalog', pngDataUrl(), 'png'],
    ['members', jpegDataUrl(), 'jpg'],
    ['groups', pngDataUrl(), 'png'],
    ['products', webpDataUrl(), 'webp'],
  ];

  for (const [category, dataUrl, extension] of cases) {
    const url = await uploads.saveCatalogImage(`${category}-asset`, dataUrl, category);

    assert.match(url, UUID_FILE, `${category} must return a UUID path`);
    assert.equal(url.split('/')[2], category, `${category} keeps its own subdirectory`);
    assert.ok(url.endsWith(`.${extension}`), `a canonical ${extension} extension is used`);

    const file = storedFile(url);
    assert.equal(path.dirname(file), path.join(uploadDir, category));
    assert.equal(fs.existsSync(file), true, `${category} file must exist`);
    assert.ok(fs.statSync(file).size > 0);
  }
});

test('a JPEG keeps the canonical .jpg extension', async () => {
  const url = await uploads.saveCatalogImage('member-portrait', jpegDataUrl(), 'members');
  assert.ok(url.endsWith('.jpg'), 'the stored extension follows the sniffed type, not the request');
  assert.match(url, UUID_FILE);
});

test('two uploads of the same bytes never collide', async () => {
  const first = await uploads.saveCatalogImage('group-cover', pngDataUrl(), 'groups');
  const second = await uploads.saveCatalogImage('group-cover', pngDataUrl(), 'groups');

  assert.notEqual(first, second, 'each upload gets a fresh UUID');
  assert.equal(fs.existsSync(storedFile(first)), true);
  assert.equal(fs.existsSync(storedFile(second)), true);
});

test('replacing an image stores the new file and removes the old one', async () => {
  const previous = await uploads.saveCatalogImage('product-cover', pngDataUrl(), 'products');
  const replaced = await uploads.saveCatalogImage('product-cover', jpegDataUrl(), 'products');

  assert.notEqual(replaced, previous);
  assert.equal(fs.existsSync(storedFile(previous)), true, 'both files exist until the old one is dropped');

  assert.equal(await uploads.removeCatalogImage(previous), true);
  assert.equal(fs.existsSync(storedFile(previous)), false, 'the replaced file is gone');
  assert.equal(fs.existsSync(storedFile(replaced)), true, 'the current file stays');
});

test('deleting an image removes the file and is idempotent', async () => {
  const url = await uploads.saveCatalogImage('member-design', pngDataUrl(), 'members');
  assert.equal(fs.existsSync(storedFile(url)), true);

  assert.equal(await uploads.removeCatalogImage(url), true);
  assert.equal(fs.existsSync(storedFile(url)), false);
  assert.equal(await uploads.removeCatalogImage(url), false, 'a second delete is a no-op');
});

// ---------------------------------------------------------------------------
// Validation and traversal
// ---------------------------------------------------------------------------

test('invalid types, mismatched bytes and oversized files are rejected', async () => {
  await assert.rejects(
    () => uploads.saveCatalogImage('asset', 'data:text/plain;base64,aGVsbG8=', 'catalog'),
    (error) => error.code === 'invalid_image' && error.statusCode === 400,
  );

  await assert.rejects(
    () => uploads.saveCatalogImage('asset', 'not-an-image', 'catalog'),
    (error) => error.code === 'invalid_image' && error.statusCode === 400,
  );

  // PNG declared, JPEG bytes inside.
  await assert.rejects(
    () => uploads.saveCatalogImage('asset', `data:image/png;base64,${JPEG_BASE64}`, 'catalog'),
    (error) => error.code === 'invalid_image' && error.statusCode === 400,
  );

  // JPEG declared, PNG bytes inside.
  await assert.rejects(
    () => uploads.saveCatalogImage('asset', `data:image/jpeg;base64,${PNG_BASE64}`, 'catalog'),
    (error) => error.code === 'invalid_image',
  );

  const oversized = Buffer.alloc(uploads.MAX_IMAGE_BYTES + 1);
  Buffer.from(PNG_BASE64, 'base64').copy(oversized, 0);
  await assert.rejects(
    () => uploads.saveCatalogImage('asset', `data:image/png;base64,${oversized.toString('base64')}`, 'catalog'),
    (error) => error.code === 'image_too_large' && error.statusCode === 413,
  );
});

test('path traversal is refused on write, delete and serve', async () => {
  for (const category of ['../groups', 'groups/../../', '/etc', 'catalog/..', '..']) {
    await assert.rejects(
      () => uploads.saveCatalogImage('asset', pngDataUrl(), category),
      (error) => error.code === 'invalid_category' || error.code === 'invalid_path',
      `${category} must not become a directory`,
    );
  }

  assert.equal(uploads.isManagedUrl('/uploads/groups/../../package.json'), false);
  assert.equal(uploads.isManagedUrl('/uploads/../etc/passwd'), false);
  assert.equal(await uploads.removeCatalogImage('/uploads/groups/../../package.json'), false);
  assert.equal(fs.existsSync(path.join(root, 'package.json')), true, 'the traversal never reaches a real file');

  for (const attempt of [
    '/uploads/groups/../../server.js',
    '/uploads/groups/%2e%2e/%2e%2e/server.js',
    '/uploads/groups/0e4f1e1c-0000-4000-8000-000000000000.png\0.jpg',
    '/uploads/groups/..\\..\\server.js',
    '/uploads//etc/passwd',
    '/uploads/groups/',
    '/uploads/groups',
    '/uploads/',
    '/uploads',
  ]) {
    assert.equal(uploads.resolveUploadFile(attempt), null, `${JSON.stringify(attempt)} must not resolve`);
  }
});

test('an upload directory inside the application is refused', async () => {
  const previous = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = path.join(root, 'assets', 'uploads');
  try {
    await assert.rejects(
      () => uploads.saveCatalogImage('asset', pngDataUrl(), 'catalog'),
      (error) => error.code === 'invalid_upload_dir' && error.statusCode === 500,
    );
  } finally {
    process.env.UPLOAD_DIR = previous;
  }
});

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------

test('local is the default and Cloudinary has to be named explicitly in production', () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.UPLOAD_DRIVER;
    process.env.NODE_ENV = 'production';
    process.env.CLOUDINARY_CLOUD_NAME = 'locoxatl-demo';
    process.env.CLOUDINARY_API_KEY = 'key';
    process.env.CLOUDINARY_API_SECRET = 'secret';
    assert.equal(uploads.uploadDriver(), 'local', 'a VPS keeps its files even when old Cloudinary keys linger');
    assert.equal(uploads.usesCloudStorage(), false);

    process.env.UPLOAD_DRIVER = 'cloudinary';
    assert.equal(uploads.uploadDriver(), 'cloudinary', 'Cloudinary is used only when it is named');

    delete process.env.NODE_ENV;
    delete process.env.UPLOAD_DRIVER;
    assert.equal(uploads.uploadDriver(), 'cloudinary', 'a non-production environment with keys keeps Cloudinary');

    delete process.env.CLOUDINARY_CLOUD_NAME;
    assert.equal(uploads.uploadDriver(), 'local', 'an incomplete Cloudinary configuration never wins');
  } finally {
    for (const key of ['NODE_ENV', 'UPLOAD_DRIVER', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
});

test('the production default directory is the persistent volume', () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.UPLOAD_DIR;
    delete process.env.CATALOG_UPLOAD_DIR;
    process.env.NODE_ENV = 'production';
    assert.equal(uploads.uploadRoot(), '/var/lib/locoxatl/uploads');

    delete process.env.NODE_ENV;
    assert.notEqual(uploads.uploadRoot(), '/var/lib/locoxatl/uploads', 'development stays off the system path');
    assert.equal(uploads.uploadRoot().startsWith(root), false, 'the default never points inside the repo');
    assert.equal(uploads.uploadRoot().includes(os.tmpdir()), false, 'the default never points at the temp dir');
  } finally {
    for (const key of ['NODE_ENV', 'UPLOAD_DIR', 'CATALOG_UPLOAD_DIR']) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

test('historical Cloudinary and legacy local URLs stay managed next to the new paths', () => {
  assert.equal(uploads.isManagedUrl('https://res.cloudinary.com/locoxatl/image/upload/v1/locoxatl/catalog/a.webp'), true);
  assert.equal(uploads.isManagedUrl('/assets/uploads/catalog/blackpink-0123456789ab.png'), true);
  assert.equal(uploads.isManagedUrl('/uploads/groups/0e4f1e1c-0000-4000-8000-000000000000.webp'), true);

  assert.equal(uploads.isManagedUrl('https://res.cloudinary.com/evil/raw/upload/a.txt'), false);
  assert.equal(uploads.isManagedUrl('https://example.com/uploads/groups/a.png'), false);
  assert.equal(uploads.isManagedUrl('/uploads/catalog/not-a-uuid.png'), false);

  // A Cloudinary URL is not a local file, so nothing is ever deleted from disk for it.
  assert.equal(uploads.resolveUploadFile('https://res.cloudinary.com/locoxatl/image/upload/v1/a.webp'), null);
  assert.equal(uploads.resolveUploadFile('/assets/uploads/catalog/blackpink-0123456789ab.png'), null);
});

// ---------------------------------------------------------------------------
// Serving, and a restart that keeps the files
// ---------------------------------------------------------------------------

test('uploaded images are served with the right headers and survive a restart', async (t) => {
  const url = await uploads.saveCatalogImage('group-cover', pngDataUrl(), 'groups');
  const bytes = fs.readFileSync(storedFile(url));

  const first = createAppServer(root);
  const { port: firstPort } = await listenWithFallback(first, 0);
  const served = await call(firstPort, url);
  assert.equal(served.status, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.equal(served.headers['x-content-type-options'], 'nosniff');
  assert.match(served.headers['cache-control'], /immutable/);
  assert.deepEqual(served.body, bytes, 'the served bytes are the stored bytes');

  const head = await call(firstPort, url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers['content-length']), bytes.length);
  assert.equal(head.body.length, 0, 'HEAD sends no body');

  // No directory listing, no traversal, no unknown category.
  for (const pathname of ['/uploads/', '/uploads/groups/', '/uploads/groups/../../server.js', '/uploads/secrets/a.png', '/uploads/groups/0e4f1e1c-0000-4000-8000-000000000000.png']) {
    const response = await call(firstPort, pathname);
    assert.equal(response.status, 404, `${pathname} must not be served`);
    assert.match(String(response.body), /Image not found|Page or asset not found/);
  }

  await new Promise((resolve) => first.close(resolve));

  // A new app instance against the same directory still serves the file.
  const second = createAppServer(root);
  const { port: secondPort } = await listenWithFallback(second, 0);
  t.after(() => new Promise((resolve) => second.close(resolve)));

  const afterRestart = await call(secondPort, url);
  assert.equal(afterRestart.status, 200, 'the file survives a restart');
  assert.deepEqual(afterRestart.body, bytes);
});

// ---------------------------------------------------------------------------
// Deployment artifacts
// ---------------------------------------------------------------------------

test('the VPS artifacts describe the same volume the code writes to', () => {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

  const nginx = read('deploy/nginx-locoxatl.conf');
  assert.match(nginx, /location \/uploads\/ \{/);
  assert.match(nginx, /alias \/var\/lib\/locoxatl\/uploads\/;/);
  assert.match(nginx, /autoindex off;/);
  assert.match(nginx, /proxy_pass http:\/\/locoxatl_app;/);

  const backup = read('deploy/backup-locoxatl.sh');
  assert.match(backup, /^#!\/usr\/bin\/env bash/);
  assert.match(backup, /mysqldump/);
  assert.match(backup, /tar -czf/);
  assert.match(backup, /set -euo pipefail/);
  assert.doesNotMatch(backup, /-p"\$DB_PASSWORD"|--password=/, 'the password must never reach the process list');

  const guide = read('deploy/VPS_MIGRATION.md');
  for (const marker of [
    '/var/lib/locoxatl/uploads/{catalog,members,groups,products}',
    'UPLOAD_DRIVER=local',
    'UPLOAD_DIR=/var/lib/locoxatl/uploads',
    'chown -R locoxatl:locoxatl',
    'certbot',
    'pm2 start server.js',
    'systemd',
  ]) {
    assert.ok(guide.includes(marker), `VPS_MIGRATION.md must document ${marker}`);
  }

  const envExample = read('.env.example');
  assert.match(envExample, /^UPLOAD_DRIVER=local$/m);
  assert.match(envExample, /^UPLOAD_DIR=\/var\/lib\/locoxatl\/uploads$/m);
  assert.match(envExample, /Legacy object storage \(optional\)/);
});

test('the storefront and dashboard render both upload shapes and nothing else', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(root, 'src', 'catalog.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports });
  const client = module.exports;

  const current = '/uploads/members/0e4f1e1c-0000-4000-8000-000000000000.webp';
  const legacy = '/assets/uploads/catalog/blackpink-0123456789ab.png';
  const cloudinary = 'https://res.cloudinary.com/locoxatl/image/upload/v1/locoxatl/catalog/a.webp';

  assert.equal(client.safeImageUrl(current), current, 'the new volume path renders');
  assert.equal(client.safeImageUrl(legacy), legacy, 'historical local paths still render');
  assert.equal(client.safeImageUrl(cloudinary), cloudinary, 'historical Cloudinary URLs still render');

  assert.equal(client.safeImageUrl('/uploads/groups/../../server.js'), '');
  assert.equal(client.safeImageUrl('/uploads/secrets/0e4f1e1c-0000-4000-8000-000000000000.png'), '');
  assert.equal(client.safeImageUrl('/etc/passwd'), '');

  // The dashboard keeps its own copy of the allowlist; it must accept the same three shapes.
  const admin = fs.readFileSync(path.join(root, 'src', 'admin.js'), 'utf8');
  const rule = admin.slice(admin.indexOf('const LOCAL_UPLOAD_PATH'), admin.indexOf('const CLOUDINARY_PATH'));
  assert.ok(rule.includes('catalog|members|groups|products'), 'the dashboard accepts the volume paths');
  assert.ok(rule.includes('assets'), 'the dashboard keeps accepting historical local paths');
});
