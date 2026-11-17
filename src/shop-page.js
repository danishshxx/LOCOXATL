(() => {
  const catalog = window.LocoxatlCatalog;
  const grid = document.getElementById('artistGrid');
  if (!catalog || !grid) return;

  const tones = ['artist-card-dark', 'artist-card-light', 'artist-card-mid'];
  const safe = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  // Only paths produced by the upload endpoint are ever used as a CSS background.
  const safeImage = (url) => (/^\/assets\/uploads\/catalog\/[A-Za-z0-9._-]+$/.test(String(url || '')) ? String(url) : '');

  function render(artists) {
    if (!artists.length) {
      grid.innerHTML = '<p class="empty-state">No collections are published right now. Please check back soon.</p>';
      return;
    }

    grid.innerHTML = artists.map((artist, index) => {
      const href = `artist.html?artist=${encodeURIComponent(artist.slug)}`;
      const image = safeImage(artist.imageUrl);
      const classes = ['artist-card', tones[index % tones.length], 'reveal', 'is-visible', image ? 'has-image' : ''].filter(Boolean).join(' ');
      const style = image ? ` style="background-image:url('${image}')"` : '';
      return `
        <a class="${classes}" href="${href}"${style}>
          <span class="artist-card-index">${safe(artist.index)} / ${safe(artist.fandom)}</span>
          <strong>${safe(artist.name)}</strong>
          <span class="artist-card-bottom">${safe(String(artist.edition).toUpperCase())} <i>↗</i></span>
        </a>`;
    }).join('');
  }

  // The bundled catalogue renders first, so the grid is never empty while /api/catalog loads.
  render(catalog.artists);

  const ready = window.locoxatlCatalog;
  if (!ready || typeof ready.then !== 'function') return;

  ready.then((payload) => {
    if (!payload || !Array.isArray(payload.groups) || !payload.groups.length) return;
    render(payload.groups.map((group, index) => catalog.artistFromGroup(group, index)));
  }).catch(() => { /* keep the bundled catalogue */ });
})();
