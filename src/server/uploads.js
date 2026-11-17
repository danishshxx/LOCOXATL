const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Catalog card images are uploaded from the dashboard as a data URL (the browser downscales the
// photo first), validated here, and stored as a content-addressed file under assets/uploads.
// No multipart parser is needed, and the public path is served by the existing /assets allowlist.

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const PUBLIC_PREFIX = '/assets/uploads/catalog/';
const DEFAULT_DIR = path.join(__dirname, '..', '..', 'assets', 'uploads', 'catalog');
const PUBLIC_URL_PATTERN = /^\/assets\/uploads\/catalog\/[a-z0-9-]+-[a-f0-9]{12}\.(?:webp|jpg|png)$/;

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

function isManagedUrl(url) {
  return typeof url === 'string' && PUBLIC_URL_PATTERN.test(url);
}

/** Writes the image and returns its public path. Identical uploads reuse the same file. */
function saveCatalogImage(slug, dataUrl) {
  const { mime, buffer } = parseDataUrl(dataUrl);
  const digest = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  const filename = `${safeSlug(slug)}-${digest}.${EXTENSIONS[mime]}`;
  const directory = uploadDirectory();

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, filename), buffer);

  return `${PUBLIC_PREFIX}${filename}`;
}

/** Removes a previously uploaded file. Only paths this module owns are ever touched. */
function removeCatalogImage(url) {
  if (!isManagedUrl(url)) return false;
  const target = path.join(uploadDirectory(), url.slice(PUBLIC_PREFIX.length));
  try {
    fs.unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  UploadError,
  MAX_IMAGE_BYTES,
  PUBLIC_PREFIX,
  saveCatalogImage,
  removeCatalogImage,
  isManagedUrl,
  uploadDirectory,
};
