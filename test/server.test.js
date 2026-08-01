const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAppServer } = require('../server');

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function startTestServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), '51talk-upload-test-'));
  const server = createAppServer({
    adminPassword: 'test-admin-password',
    dataDir,
    maxBodyBytes: 2048,
    secureCookies: false,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json();
  return { body, response };
}

test('submission and admin APIs enforce the security boundary', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  let result = await jsonRequest(app.baseUrl, '/api/admin/submissions');
  assert.equal(result.response.status, 401);

  result = await jsonRequest(app.baseUrl, '/api/submissions');
  assert.equal(result.response.status, 404);

  result = await jsonRequest(app.baseUrl, '/data/submissions.json');
  assert.equal(result.response.status, 404);

  result = await jsonRequest(app.baseUrl, '/server.js');
  assert.equal(result.response.status, 404);

  result = await jsonRequest(app.baseUrl, '/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageData: TINY_PNG,
      orderId: '6912345678901234567',
      phone: '13812345678',
    }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.success, true);

  const stored = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'submissions.json'), 'utf8'));
  assert.equal(stored.submissions.length, 1);
  assert.equal(Object.hasOwn(stored.submissions[0], 'imageData'), false);
  assert.match(stored.submissions[0].imageUrl, /^\/data\/images\/[a-f0-9-]+\.png$/);

  const privateImagePath = `/api/admin/images/${path.basename(stored.submissions[0].imageUrl)}`;
  result = await jsonRequest(app.baseUrl, privateImagePath);
  assert.equal(result.response.status, 401);

  result = await jsonRequest(app.baseUrl, '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert.equal(result.response.status, 401);

  result = await jsonRequest(app.baseUrl, '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-admin-password' }),
  });
  assert.equal(result.response.status, 200);
  const setCookie = result.response.headers.get('set-cookie');
  const cookie = setCookie.split(';')[0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);

  result = await jsonRequest(app.baseUrl, '/api/admin/submissions', {
    headers: { Cookie: cookie },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.length, 1);
  assert.equal(Object.hasOwn(result.body.data[0], 'imageData'), false);

  const submission = result.body.data[0];
  const imageResponse = await fetch(`${app.baseUrl}${submission.imageUrl}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');

  result = await jsonRequest(app.baseUrl, '/api/admin/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: submission.id }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(fs.readdirSync(path.join(app.dataDir, 'images')).length, 0);
});

test('upload validation rejects fake images and oversized bodies', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  let result = await jsonRequest(app.baseUrl, '/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageData: `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`,
      orderId: '6912345678901234567',
      phone: '13812345678',
    }),
  });
  assert.equal(result.response.status, 400);

  result = await jsonRequest(app.baseUrl, '/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(3000) }),
  });
  assert.equal(result.response.status, 413);
});
