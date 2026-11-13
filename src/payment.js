(() => {
  const $ = (selector) => document.querySelector(selector);
  const money = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value).replace('IDR', 'Rp').replace(/\s/g, '');
  let order;
  try { order = JSON.parse(localStorage.getItem('locoxatl-pending-order') || 'null'); } catch { order = null; }
  if (!order || !order.orderNumber) {
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
  const config = order.configuration || {};
  const configuration = [config.base?.name, ...(config.addons || []).map((item) => item.name), config.initial ? `Initial ${config.initial}` : '', config.clasp?.name].filter(Boolean).join(', ');
  const message = [
    'Halo LOCOXATL, saya ingin konfirmasi pembayaran pesanan.',
    `Order: ${order.orderNumber}`,
    `Nama: ${order.customer?.name || '-'}`,
    `Koleksi: ${order.artist?.name || '-'}`,
    `Produk: ${order.product?.name || '-'}`,
    `Custom: ${configuration || '-'}`,
    `Subtotal produk: ${money(order.total || 0)}`,
    'Saya akan mengirimkan bukti pembayaran untuk diverifikasi.',
  ].join('\n');
  $('#whatsappConfirm').href = `https://wa.me/?text=${encodeURIComponent(message)}`;

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
