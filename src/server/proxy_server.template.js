/**
 * Universal Intelligent Hybrid Local & Fallback Proxy Server
 * 
 * 1. Serves all local static assets with high performance and accurate MIME types.
 * 2. On-Demand Upstream Caching: If an asset is requested that is missing locally,
 *    it fetches it from UPSTREAM, serves it to the browser, and saves it to disk
 *    so subsequent requests are 100% offline.
 * 3. API Mock Layer: Intercepts POST/API requests to prevent console errors.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.env.PORT || '{{PORT}}', 10);
const ROOT = __dirname;
const UPSTREAM = '{{UPSTREAM}}';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm'
};

function fetchUpstream(upstreamUrl, filePath, reqHeaders, res) {
  const parsed = url.parse(upstreamUrl);
  const isHttps = parsed.protocol === 'https:';
  const client = isHttps ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.path,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': reqHeaders.accept || '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': UPSTREAM
    }
  };

  const proxyReq = client.request(options, (upstreamRes) => {
    // Follow redirect if 301/302
    if ((upstreamRes.statusCode === 301 || upstreamRes.statusCode === 302) && upstreamRes.headers.location) {
      const redirectUrl = url.resolve(upstreamUrl, upstreamRes.headers.location);
      return fetchUpstream(redirectUrl, filePath, reqHeaders, res);
    }

    if (upstreamRes.statusCode === 200) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const fileStream = fs.createWriteStream(filePath);
        upstreamRes.pipe(fileStream);
      } catch (err) {
        console.warn(`[Proxy Write Warning] Failed to write ${filePath}: ${err.message}`);
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = upstreamRes.headers['content-type'] || MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*'
      });
      upstreamRes.pipe(res);
    } else {
      res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'text/plain' });
      res.end(`Upstream returned status ${upstreamRes.statusCode}`);
    }
  });

  proxyReq.on('error', (err) => {
    console.error(`[Proxy Error] ${upstreamUrl}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('502 Bad Gateway (Upstream fetch failed)');
    }
  });

  proxyReq.end();
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = decodeURIComponent(parsedUrl.pathname);

  // Set global CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, RSC, Next-Router-State-Tree, Next-Router-Prefetch, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Mock Layer
  if (pathname.startsWith('/api/') || pathname.startsWith('/_next/data/')) {
    if (req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'success', timestamp: Date.now() }));
      return;
    }
  }

  if (pathname === '/') {
    pathname = '/index.html';
  }

  // Normalize path
  let safePath = pathname.replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(ROOT, safePath);

  // Check if directory, try index.html
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch (e) {
    // Does not exist yet, check with .html extension
    if (!path.extname(filePath)) {
      const htmlCandidate = filePath + '.html';
      if (fs.existsSync(htmlCandidate)) {
        filePath = htmlCandidate;
      }
    }
  }

  // Check if file exists locally
  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600'
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // Asset missing locally: Fetch from Upstream
    if (UPSTREAM && UPSTREAM !== 'https://example.com') {
      const upstreamUrl = url.resolve(UPSTREAM, req.url);
      console.log(`[Cache Miss] Fetching from upstream: ${upstreamUrl}`);
      fetchUpstream(upstreamUrl, filePath, req.headers, res);
      return;
    }

    // Fallback: If no extension, serve index.html (SPA routing)
    const indexPath = path.join(ROOT, 'index.html');
    if (!path.extname(pathname) && fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Cloned site running at http://localhost:${PORT}`);
  console.log(`📡 Upstream fallback target: ${UPSTREAM}`);
});
