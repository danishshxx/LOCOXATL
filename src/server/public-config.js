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
    whatsappNumber: normalizeWhatsAppNumber(env.WHATSAPP_BUSINESS_NUMBER),
    instagramUrl: validateInstagramUrl(env.INSTAGRAM_URL),
  };
}

module.exports = { getPublicConfig, normalizeWhatsAppNumber, validateInstagramUrl };
