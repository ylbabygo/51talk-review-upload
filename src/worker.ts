interface AppEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: KVNamespace;
  ADMIN_PASSWORD: string;
  ADMIN_SESSION_SECRET: string;
}

type SubmissionRow = {
  id: string;
  phone: string;
  order_id: string;
  image_key: string;
  image_mime: string;
  status: string;
  submitted_at: string;
};

type DetectedImage = {
  bytes: Uint8Array;
  extension: '.jpg' | '.png' | '.heic';
  mime: 'image/jpeg' | 'image/png' | 'image/heic';
};

const MAX_BODY_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SESSION_COOKIE = '__Host-admin_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: HeadersInit = {},
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return Response.json(data, { status, headers });
}

function secureResponse(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    secured.headers.set(name, value);
  }
  return secured;
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie') || '';
  for (const item of cookie.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function sessionCookie(token: string, maxAge: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    'Secure',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function passwordMatches(candidate: unknown, expected: string, secret: string): Promise<boolean> {
  if (typeof candidate !== 'string' || !expected || !secret) return false;
  const key = await importHmacKey(secret);
  const expectedSignature = await crypto.subtle.sign('HMAC', key, encoder.encode(expected));
  return crypto.subtle.verify('HMAC', key, expectedSignature, encoder.encode(candidate));
}

async function createSessionToken(secret: string): Promise<string> {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    nonce: crypto.randomUUID(),
  })));
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function verifySessionToken(token: string | null, secret: string): Promise<boolean> {
  if (!token || !secret) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;

  try {
    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(signature),
      encoder.encode(payload),
    );
    if (!valid) return false;

    const parsed = JSON.parse(decoder.decode(base64UrlToBytes(payload))) as { expiresAt?: unknown };
    return typeof parsed.expiresAt === 'number' && parsed.expiresAt > Date.now();
  } catch {
    return false;
  }
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('Content-Type')?.toLowerCase() || '';
  if (!contentType.startsWith('application/json')) {
    throw new ApiError(415, '请求格式必须为 JSON');
  }

  const contentLength = Number.parseInt(request.headers.get('Content-Length') || '0', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ApiError(413, '请求内容过大');
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new ApiError(413, '请求内容过大');

  try {
    const value: unknown = JSON.parse(decoder.decode(buffer));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('JSON object required');
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'JSON 格式错误');
  }
}

function hasPrefix(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function detectImageType(bytes: Uint8Array): Omit<DetectedImage, 'bytes'> | null {
  if (bytes.length >= 3 && hasPrefix(bytes, [0xff, 0xd8, 0xff])) {
    return { extension: '.jpg', mime: 'image/jpeg' };
  }
  if (bytes.length >= 8 && hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { extension: '.png', mime: 'image/png' };
  }
  if (bytes.length >= 12 && decoder.decode(bytes.subarray(4, 8)) === 'ftyp') {
    const brand = decoder.decode(bytes.subarray(8, 12)).toLowerCase();
    if (new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']).has(brand)) {
      return { extension: '.heic', mime: 'image/heic' };
    }
  }
  return null;
}

function decodeImageData(value: unknown): DetectedImage {
  if (typeof value !== 'string') throw new ApiError(400, '请上传好评截图');
  const match = value.match(/^data:image\/(?:jpeg|png|heic|heif);base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) throw new ApiError(400, '图片格式不支持');

  const base64 = match[1].replace(/\s/g, '');
  if (!base64 || base64.length % 4 !== 0 || !/^[a-z0-9+/]+={0,2}$/i.test(base64)) {
    throw new ApiError(400, '图片数据无效');
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const estimatedBytes = (base64.length * 3) / 4 - padding;
  if (estimatedBytes > MAX_IMAGE_BYTES) throw new ApiError(413, '图片大小不能超过 10MB');

  let bytes: Uint8Array;
  try {
    const binary = atob(base64);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ApiError(400, '图片数据无效');
  }

  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new ApiError(413, '图片大小不能超过 10MB');
  }
  const detected = detectImageType(bytes);
  if (!detected) throw new ApiError(400, '图片内容无效');
  return { bytes, ...detected };
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function applyRateLimit(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext,
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const now = Date.now();
  const nextReset = now + windowMs;
  const key = `${bucket}:${clientIp(request)}`;
  const entry = await env.DB.prepare(`
    INSERT INTO rate_limits (key, count, reset_at)
    VALUES (?1, 1, ?2)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limits.reset_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN ?2 ELSE rate_limits.reset_at END
    RETURNING count, reset_at
  `).bind(key, nextReset, now).first<{ count: number; reset_at: number }>();

  if (!entry) throw new Error('Rate limit state was not returned');
  if (crypto.getRandomValues(new Uint8Array(1))[0] === 0) {
    ctx.waitUntil(env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?1').bind(now - 86_400_000).run());
  }
  if (entry.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((entry.reset_at - now) / 1000));
    throw new ApiError(429, '请求过于频繁，请稍后再试', { 'Retry-After': String(retryAfter) });
  }
}

function publicSubmission(row: SubmissionRow) {
  return {
    id: row.id,
    imageUrl: `/api/admin/images/${encodeURIComponent(row.image_key)}`,
    orderId: row.order_id,
    phone: row.phone,
    status: row.status,
    submittedAt: row.submitted_at,
  };
}

async function requireAdmin(request: Request, env: AppEnv): Promise<void> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!await verifySessionToken(token, env.ADMIN_SESSION_SECRET)) {
    throw new ApiError(401, '请先登录');
  }
}

