const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Catalog card images: validated upload, file storage, replacement cleanup and removal.

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'catalog-image-test';
process.env.DB_NAME = 'catalog_image_test';

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locoxatl-catalog-images-'));
process.env.CATALOG_UPLOAD_DIR = uploadDir;

// 1x1 PNG — the smallest real image with a valid header.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngDataUrl = (payload = PNG_BASE64) => `data:image/png;base64,${payload}`;

const groups = [
  {
    id: 1,
    slug: 'blackpink',
    name: 'BLACKPINK',
    tagline: 'BLINK',
    eyebrow: '',
    description: 'Bold energy.',
    image_url: null,
    hero_image_url: null,
    cover_focal: '50% 50%',
    hero_focal: '50% 50%',
    is_active: 1,
    sort_order: 0,
  },
];

const COLUMNS = 'id, slug, name, tagline, eyebrow, description, image_url, hero_image_url, cover_focal, hero_focal, is_active, sort_order, created_at, updated_at, versions_json, has_versions, is_custom_design';
const MEMBER_COLUMNS = 'id, group_id, slug, name, portrait_url, design_image_url, is_active, sort_order, created_at, updated_at, version_key';

async function execute(sql, params = []) {
  const query = sql.replace(/\s+/g, ' ').trim();

  if (new RegExp(`^SELECT ${COLUMNS} FROM catalog_groups WHERE id = \\? LIMIT 1$`, 'i').test(query)) {
    return [groups.filter((row) => row.id === Number(params[0])).map((row) => ({ ...row }))];
  }
  if (new RegExp(`^SELECT ${COLUMNS} FROM catalog_groups WHERE is_active = 1`, 'i').test(query)) {
    return [groups.filter((row) => row.is_active).map((row) => ({ ...row }))];
  }
  if (/^UPDATE catalog_groups SET image_url = \? WHERE id = \?$/i.test(query)) {
    const row = groups.find((entry) => entry.id === Number(params[1]));
    if (!row) return [{ affectedRows: 0 }];
    row.image_url = params[0];
    return [{ affectedRows: 1 }];
  }
  if (/^UPDATE catalog_groups SET hero_image_url = \? WHERE id = \?$/i.test(query)) {
    const row = groups.find((entry) => entry.id === Number(params[1]));
    if (!row) return [{ affectedRows: 0 }];
    row.hero_image_url = params[0];
    return [{ affectedRows: 1 }];
  }
  if (/^UPDATE catalog_groups SET image_url = NULL WHERE id = \?$/i.test(query)) {
    const row = groups.find((entry) => entry.id === Number(params[0]));
    if (!row) return [{ affectedRows: 0 }];
    row.image_url = null;
    return [{ affectedRows: 1 }];
  }
  if (/^UPDATE catalog_groups SET hero_image_url = NULL WHERE id = \?$/i.test(query)) {
    const row = groups.find((entry) => entry.id === Number(params[0]));
    if (!row) return [{ affectedRows: 0 }];
    row.hero_image_url = null;
    return [{ affectedRows: 1 }];
  }
  // The design, member and price tables exist but are empty in this fixture.
  if (new RegExp(`^SELECT ${MEMBER_COLUMNS} FROM artist_members`, 'i').test(query)) return [[]];
  if (/^SELECT id, base_model, updated_at FROM product_settings WHERE id = 1 LIMIT 1$/i.test(query)) {
    return [[{ id: 1, base_model: 'heart', updated_at: '2026-11-17 09:00:00' }]];
  }
  if (/^SELECT .* FROM catalog_products/i.test(query)) return [[]];
  if (/^SELECT .* FROM pricing_options/i.test(query)) return [[]];

  if (/FROM catalog_bundles/i.test(query)) return [[]];

  if (/FROM option_categories/i.test(query)) return [[]];

  throw new Error(`Unexpected catalog image test SQL: ${query}`);
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

const serverCatalog = require('../src/server/catalog');
const uploads = require('../src/server/uploads');
const { isPublicAssetPath } = require('../server');
const { handleApiRequest } = require('../src/server/api');

function mockHttp(method, pathname, { headers = {}, body = null } = {}) {
  const req = {
    method,
    headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
    socket: { encrypted: false, remoteAddress: '203.0.113.10' },
    on(event, handler) {
      if (event === 'data' && body) handler(Buffer.from(JSON.stringify(body)));
      if (event === 'end') handler();
      return req;
    },
    destroy() {},
  };
  let statusCode = 200;
  let payload = '';
  const res = {
    writeHead(status) { statusCode = status; },
    end(data) { payload = data || ''; },
    get writableEnded() { return Boolean(payload); },
  };
  return {
    req,
    res,
    url: new URL(pathname, 'http://localhost'),
    result: () => ({ status: statusCode, body: payload ? JSON.parse(payload) : null }),
  };
}

test.after(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

test('uploading an image stores a file and exposes it on the group', async () => {
  const group = await serverCatalog.setGroupImage(1, pngDataUrl());

  assert.match(group.imageUrl, /^\/assets\/uploads\/catalog\/blackpink-[a-f0-9]{12}\.png$/);

  const filename = group.imageUrl.split('/').pop();
  const stored = path.join(uploadDir, filename);
  assert.equal(fs.existsSync(stored), true, 'the file must be written to the upload directory');
  assert.deepEqual(fs.readFileSync(stored), Buffer.from(PNG_BASE64, 'base64'), 'the stored bytes must match');

  const publicCatalog = await serverCatalog.loadCatalog({ activeOnly: true });
  assert.equal(publicCatalog.groups[0].imageUrl, group.imageUrl, 'the storefront catalogue carries the image');
});

test('the uploaded path is served by the static allowlist', async () => {
  const group = await serverCatalog.getGroupById(1);
  assert.equal(isPublicAssetPath(group.imageUrl), true);
  assert.equal(isPublicAssetPath('/assets/uploads/catalog/../../server.js'), false);
});

test('replacing an image deletes the previous file', async () => {
  const before = await serverCatalog.getGroupById(1);
  const previousFile = path.join(uploadDir, before.imageUrl.split('/').pop());
  assert.equal(fs.existsSync(previousFile), true);

  // A different payload produces a different content hash, so a new filename is used.
  const secondPng = Buffer.from(PNG_BASE64, 'base64');
  secondPng[secondPng.length - 1] = secondPng[secondPng.length - 1] ^ 0x01;
  const replaced = await serverCatalog.setGroupImage(1, `data:image/png;base64,${secondPng.toString('base64')}`);

  assert.notEqual(replaced.imageUrl, before.imageUrl);
  assert.equal(fs.existsSync(previousFile), false, 'the old file must be removed');
  assert.equal(fs.existsSync(path.join(uploadDir, replaced.imageUrl.split('/').pop())), true);
});

test('re-uploading identical bytes reuses the same file', async () => {
  const first = await serverCatalog.setGroupImage(1, pngDataUrl());
  const second = await serverCatalog.setGroupImage(1, pngDataUrl());
  assert.equal(second.imageUrl, first.imageUrl);
  assert.equal(fs.existsSync(path.join(uploadDir, first.imageUrl.split('/').pop())), true);
});

test('invalid, mismatched and oversized images are rejected', async () => {
  await assert.rejects(
    () => serverCatalog.setGroupImage(1, 'not-an-image'),
    (error) => error.code === 'invalid_image' && error.statusCode === 400,
  );

  // Declares PNG but carries JPEG bytes.
  await assert.rejects(
    () => serverCatalog.setGroupImage(1, 'data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD'),
    (error) => error.code === 'invalid_image',
  );

  // Valid PNG header, but far beyond the 3 MB limit.
  const oversized = Buffer.alloc(uploads.MAX_IMAGE_BYTES + 1024);
  Buffer.from(PNG_BASE64, 'base64').copy(oversized, 0);
  await assert.rejects(
    () => serverCatalog.setGroupImage(1, `data:image/png;base64,${oversized.toString('base64')}`),
    (error) => error.code === 'image_too_large' && error.statusCode === 413,
  );

  // A rejected upload must leave the current image untouched.
  const group = await serverCatalog.getGroupById(1);
  assert.match(group.imageUrl, /^\/assets\/uploads\/catalog\//);
});

test('only files owned by the uploader can be removed', async () => {
  assert.equal(uploads.isManagedUrl('/assets/uploads/catalog/blackpink-0123456789ab.png'), true);
  assert.equal(uploads.isManagedUrl('/assets/brand/favicon.png'), false);
  assert.equal(uploads.isManagedUrl('/assets/uploads/catalog/../../package.json'), false);
  assert.equal(await uploads.removeCatalogImage('/assets/brand/favicon.png'), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'assets', 'brand', 'favicon.png')), true);
});

test('removing the image clears the column and deletes the file', async () => {
  const group = await serverCatalog.setGroupImage(1, pngDataUrl());
  const stored = path.join(uploadDir, group.imageUrl.split('/').pop());
  assert.equal(fs.existsSync(stored), true);

  const cleared = await serverCatalog.clearGroupImage(1);
  assert.equal(cleared.imageUrl, null);
  assert.equal(fs.existsSync(stored), false);

  // Removing twice is a no-op.
  const again = await serverCatalog.clearGroupImage(1);
  assert.equal(again.imageUrl, null);
});

test('the upload endpoint requires an admin session', async () => {
  const call = mockHttp('POST', '/api/admin/catalog/groups/1/image', {
    headers: { origin: 'http://localhost' },
    body: { dataUrl: pngDataUrl() },
  });
  await handleApiRequest(call.req, call.res, call.url);
  assert.equal(call.result().status, 401);

  const deleteCall = mockHttp('DELETE', '/api/admin/catalog/groups/1/image', {
    headers: { origin: 'http://localhost' },
  });
  await handleApiRequest(deleteCall.req, deleteCall.res, deleteCall.url);
  assert.equal(deleteCall.result().status, 401);
});
