const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Artist & Group Management: group presentation fields, member CRUD, image upload validation,
// public catalogue exposure, authorization, ordering and inactive content.

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'artist-cms-test';
process.env.DB_NAME = 'artist_cms_test';

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locoxatl-artist-cms-'));
process.env.CATALOG_UPLOAD_DIR = uploadDir;
// Force the local storage fallback so the suite never reaches Cloudinary.
delete process.env.CLOUDINARY_CLOUD_NAME;
delete process.env.CLOUDINARY_API_KEY;
delete process.env.CLOUDINARY_API_SECRET;
delete process.env.CLOUDINARY_FOLDER;

// 1x1 PNG and a JPEG header used to prove the server validates real bytes.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngDataUrl = () => `data:image/png;base64,${PNG_BASE64}`;

const GROUP_FIELDS = 'id, slug, name, tagline, eyebrow, description, image_url, hero_image_url, cover_focal, hero_focal, is_active, sort_order, created_at, updated_at';
const PRODUCT_FIELDS = 'id, group_id, slug, name, template_key, description, base_price, image_url, is_active, sort_order, created_at, updated_at';
const MEMBER_FIELDS = 'id, group_id, slug, name, portrait_url, design_image_url, is_active, sort_order, created_at, updated_at';
const PRICING_FIELDS = 'id, category, option_key, label, price, is_active, sort_order, updated_at';

const groups = [
  {
    id: 1, slug: 'blackpink', name: 'BLACKPINK', tagline: 'BLINK', eyebrow: 'BLINK / ARTIST COLLECTION',
    description: 'Bold energy.', image_url: null, hero_image_url: null, cover_focal: '50% 50%',
    hero_focal: '50% 20%', is_active: 1, sort_order: 0,
  },
  {
    id: 2, slug: 'bts', name: 'BTS', tagline: 'ARMY', eyebrow: '', description: 'Signal edit.',
    image_url: null, hero_image_url: null, cover_focal: '50% 50%', hero_focal: '50% 50%',
    is_active: 1, sort_order: 1,
  },
  {
    id: 3, slug: 'seventeen', name: 'SEVENTEEN', tagline: 'CARAT', eyebrow: '', description: 'Hidden.',
    image_url: null, hero_image_url: null, cover_focal: '50% 50%', hero_focal: '50% 50%',
    is_active: 0, sort_order: 2,
  },
];

let members = [
  { id: 1, group_id: 1, slug: 'jisoo', name: 'Jisoo', portrait_url: null, is_active: 1, sort_order: 0 },
  { id: 2, group_id: 1, slug: 'jennie', name: 'Jennie', portrait_url: null, is_active: 1, sort_order: 1 },
  { id: 3, group_id: 1, slug: 'rosé', name: 'Rosé', portrait_url: null, is_active: 0, sort_order: 2 },
  { id: 4, group_id: 2, slug: 'rm', name: 'RM', portrait_url: null, is_active: 1, sort_order: 0 },
  { id: 99, group_id: 3, slug: 'hidden-group-member', name: 'Hidden Group Member', portrait_url: null, is_active: 1, sort_order: 0 },
];
let nextMemberId = 5;
let nextGroupId = 4;

let products = [
  {
    id: 1, group_id: 1, slug: 'cloud-heart', name: 'Cloud Heart', template_key: 'acrylic-keychain',
    description: 'A clean heart silhouette.', base_price: 45000, image_url: null, is_active: 1, sort_order: 0,
  },
  {
    id: 2, group_id: 1, slug: 'orbit-star', name: 'Orbit Star', template_key: 'photocard-holder',
    description: 'A star-shaped base.', base_price: 45000, image_url: null, is_active: 0, sort_order: 1,
  },
];

function stamps(row) {
  return { created_at: '2026-11-17 09:00:00', updated_at: '2026-11-17 09:00:00', ...row };
}

const groupSelect = new RegExp(`^SELECT ${GROUP_FIELDS} FROM catalog_groups`, 'i');
const memberSelect = new RegExp(`^SELECT ${MEMBER_FIELDS} FROM artist_members`, 'i');

