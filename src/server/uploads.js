const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Artist, member, product and catalog images are uploaded from the dashboard as a data URL (the
// browser downscales the photo first), validated here, then written to storage.
//
// UPLOAD_DRIVER picks the backend: `local` writes to UPLOAD_DIR (a persistent VPS volume by
// default), `cloudinary` keeps the historical object-storage path. Cloudinary is used when it is
// configured and no driver is named, so an environment that predates the VPS keeps working.
//
// Only the resulting public URL and the focal crop reach MySQL — never the bytes and never the
// credentials, which stay server-side.

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const UPLOAD_CATEGORIES = ['catalog', 'members', 'groups', 'products'];
const PUBLIC_PREFIX = '/uploads/';
const LEGACY_LOCAL_PREFIX = '/assets/uploads/catalog/';
const DEFAULT_PRODUCTION_DIR = '/var/lib/locoxatl/uploads';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const LEGACY_LOCAL_DIR = path.join(PROJECT_ROOT, 'assets', 'uploads', 'catalog');
const CLOUDINARY_UPLOAD_ENDPOINT = 'https://api.cloudinary.com/v1_1';
const CLOUDINARY_FOLDER = 'locoxatl/catalog';

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PUBLIC_URL_PATTERN = new RegExp(`^/uploads/(?:${UPLOAD_CATEGORIES.join('|')})/${UUID_SOURCE}\\.(?:webp|png|jpg|jpeg)$`);
const LOCAL_URL_PATTERN = /^\/assets\/uploads\/catalog\/[a-z0-9-]+-[a-f0-9]{12}\.(?:webp|jpg|png)$/;
const CLOUDINARY_URL_PATTERN = /^https:\/\/res\.cloudinary\.com\/[a-z0-9-]+\/image\/upload\/[A-Za-z0-9._~\-/]+$/;

const EXTENSIONS = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

const CONTENT_TYPES = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

class UploadError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const isProduction = () => process.env.NODE_ENV === 'production';

function cloudinarySettings() {
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret, folder: String(process.env.CLOUDINARY_FOLDER || CLOUDINARY_FOLDER).trim() };
}

/**
 * `local` unless Cloudinary is explicitly forced. A production process never falls back to
 * object storage on its own: the VPS keeps its files on the persistent volume, and an
 * environment that still needs Cloudinary names it in UPLOAD_DRIVER.
 */
function uploadDriver() {
  const explicit = String(process.env.UPLOAD_DRIVER || '').trim().toLowerCase();
  if (explicit === 'cloudinary' || explicit === 'local') return explicit;
  if (isProduction()) return 'local';
  return cloudinarySettings() ? 'cloudinary' : 'local';
}

/** True when uploads go to Cloudinary instead of the local directory. */
function usesCloudStorage() {
  return uploadDriver() === 'cloudinary';
}

/** The directory uploads are written to. Never inside the application directory. */
function uploadRoot() {
  const configured = String(process.env.UPLOAD_DIR || process.env.CATALOG_UPLOAD_DIR || '').trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (resolved === PROJECT_ROOT || resolved.startsWith(PROJECT_ROOT + path.sep)) {
      throw new UploadError('invalid_upload_dir', 'UPLOAD_DIR must live outside the application directory.', 500);
    }
    return resolved;
  }
  return isProduction() ? DEFAULT_PRODUCTION_DIR : path.join(os.homedir(), '.locoxatl', 'uploads');
}

function isUploadCategory(value) {
  return UPLOAD_CATEGORIES.includes(String(value || '').toLowerCase());
}

/** Joins inside `root` only: a segment that could escape it is refused, never normalised away. */
function safeJoin(root, ...segments) {
  for (const segment of segments) {
    const text = String(segment == null ? '' : segment);
    if (!text || text.includes('\0') || text.includes('..') || path.isAbsolute(text) || /[\\/]/.test(text)) {
      throw new UploadError('invalid_path', 'That file path is not allowed.', 400);
    }
  }
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new UploadError('invalid_path', 'That file path is not allowed.', 400);
  }
  return target;
}

function uploadDirectory(category = 'catalog') {
  const name = String(category || '').toLowerCase();
  if (!isUploadCategory(name)) {
    throw new UploadError('invalid_category', 'Unknown upload category.', 400);
  }
  return safeJoin(uploadRoot(), name);
}

