import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Resolves the local rea-agents CLI script path to avoid cmd.exe wrapper overhead on Windows.
 */
export function resolveReaCommand() {
  if (process.env.REA_CLI_PATH && fs.existsSync(process.env.REA_CLI_PATH)) {
    return { command: process.execPath, prefixArgs: [process.env.REA_CLI_PATH] };
  }
  const appData = process.env.APPDATA || '';
  if (appData) {
    const globalReaMjs = path.join(appData, 'npm', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs');
    if (fs.existsSync(globalReaMjs)) {
      return { command: process.execPath, prefixArgs: [globalReaMjs] };
    }
  }
  return {
    command: process.platform === 'win32' ? 'rea.cmd' : 'rea',
    prefixArgs: []
  };
}

/**
 * Parses REA CLI stdout, ignoring JSONL progress records ({"rea_progress":...})
 * and returning the final JSON payload.
 */
export function parseReaJsonOutput(stdout) {
  if (!stdout || typeof stdout !== 'string') {
    throw new Error('Empty output from REA CLI');
  }
  const lines = stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.rea_progress) continue;
      if (parsed && parsed.ok === true && parsed.data) return parsed.data;
      if (parsed && parsed.ok === false && parsed.error) {
        throw new Error(parsed.error.message || JSON.stringify(parsed.error));
      }
      return parsed;
    } catch (err) {
      if (err.message && !err.message.includes('JSON')) throw err;
    }
  }
  throw new Error('No valid final JSON record found in REA output');
}

/**
 * Runs a REA CLI command with a bounded timeout and returns parsed JSON output.
 */
