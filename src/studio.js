(() => {
  const catalog = window.LocoxatlCatalog;
  const pricing = window.LocoxatlPricing;
  const options = window.LocoxatlOptions || null;
  const whatsapp = window.LocoxatlWhatsApp || null;
  // Dynamic import() inside a classic script resolves against the document URL, so the
  // viewer URL is derived from this script's own src instead.
  const selfUrl = document.currentScript ? document.currentScript.src : window.location.href;
  const viewerModuleUrl = new URL('three/viewer.mjs', selfUrl).href;
  // Feature flag. The three.js modules, the vendor bundle and the stored snapshot fields all
  // stay in place; only the viewport stops mounting, so the SVG preview stays in charge.
  const ENABLE_3D_PREVIEW = false;
  if (!catalog || !pricing) return;

  const params = new URLSearchParams(window.location.search);
  const requestedArtist = params.get('artist');
  const requestedMember = params.get('member');
  // The two-step collection flow hands the chosen version to the studio; unknown values are
  // ignored so a stale link never blocks checkout.
  const requestedVersion = ['yellow', 'pink'].includes(String(params.get('version') || '').toLowerCase())
    ? String(params.get('version')).toLowerCase()
    : null;

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
      initStudio(catalog.artistFromGroup(staticArtist, 0), null, defaultProduct, requestedVersion);
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
      initStudio(catalog.artistFromGroup(groups[index], index), null, (payload && payload.product) || defaultProduct, requestedVersion);
    }).catch(fallback);
  }

  function initStudio(artist, initialMember, initialProduct, initialVersion) {
    const money = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value).replace('IDR', 'Rp').replace(/\s/g, '');
    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

    const baseNames = { heart: 'Heart', star: 'Star', bow: 'Ribbon' };
    let activeProduct = initialProduct || defaultProduct;
    let activeMember = initialMember || null;
    // Live prices from /api/catalog. Null until the request answers, so the bundled
    // src/options.js table keeps the page correct while it loads.
    let pricingTable = null;
    // Bundle packages ("paketan") arrive with the same catalogue payload. No bundle selected
    // means the standard base price with every add-on charged normally.
    let availableBundles = [];
    let activeBundle = null;
    // Set by every renderPreview() call; the checkout payload reads it instead of recomputing.
    let lastQuote = null;
    // The resolved preview image and label, handed to the checkout summary.
    let lastPreview = { imageUrl: '', label: '' };
    // The catalogue row for this collection, once the API answers. Custom design groups use it.
    let activeGroup = null;
    // Delivery and payment choices. Shopee is settled in Shopee, so it never asks for a method.
    let fulfillmentMethod = 'campus_delivery';
    let publicConfig = null;
    // Yellow or pink, when the collection page sent one. It travels with the order so the
    // server can prove the design belongs to that version.
    const activeVersion = initialVersion || null;

    const state = {
      base: {
        id: baseNames[activeProduct.baseModel] ? activeProduct.baseModel : 'heart',
        name: activeProduct.baseLabel || baseNames[activeProduct.baseModel] || baseNames.heart,
        price: Number(activeProduct.basePrice) || 0,
      },
      clasp: { id: 'silver', name: 'Silver clasp', price: claspPrice('silver') },
      addons: [],
      // Every choice the customer makes, by dashboard category slug. The static addon and clasp
      // markup and the dynamically rendered categories both write into this one map.
      selections: { addon: [], clasp: ['silver'] },
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
        // The dashboard owns the categories and their items; the bundled list stays until it answers.
        if (payload.options && Array.isArray(payload.options.items) && payload.options.items.length) {
          activeItems = payload.options.items
            .filter((item) => item && item.isActive !== false)
            .map((item) => ({
              key: String(item.key || '').toLowerCase(),
              category: String(item.category || 'addon').toLowerCase(),
              price: Number(item.price) || 0,
              label: item.label || item.key,
              personalization: Boolean(item.personalization),
            }));
        }
        if (Array.isArray(payload.optionCategories) && payload.optionCategories.length) {
          activeCategories = payload.optionCategories;
        }
        applyStaticStepVisibility();
        renderDynamicCategories();
        syncSelections();
        activeGroup = group;
        applyGroupNotice();
        // Only bundles that apply to this collection are offered; a group-scoped bundle from
        // another collection never appears here.
        availableBundles = (Array.isArray(payload.bundles) ? payload.bundles : [])
          .filter((item) => item && item.isActive !== false)
          .filter((item) => item.groupId == null || item.groupSlug === group.slug || Number(item.groupId) === Number(group.id));
        if (activeBundle && !availableBundles.some((item) => item.id === activeBundle.id)) activeBundle = null;
        renderBundleChoices();
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
      if (state.clasp) state.clasp = { ...state.clasp, price: claspPrice(state.clasp.id) };
      state.addons = state.addons.map((addon) => ({ ...addon, name: addonName(addon.id), price: addonPrice(addon.id) }));

      $$('.addon-option input').forEach((input) => {
        if (!input.dataset.addon) return; // dashboard categories price their own rows
        const option = input.closest('.addon-option');
        const label = option ? option.querySelector('small') : null;
        if (label) label.textContent = money(addonPrice(input.dataset.addon));
      });
      $$('.clasp-choice').forEach((button) => {
        if (!button.dataset.clasp) return; // same: dynamic single-choice rows are not clasps
        const label = button.querySelector('small');
        if (label) label.textContent = `+${money(claspPrice(button.dataset.clasp))}`;
      });
    }

    // ------------------------------------------------------------- option groups
    // The dashboard owns the categories. The two built-in ones keep their static markup because
    // the personalization field lives there; every other active category renders below.
    const STATIC_CATEGORIES = ['addon', 'clasp'];
    let activeCategories = (options && options.optionCategories) || [];
    let activeItems = bundledOptionItems();

    function bundledOptionItems() {
      const items = [];
      for (const addon of (options && options.addons) || []) {
        items.push({ key: addon.id, category: 'addon', price: addon.price, label: addon.name, personalization: Boolean(addon.personalization) });
      }
      for (const clasp of (options && options.clasps) || []) {
        items.push({ key: clasp.id, category: 'clasp', price: clasp.price, label: clasp.name });
      }
      for (const strap of (options && options.straps) || []) {
        items.push({ key: strap.id, category: 'silicone-strap', price: strap.price, label: strap.name });
      }
      return items;
    }

    function itemByKey(key) {
      return activeItems.find((item) => item.key === key) || null;
    }

    function categoryBySlug(slug) {
      return activeCategories.find((row) => row && String(row.slug).toLowerCase() === slug) || null;
    }

    function categoryItems(slug) {
      return activeItems.filter((item) => item && item.category === slug);
    }

    /** A category is offered when the dashboard left it active and it still has an active item. */
    function categoryOffered(slug) {
      const category = categoryBySlug(slug);
      if (!category || category.isActive === false) return false;
      return categoryItems(slug).length > 0;
    }

    /**
     * The addon and clasp steps are static markup, so the dashboard cannot delete them. Hiding
     * them here keeps a deactivated category off the page and out of the total.
     */
    function applyStaticStepVisibility() {
      const addonStep = $('#addonStep');
      const claspStep = $('#claspStep');

      if (addonStep) {
        addonStep.hidden = !categoryOffered('addon');
        // A row whose option the dashboard switched off leaves the list; the rest of the step stays.
        $$('.addon-option', addonStep).forEach((option) => {
          const input = option.querySelector('input[data-addon]');
          if (!input) return;
          const offered = Boolean(itemByKey(input.dataset.addon));
          option.hidden = !offered;
          if (!offered && input.checked) {
            input.checked = false;
            if (input.dataset.addon === 'initial') {
              state.initial = '';
              const initialText = $('#initialText');
              if (initialText) {
                initialText.value = '';
                initialText.disabled = true;
              }
            }
          }
        });
      }

      if (addonStep && addonStep.hidden) {
        $$('.addon-option input', addonStep).forEach((input) => { input.checked = false; });
        state.initial = '';
        const initialText = $('#initialText');
        if (initialText) {
          initialText.value = '';
          initialText.disabled = true;
        }
      }

      if (claspStep && !claspStep.hidden) {
        const buttons = $$('.clasp-choice[data-clasp]', claspStep);
        const offered = buttons.filter((button) => Boolean(itemByKey(button.dataset.clasp)));
        buttons.filter((button) => !offered.includes(button)).forEach((button) => button.classList.remove('selected'));
        // The default clasp has to be one the dashboard still offers.
        if (offered.length && !offered.some((button) => button.classList.contains('selected'))) {
          offered[0].classList.add('selected');
        }
      }
    }

    function renderDynamicCategories() {
      const container = $('#dynamicOptionSteps');
      if (!container) return;

      const sections = activeCategories.filter((category) => category
        && category.isActive !== false
        && !STATIC_CATEGORIES.includes(category.slug));

      container.innerHTML = sections.map((category) => {
        const items = activeItems.filter((item) => item.category === category.slug);
        if (!items.length) return '';
        const selected = state.selections[category.slug] || [];
        const single = category.selectionMode === 'single';

        const controls = single
          ? `<div class="clasp-choices">${items.map((item) => `<button type="button" class="clasp-choice${selected.includes(item.key) ? ' selected' : ''}" data-option-category="${escapeHtml(category.slug)}" data-option-key="${escapeHtml(item.key)}" aria-pressed="${selected.includes(item.key)}">${escapeHtml(item.label)} <small>${money(item.price)}</small></button>`).join('')}</div>`
          : `<div class="addon-list">${items.map((item) => `<label class="addon-option"><span class="addon-name">${escapeHtml(item.label)}<small>${money(item.price)}</small></span><input type="checkbox" data-option-category="${escapeHtml(category.slug)}" data-option-key="${escapeHtml(item.key)}" ${selected.includes(item.key) ? 'checked' : ''} /><i class="custom-check"></i></label>`).join('')}</div>`;

        const hint = single ? (category.isRequired ? 'Choose one.' : 'Optional.') : 'Choose any that fit.';
        return `<div class="builder-step"><div class="step-heading"><div><h3>${escapeHtml(category.name)}</h3><p>${hint}</p></div></div>${controls}</div>`;
      }).join('');
    }

    /** Mirrors the DOM (static markup plus rendered categories) into state.selections. */
    function syncSelections() {
      const next = {};
      $$('[data-option-category], .addon-option input[data-addon], .clasp-choice[data-clasp]').forEach((element) => {
        // A step the dashboard switched off is hidden; whatever it still holds is not a choice.
        const step = element.closest ? element.closest('.builder-step') : null;
        if (step && step.hidden) return;
        const category = element.dataset.optionCategory || (element.dataset.addon ? 'addon' : (element.dataset.clasp ? 'clasp' : ''));
        const key = element.dataset.optionKey || element.dataset.addon || element.dataset.clasp;
        if (!category || !key) return;
        const on = element.type === 'checkbox' ? element.checked : element.classList.contains('selected');
        if (!next[category]) next[category] = [];
        if (on && !next[category].includes(key)) next[category].push(key);
      });

      state.selections = next;
      state.addons = (next.addon || []).map((key) => ({
        id: key,
        name: itemByKey(key) ? itemByKey(key).label : addonName(key),
        price: itemByKey(key) ? itemByKey(key).price : addonPrice(key),
      }));
      // No clasp chosen means no clasp: the dashboard can ship a catalogue without that category.
      const claspKey = (next.clasp || [])[0] || '';
      const claspItem = claspKey ? itemByKey(claspKey) : null;
      state.clasp = claspKey
        ? { id: claspKey, name: claspItem ? claspItem.label : 'Clasp', price: claspItem ? claspItem.price : claspPrice(claspKey) }
        : null;
    }

    /** Shows every option the bundle covers as Rp 0 and renames its price label. */
    function markFreeOptions(lines) {
      const free = new Set((lines || []).filter((line) => line.free).map((line) => line.key));
      $$('.addon-option').forEach((option) => {
        const input = option.querySelector('input');
        const label = option.querySelector('small');
        const key = input ? (input.dataset.optionKey || input.dataset.addon) : '';
        if (!key || !label) return;
        const isFree = free.has(key);
        const item = itemByKey(key);
        label.textContent = isFree ? 'Free (Included in Bundle)' : money(item ? item.price : addonPrice(key));
        option.classList.toggle('is-free', isFree);
      });
    }

    function updateBundleNote(quote) {
      const note = $('#bundleNote');
      const step = $('#bundleStep');
      if (step) step.hidden = !availableBundles.length;
      if (!note) return;
      if (!activeBundle) {
        note.hidden = true;
        note.textContent = '';
        return;
      }
      const quota = Number(activeBundle.freeAddonQuota) || 0;
      const used = quote && Array.isArray(quote.freeAddonIds) ? quote.freeAddonIds.length : 0;
      note.hidden = false;
      note.textContent = `${used} of ${quota} free add-on${quota === 1 ? '' : 's'} used. Extra add-ons are charged normally.`;
    }

    function renderBundleChoices() {
      const step = $('#bundleStep');
      const container = $('#bundleChoices');
      if (!step || !container) return;
      if (!availableBundles.length) {
        step.hidden = true;
        container.innerHTML = '';
        return;
      }
      step.hidden = false;

      container.innerHTML = [null, ...availableBundles].map((item) => {
        const selected = item ? Boolean(activeBundle) && activeBundle.id === item.id : !activeBundle;
        const quota = item ? Number(item.freeAddonQuota) || 0 : 0;
        const detail = item
          ? `${money(item.price)} · ${quota} free add-on${quota === 1 ? '' : 's'}`
          : 'Standard price · no bundle';
        return `<button type="button" class="bundle-choice${selected ? ' selected' : ''}" data-bundle="${item ? item.id : ''}" aria-pressed="${selected}"><span>${escapeHtml(item ? item.name : 'No bundle')}<small>${detail}</small></span></button>`;
      }).join('');

      container.querySelectorAll('[data-bundle]').forEach((button) => {
        button.addEventListener('click', () => {
          const id = button.dataset.bundle ? Number(button.dataset.bundle) : null;
          activeBundle = id ? availableBundles.find((item) => item.id === id) || null : null;
          renderBundleChoices();
          update();
        });
      });
    }

    // ------------------------------------------------- delivery, custom design and Shopee
    const FULFILLMENT_OPTIONS = [
      { code: 'campus_delivery', label: 'Kirim ke Kampus', detail: 'Khusus Telkom University Jakarta' },
      { code: 'cod_telkom', label: 'COD / Ketemuan', detail: 'Khusus Telkom University Jakarta' },
      { code: 'shopee_external', label: 'Eksternal: Order via Shopee', detail: 'Chat CS untuk link CO Shopee' },
    ];

    const waNumber = () => (publicConfig && publicConfig.whatsappNumber) || '';

    fetch('/api/public-config')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        publicConfig = data || null;
        applyGroupNotice();
        if (!$('#shopeeModal') || $('#shopeeModal').hidden) return;
        renderFulfillmentChoices();
      })
      .catch(() => { /* the generic wa.me share sheet still works */ });

    /** One readable line describing the current build, used by the Shopee chat message. */
    function describeSelection() {
      const parts = [];
      if (activeMember) parts.push(`${activeMember.name} keychain`);
      else if (activeProduct && activeProduct.name) parts.push(activeProduct.name);
      if (state.base && state.base.name) parts.push(state.base.name);
      state.addons.forEach((addon) => parts.push(addon.name));
      if (state.initial) parts.push(`Initial ${state.initial}`);
      if (state.clasp) parts.push(state.clasp.name);
      Object.entries(state.selections)
        .filter(([slug]) => !STATIC_CATEGORIES.includes(slug))
        .forEach(([, keys]) => keys.forEach((key) => {
          const item = itemByKey(key);
          if (item) parts.push(item.label);
        }));
      if (activeBundle) parts.push(`Paket ${activeBundle.name}`);
      if (activeVersion) parts.push(`${activeVersion} version`);
      return parts.filter(Boolean).join(' · ');
    }

    /** Custom design collections take the artwork on WhatsApp, so the builder says so up front. */
    function applyGroupNotice() {
      const notice = $('#customDesignNotice');
      if (!notice) return;
      const isCustom = Boolean(activeGroup && activeGroup.isCustomDesign);
      notice.hidden = !isCustom;
      if (!isCustom) return;

      const link = $('#customDesignWaLink');
      if (link && whatsapp) {
        link.href = whatsapp.buildChatUrl(
          waNumber(),
          whatsapp.buildCustomDesignMessage(activeMember ? activeMember.name : artist.name),
        );
      }
    }

    function renderFulfillmentChoices() {
      const container = $('#fulfillmentChoices');
      if (!container) return;
      container.innerHTML = FULFILLMENT_OPTIONS.map((option) => {
        const selected = fulfillmentMethod === option.code;
        return `<button type="button" class="bundle-choice${selected ? ' selected' : ''}" data-fulfillment="${option.code}" aria-pressed="${selected}"><span>${escapeHtml(option.label)}<small>${escapeHtml(option.detail)}</small></span></button>`;
      }).join('');

      container.querySelectorAll('[data-fulfillment]').forEach((button) => {
        button.addEventListener('click', () => {
          fulfillmentMethod = button.dataset.fulfillment;
          renderFulfillmentChoices();
        });
      });
    }

    /**
     * Shopee orders are settled in Shopee. The summary keeps the configuration together and hands
     * the buyer a prefilled chat, so no payment method is ever shown for this path.
     */
    function openShopeeModal(total) {
      const modal = $('#shopeeModal');
      const backdrop = $('#shopeeBackdrop');
      if (!modal) return;

      const summary = $('#shopeeSummary');
      if (summary) summary.textContent = describeSelection();
      const totalEl = $('#shopeeTotal');
      if (totalEl) totalEl.textContent = money(total);

      const link = $('#shopeeCsLink');
      if (link && whatsapp) {
        link.href = whatsapp.buildChatUrl(
          waNumber(),
          whatsapp.buildShopeeMessage({
            selection: describeSelection(),
            artist: artist.name,
            total: money(total),
            payment: 'Shopee',
          }),
        );
      }

      modal.hidden = false;
      if (backdrop) backdrop.hidden = false;
      modal.classList.add('open');
      if (backdrop) backdrop.classList.add('open');
      const closeButton = $('#shopeeModalClose');
      if (closeButton) closeButton.focus();
    }

    function closeShopeeModal() {
      const modal = $('#shopeeModal');
      const backdrop = $('#shopeeBackdrop');
      if (!modal || modal.hidden) return;
      modal.hidden = true;
      if (backdrop) backdrop.hidden = true;
      modal.classList.remove('open');
      if (backdrop) backdrop.classList.remove('open');
      const trigger = $('#continueToCheckout');
      if (trigger) trigger.focus();
    }

    if ($('#shopeeModalClose')) $('#shopeeModalClose').addEventListener('click', closeShopeeModal);
    if ($('#shopeeBackdrop')) $('#shopeeBackdrop').addEventListener('click', closeShopeeModal);
    if ($('#shopeeBackLink')) $('#shopeeBackLink').addEventListener('click', closeShopeeModal);
    document.addEventListener('keydown', (event) => {
      const modal = $('#shopeeModal');
      if (event.key === 'Escape' && modal && !modal.hidden) closeShopeeModal();
    });

    function renderPreview() {
      // The preview shows the product image itself, unclipped. Without one it falls back to the
      // member artwork, then the version cover, then the collection cover, then plain text.
      const versionSettings = activeGroup && activeVersion && activeGroup.versions
        ? activeGroup.versions[activeVersion] || null
        : null;
      const imageCandidates = [
        activeProduct && activeProduct.imageUrl,
        activeMember && activeMember.designImageUrl,
        versionSettings && versionSettings.coverImageUrl,
        activeGroup && activeGroup.heroImageUrl,
        activeGroup && activeGroup.imageUrl,
      ];
      const previewImageUrl = imageCandidates
        .map((candidate) => safeUpload(candidate))
        .find((candidate) => Boolean(candidate)) || '';
      const previewLabel = activeMember
        ? `${activeMember.name} keychain`
        : ((activeProduct && activeProduct.name) || (activeGroup && activeGroup.name) || 'LOCOXATL keychain');

      const previewImage = $('#previewProductImage');
      if (previewImage) {
        if (previewImageUrl) {
          previewImage.src = previewImageUrl;
          previewImage.alt = `${previewLabel} preview`;
          previewImage.hidden = false;
        } else {
          previewImage.removeAttribute('src');
          previewImage.hidden = true;
        }
      }
      const previewEmpty = $('#previewProductEmpty');
      if (previewEmpty) {
        previewEmpty.textContent = previewLabel;
        previewEmpty.hidden = Boolean(previewImageUrl);
      }
      lastPreview = { imageUrl: previewImageUrl, label: previewLabel };

      $('#previewCount').textContent = `${2 + state.addons.length + (state.initial ? 1 : 0)} PIECES`;
      const quote = pricing.quoteSelections({
        // The standard base is only a fallback: a bundle replaces it, never adds to it.
        basePrice: state.base.price,
        bundle: activeBundle
          ? {
            price: Number(activeBundle.price),
            freeAddonQuota: activeBundle.freeAddonQuota,
            allowedAddonKeys: activeBundle.allowedAddonKeys,
          }
          : null,
        categories: activeCategories,
        items: activeItems,
        selections: state.selections,
        personalization: { key: 'initial', active: Boolean(state.initial) },
        quantity: 1,
      });
      $('#builderPrice').textContent = money(quote.total);
      markFreeOptions(quote.lines);
      updateBundleNote(quote);
      // The latest quote is the only source for the checkout payload, so a bundle-covered option
      // is recorded at Rp 0 there exactly as it is shown here.
      lastQuote = quote;
      return quote.total;
    }

    function viewerState() {
      const addons = state.addons.map((item) => item.id);
      const initialToggle = $('#initialToggle');
      if (initialToggle && initialToggle.checked) addons.push('initial');
      return {
        base: state.base.id,
        clasp: state.clasp ? state.clasp.id : '',
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
      if (input.dataset.addon === 'initial') {
        $('#initialText').disabled = !input.checked;
        if (!input.checked) { state.initial = ''; $('#initialText').value = ''; }
      }
      state.hidden = state.hidden.filter((id) => id !== input.dataset.addon);
      syncSelections();
      update();
    }));

    // Category checkboxes rendered from the dashboard.
    document.addEventListener('change', (event) => {
      const input = event.target;
      if (!input || !input.dataset || !input.dataset.optionCategory) return;
      syncSelections();
      update();
    });

    $('#initialText').addEventListener('input', (event) => {
      state.initial = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 1);
      event.target.value = state.initial;
      update();
    });

    // One handler covers the bundled clasp buttons and every rendered single-choice category.
    document.addEventListener('click', (event) => {
      const button = event.target.closest ? event.target.closest('.clasp-choice') : null;
      if (!button || !button.parentElement) return;

      const slug = button.dataset.optionCategory;
      const category = slug ? activeCategories.find((row) => row && row.slug === slug) : null;
      // Clicking the active choice of an optional category clears it; a required one stays put.
      const clear = Boolean(category && !category.isRequired && button.classList.contains('selected'));

      [...button.parentElement.querySelectorAll('.clasp-choice')].forEach((choice) => {
        const isOn = !clear && choice === button;
        choice.classList.toggle('selected', isOn);
        if (choice.hasAttribute('aria-pressed')) {
          choice.setAttribute('aria-pressed', String(isOn));
        }
      });
      syncSelections();
      update();
    });

    $('#continueToCheckout').addEventListener('click', () => {
      if ($('#initialToggle').checked && !state.initial) {
        $('#initialText').focus();
        $('#initialText').setCustomValidity('Enter one letter for your initial.');
        $('#initialText').reportValidity();
        $('#initialText').addEventListener('input', () => $('#initialText').setCustomValidity(''), { once: true });
        return;
      }
      const total = renderPreview();
      // Shopee hands the buyer to CS instead of a payment page, so nothing is charged here.
      if (fulfillmentMethod === 'shopee_external') {
        openShopeeModal(total);
        return;
      }
      const viewer = window.LocoxatlStudio3D;
      const snapshot = viewer && typeof viewer.getSnapshot === 'function' ? viewer.getSnapshot() : null;
      // Bundle-covered add-ons are recorded at Rp 0, so the stored configuration never reads as
      // an extra charge on top of the bundle price.
      const freeKeys = new Set((lastQuote && Array.isArray(lastQuote.lines) ? lastQuote.lines : [])
        .filter((line) => line.free)
        .map((line) => line.key));
      const payloadAddons = state.addons.map((addon) => (freeKeys.has(addon.id)
        ? { ...addon, price: 0, free: true }
        : addon));
      const extraLabels = Object.entries(state.selections)
        .filter(([slug]) => !STATIC_CATEGORIES.includes(slug))
        .flatMap(([, keys]) => keys.map((key) => (itemByKey(key) ? itemByKey(key).label : '')).filter(Boolean));

      const pendingOrder = {
        artist: { slug: artist.slug, name: artist.name, fandom: artist.fandom },
        member: activeMember
          ? { slug: activeMember.slug, name: activeMember.name, designImageUrl: activeMember.designImageUrl || null }
          : null,
        baseModel: state.base.id,
        version: activeVersion || undefined,
        fulfillmentMethod,
        previewImage: lastPreview.imageUrl || undefined,
        previewLabel: lastPreview.label || undefined,
        selections: state.selections,
        extraLabels,
        bundle: activeBundle
          ? {
            id: activeBundle.id,
            slug: activeBundle.slug,
            name: activeBundle.name,
            price: Number(activeBundle.price),
            freeAddonQuota: Number(activeBundle.freeAddonQuota) || 0,
          }
          : null,
        configuration: {
          base: state.base,
          addons: payloadAddons,
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

    applyStaticStepVisibility();
    renderFulfillmentChoices();
    syncSelections();
    renderDynamicCategories();
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

      if (!ENABLE_3D_PREVIEW) {
        // data-viewer="off" leaves the stage at its resting opacity of 0, so the flat preview
        // and the summary stay visible without any layout change.
        viewerElements.stage.dataset.viewer = 'off';
        return;
      }

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

    if (viewerElements.stage && ENABLE_3D_PREVIEW) {
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
    } else if (viewerElements.stage) {
      // Flag off: say so instead of leaving the initial "loading" marker in place.
      viewerElements.stage.dataset.viewer = 'off';
    }

    window.addEventListener('pagehide', () => {
      if (window.LocoxatlStudio3D && typeof window.LocoxatlStudio3D.dispose === 'function') window.LocoxatlStudio3D.dispose();
    });
  }

  startStudio();
})();
