(() => {
  const catalog = window.LocoxatlCatalog;
  const grid = document.getElementById('artistGrid');
  if (!catalog || !grid) return;

  const tones = ['artist-card-dark', 'artist-card-light', 'artist-card-mid'];
  const safe = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const safeImage = (url) => (catalog.safeImageUrl ? catalog.safeImageUrl(url) : '');
  const safeFocal = (value) => (catalog.safeFocal ? catalog.safeFocal(value) : '50% 50%');

  function cardMarkup(artist, index) {
    const href = `artist.html?artist=${encodeURIComponent(artist.slug)}`;
    const image = safeImage(artist.imageUrl);
    const classes = ['artist-card', tones[index % tones.length], 'reveal', 'is-visible', image ? 'has-image' : ''].filter(Boolean).join(' ');
    // The cover image and its focal crop both come from the CMS, so the same photo can be framed
    // differently per collection without re-uploading it.
    const style = image
      ? ` style="background-image:url('${image}');background-position:${safeFocal(artist.coverFocal)}"`
      : '';
    return `
      <a class="${classes}" href="${href}"${style}>
        <span class="artist-card-index">${safe(artist.index)} / ${safe(artist.fandom)}</span>
        <strong>${safe(artist.name)}</strong>
        <span class="artist-card-bottom">${safe(String(artist.edition).toUpperCase())} <i>↗</i></span>
      </a>`;
  }

  function render(artists) {
    if (!artists.length) {
      grid.innerHTML = '<p class="empty-state">No collections are published right now. Please check back soon.</p>';
      return;
    }
    grid.innerHTML = artists.map(cardMarkup).join('');
  }

  // The bundled catalogue renders first, so the grid is never empty while /api/catalog loads.
  render(catalog.artists.map((artist, index) => catalog.artistFromGroup(artist, index)));

  const ready = window.locoxatlCatalog;
  if (!ready || typeof ready.then !== 'function') return;

  ready.then((payload) => {
    if (!payload || !Array.isArray(payload.groups)) return;
    // A database payload is authoritative even when it is empty: every collection is unpublished.
    if (payload.source === 'database' || payload.groups.length) {
      render(payload.groups.map((group, index) => catalog.artistFromGroup(group, index)));
    }
  }).catch(() => { /* keep the bundled catalogue */ });
})();
