(() => {
  const catalog = window.LocoxatlCatalog;
  const pricing = window.LocoxatlPricing;
  const options = window.LocoxatlOptions || null;
  // Dynamic import() inside a classic script resolves against the document URL, so the
  // viewer URL is derived from this script's own src instead.
  const selfUrl = document.currentScript ? document.currentScript.src : window.location.href;
  const viewerModuleUrl = new URL('three/viewer.mjs', selfUrl).href;
  if (!catalog || !pricing) return;

  const params = new URLSearchParams(window.location.search);
  const requestedArtist = params.get('artist');
  const requestedProduct = params.get('product');

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  /**
   * Designs created in the dashboard do not exist in the bundled catalogue, so a miss there is
   * resolved against /api/catalog before the studio gives up and returns to the shop.
   */
  function startStudio() {
    const staticArtist = catalog.getArtist(requestedArtist);
    const staticProduct = catalog.getProduct(requestedProduct);
    if (staticArtist && staticProduct) {
      initStudio(staticArtist, staticProduct);
      return;
    }

    const ready = window.locoxatlCatalog;
    const fallback = () => window.location.replace('shop.html');
    if (!ready || typeof ready.then !== 'function') {
      fallback();
      return;
    }

    ready.then((payload) => {
      const groups = (payload && payload.groups) || [];
      const products = (payload && payload.products) || [];
      const index = groups.findIndex((group) => group.slug === requestedArtist);
      const liveProduct = products.find((item) => item.slug === requestedProduct);
      if (index < 0 || !liveProduct) {
        fallback();
        return;
      }
      initStudio(catalog.artistFromGroup(groups[index], index), liveProduct);
    }).catch(fallback);
  }

  function initStudio(artist, product) {
    const money = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value).replace('IDR', 'Rp').replace(/\s/g, '');
    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

    function applyGroupLabels(artistView, productView) {
      $('#studioArtistName').textContent = `${artistView.name.toUpperCase()} / ${artistView.fandom}`;
      $('#studioProductName').textContent = productView.name.toUpperCase();
      $('#studioIntro').textContent = `Personalize ${productView.name} from the ${artistView.name} collection. Choose your details before checkout.`;
      $('#studioArtistLink').textContent = artistView.name;
      $('#studioArtistLink').href = `artist.html?artist=${encodeURIComponent(artistView.slug)}`;
      document.title = `${productView.name} Custom Studio — LOCOXATL`;
    }

    applyGroupLabels(artist, product);

    // Hydrate from the curated catalogue: the design (name, base price, template, image) and the
    // live add-on/clasp prices all come from the database when it is available.
    const catalogReady = window.locoxatlCatalog;
    if (catalogReady && typeof catalogReady.then === 'function') {
      catalogReady.then((payload) => {
        if (!payload || !Array.isArray(payload.groups)) return;
        const index = payload.groups.findIndex((group) => group.slug === artist.slug);
        if (index < 0) {
          if (payload.source === 'database') window.location.replace('shop.html');
          return;
        }

        const group = payload.groups[index];
        const groupProducts = (payload.products || []).filter((item) => item.groupSlug === group.slug);
        const liveProduct = groupProducts.find((item) => item.slug === product.slug) || null;

        if (!liveProduct && payload.source === 'database') {
          // The design was hidden after the customer opened this page.
          window.location.replace(`artist.html?artist=${encodeURIComponent(group.slug)}`);
          return;
        }

        pricingTable = payload.options || null;
        applyGroupLabels(catalog.artistFromGroup(group, index), liveProduct || product);
        if (liveProduct) applyLiveDesign(liveProduct, groupProducts);
        refreshPriceState();
        update();
      }).catch(() => { /* keep the bundled labels and prices */ });
    }

    /** Applies a database design: base price, silhouette, image and the 3D template. */
    function applyLiveDesign(liveProduct, groupProducts) {
      designsByBase = {};
      for (const item of groupProducts) {
        if (item.baseId) designsByBase[item.baseId] = item;
      }

      // template_key decides which silhouette the viewer renders, so a design whose template
      // differs from the URL's starting base still opens on the right shape.
      const liveBase = liveProduct.baseId || state.base.id;
      state.base = {
        id: liveBase,
        name: liveProduct.name || baseNames[liveBase],
        price: Number(liveProduct.price) || 0,
      };

      const image = $('#studioDesignImage');
      if (image) {
        const thumb = safeUpload(liveProduct.imageUrl);
        if (thumb) {
          image.src = thumb;
          image.alt = liveProduct.name || 'Selected design';
          image.hidden = false;
        } else {
          image.removeAttribute('src');
          image.hidden = true;
        }
      }

      // Keep the silhouette buttons on live prices so swapping the base reprices correctly.
      $$('.base-choices .choice-button').forEach((button) => {
        const live = designsByBase[button.dataset.base];
        if (live) button.dataset.price = String(live.price);
        button.classList.toggle('selected', button.dataset.base === liveBase);
      });
    }

    /** Re-reads every displayed price from the current table. */
    function refreshPriceState() {
      state.clasp = { ...state.clasp, price: claspPrice(state.clasp.id) };
      state.addons = state.addons.map((addon) => ({ ...addon, name: addonName(addon.id), price: addonPrice(addon.id) }));

      $$('.addon-option input').forEach((input) => {
        const option = input.closest('.addon-option');
        const label = option ? option.querySelector('small') : null;
        if (label) label.textContent = money(addonPrice(input.dataset.addon));
      });
      $$('.clasp-choice').forEach((button) => {
        const label = button.querySelector('small');
        if (label) label.textContent = `+${money(claspPrice(button.dataset.clasp))}`;
      });
    }

    const baseNames = { heart: 'Cloud Heart', star: 'Orbit Star', bow: 'Soft Ribbon' };
    // Live prices from /api/catalog. Null until the request answers, so the bundled
    // src/options.js table keeps the page correct while it loads.
    let pricingTable = null;
    let designsByBase = {};

    const state = {
      base: { id: product.baseId, name: baseNames[product.baseId], price: product.price },
      clasp: { id: 'silver', name: 'Silver clasp', price: claspPrice('silver') },
      addons: [],
      initial: '',
      hidden: [],
    };

    const safeUpload = (url) => (/^\/assets\/uploads\/catalog\/[A-Za-z0-9._-]+$/.test(String(url || '')) ? String(url) : '');

    // src/options.js stays the fallback, but a live pricing table from the dashboard wins so the
    // customizer, the checkout snapshot and the order API all price the same configuration.
    function addonPrice(id) {
      if (pricingTable) {
        const live = pricing.priceOf(pricingTable.addons, id);
        if (live !== null) return live;
      }
      const fromOptions = options && options.getAddon(id);
      if (fromOptions) return fromOptions.price;
      const input = $(`[data-addon="${id}"]`);
      return input ? Number(input.dataset.price) : 0;
    }

    function claspPrice(id) {
      if (pricingTable) {
        const live = pricing.priceOf(pricingTable.clasps, id);
        if (live !== null) return live;
      }
      const fromOptions = options && options.getClasp(id);
      if (fromOptions) return fromOptions.price;
      const button = $(`.clasp-choice[data-clasp="${id}"]`);
      return button ? Number(button.dataset.price) : 0;
    }

    function addonName(id) {
      if (pricingTable) {
        const live = pricingTable.addons.find((item) => item && item.key === id);
        if (live && live.label) return live.label;
      }
      const fromOptions = options && options.getAddon(id);
      if (fromOptions) return fromOptions.name;
      return { pearl: 'Pearl drop', star: 'Mini star', initial: 'Your initial' }[id] || id;
    }

    function renderPreview() {
      const baseShapes = {
        heart: '<path d="M200 199c-27-37-78-21-69 23 7 34 69 76 69 76s62-42 69-76c9-44-42-60-69-23Z" fill="url(#previewWhite)" stroke="#c9c9c9" stroke-width="3"/><path d="M157 219c-4 12 1 23 10 30" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round"/>',
        star: '<path d="m200 187 21 43 47 5-35 31 10 47-43-24-43 24 10-47-35-31 47-5Z" fill="url(#previewWhite)" stroke="#c9c9c9" stroke-width="3"/><path d="m200 202 8 18" stroke="#fff" stroke-width="5" stroke-linecap="round"/>',
        bow: '<path d="M200 213c-26-35-68-28-67 8 1 24 30 42 64 31-8 24-7 46 3 61 10-15 11-37 3-61 34 11 63-7 64-31 1-36-41-43-67-8Z" fill="url(#previewWhite)" stroke="#c9c9c9" stroke-width="3"/><ellipse cx="200" cy="236" rx="13" ry="16" fill="#eee" stroke="#ccc" stroke-width="2"/>',
      };
      $('#previewBase').innerHTML = baseShapes[state.base.id];
      let addonMarkup = '';
      if (state.addons.some((item) => item.id === 'pearl')) addonMarkup += '<path d="M260 285v18" stroke="#bbb" stroke-width="5" stroke-linecap="round"/><circle cx="260" cy="321" r="16" fill="url(#previewWhite)" stroke="#ccc" stroke-width="2"/><circle cx="254" cy="315" r="5" fill="#fff"/>';
      if (state.addons.some((item) => item.id === 'star')) addonMarkup += '<path d="M132 291v12" stroke="#bbb" stroke-width="5" stroke-linecap="round"/><path d="m132 304 8 17 19 2-14 12 4 19-17-10-17 10 4-19-14-12 19-2Z" fill="url(#previewWhite)" stroke="#ccc" stroke-width="2"/>';
      $('#previewAddon').innerHTML = addonMarkup;
      $('#previewInitial').innerHTML = state.initial ? `<circle cx="200" cy="270" r="17" fill="#111" stroke="#fff" stroke-width="2"/><text x="200" y="276" text-anchor="middle" font-size="15" font-family="Inter, sans-serif" font-weight="700" fill="#fff">${escapeHtml(state.initial)}</text>` : '';
      $('#previewRing').setAttribute('stroke', state.clasp.id === 'black' ? '#151515' : '#aaa');
      $('#previewRing').setAttribute('stroke-width', state.clasp.id === 'black' ? '13' : '11');
      $('#previewCount').textContent = `${2 + state.addons.length + (state.initial ? 1 : 0)} PIECES`;
      const quote = pricing.calculatePrice({ basePrice: state.base.price, addonPrices: state.addons.map((item) => item.price), claspPrice: state.clasp.price, personalizationPrice: state.initial ? addonPrice('initial') : 0, pricing: pricingTable || undefined, quantity: 1 });
      $('#builderPrice').textContent = money(quote.total);
      return quote.total;
    }

    function viewerState() {
      const addons = state.addons.map((item) => item.id);
      const initialToggle = $('#initialToggle');
      if (initialToggle && initialToggle.checked) addons.push('initial');
      return {
        base: state.base.id,
        clasp: state.clasp.id,
        addons,
        initial: state.initial,
        hidden: state.hidden,
      };
    }

    function syncViewer() {
      const viewer = window.LocoxatlStudio3D;
      if (viewer && typeof viewer.applyState === 'function') viewer.applyState(viewerState());
    }

    function update() {
      renderPreview();
      syncViewer();
    }

    $$('.base-choices .choice-button').forEach((button) => {
      const selected = button.dataset.base === product.baseId;
      button.classList.toggle('selected', selected);
      button.addEventListener('click', () => {
        $$('.base-choices .choice-button').forEach((choice) => choice.classList.toggle('selected', choice === button));
        state.base = { id: button.dataset.base, name: baseNames[button.dataset.base], price: Number(button.dataset.price) };
        update();
      });
    });

    $$('.addon-option input').forEach((input) => input.addEventListener('change', () => {
      const addon = { id: input.dataset.addon, name: addonName(input.dataset.addon), price: addonPrice(input.dataset.addon) };
      state.addons = state.addons.filter((item) => item.id !== addon.id);
      state.hidden = state.hidden.filter((id) => id !== addon.id);
      if (input.checked && addon.id !== 'initial') state.addons.push(addon);
      if (addon.id === 'initial') {
        $('#initialText').disabled = !input.checked;
        if (!input.checked) { state.initial = ''; $('#initialText').value = ''; }
      }
      update();
    }));

    $('#initialText').addEventListener('input', (event) => {
      state.initial = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 1);
      event.target.value = state.initial;
      update();
    });

    $$('.clasp-choice').forEach((button) => button.addEventListener('click', () => {
      $$('.clasp-choice').forEach((choice) => choice.classList.toggle('selected', choice === button));
      state.clasp = { id: button.dataset.clasp, name: button.dataset.clasp === 'silver' ? 'Silver clasp' : 'Black clasp', price: claspPrice(button.dataset.clasp) };
      update();
    }));

    $('#continueToCheckout').addEventListener('click', () => {
      if ($('#initialToggle').checked && !state.initial) {
        $('#initialText').focus();
        $('#initialText').setCustomValidity('Enter one letter for your initial.');
        $('#initialText').reportValidity();
        $('#initialText').addEventListener('input', () => $('#initialText').setCustomValidity(''), { once: true });
        return;
      }
      const total = renderPreview();
      const viewer = window.LocoxatlStudio3D;
      const snapshot = viewer && typeof viewer.getSnapshot === 'function' ? viewer.getSnapshot() : null;
      const pendingOrder = {
        artist: { slug: artist.slug, name: artist.name, fandom: artist.fandom },
        product: { slug: product.slug, name: product.name, price: state.base.price },
        configuration: {
          base: state.base,
          addons: state.addons,
          initial: state.initial,
          clasp: state.clasp,
          render: snapshot ? { engine: snapshot.engine, version: snapshot.version } : { engine: 'svg-fallback', version: 1 },
          components: snapshot ? snapshot.components : [],
        },
        viewer: snapshot,
        total,
        quantity: 1,
        createdAt: new Date().toISOString(),
      };
      localStorage.setItem('locoxatl-pending-order', JSON.stringify(pendingOrder));
      window.location.href = 'checkout.html';
    });

    renderPreview();

    /* ------------------------------------------------------------------ *
     * Lazy 3D viewer. Three.js is only downloaded once the preview area
     * approaches the viewport, and only when WebGL is available. If it is
     * not, the SVG preview above stays in place as the fallback.
     * ------------------------------------------------------------------ */

    const viewerElements = {
      canvas: $('#studioViewerCanvas'),
      stage: $('#studioViewerStage'),
      explodeButton: $('#viewerExplode'),
      assembleButton: $('#viewerAssemble'),
      resetButton: $('#viewerReset'),
      partList: $('#viewerPartList'),
      selectionName: $('#viewerSelectionName'),
      selectionMeta: $('#viewerSelectionMeta'),
      swatches: $('#viewerSwatches'),
      visibilityToggle: $('#viewerVisibilityToggle'),
      hint: $('#viewerHint'),
    };

    let viewerRequested = false;

    function hasWebGL() {
      try {
        const probe = document.createElement('canvas');
        return Boolean(window.WebGLRenderingContext && (probe.getContext('webgl2') || probe.getContext('webgl')));
      } catch {
        return false;
      }
    }

    function onToggleAddon(componentId, visible) {
      const input = $(`[data-addon="${componentId}"]`);
      if (!input || input.checked === visible) return;
      input.checked = visible;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function loadViewer() {
      if (viewerRequested) return;
      viewerRequested = true;
      if (!viewerElements.canvas || !viewerElements.stage) return;

      if (!hasWebGL()) {
        viewerElements.stage.dataset.viewer = 'failed';
        document.dispatchEvent(new CustomEvent('locoxatl:viewer-unavailable', { detail: { message: 'WebGL is not available in this browser.' } }));
        return;
      }

      import(viewerModuleUrl)
        .then(({ mountStudioViewer }) => {
          mountStudioViewer(viewerElements, {
            ...viewerState(),
            onToggleAddon,
          });
          const panel = viewerElements.stage.closest('.builder-preview-panel');
          if (panel) panel.classList.add('is-3d');
        })
        .catch((error) => {
          viewerElements.stage.dataset.viewer = 'failed';
          document.dispatchEvent(new CustomEvent('locoxatl:viewer-unavailable', { detail: { message: error.message } }));
          if (window.console) console.warn('LOCOXATL 3D viewer unavailable, keeping the SVG preview.', error);
        });
    }

    function scheduleViewerLoad() {
      loadViewer();
    }

    if (viewerElements.stage) {
      if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer.disconnect();
            scheduleViewerLoad();
          }
        }, { rootMargin: '320px 0px' });
        observer.observe(viewerElements.stage);
      } else {
        window.setTimeout(scheduleViewerLoad, 400);
      }
    }

    window.addEventListener('pagehide', () => {
      if (window.LocoxatlStudio3D && typeof window.LocoxatlStudio3D.dispose === 'function') window.LocoxatlStudio3D.dispose();
    });
  }

  startStudio();
})();