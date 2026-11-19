(() => {
  const catalog = window.LocoxatlCatalog;
  if (!catalog) return;

  const params = new URLSearchParams(window.location.search);
  const slug = params.get('artist');
  const title = document.getElementById('artistTitle');
  const memberSection = document.getElementById('artistMembersSection');
  const memberGrid = document.getElementById('artistMemberGrid');
  const hero = document.querySelector('.artist-hero');
  const versionSection = document.getElementById('artistVersionSection');
  const versionGrid = document.getElementById('artistVersionGrid');
  const versionSwitch = document.getElementById('artistVersionSwitch');

  // Step one of the collection flow: pick Yellow or Pink before seeing any member.
  const VERSIONS = [
    { key: 'yellow', label: 'Yellow Version' },
    { key: 'pink', label: 'Pink Version' },
  ];
  const requestedVersion = VERSIONS.some((version) => version.key === (params.get('version') || '').toLowerCase())
    ? (params.get('version') || '').toLowerCase()
    : null;

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

  /**
   * A member is the customer's design choice. Every card therefore shows the same shared
   * keychain model with that member's artwork on the charm face — never the portrait. The
   * portrait stays available inside the admin dashboard only.
   */
  function memberCard(artist, member) {
    const product = catalog.keychainArtworkMarkup({
      artworkUrl: safeImage(member.designImageUrl),
      name: member.name,
    });
    const href = `studio.html?artist=${encodeURIComponent(artist.slug)}&amp;member=${encodeURIComponent(member.slug)}${requestedVersion ? `&amp;version=${requestedVersion}` : ''}`;
    return `
      <a class="member-card member-card-link reveal is-visible" href="${href}" data-member="${safe(member.slug)}">
        <span class="member-card-product">${product}</span>
        <span class="member-card-name">${safe(member.name)}</span>
      </a>`;
  }

  /** Shown when a group has no members configured (or while offline): one shared keychain. */
  function genericCard(artist) {
    const href = `studio.html?artist=${encodeURIComponent(artist.slug)}`;
    const product = catalog.keychainArtworkMarkup({ name: 'LOCOXATL', monogram: 'LX' });
    return `
      <a class="member-card member-card-link reveal is-visible" href="${href}">
        <span class="member-card-product">${product}</span>
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

  /**
   * Step one. These cards use the same markup, size, classes and hover behaviour as the
   * collection cards on shop.html, so the two pages read as one system.
   */
  function versionCards(artist, group) {
    const versions = (group && group.versions) || {};

    return VERSIONS.map((version, index) => {
      const settings = versions[version.key] || {};
      const image = safeImage(settings.coverImageUrl) || safeImage(artist.imageUrl);
      const focal = safeFocal(settings.coverFocal || artist.coverFocal);
      const title = settings.title || version.label.replace(' Version', '');
      const tagline = settings.tagline || version.label;
      const classes = [
        'artist-card',
        index === 0 ? 'artist-card-dark' : 'artist-card-light',
        'reveal',
        'is-visible',
        image ? 'has-image' : '',
      ].filter(Boolean).join(' ');
      const style = image
        ? ` style="background-image:url('${image}');background-position:${focal}"`
        : '';
      const href = `artist.html?artist=${encodeURIComponent(artist.slug)}&amp;version=${version.key}`;

      return `
      <a class="${classes}" href="${href}"${style} data-version="${version.key}">
        <span class="artist-card-index">${String(index + 1).padStart(2, '0')} / ${safe(version.label.toUpperCase())}</span>
        <strong>${safe(title)}</strong>
        <span class="artist-card-bottom">${safe(String(tagline).toUpperCase())} <i>↗</i></span>
      </a>`;
    }).join('');
  }

  function renderArtist(artist, members = [], group = null) {
    document.title = `${artist.name} Collection — LOCOXATL`;
    document.getElementById('breadcrumbArtist').textContent = artist.name;
    document.getElementById('artistTitle').innerHTML = `${safe(artist.name)}<br /><span>collection.</span>`;
    document.getElementById('artistDescription').textContent = artist.note;
    document.getElementById('artistEdition').textContent = String(artist.edition).toUpperCase();
    document.getElementById('artistMark').textContent = String(artist.name).toUpperCase();
    applyHero(artist);

    // A group with the Yellow/Pink picker switched off has one flat set of designs.
    const versionsEnabled = !group || group.hasVersions !== false;

    if (!versionsEnabled) {
      if (versionSection) versionSection.hidden = true;
      if (versionSwitch) versionSwitch.innerHTML = '';
      renderMembers(artist, members);
      return;
    }

    if (!requestedVersion) {
      // Step one: no members yet, only the two version cards.
      if (memberSection) memberSection.hidden = true;
      if (versionSection && versionGrid) {
        versionSection.hidden = false;
        versionGrid.innerHTML = versionCards(artist, group);
      }
      return;
    }

    if (versionSection) versionSection.hidden = true;
    if (versionSwitch) {
      versionSwitch.innerHTML = `<a class="text-link" href="artist.html?artist=${encodeURIComponent(artist.slug)}">Switch version</a>`;
    }
    renderMembers(artist, members.filter((member) => !member.versionKey || member.versionKey === requestedVersion));
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
    renderArtist(catalog.artistFromGroup(staticArtist, 0), [], staticArtist);
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
      renderArtist(catalog.artistFromGroup(group, index), members, group);
      return;
    }

    // When the database answered, it is authoritative: a collection missing from it has been
    // deactivated by the admin, so it must stop being advertised.
    if (payload.source === 'database') {
      renderUnavailable('This collection is no longer available.');
    }
  }).catch(() => { /* keep the bundled catalogue */ });
})();
