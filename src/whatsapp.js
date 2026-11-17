(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LocoxatlWhatsApp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // The exact message the customer sends to the shop when confirming a payment. Keep this as
  // the single source of truth: the payment page, the success page and the tests all use it.
  const VERIFICATION_TEMPLATE = 'halo kak ingin memverifikasi pembelian dan pembayaran dengan nomor order : {orderNumber}';

  function buildVerificationMessage(orderNumber) {
    const value = String(orderNumber == null ? '' : orderNumber).trim();
    return VERIFICATION_TEMPLATE.replace('{orderNumber}', value || 'LX-DEMO');
  }

  /**
   * Builds the wa.me chat link. With a valid number it opens a direct chat with the shop;
   * without one it falls back to the generic share sheet so the customer can pick a chat.
   */
  function buildChatUrl(whatsappNumber, message) {
    const digits = String(whatsappNumber == null ? '' : whatsappNumber).replace(/\D/g, '');
    const text = encodeURIComponent(String(message == null ? '' : message));
    if (!/^[1-9]\d{7,14}$/.test(digits)) return `https://wa.me/?text=${text}`;
    return `https://wa.me/${digits}?text=${text}`;
  }

  return { VERIFICATION_TEMPLATE, buildVerificationMessage, buildChatUrl };
});
