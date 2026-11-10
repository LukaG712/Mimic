// test/url_mapper.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { mapUrlToFilePath } from '../src/engine/url_mapper.mjs';

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

console.log('✓ url_mapper tests passed');
