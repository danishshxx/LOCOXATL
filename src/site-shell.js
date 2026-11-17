(() => {
  const headerTarget = document.querySelector('[data-site-header]');
  const footerTarget = document.querySelector('[data-site-footer]');

  if (headerTarget) {
    headerTarget.innerHTML = `
      <header class="site-header" id="top">
        <a class="brand" href="index.html" aria-label="LOCOXATL homepage"><img src="assets/brand/locoxatl-wordmark-black.png" alt="LOCOXATL" /></a>
        <nav class="desktop-nav" aria-label="Main navigation">
          <a href="index.html#our-story">Our story</a>
          <a href="shop.html">Collections</a>
          <a href="shop.html" class="nav-shop-link">Buy Now</a>
        </nav>
        <button class="icon-button mobile-menu-button" id="mobileMenuButton" aria-label="Open menu" aria-expanded="false"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
        <nav class="mobile-nav" id="mobileNav" hidden aria-label="Mobile navigation"><a href="index.html">Home</a><a href="index.html#our-story">Our story</a><a href="shop.html">Collections</a><a href="shop.html">Buy Now</a></nav>
      </header>`;
  }

  if (footerTarget) {
    footerTarget.innerHTML = `
      <footer class="site-footer">
        <a class="brand brand-footer" href="index.html" aria-label="LOCOXATL homepage"><img src="assets/brand/locoxatl-wordmark-black.png" alt="LOCOXATL" /></a>
        <p>Personal objects, made by you.</p>
        <nav class="footer-links" aria-label="Footer navigation"><a href="index.html#our-story">Our story</a><a href="shop.html">Collections</a><a href="shop.html">Buy Now</a></nav>
        <nav class="footer-collections" id="footerCollections" aria-label="Shop by collection" hidden></nav>
        <div class="footer-contact-links" aria-label="Contact and social links">
          <a class="footer-contact-link" id="whatsappContactLink" href="#" target="_blank" rel="noopener noreferrer" hidden><span>WhatsApp</span><strong id="whatsappContactNumber"></strong><span aria-hidden="true">↗</span></a>
          <a class="footer-contact-link" id="instagramProfileLink" href="#" target="_blank" rel="noopener noreferrer" hidden><svg class="footer-instagram-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"></rect><circle cx="12" cy="12" r="4"></circle><circle cx="17.5" cy="6.5" r=".75"></circle></svg><span>Instagram</span><span aria-hidden="true">↗</span></a>
          <span id="footerContactStatus" class="footer-link-status" role="status" hidden></span>
        </div>
        <div class="footer-bottom"><span>© 2026 LOCOXATL. ALL RIGHTS RESERVED.</span><span>CUSTOM. CLEAN. BOLD.</span></div>
      </footer>`;
  }

  window.locoxatlPublicConfig = fetch('/api/public-config')
    .then((response) => {
      if (!response.ok) throw new Error(`Public configuration request failed (${response.status}).`);
      return response.json();
    });

  // Shared catalogue request: pages hydrate their group navigation from this promise, and
  // src/catalog.js stays the immediate/offline fallback when it rejects.
  window.locoxatlCatalog = fetch('/api/catalog')
    .then((response) => {
      if (!response.ok) throw new Error(`Catalog request failed (${response.status}).`);
      return response.json();
    })
    .catch(() => null);

  window.locoxatlCatalog.then((payload) => {
    const container = document.getElementById('footerCollections');
    if (!container || !payload || !Array.isArray(payload.groups) || !payload.groups.length) return;
    container.innerHTML = payload.groups.map((group) =>
      `<a href="artist.html?artist=${encodeURIComponent(group.slug)}">${String(group.name).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])}</a>`
    ).join('');
    container.hidden = false;
  });
  window.locoxatlPublicConfig.then((config) => {
    const whatsappLink = document.getElementById('whatsappContactLink');
    const whatsappNumber = document.getElementById('whatsappContactNumber');
    const instagramLink = document.getElementById('instagramProfileLink');
    const status = document.getElementById('footerContactStatus');
    const missing = [];

    if (whatsappLink && whatsappNumber && /^[1-9]\d{7,14}$/.test(config.whatsappNumber || '')) {
      whatsappLink.href = `https://wa.me/${config.whatsappNumber}`;
      whatsappNumber.textContent = `+${config.whatsappNumber}`;
      whatsappLink.hidden = false;
    } else {
      missing.push('WhatsApp contact is not configured.');
    }
    if (instagramLink && config.instagramUrl) {
      instagramLink.href = config.instagramUrl;
      instagramLink.hidden = false;
    } else {
      missing.push('Instagram profile is not configured.');
    }

    if (status && missing.length) {
      status.textContent = missing.join(' ');
      status.hidden = false;
    }
  }).catch(() => {
    const status = document.getElementById('footerContactStatus');
    if (status) {
      status.textContent = 'Contact links could not be loaded.';
      status.hidden = false;
    }
  });

  const menuButton = document.getElementById('mobileMenuButton');
  const mobileNav = document.getElementById('mobileNav');
  if (menuButton && mobileNav) {
    menuButton.addEventListener('click', () => {
      const isOpen = mobileNav.hidden;
      mobileNav.hidden = !isOpen;
      menuButton.setAttribute('aria-expanded', String(isOpen));
    });
    mobileNav.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
      mobileNav.hidden = true;
      menuButton.setAttribute('aria-expanded', 'false');
    }));
  }

  if ('IntersectionObserver' in window) {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach((element) => revealObserver.observe(element));
  } else {
    document.querySelectorAll('.reveal').forEach((element) => element.classList.add('is-visible'));
  }
})();
