const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// COD is a fulfillment path, not a new payment system: the existing Cash method is recorded,
// the order stays "waiting_for_payment", and the buyer is handed to WhatsApp instead of QRIS.

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const whatsapp = require('../src/whatsapp.js');
const { validateOrderPayload } = require('../src/server/validation.js');

function catalog(overrides = {}) {
  return {
    source: 'database',
    groups: [{ id: 1, slug: 'blackpink', name: 'BLACKPINK', isActive: true, hasVersions: false, isCustomDesign: false }],
    members: [{
      id: 5, groupId: 1, groupSlug: 'blackpink', slug: 'jisoo', name: 'Jisoo',
      versionKey: 'yellow', isActive: true, designImageUrl: null,
    }],
    products: [],
    bundles: [],
    optionCategories: [
      { slug: 'addon', name: 'Universal Add-ons', selectionMode: 'multiple', isRequired: false, countsTowardBundleFree: true, sortOrder: 0, isActive: true },
    ],
    options: {
      base: { key: 'keychain', label: 'Keychain base', price: 45000, isActive: true },
      addons: [],
      clasps: [],
      items: [{ key: 'pearl', category: 'addon', label: 'Pearl drop', price: 8000, isActive: true }],
    },
    paymentMethods: [
      { code: 'qris', label: 'QRIS', instructions: 'Scan.', imageUrl: null, isActive: true, sortOrder: 0 },
      { code: 'cash', label: 'Cash', instructions: 'Pay in person.', imageUrl: null, isActive: true, sortOrder: 1 },
    ],
    product: { baseModel: 'heart', baseLabel: 'Heart', basePrice: 45000 },
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    customer: { name: 'Ayu Lestari', phone: '081234567890', email: '', address: 'Jl. Merdeka 10, Bandung', note: '' },
    order: {
      artist: { slug: 'blackpink' },
      member: { slug: 'jisoo' },
      configuration: { base: { id: 'heart' }, addons: [{ id: 'pearl' }], clasp: { id: 'silver' }, components: [] },
      quantity: 1,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Checkout routing
// ---------------------------------------------------------------------------

test('COD bypasses the QRIS page and hands the saved order to WhatsApp', () => {
  const source = read('src/checkout.js');
  const html = read('checkout.html');

  assert.match(html, /src\/whatsapp\.js/, 'checkout loads the shared WhatsApp module');
  assert.match(html, /id="paymentMethodFieldset"/, 'the QRIS-style method picker still exists for QRIS orders');
  assert.doesNotMatch(html, /QRIS/i, 'the checkout page itself never advertises QRIS');

  // The COD branch hides the payment picker, records the existing Cash method, and returns
  // before the payment-page redirect.
  assert.match(source, /fulfillmentMethod === 'cod_telkom'/);
  assert.match(source, /fieldset\.hidden = true/);
  assert.match(source, /method\.code === 'cash'/);
  assert.match(source, /buildCodMessage/);
  assert.match(source, /window\.location\.href = whatsapp\.buildChatUrl/);

  const submit = source.slice(source.indexOf("form.addEventListener('submit'"));
  const codReturn = submit.indexOf("if (fulfillmentMethod === 'cod_telkom')");
  const paymentRedirect = submit.indexOf("window.location.href = 'payment.html'");
  assert.ok(codReturn > -1, 'the submit handler branches on COD');
  assert.ok(paymentRedirect > codReturn, 'COD returns before the QRIS redirect');
});

test('a failed order API never redirects to WhatsApp or QRIS', () => {
  const source = read('src/checkout.js');
  const submit = source.slice(source.indexOf("form.addEventListener('submit'"));

  // Every failure path persists the draft, reports an error inline and calls setBusy(false)
  // before reaching the success block that performs a redirect.
  const successBlock = submit.indexOf('order.orderNumber = body.order.orderNumber');
  assert.ok(successBlock > -1);
  const failureBlock = submit.slice(0, successBlock);
  assert.equal((failureBlock.match(/setStatus\(describeFailure/g) || []).length >= 2, true);
  assert.match(failureBlock, /persistDraft\(\)/);
  assert.match(failureBlock, /setBusy\(false\)/);
});

test('COD never marks itself paid or sends a payment confirmation', () => {
  const source = read('src/checkout.js');
  assert.doesNotMatch(source, /status: 'paid'/);
  assert.doesNotMatch(source, /payment_confirmation_sent/);
  assert.doesNotMatch(source, /method: 'PATCH'/);
  assert.match(source, /waiting_for_payment/);
});

// ---------------------------------------------------------------------------
// Validation and message
// ---------------------------------------------------------------------------

test('a COD order validates with the existing Cash method and keeps the unpaid lifecycle', () => {
  const result = validateOrderPayload(order({ fulfillmentMethod: 'cod_telkom', paymentMethod: 'cash' }), {
    catalog: catalog(),
  });

  assert.equal(result.fulfillmentMethod, 'cod_telkom');
  assert.equal(result.paymentMethod, 'cash');
  assert.equal(result.quote.total, 53000);
});

test('the COD WhatsApp message contains every detail the admin needs', () => {
  const message = whatsapp.buildCodMessage({
    orderNumber: 'LX-COD-9',
    name: 'Ayu Lestari',
    phone: '081234567890',
    artist: 'BLACKPINK',
    member: 'Jisoo',
    configuration: 'Heart · Silver clasp',
    addons: 'Pearl drop',
    quantity: 1,
    fulfillment: 'COD / Ketemuan',
    address: 'Jl. Merdeka 10',
    total: 'Rp53.000',
  });

  for (const line of [
    'Order: LX-COD-9',
    'Nama: Ayu Lestari',
    'No. WhatsApp: 081234567890',
    'Koleksi: BLACKPINK',
    'Member: Jisoo',
    'Konfigurasi: Heart · Silver clasp',
    'Add-ons: Pearl drop',
    'Jumlah: 1',
    'Pengiriman: COD / Ketemuan',
    'Total: Rp53.000',
    'Metode pembayaran: COD.',
  ]) {
    assert.ok(message.includes(line), `message must include "${line}"`);
  }

  const url = whatsapp.buildChatUrl('081234567890', message);
  assert.match(url, /^https:\/\/wa\.me\/6281234567890\?text=/);
  assert.ok(!url.startsWith('/') && !url.includes('checkout.html'));
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('a COD order is persisted as waiting_for_payment with COD fulfillment and Cash', async () => {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_USER = 'cod-test';
  process.env.DB_NAME = 'locoxatl_cod_test';

  const calls = [];
  const handle = async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    if (/^INSERT INTO orders/i.test(String(sql).trim())) return [{ insertId: 11, affectedRows: 1 }];
    if (/^INSERT INTO order_items/i.test(String(sql).trim())) return [{ insertId: 12, affectedRows: 1 }];
    return [[]];
  };
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release() {},
    execute: handle,
    query: handle,
  };
  const mysqlPath = require.resolve('mysql2/promise');
  require.cache[mysqlPath] = {
    id: mysqlPath,
    filename: mysqlPath,
    loaded: true,
    exports: {
      createPool() {
        return {
          execute: handle,
          query: handle,
          getConnection: async () => connection,
          end: async () => {},
        };
      },
    },
  };

  const orders = require('../src/server/orders.js');
  const created = await orders.createOrder({
    customer: { name: 'Ayu Lestari', phone: '081234567890', email: '', address: 'Jl. Merdeka 10, Bandung', note: '' },
    order: {
      artist: { slug: 'blackpink' },
      product: { slug: 'blackpink-cloud-heart' },
      fulfillmentMethod: 'cod_telkom',
      paymentMethod: 'cash',
      configuration: { base: { id: 'heart' }, addons: [], clasp: { id: 'silver' }, components: [] },
      quantity: 1,
    },
  });

  assert.equal(created.status, 'waiting_for_payment', 'COD is never created as paid');
  assert.equal(created.fulfillmentMethod, 'cod_telkom');
  assert.equal(created.paymentMethod, 'cash');

  const insert = calls.find((call) => /^INSERT INTO orders/i.test(call.sql));
  assert.ok(insert, 'the order is written before any redirect');
  assert.equal(insert.params[6], 'cod_telkom');
  assert.equal(insert.params[7], 'cash');
  assert.equal(insert.params[9], 'waiting_for_payment', 'the stored status stays unpaid');
});

// ---------------------------------------------------------------------------
// QRIS remains intact
// ---------------------------------------------------------------------------

test('the QRIS flow still saves the order, renders the code and waits for admin verification', () => {
  const checkout = read('src/checkout.js');
  const paymentHtml = read('payment.html');
  const paymentJs = read('src/payment.js');

  assert.match(checkout, /window\.location\.href = 'payment\.html'/);
  assert.match(paymentHtml, /id="paymentQrImage"/);
  assert.match(paymentHtml, /id="paymentMethodPanel"/);
  assert.match(paymentHtml, /class="payment-qr-image"/);
  assert.doesNotMatch(paymentHtml, /qris-placeholder-mark/, 'the decorative faux-QR block is removed');
  assert.match(paymentJs, /image\.hidden = false/, 'the uploaded QRIS image is displayed');
  assert.match(paymentJs, /payment_confirmation_sent/, 'the customer confirmation stays separate from paid');
  assert.match(paymentHtml, /does not mark the payment as paid/);
});

// ---------------------------------------------------------------------------
// WhatsApp entry points
// ---------------------------------------------------------------------------

test('no WhatsApp entry point can navigate back into the storefront', () => {
  const pages = ['studio.html', 'payment.html', 'order-success.html'];
  for (const page of pages) {
    const html = read(page);
    const anchors = html.match(/<a[^>]*>[^<]*WhatsApp[^<]*<\/a>/gi) || [];
    for (const anchor of anchors) {
      // The href is written by the page script once the configured number is known, so the static
      // markup either has no href or already points at wa.me.
      if (/href="/.test(anchor)) assert.match(anchor, /href="https:\/\/wa\.me\//, `${page}: ${anchor}`);
    }
    assert.doesNotMatch(html, /id="(?:whatsappConfirm|successWhatsApp|customDesignWaLink|shopeeCsLink)"[^>]*href="#"/);
    assert.doesNotMatch(html, /wa\.me\/\?text=/, `${page} must not ship the generic share link`);
  }

  // Storefront scripts only ever write a direct chat URL with the configured number.
  for (const script of ['src/studio.js', 'src/payment.js', 'src/success.js']) {
    assert.match(read(script), /buildStorefrontChatUrl\(/, `${script} must use the storefront chat helper`);
    assert.doesNotMatch(read(script), /buildChatUrl\(\s*''/, `${script} must not fall back to the share sheet`);
  }

  // The shared footer only ever writes a wa.me URL.
  assert.match(read('src/site-shell.js'), /whatsappLink\.href = `https:\/\/wa\.me\/\$\{config\.whatsappNumber\}`/);
});
