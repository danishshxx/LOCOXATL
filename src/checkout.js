(() => {
  const $ = (selector) => document.querySelector(selector);
  const money = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value) || 0).replace('IDR', 'Rp').replace(/\s/g, '');
  const escapeText = (value) => String(value == null ? '' : value)
    .replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  const form = $('#checkoutForm');
  const summary = $('#checkoutOrderSummary');
  const submitButton = form ? form.querySelector('button[type="submit"]') : null;
  const whatsapp = window.LocoxatlWhatsApp || null;
  const cart = window.LocoxatlCart || null;
  if (!form || !summary) return;

  const DRAFT_KEY = 'locoxatl-pending-order';
  const mode = new URLSearchParams(window.location.search).get('mode') === 'direct' ? 'direct' : 'cart';

  // The checkout draft keeps the typed details and the last saved order for the payment pages.
  let order = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (parsed && typeof parsed === 'object') order = parsed;
  } catch { order = {}; }

  let items = [];
  let fulfillmentMethod = order.fulfillmentMethod || 'campus_delivery';
  let paymentMethods = [];
  let selectedPayment = order.paymentMethod || '';
  let busy = false;

  const status = $('#checkoutStatus');
  const notices = $('#checkoutNotices');

  function setStatus(message, tone = 'info') {
    if (!status) return;
    status.hidden = !message;
    status.textContent = message || '';
    status.dataset.tone = tone;
    status.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  }

  function setNotices(message) {
    if (!notices) return;
    notices.hidden = !message;
    notices.textContent = message || '';
  }

  function setBusy(next) {
    busy = next;
    if (!submitButton) return;
    submitButton.disabled = next;
    submitButton.dataset.label = submitButton.dataset.label || submitButton.innerHTML;
    submitButton.innerHTML = next ? 'Saving your order…' : submitButton.dataset.label;
  }

  function showEmpty(title, body) {
    summary.innerHTML = `<div class="empty-state"><h2>${escapeText(title)}</h2><p>${escapeText(body)}</p><a class="button button-dark" href="shop.html">Browse collections <span aria-hidden="true">↗</span></a></div>`;
    if (submitButton) submitButton.disabled = true;
  }

  // ---------------------------------------------------------------- cart or direct item

  function loadItems() {
    if (mode === 'direct') {
      const direct = cart ? cart.readDirectCheckout() : null;
      return direct ? [direct] : [];
    }
    return cart ? cart.readCart() : [];
  }

  items = loadItems();

  if (!items.length) {
    showEmpty(
      mode === 'direct' ? 'No design selected yet.' : 'Your cart is empty.',
      mode === 'direct'
        ? 'Customize a design in the studio, then choose Buy now.'
        : 'Add a design from the studio before checking out.',
    );
    return;
  }

  // ---------------------------------------------------------------- summary

  const FULFILLMENT_LABELS = {
    campus_delivery: 'Campus delivery',
    cod_telkom: 'COD / meet-up',
    shopee_external: 'Shopee (external)',
  };

  function lineTotal(item) {
    return (Number(item.unitPrice) || 0) * (Number(item.quantity) || 1);
  }

  function subtotal() {
    return items.reduce((total, item) => total + lineTotal(item), 0);
  }

  function summaryText(item) {
    return cart ? cart.configurationSummary(item) : '';
  }

  function lineLabel(item) {
    return item.member ? `${item.member.name} Keychain` : (item.product && item.product.name) || 'LOCOXATL Keychain';
  }

  function renderSummary() {
    const container = $('#summaryItems');
    if (!container) return;

    container.innerHTML = items.map((item, index) => {
      const image = String(item.imageUrl || '').trim();
      const label = lineLabel(item);
      const group = [item.artist && item.artist.name, item.version ? `${item.version} version` : ''].filter(Boolean).join(' / ');
      const configuration = summaryText(item);
      return `
        <article class="summary-product" data-summary-line="${index}">
          <div class="summary-product-art">
            ${image
              ? `<img class="summary-product-image" src="${escapeText(image)}" alt="${escapeText(label)} preview" decoding="async" />`
              : `<span class="summary-product-empty">${escapeText(label)}</span>`}
          </div>
          <div class="summary-product-copy">
            <span class="eyebrow">LOCOXATL CUSTOM</span>
            <h2>${escapeText(label)}${item.quantity > 1 ? ` <span class="summary-qty">×${item.quantity}</span>` : ''}</h2>
            <p>${escapeText(group || 'Artist collection')}</p>
            ${configuration ? `<p>${escapeText(configuration)}</p>` : ''}
            <p class="summary-line-total">${money(lineTotal(item))}</p>
          </div>
        </article>`;
    }).join('');

    $('#summaryPrice').textContent = money(subtotal());
    $('#summaryTotal').textContent = money(subtotal());
    $('#summaryFulfillment').textContent = FULFILLMENT_LABELS[fulfillmentMethod] || FULFILLMENT_LABELS.campus_delivery;
  }

  // ---------------------------------------------------------------- fulfillment

  const FULFILLMENT_OPTIONS = [
    { code: 'campus_delivery', label: 'Campus delivery', detail: 'Telkom University Jakarta' },
    { code: 'cod_telkom', label: 'COD / meet-up', detail: 'Pay in cash, confirm on WhatsApp' },
    { code: 'shopee_external', label: 'Shopee', detail: 'CS sends the checkout link' },
  ];

  function renderFulfillment() {
    const container = $('#fulfillmentChoices');
    if (!container) return;
    container.innerHTML = FULFILLMENT_OPTIONS.map((option) => {
      const selected = fulfillmentMethod === option.code;
      return `<button type="button" class="bundle-choice${selected ? ' selected' : ''}" data-fulfillment="${option.code}" aria-pressed="${selected}"><span>${escapeText(option.label)}<small>${escapeText(option.detail)}</small></span></button>`;
    }).join('');

    container.querySelectorAll('[data-fulfillment]').forEach((button) => {
      button.addEventListener('click', () => {
        fulfillmentMethod = button.dataset.fulfillment;
        renderFulfillment();
        renderPaymentMethods();
        renderSummary();
      });
    });
  }

  // ---------------------------------------------------------------- payment

  const fieldset = $('#paymentMethodFieldset');
  const choices = $('#paymentMethodChoices');
  const summaryPayment = $('#summaryPayment');
  const FALLBACK_METHODS = [
    { code: 'qris', label: 'QRIS', instructions: '' },
    { code: 'cash', label: 'Cash', instructions: '' },
    { code: 'transfer', label: 'Bank Transfer', instructions: '' },
  ];

  function activeMethod(code) {
    return paymentMethods.find((method) => method && method.code === code) || null;
  }

  function renderPaymentMethods() {
    if (!choices) return;
    const shopeeNote = $('#shopeeNote');
    if (shopeeNote) shopeeNote.hidden = fulfillmentMethod !== 'shopee_external';

    // Shopee settles payment off-site, so no method is offered for that path.
    if (fulfillmentMethod === 'shopee_external') {
      if (fieldset) fieldset.hidden = true;
      selectedPayment = '';
      if (summaryPayment) summaryPayment.textContent = 'Shopee';
      return;
    }

    // COD is a different journey: no payment proof, no QRIS page. The existing Cash method
    // records how the courier is paid, and the admin sees the COD fulfillment in the dashboard.
    if (fulfillmentMethod === 'cod_telkom') {
      if (fieldset) fieldset.hidden = true;
      const codMethod = paymentMethods.find((method) => method.code === 'cash')
        || paymentMethods.find((method) => method.code !== 'qris')
        || paymentMethods[0]
        || null;
      selectedPayment = codMethod ? codMethod.code : '';
      if (summaryPayment) summaryPayment.textContent = codMethod ? 'COD — pay in cash at meet-up' : 'COD';
      return;
    }

    if (!paymentMethods.length) {
      if (fieldset) fieldset.hidden = false;
      choices.innerHTML = '<p class="demo-note">No payment method is available right now. Message our WhatsApp CS and we will help.</p>';
      return;
    }

    if (fieldset) fieldset.hidden = false;
    if (!selectedPayment || !activeMethod(selectedPayment)) selectedPayment = paymentMethods[0].code;
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

    const active = activeMethod(selectedPayment);
    if (summaryPayment) summaryPayment.textContent = active ? active.label : 'Not chosen yet';
  }

  function loadPaymentMethods() {
    fetch('/api/payment-methods')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const list = data && Array.isArray(data.paymentMethods) ? data.paymentMethods : [];
        paymentMethods = list.filter((method) => method && method.isActive !== false);
        if (!paymentMethods.length) paymentMethods = FALLBACK_METHODS;
        renderPaymentMethods();
      })
      .catch(() => {
        paymentMethods = FALLBACK_METHODS;
        renderPaymentMethods();
      });
  }

  renderFulfillment();
  renderSummary();
  loadPaymentMethods();

  // ---------------------------------------------------------------- live catalogue

  const catalogReady = window.locoxatlCatalog && typeof window.locoxatlCatalog.then === 'function'
    ? window.locoxatlCatalog
    : Promise.resolve(null);

  catalogReady.then((payload) => {
    if (!payload || !cart) return;
    const result = cart.reconcileCartWithCatalog(items, payload);
    items = result.items;

    if (result.changed) {
      // reconcileCartWithCatalog() already rewrote the saved cart; the direct snapshot has its
      // own key, so it is written back here.
      if (mode === 'direct') {
        if (items.length) cart.writeDirectCheckout(items[0]);
        else cart.clearDirectCheckout();
      }
    }

    if (!items.length) {
      showEmpty('Nothing left to check out.', 'Everything in this selection is no longer available. Pick a current design to continue.');
      return;
    }

    if (result.notices.length) setNotices(result.notices.join(' '));
    renderSummary();
  }).catch(() => { /* the stored snapshot stays authoritative */ });

  // Restore the delivery details of an interrupted attempt so nothing has to be retyped.
  if (order.customer) {
    ['name', 'phone', 'email', 'address', 'note'].forEach((field) => {
      const input = form.elements[field];
      if (input && order.customer[field]) input.value = order.customer[field];
    });
  }

  // ---------------------------------------------------------------- submit

  function buildPayload() {
    return {
      customer: order.customer,
      fulfillmentMethod,
      paymentMethod: fulfillmentMethod === 'shopee_external' ? undefined : (selectedPayment || undefined),
      total: subtotal(),
      items: items.map((item) => ({
        artist: item.artist || undefined,
        member: item.member || undefined,
        product: item.product || undefined,
        bundle: item.bundle || undefined,
        version: item.version || undefined,
        quantity: item.quantity || 1,
        total: lineTotal(item),
        configuration: {
          base: item.configuration && item.configuration.base,
          addons: item.configuration && item.configuration.addons,
          selections: item.selections || undefined,
          initial: item.configuration && item.configuration.initial,
          clasp: item.configuration && item.configuration.clasp,
          render: item.configuration && item.configuration.render,
          components: (item.configuration && item.configuration.components) || [],
        },
      })),
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

  // Keeps the typed details in this browser so a failed attempt can be retried. Nothing is
  // ever written that claims an order was placed.
  function persistDraft() {
    const draft = { ...order, persisted: false, updatedAt: new Date().toISOString() };
    delete draft.orderNumber;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch { /* storage blocked: the form itself still holds the values */ }
  }

  /** One line per cart item, in the shape the WhatsApp builders print. */
  function messageItems() {
    return items.map((item) => ({
      name: lineLabel(item),
      quantity: item.quantity || 1,
      configuration: summaryText(item),
      total: lineTotal(item),
    }));
  }

  async function shopNumber() {
    try {
      const config = window.locoxatlPublicConfig
        || fetch('/api/public-config').then((response) => (response.ok ? response.json() : null));
      const resolved = await config;
      return resolved && resolved.whatsappNumber ? resolved.whatsappNumber : '';
    } catch {
      return '';
    }
  }

  /**
   * COD handoff. The order already exists in MySQL by the time this runs, so the buyer only
   * needs to open WhatsApp with the complete order. No payment page, no paid status.
   */
  async function redirectToCodWhatsApp() {
    if (!whatsapp) {
      setStatus(`Order ${order.orderNumber} is saved. Message our WhatsApp admin to confirm COD.`, 'info');
      return;
    }

    const message = whatsapp.buildCodMessage({
      orderNumber: order.orderNumber,
      name: order.customer?.name || '',
      phone: order.customer?.phone || '',
      items: messageItems(),
      fulfillment: 'COD / Ketemuan — Telkom University Jakarta',
      address: order.customer?.address || '',
      note: order.customer?.note || '',
      total: money(subtotal()),
    });

    setStatus(`Order ${order.orderNumber} is saved. Opening WhatsApp so you can confirm your COD order…`);
    window.location.href = whatsapp.buildChatUrl(await shopNumber(), message);
  }

  /** Shopee is settled inside Shopee: CS replies with the checkout link for this order. */
  async function redirectToShopeeWhatsApp() {
    if (!whatsapp) {
      setStatus(`Order ${order.orderNumber} is saved. Message our WhatsApp CS for the Shopee checkout link.`, 'info');
      return;
    }

    const message = whatsapp.buildShopeeMessage({
      selection: messageItems()
        .map((item) => `${item.name}${item.quantity > 1 ? ` (×${item.quantity})` : ''} — ${item.configuration}`)
        .join('; '),
      total: money(subtotal()),
      orderNumber: order.orderNumber,
    });

    setStatus(`Order ${order.orderNumber} is saved. Opening WhatsApp so CS can send your Shopee checkout link…`);
    window.location.href = whatsapp.buildChatUrl(await shopNumber(), message);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!items.length) {
      setStatus('Add a design to your cart before checking out.', 'error');
      return;
    }
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
    if (fulfillmentMethod !== 'shopee_external' && !selectedPayment) {
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
    order.total = typeof body.order.total === 'number' ? body.order.total : subtotal();
    order.items = messageItems();
    order.fulfillmentMethod = fulfillmentMethod;
    order.paymentMethod = fulfillmentMethod === 'shopee_external' ? null : selectedPayment;
    order.payment = activeMethod(selectedPayment);
    order.persisted = true;
    order.persistence = {
      mode: 'mysql',
      orderId: body.order.orderId,
      orderItemId: body.order.orderItemId,
      storedAt: new Date().toISOString(),
    };
    order.updatedAt = new Date().toISOString();

    // The cart is cleared the moment the order exists, so Back or a second click cannot submit
    // the same designs twice.
    if (cart) {
      if (mode === 'direct') cart.clearDirectCheckout();
      else cart.clearCart();
    }

    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(order)); } catch { /* storage blocked */ }

    if (body.order.priceAdjusted) {
      setStatus('The order total was recalculated from the current catalog prices.', 'info');
    }

    if (fulfillmentMethod === 'cod_telkom') {
      await redirectToCodWhatsApp();
      return;
    }

    if (fulfillmentMethod === 'shopee_external') {
      await redirectToShopeeWhatsApp();
      return;
    }

    window.location.href = 'payment.html';
  });
})();
