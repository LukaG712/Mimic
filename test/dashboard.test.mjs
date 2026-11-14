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

const serverProc = spawn(process.execPath, ['src/dashboard.js'], {
  env: { ...process.env, DASHBOARD_PORT: String(TEST_PORT) },
  stdio: 'ignore'
});

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

  for (const marker of ['id="cmdPalette"', 'id="inspectorDrawer"', 'id="pipelineFlow"', 'id="onboardingBar"', 'data-theme="linear"']) {
    assert.ok(html.includes(marker), `Expected dashboard HTML to contain ${marker}`);
  }

  // Verify inline <script> compiles without client-side syntax errors
  const scriptMatches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)];
  const inlineScripts = scriptMatches.map(m => m[1]).filter(s => s.trim().length > 0);
  assert.ok(inlineScripts.length > 0, 'Expected inline dashboard script');
  for (const scriptBody of inlineScripts) {
    new vm.Script(scriptBody);
  }

  console.log('✓ dashboard tests passed');
} finally {
  try { serverProc.kill(); } catch {}
}
