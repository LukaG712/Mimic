// test/url_mapper.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { isBlockedTrackerUrl, mapUrlToFilePath, rewriteExternalAssetUrls } from '../src/engine/url_mapper.mjs';

const outDir = path.resolve('C:/clones/test-site');
const base = 'https://linear.app';

// Relative same-domain asset
const r1 = mapUrlToFilePath('https://linear.app/static/main.css?v=123', base, outDir);
assert.equal(r1.diskPath, path.join(outDir, 'static', 'main.css'));
assert.equal(r1.isExternal, false);

// External CDN asset
const r2 = mapUrlToFilePath('https://assets.linear.app/fonts/inter.woff2', base, outDir);
assert.equal(r2.diskPath, path.join(outDir, 'external', 'assets.linear.app', 'fonts', 'inter.woff2'));
assert.equal(r2.isExternal, true);

// Root path index.html
const r3 = mapUrlToFilePath('https://linear.app/', base, outDir);
assert.equal(r3.diskPath, path.join(outDir, 'index.html'));

// Ignore data URLs
assert.equal(mapUrlToFilePath('data:image/png;base64,abc', base, outDir), null);

// Ignore blob URLs
assert.equal(mapUrlToFilePath('blob:https://linear.app/123-abc', base, outDir), null);

// Extensionless HTML route with mimeType
const r4 = mapUrlToFilePath('https://linear.app/about', base, outDir, 'text/html');
assert.equal(r4.diskPath, path.join(outDir, 'about.html'));

// Query parameterized endpoint without extension
const q1 = mapUrlToFilePath('https://linear.app/_next/image?url=img1.png&w=640', base, outDir);
const q2 = mapUrlToFilePath('https://linear.app/_next/image?url=img2.png&w=1200', base, outDir);
assert.notEqual(q1.diskPath, q2.diskPath, 'Different queries on extensionless paths must produce distinct filenames');

// Tracker filtering
assert.equal(isBlockedTrackerUrl('https://www.google-analytics.com/analytics.js'), true);
assert.equal(isBlockedTrackerUrl('https://linear.app/main.js'), false);

// External CDN URL rewriting
const sampleHtml = `
  <link href="https://static.linear.app/fonts/inter.woff2" rel="preload">
  <a href="https://github.com/org">GitHub</a>
`;
const rewritten = rewriteExternalAssetUrls(sampleHtml, new Set(['static.linear.app']));
assert.ok(rewritten.includes('/external/static.linear.app/fonts/inter.woff2'), 'Captured external CDN must be rewritten');
assert.ok(rewritten.includes('https://github.com/org'), 'Unlisted third-party links must remain untouched');

console.log('✓ url_mapper tests passed');
