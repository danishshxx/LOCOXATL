(() => {
  const $ = (selector) => document.querySelector(selector);
  const money = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value).replace('IDR', 'Rp').replace(/\s/g, '');
  const raw = localStorage.getItem('locoxatl-pending-order');
  let order;
  try { order = raw ? JSON.parse(raw) : null; } catch { order = null; }

  const form = $('#checkoutForm');
  const summary = $('#checkoutOrderSummary');
  const submitButton = form ? form.querySelector('button[type="submit"]') : null;

  if (!form || !summary) return;

  if (!order || (!order.member && !order.product && !order.artist)) {
    summary.innerHTML = '<div class="empty-state"><h2>No design selected yet.</h2><p>Choose a member and customize the keychain before checkout.</p><a class="button button-dark" href="shop.html">Browse collections <span>↗</span></a></div>';
    if (submitButton) submitButton.disabled = true;
    return;
  }

  const member = order.member || null;
  const config = order.configuration || {};
  const configText = [config.base?.name, ...(config.addons || []).map((item) => item.name), config.initial ? `Initial ${config.initial}` : '', config.clasp?.name].filter(Boolean).join(' · ');
  $('#summaryProductName').textContent = member ? `${member.name} Keychain` : (order.product?.name || 'LOCOXATL Keychain');
  $('#summaryArtistName').textContent = `${order.artist?.name || 'Artist collection'} / ${order.artist?.fandom || ''}`;
  $('#summaryConfiguration').textContent = configText;
  $('#summaryPrice').textContent = money(order.total || 0);
  $('#summaryTotal').textContent = money(order.total || 0);

  const status = $('#checkoutStatus');
  let busy = false;

  function setStatus(message, tone = 'info') {
    if (!status) return;
    status.hidden = !message;
    status.textContent = message || '';
    status.dataset.tone = tone;
    status.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  }

  function setBusy(next) {
    busy = next;
    if (!submitButton) return;
    submitButton.disabled = next;
    submitButton.dataset.label = submitButton.dataset.label || submitButton.innerHTML;
    submitButton.innerHTML = next ? 'Saving your order…' : submitButton.dataset.label;
  }

  // Restore the delivery details of an interrupted attempt so nothing has to be retyped.
  if (order.customer) {
    ['name', 'phone', 'email', 'address', 'note'].forEach((field) => {
      const input = form.elements[field];
      if (input && order.customer[field]) input.value = order.customer[field];
    });
  }

  /** Structured JSON snapshot of the whole customization, sent to the order API. */
  function buildPayload() {
    return {
      customer: order.customer,
      order: {
        artist: order.artist,
        member: order.member || undefined,
        product: order.product || undefined,
        baseModel: order.baseModel || order.configuration?.base?.id,
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

  function describeFailure(body, statusCode) {
    const message = body && (body.message || body.detail);
    if (statusCode === 503) {
      return `We could not save your order right now. ${message || 'The order service is temporarily unavailable.'} Your design and details are still here — please try again in a moment, or confirm with us on WhatsApp.`;
    }
    if (statusCode === 429) {
      return 'Too many attempts in a short time. Please wait a minute and try again.';
    }
    return `We could not save your order${statusCode ? ` (error ${statusCode})` : ''}. ${message || 'Please try again.'} Your design and details are still here.`;
  }

  // Keeps the design and the typed details in this browser so a failed attempt can be retried.
  // Nothing is ever written that claims an order was placed.
  function persistDraft() {
    const draft = { ...order, persisted: false, updatedAt: new Date().toISOString() };
    delete draft.orderNumber;
    delete draft.persistence;
    try {
      localStorage.setItem('locoxatl-pending-order', JSON.stringify(draft));
    } catch { /* storage blocked: the form itself still holds the values */ }
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

    let response;
    let body = null;

    try {
      response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      try { body = await response.json(); } catch { body = null; }
    } catch (error) {
      // Network failure: keep everything on screen and let the customer retry.
      persistDraft();
      setStatus(describeFailure({ message: error.message }, 0), 'error');
      setBusy(false);
      return;
    }

    if (response.status === 400) {
      persistDraft();
      setStatus(describeValidation(body), 'error');
      setBusy(false);
      return;
    }

    if (!response.ok || !body || !body.order || !body.order.orderNumber) {
      // Includes the documented 503 when MySQL is not configured. The order was not stored,
      // so the customer must never be sent on to the payment page.
      persistDraft();
      setStatus(describeFailure(body, response.status), 'error');
      setBusy(false);
      return;
    }

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
    order.updatedAt = new Date().toISOString();
    localStorage.setItem('locoxatl-pending-order', JSON.stringify(order));

    if (body.order.priceAdjusted) {
      setStatus('The order total was recalculated from the current catalog prices.', 'info');
    }
    window.location.href = 'payment.html';
  });
})();