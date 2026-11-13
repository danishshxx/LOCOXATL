const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { createAppServer, listenWithFallback } = require('../server');

const root = path.join(__dirname, '..');

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, type: response.headers['content-type'] }));
    }).on('error', reject);
  });
}

test('the active homepage links to the separate artist directory, not an in-page shop section', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /href="shop\.html"/);
  assert.doesNotMatch(html, /href="#(?:shop|studio|products)"/i);
});

test('artist and product navigation targets are separate editable HTML files', () => {
  for (const file of ['index.html', 'shop.html', 'artist.html', 'studio.html', 'checkout.html', 'payment.html', 'order-success.html']) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} must exist`);
  }
  const shop = fs.readFileSync(path.join(root, 'shop.html'), 'utf8');
  const artist = fs.readFileSync(path.join(root, 'artist.html'), 'utf8');
  assert.match(shop, /artist\.html\?artist=blackpink/);
  assert.match(artist, /studio\.html\?artist=/);
});

test('local server serves the separate pages and their scripts over HTTP', async (t) => {
  const server = createAppServer(root);
  const { port } = await listenWithFallback(server, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(server.address().address, '127.0.0.1', 'preview server should only listen on loopback');

  for (const pathname of ['/', '/shop.html', '/artist.html?artist=blackpink', '/studio.html?artist=blackpink&product=blackpink-cloud-heart', '/checkout.html', '/payment.html', '/order-success.html', '/src/catalog.js', '/styles.css']) {
    const response = await request(port, pathname);
    assert.equal(response.status, 200, `${pathname} should load`);
    assert.ok(response.body.length > 0, `${pathname} should not be empty`);
  }

  for (const pathname of ['/.env', '/.env.example', '/nested/.env.production']) {
    const response = await request(port, pathname);
    assert.equal(response.status, 404, `${pathname} must not be served`);
  }
});

test('local server moves to another port if the default port is already occupied', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupiedPort = blocker.address().port;
  const server = createAppServer(root);
  const { port } = await listenWithFallback(server, occupiedPort);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => blocker.close(resolve));
  });
  assert.ok(port > occupiedPort, 'server should choose a free port after the occupied one');
  const response = await request(port, '/');
  assert.equal(response.status, 200);
  assert.match(response.body, /Meet your new/);
});

test('all local links and script references in active pages resolve to files', () => {
  const pages = ['index.html', 'shop.html', 'artist.html', 'studio.html', 'checkout.html', 'payment.html', 'order-success.html'];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
    for (const ref of refs) {
      if (/^(?:https?:|mailto:|tel:|#|data:|javascript:)/i.test(ref)) continue;
      const localPath = decodeURIComponent(ref.split(/[?#]/, 1)[0]);
      if (!localPath) continue;
      assert.ok(fs.existsSync(path.join(root, localPath)), `${page} references missing local file: ${ref}`);
    }
  }
});

test('Windows launcher uses the server-selected port instead of hardcoding localhost:4173', () => {
  const launcher = fs.readFileSync(path.join(root, 'start-preview.bat'), 'utf8');
  assert.match(launcher, /OPEN_BROWSER=1/);
  assert.match(launcher, /node server\.js/);
  assert.doesNotMatch(launcher, /localhost:4173/i);
});
