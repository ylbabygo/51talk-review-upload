const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.resolve(root, 'dist');
if (path.dirname(output) !== root || path.basename(output) !== 'dist') {
  throw new Error('Build output must be the workspace dist directory');
}
// Publish only these application assets; never publish repository or upload data.
const files = [
  'index.html',
  'admin.html',
  'styles/main.css',
  'public/logo.png',
  'public/toki-greeting.gif',
  'public/toki-celebrate.gif'
];
for (const file of files) fs.accessSync(path.join(root, file));
fs.rmSync(output, { recursive: true, force: true });
for (const file of files) {
  const destination = path.join(output, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, file), destination);
}
console.log(`Built ${files.length} public assets in dist`);
