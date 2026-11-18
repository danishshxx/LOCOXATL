const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Artist and product images are uploaded from the dashboard as a data URL (the browser downscales
// the photo first), validated here, then written to persistent external object storage.
//
// Cloudinary is used whenever CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
// are present. Only the resulting public URL and the focal crop reach MySQL — never the bytes and
// never the credentials, which stay server-side. Railway containers have an ephemeral filesystem,
// so the local assets/uploads fallback exists for local development and tests only.

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const LOCAL_PREFIX = '/assets/uploads/catalog/';
const DEFAULT_DIR = path.join(__dirname, '..', '..', 'assets', 'uploads', 'catalog');
const LOCAL_URL_PATTERN = /^\/assets\/uploads\/catalog\/[a-z0-9-]+-[a-f0-9]{12}\.(?:webp|jpg|png)$/;
const CLOUDINARY_URL_PATTERN = /^https:\/\/res\.cloudinary\.com\/[a-z0-9-]+\/image\/upload\/[A-Za-z0-9._~\-/]+$/;
const CLOUDINARY_UPLOAD_ENDPOINT = 'https://api.cloudinary.com/v1_1';
const CLOUDINARY_FOLDER = 'locoxatl/catalog';

const EXTENSIONS = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

class UploadError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function uploadDirectory() {
  return process.env.CATALOG_UPLOAD_DIR
    ? path.resolve(process.env.CATALOG_UPLOAD_DIR)
    : DEFAULT_DIR;
}

function cloudinarySettings() {
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret, folder: String(process.env.CLOUDINARY_FOLDER || CLOUDINARY_FOLDER).trim() };
}

/** True when uploads go to Cloudinary instead of the local fallback directory. */
function usesCloudStorage() {
  return cloudinarySettings() !== null;
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
    throw new UploadError('image_too_large', 'Images must be 3 MB or smaller.', 413);
  }

  const actual = sniffMime(buffer);
  if (!actual || actual !== declared) {
    throw new UploadError('invalid_image', 'The file content is not a valid PNG, JPEG or WebP image.');
  }

  return { mime: actual, buffer };
}

function safeSlug(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'group';
}

/** Only URLs this module produced may be stored, rendered, or deleted. */
function isManagedUrl(url) {
  if (typeof url !== 'string') return false;
  return LOCAL_URL_PATTERN.test(url) || CLOUDINARY_URL_PATTERN.test(url);
}

function writeLocalImage(slug, { mime, buffer }) {
  const digest = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  const filename = `${safeSlug(slug)}-${digest}.${EXTENSIONS[mime]}`;
  const directory = uploadDirectory();

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, filename), buffer);

  return `${LOCAL_PREFIX}${filename}`;
}

/**
 * Signs and sends the upload to Cloudinary's REST API. The signature is a SHA-1 over the sorted
 * parameters with the API secret appended; the secret itself never leaves this process.
 */
async function uploadToCloudinary(slug, { mime, buffer }) {
  const settings = cloudinarySettings();
  if (!settings) {
    throw new UploadError('storage_not_configured', 'Image storage is not configured on the server.', 503);
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `${safeSlug(slug)}-${crypto.randomBytes(6).toString('hex')}`;
  const signed = { folder: settings.folder, public_id: publicId, timestamp };
  const toSign = Object.keys(signed)
    .sort()
    .map((key) => `${key}=${signed[key]}`)
    .join('&');
  const signature = crypto
    .createHash('sha1')
    .update(`${toSign}${settings.apiSecret}`)
    .digest('hex');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), `${publicId}.${EXTENSIONS[mime]}`);
  form.append('api_key', settings.apiKey);
  form.append('timestamp', String(timestamp));
  form.append('folder', settings.folder);
  form.append('public_id', publicId);
  form.append('signature', signature);

  const endpoint = `${CLOUDINARY_UPLOAD_ENDPOINT}/${settings.cloudName}/image/upload`;

  let response;
  try {
    response = await fetch(endpoint, { method: 'POST', body: form });
  } catch {
    throw new UploadError('storage_unavailable', 'The image storage could not be reached. Try again.', 502);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.secure_url) {
    // The upstream message is deliberately not echoed to the browser: it can contain signed
    // parameters, and the dashboard only needs to know the upload failed.
    throw new UploadError('storage_rejected', 'The image storage rejected the upload. Try again.', 502);
  }
  if (!isManagedUrl(payload.secure_url)) {
    throw new UploadError('storage_rejected', 'The image storage returned an unexpected URL.', 502);
  }
  return payload.secure_url;
}

/**
 * Persists an image and returns its public URL. Cloudinary is used when configured; otherwise the
 * file lands in assets/uploads/catalog and is served by the /assets allowlist.
 */
async function saveCatalogImage(slug, dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  const settings = cloudinarySettings();
  if (settings) return uploadToCloudinary(slug, parsed);
  if (process.env.RAILWAY_PROJECT_ID) {
    throw new UploadError(
      'storage_not_configured',
      'Persistent image storage must be configured on Railway.',
      503,
    );
  }
  return writeLocalImage(slug, parsed);
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

  if (LOCAL_URL_PATTERN.test(url)) {
    const target = path.join(uploadDirectory(), url.slice(LOCAL_PREFIX.length));
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
  PUBLIC_PREFIX: LOCAL_PREFIX,
  LOCAL_URL_PATTERN,
  CLOUDINARY_URL_PATTERN,
  saveCatalogImage,
  removeCatalogImage,
  isManagedUrl,
  usesCloudStorage,
  uploadDirectory,
  parseDataUrl,
  sniffMime,
};
