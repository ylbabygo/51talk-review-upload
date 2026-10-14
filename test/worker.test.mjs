import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/worker.ts';

const ORIGIN = 'https://example.test';
const VALID_PHONE = '13800138000';
const VALID_ORDER_ID = '6912345678901234567';
const PNG_DATA = 'data:image/png;base64,iVBORw0KGgo=';

class FakeStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql.replace(/\s+/g, ' ').trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    const { database, sql, values } = this;

    if (sql.startsWith('INSERT INTO rate_limits')) {
      const [key, nextReset, now] = values;
      const current = database.rateLimits.get(key);
      const entry = !current || current.reset_at <= now
        ? { count: 1, reset_at: nextReset }
        : { count: current.count + 1, reset_at: current.reset_at };
      database.rateLimits.set(key, entry);
      return { ...entry };
    }

    if (sql.startsWith('SELECT phone, order_id FROM submissions')) {
      const [phone, orderId] = values;
      const row = database.submissions.find(
        (submission) => submission.phone === phone || submission.order_id === orderId,
      );
      return row ? { phone: row.phone, order_id: row.order_id } : null;
    }

    if (sql.startsWith('SELECT image_key FROM submissions')) {
      const row = database.submissions.find((submission) => submission.id === values[0]);
      return row ? { image_key: row.image_key } : null;
    }

    throw new Error(`Unsupported first() query: ${sql}`);
  }

  async all() {
    if (!this.sql.includes('FROM submissions ORDER BY submitted_at DESC')) {
      throw new Error(`Unsupported all() query: ${this.sql}`);
    }
    return {
      results: [...this.database.submissions]
        .sort((left, right) => right.submitted_at.localeCompare(left.submitted_at))
        .map((row) => ({ ...row })),
    };
  }

  async run() {
    const { database, sql, values } = this;

    if (sql.startsWith('INSERT INTO submissions')) {
      const [id, phone, orderId, imageKey, imageMime, submittedAt] = values;
      if (database.submissions.some(
        (submission) => submission.phone === phone || submission.order_id === orderId,
      )) {
        throw new Error('UNIQUE constraint failed');
      }
      database.submissions.push({
        id,
        phone,
        order_id: orderId,
        image_key: imageKey,
        image_mime: imageMime,
        status: 'pending',
        submitted_at: submittedAt,
      });
      return { success: true };
    }

    if (sql.startsWith('DELETE FROM submissions')) {
      const index = database.submissions.findIndex((submission) => submission.id === values[0]);
      if (index >= 0) database.submissions.splice(index, 1);
      return { success: true };
    }

    if (sql.startsWith('DELETE FROM rate_limits')) {
      const cutoff = values[0];
      for (const [key, entry] of database.rateLimits) {
        if (entry.reset_at < cutoff) database.rateLimits.delete(key);
      }
      return { success: true };
    }

    throw new Error(`Unsupported run() query: ${sql}`);
  }
}

class FakeD1 {
  constructor() {
    this.submissions = [];
    this.rateLimits = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }
}

class FakeKv {
  constructor() {
    this.entries = new Map();
  }

  async put(key, value, options = {}) {
    this.entries.set(key, {
      value: value instanceof ArrayBuffer ? value.slice(0) : value,
      metadata: options.metadata,
    });
  }

  async delete(key) {
    this.entries.delete(key);
  }

  async getWithMetadata(key) {
    const entry = this.entries.get(key);
    if (!entry) return { value: null, metadata: null };
    return { value: entry.value, metadata: entry.metadata };
  }
}

function makeEnv() {
  const DB = new FakeD1();
  const IMAGES = new FakeKv();
  return {
    DB,
    IMAGES,
    ADMIN_PASSWORD: 'correct horse battery staple',
    ADMIN_SESSION_SECRET: 'test-secret-with-enough-entropy',
    ASSETS: {
      async fetch(request) {
        return new Response(`asset:${new URL(request.url).pathname}`, {
          headers: { 'Content-Type': 'text/plain' },
        });
      },
    },
  };
}

function makeContext() {
  const pending = [];
  return {
    pending,
    waitUntil(promise) {
      pending.push(Promise.resolve(promise));
    },
    passThroughOnException() {},
  };
}

