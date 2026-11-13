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
        <div class="footer-links"><a href="index.html#our-story">Our story</a><a href="shop.html">Collections</a><a href="shop.html">Buy Now</a><a href="mailto:hello@locoxatl.com">Contact</a></div>
        <div class="footer-bottom"><span>© 2026 LOCOXATL. ALL RIGHTS RESERVED.</span><span>CUSTOM. CLEAN. BOLD.</span></div>
      </footer>`;
  }

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
