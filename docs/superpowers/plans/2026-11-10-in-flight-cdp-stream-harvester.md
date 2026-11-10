# In-Flight CDP Stream Harvester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform `src/engine/cdp_capture.mjs` into a zero-loss stream harvester that intercepts network assets (fonts, CSS, images, JS chunks) directly from Chrome memory during navigation and full-page scrolling, and auto-scaffolds a runnable clone.

**Architecture:** Hook into CDP `Network.responseReceived` and `Network.loadingFinished` via WebSocket. Decode binary and text asset payloads in-flight with `Network.getResponseBody`, write them to normalized local file paths, extract the hydrated DOM, capture viewport screenshot, and scaffold a turnkey `server.js` fallback proxy.

**Tech Stack:** Node.js 24 (ES Modules, native `WebSocket`, `fetch`, `Buffer`), Chrome DevTools Protocol (CDP), Headless Chrome.

**Spec:** [`docs/superpowers/specs/2026-11-10-ten-pillars-cloning-pipeline-design.md`](file:///c:/Users/gosse/Documents/Gemini/Webstack/docs/superpowers/specs/2026-11-10-ten-pillars-cloning-pipeline-design.md)

## Global Constraints

- **Platform:** Windows 11 with Node.js 24 (`"type": "module"` in `package.json`).
- **Binary:** Use Google Chrome executable at `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- **Zero New Dependencies:** Pure native Node.js standard libraries (`child_process`, `fs`, `path`, `url`, `http`, `https`).
- **Output Structure:** Every clone output directory must be self-contained: `index.html`, `server.js`, `package.json`, `README.md`, `screenshot.png`, and asset trees (`/static/...`, `/_next/...`, `/external/...`).

## Review Focus

1. **Massive Data URLs:** Some sites inline multi-megabyte base64 images in `Network.responseReceived` that shouldn't be written as files.
   * *Expected:* Filter out `data:` and `blob:` schemes before requesting body.
2. **Duplicate Request IDs / Redirection Chaining:** Redirects (301/302) reuse request IDs or trigger multiple response events.
   * *Expected:* Only process 200/206 status codes with valid URLs.
3. **Query Parameters in Asset File Paths:** URLs like `/font.woff2?v=4.7.0#iefix` create illegal Windows file paths.
   * *Expected:* Strip `?query` and `#hash` from disk destination while preserving directory structure.
4. **Third-Party CDN External Mapping:** Assets hosted on `assets.linear.app` or `b.stripecdn.com` must not overwrite local root files.
   * *Expected:* Map different hostnames into `external/<hostname>/<path>`.
5. **Chrome Lifecycle Deadlocks:** If Chrome crashes or page navigation hangs, the process must cleanly kill Chrome and reject the promise within a timeout.
   * *Expected:* Hard timeout wrapper with process cleanup in `finally` block.

---

### Task 1: Asset URL Normalizer & Disk Path Mapper

**Files:**
- Create: `src/engine/url_mapper.mjs`
- Test: `test/url_mapper.test.mjs`

**Interfaces:**
- Produces:
  `mapUrlToFilePath(assetUrl: string, baseUrl: string, outputDir: string): { diskPath: string, isExternal: boolean } | null`

- [ ] **Step 1: Write the failing test**

```javascript
// test/url_mapper.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { mapUrlToFilePath } from '../src/engine/url_mapper.mjs';

const outDir = 'C:\\clones\\test-site';
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
console.log('✓ url_mapper tests passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/url_mapper.test.mjs`
Expected: FAIL with "Cannot find module '../src/engine/url_mapper.mjs'"

- [ ] **Step 3: Implement `mapUrlToFilePath` in `src/engine/url_mapper.mjs`**

Implement clean URL parsing, stripping `?query` and `#hash`, sanitizing path separators for Windows, mapping same-origin to root and external origins to `external/<hostname>/<path>`, and rejecting `data:`/`blob:`/`javascript:` schemes.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/url_mapper.test.mjs`
Expected: PASS with "✓ url_mapper tests passed"

- [ ] **Step 5: Commit**

```bash
git add src/engine/url_mapper.mjs test/url_mapper.test.mjs
git commit -m "feat(engine): add asset url normalizer and disk path mapper"
```

---

### Task 2: In-Flight CDP Stream Interceptor & Body Decoder

**Files:**
- Modify: `src/engine/cdp_capture.mjs:40-160`
- Consumes: `mapUrlToFilePath` from `src/engine/url_mapper.mjs`
- Test: `test/cdp_stream.test.mjs`

- [ ] **Step 1: Write integration test**

```javascript
// test/cdp_stream.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { captureRuntime } from '../src/engine/cdp_capture.mjs';

const testDir = path.resolve('test-output-stream');
try {
  fs.rmSync(testDir, { recursive: true, force: true });
} catch {}

const result = await captureRuntime('https://example.com', testDir, { waitMs: 2000 });
assert.ok(fs.existsSync(path.join(testDir, 'index.html')), 'index.html must exist');
assert.ok(fs.existsSync(path.join(testDir, 'screenshot.png')), 'screenshot.png must exist');
assert.ok(result.assetCount >= 1, 'must capture at least 1 asset');

fs.rmSync(testDir, { recursive: true, force: true });
console.log('✓ cdp_stream integration test passed');
```

- [ ] **Step 2: Run test to verify it fails or runs without stream harvesting**

Run: `node test/cdp_stream.test.mjs`
Expected: Fails on `result.assetCount` assertion because `captureRuntime` doesn't currently return asset metrics.

- [ ] **Step 3: Implement In-Flight Stream Interception in `src/engine/cdp_capture.mjs`**

1. Register listeners on the CDP WebSocket for:
   - `Network.responseReceived`: Track `requestId`, `response.url`, `response.mimeType`, and `response.status === 200`.
   - `Network.loadingFinished`: Trigger an async worker to call `Network.getResponseBody({ requestId })`.
2. Map URL to local path using `mapUrlToFilePath`.
3. If `base64Encoded` is true, write decoded binary buffer (`Buffer.from(body, 'base64')`). If false, write string content (`utf-8`).
4. Keep concurrency bounded to 10 parallel disk writes.
5. Track `downloadedCount` and `totalBytes` and return `{ domBytes, screenshotBytes, assetCount, totalBytes }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/cdp_stream.test.mjs`
Expected: PASS with "✓ cdp_stream integration test passed"

- [ ] **Step 5: Commit**

```bash
git add src/engine/cdp_capture.mjs test/cdp_stream.test.mjs
git commit -m "feat(engine): stream intercepted network assets to disk during cdp scroll"
```

---

### Task 3: Turnkey Server & Manifest Scaffolding Integration

**Files:**
- Modify: `src/engine/cdp_capture.mjs`
- Template: `src/server/proxy_server.template.js`
- Test: `test/turnkey_scaffold.test.mjs`

- [ ] **Step 1: Write test for turnkey clone scaffolding**

```javascript
// test/turnkey_scaffold.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scaffoldCloneManifests } from '../src/engine/cdp_capture.mjs';

const testDir = path.resolve('test-scaffold-dir');
fs.mkdirSync(testDir, { recursive: true });

scaffoldCloneManifests('https://linear.app', testDir, 3003);

assert.ok(fs.existsSync(path.join(testDir, 'server.js')), 'server.js must be created');
assert.ok(fs.existsSync(path.join(testDir, 'package.json')), 'package.json must be created');
assert.ok(fs.existsSync(path.join(testDir, 'README.md')), 'README.md must be created');

const srv = fs.readFileSync(path.join(testDir, 'server.js'), 'utf8');
assert.ok(srv.includes('3003'), 'server.js must bind assigned port');
assert.ok(srv.includes('https://linear.app'), 'server.js must bind upstream');

fs.rmSync(testDir, { recursive: true, force: true });
console.log('✓ turnkey_scaffold tests passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/turnkey_scaffold.test.mjs`
Expected: FAIL with "scaffoldCloneManifests is not a function"

- [ ] **Step 3: Implement `scaffoldCloneManifests` and integrate into `captureRuntime`**

Read `proxy_server.template.js`, replace `{{PORT}}` and `{{UPSTREAM}}`, write `server.js`, `package.json`, and `README.md`. Export `scaffoldCloneManifests` and call it at the conclusion of `captureRuntime`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/turnkey_scaffold.test.mjs`
Expected: PASS with "✓ turnkey_scaffold tests passed"

- [ ] **Step 5: Commit**

```bash
git add src/engine/cdp_capture.mjs test/turnkey_scaffold.test.mjs
git commit -m "feat(engine): auto-scaffold server, package.json and readme for captured sites"
```

---

### Task 4: CLI Integration & Verification

**Files:**
- Modify: `src/cli.js:135-151`
- Test: `npm test` script in `package.json`

- [ ] **Step 1: Add `--port` option support to `src/cli.js capture`**

Allow syntax: `node src/cli.js capture <url> [name] [--port 3000]`. Pass the assigned port to `captureRuntime`.

- [ ] **Step 2: Add `"test"` script to `package.json`**

Update `package.json` scripts:
```json
"test": "node test/url_mapper.test.mjs && node test/turnkey_scaffold.test.mjs"
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/cli.js package.json
git commit -m "feat(cli): wire port assignment and automated tests for capture engine"
```

---

### Task 5: Live Target Verification (Linear or Duolingo)

- [ ] **Step 1: Run live in-flight capture on target site**

Run: `node src/cli.js capture https://linear.app linear-preview --port 3003`

- [ ] **Step 2: Verify captured clone contents**

Check `clones/linear-preview`:
- `index.html` > 100KB
- `screenshot.png` exists
- `server.js` exists
- Multiple intercepted CSS/JS/font assets exist on disk in local asset folders
- Start server briefly and verify HTTP 200 on `http://localhost:3003`

- [ ] **Step 3: Push changes to GitHub repository**

Run: `git push origin main`
Expected: Remote `LukaG712/mimic` updated.
