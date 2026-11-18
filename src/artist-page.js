(() => {
  const catalog = window.LocoxatlCatalog;
  if (!catalog) return;

  const params = new URLSearchParams(window.location.search);
  const slug = params.get('artist');
  const title = document.getElementById('artistTitle');
  const memberSection = document.getElementById('artistMembersSection');
  const memberGrid = document.getElementById('artistMemberGrid');
  const hero = document.querySelector('.artist-hero');

  const safe = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const safeImage = (url) => (catalog.safeImageUrl ? catalog.safeImageUrl(url) : '');
  const safeFocal = (value) => (catalog.safeFocal ? catalog.safeFocal(value) : '50% 50%');

  function renderUnavailable(message) {
    document.title = 'Collection unavailable — LOCOXATL';
    if (title) title.innerHTML = 'Collection<br /><span>not available.</span>';
    if (memberGrid) {
      memberGrid.innerHTML = `<p class="empty-state">${safe(message)} <a href="shop.html">Browse all collections.</a></p>`;
    }
    if (memberSection) memberSection.hidden = false;
  }

  function initials(name) {
    return String(name || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('') || '?';
  }

  /**
   * A member is the customer's design choice. The card carries the member's keychain artwork
   * (falling back to the portrait, then initials) and links to the studio with the member slug.
   */
  function memberCard(artist, member) {
    const artwork = safeImage(member.designImageUrl) || safeImage(member.portraitUrl);
    const media = artwork
      ? `<span class="member-card-portrait has-image" style="background-image:url('${artwork}')" role="img" aria-label="${safe(member.name)} keychain artwork"></span>`
      : `<span class="member-card-portrait is-empty" aria-hidden="true">${safe(initials(member.name))}</span>`;
    const href = `studio.html?artist=${encodeURIComponent(artist.slug)}&amp;member=${encodeURIComponent(member.slug)}`;
    return `
      <a class="member-card member-card-link reveal is-visible" href="${href}" data-member="${safe(member.slug)}">
        ${media}
        <span class="member-card-name">${safe(member.name)}</span>
      </a>`;
  }

  /** Shown when a group has no members configured (or while offline): one shared keychain. */
  function genericCard(artist) {
    const href = `studio.html?artist=${encodeURIComponent(artist.slug)}`;
    return `
      <a class="member-card member-card-link reveal is-visible" href="${href}">
        <span class="member-card-portrait is-empty" aria-hidden="true">◇</span>
        <span class="member-card-name">Customize this keychain</span>
      </a>`;
  }

  function renderMembers(artist, members) {
    if (!memberSection || !memberGrid) return;
    memberSection.hidden = false;
    memberGrid.innerHTML = members.length
      ? members.map((member) => memberCard(artist, member)).join('')
      : genericCard(artist);
  }

  function applyHero(artist) {
    const heroImage = safeImage(artist.heroImageUrl) || safeImage(artist.imageUrl);
    if (hero && heroImage) {
      hero.classList.add('has-hero-image');
      hero.style.setProperty('--artist-hero-image', `url('${heroImage}')`);
      hero.style.setProperty('--artist-hero-focal', safeFocal(artist.heroFocal));
    }
    const fandomEl = document.getElementById('artistFandom');
    if (fandomEl) {
      const eyebrow = artist.eyebrow || `${artist.fandom} / ARTIST COLLECTION`;
      fandomEl.textContent = eyebrow;
    }
  }

  function renderArtist(artist, members = []) {
    document.title = `${artist.name} Collection — LOCOXATL`;
    document.getElementById('breadcrumbArtist').textContent = artist.name;
    document.getElementById('artistTitle').innerHTML = `${safe(artist.name)}<br /><span>collection.</span>`;
    document.getElementById('artistDescription').textContent = artist.note;
    document.getElementById('artistEdition').textContent = String(artist.edition).toUpperCase();
    document.getElementById('artistMark').textContent = String(artist.name).toUpperCase();
    applyHero(artist);
    renderMembers(artist, members);
  }

  // An eyebrow without an API payload still needs its default label.
  const initialFandom = document.getElementById('artistFandom');
  if (initialFandom && !initialFandom.textContent.trim()) {
    initialFandom.textContent = 'ARTIST COLLECTION';
  }

  // Bundled catalogue first, so the page is complete before the network answers. It has no
  // members, so the generic shared-keychain card links straight into the studio.
  const staticArtist = catalog.getArtist(slug);
  if (staticArtist) {
    renderArtist(catalog.artistFromGroup(staticArtist, 0), []);
  } else if (slug) {
    renderUnavailable('This artist collection is not available yet.');
  }

  const ready = window.locoxatlCatalog;
  if (!ready || typeof ready.then !== 'function') return;

  ready.then((payload) => {
    if (!payload || !Array.isArray(payload.groups)) return;

    const index = payload.groups.findIndex((group) => group.slug === slug);
    if (index >= 0) {
      const group = payload.groups[index];
      const members = Array.isArray(payload.members)
        ? payload.members
          .filter((member) => member.groupSlug === group.slug && member.isActive !== false)
          .map((member) => catalog.memberFromApi(member))
        : [];
      renderArtist(catalog.artistFromGroup(group, index), members);
      return;
    }

    // When the database answered, it is authoritative: a collection missing from it has been
    // deactivated by the admin, so it must stop being advertised.
    if (payload.source === 'database') {
      renderUnavailable('This collection is no longer available.');
    }
  }).catch(() => { /* keep the bundled catalogue */ });
})();
