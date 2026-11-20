const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Storefront rendering: the shop and artist pages must build their groups, hero images and member
// cards from the catalogue payload, and must degrade gracefully when nothing is published.

const root = path.join(__dirname, '..');
const catalogSource = fs.readFileSync(path.join(root, 'src', 'catalog.js'), 'utf8');
const shopSource = fs.readFileSync(path.join(root, 'src', 'shop-page.js'), 'utf8');
const artistSource = fs.readFileSync(path.join(root, 'src', 'artist-page.js'), 'utf8');

function runCatalog() {
  const module = { exports: {} };
  vm.runInNewContext(catalogSource, { module, exports: module.exports });
  return module.exports;
}

const catalog = runCatalog();

function element(overrides = {}) {
  return {
    textContent: '',
    innerHTML: '',
    hidden: false,
    value: '',
    className: '',
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    ...overrides,
  };
}

function runPage(source, { elements, payload, search }) {
  const context = {
    window: {
      LocoxatlCatalog: catalog,
      locoxatlCatalog: Promise.resolve(payload),
      location: { search },
    },
    document: {
      title: '',
      getElementById: (id) => elements[id] || null,
      querySelector: (selector) => elements[selector] || null,
      querySelectorAll: () => [],
    },
    URLSearchParams,
    Intl,
    console,
  };
  vm.runInNewContext(source, context);
  return context;
}

