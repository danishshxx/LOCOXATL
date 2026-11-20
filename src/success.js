(() => {
  const $ = (id) => document.getElementById(id);
  const whatsapp = window.LocoxatlWhatsApp;
  let order;
  try { order = JSON.parse(localStorage.getItem('locoxatl-pending-order') || 'null'); } catch { order = null; }
  if (!order || !whatsapp) return;
  const orderNumber = new URLSearchParams(window.location.search).get('order') || order.orderNumber || 'LX-DEMO';
  $('successOrderNumber').textContent = orderNumber;
  $('successStatus').textContent = order.status === 'payment_confirmation_sent' ? 'WAITING FOR ADMIN VERIFICATION' : 'WAITING FOR PAYMENT';
  $('successMessage').textContent = `Thank you, ${order.customer?.name || 'there'}. Your payment confirmation has been prepared. The LOCOXATL admin will verify the payment before production begins.`;

  // Same verification template as the payment page (src/whatsapp.js).
  const message = whatsapp.buildVerificationMessage(orderNumber);

  const whatsappLink = $('successWhatsApp');
  const copyButton = $('copyOrderMessage');
  const actionStatus = $('successActionStatus');

  // The confirmation has to land in the shop chat, so the button is only armed once the
  // configured number is known; it is never pointed at the generic share sheet.
  whatsappLink.removeAttribute('tabindex');

  const publicConfig = window.locoxatlPublicConfig || fetch('/api/public-config').then((response) => {
    if (!response.ok) throw new Error(`Public configuration request failed (${response.status}).`);
    return response.json();
  });

  function disableWhatsAppLink(messageText) {
    whatsappLink.removeAttribute('href');
    whatsappLink.setAttribute('aria-disabled', 'true');
    actionStatus.textContent = messageText;
  }

  publicConfig.then((config) => {
    const url = config && config.whatsappNumber
      ? whatsapp.buildDirectChatUrl(config.whatsappNumber, message)
      : '';
    if (!url) {
      disableWhatsAppLink('WhatsApp is not configured yet. Copy your order message and send it to our CS.');
      return;
    }
    whatsappLink.href = url;
    whatsappLink.removeAttribute('aria-disabled');
  }).catch(() => {
    disableWhatsAppLink('WhatsApp could not be configured. Copy your order message and send it to our CS.');
  });

  copyButton.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(message);
          actionStatus.textContent = 'Order message copied.';
          return;
        } catch { /* use the browser selection fallback */ }
      }

      try {
        const textArea = document.createElement('textarea');
        textArea.value = message;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        const copied = document.execCommand('copy');
        textArea.remove();
        if (!copied) throw new Error('Clipboard copy was rejected.');
        actionStatus.textContent = 'Order message copied.';
      } catch {
        const manualCopy = $('orderMessageFallback');
        manualCopy.value = message;
        manualCopy.hidden = false;
        manualCopy.focus();
        manualCopy.select();
        actionStatus.textContent = 'Clipboard unavailable. The message is selected for you to copy manually.';
      }
    } catch {
      actionStatus.textContent = 'Could not copy the message. Please try selecting it manually below.';
    }
  });
})();
