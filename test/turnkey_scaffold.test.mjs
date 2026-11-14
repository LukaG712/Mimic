// test/turnkey_scaffold.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { scaffoldCloneManifests } from '../src/engine/cdp_capture.mjs';
import { mapUrlToFilePath } from '../src/engine/url_mapper.mjs';

const testDir = path.resolve('My Test Site');
fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

let serverProc;
try {
  scaffoldCloneManifests('https://linear.app', testDir, 3003);

  assert.ok(fs.existsSync(path.join(testDir, 'server.js')), 'server.js must be created');
  assert.ok(fs.existsSync(path.join(testDir, 'package.json')), 'package.json must be created');
  assert.ok(fs.existsSync(path.join(testDir, 'README.md')), 'README.md must be created');

  const srv = fs.readFileSync(path.join(testDir, 'server.js'), 'utf8');
  assert.ok(srv.includes('3003'), 'server.js must bind assigned port');
  assert.ok(srv.includes('https://linear.app'), 'server.js must bind upstream');

  const pkg = JSON.parse(fs.readFileSync(path.join(testDir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'my-test-site', 'package.json name must be sanitized for npm');
  assert.ok(pkg.scripts && pkg.scripts.start);

  // Write a query-hashed extensionless PNG file matching url_mapper.mjs output
  const imgUrl = 'https://linear.app/_next/image?url=img1.png&w=640';
  const mapped = mapUrlToFilePath(imgUrl, 'https://linear.app', testDir, 'image/png');
  fs.mkdirSync(path.dirname(mapped.diskPath), { recursive: true });
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
  fs.writeFileSync(mapped.diskPath, pngHeader);

  // Verify the hash aligns with MD5 of '?url=img1.png&w=640'
  const expectedHash = crypto.createHash('md5').update('?url=img1.png&w=640').digest('hex').slice(0, 8);
  assert.ok(mapped.diskPath.endsWith(`_${expectedHash}`));

  // Start server.js on a test port and verify HTTP behaviors
  const testPort = 4399;
  serverProc = spawn('node', ['server.js'], {
    cwd: testDir,
    env: { ...process.env, PORT: String(testPort) },
    stdio: 'ignore'
  });

  // Poll until server is listening
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`http://127.0.0.1:${testPort}/package.json`);
      ready = true;
      break;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  assert.ok(ready, 'Scaffolded server.js must start and listen on PORT');

  // 1. Verify query-hashed extensionless file serves with 200 & sniffed image/png MIME type
  const imgResp = await fetch(`http://127.0.0.1:${testPort}/_next/image?url=img1.png&w=640`);
  assert.equal(imgResp.status, 200);
  assert.equal(imgResp.headers.get('content-type'), 'image/png');

  // 2. Verify path traversal via raw encoded dot-dot is rejected with 403
  const travStatus = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: testPort, path: '/%2e%2e/package.json', method: 'GET' }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.ok(travStatus === 403 || travStatus === 404, `Path traversal must be blocked (got ${travStatus})`);

  console.log('✓ turnkey_scaffold tests passed');
} finally {
  if (serverProc) {
    try { serverProc.kill(); } catch {}
  }
  await new Promise(r => setTimeout(r, 150));
  fs.rmSync(testDir, { recursive: true, force: true });
}
