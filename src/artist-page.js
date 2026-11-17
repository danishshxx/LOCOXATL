(() => {
  const catalog = window.LocoxatlCatalog;
  if (!catalog) return;

  const params = new URLSearchParams(window.location.search);
  const slug = params.get('artist');
  const title = document.getElementById('artistTitle');
  const grid = document.getElementById('artistProductGrid');
  if (!grid) return;

  const safe = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const artClasses = { heart: 'heart-art', star: 'star-art', bow: 'ribbon-art' };
  const artSymbols = { heart: '♡', star: '✳', bow: '∞' };

  function renderUnavailable(message) {
    document.title = 'Collection unavailable — LOCOXATL';
    if (title) title.innerHTML = 'Collection<br /><span>not available.</span>';
    grid.innerHTML = `<p class="empty-state">${safe(message)} <a href="shop.html">Browse all collections.</a></p>`;
  }

  function renderArtist(artist, products) {
    document.title = `${artist.name} Collection — LOCOXATL`;
    document.getElementById('breadcrumbArtist').textContent = artist.name;
    document.getElementById('artistFandom').textContent = `${artist.fandom} / ARTIST COLLECTION`;
    document.getElementById('artistTitle').innerHTML = `${safe(artist.name)}<br /><span>collection.</span>`;
    document.getElementById('artistDescription').textContent = artist.note;
    document.getElementById('artistEdition').textContent = String(artist.edition).toUpperCase();
    document.getElementById('artistMark').textContent = String(artist.name).toUpperCase();

    grid.innerHTML = products.map((product) => `
      <article class="product-card reveal is-visible">
        <div class="product-image"><span class="product-tag">${safe(product.tag)}</span><div class="mini-product-art ${artClasses[product.baseId] || ''}">${artSymbols[product.baseId] || '✧'}</div></div>
        <div class="product-meta"><div><h3>${safe(product.name)}</h3><p>${safe(product.category)} · ${safe(artist.name)}</p></div><strong>${new Intl.NumberFormat('id-ID').format(product.price).replace(/^/, 'Rp')}</strong></div>
        <p class="product-description">${safe(product.description)}</p>
        <a class="button button-dark product-customize" data-product="${safe(product.slug)}" href="studio.html?artist=${encodeURIComponent(artist.slug)}&product=${encodeURIComponent(product.slug)}">Customize <span>↗</span></a>
      </article>`).join('');
  }

  // Bundled catalogue first, so the page is complete before the network answers.
  const staticArtist = catalog.getArtist(slug);
  if (staticArtist) {
    renderArtist(staticArtist, catalog.getProductsByArtist(staticArtist.slug));
  } else {
    renderUnavailable('This artist collection is not available yet.');
  }

  const ready = window.locoxatlCatalog;
  if (!ready || typeof ready.then !== 'function') return;

  ready.then((payload) => {
    if (!payload || !Array.isArray(payload.groups)) return;

    const index = payload.groups.findIndex((group) => group.slug === slug);
    if (index >= 0) {
      const group = payload.groups[index];
      renderArtist(catalog.artistFromGroup(group, index), catalog.productsForGroup(group));
      return;
    }

    // When the database answered, it is authoritative: a collection missing from it has been
    // deactivated by the admin, so its products must stop being advertised.
    if (payload.source === 'database') {
      renderUnavailable('This collection is no longer available.');
    }
  }).catch(() => { /* keep the bundled catalogue */ });
})();