async function submitReview(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  await applyRateLimit(request, env, ctx, 'submit', 10, 15 * 60 * 1000);
  const body = await readJson(request, MAX_BODY_BYTES);
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';

  if (!/^1\d{10}$/.test(phone)) throw new ApiError(400, '手机号格式错误');
  if (!/^69\d{17}$/.test(orderId)) throw new ApiError(400, '订单 ID 格式错误');

  const duplicate = await env.DB.prepare(
    'SELECT phone, order_id FROM submissions WHERE phone = ?1 OR order_id = ?2 LIMIT 1',
  ).bind(phone, orderId).first<{ phone: string; order_id: string }>();
  if (duplicate) {
    throw new ApiError(409, duplicate.phone === phone ? '该手机号已提交过' : '该订单 ID 已提交过');
  }

  const image = decodeImageData(body.imageData);
  const id = crypto.randomUUID();
  const imageKey = `${id}${image.extension}`;
  const submittedAt = new Date().toISOString();

  const imageBuffer = image.bytes.buffer.slice(
    image.bytes.byteOffset,
    image.bytes.byteOffset + image.bytes.byteLength,
  ) as ArrayBuffer;
  await env.IMAGES.put(imageKey, imageBuffer, {
    metadata: { contentType: image.mime, submissionId: id },
  });

  try {
    await env.DB.prepare(`
      INSERT INTO submissions (id, phone, order_id, image_key, image_mime, status, submitted_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)
    `).bind(id, phone, orderId, imageKey, image.mime, submittedAt).run();
  } catch (error) {
    await env.IMAGES.delete(imageKey);
    if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
      throw new ApiError(409, '手机号或订单 ID 已提交过');
    }
    throw error;
  }

  return json({ success: true, message: '提交成功' });
}

async function adminLogin(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  await applyRateLimit(request, env, ctx, 'admin-login', 10, 15 * 60 * 1000);
  const body = await readJson(request, 16 * 1024);
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    throw new ApiError(503, '管理员凭据尚未配置');
  }
  if (!await passwordMatches(body.password, env.ADMIN_PASSWORD, env.ADMIN_SESSION_SECRET)) {
    throw new ApiError(401, '密码错误');
  }

  const token = await createSessionToken(env.ADMIN_SESSION_SECRET);
  return json({ success: true }, 200, {
    'Set-Cookie': sessionCookie(token, SESSION_TTL_SECONDS),
  });
}

async function listSubmissions(request: Request, env: AppEnv): Promise<Response> {
  await requireAdmin(request, env);
  const result = await env.DB.prepare(`
    SELECT id, phone, order_id, image_key, image_mime, status, submitted_at
    FROM submissions
    ORDER BY submitted_at DESC
  `).all<SubmissionRow>();
  const submissions = result.results.map(publicSubmission);
  return json({ success: true, data: submissions, submissions, total: submissions.length });
}

async function getImage(request: Request, env: AppEnv, pathname: string): Promise<Response> {
  await requireAdmin(request, env);
  const imageKey = decodeURIComponent(pathname.slice('/api/admin/images/'.length));
  if (!/^[a-f0-9-]{20,}\.(?:jpg|png|heic)$/i.test(imageKey)) {
    throw new ApiError(404, '图片不存在');
  }

  const image = await env.IMAGES.getWithMetadata<{ contentType?: string }>(imageKey, 'stream');
  if (!image.value) throw new ApiError(404, '图片不存在');
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'Cache-Control': 'private, no-store',
    'Content-Type': image.metadata?.contentType || 'application/octet-stream',
  });
  return new Response(image.value, { headers });
}

async function deleteSubmission(request: Request, env: AppEnv): Promise<Response> {
  await requireAdmin(request, env);
  const body = await readJson(request, 16 * 1024);
  const id = typeof body.id === 'string' ? body.id : '';
  if (!/^[a-f0-9-]{20,}$/i.test(id)) throw new ApiError(400, 'ID 参数无效');

  const row = await env.DB.prepare('SELECT image_key FROM submissions WHERE id = ?1')
    .bind(id)
    .first<{ image_key: string }>();
  if (!row) throw new ApiError(404, '数据不存在');

  await env.DB.prepare('DELETE FROM submissions WHERE id = ?1').bind(id).run();
  await env.IMAGES.delete(row.image_key);
  return json({ success: true, message: '删除成功' });
}

async function handleApi(request: Request, env: AppEnv, ctx: ExecutionContext, pathname: string): Promise<Response> {
  if (request.method === 'POST' && !isSameOrigin(request)) {
    throw new ApiError(403, '请求来源无效');
  }
  if (pathname === '/api/submit' && request.method === 'POST') {
    return submitReview(request, env, ctx);
  }
  if (pathname === '/api/admin/login' && request.method === 'POST') {
    return adminLogin(request, env, ctx);
  }
  if (pathname === '/api/admin/logout' && request.method === 'POST') {
    return json({ success: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if ((pathname === '/api/admin/data' || pathname === '/api/admin/submissions') && request.method === 'GET') {
    return listSubmissions(request, env);
  }
  if (pathname.startsWith('/api/admin/images/') && request.method === 'GET') {
    return getImage(request, env, pathname);
  }
  if (pathname === '/api/admin/delete' && request.method === 'POST') {
    return deleteSubmission(request, env);
  }
  throw new ApiError(404, 'API not found');
}

async function fetchHandler(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(request, env, ctx, url.pathname);
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return json({ success: false, message: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
    }

    return secureResponse(await env.ASSETS.fetch(request));
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ success: false, message: error.message }, error.status, error.headers);
    }
    console.error(JSON.stringify({
      event: 'request_failed',
      method: request.method,
      path: url.pathname,
      message: error instanceof Error ? error.message : String(error),
    }));
    return json({ success: false, message: '服务暂时不可用，请稍后再试' }, 500);
  }
}

export default { fetch: fetchHandler } satisfies ExportedHandler<AppEnv>;
