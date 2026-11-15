import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unpackDesktopApp } from '../src/engine/desktop_unpacker.mjs';

function buildTestAsar(filesMap) {
  const payloads = [];
  let offset = 0;
  const headerFiles = {};

  for (const [name, content] of Object.entries(filesMap)) {
    const buf = Buffer.from(content, 'utf8');
    headerFiles[name] = { size: buf.length, offset: String(offset) };
    payloads.push(buf);
    offset += buf.length;
  }

  const jsonBuf = Buffer.from(JSON.stringify({ files: headerFiles }), 'utf8');
  const paddedJsonLen = Math.ceil(jsonBuf.length / 4) * 4;
  const headerPayloadSize = 4 + paddedJsonLen;
  const headerPickleSize = 4 + headerPayloadSize;

  const headerBuf = Buffer.alloc(16 + paddedJsonLen);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(headerPickleSize, 4);
  headerBuf.writeUInt32LE(headerPayloadSize, 8);
  headerBuf.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(headerBuf, 16);

  return Buffer.concat([headerBuf, ...payloads]);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-asar-test-'));
const cloneName = `asar-test-${Date.now()}`;
const cliCloneDir = path.resolve('clones', cloneName);

try {
  const asarPath = path.join(tmpDir, 'app.asar');
  fs.writeFileSync(
    asarPath,
    buildTestAsar({
      'index.html': '<!doctype html><html><body><h1>Desktop App</h1></body></html>',
      'app.js': 'console.log("desktop");'
    })
  );

  const outDir = path.join(tmpDir, 'unpacked');
  const res = unpackDesktopApp(asarPath, outDir, { port: 3123 });
  assert.equal(res.fileCount, 2);
  assert.ok(fs.existsSync(path.join(outDir, 'index.html')));
  assert.ok(fs.existsSync(path.join(outDir, 'app.js')));
  assert.ok(fs.existsSync(path.join(outDir, 'server.js')));
  assert.ok(fs.existsSync(path.join(outDir, 'clone-manifest.json')));

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'clone-manifest.json'), 'utf8'));
  assert.equal(manifest.sourceType, 'electron-asar');

  // Test CLI unpack + export --format electron
  execFileSync(process.execPath, ['src/cli.js', 'unpack', asarPath, cloneName, '--json']);
  assert.ok(fs.existsSync(path.join(cliCloneDir, 'index.html')));

  const exportOut = execFileSync(process.execPath, ['src/cli.js', 'export', cloneName, '--format', 'electron', '--json'], {
    encoding: 'utf8'
  });
  const exportJson = JSON.parse(exportOut.trim());
  assert.equal(exportJson.ok, true);
  assert.equal(exportJson.format, 'electron');
  assert.ok(fs.existsSync(path.join(cliCloneDir, 'electron-main.js')));

  const pkg = JSON.parse(fs.readFileSync(path.join(cliCloneDir, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'electron-main.js');
  assert.deepEqual(pkg.build.win.target, ['nsis', 'msi']);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(cliCloneDir, { recursive: true, force: true });
}

console.log('✓ desktop_unpacker tests passed');
