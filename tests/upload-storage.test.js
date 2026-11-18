const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// External image storage: the server uploads to Cloudinary when it is configured, persists only
// the returned URL, never leaks the API secret, and falls back to local storage otherwise.

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locoxatl-cloudinary-'));
process.env.CATALOG_UPLOAD_DIR = uploadDir;

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngDataUrl = () => `data:image/png;base64,${PNG_BASE64}`;

function clearCloudinaryEnv() {
  delete process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_API_KEY;
  delete process.env.CLOUDINARY_API_SECRET;
  delete process.env.CLOUDINARY_FOLDER;
}

function configureCloudinary() {
  process.env.CLOUDINARY_CLOUD_NAME = 'locoxatl-demo';
  process.env.CLOUDINARY_API_KEY = 'test-key';
  process.env.CLOUDINARY_API_SECRET = 'test-secret';
  process.env.CLOUDINARY_FOLDER = 'locoxatl/catalog';
}

test.after(() => {
  clearCloudinaryEnv();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

test('storage is local by default and switches to Cloudinary only when fully configured', () => {
  clearCloudinaryEnv();
  const uploads = require('../src/server/uploads');

  assert.equal(uploads.usesCloudStorage(), false);

  // A partial configuration must not switch backends.
  process.env.CLOUDINARY_CLOUD_NAME = 'locoxatl-demo';
  delete process.env.CLOUDINARY_API_KEY;
  delete process.env.CLOUDINARY_API_SECRET;
  assert.equal(uploads.usesCloudStorage(), false);

  configureCloudinary();
  assert.equal(uploads.usesCloudStorage(), true);
  clearCloudinaryEnv();
});

test('Railway rejects local fallback when Cloudinary config is missing or incomplete', async () => {
  const uploads = require('../src/server/uploads');
  const previousProjectId = process.env.RAILWAY_PROJECT_ID;
  const filesBefore = fs.readdirSync(uploadDir).sort();

  try {
    process.env.RAILWAY_PROJECT_ID = 'test-project';
    clearCloudinaryEnv();

    await assert.rejects(
      () => uploads.saveCatalogImage('railway-missing-config', pngDataUrl()),
      (error) => error.code === 'storage_not_configured' && error.statusCode === 503,
    );

    process.env.CLOUDINARY_CLOUD_NAME = 'locoxatl-demo';
    await assert.rejects(
      () => uploads.saveCatalogImage('railway-partial-config', pngDataUrl()),
      (error) => error.code === 'storage_not_configured' && error.statusCode === 503,
    );

    assert.deepEqual(fs.readdirSync(uploadDir).sort(), filesBefore, 'no local fallback file is written');
  } finally {
    if (previousProjectId === undefined) delete process.env.RAILWAY_PROJECT_ID;
    else process.env.RAILWAY_PROJECT_ID = previousProjectId;
    clearCloudinaryEnv();
  }
});

test('a Cloudinary upload is signed, sends no secret, and returns only the URL', async () => {
  configureCloudinary();
  const uploads = require('../src/server/uploads');

  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    captured.push({ url, options });
    return {
      ok: true,
      async json() {
        return { secure_url: 'https://res.cloudinary.com/locoxatl-demo/image/upload/v1/locoxatl/catalog/blackpink-abc123.webp' };
      },
    };
  };

  try {
    const url = await uploads.saveCatalogImage('blackpink-cover', pngDataUrl());

    assert.equal(url, 'https://res.cloudinary.com/locoxatl-demo/image/upload/v1/locoxatl/catalog/blackpink-abc123.webp');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, 'https://api.cloudinary.com/v1_1/locoxatl-demo/image/upload');

    const form = captured[0].options.body;
    assert.ok(form instanceof FormData, 'the upload must be multipart form data');
    assert.equal(form.get('api_key'), 'test-key');
    assert.equal(form.get('folder'), 'locoxatl/catalog');
    assert.ok(form.get('signature'), 'the request must be signed');
    // The secret itself is never sent to Cloudinary — only the derived signature.
    assert.equal(form.get('api_secret'), null);
    assert.ok(![...form.values()].includes('test-secret'), 'the API secret must not appear in the payload');

    assert.equal(uploads.usesCloudStorage(), true);
    assert.equal(fs.existsSync(path.join(uploadDir, 'blackpink-cover.png')), false, 'nothing is written locally');
  } finally {
    globalThis.fetch = realFetch;
    clearCloudinaryEnv();
  }
});

test('the Cloudinary signature is a deterministic SHA-1 of the signed parameters', async () => {
  configureCloudinary();
  const uploads = require('../src/server/uploads');

  let signature = null;
  let signedFields = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const form = options.body;
    signature = form.get('signature');
    signedFields = {
      folder: form.get('folder'),
      public_id: form.get('public_id'),
      timestamp: form.get('timestamp'),
    };
    return {
      ok: true,
      async json() {
        return { secure_url: 'https://res.cloudinary.com/locoxatl-demo/image/upload/v1/locoxatl/catalog/x.webp' };
      },
    };
  };

  try {
    await uploads.saveCatalogImage('group', pngDataUrl());

    const toSign = Object.keys(signedFields)
      .sort()
      .map((key) => `${key}=${signedFields[key]}`)
      .join('&');
    const expected = crypto.createHash('sha1').update(`${toSign}test-secret`).digest('hex');
    assert.equal(signature, expected, 'the signature covers folder, public_id and timestamp');
  } finally {
    globalThis.fetch = realFetch;
    clearCloudinaryEnv();
  }
});

test('a storage error surfaces without leaking the secret', async () => {
  configureCloudinary();
  const uploads = require('../src/server/uploads');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async json() {
      return { error: { message: 'Invalid Signature test-secret' } };
    },
  });

  try {
    await assert.rejects(
      () => uploads.saveCatalogImage('group', pngDataUrl()),
      (error) => {
        assert.equal(error.statusCode, 502);
        assert.ok(!error.message.includes('test-secret'));
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
    clearCloudinaryEnv();
  }
});

test('isManagedUrl accepts Cloudinary delivery URLs but not arbitrary HTTPS hosts', () => {
  clearCloudinaryEnv();
  const uploads = require('../src/server/uploads');

  assert.equal(
    uploads.isManagedUrl('https://res.cloudinary.com/locoxatl-demo/image/upload/v1699/locoxatl/catalog/a.webp'),
    true,
  );
  assert.equal(uploads.isManagedUrl('https://evil.example.com/image/upload/a.webp'), false);
  assert.equal(uploads.isManagedUrl('https://res.cloudinary.com/locoxatl-demo/raw/upload/a.txt'), false);
  assert.equal(uploads.isManagedUrl('/assets/uploads/catalog/blackpink-0123456789ab.png'), true);
});