/** Reads the real image type from the file header instead of trusting the data URL. */
function sniffMime(buffer) {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.trim()) {
    throw new UploadError('invalid_image', 'Choose a PNG, JPEG or WebP image to upload.');
  }

  const match = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!match) {
    throw new UploadError('invalid_image', 'Choose a PNG, JPEG or WebP image to upload.');
  }

  const declared = match[1];
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) {
    throw new UploadError('invalid_image', 'The uploaded image was empty.');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new UploadError('image_too_large', 'Images must be 5 MB or smaller.', 413);
  }

  // The bytes decide, not the declared type: a JPEG renamed to .png is still rejected.
  const actual = sniffMime(buffer);
  if (!actual || actual !== declared) {
    throw new UploadError('invalid_image', 'The file content is not a valid PNG, JPEG or WebP image.');
  }

  return { mime: actual, buffer };
}

/** Only URLs this module produced may be stored, rendered, or deleted. */
function isManagedUrl(url) {
  if (typeof url !== 'string') return false;
  return PUBLIC_URL_PATTERN.test(url) || LOCAL_URL_PATTERN.test(url) || CLOUDINARY_URL_PATTERN.test(url);
}

/** The absolute path a managed local URL points at, or null when the URL is not a local file. */
function localFileFor(url) {
  if (PUBLIC_URL_PATTERN.test(url)) {
    const [, category, filename] = /^\/uploads\/([a-z]+)\/([^/]+)$/.exec(url);
    return safeJoin(uploadDirectory(category), filename);
  }
  if (LOCAL_URL_PATTERN.test(url)) {
    return safeJoin(LEGACY_LOCAL_DIR, url.slice(LEGACY_LOCAL_PREFIX.length));
  }
  return null;
}

/**
 * Maps a request path to a file inside the upload root. Anything that is not exactly
 * `/uploads/<category>/<uuid>.<ext>` returns null, so there is no directory listing, no traversal
 * and no way to serve a file this module did not write.
 */
function resolveUploadFile(pathname) {
  if (typeof pathname !== 'string' || !PUBLIC_URL_PATTERN.test(pathname)) return null;
  const [, category, filename] = /^\/uploads\/([a-z]+)\/([^/]+)$/.exec(pathname);
  const extension = path.extname(filename).slice(1).toLowerCase();
  return {
    category,
    filePath: safeJoin(uploadDirectory(category), filename),
    contentType: CONTENT_TYPES[extension],
  };
}

function writeLocalImage(category, { mime, buffer }) {
  const directory = uploadDirectory(category);
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });

  const filename = `${crypto.randomUUID()}.${EXTENSIONS[mime]}`;
  const target = safeJoin(directory, filename);
  // 'wx' turns a name collision into an error instead of an overwrite.
  fs.writeFileSync(target, buffer, { flag: 'wx', mode: 0o644 });

  return `${PUBLIC_PREFIX}${category}/${filename}`;
}

function safeSlug(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'image';
}

/**
 * Signs and sends the upload to Cloudinary's REST API. The signature is a SHA-1 over the sorted
 * parameters with the API secret appended; the secret itself never leaves this process.
 */
