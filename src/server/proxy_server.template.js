/**
 * Universal Intelligent Hybrid Local & Fallback Proxy Server
 * 
 * 1. Serves all local static assets with high performance and accurate MIME types (including magic-byte sniffing).
 * 2. Resolves query-hashed extensionless endpoints and /external/<host>/... CDN routes locally.
 * 3. On-Demand Upstream Caching: If an asset is requested that is missing locally,
 *    it fetches it from UPSTREAM (or the external CDN host), serves it to the browser,
 *    and saves it to disk so subsequent requests are 100% offline.
 * 4. API Mock Layer: Intercepts POST/API requests to prevent console errors.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.env.PORT || '{{PORT}}', 10);
const ROOT = __dirname;
const RESOLVED_ROOT = path.resolve(ROOT);
const UPSTREAM = '{{UPSTREAM}}';

const DISCOVERED_ENDPOINTS = new Set();
try {
  for (const manifestFile of ['clone-manifest.json', 'rea-bundle.json']) {
    const mPath = path.join(RESOLVED_ROOT, manifestFile);
    if (fs.existsSync(mPath)) {
      const data = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      const reaData = data.rea || data;
      const eps = Array.isArray(reaData.endpoints) ? reaData.endpoints : [];
      for (const ep of eps) {
        if (typeof ep === 'string' && ep.startsWith('/')) {
          DISCOVERED_ENDPOINTS.add(ep.split('?')[0]);
        }
      }
    }
  }
} catch {}

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

function detectMimeFromBuffer(buf, fallbackExt = '') {
  if (fallbackExt && MIME_TYPES[fallbackExt]) {
    return MIME_TYPES[fallbackExt];
  }
  if (!buf || buf.length === 0) {
    return 'application/octet-stream';
  }
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return 'image/jpeg';
  }
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 4 && buf.slice(0, 4).toString('ascii') === 'GIF8') {
    return 'image/gif';
  }
  if (buf.length >= 12 && buf.slice(4, 12).toString('ascii') === 'ftypavif') {
    return 'image/avif';
  }
  if (buf.length >= 4 && buf.slice(0, 4).toString('ascii') === 'wOF2') {
    return 'font/woff2';
  }
  if (buf.length >= 4 && buf.slice(0, 4).toString('ascii') === 'wOFF') {
    return 'font/woff';
  }

  const headText = buf.slice(0, 64).toString('utf8').trimStart().toLowerCase();
  if (headText.startsWith('<svg') || (headText.startsWith('<?xml') && headText.includes('<svg'))) {
    return 'image/svg+xml';
  }
  if (headText.startsWith('<!doctype') || headText.startsWith('<html')) {
    return 'text/html; charset=utf-8';
  }
  if (headText.startsWith('{') || headText.startsWith('[')) {
    return 'application/json; charset=utf-8';
  }
  return 'application/octet-stream';
}

function isPathInsideRoot(targetPath) {
  const rel = path.relative(RESOLVED_ROOT, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

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
  let pathname;
  try {
    pathname = decodeURIComponent(parsedUrl.pathname || '/');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('400 Bad Request');
    return;
  }

  // Set global CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, RSC, Next-Router-State-Tree, Next-Router-Prefetch, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Mock Layer (handles POST/PUT/DELETE mutations and REA-discovered API routes without local files)
  const isDiscoveredEndpoint = DISCOVERED_ENDPOINTS.has(pathname);
  if (pathname.startsWith('/api/') || pathname.startsWith('/_next/data/') || isDiscoveredEndpoint) {
    const candidateLocal = path.resolve(RESOLVED_ROOT, '.' + pathname);
    if (!isPathInsideRoot(candidateLocal)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden');
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' || (isDiscoveredEndpoint && !fs.existsSync(candidateLocal))) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, status: 'success', mocked: true, endpoint: pathname, timestamp: Date.now() }));
      return;
    }
  }

  if (pathname === '/') {
    pathname = '/index.html';
  }

  // Resolve and verify path stays within ROOT (prevents path traversal)
  let filePath = path.resolve(RESOLVED_ROOT, '.' + pathname);
  if (!isPathInsideRoot(filePath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  // Check query-hashed extensionless file first when query parameters exist
  let hasHashedMatch = false;
  if (parsedUrl.search && !path.extname(filePath)) {
    const qHash = crypto.createHash('md5').update(parsedUrl.search).digest('hex').slice(0, 8);
    const hashedCandidate = `${filePath}_${qHash}`;
    if (fs.existsSync(hashedCandidate)) {
      filePath = hashedCandidate;
      hasHashedMatch = true;
    }
  }

  if (!hasHashedMatch) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
    } catch (e) {
      if (!path.extname(filePath)) {
        const htmlCandidate = filePath + '.html';
        if (fs.existsSync(htmlCandidate)) {
          filePath = htmlCandidate;
        }
      }
    }
  }

  // Check if file exists locally
  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      let contentType = MIME_TYPES[ext];
      if (!contentType) {
        try {
          const fd = fs.openSync(filePath, 'r');
          const headBuf = Buffer.alloc(64);
          const bytesRead = fs.readSync(fd, headBuf, 0, 64, 0);
          fs.closeSync(fd);
          contentType = detectMimeFromBuffer(headBuf.subarray(0, bytesRead), ext);
        } catch {
          contentType = 'application/octet-stream';
        }
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600'
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // External CDN route cache miss: /external/<host>/<rest>
    if (pathname.startsWith('/external/')) {
      const extMatch = pathname.match(/^\/external\/([^/]+)\/(.+)$/);
      if (extMatch) {
        const externalUpstreamUrl = `https://${extMatch[1]}/${extMatch[2]}${parsedUrl.search || ''}`;
        console.log(`[External Cache Miss] Fetching from CDN: ${externalUpstreamUrl}`);
        fetchUpstream(externalUpstreamUrl, filePath, req.headers, res);
        return;
      }
    }

    // Asset missing locally: Fetch from Upstream
    if (UPSTREAM && UPSTREAM !== 'https://example.com') {
      const upstreamUrl = url.resolve(UPSTREAM, req.url);
      console.log(`[Cache Miss] Fetching from upstream: ${upstreamUrl}`);
      let cachePath = filePath;
      if (parsedUrl.search && !path.extname(cachePath)) {
        const qHash = crypto.createHash('md5').update(parsedUrl.search).digest('hex').slice(0, 8);
        cachePath = `${cachePath}_${qHash}`;
      }
      fetchUpstream(upstreamUrl, cachePath, req.headers, res);
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
