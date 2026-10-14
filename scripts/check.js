const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function check() {
  for (const file of ['index.html', 'admin.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      new vm.Script(match[1], { filename: file });
    }
  }
  await import('../src/worker.ts');
  console.log('Frontend scripts and Worker syntax checked');
}
check().catch(error => { console.error(error); process.exitCode = 1; });
