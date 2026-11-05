const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'assets', 'stickers');
const DST_DIR = path.join(PROJECT_ROOT, 'dist', 'stickers');

if (!fs.existsSync(SRC_DIR)) {
  console.log('[copy-stickers] assets/stickers not found, skipping');
  process.exit(0);
}

fs.mkdirSync(DST_DIR, { recursive: true });
fs.cpSync(SRC_DIR, DST_DIR, { recursive: true, force: true });
console.log(`[copy-stickers] copied ${SRC_DIR} -> ${DST_DIR}`);
