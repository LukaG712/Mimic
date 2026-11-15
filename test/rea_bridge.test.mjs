import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseReaJsonOutput,
  runReaAppAnalysis,
  summarizeWebBundleEvidence
} from '../src/engine/rea_bridge.mjs';

// 1. parseReaJsonOutput ignores JSONL progress lines and unwraps envelopes
const mockStdout = [
  '{"rea_progress":{"phase":"init","completed":0,"total":1,"sequence":1}}',
  '{"rea_progress":{"phase":"done","completed":1,"total":1,"terminal":true,"sequence":2}}',
  '{"ok":true,"data":{"evidence_id":"ev_test123","normalized_result":{"format":"directory"}}}'
].join('\n');

const parsedEnvelope = parseReaJsonOutput(mockStdout);
assert.equal(parsedEnvelope.evidence_id, 'ev_test123');

const rawEvidenceStdout = [
  '{"rea_progress":{"phase":"init","sequence":1}}',
  '{"evidence_id":"ev_raw456","normalized_result":{"capture":{"target_url":"https://example.com","scripts_observed":2,"scripts_analyzed":2}}}'
].join('\n');
const parsedRaw = parseReaJsonOutput(rawEvidenceStdout);
assert.equal(parsedRaw.evidence_id, 'ev_raw456');

// 2. summarizeWebBundleEvidence extracts routes, endpoints (observed + inferred), chunks, and source maps
const bundleSummary = summarizeWebBundleEvidence({
  evidence_id: 'ev_bundle789',
  normalized_result: {
    capture: { target_url: 'https://example.com', scripts_observed: 1, scripts_analyzed: 1 },
    observations: {
      chunks: { nodes: [{ url: 'https://example.com/app.js', bytes: 1024, artifact_sha256: 'a'.repeat(64) }], edges: [] },
      routes: [{ value: '/dashboard', mechanism: 'router', location: { script_key: 's1', line: 1, column: 0 } }],
      endpoints: [{ value: '/v1/session', mechanism: 'fetch', location: { script_key: 's1', line: 2, column: 0 } }],
      webmcp_declarations: [],
      source_maps: { status: 'included', requested: 1, processed: 1, items: [] }
    },
    inferences: [
      { kind: 'route_framework', value: 'nextjs', confidence: 'high', basis: [] },
      { kind: 'endpoint_candidate', value: '/v1/billing', confidence: 'medium', basis: [] }
    ],
    completeness: { status: 'complete', parsed_scripts: 1, parse_failures: 0, visited_ast_nodes: 40 }
  },
  limitations: ['Static parse only']
});

assert.equal(bundleSummary.evidenceId, 'ev_bundle789');
assert.deepEqual(bundleSummary.routes, ['/dashboard']);
assert.deepEqual(bundleSummary.endpoints, ['/v1/session', '/v1/billing']);
assert.equal(bundleSummary.sourceMaps.status, 'included');

import { spawnSync } from 'node:child_process';

// 3. Live runReaAppAnalysis against a temporary JS application directory (when rea CLI is installed)
const reaCheck = spawnSync('rea', ['--version'], { stdio: 'ignore' });
if (reaCheck.error && reaCheck.error.code === 'ENOENT') {
  console.log('⚠️ Skipping live rea CLI test (rea binary not installed on PATH)');
} else {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-rea-test-'));
  try {
    fs.writeFileSync(
      path.join(tempDir, 'app.js'),
      'export async function loadProfile() { return fetch("/api/profile").then(r => r.json()); }\n',
      'utf8'
    );

    const summary = await runReaAppAnalysis(tempDir);
    assert.ok(summary.evidenceId && summary.evidenceId.startsWith('ev_'), 'Expected Evidence ID starting with ev_');
    assert.ok(summary.nodeCount > 0, 'Expected graph nodes > 0');
    assert.ok(fs.existsSync(path.join(tempDir, 'rea-analysis.json')), 'Expected rea-analysis.json to be written');

    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, 'rea-analysis.json'), 'utf8'));
    assert.equal(onDisk.evidenceId, summary.evidenceId);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log('✓ rea_bridge tests passed');