async function execute(sql, params = []) {
  const query = sql.replace(/\s+/g, ' ').trim();

  // --- groups ---------------------------------------------------------------
  if (new RegExp(`^SELECT ${GROUP_FIELDS} FROM catalog_groups WHERE is_active = 1 ORDER BY sort_order ASC, id ASC$`, 'i').test(query)) {
    return [groups.filter((row) => row.is_active).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map(stamps)];
  }
  if (new RegExp(`^SELECT ${GROUP_FIELDS} FROM catalog_groups ORDER BY sort_order ASC, id ASC$`, 'i').test(query)) {
    return [groups.slice().sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map(stamps)];
  }
  if (new RegExp(`^SELECT ${GROUP_FIELDS} FROM catalog_groups WHERE id = \\? LIMIT 1$`, 'i').test(query)) {
    return [groups.filter((row) => row.id === Number(params[0])).map(stamps)];
  }
  if (/^SELECT COALESCE\(MAX\(sort_order\), -1\) \+ 1 AS next_order FROM catalog_groups$/i.test(query)) {
    return [[{ next_order: groups.reduce((max, row) => Math.max(max, row.sort_order), -1) + 1 }]];
  }
  if (/^INSERT(?: IGNORE)? INTO catalog_groups/i.test(query)) {
    const columnList = /\(([^)]+)\)\s*VALUES/i.exec(query)[1].split(',').map((name) => name.trim());
    const row = { id: nextGroupId++, image_url: null, hero_image_url: null, cover_focal: '50% 50%', hero_focal: '50% 50%', eyebrow: '', tagline: '' };
    columnList.forEach((column, index) => { row[column] = params[index]; });
    if (groups.some((entry) => entry.slug === row.slug)) {
      const error = new Error('Duplicate entry');
      error.code = 'ER_DUP_ENTRY';
      throw error;
    }
    groups.push(row);
    return [{ insertId: row.id, affectedRows: 1 }];
  }
  if (/^UPDATE catalog_groups SET/i.test(query)) {
    const id = Number(params[params.length - 1]);
    const row = groups.find((entry) => entry.id === id);
    if (!row) return [{ affectedRows: 0 }];
    const assignments = query.replace(/^UPDATE catalog_groups SET /i, '').replace(/ WHERE id = \?$/, '').split(', ');
    assignments.forEach((assignment, index) => {
      if (assignment.endsWith('= NULL')) {
        row[assignment.split(' ')[0]] = null;
        return;
      }
      row[assignment.split(' = ')[0]] = params[index];
    });
    return [{ affectedRows: 1 }];
  }
  if (/^DELETE FROM catalog_groups WHERE id = \?$/i.test(query)) {
    const id = Number(params[0]);
    const index = groups.findIndex((row) => row.id === id);
    if (index < 0) return [{ affectedRows: 0 }];
    groups.splice(index, 1);
    // Emulate ON DELETE CASCADE.
    members = members.filter((member) => member.group_id !== id);
    products = products.filter((product) => product.group_id !== id);
    return [{ affectedRows: 1 }];
  }

  // --- members --------------------------------------------------------------
  if (new RegExp(`^SELECT ${MEMBER_FIELDS} FROM artist_members WHERE is_active = 1 AND group_id IN \\(SELECT id FROM catalog_groups WHERE is_active = 1\\) ORDER BY`, 'i').test(query)) {
    return [members
      .filter((row) => row.is_active && groups.some((group) => group.id === row.group_id && group.is_active))
      .sort((a, b) => a.group_id - b.group_id || a.sort_order - b.sort_order)
      .map(stamps)];
  }
  if (new RegExp(`^SELECT ${MEMBER_FIELDS} FROM artist_members ORDER BY`, 'i').test(query)) {
    return [members.slice().sort((a, b) => a.group_id - b.group_id || a.sort_order - b.sort_order).map(stamps)];
  }
  if (new RegExp(`^SELECT ${MEMBER_FIELDS} FROM artist_members WHERE id = \\? LIMIT 1$`, 'i').test(query)) {
    return [members.filter((row) => row.id === Number(params[0])).map(stamps)];
  }
  if (/^SELECT id, slug FROM artist_members WHERE group_id = \?$/i.test(query)) {
    return [members.filter((row) => row.group_id === Number(params[0])).map(({ id, slug }) => ({ id, slug }))];
  }
  if (/^SELECT COALESCE\(MAX\(sort_order\), -1\) \+ 1 AS next_order FROM artist_members WHERE group_id = \?$/i.test(query)) {
    const rows = members.filter((row) => row.group_id === Number(params[0]));
    return [[{ next_order: rows.reduce((max, row) => Math.max(max, row.sort_order), -1) + 1 }]];
  }
  if (/^INSERT INTO artist_members/i.test(query)) {
    const [groupId, slug, name, portraitUrl, designImageUrl, isActive, sortOrder] = params;
    if (members.some((row) => row.group_id === Number(groupId) && row.slug === slug)) {
      const error = new Error('Duplicate entry');
      error.code = 'ER_DUP_ENTRY';
      throw error;
    }
    const row = {
      id: nextMemberId++,
      group_id: Number(groupId),
      slug,
      name,
      portrait_url: portraitUrl,
      design_image_url: designImageUrl,
      is_active: Number(isActive),
      sort_order: Number(sortOrder),
    };
    members.push(row);
    return [{ insertId: row.id, affectedRows: 1 }];
  }
  if (/^UPDATE artist_members SET/i.test(query)) {
    const id = Number(params[params.length - 1]);
    const row = members.find((entry) => entry.id === id);
    if (!row) return [{ affectedRows: 0 }];
    const assignments = query.replace(/^UPDATE artist_members SET /i, '').replace(/ WHERE id = \?$/, '').split(', ');
    assignments.forEach((assignment, index) => {
      if (assignment.endsWith('= NULL')) {
        row[assignment.split(' ')[0]] = null;
        return;
      }
      row[assignment.split(' = ')[0]] = params[index];
    });
    return [{ affectedRows: 1 }];
  }
  if (/^DELETE FROM artist_members WHERE id = \?$/i.test(query)) {
    const id = Number(params[0]);
    const index = members.findIndex((row) => row.id === id);
    if (index < 0) return [{ affectedRows: 0 }];
    members.splice(index, 1);
    return [{ affectedRows: 1 }];
  }
  if (/^DELETE FROM catalog_products WHERE group_id = \?$/i.test(query)) {
    const groupId = Number(params[0]);
    const before = products.length;
    products = products.filter((row) => row.group_id !== groupId);
    return [{ affectedRows: before - products.length }];
  }

  // --- products and pricing (read-only in this suite) -----------------------
  if (new RegExp(`^SELECT ${PRODUCT_FIELDS} FROM catalog_products WHERE is_active = 1 ORDER BY`, 'i').test(query)) {
    return [products.filter((row) => row.is_active).map(stamps)];
  }
  if (new RegExp(`^SELECT ${PRODUCT_FIELDS} FROM catalog_products WHERE group_id = \\? ORDER BY`, 'i').test(query)) {
    return [products.filter((row) => row.group_id === Number(params[0])).map(stamps)];
  }
  if (new RegExp(`^SELECT ${PRODUCT_FIELDS} FROM catalog_products`, 'i').test(query)) {
    return [products.map(stamps)];
  }
  if (new RegExp(`^SELECT ${PRICING_FIELDS} FROM pricing_options`, 'i').test(query)) {
    return [[]];
  }
  if (/^SELECT id, base_model, updated_at FROM product_settings WHERE id = 1 LIMIT 1$/i.test(query)) {
    return [[{ id: 1, base_model: 'heart', updated_at: '2026-11-17 09:00:00' }]];
  }

  throw new Error(`Unexpected artist CMS test SQL: ${query}`);
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

