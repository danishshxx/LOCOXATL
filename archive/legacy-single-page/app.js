(() => {
  const money = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value).replace('IDR', 'Rp').replace(/\s/g, '');
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = {
    cart: [],
    base: { id: 'heart', name: 'Cloud Heart', price: 45000 },
    clasp: { id: 'silver', name: 'Silver clasp', price: 7000 },
    addons: [],
    initial: '',
  };

  const products = {
    heart: { id: 'heart', title: 'Cloud Heart', description: 'Base charm · White acrylic', price: 45000, symbol: 'H' },
    star: { id: 'star', title: 'Little Star', description: 'Add-on · Gloss finish', price: 12000, symbol: 'S' },
    bow: { id: 'bow', title: 'Soft Ribbon', description: 'Base charm · Satin white', price: 49000, symbol: 'R' },
    set: { id: 'set', title: 'The Daydream Set', description: 'Ready set · 3 pieces', price: 79000, symbol: 'D' },
  };

  function calculateBuilderPrice() {
    const result = window.LocoxatlPricing.calculatePrice({
      basePrice: state.base.price,
      addonPrices: state.addons.map((addon) => addon.price),
      claspPrice: state.clasp.price,
      personalizationPrice: state.initial ? 5000 : 0,
      quantity: 1,
    });
    $('#builderPrice').textContent = money(result.total);
    return result.total;
  }

  function renderPreview() {
    const base = $('#previewBase');
    const addon = $('#previewAddon');
    const initial = $('#previewInitial');
    const ring = $('#previewRing');

    const baseShapes = {
      heart: '<path d="M200 199c-27-37-78-21-69 23 7 34 69 76 69 76s62-42 69-76c9-44-42-60-69-23Z" fill="url(#previewWhite)" stroke="#c9c9c9" stroke-width="3"/><path d="M157 219c-4 12 1 23 10 30" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round"/>',
      star: '<path d="m200 187 21 43 47 5-35 31 10 47-43-24-43 24 10-47-35-31 47-5Z" fill="url(#previewWhite)" stroke="#c9c9c9" stroke-width="3"/><path d="m200 202 8 18" stroke="#fff" stroke-width="5" stroke-linecap="round"/>',
      bow: '<path d="M200 213c-26-35-68-28-67 8 1 24 30 42 64 31-8 24-7 46 3 61 10-15 11-37 3-61 34 11 63-7 64-31 1-36-41-43-67-8Z" fill="url(#previewWhite)" stroke="#c9c9c9" stroke-width="3"/><ellipse cx="200" cy="236" rx="13" ry="16" fill="#eee" stroke="#ccc" stroke-width="2"/>',
    };
    base.innerHTML = baseShapes[state.base.id];

    let addonMarkup = '';
    if (state.addons.some((item) => item.id === 'pearl')) {
      addonMarkup += '<path d="M260 285v18" stroke="#bbb" stroke-width="5" stroke-linecap="round"/><circle cx="260" cy="321" r="16" fill="url(#previewWhite)" stroke="#ccc" stroke-width="2"/><circle cx="254" cy="315" r="5" fill="#fff"/>';
    }
    if (state.addons.some((item) => item.id === 'star')) {
      addonMarkup += '<path d="M132 291v12" stroke="#bbb" stroke-width="5" stroke-linecap="round"/><path d="m132 304 8 17 19 2-14 12 4 19-17-10-17 10 4-19-14-12 19-2Z" fill="url(#previewWhite)" stroke="#ccc" stroke-width="2"/>';
    }
    addon.innerHTML = addonMarkup;
    initial.innerHTML = state.initial ? `<circle cx="200" cy="270" r="17" fill="#111" stroke="#fff" stroke-width="2"/><text x="200" y="276" text-anchor="middle" font-size="15" font-family="Inter, sans-serif" font-weight="700" fill="#fff">${escapeHtml(state.initial)}</text>` : '';
    ring.setAttribute('stroke', state.clasp.id === 'black' ? '#151515' : '#aaa');
    ring.setAttribute('stroke-width', state.clasp.id === 'black' ? '13' : '11');
    $('#previewCount').textContent = `${2 + state.addons.length + (state.initial ? 1 : 0)} PIECES`;
    calculateBuilderPrice();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function updateBagCount() {
    const count = state.cart.reduce((sum, item) => sum + item.qty, 0);
    $('#bagCount').textContent = count;
    $('#drawerCount').textContent = `(${count})`;
  }

  function addToCart(item) {
    const existing = state.cart.find((cartItem) => cartItem.id === item.id && cartItem.description === item.description);
    if (existing) existing.qty += item.qty || 1;
    else state.cart.push({ ...item, qty: item.qty || 1 });
    updateCart();
    showToast(`${item.title} added to your bag.`);
  }

  function updateCart() {
    const container = $('#cartItems');
    const summary = $('#cartSummary');
    updateBagCount();
    if (!state.cart.length) {
      container.innerHTML = '<div class="empty-cart"><div class="empty-bag-icon">＋</div><h3>Your bag is taking a break.</h3><p>Find a piece that feels like you.</p><button class="button button-dark" id="continueShopping">Explore the collection <span>↗</span></button></div>';
      summary.hidden = true;
      $('#continueShopping').addEventListener('click', () => { closeCart(); $('#shop').scrollIntoView({ behavior: 'smooth' }); });
      return;
    }
    container.innerHTML = state.cart.map((item, index) => `
      <article class="cart-item">
        <div class="cart-thumb">${escapeHtml(item.symbol || '✧')}</div>
        <div><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.description)}</p>
          <div class="cart-item-actions"><div class="qty-control"><button data-qty="minus" data-index="${index}" aria-label="Decrease quantity">−</button><span>${item.qty}</span><button data-qty="plus" data-index="${index}" aria-label="Increase quantity">+</button></div><button class="remove-item" data-remove="${index}">Remove</button></div>
        </div><strong>${money(item.price * item.qty)}</strong>
      </article>`).join('');
    const subtotal = state.cart.reduce((sum, item) => sum + item.price * item.qty, 0);
    $('#cartSubtotal').textContent = money(subtotal);
    summary.hidden = false;
  }

  function openCart() {
    $('#cartDrawer').classList.add('open');
    $('#cartDrawer').setAttribute('aria-hidden', 'false');
    $('#drawerBackdrop').classList.add('open');
    document.body.classList.add('no-scroll');
  }
  function closeCart() {
    $('#cartDrawer').classList.remove('open');
    $('#cartDrawer').setAttribute('aria-hidden', 'true');
    $('#drawerBackdrop').classList.remove('open');
    document.body.classList.remove('no-scroll');
  }
  function openCheckout() {
    if (!state.cart.length) return;
    const total = state.cart.reduce((sum, item) => sum + item.price * item.qty, 0);
    $('#checkoutTotal').textContent = money(total);
    $('#checkoutFormView').hidden = false;
    $('#orderSuccess').hidden = true;
    $('#checkoutModal').classList.add('open');
    $('#checkoutModal').setAttribute('aria-hidden', 'false');
    $('#checkoutBackdrop').classList.add('open');
    document.body.classList.add('no-scroll');
    closeCart();
  }
  function closeCheckout() {
    $('#checkoutModal').classList.remove('open');
    $('#checkoutModal').setAttribute('aria-hidden', 'true');
    $('#checkoutBackdrop').classList.remove('open');
    document.body.classList.remove('no-scroll');
  }
  let toastTimer;
  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
  }

  $('#openCart').addEventListener('click', openCart);
  $('#closeCart').addEventListener('click', closeCart);
  $('#drawerBackdrop').addEventListener('click', closeCart);
  $('#goCheckout').addEventListener('click', openCheckout);
  $('#closeCheckout').addEventListener('click', closeCheckout);
  $('#checkoutBackdrop').addEventListener('click', closeCheckout);
  $('#finishDemo').addEventListener('click', () => { closeCheckout(); $('#shop').scrollIntoView({ behavior: 'smooth' }); });
  $('#continueShopping').addEventListener('click', () => { closeCart(); $('#shop').scrollIntoView({ behavior: 'smooth' }); });

  $('#cartItems').addEventListener('click', (event) => {
    const qtyButton = event.target.closest('[data-qty]');
    const removeButton = event.target.closest('[data-remove]');
    if (qtyButton) {
      const index = Number(qtyButton.dataset.index);
      if (qtyButton.dataset.qty === 'plus') state.cart[index].qty += 1;
      else state.cart[index].qty = Math.max(1, state.cart[index].qty - 1);
      updateCart();
    }
    if (removeButton) {
      state.cart.splice(Number(removeButton.dataset.remove), 1);
      updateCart();
    }
  });

  $$('.quick-add').forEach((button) => button.addEventListener('click', () => {
    const product = products[button.dataset.add];
    addToCart({ ...product, description: product.description });
  }));

  $$('.filter-chip').forEach((button) => button.addEventListener('click', () => {
    $$('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip === button));
    const filter = button.dataset.filter;
    $$('.product-card').forEach((card) => card.classList.toggle('is-hidden', filter !== 'all' && card.dataset.category !== filter));
  }));

  $$('.base-choices .choice-button').forEach((button) => button.addEventListener('click', () => {
    $$('.base-choices .choice-button').forEach((choice) => choice.classList.toggle('selected', choice === button));
    const names = { heart: 'Cloud Heart', star: 'Orbit Star', bow: 'Soft Ribbon' };
    state.base = { id: button.dataset.base, name: names[button.dataset.base], price: Number(button.dataset.price) };
    renderPreview();
  }));

  $$('.addon-option input').forEach((input) => input.addEventListener('change', () => {
    const addon = { id: input.dataset.addon, name: input.dataset.addon === 'pearl' ? 'Pearl drop' : input.dataset.addon === 'star' ? 'Mini star' : 'Your initial', price: Number(input.dataset.price) };
    state.addons = state.addons.filter((item) => item.id !== addon.id);
    if (input.checked && addon.id !== 'initial') state.addons.push(addon);
    if (addon.id === 'initial') {
      $('#initialText').disabled = !input.checked;
      if (!input.checked) { state.initial = ''; $('#initialText').value = ''; }
    }
    renderPreview();
  }));
  $('#initialText').addEventListener('input', (event) => {
    state.initial = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 1);
    event.target.value = state.initial;
    renderPreview();
  });
  $$('.clasp-choice').forEach((button) => button.addEventListener('click', () => {
    $$('.clasp-choice').forEach((choice) => choice.classList.toggle('selected', choice === button));
    state.clasp = { id: button.dataset.clasp, name: button.dataset.clasp === 'silver' ? 'Silver clasp' : 'Black clasp', price: Number(button.dataset.price) };
    renderPreview();
  }));

  $('#addCustomToBag').addEventListener('click', () => {
    const addonDescription = state.addons.map((item) => item.name).join(', ');
    const detailParts = [state.base.name, addonDescription, state.initial ? `Initial ${state.initial}` : '', state.clasp.name].filter(Boolean);
    addToCart({
      id: `custom-${state.base.id}-${state.clasp.id}-${state.addons.map((item) => item.id).sort().join('-')}-${state.initial}`,
      title: 'Your custom keychain',
      description: detailParts.join(' · '),
      price: calculateBuilderPrice(),
      symbol: state.base.id === 'heart' ? 'H' : state.base.id === 'star' ? 'S' : 'R',
      qty: 1,
    });
  });

  $('#checkoutForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const orderNumber = `LX-${String(Date.now()).slice(-6)}`;
    $('#orderNumber').textContent = orderNumber;
    $('#checkoutFormView').hidden = true;
    $('#orderSuccess').hidden = false;
    state.cart = [];
    updateCart();
  });

  $('#mobileMenuButton').addEventListener('click', () => {
    const nav = $('#mobileNav');
    const open = nav.hidden;
    nav.hidden = !open;
    $('#mobileMenuButton').setAttribute('aria-expanded', String(open));
  });
  $$('#mobileNav a').forEach((link) => link.addEventListener('click', () => {
    $('#mobileNav').hidden = true;
    $('#mobileMenuButton').setAttribute('aria-expanded', 'false');
  }));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeCart(); closeCheckout(); $('#mobileNav').hidden = true; }
  });

  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  $$('.reveal').forEach((element) => revealObserver.observe(element));

  updateCart();
  renderPreview();
})();
