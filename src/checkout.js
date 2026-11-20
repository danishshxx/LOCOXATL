(() => {
  const $ = (selector) => document.querySelector(selector);
  const money = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value).replace('IDR', 'Rp').replace(/\s/g, '');
  const raw = localStorage.getItem('locoxatl-pending-order');
  let order;
  try { order = raw ? JSON.parse(raw) : null; } catch { order = null; }

  const form = $('#checkoutForm');
  const summary = $('#checkoutOrderSummary');
  const submitButton = form ? form.querySelector('button[type="submit"]') : null;
  const whatsapp = window.LocoxatlWhatsApp || null;

  if (!form || !summary) return;

  if (!order || (!order.member && !order.product && !order.artist)) {
    summary.innerHTML = '<div class="empty-state"><h2>No design selected yet.</h2><p>Choose a member and customize the keychain before checkout.</p><a class="button button-dark" href="shop.html">Browse collections <span>↗</span></a></div>';
    if (submitButton) submitButton.disabled = true;
    return;
  }

  // Shopee orders are handed to CS from the studio, so a stale URL goes back to the builder.
  if (order.fulfillmentMethod === 'shopee_external' && !order.orderNumber) {
    const params = new URLSearchParams();
    if (order.artist?.slug) params.set('artist', order.artist.slug);
    if (order.member?.slug) params.set('member', order.member.slug);
    if (order.version) params.set('version', order.version);
    window.location.replace(`studio.html${params.toString() ? `?${params.toString()}` : ''}`);
    return;
  }

  const member = order.member || null;
  const config = order.configuration || {};
  // The design name already carries the product, so the legacy silhouette label is not repeated.
  const configText = [...(config.addons || []).map((item) => item.name), config.initial ? `Initial ${config.initial}` : '', config.clasp?.name, ...(order.extraLabels || []), order.bundle && order.bundle.name ? `Paket ${order.bundle.name}` : ''].filter(Boolean).join(' · ');
  $('#summaryProductName').textContent = member ? `${member.name} Keychain` : (order.product?.name || 'LOCOXATL Keychain');
  $('#summaryArtistName').textContent = `${order.artist?.name || 'Artist collection'} / ${order.artist?.fandom || ''}`;
  $('#summaryConfiguration').textContent = configText;

  // The summary shows the same image the studio previewed, unclipped, with a text fallback.
  const previewImage = $('#summaryProductImage');
  const previewEmpty = $('#summaryProductEmpty');
  const safePreview = (value) => {
    const url = String(value == null ? '' : value).trim();
    return /^(https?:\/\/|\/|data:image\/)/i.test(url) ? url : '';
  };
  const previewUrl = safePreview(order.previewImage)
    || safePreview(order.product && order.product.imageUrl)
    || safePreview(member && member.designImageUrl);
  const previewLabel = order.previewLabel
    || (member ? `${member.name} keychain` : ((order.product && order.product.name) || 'LOCOXATL keychain'));

  if (previewImage) {
    if (previewUrl) {
      previewImage.src = previewUrl;
      previewImage.alt = `${previewLabel} preview`;
      previewImage.hidden = false;
    } else {
      previewImage.removeAttribute('src');
      previewImage.hidden = true;
    }
  }
  if (previewEmpty) {
    previewEmpty.textContent = previewLabel;
    previewEmpty.hidden = Boolean(previewUrl);
  }
  $('#summaryPrice').textContent = money(order.total || 0);
  $('#summaryTotal').textContent = money(order.total || 0);

  // Delivery and payment come from the studio, and the payment list from the dashboard.
  const FULFILLMENT_LABELS = {
    campus_delivery: 'Campus delivery',
    cod_telkom: 'COD / meet-up',
    shopee_external: 'Shopee (external)',
  };
  const fulfillmentMethod = order.fulfillmentMethod || 'campus_delivery';
  const fulfillmentEl = $('#summaryFulfillment');
  if (fulfillmentEl) {
    fulfillmentEl.textContent = fulfillmentMethod === 'cod_telkom'
      ? 'COD / meet-up — Telkom University Jakarta'
      : (FULFILLMENT_LABELS[fulfillmentMethod] || FULFILLMENT_LABELS.campus_delivery);
  }
  // COD is paid in person, so the button confirms the saved order on WhatsApp instead of
  // continuing to the QRIS page.
  if (fulfillmentMethod === 'cod_telkom' && submitButton) {
    submitButton.innerHTML = 'Confirm COD via WhatsApp <span aria-hidden="true">↗</span>';
  }

  const fieldset = $('#paymentMethodFieldset');
  const choices = $('#paymentMethodChoices');
  const summaryPayment = $('#summaryPayment');
  const FALLBACK_METHODS = [
    { code: 'qris', label: 'QRIS', instructions: '' },
    { code: 'cash', label: 'Cash', instructions: '' },
    { code: 'transfer', label: 'Bank Transfer', instructions: '' },
  ];
  let paymentMethods = FALLBACK_METHODS;
  let selectedPayment = order.paymentMethod || '';

  const escapeText = (value) => String(value == null ? '' : value)
    .replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  function renderPaymentMethods() {
    if (!choices) return;
    // Shopee settles payment off-site, so no method is offered for that path.
    if (fulfillmentMethod === 'shopee_external') {
      if (fieldset) fieldset.hidden = true;
      if (summaryPayment) summaryPayment.textContent = 'Shopee';
      return;
    }

    // COD is a different journey: no QRIS, no payment proof. The existing Cash method records
    // how the courier is paid, and the admin sees the COD fulfillment in the dashboard.
    if (fulfillmentMethod === 'cod_telkom') {
      if (fieldset) fieldset.hidden = true;
      // Prefer Cash (the accurate COD method). If the admin disabled it, never fall back to
      // QRIS for a COD order; any other active method is a better fit.
      const codMethod = paymentMethods.find((method) => method.code === 'cash')
        || paymentMethods.find((method) => method.code !== 'qris')
        || paymentMethods[0]
        || null;
      selectedPayment = codMethod ? codMethod.code : '';
      order.paymentMethod = selectedPayment || undefined;
      order.payment = codMethod ? { code: codMethod.code, label: 'COD', instructions: '', imageUrl: null } : null;
      if (summaryPayment) summaryPayment.textContent = codMethod ? 'COD — pay in cash at meet-up' : 'COD';
      return;
    }

    if (!paymentMethods.length) {
      if (fieldset) fieldset.hidden = false;
      choices.innerHTML = '<p class="demo-note">No payment method is available right now. Message our WhatsApp CS and we will help.</p>';
      return;
    }

    if (fieldset) fieldset.hidden = false;
    if (!selectedPayment) selectedPayment = paymentMethods[0].code;
    choices.innerHTML = paymentMethods.map((method) => {
      const selected = method.code === selectedPayment;
      return `<button type="button" class="bundle-choice${selected ? ' selected' : ''}" data-payment="${escapeText(method.code)}" aria-pressed="${selected}"><span>${escapeText(method.label)}</span></button>`;
    }).join('');

    choices.querySelectorAll('[data-payment]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedPayment = button.dataset.payment;
        renderPaymentMethods();
      });
    });

    const active = paymentMethods.find((method) => method.code === selectedPayment);
    if (summaryPayment) summaryPayment.textContent = active ? active.label : 'Not chosen yet';
    order.paymentMethod = selectedPayment;
    order.payment = {
      code: selectedPayment,
      label: active ? active.label : '',
      instructions: active ? active.instructions : '',
      imageUrl: active ? active.imageUrl : null,
    };
  }

  renderPaymentMethods();

  fetch('/api/payment-methods')
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      const list = data && Array.isArray(data.paymentMethods) ? data.paymentMethods : [];
      if (list.length) paymentMethods = list.filter((method) => method && method.isActive !== false);
      renderPaymentMethods();
    })
    .catch(() => { /* the fallback list already rendered */ });

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
        bundle: order.bundle || undefined,
        version: order.version || undefined,
        fulfillmentMethod,
        paymentMethod: order.paymentMethod || undefined,
        configuration: {
          base: config.base,
          addons: config.addons,
          selections: order.selections || undefined,
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

  /**
   * COD handoff. The order already exists in MySQL by the time this runs, so the buyer only
   * needs to open WhatsApp with the complete order. No payment page, no QRIS, no paid status.
   */
  async function redirectToCodWhatsApp() {
    if (!whatsapp) {
      setStatus(`Order ${order.orderNumber} is saved. Message our WhatsApp admin to confirm COD.`, 'info');
      return;
    }

    const addonNames = [
      ...((config.addons || []).map((item) => item && item.name).filter(Boolean)),
      ...(order.extraLabels || []),
      config.initial ? `Initial ${config.initial}` : '',
    ].filter(Boolean);
    const configurationText = config.clasp?.name || '';
    const message = whatsapp.buildCodMessage({
      orderNumber: order.orderNumber,
      name: order.customer?.name || '',
      phone: order.customer?.phone || '',
      artist: order.artist?.name || '',
      member: member ? member.name : '',
      product: order.product?.name || '',
      configuration: configurationText,
      addons: addonNames.join(', '),
      bundle: order.bundle?.name ? `Paket ${order.bundle.name}` : '',
      quantity: order.quantity || 1,
      fulfillment: 'COD / Ketemuan — Telkom University Jakarta',
      address: order.customer?.address || '',
      note: order.customer?.note || '',
      total: money(order.total || 0),
    });

    let number = '';
    try {
      const configData = window.locoxatlPublicConfig
        || fetch('/api/public-config').then((response) => (response.ok ? response.json() : null));
      const resolved = await configData;
      number = resolved && resolved.whatsappNumber ? resolved.whatsappNumber : '';
    } catch { /* the generic wa.me share sheet still works */ }

    setStatus(`Order ${order.orderNumber} is saved. Opening WhatsApp so you can confirm your COD order…`);
    window.location.href = whatsapp.buildChatUrl(number, message);
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

    // Every path except Shopee has to name the method the buyer will pay with.
    if (fulfillmentMethod !== 'shopee_external' && !order.paymentMethod) {
      setStatus('Choose a payment method.', 'error');
      if (choices) choices.scrollIntoView({ block: 'center' });
      return;
    }

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
      // so the customer must never be sent on to the payment page or WhatsApp.
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
    try { localStorage.setItem('locoxatl-pending-order', JSON.stringify(order)); } catch { /* storage blocked */ }

    if (body.order.priceAdjusted) {
      setStatus('The order total was recalculated from the current catalog prices.', 'info');
    }

    // COD never reaches the QRIS page. QRIS and the other methods keep their existing flow.
    if (fulfillmentMethod === 'cod_telkom') {
      await redirectToCodWhatsApp();
      return;
    }

    window.location.href = 'payment.html';
  });
})();