// A toggleable admin session. src/server/api.js destructures these at require time, so the stub
// must be installed BEFORE api.js is loaded. `mockAuthenticated` lets one test assert the
// unauthenticated path without swapping the module again.
let mockAuthenticated = true;
const authPath = require.resolve('../src/server/auth');
const realAuth = require(authPath);
require.cache[authPath].exports = {
  ...realAuth,
  extractAdminToken: () => (mockAuthenticated ? 'test-session-token' : null),
  validateAdminSession: async () => (mockAuthenticated ? { adminId: 1, username: 'admin' } : null),
};

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

test('group CRUD persists eyebrow, hero, focal crops, visibility and ordering', async () => {
  const created = await serverCatalog.createGroup({
    name: 'TWICE',
    eyebrow: 'ONCE / ARTIST COLLECTION',
    tagline: 'ONCE',
    description: 'Nine voices, one collection.',
    coverFocal: '50% 20%',
    heroFocal: '80% 20%',
    sortOrder: 9,
  });

  assert.equal(created.slug, 'twice');
  assert.equal(created.eyebrow, 'ONCE / ARTIST COLLECTION');
  assert.equal(created.coverFocal, '50% 20%');
  assert.equal(created.heroFocal, '80% 20%');
  assert.equal(created.isActive, true);
  assert.equal(created.sortOrder, 9);
  assert.equal(created.heroImageUrl, null, 'a new group starts without a hero image');

  const updated = await serverCatalog.updateGroup(created.id, {
    eyebrow: 'ONCE',
    heroFocal: '20% 80%',
    isActive: false,
    sortOrder: 1,
  });
  assert.equal(updated.eyebrow, 'ONCE');
  assert.equal(updated.heroFocal, '20% 80%');
  assert.equal(updated.isActive, false);
  assert.equal(updated.sortOrder, 1);
});

