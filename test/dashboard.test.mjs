import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import vm from 'node:vm';

const TEST_PORT = 4499;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function waitForServer(maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${BASE_URL}/api/clones`);
      if (resp.ok) return resp;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Dashboard server did not start within ${maxMs}ms`);
}

import fs from 'node:fs';
import path from 'node:path';

const serverProc = spawn(process.execPath, ['src/dashboard.js'], {
  env: { ...process.env, DASHBOARD_PORT: String(TEST_PORT) },
  stdio: 'ignore'
});

const testAnalysisSlug = `test-pe-${Date.now()}`;
const testAnalysisDir = path.resolve('analyses', testAnalysisSlug);

try {
  const clonesResp = await waitForServer(5000);
  assert.equal(clonesResp.status, 200);
  const clonesData = await clonesResp.json();
  assert.ok(Array.isArray(clonesData.clones), 'Expected /api/clones to return a clones array');

  for (const c of clonesData.clones) {
    assert.ok('metrics' in c, 'Expected clone entry to expose metrics');
    assert.ok('hasRea' in c, 'Expected clone entry to expose hasRea');
    assert.ok('engine' in c, 'Expected clone entry to expose engine');
  }

  const htmlResp = await fetch(`${BASE_URL}/`);
  assert.equal(htmlResp.status, 200);
  const html = await htmlResp.text();

  for (const marker of ['id="cmdPalette"', 'id="inspectorDrawer"', 'id="pipelineFlow"', 'id="onboardingBar"', 'data-theme="linear"', 'id="softwareAnalysisSection"', 'id="swInspectorDrawer"']) {
    assert.ok(html.includes(marker), `Expected dashboard HTML to contain ${marker}`);
  }

  // Verify inline <script> compiles without client-side syntax errors
  const scriptMatches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)];
  const inlineScripts = scriptMatches.map(m => m[1]).filter(s => s.trim().length > 0);
  assert.ok(inlineScripts.length > 0, 'Expected inline dashboard script');
  for (const scriptBody of inlineScripts) {
    new vm.Script(scriptBody);
  }

  // Verify Software Analysis API routes
  const swToolsResp = await fetch(`${BASE_URL}/api/software/tools`);
  assert.equal(swToolsResp.status, 200);
  const swToolsData = await swToolsResp.json();
  assert.ok(swToolsData.tools && '7z' in swToolsData.tools && 'python3' in swToolsData.tools);

  const swListResp = await fetch(`${BASE_URL}/api/software/list`);
  assert.equal(swListResp.status, 200);
  const swListData = await swListResp.json();
  assert.ok(Array.isArray(swListData.analyses));

  // Upload a tiny non-PE sample via base64 to verify job creation, no path leakage, inspect, traversal block, and ZIP export
  const analyzeResp = await fetch(`${BASE_URL}/api/software/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: 'sample.bin',
      slug: testAnalysisSlug,
      base64Data: Buffer.from('TEST_PAYLOAD_DATA').toString('base64')
    })
  });
  assert.equal(analyzeResp.status, 200);
  const analyzeData = await analyzeResp.json();
  assert.equal(analyzeData.ok, true);
  assert.equal(analyzeData.outDir, undefined, 'API must not leak server outDir');

  // Wait briefly for async analysis to write analysis-report.json
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(testAnalysisDir, 'analysis-report.json'))) break;
    await new Promise(r => setTimeout(r, 100));
  }

  const inspectResp = await fetch(`${BASE_URL}/api/software/inspect?name=${encodeURIComponent(testAnalysisSlug)}`);
  assert.equal(inspectResp.status, 200);
  const inspectData = await inspectResp.json();
  assert.equal(inspectData.report.file.name, 'sample.bin');

  // Verify path-traversal rejection on /api/software/file
  const travResp = await fetch(`${BASE_URL}/api/software/file?name=${encodeURIComponent(testAnalysisSlug)}&path=../../package.json`);
  assert.equal(travResp.status, 404);

  // Verify ZIP export
  const zipResp = await fetch(`${BASE_URL}/api/software/export?name=${encodeURIComponent(testAnalysisSlug)}`);
  assert.equal(zipResp.status, 200);
  assert.equal(zipResp.headers.get('content-type'), 'application/zip');

  console.log('✓ dashboard tests passed');
} finally {
  try { serverProc.kill(); } catch {}
  try { fs.rmSync(testAnalysisDir, { recursive: true, force: true }); } catch {}
}
