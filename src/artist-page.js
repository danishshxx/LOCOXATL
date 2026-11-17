(() => {
  const catalog = window.LocoxatlCatalog;
  if (!catalog) return;

  const params = new URLSearchParams(window.location.search);
  const slug = params.get('artist');
  const title = document.getElementById('artistTitle');
  const grid = document.getElementById('artistProductGrid');
  if (!grid) return;

  const safe = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  // Design images only ever come from the upload pipeline.
  const safeUpload = (url) => (/^\/assets\/uploads\/catalog\/[A-Za-z0-9._-]+$/.test(String(url || '')) ? String(url) : '');
  const money = (value) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value) || 0).replace('IDR', 'Rp').replace(/\s/g, '');
  const artClasses = { heart: 'heart-art', star: 'star-art', bow: 'ribbon-art' };
  const artSymbols = { heart: '♡', star: '✳', bow: '∞' };

  function renderUnavailable(message) {
    document.title = 'Collection unavailable — LOCOXATL';
    if (title) title.innerHTML = 'Collection<br /><span>not available.</span>';
    grid.innerHTML = `<p class="empty-state">${safe(message)} <a href="shop.html">Browse all collections.</a></p>`;
  }

  function productCard(product, artist) {
    const thumb = safeUpload(product.imageUrl);
    const artClass = artClasses[product.baseId] || '';
    const art = artSymbols[product.baseId] || '✧';
    return `
      <article class="product-card reveal is-visible">
        <div class="product-image${thumb ? ' has-image' : ''}"${thumb ? ` style="background-image:url('${thumb}')"` : ''}>
          <span class="product-tag">${safe(product.tag || 'DESIGN')}</span>
          ${thumb ? '' : `<div class="mini-product-art ${artClass}">${art}</div>`}
        </div>
        <div class="product-meta"><div><h3>${safe(product.name)}</h3><p>${safe(product.category || 'DESIGN')} · ${safe(artist.name)}</p></div><strong>${money(product.price)}</strong></div>
        <p class="product-description">${safe(product.description)}</p>
        <a class="button button-dark product-customize" data-product="${safe(product.slug)}" href="studio.html?artist=${encodeURIComponent(artist.slug)}&product=${encodeURIComponent(product.slug)}">Customize <span>↗</span></a>
      </article>`;
  }

  function renderArtist(artist, products) {
    document.title = `${artist.name} Collection — LOCOXATL`;
    document.getElementById('breadcrumbArtist').textContent = artist.name;
    document.getElementById('artistFandom').textContent = `${artist.fandom} / ARTIST COLLECTION`;
    document.getElementById('artistTitle').innerHTML = `${safe(artist.name)}<br /><span>collection.</span>`;
    document.getElementById('artistDescription').textContent = artist.note;
    document.getElementById('artistEdition').textContent = String(artist.edition).toUpperCase();
    document.getElementById('artistMark').textContent = String(artist.name).toUpperCase();

    if (!products.length) {
      grid.innerHTML = '<p class="empty-state">No designs are published for this collection yet. <a href="shop.html">Browse all collections.</a></p>';
      return;
    }
    grid.innerHTML = products.map((product) => productCard(product, artist)).join('');
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
      // Hidden designs are already filtered out by the API, so this list is storefront-safe.
      const groupProducts = Array.isArray(payload.products)
        ? payload.products.filter((product) => product.groupSlug === group.slug)
        : [];
      const products = groupProducts.length ? groupProducts : catalog.productsForGroup(group);
      renderArtist(catalog.artistFromGroup(group, index), products);
      return;
    }

    // When the database answered, it is authoritative: a collection missing from it has been
    // deactivated by the admin, so its products must stop being advertised.
    if (payload.source === 'database') {
      renderUnavailable('This collection is no longer available.');
    }
  }).catch(() => { /* keep the bundled catalogue */ });
})();