async function uploadToCloudinary(name, { mime, buffer }) {
  const settings = cloudinarySettings();

  if (!settings) {
    throw new UploadError(
      'storage_not_configured',
      'Image storage is not configured on the server.',
      503,
    );
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `${safeSlug(name)}-${crypto.randomBytes(6).toString('hex')}`;

  const signed = {
    folder: settings.folder,
    public_id: publicId,
    timestamp,
  };

  const toSign = Object.keys(signed)
    .sort()
    .map((key) => `${key}=${signed[key]}`)
    .join('&');

  const signature = crypto
    .createHash('sha1')
    .update(`${toSign}${settings.apiSecret}`)
    .digest('hex');

  const form = new FormData();

  form.append(
    'file',
    new Blob([buffer], { type: mime }),
    `${publicId}.${EXTENSIONS[mime]}`,
  );
  form.append('api_key', settings.apiKey);
  form.append('timestamp', String(timestamp));
  form.append('folder', settings.folder);
  form.append('public_id', publicId);
  form.append('signature', signature);

  const endpoint =
    `${CLOUDINARY_UPLOAD_ENDPOINT}/${settings.cloudName}/image/upload`;

  let response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      body: form,
    });
  } catch (error) {
    console.error('[Cloudinary] Network failure:', {
      name: error?.name,
      code: error?.cause?.code || error?.code || null,
      message: String(error?.message || 'Unknown error')
        .replaceAll(settings.apiSecret, '[REDACTED]')
        .slice(0, 240),
    });

    throw new UploadError(
      'storage_unavailable',
      'The image storage could not be reached. Try again.',
      502,
    );
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.secure_url) {
    const upstreamMessage = String(
      payload?.error?.message || 'Missing secure_url',
    )
      .replaceAll(settings.apiSecret, '[REDACTED]')
      .replaceAll(settings.apiKey, '[REDACTED]')
      .replace(/signature[=:]\s*[a-f0-9]+/gi, 'signature=[REDACTED]')
      .slice(0, 240);

    console.error('[Cloudinary] Upload rejected:', {
      status: response.status,
      code: payload?.error?.http_code || null,
      message: upstreamMessage,
      cloudName: settings.cloudName,
      folder: settings.folder,
    });

    throw new UploadError(
      'storage_rejected',
      'The image storage rejected the upload. Try again.',
      502,
    );
  }

  if (!isManagedUrl(payload.secure_url)) {
    throw new UploadError(
      'storage_rejected',
      'The image storage returned an unexpected URL.',
      502,
    );
  }

  return payload.secure_url;
}

/**
 * Persists an image and returns its public URL. `category` decides the subdirectory the file is
 * written to; `name` only shapes the Cloudinary public id, because a local file is named by its
 * UUID.
 */
async function saveCatalogImage(name, dataUrl, category = 'catalog') {
  const parsed = parseDataUrl(dataUrl);
  const driver = uploadDriver();

  if (driver === 'cloudinary') return uploadToCloudinary(name, parsed);

  // A container filesystem is thrown away on every deploy, so a platform that reports itself as
  // ephemeral must name object storage instead of silently losing the image.
  if (process.env.RAILWAY_PROJECT_ID) {
    throw new UploadError(
      'storage_not_configured',
      'Persistent image storage must be configured on this host.',
      503,
    );
  }

  return writeLocalImage(category, parsed);
}

function cloudinaryPublicId(url) {
  // .../upload/v1690000000/locoxatl/catalog/blackpink-ab12cd34ef56.webp -> locoxatl/catalog/...
  const match = /\/upload\/(?:v\d+\/)?(.+)$/.exec(url);
  return match ? match[1].replace(/\.[a-z0-9]+$/i, '') : null;
}

async function deleteFromCloudinary(url) {
  const settings = cloudinarySettings();
  const publicId = cloudinaryPublicId(url);
  if (!settings || !publicId) return false;

  const timestamp = Math.floor(Date.now() / 1000);
  const toSign = `public_id=${publicId}&timestamp=${timestamp}`;
  const signature = crypto
    .createHash('sha1')
    .update(`${toSign}${settings.apiSecret}`)
    .digest('hex');

  const form = new FormData();
  form.append('public_id', publicId);
  form.append('timestamp', String(timestamp));
  form.append('api_key', settings.apiKey);
  form.append('signature', signature);

  try {
    const response = await fetch(`${CLOUDINARY_UPLOAD_ENDPOINT}/${settings.cloudName}/image/destroy`, {
      method: 'POST',
      body: form,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Removes a previously stored image. Only URLs this module owns are ever touched. */
async function removeCatalogImage(url) {
  if (!isManagedUrl(url)) return false;

  const target = localFileFor(url);
  if (target) {
    try {
      fs.unlinkSync(target);
      return true;
    } catch {
      return false;
    }
  }

  return deleteFromCloudinary(url);
}

module.exports = {
  UploadError,
  MAX_IMAGE_BYTES,
  PUBLIC_PREFIX,
  UPLOAD_CATEGORIES,
  PUBLIC_URL_PATTERN,
  LOCAL_URL_PATTERN,
  CLOUDINARY_URL_PATTERN,
  saveCatalogImage,
  removeCatalogImage,
  isManagedUrl,
  usesCloudStorage,
  uploadDriver,
  uploadRoot,
  uploadDirectory,
  isUploadCategory,
  resolveUploadFile,
  parseDataUrl,
  sniffMime,
};