function jsonRequest(path, body, headers = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function responseJson(response) {
  return JSON.parse(await response.text());
}

async function login(env, ctx) {
  const response = await worker.fetch(
    jsonRequest('/api/admin/login', { password: env.ADMIN_PASSWORD }),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-admin_session=[^;]+;/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  return setCookie.split(';', 1)[0];
}

test('same-origin upload stores detected image in KV and submission in D1', async () => {
  const env = makeEnv();
  const ctx = makeContext();
  const response = await worker.fetch(jsonRequest('/api/submit', {
    phone: VALID_PHONE,
    orderId: VALID_ORDER_ID,
    imageData: PNG_DATA,
  }), env, ctx);

  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), { success: true, message: '提交成功' });
  assert.equal(env.DB.submissions.length, 1);
  const row = env.DB.submissions[0];
  assert.equal(row.phone, VALID_PHONE);
  assert.equal(row.order_id, VALID_ORDER_ID);
  assert.equal(row.image_mime, 'image/png');
  assert.equal(row.status, 'pending');
  assert.match(row.image_key, /^[a-f0-9-]{20,}\.png$/i);

  const storedImage = env.IMAGES.entries.get(row.image_key);
  assert.ok(storedImage);
  assert.equal(storedImage.metadata.contentType, 'image/png');
  assert.equal(storedImage.metadata.submissionId, row.id);
  assert.deepEqual([...new Uint8Array(storedImage.value)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('duplicate phone and duplicate order ID are rejected without storing another image', async () => {
  const env = makeEnv();
  const ctx = makeContext();
  const submit = (phone, orderId) => worker.fetch(jsonRequest('/api/submit', {
    phone,
    orderId,
    imageData: PNG_DATA,
  }), env, ctx);

  assert.equal((await submit(VALID_PHONE, VALID_ORDER_ID)).status, 200);

  const duplicatePhone = await submit(VALID_PHONE, '6999999999999999999');
  assert.equal(duplicatePhone.status, 409);
  assert.equal((await responseJson(duplicatePhone)).message, '该手机号已提交过');

  const duplicateOrder = await submit('13900139000', VALID_ORDER_ID);
  assert.equal(duplicateOrder.status, 409);
  assert.equal((await responseJson(duplicateOrder)).message, '该订单 ID 已提交过');

  assert.equal(env.DB.submissions.length, 1);
  assert.equal(env.IMAGES.entries.size, 1);
});

test('admin list, image, and delete endpoints require authentication', async () => {
  const env = makeEnv();
  const ctx = makeContext();
  const requests = [
    new Request(`${ORIGIN}/api/admin/data`),
    new Request(`${ORIGIN}/api/admin/images/12345678-1234-1234-1234-123456789abc.png`),
    jsonRequest('/api/admin/delete', { id: '12345678-1234-1234-1234-123456789abc' }),
  ];

  for (const request of requests) {
    const response = await worker.fetch(request, env, ctx);
    assert.equal(response.status, 401);
    assert.equal((await responseJson(response)).message, '请先登录');
  }
});

test('login session cookie authorizes listing and returns public submission fields', async () => {
  const env = makeEnv();
  const ctx = makeContext();
  const id = '12345678-1234-1234-1234-123456789abc';
  env.DB.submissions.push({
    id,
    phone: VALID_PHONE,
    order_id: VALID_ORDER_ID,
    image_key: `${id}.png`,
    image_mime: 'image/png',
    status: 'pending',
    submitted_at: '2026-10-14T08:00:00.000Z',
  });

  const cookie = await login(env, ctx);
  const response = await worker.fetch(new Request(`${ORIGIN}/api/admin/submissions`, {
    headers: { Cookie: cookie },
  }), env, ctx);

  assert.equal(response.status, 200);
  const payload = await responseJson(response);
  const expected = {
    id,
    imageUrl: `/api/admin/images/${id}.png`,
    orderId: VALID_ORDER_ID,
    phone: VALID_PHONE,
    status: 'pending',
    submittedAt: '2026-10-14T08:00:00.000Z',
  };
  assert.equal(payload.success, true);
  assert.equal(payload.total, 1);
  assert.deepEqual(payload.data, [expected]);
  assert.deepEqual(payload.submissions, [expected]);
});

test('static assets receive browser security headers', async () => {
  const env = makeEnv();
  const response = await worker.fetch(new Request(`${ORIGIN}/index.html`), env, makeContext());

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'asset:/index.html');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
});
