const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = __dirname;
const PORT = Number.parseInt(process.env.DEPLOY_RUN_PORT || process.env.PORT || '5000', 10);
const DEFAULT_MAX_BODY_BYTES = 15 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SESSION_COOKIE = 'admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sendJSON(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function sendBuffer(res, statusCode, data, contentType, cacheControl = 'no-store') {
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Cache-Control': cacheControl,
    'Content-Type': contentType,
  });
  res.end(data);
}

function parseCookies(req) {
  const result = {};
  const rawCookie = req.headers.cookie || '';

  for (const part of rawCookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;

    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }

  return result;
}

function passwordMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || !expected) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function parseJSONBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      reject(new HttpError(415, '请求格式必须为 JSON'));
      return;
    }

    const contentLength = Number.parseInt(req.headers['content-length'] || '0', 10);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      reject(new HttpError(413, '请求内容过大'));
      req.resume();
      return;
    }

    let body = '';
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
        body = '';
        return;
      }
      if (!tooLarge) body += chunk.toString('utf8');
    });

    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, '请求内容过大'));
        return;
      }

      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new HttpError(400, 'JSON 格式错误'));
      }
    });

    req.on('aborted', () => reject(new HttpError(400, '请求已中断')));
    req.on('error', reject);
  });
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: '.jpg', mime: 'image/jpeg' };
  }

  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length >= pngSignature.length && buffer.subarray(0, 8).equals(pngSignature)) {
    return { extension: '.png', mime: 'image/png' };
  }

  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12).toLowerCase();
    const heicBrands = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);
    if (heicBrands.has(brand)) return { extension: '.heic', mime: 'image/heic' };
  }

  return null;
}

function decodeImageData(imageData, maxImageBytes) {
  if (typeof imageData !== 'string') throw new HttpError(400, '请上传好评截图');

  const match = imageData.match(/^data:image\/(?:jpeg|png|heic|heif);base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) throw new HttpError(400, '图片格式不支持');

  const base64 = match[1].replace(/\s/g, '');
  if (!base64 || base64.length % 4 !== 0 || !/^[a-z0-9+/]+={0,2}$/i.test(base64)) {
    throw new HttpError(400, '图片数据无效');
  }

  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes > maxImageBytes) throw new HttpError(413, '图片大小不能超过 10MB');

  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.length > maxImageBytes) throw new HttpError(413, '图片大小不能超过 10MB');

  const detectedType = detectImageType(buffer);
  if (!detectedType) throw new HttpError(400, '图片内容无效');

  return { buffer, ...detectedType };
}

function sanitizeSubmission(item) {
  const imageFilename = item.imageUrl ? path.basename(item.imageUrl) : null;
  return {
    id: String(item.id || ''),
    imageUrl: imageFilename ? `/api/admin/images/${encodeURIComponent(imageFilename)}` : null,
    orderId: String(item.orderId || ''),
    phone: String(item.phone || ''),
    status: String(item.status || 'pending'),
    submittedAt: item.submittedAt,
  };
}

function createAppServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data'));
  const imageDir = path.join(dataDir, 'images');
  const dataFile = path.join(dataDir, 'submissions.json');
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? '';
  const maxBodyBytes = options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;
  const maxImageBytes = options.maxImageBytes || DEFAULT_MAX_IMAGE_BYTES;
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production';
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === 'true';
  const sessions = new Map();
  const rateLimits = new Map();
  let mutationQueue = Promise.resolve();

  fs.mkdirSync(imageDir, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, `${JSON.stringify({ submissions: [] }, null, 2)}\n`, { mode: 0o600 });
  }

  function readData() {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (!parsed || !Array.isArray(parsed.submissions)) throw new Error('Invalid submissions data');
    return parsed;
  }

  function writeData(data) {
    const temporaryFile = `${dataFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryFile, dataFile);
  }

  function withDataLock(task) {
    const next = mutationQueue.then(task, task);
    mutationQueue = next.catch(() => {});
    return next;
  }

  function getClientIp(req) {
    if (trustProxy && req.headers['x-forwarded-for']) {
      return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function applyRateLimit(req, res, bucket, maxRequests, windowMs) {
    const now = Date.now();
    const key = `${bucket}:${getClientIp(req)}`;
    let entry = rateLimits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimits.set(key, entry);
    }

    entry.count += 1;
    if (entry.count <= maxRequests) return true;

    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    sendJSON(res, 429, { success: false, message: '请求过于频繁，请稍后再试' }, {
      'Retry-After': String(retryAfter),
    });
    return false;
  }

  function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  function isAdmin(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return false;
    const expiresAt = sessions.get(token);
    if (!expiresAt || expiresAt <= Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function requireAdmin(req, res) {
    if (isAdmin(req)) return true;
    sendJSON(res, 401, { success: false, message: '请先登录' });
    return false;
  }

  function sessionCookie(token, maxAgeSeconds) {
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'HttpOnly',
      'Path=/',
      'SameSite=Strict',
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  function resolveStaticFile(urlPath) {
    if (urlPath === '/' || urlPath === '/index.html') return path.join(ROOT, 'index.html');
    if (urlPath === '/admin' || urlPath === '/admin.html') return path.join(ROOT, 'admin.html');

    for (const directory of ['public', 'styles']) {
      const prefix = `/${directory}/`;
      if (!urlPath.startsWith(prefix)) continue;
      const relativePath = urlPath.slice(prefix.length);
      const baseDirectory = path.join(ROOT, directory);
      const resolvedPath = path.resolve(baseDirectory, relativePath);
      if (resolvedPath.startsWith(`${baseDirectory}${path.sep}`)) return resolvedPath;
    }

    return null;
  }

  async function handleApi(req, res, urlPath) {
    if (req.method === 'POST' && !isSameOriginRequest(req)) {
      sendJSON(res, 403, { success: false, message: '请求来源无效' });
      return;
    }

    if (urlPath === '/api/submit' && req.method === 'POST') {
      if (!applyRateLimit(req, res, 'submit', 10, 15 * 60 * 1000)) return;

      try {
        const body = await parseJSONBody(req, maxBodyBytes);
        const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
        const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';

        if (!/^1\d{10}$/.test(phone)) throw new HttpError(400, '手机号格式错误');
        if (!/^69\d{17}$/.test(orderId)) throw new HttpError(400, '订单 ID 格式错误');

        const image = decodeImageData(body.imageData, maxImageBytes);

        await withDataLock(() => {
          const data = readData();
          const duplicate = data.submissions.find((item) => item.phone === phone || item.orderId === orderId);
          if (duplicate) {
            throw new HttpError(409, duplicate.phone === phone ? '该手机号已提交过' : '该订单 ID 已提交过');
          }

          const id = crypto.randomUUID();
          const filename = `${id}${image.extension}`;
          const imagePath = path.join(imageDir, filename);
          fs.writeFileSync(imagePath, image.buffer, { flag: 'wx', mode: 0o600 });

          const submission = {
            id,
            phone,
            orderId,
            imageUrl: `/data/images/${filename}`,
            status: 'pending',
            submittedAt: new Date().toISOString(),
          };

          try {
            data.submissions.unshift(submission);
            writeData(data);
          } catch (error) {
            fs.rmSync(imagePath, { force: true });
            throw error;
          }
        });

        sendJSON(res, 200, { success: true, message: '提交成功' });
      } catch (error) {
        const statusCode = error.statusCode || 500;
        if (statusCode >= 500) console.error('[api] submit failed:', error.message);
        sendJSON(res, statusCode, {
          success: false,
          message: statusCode >= 500 ? '提交失败，请稍后再试' : error.message,
        });
      }
      return;
    }

    if (urlPath === '/api/admin/login' && req.method === 'POST') {
      if (!applyRateLimit(req, res, 'admin-login', 10, 15 * 60 * 1000)) return;

      try {
        const body = await parseJSONBody(req, 16 * 1024);
        if (!adminPassword) {
          sendJSON(res, 503, { success: false, message: '管理员密码尚未配置' });
          return;
        }
        if (!passwordMatches(body.password, adminPassword)) {
          sendJSON(res, 401, { success: false, message: '密码错误' });
          return;
        }

        const token = createSession();
        sendJSON(res, 200, { success: true }, {
          'Set-Cookie': sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)),
        });
      } catch (error) {
        sendJSON(res, error.statusCode || 500, {
          success: false,
          message: error.statusCode ? error.message : '登录失败',
        });
      }
      return;
    }

    if (urlPath === '/api/admin/logout' && req.method === 'POST') {
      const token = parseCookies(req)[SESSION_COOKIE];
      if (token) sessions.delete(token);
      sendJSON(res, 200, { success: true }, {
        'Set-Cookie': sessionCookie('', 0),
      });
      return;
    }

    if ((urlPath === '/api/admin/data' || urlPath === '/api/admin/submissions') && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;

      try {
        const data = readData();
        const submissions = data.submissions.map(sanitizeSubmission);
        sendJSON(res, 200, { success: true, data: submissions, submissions, total: submissions.length });
      } catch (error) {
        console.error('[api] read submissions failed:', error.message);
        sendJSON(res, 500, { success: false, message: '获取数据失败' });
      }
      return;
    }

    if (urlPath.startsWith('/api/admin/images/') && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const filename = path.basename(urlPath.slice('/api/admin/images/'.length));
      if (!/^[a-f0-9-]+\.(?:jpg|png|heic)$/i.test(filename)) {
        sendJSON(res, 404, { success: false, message: '图片不存在' });
        return;
      }

      const imagePath = path.join(imageDir, filename);
      fs.readFile(imagePath, (error, data) => {
        if (error) {
          sendJSON(res, 404, { success: false, message: '图片不存在' });
          return;
        }
        sendBuffer(res, 200, data, MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream');
      });
      return;
    }

    if (urlPath === '/api/admin/delete' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;

      try {
        const body = await parseJSONBody(req, 16 * 1024);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!/^[a-f0-9-]{20,}$/i.test(id)) throw new HttpError(400, 'ID 参数无效');

        let removedSubmission;
        await withDataLock(() => {
          const data = readData();
          const index = data.submissions.findIndex((item) => item.id === id);
          if (index === -1) throw new HttpError(404, '数据不存在');
          [removedSubmission] = data.submissions.splice(index, 1);
          writeData(data);
        });

        if (removedSubmission.imageUrl) {
          const filename = path.basename(removedSubmission.imageUrl);
          if (/^[a-f0-9-]+\.(?:jpg|png|heic)$/i.test(filename)) {
            fs.rmSync(path.join(imageDir, filename), { force: true });
          }
        }

        sendJSON(res, 200, { success: true, message: '删除成功' });
      } catch (error) {
        const statusCode = error.statusCode || 500;
        if (statusCode >= 500) console.error('[api] delete failed:', error.message);
        sendJSON(res, statusCode, {
          success: false,
          message: statusCode >= 500 ? '删除失败' : error.message,
        });
      }
      return;
    }

    sendJSON(res, 404, { success: false, message: 'API not found' });
  }

  return http.createServer(async (req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      sendJSON(res, 400, { success: false, message: 'URL 格式错误' });
      return;
    }

    if (urlPath.startsWith('/api/')) {
      await handleApi(req, res, urlPath);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJSON(res, 405, { success: false, message: 'Method not allowed' }, { Allow: 'GET, HEAD' });
      return;
    }

    const filePath = resolveStaticFile(urlPath);
    if (!filePath) {
      sendJSON(res, 404, { success: false, message: 'Not found' });
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        sendJSON(res, 404, { success: false, message: 'Not found' });
        return;
      }

      const contentType = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      const cacheControl = contentType.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600';
      if (req.method === 'HEAD') {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Cache-Control': cacheControl, 'Content-Type': contentType });
        res.end();
        return;
      }
      sendBuffer(res, 200, data, contentType, cacheControl);
    });
  });
}

if (require.main === module) {
  const server = createAppServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on 0.0.0.0:${PORT}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('[server] ADMIN_PASSWORD is not configured; admin login is disabled');
    }
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, shutting down`);
    const forceExit = setTimeout(() => process.exit(1), 5000);
    forceExit.unref();
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    console.error('[server] uncaught exception:', error.message);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled rejection:', reason instanceof Error ? reason.message : String(reason));
    shutdown('unhandledRejection');
  });
}

module.exports = {
  createAppServer,
  decodeImageData,
  detectImageType,
};
