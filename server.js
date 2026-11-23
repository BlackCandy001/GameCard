/**
 * Liar's Bar Web Server (Zero-dependency for Wispbyte / Pterodactyl / Node.js)
 * Tự động nhận biến môi trường PORT từ Wispbyte / Docker container.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Wispbyte và Pterodactyl Panel thường truyền cổng qua process.env.PORT hoặc process.env.SERVER_PORT
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || '3000', 10);
const HOST = '0.0.0.0'; // Bắt buộc lắng nghe 0.0.0.0 trong môi trường container
const BASE_DIR = path.resolve(__dirname);

// Bảng MIME Type
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8'
};

// Route viết tắt thân thiện
const ROUTE_ALIASES = {
  '/': '/index.html',
  '/deck': '/index.html',
  '/liardeck': '/index.html',
  '/liarpoker': '/LiarPoker.html',
  '/poker': '/poker.html',
  '/pokermode': '/PokerMode.html'
};

const server = http.createServer((req, res) => {
  // Chỉ hỗ trợ GET và HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
    return;
  }

  // Phân tích URL
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  let pathname = parsedUrl.pathname;

  // Endpoint kiểm tra sức khỏe server (Healthcheck cho monitoring/hosting)
  if (pathname === '/health' || pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() }));
    return;
  }

  // Ánh xạ route thân thiện nếu có
  if (ROUTE_ALIASES[pathname]) {
    pathname = ROUTE_ALIASES[pathname];
  }

  // Decode URI và chuẩn hóa đường dẫn để chống Directory Traversal (tấn công ../)
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request: Invalid URI');
    return;
  }

  const normalizedPath = path.normalize(decodedPath).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(BASE_DIR, normalizedPath);

  // Đảm bảo không thoát khỏi thư mục gốc BASE_DIR
  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  // Kiểm tra file tồn tại
  fs.stat(filePath, (err, stats) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>404 Not Found</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#eee;">
          <h1>404 - Không tìm thấy trang</h1>
          <p><a href="/" style="color:#f59e0b;">Quay lại Liar's Bar</a> | <a href="/poker.html" style="color:#ef4444;">Vào Liar's Poker</a></p>
        </body></html>`);
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 Internal Server Error');
      return;
    }

    // Nếu đường dẫn là thư mục, tìm index.html bên trong
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      fs.stat(filePath, (subErr, subStats) => {
        if (subErr || !subStats.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('404 Not Found');
          return;
        }
        serveFile(req, res, filePath, subStats);
      });
      return;
    }

    if (!stats.isFile()) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }

    serveFile(req, res, filePath, stats);
  });
});

function serveFile(req, res, filePath, stats) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  const headers = {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*'
  };

  // Caching: File tĩnh như CSS/JS/Vendor có thể cache ngắn hạn; HTML không cache để cập nhật ngay
  if (ext === '.html') {
    headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
  } else {
    headers['Cache-Control'] = 'public, max-age=86400';
  }

  // HEAD request chỉ trả header
  if (req.method === 'HEAD') {
    headers['Content-Length'] = stats.size;
    res.writeHead(200, headers);
    res.end();
    return;
  }

  // Nén gzip cho text/js/css/html nếu client hỗ trợ
  const acceptEncoding = req.headers['accept-encoding'] || '';
  const isCompressible = /text|javascript|json|svg/i.test(contentType) && stats.size > 1024;

  if (isCompressible && acceptEncoding.includes('gzip')) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    const rawStream = fs.createReadStream(filePath);
    const gzip = zlib.createGzip({ level: 6 });
    rawStream.pipe(gzip).pipe(res);
  } else {
    headers['Content-Length'] = stats.size;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  }
}

// Bắt đầu lắng nghe
server.listen(PORT, HOST, () => {
  console.log('====================================================');
  console.log(`[Liar's Bar] Server da khoi dong thanh cong!`);
  console.log(`- Cong lang nghe : ${PORT}`);
  console.log(`- Che do host    : ${HOST}`);
  console.log(`- Liar's Deck    : http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`);
  console.log(`- Liar's Poker   : http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/poker.html`);
  console.log('====================================================');
});

// Xử lý dừng máy chủ an toàn (graceful shutdown)
function shutdown(signal) {
  console.log(`\nNhan tin hieu ${signal}, dang dong server...`);
  server.close(() => {
    console.log('Server da dong hoan toan.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Buoc dung do het timeout.');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
