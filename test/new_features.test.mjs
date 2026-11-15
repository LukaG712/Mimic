import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChromePath, getChromeLaunchArgs } from '../src/engine/chrome_finder.mjs';
import { comparePngFiles, decodePng, encodeRgbaPng } from '../src/engine/png_diff.mjs';
import { scaffoldCloneManifests } from '../src/engine/cdp_capture.mjs';

// 1. Cross-platform Chrome finder
const chromePath = findChromePath();
assert.ok(fs.existsSync(chromePath), `Detected Chrome path must exist: ${chromePath}`);
const launchArgs = getChromeLaunchArgs(9222);
assert.ok(launchArgs.includes('--headless=new'));
assert.ok(launchArgs.includes('--remote-debugging-port=9222'));

// 2. Zero-dependency PNG encode/decode + pixel diff
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-new-features-'));
try {
  const width = 4;
  const height = 4;
  const rgbaA = Buffer.alloc(width * height * 4, 255);
  const rgbaB = Buffer.from(rgbaA);
  // Flip 2 pixels in rgbaB to black
  for (let p = 0; p < 2; p++) {
    rgbaB[p * 4] = 0;
    rgbaB[p * 4 + 1] = 0;
    rgbaB[p * 4 + 2] = 0;
  }

  const pngA = path.join(tmpDir, 'a.png');
  const pngB = path.join(tmpDir, 'b.png');
  const diffPng = path.join(tmpDir, 'diff.png');
  fs.writeFileSync(pngA, encodeRgbaPng(width, height, rgbaA));
  fs.writeFileSync(pngB, encodeRgbaPng(width, height, rgbaB));

  const decoded = decodePng(fs.readFileSync(pngA));
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 4);

  const sameDiff = comparePngFiles(pngA, pngA);
  assert.equal(sameDiff.mismatchedPixels, 0);
  assert.equal(sameDiff.diffPercent, 0);

  const diffRes = comparePngFiles(pngA, pngB, { diffOutputPath: diffPng });
  assert.equal(diffRes.totalPixels, 16);
  assert.equal(diffRes.mismatchedPixels, 2);
  assert.equal(diffRes.diffPercent, 12.5);
  assert.ok(fs.existsSync(diffPng), 'diff.png should be written');

  // 3. Proxy server fixture replay + strict offline mode
  const cloneDir = path.join(tmpDir, 'clone');
  fs.mkdirSync(path.join(cloneDir, 'mocks'), { recursive: true });
  fs.writeFileSync(path.join(cloneDir, 'index.html'), '<!doctype html><html><body>OK</body></html>', 'utf8');
  fs.writeFileSync(
    path.join(cloneDir, 'mocks', 'fixtures.json'),
    JSON.stringify({
      'POST:/api/graphql': {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ data: { viewer: 'luka' } })
      }
    }),
    'utf8'
  );

  const testPort = 4591;
  scaffoldCloneManifests('https://example.org', cloneDir, testPort);

  const srv = spawn(process.execPath, ['server.js', '--offline'], {
    cwd: cloneDir,
    env: { ...process.env, PORT: String(testPort) },
    stdio: 'ignore'
  });

  try {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${testPort}/`);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, 'Offline clone server should start');

    const gqlResp = await fetch(`http://127.0.0.1:${testPort}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ viewer }' })
    });
    assert.equal(gqlResp.status, 200);
    assert.equal(gqlResp.headers.get('x-mimic-fixture'), 'replayed');
    const gqlJson = await gqlResp.json();
    assert.deepEqual(gqlJson, { data: { viewer: 'luka' } });

    const missResp = await fetch(`http://127.0.0.1:${testPort}/missing-asset.png`);
    assert.equal(missResp.status, 404, 'Strict offline mode must return 404 on missing asset');
  } finally {
    try { srv.kill(); } catch {}
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('✓ new_features tests passed');
