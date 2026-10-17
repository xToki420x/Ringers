// Copies the built web game (../dist, from `npm run build` in the repo root)
// into ./app, where the desktop shell loads it from.
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'dist');
const dest = path.join(__dirname, 'app');
if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error('Build the game first: run `npm run build` in the repository root.');
  process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`Copied ${src} → ${dest}`);
