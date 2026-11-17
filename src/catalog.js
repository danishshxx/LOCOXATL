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
      imageUrl: group && group.imageUrl ? String(group.imageUrl) : null,
      isActive: group && group.isActive === false ? false : true,
      sortOrder: Number.isInteger(group && group.sortOrder) ? group.sortOrder : index,
    };
  }

  return {
    artists,
    products,
    productTemplates,
    TEMPLATE_KEYS,
    templateFor,
    baseIdForTemplate,
    getArtist,
    getProduct,
    getProductsByArtist,
    productsForGroup,
    artistFromGroup,
  };
});
