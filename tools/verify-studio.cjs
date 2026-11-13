const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { createAppServer, listenWithFallback } = require('../server');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(os.tmpdir(), `locoxatl-studio-verification-${process.pid}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: options.headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = createAppServer(ROOT);
  const { port } = await listenWithFallback(server, 0);
  const base = `http://127.0.0.1:${port}`;
  const log = (...args) => console.log(...args);
  const issues = [];
  let unavailableOrderRequestObserved = false;
  let browser;

  try {
    log('server', base);

    const health = await request(port, '/api/health');
    log('health', health.status, health.body.slice(0, 150));

    const post = await request(port, '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: { name: 'Test', phone: '08123456789', address: 'Jl. Test No. 1, Bandung' }, order: { product: { slug: 'blackpink-cloud-heart' }, quantity: 1, total: 52000, configuration: { base: { id: 'heart' }, clasp: { id: 'silver' }, addons: [{ id: 'pearl' }], initial: 'A' } } }),
    });
    log('POST order (no db)', post.status, post.body.slice(0, 120));

    const bad = await request(port, '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: { name: 'T', phone: '1' }, order: { product: { slug: 'nope' } } }),
    });
    log('POST invalid', bad.status, bad.body.slice(0, 160));

    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-sandbox'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/orders' && response.status() === 503) {
        unavailableOrderRequestObserved = true;
      }
    });
    page.on('console', (m) => {
      if (!['error', 'warning'].includes(m.type())) return;
      if (unavailableOrderRequestObserved && m.text().includes('status of 503 (Service Unavailable)')) return;
      issues.push(`[${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => issues.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => issues.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));

    await page.goto(`${base}/studio.html?artist=blackpink&product=blackpink-cloud-heart`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => document.getElementById('studioViewerStage')?.dataset.viewer !== 'loading', { timeout: 25000 });
    await page.evaluate(() => document.querySelector('.studio-builder').scrollIntoView({ block: 'center' }));
    await sleep(1400);
    const viewer = await page.evaluate(() => ({
      status: document.getElementById('studioViewerStage').dataset.viewer,
      canvas: (() => { const c = document.getElementById('studioViewerCanvas'); return `${c.width}x${c.height}`; })(),
      price: document.getElementById('builderPrice').textContent,
    }));
    log('viewer', JSON.stringify(viewer));
    if (viewer.status !== 'ready' || viewer.price !== 'Rp52.000') issues.push('[check] desktop 3D viewer or initial price');
    await page.screenshot({ path: path.join(SHOTS, '01-heart.png') });

    // Base switching
    for (const baseId of ['star', 'bow']) {
      await page.click(`.base-choices .choice-button[data-base="${baseId}"]`);
      await sleep(700);
      const info = await page.evaluate(() => ({
        base: window.LocoxatlStudio3D.scene.assembly.baseId,
        price: document.getElementById('builderPrice').textContent,
        height: window.LocoxatlStudio3D.scene.assembly.metrics.height.toFixed(2),
      }));
      log(`base ${baseId}`, JSON.stringify(info));
      if (info.base !== baseId) issues.push(`[check] ${baseId} base selection`);
      await page.screenshot({ path: path.join(SHOTS, `02-base-${baseId}.png`) });
    }

    // Back to heart and add everything
    await page.click('.base-choices .choice-button[data-base="heart"]');
    await page.click('input[data-addon="pearl"]');
    await page.click('input[data-addon="star"]');
    await page.click('#initialToggle');
    await page.type('#initialText', 'm');
    await sleep(900);
    const addons = await page.evaluate(() => ({
      price: document.getElementById('builderPrice').textContent,
      pieces: document.getElementById('previewCount').textContent,
      parts: [...document.querySelectorAll('.part-chip')].map((c) => `${c.dataset.component}:${c.classList.contains('is-off') ? 'off' : 'on'}`).join(' '),
      initialVisible: window.LocoxatlStudio3D.scene.assembly.registry.get('initial').visible,
      letter: window.LocoxatlStudio3D.scene.assembly.initialLetter,
    }));
    log('addons', JSON.stringify(addons));
    if (addons.price !== 'Rp77.000' || !addons.initialVisible || addons.letter !== 'M') issues.push('[check] add-on configuration and price');
    await page.screenshot({ path: path.join(SHOTS, '03-full-silver.png') });

    // Clasp
    await page.click('.clasp-choice[data-clasp="black"]');
    await sleep(600);
    log('black clasp', JSON.stringify(await page.evaluate(() => ({
      price: document.getElementById('builderPrice').textContent,
      claspFinish: window.LocoxatlStudio3D.scene.assembly.registry.get('clasp').finish,
      connectorFinish: window.LocoxatlStudio3D.scene.assembly.registry.get('connector').finish,
    }))));
    await page.screenshot({ path: path.join(SHOTS, '04-black-clasp.png') });

    // Select base via chip and change finish
    await page.evaluate(() => document.querySelector('.part-chip[data-component="base"]').click());
    await sleep(300);
    log('inspector', JSON.stringify(await page.evaluate(() => ({
      name: document.getElementById('viewerSelectionName').textContent,
      meta: document.getElementById('viewerSelectionMeta').textContent,
      swatches: [...document.querySelectorAll('.swatch')].map((s) => s.dataset.finish),
      marker: Boolean(window.LocoxatlStudio3D.scene.assembly.registry.marker.parent),
    }))));
    await page.evaluate(() => document.querySelector('.swatch[data-finish="silver"]').click());
    await sleep(500);
    await page.screenshot({ path: path.join(SHOTS, '05-silver-base.png') });

    // Click-to-select on the canvas
    const box = await page.evaluate(() => { const r = document.getElementById('studioViewerCanvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await page.evaluate(() => window.LocoxatlStudio3D.select(null));
    await sleep(200);
    const centerHit = await page.evaluate(({ cx, cy }) => window.LocoxatlStudio3D.scene.pick(cx, cy, { silent: true }), { cx: box.x + box.w / 2, cy: box.y + box.h / 2 });
    log('raycast at canvas centre ->', centerHit);
    await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
    await sleep(400);
    log('after canvas click selection:', await page.evaluate(() => document.getElementById('viewerSelectionName').textContent));

    // Explode / assemble
    await page.click('#viewerExplode');
    await sleep(1200);
    const exploded = await page.evaluate(() => window.LocoxatlStudio3D.getSnapshot().explode);
    log('exploded', exploded);
    if (exploded !== 1) issues.push('[check] exploded view');
    await page.screenshot({ path: path.join(SHOTS, '06-exploded.png') });
    await page.click('#viewerAssemble');
    await sleep(1200);
    const assembled = await page.evaluate(() => window.LocoxatlStudio3D.getSnapshot().explode);
    log('assembled', assembled);
    if (assembled !== 0) issues.push('[check] assemble view');

    // Orbit + zoom
    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w / 2 + 160, box.y + box.h / 2 - 30, { steps: 14 });
    await page.mouse.up();
    await page.mouse.wheel({ deltaY: -300 });
    await sleep(800);
    log('camera after orbit', JSON.stringify(await page.evaluate(() => window.LocoxatlStudio3D.scene.camera.position.toArray().map((n) => Number(n.toFixed(2))))));
    await page.screenshot({ path: path.join(SHOTS, '07-orbit.png') });

    await page.click('#viewerReset');
    await sleep(900);
    await page.screenshot({ path: path.join(SHOTS, '08-reset.png') });

    log('snapshot', JSON.stringify((await page.evaluate(() => window.LocoxatlStudio3D.getSnapshot())).components.map((c) => `${c.id}/${c.finish}/${c.visible ? 'on' : 'off'}`)));

    // Checkout
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.click('#continueToCheckout'),
    ]);
    log('checkout url', page.url());
    log('checkout summary', JSON.stringify(await page.evaluate(() => ({
      product: document.getElementById('summaryProductName').textContent,
      config: document.getElementById('summaryConfiguration').textContent,
      price: document.getElementById('summaryPrice').textContent,
    }))));
    const checkoutComponents = await page.evaluate(() => (JSON.parse(localStorage.getItem('locoxatl-pending-order')).configuration.components || []).length);
    log('pending order components', checkoutComponents);
    if (checkoutComponents !== 6) issues.push('[check] checkout configuration snapshot');

    await page.type('input[name="name"]', 'Ayu Lestari');
    await page.type('input[name="phone"]', '081234567890');
    await page.type('input[name="email"]', 'ayu@example.com');
    await page.type('textarea[name="address"]', 'Jl. Merdeka No. 12, Bandung 40111');
    await page.screenshot({ path: path.join(SHOTS, '09-checkout.png') });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }),
      page.click('#checkoutForm button[type="submit"]'),
    ]);
    log('payment url', page.url());
    log('payment', JSON.stringify(await page.evaluate(() => ({
      order: document.getElementById('paymentOrderNumber')?.textContent,
      total: document.getElementById('paymentTotal')?.textContent,
      persistence: JSON.parse(localStorage.getItem('locoxatl-pending-order') || '{}').persistence,
    }))));
    if (!unavailableOrderRequestObserved) issues.push('[check] local-demo order fallback was not exercised');
    await page.screenshot({ path: path.join(SHOTS, '10-payment.png') });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.click('#finishPaymentDemo'),
    ]);
    log('success url', page.url());
    log('success', JSON.stringify(await page.evaluate(() => ({
      order: document.getElementById('successOrderNumber').textContent,
      status: document.getElementById('successStatus').textContent,
    }))));
    await page.screenshot({ path: path.join(SHOTS, '11-success.png') });

    // Mobile
    const mobile = await browser.newPage();
    await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    mobile.on('pageerror', (e) => issues.push(`[mobile pageerror] ${e.message}`));
    mobile.on('console', (m) => { if (m.type() === 'error') issues.push(`[mobile console] ${m.text()}`); });
    await mobile.goto(`${base}/studio.html?artist=bts&product=bts-soft-ribbon`, { waitUntil: 'networkidle2' });
    await mobile.waitForFunction(() => document.getElementById('studioViewerStage')?.dataset.viewer !== 'loading', { timeout: 25000 });
    await sleep(1200);
    const mobileState = await mobile.evaluate(() => {
      const canvas = document.getElementById('studioViewerCanvas').getBoundingClientRect();
      return {
        status: document.getElementById('studioViewerStage').dataset.viewer,
        canvas: [Math.round(canvas.width), Math.round(canvas.height)],
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        price: document.getElementById('builderPrice').textContent,
      };
    });
    log('mobile', JSON.stringify(mobileState));
    if (mobileState.status !== 'ready' || mobileState.overflowX) issues.push('[check] mobile viewer or horizontal overflow');
    await mobile.screenshot({ path: path.join(SHOTS, '12-mobile-bow.png') });

    await mobile.evaluate(() => document.querySelector('input[data-addon="pearl"]').click());
    await sleep(800);
    await mobile.screenshot({ path: path.join(SHOTS, '13-mobile-pearl.png') });

    for (const pagePath of ['/', '/shop.html', '/artist.html?artist=blackpink', '/studio.html', '/checkout.html', '/payment.html', '/order-success.html', '/styles.css', '/src/three/viewer.mjs', '/assets/vendor/three/three.module.js', '/assets/vendor/three/addons/controls/OrbitControls.js']) {
      const response = await request(port, pagePath);
      if (response.status !== 200) issues.push(`[http ${response.status}] ${pagePath}`);
    }
    if (!issues.length) log('static pages and browser checks OK');
  } finally {
    log('--- console issues:', issues.length, '---');
    issues.slice(0, 30).forEach((line) => log(line));
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(SHOTS, { recursive: true, force: true });
    if (issues.length) process.exitCode = 1;
  }
})().catch((error) => {
  console.error('VERIFY FAILED:', error);
  process.exitCode = 1;
});