test('group input rejects bad focal crops, short names and duplicate slugs', async () => {
  await assert.rejects(
    () => serverCatalog.createGroup({ name: 'Valid name', coverFocal: 'middle' }),
    (error) => error.code === 'invalid_focal' && error.statusCode === 400,
  );
  await assert.rejects(
    () => serverCatalog.createGroup({ name: 'X' }),
    (error) => error.code === 'invalid_name',
  );
  await assert.rejects(
    () => serverCatalog.createGroup({ name: 'BLACKPINK' }),
    (error) => error.code === 'group_exists' && error.statusCode === 409,
  );
  await assert.rejects(
    () => serverCatalog.updateGroup(999, { name: 'Nope' }),
    (error) => error.code === 'group_not_found' && error.statusCode === 404,
  );
});

test('member CRUD keeps slugs unique per group and respects ordering', async () => {
  const created = await serverCatalog.createMember({ groupId: 2, name: 'Jin' });
  assert.equal(created.slug, 'jin');
  assert.equal(created.groupId, 2);
  assert.equal(created.isActive, true);
  assert.equal(created.sortOrder, 1, 'appended after the existing member');

  // The same name inside the same group gets a suffix.
  const duplicate = await serverCatalog.createMember({ groupId: 2, name: 'Jin' });
  assert.equal(duplicate.slug, 'jin-2');

  // The same name in a different group keeps the plain slug.
  const otherGroup = await serverCatalog.createMember({ groupId: 1, name: 'Jin' });
  assert.equal(otherGroup.slug, 'jin');

  const updated = await serverCatalog.updateMember(created.id, { name: 'Jin (Kim Seokjin)', sortOrder: 5, isActive: false });
  assert.equal(updated.name, 'Jin (Kim Seokjin)');
  assert.equal(updated.sortOrder, 5);
  assert.equal(updated.isActive, false);

  await assert.rejects(
    () => serverCatalog.createMember({ groupId: 999, name: 'Nobody' }),
    (error) => error.code === 'group_not_found',
  );
  await assert.rejects(
    () => serverCatalog.updateMember(9999, { name: 'Nope' }),
    (error) => error.code === 'member_not_found',
  );
});

test('member images are validated, stored and removed safely', async () => {
  const member = await serverCatalog.createMember({ groupId: 1, name: 'Lisa', portraitUrl: pngDataUrl() });
  assert.match(member.portraitUrl, /^\/assets\/uploads\/catalog\/member-blackpink-lisa-[a-f0-9]{12}\.png$/);
  const stored = path.join(uploadDir, member.portraitUrl.split('/').pop());
  assert.equal(fs.existsSync(stored), true, 'the portrait must be written to storage');

  await assert.rejects(
    () => serverCatalog.updateMember(member.id, { portraitUrl: 'not-an-image' }),
    (error) => error.code === 'invalid_image',
  );

  const cleared = await serverCatalog.updateMember(member.id, { portraitUrl: null });
  assert.equal(cleared.portraitUrl, null);
  assert.equal(fs.existsSync(stored), false, 'clearing the portrait deletes the file');

  const deleting = await serverCatalog.createMember({ groupId: 1, name: 'Chaeyoung', portraitUrl: pngDataUrl() });
  const deletingFile = path.join(uploadDir, deleting.portraitUrl.split('/').pop());
  const result = await serverCatalog.deleteMember(deleting.id);
  assert.equal(result.deleted, true);
  assert.equal(fs.existsSync(deletingFile), false, 'deleting a member removes its portrait');
});