export function execReaJson(reaArgs, timeoutMs = 60000) {
  const { command, prefixArgs } = resolveReaCommand();
  const fullArgs = [...prefixArgs, ...reaArgs, '--format', 'json'];

  return new Promise((resolve, reject) => {
    const child = spawn(command, fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`REA command timed out after ${timeoutMs}ms: ${reaArgs.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', code => {
      clearTimeout(timer);
      try {
        const parsed = parseReaJsonOutput(stdout);
        resolve(parsed);
      } catch (parseErr) {
        if (code !== 0) {
          reject(new Error(`REA exited with code ${code}: ${(stderr || stdout || parseErr.message).trim().slice(0, 400)}`));
        } else {
          reject(parseErr);
        }
      }
    });
  });
}

/**
 * Extracts a compact, token-efficient summary from an analyze_web_bundle Evidence object.
 */
export function summarizeWebBundleEvidence(evidence) {
  const nr = evidence?.normalized_result || evidence || {};
  const chunks = (nr.observations?.chunks?.nodes || []).map(n => ({
    url: n.url,
    bytes: n.bytes,
    sha256: n.artifact_sha256
  }));
  const routes = [...new Set((nr.observations?.routes || []).map(r => r.value).filter(Boolean))];
  const observedEndpoints = (nr.observations?.endpoints || []).map(e => e.value).filter(Boolean);
  const inferredEndpoints = (nr.inferences || [])
    .filter(inf => inf.kind === 'endpoint_candidate' && inf.value)
    .map(inf => inf.value);
  const endpoints = [...new Set([...observedEndpoints, ...inferredEndpoints])];

  const inferences = (nr.inferences || []).map(inf => ({
    kind: inf.kind,
    value: inf.value,
    confidence: inf.confidence
  }));

  const webmcp = (nr.observations?.webmcp_declarations || []).map(w => ({
    name: w.name,
    description: w.description,
    properties: w.schema_property_names || []
  }));

  return {
    evidenceId: evidence?.evidence_id || null,
    targetUrl: nr.capture?.target_url || null,
    scriptsObserved: nr.capture?.scripts_observed ?? 0,
    scriptsAnalyzed: nr.capture?.scripts_analyzed ?? 0,
    completeness: nr.completeness || null,
    chunkCount: chunks.length,
    chunks: chunks.slice(0, 50),
    routes,
    endpoints,
    inferences,
    webmcp,
    sourceMaps: {
      status: nr.observations?.source_maps?.status || 'not_requested',
      requested: nr.observations?.source_maps?.requested ?? 0,
      processed: nr.observations?.source_maps?.processed ?? 0
    },
    limitations: evidence?.limitations || nr.limitations || []
  };
}

/**
 * Extracts a compact, token-efficient summary from an analyze_javascript_application Evidence object.
 */
export function summarizeJsAppEvidence(evidence) {
  const nr = evidence?.normalized_result || evidence || {};
  const allNodes = nr.graph?.nodes || [];
  const allEdges = nr.graph?.edges || [];

  const analyzedModules = allNodes
    .filter(n => n.kind && n.kind !== 'unknown')
    .slice(0, 80)
    .map(n => ({
      nodeId: n.node_id,
      kind: n.kind,
      key: n.identity?.key || null
    }));

  const semanticFamilies = (nr.semantic_graph?.coverage?.families || []).map(f => ({
    family: f.family,
    status: f.status,
    retainedRelations: f.retained_relations ?? 0,
    unknownCount: Array.isArray(f.unknown_ids) ? f.unknown_ids.length : 0
  }));

  return {
    evidenceId: evidence?.evidence_id || null,
    rootSha256: nr.root_artifact_sha256 || null,
    format: nr.format || 'directory',
    sourceSelection: nr.source_selection || null,
    nodeCount: allNodes.length,
    edgeCount: allEdges.length,
    analyzedModuleCount: analyzedModules.length,
    modules: analyzedModules,
    semanticFamilies,
    limitations: evidence?.limitations || nr.limitations || []
  };
}

/**
 * Runs `rea analyze-web-bundle` against a live CDP endpoint and targetId,
 * writes `rea-bundle.json` in outputDir, and returns the compact summary.
 */
export async function runReaWebBundle(cdpEndpoint, targetId, outputDir, options = {}) {
  const args = ['analyze-web-bundle', cdpEndpoint, targetId];
  if (options.fetchSourceMaps) {
    args.push('--fetch-source-maps');
  }
  if (options.observationMs !== undefined) {
    args.push('--observation-ms', String(options.observationMs));
  }

  const evidence = await execReaJson(args, options.timeoutMs || 45000);
  const summary = summarizeWebBundleEvidence(evidence);

  if (outputDir) {
    await fs.promises.mkdir(outputDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(outputDir, 'rea-bundle.json'),
      JSON.stringify(summary, null, 2),
      'utf8'
    );
  }

  return summary;
}

/**
 * Collects relative JS file paths in a clone directory (excluding server.js and node_modules).
 */
function discoverCloneJsFiles(rootDir, maxFiles = 25) {
  const results = [];
  function walk(currentDir) {
    if (results.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__pycache__') continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (relPath === 'server.js') continue;
        if (relPath.endsWith('.js') || relPath.endsWith('.mjs')) {
          results.push(relPath);
        }
      }
    }
  }
  walk(rootDir);
  return results;
}

/**
 * Runs `rea analyze-javascript-application` on a local clone directory,
 * writes `rea-analysis.json` (and optional `rea-evidence.json`), and returns the compact summary.
 */
export async function runReaAppAnalysis(targetDir, options = {}) {
  const absDir = path.resolve(targetDir);
  if (!fs.existsSync(absDir)) {
    throw new Error(`Target directory does not exist: ${absDir}`);
  }

  const sourcePaths = Array.isArray(options.sourcePaths) && options.sourcePaths.length > 0
    ? options.sourcePaths
    : discoverCloneJsFiles(absDir, options.maxFiles || 25);

  const args = ['analyze-javascript-application', absDir];
  for (const sp of sourcePaths) {
    args.push('--source-path', sp);
  }

  const evidence = await execReaJson(args, options.timeoutMs || 90000);
  const summary = summarizeJsAppEvidence(evidence);

  await fs.promises.writeFile(
    path.join(absDir, 'rea-analysis.json'),
    JSON.stringify(summary, null, 2),
    'utf8'
  );

  if (options.fullEvidence) {
    await fs.promises.writeFile(
      path.join(absDir, 'rea-evidence.json'),
      JSON.stringify(evidence, null, 2),
      'utf8'
    );
  }

  return summary;
}
