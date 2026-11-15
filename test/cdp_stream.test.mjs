// test/cdp_stream.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { captureRuntime } from '../src/engine/cdp_capture.mjs';

const fixtureServer = http.createServer((req, res) => {
  const reqPath = (req.url || '/').split('?')[0];
  if (reqPath === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ greeting: 'hello-mimic', headerSeen: req.headers['x-mimic-test'] || null }));
    return;
  }
  if (reqPath === '/about') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><head><title>About</title></head><body><h1>About Page</h1></body></html>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><title>Mimic Fixture</title></head><body>
    <h1>Mimic Test App</h1>
    <a href="/about">About</a>
    <div id="api-out"></div>
    <script>fetch('/api/data').then(r => r.json()).then(d => { document.getElementById('api-out').textContent = d.greeting; });</script>
  </body></html>`);
});

await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
const { port } = fixtureServer.address();
const localUrl = `http://127.0.0.1:${port}`;

const testDir = path.resolve('test-output-stream');
try {
  fs.rmSync(testDir, { recursive: true, force: true });
} catch {}

try {
  const result = await captureRuntime(localUrl, testDir, {
    waitMs: 1500,
    scroll: false,
    crawl: true,
    maxRoutes: 5,
    headers: { 'X-Mimic-Test': 'ok' },
    quiet: true
  });

  assert.ok(fs.existsSync(path.join(testDir, 'index.html')), 'index.html must exist');
  const htmlContent = fs.readFileSync(path.join(testDir, 'index.html'), 'utf-8');
  assert.ok(htmlContent.trim().toLowerCase().startsWith('<!doctype html>'), 'index.html must start with <!DOCTYPE html>');
  assert.ok(fs.existsSync(path.join(testDir, 'screenshot.png')), 'screenshot.png must exist');
  assert.ok(fs.existsSync(path.join(testDir, 'baseline-desktop.png')), 'baseline-desktop.png must exist');
  assert.ok(fs.existsSync(path.join(testDir, 'about', 'index.html')), 'crawled /about/index.html must exist');

  const fixturesPath = path.join(testDir, 'mocks', 'fixtures.json');
  assert.ok(fs.existsSync(fixturesPath), 'mocks/fixtures.json must exist');
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf-8'));
  assert.ok(fixtures['GET:/api/data'], 'GET:/api/data fixture must be recorded');
  assert.ok(fixtures['GET:/api/data'].body.includes('hello-mimic'), 'Recorded fixture must contain API payload');

  const manifestPath = path.join(testDir, 'clone-manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'clone-manifest.json must exist');
  const manifestStat = fs.statSync(manifestPath);
  assert.ok(manifestStat.size < 4096, `clone-manifest.json must remain compact (< 4KB, got ${manifestStat.size})`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  assert.ok(manifest.page && typeof manifest.page.title === 'string', 'manifest must contain page.title');
  assert.ok(manifest.mimeBreakdown && typeof manifest.mimeBreakdown === 'object', 'manifest must contain mimeBreakdown');
  assert.deepEqual(manifest.crawledRoutes, ['/about']);

  assert.ok(result && typeof result.assetCount === 'number', 'result must return assetCount');

  // Verify hard timeout wrapper rejects cleanly and cleans up Chrome
  const timeoutDir = path.resolve('test-output-timeout');
  await assert.rejects(
    () => captureRuntime(localUrl, timeoutDir, { timeout: 200, quiet: true }),
    /timed out/i,
    'captureRuntime must reject when timeout budget expires'
  );
  try {
    fs.rmSync(timeoutDir, { recursive: true, force: true });
  } catch {}
} finally {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}
  fixtureServer.close();
}

console.log('✓ cdp_stream integration test passed');
