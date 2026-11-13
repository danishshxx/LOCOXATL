const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'src', 'site-shell.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

 test('uses the supplied locoxatl wordmark in the main navigation and footer', () => {
  assert.match(shell, /class=\"brand\"[^>]*>[\s\S]*?locoxatl-wordmark-black\.png/);
  assert.match(shell, /class=\"brand brand-footer\"[^>]*>[\s\S]*?locoxatl-wordmark-black\.png/);
});

test('uses the supplied white wordmark on the black closing section', () => {
  assert.match(html, /class="[^"]*closing-watermark[^"]*"[^>]*>[\s\S]*?<img[^>]+src="assets\/brand\/locoxatl-wordmark-white\.png"/);
});

test('ships the official wordmark and LXL mark as transparent image assets', () => {
  for (const asset of [
    'locoxatl-wordmark-black.png',
    'locoxatl-wordmark-white.png',
    'lxl-mark-black.png',
    'lxl-mark-white.png',
  ]) {
    assert.ok(fs.existsSync(path.join(root, 'assets', 'brand', asset)), `${asset} should exist`);
  }
});

test('keeps the interface on an explicitly monochrome brand palette', () => {
  assert.match(css, /--brand-black:\s*#000(?:000)?\b/i);
  assert.match(css, /--brand-white:\s*#fff(?:fff)?\b/i);
  assert.match(css, /font-family:\s*Inter\b/);
});
