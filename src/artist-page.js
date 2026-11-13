(() => {
  const catalog = window.LocoxatlCatalog;
  if (!catalog) return;

  const params = new URLSearchParams(window.location.search);
  const artist = catalog.getArtist(params.get('artist'));
  const title = document.getElementById('artistTitle');
  const grid = document.getElementById('artistProductGrid');
  if (!artist || !grid) {
    if (title) title.textContent = 'Collection not found';
    if (grid) grid.innerHTML = '<p class="empty-state">This artist collection is not available yet. <a href="shop.html">Browse all collections.</a></p>';
    return;
  }

  const safe = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  document.title = `${artist.name} Collection — LOCOXATL`;
  document.getElementById('breadcrumbArtist').textContent = artist.name;
  document.getElementById('artistFandom').textContent = `${artist.fandom} / ARTIST COLLECTION`;
  document.getElementById('artistTitle').innerHTML = `${safe(artist.name)}<br /><span>collection.</span>`;
  document.getElementById('artistDescription').textContent = artist.note;
  document.getElementById('artistEdition').textContent = artist.edition.toUpperCase();
  document.getElementById('artistMark').textContent = artist.name.toUpperCase();

  const artClasses = { heart: 'heart-art', star: 'star-art', bow: 'ribbon-art' };
  const artSymbols = { heart: '♡', star: '✳', bow: '∞' };
  grid.innerHTML = catalog.getProductsByArtist(artist.slug).map((product) => `
    <article class="product-card reveal is-visible">
      <div class="product-image"><span class="product-tag">${safe(product.tag)}</span><div class="mini-product-art ${artClasses[product.baseId] || ''}">${artSymbols[product.baseId] || '✧'}</div></div>
      <div class="product-meta"><div><h3>${safe(product.name)}</h3><p>${safe(product.category)} · ${safe(artist.name)}</p></div><strong>${new Intl.NumberFormat('id-ID').format(product.price).replace(/^/, 'Rp')}</strong></div>
      <p class="product-description">${safe(product.description)}</p>
      <a class="button button-dark product-customize" data-product="${safe(product.slug)}" href="studio.html?artist=${encodeURIComponent(artist.slug)}&product=${encodeURIComponent(product.slug)}">Customize <span>↗</span></a>
    </article>`).join('');
})();
