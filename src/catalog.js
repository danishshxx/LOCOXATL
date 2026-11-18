(function (root, factory) {
  const catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  if (root) root.LocoxatlCatalog = catalog;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const artists = [
    { slug: 'blackpink', name: 'BLACKPINK', fandom: 'BLINK', note: 'Bold energy. Personal details.', edition: 'The Iconic Edit', count: 3, index: '01' },
    { slug: 'bts', name: 'BTS', fandom: 'ARMY', note: 'A little reminder of what moves you.', edition: 'The Signal Edit', count: 3, index: '02' },
    { slug: 'seventeen', name: 'SEVENTEEN', fandom: 'CARAT', note: 'Made of many little moments.', edition: 'The Together Edit', count: 3, index: '03' },
    { slug: 'newjeans', name: 'NewJeans', fandom: 'BUNNIES', note: 'Fresh shapes, everyday expression.', edition: 'The Fresh Edit', count: 3, index: '04' },
    { slug: 'nct', name: 'NCT', fandom: 'NCTzen', note: 'A signature combination, your way.', edition: 'The Neo Edit', count: 3, index: '05' },
    { slug: 'riize', name: 'RIIZE', fandom: 'BRIIZE', note: 'Small pieces for new memories.', edition: 'The Rise Edit', count: 3, index: '06' },
  ];

  const productTemplates = [
    { templateSlug: 'cloud-heart', templateKey: 'acrylic-keychain', name: 'Cloud Heart', category: 'BASE CHARM', description: 'A clean heart silhouette in glossy white acrylic.', price: 45000, baseId: 'heart', symbol: 'H', tag: 'BESTSELLER' },
    { templateSlug: 'orbit-star', templateKey: 'photocard-holder', name: 'Orbit Star', category: 'BASE CHARM', description: 'A star-shaped base with a polished finish.', price: 45000, baseId: 'star', symbol: 'S', tag: 'SIGNATURE' },
    { templateSlug: 'soft-ribbon', templateKey: 'phone-charm', name: 'Soft Ribbon', category: 'BASE CHARM', description: 'A soft ribbon silhouette made for your combination.', price: 49000, baseId: 'bow', symbol: 'R', tag: 'NEW' },
  ];

  // One shared keychain product. The server's product_settings/pricing_options override these
  // defaults; the bundled values match the current studio (heart silhouette, Rp45.000).
  const productDefaults = {
    baseModel: 'heart',
    baseLabel: 'Heart',
    basePrice: 45000,
    baseKey: 'keychain',
  };

  // template_key is what the admin dashboard stores in catalog_products and what the 3D studio
  // renders; baseId is the silhouette the customizer swaps between.
  const TEMPLATE_KEYS = productTemplates.map((template) => template.templateKey);

  function templateFor(templateKey) {
    const key = String(templateKey == null ? '' : templateKey).trim().toLowerCase();
    return productTemplates.find((template) => template.templateKey === key) || null;
  }

  function baseIdForTemplate(templateKey) {
    const template = templateFor(templateKey);
    return template ? template.baseId : null;
  }

  const products = artists.flatMap((artist) => productTemplates.map((template) => ({
    ...template,
    slug: `${artist.slug}-${template.templateSlug}`,
    artistSlug: artist.slug,
    artistName: artist.name,
  })));

  function getArtist(slug) {
    return artists.find((artist) => artist.slug === slug) || null;
  }

  function getProduct(slug) {
    return products.find((product) => product.slug === slug) || null;
  }

  function getProductsByArtist(artistSlug) {
    return products.filter((product) => product.artistSlug === artistSlug);
  }

  /**
   * Builds the three standard product records for any group slug, so groups managed in the
   * database produce exactly the same product shape as the static catalogue.
   */
  function productsForGroup(group) {
    const slug = String((group && group.slug) || '').trim();
    if (!slug) return [];
    const name = String((group && group.name) || slug).trim();
    return productTemplates.map((template) => ({
      ...template,
      slug: `${slug}-${template.templateSlug}`,
      artistSlug: slug,
      artistName: name,
    }));
  }

  /** Adapts a catalogue group (static artist or database row) to the artist-page shape. */
  function artistFromGroup(group, index = 0) {
    const slug = String((group && group.slug) || '').trim();
    const name = String((group && group.name) || slug).trim();
    const tagline = String((group && (group.tagline || group.fandom)) || '').trim();
    const description = String((group && (group.description || group.note)) || '').trim();
    const eyebrow = String((group && group.eyebrow) || '').trim();
    return {
      slug,
      name,
      fandom: tagline || name.toUpperCase(),
      note: description || 'Explore this collection and make it yours.',
      edition: String((group && group.edition) || tagline || 'The Collection'),
      count: productTemplates.length,
      index: String(index + 1).padStart(2, '0'),
      tagline,
      description,
      eyebrow,
      imageUrl: group && group.imageUrl ? String(group.imageUrl) : null,
      heroImageUrl: group && group.heroImageUrl ? String(group.heroImageUrl) : null,
      coverFocal: String((group && group.coverFocal) || '50% 50%'),
      heroFocal: String((group && group.heroFocal) || '50% 50%'),
      isActive: group && group.isActive === false ? false : true,
      sortOrder: Number.isInteger(group && group.sortOrder) ? group.sortOrder : index,
    };
  }

  /** Normalizes a member record from the public API into the shape the page renders. */
  function memberFromApi(member) {
    const name = String((member && member.name) || '').trim();
    return {
      id: member && member.id != null ? member.id : null,
      slug: String((member && member.slug) || '').trim(),
      name,
      groupId: member && member.groupId != null ? member.groupId : null,
      groupSlug: String((member && (member.groupSlug || member.group_slug)) || '').trim(),
      portraitUrl: member && member.portraitUrl ? String(member.portraitUrl) : null,
      designImageUrl: member && member.designImageUrl ? String(member.designImageUrl) : null,
      versionKey: String((member && member.versionKey) || 'yellow').toLowerCase(),
      isActive: member && member.isActive === false ? false : true,
      sortOrder: Number.isInteger(member && member.sortOrder) ? member.sortOrder : 0,
    };
  }

  // Images only ever come from the two storage backends the server writes to: the local upload
  // directory and Cloudinary delivery URLs. Anything else is dropped instead of being rendered.
  const UPLOAD_PATH = /^\/assets\/uploads\/catalog\/[A-Za-z0-9._-]+$/;
  const CLOUDINARY_PATH = /^https:\/\/res\.cloudinary\.com\/[a-z0-9-]+\/image\/upload\/[A-Za-z0-9._~\-/]+$/;

  function safeImageUrl(url) {
    const value = String(url == null ? '' : url);
    return UPLOAD_PATH.test(value) || CLOUDINARY_PATH.test(value) ? value : '';
  }

  // background-position for a stored focal crop, or the neutral centre when unset/invalid.
  const FOCAL = /^(?:center|(?:100|[1-9]?\d)% (?:100|[1-9]?\d)%)$/;

  function safeFocal(value) {
    const text = String(value == null ? '' : value).trim().toLowerCase();
    return FOCAL.test(text) ? text : '50% 50%';
  }

  return {
    artists,
    products,
    productTemplates,
    productDefaults,
    TEMPLATE_KEYS,
    templateFor,
    baseIdForTemplate,
    getArtist,
    getProduct,
    getProductsByArtist,
    productsForGroup,
    artistFromGroup,
    memberFromApi,
    safeImageUrl,
    safeFocal,
  };
});
