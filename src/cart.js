(function (root, factory) {
  const pricing = (typeof module === 'object' && module.exports)
    ? require('./pricing.js')
    : (root && root.LocoxatlPricing) || null;
  const api = factory(root, pricing);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LocoxatlCart = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, pricing) {
  const CART_KEY = 'locoxatl_cart';
  const DIRECT_KEY = 'locoxatl_direct_checkout';
  const MAX_QUANTITY = 20;
  const MAX_ITEMS = 20;

  // localStorage throws in some private modes. A probe decides once, and the in-memory map keeps
  // the cart usable for the rest of the visit instead of losing it on the first write.
  const memory = {};
  const store = (() => {
    try {
      const candidate = root && root.localStorage;
      if (!candidate) return null;
      candidate.setItem('locoxatl_cart_probe', '1');
      candidate.removeItem('locoxatl_cart_probe');
      return candidate;
    } catch {
      return null;
    }
  })();

  function readRaw(key) {
    if (store) {
      try {
        return store.getItem(key);
      } catch { /* fall through to memory */ }
    }
    return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
  }

  function writeRaw(key, value) {
    memory[key] = value;
    if (!store) return;
    try {
      if (value === null) store.removeItem(key);
      else store.setItem(key, value);
    } catch { /* memory already holds it */ }
  }

  const money = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
    .format(Number(value) || 0).replace('IDR', 'Rp').replace(/\s/g, '');

  const escapeText = (value) => String(value == null ? '' : value)
    .replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  // A cart line holds image URLs only: an uploaded base64 snapshot is dropped rather than copied
  // into localStorage, where a few of them would exhaust the quota.
  const imageUrl = (value) => {
    const url = String(value == null ? '' : value).trim();
    if (!url || /^data:/i.test(url)) return '';
    return /^(?:https?:\/\/|\/|assets\/)/i.test(url) ? url : '';
  };

  function newId() {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  const clampQuantity = (value) => Math.min(MAX_QUANTITY, Math.max(1, Math.floor(Number(value) || 1)));

  function isItem(value) {
    return Boolean(value) && typeof value === 'object' && Boolean(value.cartItemId);
  }

  function readCart() {
    const raw = readRaw(CART_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isItem).map(normalizeItem) : [];
    } catch {
      return [];
    }
  }

  function writeCart(items) {
    writeRaw(CART_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
    emit(items);
  }

  /** Guarantees the fields every renderer and the order API read. */
  function normalizeItem(input) {
    const item = input && typeof input === 'object' ? input : {};
    const member = item.member && typeof item.member === 'object' ? item.member : null;
    const product = item.product && typeof item.product === 'object' ? item.product : null;
    const artist = item.artist && typeof item.artist === 'object' ? item.artist : null;
    const configuration = item.configuration && typeof item.configuration === 'object' ? item.configuration : {};

    return {
      ...item,
      cartItemId: item.cartItemId || newId(),
      artist: artist ? { slug: artist.slug || null, name: artist.name || null, fandom: artist.fandom || null } : null,
      member: member ? { id: member.id ?? null, slug: member.slug || null, name: member.name || null, designImageUrl: member.designImageUrl || null } : null,
      product: product ? { id: product.id ?? null, slug: product.slug || null, name: product.name || null, imageUrl: product.imageUrl || null } : null,
      version: item.version || null,
      bundle: item.bundle && typeof item.bundle === 'object' ? item.bundle : null,
      selections: item.selections && typeof item.selections === 'object' ? item.selections : {},
      configuration,
      extraLabels: Array.isArray(item.extraLabels) ? item.extraLabels : [],
      name: item.name || (member && member.name ? `${member.name} Keychain` : (product && product.name) || 'LOCOXATL Keychain'),
      imageUrl: imageUrl(item.imageUrl || item.previewImage || (member && member.designImageUrl) || (product && product.imageUrl)),
      quantity: clampQuantity(item.quantity),
      unitPrice: Number(item.unitPrice ?? item.total) || 0,
      lineTotal: (Number(item.unitPrice ?? item.total) || 0) * clampQuantity(item.quantity),
    };
  }

  const firstValue = (...values) => {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return '';
  };

  /**
   * Two lines are the same design only when the design, its add-ons, its clasp, its initial, its
   * bundle and every custom-category choice match. Anything else is a separate line.
   */
  function fingerprint(item) {
    const design = firstValue(
      item.memberId, item.member && item.member.id, item.memberSlug, item.member && item.member.slug,
      item.productId, item.product && item.product.id, item.productSlug, item.product && item.product.slug,
    );
    const addons = (Array.isArray(item.configuration && item.configuration.addons) ? item.configuration.addons : [])
      .map((addon) => String(addon && (addon.id ?? addon.key) || addon || '').toLowerCase())
      .filter(Boolean)
      .sort();
    const clasp = String(firstValue(item.configuration && item.configuration.clasp && item.configuration.clasp.id)).toLowerCase();
    const initial = String(firstValue(item.configuration && item.configuration.initial)).toUpperCase();
    const bundleId = firstValue(item.bundle && item.bundle.id, item.bundle && item.bundle.slug, '');
    const selections = Object.keys(item.selections || {})
      .filter((slug) => slug !== 'addon' && slug !== 'clasp')
      .sort()
      .map((slug) => {
        const keys = (Array.isArray(item.selections[slug]) ? item.selections[slug] : [item.selections[slug]])
          .map((key) => String(key && (key.key ?? key.id) || key || '').toLowerCase())
          .filter(Boolean)
          .sort();
        return `${slug}:${keys.join('|')}`;
      })
      .join(',');

    return [String(design), addons.join('|'), clasp, initial, String(bundleId), selections].join('~');
  }

  function addItem(design, options = {}) {
    const quantity = clampQuantity(options.quantity || 1);
    const cart = readCart();
    const candidate = normalizeItem({ ...design, cartItemId: design && design.cartItemId ? design.cartItemId : newId(), quantity });
    const key = fingerprint(candidate);
    const existing = cart.find((item) => fingerprint(item) === key);

    if (existing) {
      existing.quantity = clampQuantity(existing.quantity + quantity);
      existing.lineTotal = existing.unitPrice * existing.quantity;
    } else if (cart.length < MAX_ITEMS) {
      cart.push(candidate);
    } else {
      return { items: cart, added: false, reason: 'full' };
    }

    writeCart(cart);
    return { items: readCart(), added: true, cartItemId: existing ? existing.cartItemId : candidate.cartItemId };
  }

  function setQuantity(cartItemId, quantity) {
    const cart = readCart();
    const index = cart.findIndex((item) => item.cartItemId === cartItemId);
    if (index < 0) return cart;
    if (Number(quantity) < 1) {
      cart.splice(index, 1);
    } else {
      cart[index].quantity = clampQuantity(quantity);
      cart[index].lineTotal = cart[index].unitPrice * cart[index].quantity;
    }
    writeCart(cart);
    return readCart();
  }

  function removeItem(cartItemId) {
    return setQuantity(cartItemId, 0);
  }

  function clearCart() {
    writeRaw(CART_KEY, null);
    emit([]);
  }

  function clearDirectCheckout() {
    writeRaw(DIRECT_KEY, null);
  }

  function readDirectCheckout() {
    const raw = readRaw(DIRECT_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? normalizeItem(parsed) : null;
    } catch {
      return null;
    }
  }

  function writeDirectCheckout(design) {
    writeRaw(DIRECT_KEY, JSON.stringify(normalizeItem(design)));
  }

  function count(items) {
    return (Array.isArray(items) ? items : []).reduce((total, item) => total + (Number(item.quantity) || 0), 0);
  }

  function subtotal(items) {
    return (Array.isArray(items) ? items : []).reduce((total, item) => total + (Number(item.unitPrice) || 0) * (Number(item.quantity) || 0), 0);
  }

  /** "Pearl drop · Silver clasp · Initial A" — the line every summary and message reuses. */
  function configurationSummary(item) {
    if (!item) return '';
    const configuration = item.configuration || {};
    const addons = (Array.isArray(configuration.addons) ? configuration.addons : [])
      .map((addon) => addon && (addon.name || addon.label || addon.id))
      .filter(Boolean);
    const parts = [...addons];
    if (configuration.initial) parts.push(`Initial ${configuration.initial}`);
    const clasp = configuration.clasp && (configuration.clasp.name || configuration.clasp.id);
    if (clasp) parts.push(clasp);
    if (Array.isArray(item.extraLabels)) parts.push(...item.extraLabels.filter(Boolean));
    if (item.bundle && item.bundle.name) parts.push(`Paket ${item.bundle.name}`);
    return [...new Set(parts.map((part) => String(part).trim()).filter(Boolean))].join(' · ');
  }

  function indexBy(rows, keys) {
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row) continue;
      for (const key of keys(row)) {
        if (key !== null && key !== undefined && key !== '') map.set(String(key), row);
      }
    }
    return map;
  }

  function designLookup(item, payload) {
    const members = indexBy(payload.members, (row) => [row.slug, row.id]);
    const products = indexBy(payload.products, (row) => [row.slug, row.id]);
    if (item.member) {
      return members.get(String(item.member.slug || '')) || members.get(String(item.member.id ?? '')) || null;
    }
    if (item.product) {
      return products.get(String(item.product.slug || '')) || products.get(String(item.product.id ?? '')) || null;
    }
    return null;
  }

  /**
   * Re-checks every line against the live catalogue: current prices, and nothing the dashboard has
   * switched off. A line whose design is gone is dropped; a dead option is stripped from that line
   * only, so the rest of the cart still checks out.
   */
  function reconcileCartWithCatalog(items, payload) {
    const list = Array.isArray(items) ? items : [];
    const notices = [];
    if (!payload || !Array.isArray(payload.groups) || !pricing) {
      return { items: list.map(normalizeItem), notices, changed: false };
    }

    const liveGroups = new Set(payload.groups.map((group) => String(group.slug || '').toLowerCase()));
    const liveItems = new Map();
    for (const option of (payload.options && Array.isArray(payload.options.items) ? payload.options.items : [])) {
      if (!option || option.isActive === false || option.isLive === false) continue;
      const key = String(option.key ?? option.id ?? '').toLowerCase();
      if (key) liveItems.set(key, { key, label: option.label || key, price: Number(option.price) || 0, category: String(option.category || 'addon').toLowerCase() });
    }
    const liveCategories = (Array.isArray(payload.optionCategories) ? payload.optionCategories : [])
      .filter((category) => category && category.isActive !== false && category.isLive !== false);
    const liveCategorySlugs = new Set(liveCategories.map((category) => String(category.slug || '').toLowerCase()));
    const liveBundles = indexBy(payload.bundles, (row) => [row.id, row.slug]);
    const basePrice = Number(payload.product && payload.product.basePrice) || 0;
    const optionRows = [...liveItems.values()];

    const next = [];
    let changed = false;

    for (const raw of list) {
      const item = normalizeItem(raw);
      const design = designLookup(item, payload);
      const groupSlug = String((item.artist && item.artist.slug) || (design && design.groupSlug) || '').toLowerCase();

      if (!design || (groupSlug && !liveGroups.has(groupSlug))) {
        notices.push(`${item.name} is no longer available and was removed from your cart.`);
        changed = true;
        continue;
      }

      let itemChanged = false;
      const selections = {};
      for (const [slug, value] of Object.entries(item.selections || {})) {
        const keys = (Array.isArray(value) ? value : [value])
          .map((key) => String(key && (key.key ?? key.id) || key || '').toLowerCase())
          .filter(Boolean);
        if (!liveCategorySlugs.has(String(slug).toLowerCase())) {
          if (keys.length) {
            notices.push(`${slug} is no longer offered and was removed from ${item.name}.`);
            itemChanged = true;
          }
          continue;
        }
        const kept = keys.filter((key) => liveItems.has(key) && liveItems.get(key).category === String(slug).toLowerCase());
        if (kept.length !== keys.length) {
          notices.push(`Some options are no longer available and were removed from ${item.name}.`);
          itemChanged = true;
        }
        if (kept.length) selections[String(slug).toLowerCase()] = kept;
      }

      let bundle = item.bundle;
      if (bundle) {
        const live = liveBundles.get(String(bundle.id ?? '')) || liveBundles.get(String(bundle.slug ?? ''));
        if (!live || live.isActive === false) {
          notices.push(`The ${bundle.name || 'bundle'} package is no longer available and was removed from ${item.name}.`);
          bundle = null;
          itemChanged = true;
        } else {
          bundle = { ...bundle, id: live.id, slug: live.slug, name: live.name, price: Number(live.price) };
        }
      }

      const configuration = { ...item.configuration, selections };
      const addons = (selections.addon || []).map((key) => {
        const live = liveItems.get(key);
        return { id: key, name: live.label, price: live.price };
      });
      const claspKey = (selections.clasp || [])[0] || '';
      const clasp = claspKey ? { id: claspKey, name: liveItems.get(claspKey).label, price: liveItems.get(claspKey).price } : null;
      const initial = selections.addon && selections.addon.includes('initial') ? configuration.initial || '' : '';

      const quote = pricing.quoteSelections({
        basePrice,
        priceOverride: design.priceOverride,
        bundle: bundle ? { price: Number(bundle.price), freeAddonQuota: bundle.freeAddonQuota, allowedAddonKeys: bundle.allowedAddonKeys } : null,
        categories: liveCategories,
        items: optionRows,
        selections,
        personalization: { key: 'initial', active: Boolean(initial) },
        quantity: 1,
      });

      const unitPrice = Number(quote.total) || 0;
      if (unitPrice !== item.unitPrice) {
        notices.push(`${item.name} price updated to ${money(unitPrice)}.`);
        itemChanged = true;
      }

      next.push(normalizeItem({
        ...item,
        bundle,
        selections,
        configuration: { ...configuration, addons, clasp, initial },
        unitPrice,
        quantity: item.quantity,
        name: item.member && design.name ? `${design.name} Keychain` : (design.name || item.name),
        imageUrl: item.imageUrl || imageUrl(design.designImageUrl || design.imageUrl),
      }));
      if (itemChanged) changed = true;
    }

    if (changed) writeCart(next);
    return { items: next, notices: [...new Set(notices)], changed };
  }

  // ---------------------------------------------------------------- storefront UI

  const listeners = [];
  function emit(items) {
    const cart = Array.isArray(items) ? items : readCart();
    for (const listener of listeners) {
      try { listener(cart); } catch { /* a broken listener must not break the cart */ }
    }
  }

  function drawerMarkup() {
    return `
      <div class="drawer-backdrop" id="cartBackdrop" data-cart-backdrop></div>
      <aside class="cart-drawer" id="cartDrawer" role="dialog" aria-modal="false" aria-label="Shopping cart" aria-hidden="true">
        <div class="drawer-header">
          <div><span class="eyebrow">YOUR SELECTION</span><h2>Cart <span id="cartDrawerCount">0</span></h2></div>
          <button type="button" class="drawer-close-btn" id="cartClose" aria-label="Close cart">✕</button>
        </div>
        <div class="cart-items" id="cartItems"></div>
        <div class="cart-summary" id="cartSummary" hidden>
          <div class="summary-line"><span>Subtotal</span><strong id="cartSubtotal">Rp0</strong></div>
          <p>Shipping and payment are chosen at checkout.</p>
          <a class="button button-dark button-full" id="cartCheckout" href="checkout.html">Proceed to checkout <span aria-hidden="true">↗</span></a>
          <p class="demo-note"><a class="text-link" href="shop.html">Add another design <span aria-hidden="true">↗</span></a></p>
        </div>
      </aside>`;
  }

  function mount() {
    if (!root || !root.document) return null;
    const doc = root.document;
    if (!doc.getElementById('cartDrawer')) {
      const holder = doc.createElement('div');
      holder.innerHTML = drawerMarkup();
      while (holder.firstElementChild) doc.body.appendChild(holder.firstElementChild);
    }
    return doc.getElementById('cartDrawer');
  }

  let mounted = false;

  function render(items) {
    const doc = root && root.document;
    if (!doc) return;
    const cart = Array.isArray(items) ? items : readCart();
    const badge = doc.getElementById('cartCount');
    const total = count(cart);
    if (badge) {
      badge.textContent = String(total);
      badge.hidden = total === 0;
      const button = doc.getElementById('cartButton');
      if (button) button.setAttribute('aria-label', total ? `Cart, ${total} item${total === 1 ? '' : 's'}` : 'Cart, empty');
    }

    const drawerCount = doc.getElementById('cartDrawerCount');
    if (drawerCount) drawerCount.textContent = total ? `(${total})` : '';

    const container = doc.getElementById('cartItems');
    const summary = doc.getElementById('cartSummary');
    if (!container) return;

    if (!cart.length) {
      container.innerHTML = `
        <div class="empty-cart">
          <div class="empty-bag-icon" aria-hidden="true">✕</div>
          <h3>Your cart is empty.</h3>
          <p>Pick a collection, then add your design from the studio.</p>
          <a class="button button-dark" href="shop.html">Browse collections <span aria-hidden="true">↗</span></a>
        </div>`;
      if (summary) summary.hidden = true;
      return;
    }

    container.innerHTML = cart.map((item) => {
      const thumb = item.imageUrl
        ? `<img src="${escapeText(item.imageUrl)}" alt="" loading="lazy" decoding="async" />`
        : '<span aria-hidden="true">LX</span>';
      const group = [item.artist && item.artist.name, item.version ? `${item.version} version` : '']
        .filter(Boolean).join(' · ');
      const summaryText = configurationSummary(item);
      return `
        <article class="cart-item" data-cart-item="${escapeText(item.cartItemId)}">
          <div class="cart-thumb">${thumb}</div>
          <div>
            <h4>${escapeText(item.name)}${item.quantity > 1 ? ` <span class="cart-item-qty">×${item.quantity}</span>` : ''}</h4>
            ${group ? `<p>${escapeText(group)}</p>` : ''}
            ${summaryText ? `<p>${escapeText(summaryText)}</p>` : ''}
            <div class="cart-item-actions">
              <div class="qty-control" role="group" aria-label="Quantity for ${escapeText(item.name)}">
                <button type="button" data-cart-step="-1" aria-label="Decrease quantity">−</button>
                <span>${item.quantity}</span>
                <button type="button" data-cart-step="1" aria-label="Increase quantity">+</button>
              </div>
              <button type="button" class="remove-item" data-cart-remove>Remove</button>
            </div>
          </div>
          <strong>${money(item.unitPrice * item.quantity)}</strong>
        </article>`;
    }).join('');

    if (summary) {
      summary.hidden = false;
      const amount = doc.getElementById('cartSubtotal');
      if (amount) amount.textContent = money(subtotal(cart));
      const checkout = doc.getElementById('cartCheckout');
      if (checkout) {
        const onCheckout = /checkout\.html$/i.test(String(root.location && root.location.pathname || ''));
        checkout.hidden = onCheckout;
      }
    }
  }

  function openDrawer() {
    const doc = root && root.document;
    if (!doc) return;
    mount();
    render(readCart());
    const drawer = doc.getElementById('cartDrawer');
    const backdrop = doc.getElementById('cartBackdrop');
    if (drawer) {
      drawer.classList.add('open');
      drawer.setAttribute('aria-hidden', 'false');
    }
    if (backdrop) backdrop.classList.add('open');
    doc.body.classList.add('no-scroll');
    const close = doc.getElementById('cartClose');
    if (close) close.focus();
  }

  function closeDrawer() {
    const doc = root && root.document;
    if (!doc) return;
    const drawer = doc.getElementById('cartDrawer');
    const backdrop = doc.getElementById('cartBackdrop');
    if (drawer) {
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
    }
    if (backdrop) backdrop.classList.remove('open');
    doc.body.classList.remove('no-scroll');
  }

  function init() {
    if (!root || !root.document || mounted) return;
    mounted = true;
    mount();
    render(readCart());

    const doc = root.document;
    const button = doc.getElementById('cartButton');
    if (button) {
      button.addEventListener('click', () => openDrawer());
    }

    doc.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      if (target.closest('#cartClose') || target.closest('[data-cart-backdrop]')) {
        closeDrawer();
        return;
      }
      const row = target.closest('[data-cart-item]');
      if (!row) return;
      const cartItemId = row.dataset.cartItem;
      if (target.closest('[data-cart-remove]')) {
        removeItem(cartItemId);
        return;
      }
      const step = target.closest('[data-cart-step]');
      if (step) {
        const current = readCart().find((item) => item.cartItemId === cartItemId);
        if (current) setQuantity(cartItemId, current.quantity + Number(step.dataset.cartStep));
      }
    });

    doc.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const drawer = doc.getElementById('cartDrawer');
      if (drawer && drawer.classList.contains('open')) closeDrawer();
    });

    // Another tab changed the cart: the badge and an open drawer follow it.
    if (root.addEventListener) {
      root.addEventListener('storage', (event) => {
        if (event && event.key && event.key !== CART_KEY) return;
        render(readCart());
      });
    }

    listeners.push(render);
  }

  if (root && root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
  }

  return {
    CART_KEY,
    DIRECT_KEY,
    MAX_QUANTITY,
    MAX_ITEMS,
    money,
    readCart,
    addItem,
    setQuantity,
    removeItem,
    clearCart,
    readDirectCheckout,
    writeDirectCheckout,
    clearDirectCheckout,
    fingerprint,
    count,
    subtotal,
    configurationSummary,
    reconcileCartWithCatalog,
    openDrawer,
    closeDrawer,
    refresh: () => render(readCart()),
    subscribe: (listener) => { listeners.push(listener); listener(readCart()); },
  };
});
