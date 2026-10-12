// Next's installed test-only Google Fonts hook reads real installed Sarabun bytes offline.
/* eslint-disable @typescript-eslint/no-require-imports -- Next's test hook requires CommonJS. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../node_modules/@fontsource/sarabun');
let css = '';
for (const weight of [300, 400, 500, 600, 700]) {
  css += fs.readFileSync(path.join(root, `${weight}.css`), 'utf8')
    .replace(/\/\* sarabun-([\w-]+)-\d+-normal \*\//g, '/* $1 */')
    .replace(/src: url\(\.\/files\/([^)]*\.woff2)\)[^;]*;/g, (_, file) => {
      const font = path.join(root, 'files', file);
      assert.equal(fs.readFileSync(font).subarray(0, 4).toString(), 'wOF2');
      // Next's mock reader requires '/' on Windows; a drive-relative root resolves on C:.
      const local = font.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '');
      return `src: url(${local}) format('woff2');`;
    });
}
assert.equal((css.match(/@font-face/g) || []).length, 20);
module.exports = {
  'https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500;600;700&display=swap': css,
};
