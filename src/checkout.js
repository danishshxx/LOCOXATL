(() => {
  const $ = (selector) => document.querySelector(selector);
  const money = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value).replace('IDR', 'Rp').replace(/\s/g, '');
  const raw = localStorage.getItem('locoxatl-pending-order');
  let order;
  try { order = raw ? JSON.parse(raw) : null; } catch { order = null; }

  const form = $('#checkoutForm');
  if (!order || !order.product || !form) {
    $('#checkoutOrderSummary').innerHTML = '<div class="empty-state"><h2>No design selected yet.</h2><p>Choose an artist and customize a product before checkout.</p><a class="button button-dark" href="shop.html">Browse collections <span>↗</span></a></div>';
    form.querySelector('button[type="submit"]').disabled = true;
    return;
  }

  const config = order.configuration || {};
  const configText = [config.base?.name, ...(config.addons || []).map((item) => item.name), config.initial ? `Initial ${config.initial}` : '', config.clasp?.name].filter(Boolean).join(' · ');
  $('#summaryProductName').textContent = order.product.name || 'Custom keychain';
  $('#summaryArtistName').textContent = `${order.artist?.name || 'Artist collection'} / ${order.artist?.fandom || ''}`;
  $('#summaryConfiguration').textContent = configText;
  $('#summaryPrice').textContent = money(order.total || 0);
  $('#summaryTotal').textContent = money(order.total || 0);

  const status = $('#checkoutStatus');
  const submitButton = form.querySelector('button[type="submit"]');
  let busy = false;

  function setStatus(message, tone = 'info') {
    if (!status) return;
    status.hidden = !message;
    status.textContent = message || '';
    status.dataset.tone = tone;
  }

  function setBusy(next) {
    busy = next;
    if (!submitButton) return;
    submitButton.disabled = next;
    submitButton.dataset.label = submitButton.dataset.label || submitButton.innerHTML;
    submitButton.innerHTML = next ? 'Saving your order…' : submitButton.dataset.label;
  }

  function localOrderNumber() {
    return `LX-${Date.now().toString().slice(-7)}`;
  }

  /** Structured JSON snapshot of the whole customization, sent to the order API. */
  function buildPayload() {
    return {
      customer: order.customer,
      order: {
        artist: order.artist,
        product: order.product,
        configuration: {
          base: config.base,
          addons: config.addons,
          initial: config.initial,
          clasp: config.clasp,
          render: config.render,
          components: config.components || [],
        },
        quantity: order.quantity || 1,
        total: order.total,
        createdAt: order.createdAt,
      },
    };
  }

  function describeValidation(body) {
    const details = body && body.details ? Object.values(body.details) : [];
    return details.length ? details.join(' ') : (body && body.message) || 'Please check your delivery details and try again.';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!form.reportValidity()) return;

    const data = new FormData(form);
    order.customer = {
      name: String(data.get('name') || '').trim(),
      phone: String(data.get('phone') || '').trim(),
      email: String(data.get('email') || '').trim(),
      address: String(data.get('address') || '').trim(),
      note: String(data.get('note') || '').trim(),
    };

    setBusy(true);
    setStatus('Saving your order…');

    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });

      let body = null;
      try { body = await response.json(); } catch { body = null; }

      if (response.status === 400) {
        setStatus(describeValidation(body), 'error');
        setBusy(false);
        return;
      }

      if (response.ok && body && body.order && body.order.orderNumber) {
        order.orderNumber = body.order.orderNumber;
        order.status = body.order.status || 'waiting_for_payment';
        if (typeof body.order.total === 'number') {
          order.total = body.order.total;
          $('#summaryPrice').textContent = money(order.total);
          $('#summaryTotal').textContent = money(order.total);
        }
        order.persisted = true;
        order.persistence = {
          mode: 'mysql',
          orderId: body.order.orderId,
          orderItemId: body.order.orderItemId,
          storedAt: new Date().toISOString(),
        };
        if (body.order.priceAdjusted) {
          setStatus('The order total was recalculated from the current catalog prices.', 'info');
        }
      } else {
        // MySQL is not configured on this machine (or the API is unreachable).
        // Keep the prototype journey intact and record why the order stayed local.
        order.persisted = false;
        order.orderNumber = order.orderNumber || localOrderNumber();
        order.status = 'waiting_for_payment';
        order.persistence = {
          mode: 'local-demo',
          reason: (body && (body.detail || body.message)) || `Order API returned ${response.status}.`,
        };
      }
    } catch (error) {
      order.persisted = false;
      order.orderNumber = order.orderNumber || localOrderNumber();
      order.status = 'waiting_for_payment';
      order.persistence = { mode: 'local-demo', reason: error.message };
    }

    order.updatedAt = new Date().toISOString();
    localStorage.setItem('locoxatl-pending-order', JSON.stringify(order));
    window.location.href = 'payment.html';
  });
})();