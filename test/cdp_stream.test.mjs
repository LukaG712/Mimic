// test/cdp_stream.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { captureRuntime } from '../src/engine/cdp_capture.mjs';

const testDir = path.resolve('test-output-stream');
try {
  fs.rmSync(testDir, { recursive: true, force: true });
} catch {}

const result = await captureRuntime('https://example.com', testDir, { waitMs: 2000, scroll: false });
assert.ok(fs.existsSync(path.join(testDir, 'index.html')), 'index.html must exist');
const htmlContent = fs.readFileSync(path.join(testDir, 'index.html'), 'utf-8');
assert.ok(htmlContent.trim().toLowerCase().startsWith('<!doctype html>'), 'index.html must start with <!DOCTYPE html>');
assert.ok(fs.existsSync(path.join(testDir, 'screenshot.png')), 'screenshot.png must exist');

const manifestPath = path.join(testDir, 'clone-manifest.json');
assert.ok(fs.existsSync(manifestPath), 'clone-manifest.json must exist');
const manifestStat = fs.statSync(manifestPath);
assert.ok(manifestStat.size < 4096, `clone-manifest.json must remain compact (< 4KB, got ${manifestStat.size})`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
assert.ok(manifest.page && typeof manifest.page.title === 'string', 'manifest must contain page.title');
assert.ok(manifest.mimeBreakdown && typeof manifest.mimeBreakdown === 'object', 'manifest must contain mimeBreakdown');

assert.ok(result && typeof result.assetCount === 'number', 'result must return assetCount');

try {
  fs.rmSync(testDir, { recursive: true, force: true });
} catch {}

// Verify hard timeout wrapper rejects cleanly and cleans up Chrome
const timeoutDir = path.resolve('test-output-timeout');
await assert.rejects(
  () => captureRuntime('https://example.com', timeoutDir, { timeout: 200 }),
  /timed out/i,
  'captureRuntime must reject when timeout budget expires'
);
try {
  fs.rmSync(timeoutDir, { recursive: true, force: true });
} catch {}

console.log('✓ cdp_stream integration test passed');
