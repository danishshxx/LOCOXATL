(() => {
  const $ = (selector) => document.querySelector(selector);
  const whatsapp = window.LocoxatlWhatsApp;
  const money = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value).replace('IDR', 'Rp').replace(/\s/g, '');
  let order;
  try { order = JSON.parse(localStorage.getItem('locoxatl-pending-order') || 'null'); } catch { order = null; }
  if (!order || !order.orderNumber || !whatsapp) {
    $('#paymentOrderNumber').textContent = 'NO ACTIVE ORDER';
    $('#paymentTotal').textContent = '—';
    $('#finishPaymentDemo').disabled = true;
    $('#whatsappConfirm').setAttribute('aria-disabled', 'true');
    return;
  }

  $('#paymentOrderNumber').textContent = order.orderNumber;
  $('#paymentTotal').textContent = money(order.total || 0);
  $('#paymentCustomerName').textContent = order.customer?.name || 'Customer';
  $('#paymentCustomerAddress').textContent = order.customer?.address || 'Address not provided';

  const FULFILLMENT_LABELS = {
    campus_delivery: 'Campus delivery (Telkom University Jakarta)',
    cod_telkom: 'COD / meet-up (Telkom University Jakarta)',
    shopee_external: 'External order via Shopee',
  };
  const fulfillmentNote = $('#paymentFulfillmentNote');
  if (fulfillmentNote) {
    fulfillmentNote.textContent = FULFILLMENT_LABELS[order.fulfillmentMethod] || FULFILLMENT_LABELS.campus_delivery;
  }

  // Only the method the buyer picked is shown. The stored snapshot renders immediately, and the
  // live table replaces it so an admin edit (label, instructions, QRIS image) is honoured.
  const storedPayment = order.payment || null;
  const METHOD_MARKS = { qris: 'QRIS', cash: 'CASH', transfer: 'BANK' };
  const METHOD_LABELS = { qris: 'QRIS', cash: 'Cash', transfer: 'Bank Transfer' };
  const methodCode = String(order.paymentMethod || (storedPayment && storedPayment.code) || 'qris').toLowerCase();

  function applyPaymentMethod(method) {
    const code = String((method && method.code) || methodCode).toLowerCase();
    const label = (method && method.label) || (storedPayment && storedPayment.label) || METHOD_LABELS[code] || 'Payment';
    const instructions = (method && method.instructions) || (storedPayment && storedPayment.instructions) || '';
    const imageUrl = (method && method.imageUrl) || (storedPayment && storedPayment.imageUrl) || null;

    const badge = $('#paymentMethodBadge');
    if (badge) badge.textContent = label.toUpperCase();
    const labelEl = $('#paymentMethodLabel');
    if (labelEl) labelEl.textContent = label;
    const instructionsEl = $('#paymentInstructions');
    if (instructionsEl) {
      instructionsEl.textContent = instructions || 'Follow the payment instructions from our WhatsApp CS.';
    }

    const mark = $('#paymentMethodMark');
    if (mark) mark.textContent = METHOD_MARKS[code] || 'PAY';

    const image = $('#paymentQrImage');
    const fallback = $('#paymentMethodFallback');
    if (image) {
      if (imageUrl) {
        image.src = imageUrl;
        image.alt = `${label} payment code`;
        image.hidden = false;
        if (fallback) fallback.hidden = true;
      } else {
        image.removeAttribute('src');
        image.hidden = true;
        if (fallback) fallback.hidden = false;
      }
    }
  }

  applyPaymentMethod(null);

  fetch('/api/payment-methods')
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      const methods = data && Array.isArray(data.paymentMethods) ? data.paymentMethods : [];
      const match = methods.find((method) => method.code === methodCode);
      if (match) applyPaymentMethod(match);
    })
    .catch(() => { /* the stored snapshot already covers this */ });

  // Customer verification message — shared template with the success page (src/whatsapp.js).
  const message = whatsapp.buildVerificationMessage(order.orderNumber);
  const whatsappLink = $('#whatsappConfirm');
  const whatsappStatus = $('#paymentWhatsAppStatus');

  // The confirmation has to land in the shop chat, so the link is only armed once the configured
  // number is known. A generic share link is never used here.
  const publicConfig = window.locoxatlPublicConfig || fetch('/api/public-config').then((response) => {
    if (!response.ok) throw new Error(`Public configuration request failed (${response.status}).`);
    return response.json();
  });

  function disableWhatsAppLink(messageText) {
    whatsappLink.removeAttribute('href');
    whatsappLink.setAttribute('aria-disabled', 'true');
    if (whatsappStatus) {
      whatsappStatus.textContent = messageText;
      whatsappStatus.hidden = false;
    }
  }

  publicConfig.then((config) => {
    const url = config && config.whatsappNumber
      ? whatsapp.buildDirectChatUrl(config.whatsappNumber, message)
      : '';
    if (!url) {
      disableWhatsAppLink('WhatsApp is not configured yet. Copy your order reference and message our CS.');
      return;
    }
    whatsappLink.href = url;
    whatsappLink.removeAttribute('aria-disabled');
  }).catch(() => {
    disableWhatsAppLink('WhatsApp could not be configured. Copy your order reference and message our CS.');
  });

  $('#finishPaymentDemo').addEventListener('click', async () => {
    order.status = 'payment_confirmation_sent';
    order.confirmationSentAt = new Date().toISOString();

    // Best effort: mirror the confirmation to MySQL when the order was persisted.
    // A failed request must not block the customer, the local snapshot still records it.
    if (order.persisted && order.orderNumber) {
      try {
        await fetch(`/api/orders/${encodeURIComponent(order.orderNumber)}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'payment_confirmation_sent' }),
          keepalive: true,
        });
      } catch { /* offline or API unavailable */ }
    }

    localStorage.setItem('locoxatl-pending-order', JSON.stringify(order));
    window.location.href = `order-success.html?order=${encodeURIComponent(order.orderNumber)}`;
  });
})();
