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
  whatsappLink.addEventListener('click', (event) => {
    if (whatsappLink.getAttribute('aria-disabled') === 'true') event.preventDefault();
  });
  const publicConfig = window.locoxatlPublicConfig || fetch('/api/public-config').then((response) => {
    if (!response.ok) throw new Error(`Public configuration request failed (${response.status}).`);
    return response.json();
  });

  publicConfig.then(({ whatsappNumber }) => {
    if (!whatsappNumber || !/^[1-9]\d{7,14}$/.test(whatsappNumber)) {
      actionStatus.textContent = 'WhatsApp is unavailable. You can copy the message and contact us manually.';
      return;
    }
    whatsappLink.href = whatsapp.buildChatUrl(whatsappNumber, message);
    whatsappLink.removeAttribute('aria-disabled');
    whatsappLink.removeAttribute('tabindex');
  }).catch(() => {
    actionStatus.textContent = 'WhatsApp could not be configured. You can still copy the message and contact us manually.';
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