test('a group image upload cannot escape the upload directory or spoof its type', async () => {
  await assert.rejects(
    () => serverCatalog.setGroupImage(1, 'data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD'),
    (error) => error.code === 'invalid_image',
  );
  await assert.rejects(
    () => serverCatalog.setGroupImage(1, '../../etc/passwd'),
    (error) => error.code === 'invalid_image',
  );
  const oversized = Buffer.alloc(uploads.MAX_IMAGE_BYTES + 1024);
  Buffer.from(PNG_BASE64, 'base64').copy(oversized, 0);
  await assert.rejects(
    () => serverCatalog.setGroupImage(1, `data:image/png;base64,${oversized.toString('base64')}`),
    (error) => error.code === 'image_too_large' && error.statusCode === 413,
  );
});

test('group cover and hero images are stored and replaced independently', async () => {
  const cover = await serverCatalog.setGroupImage(1, pngDataUrl(), 'cover');
  const hero = await serverCatalog.setGroupImage(1, pngDataUrl(), 'hero');

  assert.match(cover.imageUrl, /^\/assets\/uploads\/catalog\/blackpink-[a-f0-9]{12}\.png$/);
  assert.match(hero.heroImageUrl, /^\/assets\/uploads\/catalog\/blackpink-hero-[a-f0-9]{12}\.png$/);
  assert.notEqual(cover.imageUrl, hero.heroImageUrl, 'cover and hero never share a filename');

  const clearedHero = await serverCatalog.clearGroupImage(1, 'hero');
  assert.equal(clearedHero.heroImageUrl, null);
  assert.equal(clearedHero.imageUrl, cover.imageUrl, 'clearing the hero leaves the cover intact');
});

test('the public catalogue serves active groups and only visible members', async () => {
  const catalog = await serverCatalog.loadCatalog({ activeOnly: true });

  assert.equal(catalog.source, 'database');
  assert.ok(!catalog.groups.some((group) => group.slug === 'seventeen'), 'inactive groups are excluded');
  assert.ok(!catalog.groups.some((group) => group.slug === 'twice'), 'hidden groups are excluded');
  assert.ok(
    !catalog.members.some((member) => member.name === 'Hidden Group Member'),
    'active members of inactive groups are excluded',
  );

  const blackpinkMembers = catalog.members.filter((member) => member.groupSlug === 'blackpink');
  // Jisoo and Jennie are the seeded visible members; Rosé is hidden and must never appear. Earlier
  // tests in this file may have added more visible members, so assert the invariants instead of an
  // exact list.
  assert.ok(blackpinkMembers.some((member) => member.name === 'Jisoo'));
  assert.ok(blackpinkMembers.some((member) => member.name === 'Jennie'));
  assert.ok(!blackpinkMembers.some((member) => member.name === 'Rosé'), 'inactive members are excluded');
  assert.deepEqual(
    blackpinkMembers.map((member) => member.sortOrder),
    [...blackpinkMembers.map((member) => member.sortOrder)].sort((a, b) => a - b),
    'members are returned in display order',
  );

  for (const member of catalog.members) {
    assert.equal(typeof member.groupSlug, 'string', 'members carry their group slug for the storefront');
    assert.equal(member.isActive, true);
  }
});

test('GET /api/catalog publishes members, and admin member routes require a session', async () => {
  const publicCall = mockHttp('GET', '/api/catalog');
  await handleApiRequest(publicCall.req, publicCall.res, publicCall.url);
  const body = publicCall.result();
  assert.equal(body.status, 200);
  assert.ok(Array.isArray(body.body.members));
  assert.ok(body.body.members.every((member) => member.groupSlug));

  const forbidden = mockHttp('GET', '/api/admin/catalog/members');
  mockAuthenticated = false;
  try {
    await handleApiRequest(forbidden.req, forbidden.res, forbidden.url);
    assert.equal(forbidden.result().status, 401, 'member management requires an admin session');
  } finally {
    mockAuthenticated = true;
  }
});