// ---------------------------------------------------------------------------
// Shop page
// ---------------------------------------------------------------------------
test('the shop page renders each active group as a card with its cover image and focal crop', async () => {
  const grid = element();
  const payload = {
    source: 'database',
    groups: [
      {
        slug: 'blackpink', name: 'BLACKPINK', tagline: 'BLINK', eyebrow: 'BLINK / ARTIST COLLECTION',
        imageUrl: '/assets/uploads/catalog/blackpink-0123456789ab.webp',
        coverFocal: '50% 20%', isActive: true, sortOrder: 0,
      },
      {
        slug: 'bts', name: 'BTS', tagline: 'ARMY',
        imageUrl: null, coverFocal: '50% 50%', isActive: true, sortOrder: 1,
      },
    ],
    members: [],
    products: [],
  };

  runPage(shopSource, { elements: { artistGrid: grid }, payload, search: '' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(grid.innerHTML, /href="artist\.html\?artist=blackpink"/);
  assert.match(grid.innerHTML, /BLACKPINK/);
  assert.match(grid.innerHTML, /background-image:url\('\/assets\/uploads\/catalog\/blackpink-0123456789ab\.webp'\)/);
  assert.match(grid.innerHTML, /background-position:50% 20%/, 'the cover focal crop is applied');
  assert.match(grid.innerHTML, /href="artist\.html\?artist=bts"/);
  assert.equal((grid.innerHTML.match(/class="artist-card /g) || []).length, 2);
  // A group without a cover keeps the monochrome card, no broken background.
  assert.match(grid.innerHTML, /artist-card artist-card-light reveal is-visible"/);
});

test('the shop page ignores unsafe image URLs and falls back to the bundled catalogue', async () => {
  const grid = element();
  const payload = {
    source: 'database',
    groups: [{ slug: 'x', name: 'X Group', imageUrl: 'javascript:alert(1)', coverFocal: '50% 50%' }],
    members: [],
    products: [],
  };

  runPage(shopSource, { elements: { artistGrid: grid }, payload, search: '' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.doesNotMatch(grid.innerHTML, /javascript:alert/);
  assert.doesNotMatch(grid.innerHTML, /background-image/, 'an unmanaged URL is dropped');
});

test('an empty published catalogue shows the empty state instead of stale cards', async () => {
  const grid = element();
  runPage(shopSource, { elements: { artistGrid: grid }, payload: { source: 'database', groups: [], members: [], products: [] }, search: '' });
  await new Promise((resolve) => setImmediate(resolve));

  // The database answered with nothing published, so the bundled cards must not survive.
  assert.doesNotMatch(grid.innerHTML, /artist-card/);
  assert.match(grid.innerHTML, /No collections are published/);
});

// ---------------------------------------------------------------------------
// Artist page
// ---------------------------------------------------------------------------
function artistElements() {
  return {
    artistTitle: element(),
    artistProductGrid: element(),
    artistMembersSection: element({ hidden: true }),
    artistMemberGrid: element(),
    breadcrumbArtist: element(),
    artistFandom: element(),
    artistDescription: element(),
    artistEdition: element(),
    artistMark: element(),
    '.artist-hero': element(),
  };
}

test('the artist page renders member cards and the configurable hero', async () => {
  const elements = artistElements();
  const heroClasses = [];
  elements['.artist-hero'].classList.add = (name) => heroClasses.push(name);
  const properties = {};
  elements['.artist-hero'].style.setProperty = (name, value) => { properties[name] = value; };

  const payload = {
    source: 'database',
    groups: [{
      slug: 'blackpink', name: 'BLACKPINK', tagline: 'BLINK', eyebrow: 'BLINK / THE ICONIC EDIT',
      description: 'Bold energy.', imageUrl: '/assets/uploads/catalog/blackpink-aaaaaaaaaaaa.webp',
      heroImageUrl: '/assets/uploads/catalog/blackpink-hero-bbbbbbbbbbbb.webp',
      coverFocal: '50% 50%', heroFocal: '80% 20%', isActive: true, sortOrder: 0,
    }],
    members: [
      { id: 1, groupSlug: 'blackpink', slug: 'jisoo', name: 'Jisoo', portraitUrl: '/assets/uploads/catalog/member-jisoo-cccccccccccc.webp', designImageUrl: '/assets/uploads/catalog/member-design-jisoo-dddddddddddd.webp', isActive: true, sortOrder: 0 },
      { id: 2, groupSlug: 'blackpink', slug: 'rosé', name: 'Rosé', portraitUrl: null, designImageUrl: null, isActive: true, sortOrder: 1 },
      { id: 3, groupSlug: 'bts', slug: 'rm', name: 'RM', portraitUrl: null, isActive: true, sortOrder: 0 },
      { id: 4, groupSlug: 'blackpink', slug: 'hidden', name: 'Hidden', portraitUrl: null, isActive: false, sortOrder: 2 },
    ],
    products: [],
  };

  runPage(artistSource, { elements, payload, search: '?artist=blackpink&version=yellow' });
  await new Promise((resolve) => setImmediate(resolve));

  // Hero image + focal crop from the CMS.
  assert.ok(heroClasses.includes('has-hero-image'), 'the hero image class is applied');
  assert.match(properties['--artist-hero-image'], /blackpink-hero-bbbbbbbbbbbb\.webp/);
  assert.equal(properties['--artist-hero-focal'], '80% 20%');

  // Eyebrow override, not the default.
  assert.equal(elements.artistFandom.textContent, 'BLINK / THE ICONIC EDIT');
  assert.match(elements.artistTitle.innerHTML, /BLACKPINK/);

  // Members: only this group's, only visible, in order.
  assert.equal(elements.artistMembersSection.hidden, false);
  assert.match(elements.artistMemberGrid.innerHTML, /member-card/);
  assert.match(elements.artistMemberGrid.innerHTML, /Jisoo/);
  assert.match(elements.artistMemberGrid.innerHTML, /Rosé/);
  assert.doesNotMatch(elements.artistMemberGrid.innerHTML, /RM/);
  assert.doesNotMatch(elements.artistMemberGrid.innerHTML, /Hidden/);
  assert.ok(
    elements.artistMemberGrid.innerHTML.indexOf('Jisoo') < elements.artistMemberGrid.innerHTML.indexOf('Rosé'),
    'members keep their display order',
  );
  // Every card shows the member's uploaded artwork directly, with no silhouette frame.
  assert.match(elements.artistMemberGrid.innerHTML, /member-design-jisoo-dddddddddddd\.webp/);
  assert.match(elements.artistMemberGrid.innerHTML, /class="member-card-image"/);
  assert.doesNotMatch(elements.artistMemberGrid.innerHTML, /<svg/, 'the heart SVG frame and split ring are gone');
  assert.doesNotMatch(
    elements.artistMemberGrid.innerHTML,
    /member-jisoo-cccccccccccc\.webp/,
    'the portrait must never be the storefront card image',
  );
  assert.doesNotMatch(elements.artistMemberGrid.innerHTML, /background-image:url/, 'artwork is contained, not a cropped background');
  assert.match(elements.artistMemberGrid.innerHTML, /member-card-image-empty[^>]*>LX</, 'a member without artwork gets the shared placeholder');
  assert.match(elements.artistMemberGrid.innerHTML, /member-card-name">Rosé</, 'the name stays visible under the product');

  // Member cards link to the studio with the member slug — there is no product choice.
  assert.match(elements.artistMemberGrid.innerHTML, /studio\.html\?artist=blackpink&amp;member=jisoo/);
  assert.doesNotMatch(elements.artistMemberGrid.innerHTML, /product=/);
});

test('the artist page shows a generic shared-keychain card when the group has no members', async () => {
  const elements = artistElements();
  const payload = {
    source: 'database',
    groups: [{ slug: 'newjeans', name: 'NewJeans', tagline: 'BUNNIES', eyebrow: '', description: 'Fresh.', isActive: true, sortOrder: 0 }],
    members: [],
    products: [],
  };

  runPage(artistSource, { elements, payload, search: '?artist=newjeans&version=yellow' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.artistMembersSection.hidden, false, 'the shared keychain is still offered');
  assert.match(elements.artistMemberGrid.innerHTML, /Customize this keychain/);
  assert.match(elements.artistMemberGrid.innerHTML, /studio\.html\?artist=newjeans/);
  // With no eyebrow set, the default label is used.
  assert.equal(elements.artistFandom.textContent, 'BUNNIES / ARTIST COLLECTION');
});

test('the artist page reports a deactivated collection instead of showing members', async () => {
  const elements = artistElements();
  const payload = { source: 'database', groups: [{ slug: 'bts', name: 'BTS', isActive: true, sortOrder: 0 }], members: [], products: [] };

  runPage(artistSource, { elements, payload, search: '?artist=seventeen&version=yellow' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(elements.artistMemberGrid.innerHTML, /no longer available/i);
  assert.equal(elements.artistMembersSection.hidden, false);
});

test('the artist page keeps the bundled catalogue when the API request fails', async () => {
  const elements = artistElements();
  const context = {
    window: {
      LocoxatlCatalog: catalog,
      locoxatlCatalog: Promise.reject(new Error('offline')),
      location: { search: '?artist=blackpink&version=yellow' },
    },
    document: {
      title: '',
      getElementById: (id) => elements[id] || null,
      querySelector: (selector) => elements[selector] || null,
      querySelectorAll: () => [],
    },
    URLSearchParams,
    Intl,
    console,
  };
  vm.runInNewContext(artistSource, context);
  await new Promise((resolve) => setImmediate(resolve));

  // The bundled catalogue painted first and the failed request must not erase it.
  assert.match(elements.artistMemberGrid.innerHTML, /Customize this keychain/);
  assert.match(elements.artistTitle.innerHTML, /BLACKPINK/);
});

test('a member payload with an unsafe portrait never reaches the markup', async () => {
  const elements = artistElements();
  const payload = {
    source: 'database',
    groups: [{ slug: 'blackpink', name: 'BLACKPINK', isActive: true, sortOrder: 0 }],
    members: [{
      id: 1, groupSlug: 'blackpink', slug: 'jisoo', name: 'Jisoo',
      portraitUrl: 'javascript:alert(1)', isActive: true, sortOrder: 0,
    }],
    products: [],
  };

  runPage(artistSource, { elements, payload, search: '?artist=blackpink&version=yellow' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.doesNotMatch(elements.artistMemberGrid.innerHTML, /javascript:alert/);
  assert.match(elements.artistMemberGrid.innerHTML, /member-card-image-empty/, 'it falls back to the placeholder card');
});

test('the shared keychain mockup contains artwork on the charm without stretching it', () => {
  const markup = catalog.keychainArtworkMarkup({
    artworkUrl: '/assets/uploads/catalog/member-design-jisoo-1234abcd.webp',
    name: 'Jisoo',
  });

  assert.match(markup, /class="keychain-art"/);
  assert.match(markup, /<image href="\/assets\/uploads\/catalog\/member-design-jisoo-1234abcd\.webp"/);
  assert.match(markup, /preserveAspectRatio="xMidYMid meet"/, 'artwork keeps its aspect ratio');
  assert.match(markup, /clip-path="url\(#lx-charm-clip-\d+\)"/, 'artwork is clipped to the charm face');
  assert.doesNotMatch(markup, /background-image|background-size/, 'artwork is never an oversized background');

  const unsafe = catalog.keychainArtworkMarkup({ artworkUrl: 'javascript:alert(1)', name: 'X' });
  assert.doesNotMatch(unsafe, /javascript:/);
  assert.match(unsafe, /keychain-monogram/, 'an unusable URL falls back to the shared placeholder');
});

test('names and descriptions are HTML-escaped in both pages', async () => {
  const elements = artistElements();
  const payload = {
    source: 'database',
    groups: [{ slug: 'evil', name: '<img src=x onerror=alert(1)>', tagline: '"><script>', description: '<b>bold</b>', isActive: true, sortOrder: 0 }],
    members: [{ id: 1, groupSlug: 'evil', slug: 'x', name: '<script>x</script>', isActive: true, sortOrder: 0 }],
    products: [],
  };

  runPage(artistSource, { elements, payload, search: '?artist=evil&version=yellow' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.doesNotMatch(elements.artistTitle.innerHTML, /<img src=x/);
  assert.doesNotMatch(elements.artistMemberGrid.innerHTML, /<script>/);
  assert.match(elements.artistMemberGrid.innerHTML, /&lt;script&gt;/);
  assert.equal(elements.artistDescription.textContent, '<b>bold</b>', 'textContent is inherently safe');
});
