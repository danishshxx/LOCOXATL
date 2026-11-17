// Public contact defaults. They are real values on purpose: a fresh clone on the DEVELOPMENT
// branch renders working contact links with no .env file at all. process.env always wins, and
// the documented placeholder tokens from .env.example are treated as "not filled in yet".
const DEFAULT_WHATSAPP_BUSINESS_NUMBER = '+62 812-8211-6351';
const DEFAULT_INSTAGRAM_URL = 'https://www.instagram.com/locoxatl?rpxt=bGlxY2ExOGY4OWRz';

const PLACEHOLDER_VALUES = new Set([
  '[ISI_NOMOR_WA_628XXX]',
  '[ISI_LINK_INSTAGRAM]',
]);

function resolveConfiguredValue(value, fallback) {
  const text = String(value == null ? '' : value).trim();
  if (!text || PLACEHOLDER_VALUES.has(text)) return fallback;
  return text;
}

function normalizeWhatsAppNumber(value) {
  const input = String(value || '').trim();
  if (!input || !/^\+?[\d\s().-]+$/.test(input)) return null;

  let number = input.replace(/\D/g, '');
  if (number.startsWith('0')) number = `62${number.slice(1)}`;
  else if (number.startsWith('8')) number = `62${number}`;

  return /^[1-9]\d{7,14}$/.test(number) ? number : null;
}

function validateInstagramUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || !['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())
      || url.pathname === '/'
      || url.username
      || url.password
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function getPublicConfig(env = process.env) {
  return {
    whatsappNumber: normalizeWhatsAppNumber(
      resolveConfiguredValue(env.WHATSAPP_BUSINESS_NUMBER, DEFAULT_WHATSAPP_BUSINESS_NUMBER),
    ),
    instagramUrl: validateInstagramUrl(
      resolveConfiguredValue(env.INSTAGRAM_URL, DEFAULT_INSTAGRAM_URL),
    ),
  };
}

module.exports = {
  getPublicConfig,
  normalizeWhatsAppNumber,
  validateInstagramUrl,
  resolveConfiguredValue,
  DEFAULT_WHATSAPP_BUSINESS_NUMBER,
  DEFAULT_INSTAGRAM_URL,
  PLACEHOLDER_VALUES,
};
