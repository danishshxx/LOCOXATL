(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LocoxatlWhatsApp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // The exact message the customer sends to the shop when confirming a payment. Keep this as
  // the single source of truth: the payment page, the success page and the tests all use it.
  const VERIFICATION_TEMPLATE = 'halo kak ingin memverifikasi pembelian dan pembayaran dengan nomor order : {orderNumber}';

  // wa.me only accepts an international number without symbols: 62 followed by the local part.
  const PHONE_PATTERN = /^[1-9]\d{7,14}$/;

  function buildVerificationMessage(orderNumber) {
    const value = String(orderNumber == null ? '' : orderNumber).trim();
    return VERIFICATION_TEMPLATE.replace('{orderNumber}', value || 'LX-DEMO');
  }

  /**
   * Shopee orders are settled off-site, so the buyer asks CS for a checkout link instead of a
   * payment method. The message carries everything CS needs to build that link in one reply.
   */
  function buildShopeeMessage(input = {}) {
    const lines = [
      'halo kak, saya mau order lewat Shopee',
      'tolong kirimkan link CO Shopee untuk pesanan ini ya',
    ];
    const selection = String(input.selection == null ? '' : input.selection).trim();
    const total = String(input.total == null ? '' : input.total).trim();
    const orderNumber = String(input.orderNumber == null ? '' : input.orderNumber).trim();

    if (input.artist) lines.push(`Koleksi: ${String(input.artist).trim()}`);
    if (selection) lines.push(`Pilihan: ${selection}`);
    if (total) lines.push(`Total: ${total}`);
    if (orderNumber) lines.push(`Nomor order: ${orderNumber}`);
    return lines.join('\n');
  }

  /** Custom design collections collect the artwork on WhatsApp, after payment. */
  function buildCustomDesignMessage(designName) {
    const name = String(designName == null ? '' : designName).trim();
    return [
      'halo kak, saya mau custom design LOCOXATL',
      name ? `Desain: ${name}` : '',
      'saya sudah melakukan pembayaran, berikut file desain dan bukti pembayarannya',
    ].filter(Boolean).join('\n');
  }

  /**
   * COD is confirmed on WhatsApp after the order has been saved, so the admin receives the
   * complete order in one message and never has to ask the buyer to repeat it.
   */
  function buildCodMessage(input = {}) {
    const value = (key) => String(input[key] == null ? '' : input[key]).trim();
    const lines = [
      'Halo admin LOCOXATL!',
      '',
      'Saya ingin mengonfirmasi pesanan COD berikut:',
      '',
    ];
    const orderNumber = value('orderNumber');
    if (orderNumber) lines.push(`Order: ${orderNumber}`);
    if (input.name) lines.push(`Nama: ${value('name')}`);
    if (input.phone) lines.push(`No. WhatsApp: ${value('phone')}`);
    if (input.artist) lines.push(`Koleksi: ${value('artist')}`);
    if (input.member) lines.push(`Member: ${value('member')}`);
    else if (input.product) lines.push(`Produk: ${value('product')}`);
    if (input.configuration) lines.push(`Konfigurasi: ${value('configuration')}`);
    if (input.addons) lines.push(`Add-ons: ${value('addons')}`);
    if (input.bundle) lines.push(`Paket: ${value('bundle')}`);
    if (input.quantity) lines.push(`Jumlah: ${value('quantity')}`);
    if (input.fulfillment) lines.push(`Pengiriman: ${value('fulfillment')}`);
    if (input.address) lines.push(`Alamat: ${value('address')}`);
    if (input.note) lines.push(`Catatan: ${value('note')}`);
    if (input.total) lines.push(`Total: ${value('total')}`);
    lines.push(
      '',
      'Metode pembayaran: COD.',
      '',
      'Mohon konfirmasi apakah pesanan saya dapat diproses.',
      '',
      'Terima kasih!',
    );
    return lines.join('\n');
  }

  /**
   * Indonesian numbers reach us as +62 812-…, 62812…, 0812… or 812…. Normalise those to the
   * digits-only international form wa.me expects, and return '' when the input cannot be fixed.
   */
  function normalizeWhatsAppNumber(value) {
    let digits = String(value == null ? '' : value).replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
    else if (digits.startsWith('8')) digits = `62${digits}`;
    return PHONE_PATTERN.test(digits) ? digits : '';
  }

  /**
   * Builds an absolute wa.me link. With a valid number it opens a direct chat with the shop;
   * without one it falls back to the generic share sheet so the customer can pick a chat.
   * The result is always an https://wa.me/ URL, never a local path.
   */
  function buildChatUrl(whatsappNumber, message) {
    const digits = normalizeWhatsAppNumber(whatsappNumber);
    const text = encodeURIComponent(String(message == null ? '' : message));
    if (!digits) return `https://wa.me/?text=${text}`;
    return `https://wa.me/${digits}?text=${text}`;
  }

  /**
   * A direct chat link for a known number. Returns '' when the number cannot be normalised, so a
   * caller can leave its control disabled instead of silently shipping the generic share sheet.
   */
  function buildDirectChatUrl(whatsappNumber, message) {
    const digits = normalizeWhatsAppNumber(whatsappNumber);
    if (!digits) return '';
    return `https://wa.me/${digits}?text=${encodeURIComponent(String(message == null ? '' : message))}`;
  }

  // Mirrors the server default in src/server/public-config.js, so a storefront whose
  // configuration request fails still opens the shop chat instead of a dead control.
  const DEFAULT_WHATSAPP_NUMBER = '6281282116351';

  /**
   * The link every storefront control uses. The configured number wins; the built-in shop number
   * is the fallback, so the result is always a direct chat with a real number.
   */
  function buildStorefrontChatUrl(config, message) {
    const number = (config && config.whatsappNumber) || DEFAULT_WHATSAPP_NUMBER;
    return buildDirectChatUrl(number, message);
  }

  return {
    VERIFICATION_TEMPLATE,
    buildVerificationMessage,
    buildShopeeMessage,
    buildCustomDesignMessage,
    buildCodMessage,
    normalizeWhatsAppNumber,
    buildChatUrl,
    buildDirectChatUrl,
    buildStorefrontChatUrl,
    DEFAULT_WHATSAPP_NUMBER,
  };
});