test('authenticated member routes create, update, reorder and delete through the API', async () => {
  const create = mockHttp('POST', '/api/admin/catalog/members', {
    headers: { origin: 'http://localhost' },
    body: { groupId: 2, name: 'Suga', slug: 'suga' },
  });
  await handleApiRequest(create.req, create.res, create.url);
  const created = create.result();
  assert.equal(created.status, 201);
  assert.equal(created.body.member.name, 'Suga');

  const patch = mockHttp('PATCH', `/api/admin/catalog/members/${created.body.member.id}`, {
    headers: { origin: 'http://localhost' },
    body: { sortOrder: 9, isActive: false },
  });
  await handleApiRequest(patch.req, patch.res, patch.url);
  assert.equal(patch.result().body.member.sortOrder, 9);
  assert.equal(patch.result().body.member.isActive, false);

  const list = mockHttp('GET', '/api/admin/catalog/members?groupId=2');
  await handleApiRequest(list.req, list.res, list.url);
  assert.ok(list.result().body.members.every((member) => member.groupId === 2));

  const remove = mockHttp('DELETE', `/api/admin/catalog/members/${created.body.member.id}`, {
    headers: { origin: 'http://localhost' },
  });
  await handleApiRequest(remove.req, remove.res, remove.url);
  assert.equal(remove.result().status, 200);
  assert.equal(remove.result().body.deleted, true);
});

test('the hero image endpoint accepts ?kind=hero and rejects an unknown kind', async () => {
  const ok = mockHttp('POST', '/api/admin/catalog/groups/2/image?kind=hero', {
    headers: { origin: 'http://localhost' },
    body: { dataUrl: pngDataUrl() },
  });
  await handleApiRequest(ok.req, ok.res, ok.url);
  const body = ok.result();
  assert.equal(body.status, 200);
  assert.match(body.body.group.heroImageUrl, /^\/assets\/uploads\/catalog\/bts-hero-[a-f0-9]{12}\.png$/);
  assert.equal(body.body.group.imageUrl, null, 'the cover is untouched');
});

test('deleting a group removes its retired catalog product rows but preserves the table', async () => {
  const beforeProducts = products.filter((row) => row.group_id === 1).length;
  assert.ok(beforeProducts > 0, 'the fixture has legacy catalog products');

  const result = await serverCatalog.deleteGroup(1);
  assert.equal(result.deleted, true);
  assert.ok(!groups.some((row) => row.id === 1), 'the group is gone');
  assert.ok(!products.some((row) => row.group_id === 1), 'only that group\'s retired product rows are removed');

  // Restore the fixture so later tests still resolve group 1.
  groups.push({
    id: 1, slug: 'blackpink', name: 'BLACKPINK', tagline: 'BLINK', eyebrow: 'BLINK / ARTIST COLLECTION',
    description: 'Bold energy.', image_url: null, hero_image_url: null, cover_focal: '50% 50%',
    hero_focal: '50% 20%', is_active: 1, sort_order: 0,
  });
});

test('deleting a group cascades to its members and removes their images', async () => {
  const group = await serverCatalog.createGroup({ name: 'Temporary Group', slug: 'temporary-group' });
  const member = await serverCatalog.createMember({ groupId: group.id, name: 'Temp Member', portraitUrl: pngDataUrl() });
  const portraitFile = path.join(uploadDir, member.portraitUrl.split('/').pop());
  assert.equal(fs.existsSync(portraitFile), true);

  const result = await serverCatalog.deleteGroup(group.id);
  assert.equal(result.deleted, true);
  assert.ok(!groups.some((row) => row.id === group.id), 'the group row is gone');
  assert.ok(!members.some((row) => row.id === member.id), 'members cascade away with the group');
  assert.equal(fs.existsSync(portraitFile), false, 'the member portrait is cleaned up');
});

