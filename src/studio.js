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
  const requestedMember = params.get('member');

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const defaultProduct = catalog.productDefaults
    ? { ...catalog.productDefaults }
    : { baseModel: 'heart', baseLabel: 'Heart', basePrice: 0 };

  /**
   * The bundled group paints immediately; member artwork and live product settings arrive from
   * /api/catalog below. A database group unknown to the bundle waits for that request.
   */
  function startStudio() {
    const staticArtist = catalog.getArtist(requestedArtist);
    if (staticArtist) {
      initStudio(catalog.artistFromGroup(staticArtist, 0), null, defaultProduct);
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
      const index = groups.findIndex((group) => group.slug === requestedArtist);
      if (index < 0) {
        fallback();
        return;
      }
      initStudio(catalog.artistFromGroup(groups[index], index), null, (payload && payload.product) || defaultProduct);
    }).catch(fallback);
  }

  function initStudio(artist, initialMember, initialProduct) {
    const money = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value).replace('IDR', 'Rp').replace(/\s/g, '');
    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

    const baseNames = { heart: 'Heart', star: 'Star', bow: 'Ribbon' };
    let activeProduct = initialProduct || defaultProduct;
    let activeMember = initialMember || null;
    // Live prices from /api/catalog. Null until the request answers, so the bundled
    // src/options.js table keeps the page correct while it loads.
    let pricingTable = null;

    const state = {
      base: {
        id: baseNames[activeProduct.baseModel] ? activeProduct.baseModel : 'heart',
        name: activeProduct.baseLabel || baseNames[activeProduct.baseModel] || baseNames.heart,
        price: Number(activeProduct.basePrice) || 0,
      },
      clasp: { id: 'silver', name: 'Silver clasp', price: claspPrice('silver') },
      addons: [],
      initial: '',
      hidden: [],
    };

    const safeUpload = (url) => (catalog.safeImageUrl ? catalog.safeImageUrl(url) : '');

    function applyProduct(product) {
      const baseModel = baseNames[product.baseModel] ? product.baseModel : 'heart';
      state.base = {
        id: baseModel,
        name: product.baseLabel || baseNames[baseModel],
        price: Number(product.basePrice) || 0,
      };
    }

    function applyDesignImage(url, memberView) {
      const image = $('#studioDesignImage');
      const safe = safeUpload(url);
      if (!image) return;
      if (safe) {
        image.src = safe;
        image.alt = memberView ? `${memberView.name} keychain artwork` : 'Selected keychain artwork';
        image.hidden = false;
      } else {
        image.removeAttribute('src');
        image.hidden = true;
      }
    }

    function applyGroupLabels(artistView, memberView) {
      $('#studioArtistName').textContent = `${artistView.name.toUpperCase()} / ${artistView.fandom}`;
      $('#studioProductName').textContent = memberView
        ? `${memberView.name.toUpperCase()} · KEYCHAIN`
        : 'SHARED KEYCHAIN';
      $('#studioIntro').textContent = memberView
        ? `${memberView.name}'s artwork is printed on the same LOCOXATL keychain. Choose your details before checkout.`
        : 'Your artwork is printed on the same LOCOXATL keychain. Choose your details before checkout.';
      $('#studioArtistLink').textContent = artistView.name;
      $('#studioArtistLink').href = `artist.html?artist=${encodeURIComponent(artistView.slug)}`;
      document.title = `${memberView ? `${memberView.name} ` : ''}Custom Studio — LOCOXATL`;
      applyDesignImage(memberView ? memberView.designImageUrl : null, memberView);
    }

    applyGroupLabels(artist, activeMember);

    // Live product settings: the global silhouette/price and universal add-on/clasp prices.
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
        const groupMembers = (payload.members || [])
          .filter((member) => member.groupSlug === group.slug && member.isActive !== false)
          .map((member) => catalog.memberFromApi(member));

        if (requestedMember) {
          const match = groupMembers.find((member) => member.slug === requestedMember);
          if (!match && payload.source === 'database') {
            // The member was hidden or removed after the customer opened this page.
            window.location.replace(`artist.html?artist=${encodeURIComponent(group.slug)}`);
            return;
          }
          activeMember = match || activeMember;
        }

        activeProduct = payload.product || activeProduct;
        pricingTable = payload.options || null;
        applyProduct(activeProduct);
        applyGroupLabels(catalog.artistFromGroup(group, index), activeMember);
        refreshPriceState();
        update();
      }).catch(() => { /* keep the bundled labels and prices */ });
    }

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

    function renderPreview() {
      // The globally chosen silhouette drives both the 3D base and this flat fallback.
      const baseShapes = {
        heart: '<path d="M200 199c-27-37-78-21-69 23 7 34 69 76 69 76s62-42 69-76c9-44-42-60-69-23Z" fill="url(#previewWhite)" stroke="#c9c9c9" stroke-width="3"/><path d="M157 219c-4 12 1 23 10 30" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round"/>',
        star: '<path d="m200 187 21 43 47 5-35 31 10 47-43-24-43 24 10-47-35-31 47-5Z" fill="url(#previewWhite)" stroke="#c9c9c9" stroke-width="3"/><path d="m200 202 8 18" stroke="#fff" stroke-width="5" stroke-linecap="round"/>',
        bow: '<path d="M200 213c-26-35-68-28-67 8 1 24 30 42 64 31-8 24-7 46 3 61 10-15 11-37 3-61 34 11 63-7 64-31 1-36-41-43-67-8Z" fill="url(#previewWhite)" stroke="#c9c9c9" stroke-width="3"/><ellipse cx="200" cy="236" rx="13" ry="16" fill="#eee" stroke="#ccc" stroke-width="2"/>',
      };
      const shape = baseShapes[state.base.id] || baseShapes.heart;
      const artwork = safeUpload(activeMember ? activeMember.designImageUrl : '');
      // The flat fallback prints the member artwork onto the charm face too, clipped to the
      // same silhouette the 3D base uses.
      $('#previewBase').innerHTML = artwork
        ? `<defs><clipPath id="previewDesignClip">${shape}</clipPath></defs>${shape}<image href="${artwork}" x="110" y="175" width="180" height="165" preserveAspectRatio="xMidYMid slice" clip-path="url(#previewDesignClip)" opacity="0.94"/>`
        : shape;
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
        designImageUrl: safeUpload(activeMember ? activeMember.designImageUrl : ''),
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
        member: activeMember
          ? { slug: activeMember.slug, name: activeMember.name, designImageUrl: activeMember.designImageUrl || null }
          : null,
        baseModel: state.base.id,
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
          syncViewer();
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
