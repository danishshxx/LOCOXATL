const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

const studioHtml = read('studio.html');
const studioScript = read('src/studio.js');
const styles = read('styles.css');

test('the custom studio keeps the approved SVG preview as a WebGL fallback', () => {
  assert.match(studioHtml, /id="studioPreviewFallback"/);
  assert.match(studioHtml, /id="previewBase"/);
  assert.match(studioHtml, /id="previewRing"/);
  assert.match(studioHtml, /id="previewAddon"/);
  assert.match(studioHtml, /id="previewInitial"/);
  assert.match(studioHtml, /id="customPreview"/);
});

test('the 3D viewer mounts into the existing preview panel without new layout sections', () => {
  assert.match(studioHtml, /id="studioViewerStage"/);
  assert.match(studioHtml, /id="studioViewerCanvas"/);
  assert.match(studioHtml, /class="custom-preview"/);
  assert.match(studioHtml, /class="builder-preview-panel"/);
  // The original control steps are untouched.
  for (const marker of ['data-base="heart"', 'data-base="star"', 'data-base="bow"', 'data-addon="pearl"', 'data-addon="star"', 'id="initialToggle"', 'data-clasp="silver"', 'data-clasp="black"', 'id="continueToCheckout"']) {
    assert.ok(studioHtml.includes(marker), `${marker} control must stay in place`);
  }
});

test('explode, assemble and reset controls exist and are wired to the viewer module', () => {
  for (const id of ['viewerExplode', 'viewerAssemble', 'viewerReset', 'viewerPartList', 'viewerSelectionName', 'viewerSelectionMeta', 'viewerSwatches', 'viewerVisibilityToggle']) {
    assert.ok(studioHtml.includes(`id="${id}"`), `${id} should be present`);
  }
  const viewer = read('src/three/viewer.mjs');
  assert.match(viewer, /setExploded\(true\)/);
  assert.match(viewer, /setExploded\(false\)/);
  assert.match(viewer, /resetCamera\(\)/);
  assert.match(viewer, /applyState/);
});

test('three.js is only downloaded when the studio preview approaches the viewport', () => {
  assert.match(studioHtml, /type="importmap"/);
  assert.match(studioHtml, /assets\/vendor\/three\/three\.module\.js/);
  assert.match(studioScript, /new URL\('three\/viewer\.mjs', selfUrl\)/);
  assert.match(studioScript, /IntersectionObserver/);
  assert.match(studioScript, /hasWebGL/);
  assert.doesNotMatch(studioScript, /from 'three'|require\('three'\)/, 'studio.js must not import three eagerly');
  assert.equal((studioScript.match(/^\s*import\(/gm) || []).length, 1, 'exactly one lazy import should exist');
});

test('the studio does not duplicate prices and reads them from src/options.js', () => {
  assert.match(studioHtml, /src="src\/options\.js"/);
  assert.match(studioScript, /LocoxatlOptions/);
  assert.match(studioScript, /addonPrice\(/);
  assert.match(studioScript, /claspPrice\(/);
});

test('the vendored three.js build and the OrbitControls addon ship with the project', () => {
  for (const file of [
    'assets/vendor/three/three.module.js',
    'assets/vendor/three/three.core.js',
    'assets/vendor/three/addons/controls/OrbitControls.js',
    'assets/vendor/three/LICENSE',
  ]) {
    assert.ok(exists(file), `${file} should be vendored`);
  }
  const viewer = read('src/three/viewer.mjs');
  assert.match(viewer, /studio's|StudioScene/);
});

test('the 3D engine is split into geometry, materials, components, scene and viewer modules', () => {
  for (const file of ['src/three/svg-path.mjs', 'src/three/shapes.mjs', 'src/three/materials.mjs', 'src/three/components.mjs', 'src/three/assembly.mjs', 'src/three/scene.mjs', 'src/three/viewer.mjs', 'src/three/letter.mjs']) {
    assert.ok(exists(file), `${file} should exist`);
  }
  const scene = read('src/three/scene.mjs');
  assert.match(scene, /dispose\(\)/);
  assert.match(scene, /ResizeObserver/);
  assert.match(scene, /requestRender/);
  assert.match(styles, /\.viewer-stage/);
  assert.match(styles, /\.builder-preview-panel\.is-3d/);
});

test('checkout posts the structured configuration to the order API and never fakes a local order', () => {
  const checkoutScript = read('src/checkout.js');
  assert.match(checkoutScript, /fetch\('\/api\/orders'/);
  assert.match(checkoutScript, /components/);
  assert.doesNotMatch(checkoutScript, /local-demo|localOrderNumber/, 'a failed submission must not invent an order');
  assert.match(checkoutScript, /setStatus\(describeFailure/, 'failures must surface an inline error');
  assert.match(checkoutScript, /payment\.html/);
  const paymentScript = read('src/payment.js');
  assert.match(paymentScript, /\/status/);
  assert.match(paymentScript, /order-success\.html/);
  assert.match(read('checkout.html'), /id="checkoutStatus"/);
});

test('the MySQL schema declares the required order, item and configuration tables', () => {
  const schema = read('database/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS orders/);
  assert.match(schema, /order_number/);
  assert.match(schema, /customer_name/);
  assert.match(schema, /customer_email/);
  assert.match(schema, /customer_phone/);
  assert.match(schema, /total_amount/);
  assert.match(schema, /order_status/);
  assert.match(schema, /created_at/);
  assert.match(schema, /updated_at/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS order_items/);
  assert.match(schema, /unit_price/);
  assert.match(schema, /subtotal/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS customizer_configurations/);
  assert.match(schema, /configuration_json JSON NOT NULL/);
  assert.match(schema, /FOREIGN KEY \(order_id\) REFERENCES orders \(id\)/);
  assert.match(schema, /FOREIGN KEY \(order_item_id\) REFERENCES order_items \(id\)/);
});

test('database setup files and environment template are present', () => {
  assert.ok(exists('.env.example'));
  assert.ok(exists('DATABASE-SETUP.md'));
  const envExample = read('.env.example');
  for (const variable of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
    assert.ok(envExample.includes(variable), `${variable} should be documented`);
  }
  const setup = read('DATABASE-SETUP.md');
  assert.match(setup, /schema\.sql/);
  assert.match(setup, /mysql2/);
  assert.match(setup, /BEGIN|transaction/i);
});