test('a database without the artist_members table still serves the catalogue', async () => {
  const previousExecute = execute;
  // Simulate a database that has not run migration 006 yet.
  // eslint-disable-next-line no-func-assign
  const patched = async (sql, params) => {
    if (/artist_members/i.test(sql)) {
      const error = new Error('Table artist_members does not exist');
      error.code = 'ER_NO_SUCH_TABLE';
      throw error;
    }
    return previousExecute(sql, params);
  };
  require.cache[mysqlPath].exports.createPool = () => ({
    execute: patched,
    query: patched,
    async getConnection() { return { execute: patched, query: patched, release() {} }; },
    async end() {},
  });

  const { closePool } = require('../src/server/db');
  await closePool();

  const catalog = await serverCatalog.loadCatalog({ activeOnly: true });
  assert.equal(catalog.source, 'database');
  assert.deepEqual(catalog.members, [], 'a missing members table yields no members, not a failure');
});

test('the migration and schema artifacts declare the new tables and columns', () => {
  const root = path.join(__dirname, '..');
  const migration = fs.readFileSync(path.join(root, 'database', 'migrations', '006_artist_groups_members.sql'), 'utf8');
  const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
  const migrate = fs.readFileSync(path.join(root, 'src', 'server', 'migrate.js'), 'utf8');

  for (const source of [migration, schema, migrate]) {
    assert.match(source, /artist_members/);
    assert.match(source, /eyebrow/);
    assert.match(source, /hero_image_url/);
    assert.match(source, /cover_focal/);
    assert.match(source, /hero_focal/);
  }

  assert.match(migration, /CONSTRAINT fk_artist_member_group FOREIGN KEY \(group_id\) REFERENCES catalog_groups \(id\) ON DELETE CASCADE/);
  assert.match(migration, /UNIQUE KEY uq_artist_member_slug \(group_id, slug\)/);
  assert.match(migration, /KEY idx_artist_members_group_order \(group_id, is_active, sort_order\)/);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE|DELETE FROM/i, 'the migration must stay additive');
});

test('the admin dashboard exposes the artist and member management controls', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'src', 'admin.js'), 'utf8');

  assert.match(html, /data-view="artists"/);
  assert.match(html, /data-view-panel="artists"/);
  for (const tab of ['groups', 'members']) {
    assert.match(html, new RegExp(`data-artist-tab="${tab}"`));
    assert.match(html, new RegExp(`data-artist-panel="${tab}"`));
  }
  for (const id of ['artistGroupsBody', 'artistMembersBody', 'artistGroupForm', 'artistMemberForm', 'artistCoverInput', 'artistHeroInput', 'artistPortraitInput', 'artistCoverFocal', 'artistHeroFocal', 'artistGroupDelete', 'artistMemberDelete']) {
    assert.ok(html.includes(`id="${id}"`), `${id} must exist`);
  }

  assert.match(script, /\/api\/admin\/catalog\/members/);
  assert.match(script, /kind=hero/);
  assert.match(script, /trapFocusWithin\(\$\('#artistGroupModal'\)/, 'the group dialog must trap focus');
  assert.match(script, /trapFocusWithin\(\$\('#artistMemberModal'\)/, 'the member dialog must trap focus');
  assert.match(script, /window\.confirm/, 'destructive actions must ask for confirmation');
  assert.match(script, /setArtistTab/);
});

test('the storefront renders groups, hero images and members dynamically', () => {
  const root = path.join(__dirname, '..');
  const shop = fs.readFileSync(path.join(root, 'shop.html'), 'utf8');
  const artist = fs.readFileSync(path.join(root, 'artist.html'), 'utf8');
  const shopScript = fs.readFileSync(path.join(root, 'src', 'shop-page.js'), 'utf8');
  const artistScript = fs.readFileSync(path.join(root, 'src', 'artist-page.js'), 'utf8');

  assert.match(shop, /id="artistGrid"/);
  assert.doesNotMatch(shop, /artist\.html\?artist=blackpink/, 'collections are not hardcoded');
  assert.match(shopScript, /background-position:\$\{safeFocal\(artist\.coverFocal\)\}/, 'cards use the cover focal crop');

  assert.match(artist, /id="artistMembersSection"/);
  assert.match(artist, /id="artistMemberGrid"/);
  assert.match(artistScript, /payload\.members/, 'members come from the public API');
  assert.match(artistScript, /member-card/, 'member cards are rendered');
  assert.match(artistScript, /--artist-hero-focal/, 'the hero focal crop is applied');
  assert.doesNotMatch(artist, /data-product="blackpink-cloud-heart"/, 'designs are not hardcoded');
});
