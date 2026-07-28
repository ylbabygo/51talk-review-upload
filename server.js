const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.DEPLOY_RUN_PORT || process.env.PORT || '5000', 10);
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Security: prevent path traversal
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, safePath);

  // Ensure filePath is within ROOT
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: serve index.html for non-file routes
      if (!ext) {
        fs.readFile(path.join(ROOT, 'index.html'), (err2, data2) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(data2);
          }
        });
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(data);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on 0.0.0.0:${PORT}`);
  console.log(`[server] root: ${ROOT}`);
  console.log(`[server] DEPLOY_RUN_PORT=${process.env.DEPLOY_RUN_PORT || 'unset'}`);
  console.log(`[server] PORT=${process.env.PORT || 'unset'}`);
});

server.on('error', (err) => {
  console.error(`[server] error: ${err.message}`);
  console.error(`[server] stack: ${err.stack}`);
});

// Prevent process from exiting
process.stdin.resume();

// Handle signals gracefully - do NOT exit
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, keeping alive...');
});

process.on('SIGINT', () => {
  console.log('[server] SIGINT received, keeping alive...');
});

// Catch unhandled errors
process.on('uncaughtException', (err) => {
  console.error(`[server] uncaughtException: ${err.message}`);
  console.error(`[server] stack: ${err.stack}`);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[server] unhandledRejection: ${reason}`);
});
