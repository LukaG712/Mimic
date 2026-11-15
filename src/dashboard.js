/**
 * Mimic Studio — 10-Pillar Reverse-Engineering Workbench & Dashboard
 * Runs on http://localhost:4000 (override via DASHBOARD_PORT)
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { runReaAppAnalysis } from './engine/rea_bridge.mjs';
import { verifyClone } from './engine/verifier.mjs';
import { analyzeSoftware } from './reverse/orchestrator/analysis_pipeline.mjs';
import { discoverTools, isSafeSubpath } from './reverse/orchestrator/tool_registry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLONES_DIR = path.resolve(ROOT, 'clones');
const ANALYSES_DIR = path.resolve(ROOT, 'analyses');
const LEGACY_CLONES_DIR = 'C:\\Users\\gosse\\Documents\\Gemini\\Clones';

const PORT = parseInt(process.env.DASHBOARD_PORT || '4000', 10);
const activeServers = new Map();
const softwareJobs = new Map();

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function formatHostFromDescription(desc) {
  const m = (desc || '').match(/https?:\/\/[^\s)]+/);
  return m ? m[0] : null;
}

function getAllClones() {
  const list = [];
  const dirsToScan = [
    { base: CLONES_DIR, tag: 'Mimic' },
    { base: LEGACY_CLONES_DIR, tag: 'Gemini' }
  ];

  for (const { base, tag } of dirsToScan) {
    if (!fs.existsSync(base)) continue;
    try {
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const projectPath = path.join(base, e.name);
        const pkg = readJsonSafe(path.join(projectPath, 'package.json'));
        const manifest = readJsonSafe(path.join(projectPath, 'clone-manifest.json'));
        const reaBundle = readJsonSafe(path.join(projectPath, 'rea-bundle.json')) || manifest?.rea || null;
        const reaAnalysis = readJsonSafe(path.join(projectPath, 'rea-analysis.json'));
        const auditReport = readJsonSafe(path.join(projectPath, 'audit-report.json'));

        const description = pkg?.description || '';
        let port = 3000;
        const serverPath = path.join(projectPath, 'server.js');
        if (fs.existsSync(serverPath)) {
          try {
            const srvText = fs.readFileSync(serverPath, 'utf8');
            const portMatch = srvText.match(/PORT\s*=\s*(?:process\.env\.PORT\s*\|\|\s*)?(\d+)/);
            if (portMatch) port = parseInt(portMatch[1], 10);
          } catch {}
        }

        const hasScreenshot = fs.existsSync(path.join(projectPath, 'screenshot.png'));
        const hasAuditDesktop = hasScreenshot || fs.existsSync(path.join(projectPath, 'audit-desktop.png'));
        const hasAuditMobile =
          fs.existsSync(path.join(projectPath, 'screenshot_mobile.png')) ||
          fs.existsSync(path.join(projectPath, 'audit-mobile.png'));
        const hasManifest = Boolean(manifest);
        const hasRea = Boolean(reaBundle || reaAnalysis);
        const hasAudit = Boolean(auditReport);
        const engine = hasManifest || fs.existsSync(path.join(projectPath, 'rea-bundle.json')) ? 'cdp' : 'static';

        const palette = Array.isArray(manifest?.page?.colors) ? manifest.page.colors.slice(0, 6) : [];
        const metrics = {
          assetCount: manifest?.assetCount ?? 0,
          totalBytes: (manifest?.totalBytes ?? 0) + (manifest?.domBytes ?? 0),
          skippedTrackers: manifest?.skippedTrackers ?? 0,
          routesCount: Array.isArray(reaBundle?.routes) ? reaBundle.routes.length : 0,
          endpointsCount: Array.isArray(reaBundle?.endpoints) ? reaBundle.endpoints.length : 0,
          nodeCount: reaAnalysis?.nodeCount ?? 0,
          edgeCount: reaAnalysis?.edgeCount ?? 0,
          analyzedModuleCount: reaAnalysis?.analyzedModuleCount ?? reaBundle?.scriptsAnalyzed ?? 0,
          consoleErrors: Array.isArray(auditReport?.consoleErrors) ? auditReport.consoleErrors.length : 0,
          networkErrors: Array.isArray(auditReport?.networkErrors) ? auditReport.networkErrors.length : 0,
          passed: auditReport ? Boolean(auditReport.passed) : null
        };

        list.push({
          name: e.name,
          path: projectPath,
          source: tag,
          engine,
          description,
          targetUrl: manifest?.url || reaBundle?.targetUrl || formatHostFromDescription(description),
          capturedAt: manifest?.capturedAt || auditReport?.auditedAt || null,
          port,
          hasScreenshot,
          hasAuditDesktop,
          hasAuditMobile,
          hasManifest,
          hasRea,
          hasAudit,
          palette,
          metrics,
          running: activeServers.has(e.name)
        });
      }
    } catch (err) {
      console.error('Scan error:', err.message);
    }
  }
  return list;
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Request body exceeded ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function getAllSoftwareAnalyses() {
  if (!fs.existsSync(ANALYSES_DIR)) return [];
  const items = [];
  for (const entry of fs.readdirSync(ANALYSES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const reportPath = path.join(ANALYSES_DIR, entry.name, 'analysis-report.json');
    const report = readJsonSafe(reportPath);
    if (!report) continue;
    items.push({
      slug: entry.name,
      analyzedAt: report.analyzedAt,
      fileName: report.file?.name || entry.name,
      size: report.file?.size || 0,
      sha256: report.file?.sha256 || '',
      kind: report.identity?.kind || 'unknown',
      fileType: report.identity?.fileType || 'Unknown',
      architecture: report.identity?.architecture || null,
      runtime: report.identity?.runtime || null,
      installerFramework: report.identity?.installerFramework || null,
      packers: report.identity?.packers || [],
      overallStatus: report.overallStatus || 'partial',
      extractedCount: report.extraction?.files?.length || 0,
      decompiledCount: report.decompilation?.files?.length || 0
    });
  }
  return items.sort((a, b) => (b.analyzedAt || '').localeCompare(a.analyzedAt || ''));
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function waitForHttpPort(port, maxWaitMs = 4000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/`);
      if (resp.status >= 200 && resp.status < 500) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

function startCloneServer(match, offline = false) {
  if (activeServers.has(match.name)) {
    return { child: activeServers.get(match.name), startedTransiently: false };
  }
  const serverPath = path.join(match.path, 'server.js');
  if (!fs.existsSync(serverPath)) {
    throw new Error(`server.js missing in ${match.path}`);
  }
  const env = { ...process.env, PORT: String(match.port) };
  if (offline) env.MIMIC_OFFLINE = '1';
  const child = spawn('node', ['server.js'], {
    cwd: match.path,
    env,
    stdio: 'ignore'
  });
  activeServers.set(match.name, child);
  child.on('exit', () => {
    activeServers.delete(match.name);
  });
  return { child, startedTransiently: true };
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/api/clones') {
    sendJson(res, 200, { clones: getAllClones() });
    return;
  }

  // --- Software Reverse-Engineering (.EXE / .MSI) API Routes ---
  if (parsed.pathname === '/api/software/tools' && req.method === 'GET') {
    sendJson(res, 200, { tools: discoverTools() });
    return;
  }

  if (parsed.pathname === '/api/software/list' && req.method === 'GET') {
    sendJson(res, 200, { analyses: getAllSoftwareAnalyses() });
    return;
  }

  if (parsed.pathname === '/api/software/inspect' && req.method === 'GET') {
    const name = String(parsed.query.name || '').replace(/[^a-zA-Z0-9._-]/g, '');
    const analysisDir = path.join(ANALYSES_DIR, name);
    const reportPath = path.join(analysisDir, 'analysis-report.json');
    if (!name || !isSafeSubpath(ANALYSES_DIR, analysisDir) || !fs.existsSync(reportPath)) {
      sendJson(res, 404, { error: `Software analysis "${name}" not found` });
      return;
    }
    sendJson(res, 200, { slug: name, report: readJsonSafe(reportPath) });
    return;
  }

  if (parsed.pathname === '/api/software/file' && req.method === 'GET') {
    const name = String(parsed.query.name || '').replace(/[^a-zA-Z0-9._-]/g, '');
    const relPath = String(parsed.query.path || '');
    const analysisDir = path.join(ANALYSES_DIR, name);
    const targetPath = path.resolve(analysisDir, relPath);
    if (!name || !relPath || !isSafeSubpath(analysisDir, targetPath) || !fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
      sendJson(res, 404, { error: 'File not found or invalid path' });
      return;
    }
    const stat = fs.statSync(targetPath);
    const maxPreview = 256 * 1024;
    const raw = fs.readFileSync(targetPath);
    const truncated = raw.length > maxPreview;
    const slice = truncated ? raw.subarray(0, maxPreview) : raw;
    const isBinary = slice.includes(0);
    sendJson(res, 200, {
      path: relPath,
      size: stat.size,
      truncated,
      isBinary,
      content: isBinary ? `[Binary file: ${stat.size} bytes]` : slice.toString('utf8')
    });
    return;
  }

  if (parsed.pathname === '/api/software/export' && req.method === 'GET') {
    const name = String(parsed.query.name || '').replace(/[^a-zA-Z0-9._-]/g, '');
    const analysisDir = path.join(ANALYSES_DIR, name);
    if (!name || !isSafeSubpath(ANALYSES_DIR, analysisDir) || !fs.existsSync(analysisDir)) {
      sendJson(res, 404, { error: 'Analysis not found' });
      return;
    }
    const zipBase = path.join(ANALYSES_DIR, `${name}-package`);
    const zipPath = `${zipBase}.zip`;
    const pyZip = spawn('python3', [
      '-c',
      'import shutil, sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])',
      zipBase,
      analysisDir
    ], { stdio: 'ignore' });
    pyZip.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(zipPath)) {
        sendJson(res, 500, { error: 'Failed to create ZIP archive' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${name}-analysis.zip"`
      });
      fs.createReadStream(zipPath).pipe(res);
    });
    return;
  }

  if (parsed.pathname === '/api/software/stream' && req.method === 'GET') {
    const jobId = String(parsed.query.jobId || '');
    const job = softwareJobs.get(jobId);
    if (!job) {
      sendJson(res, 404, { error: 'Software analysis job not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    for (const line of job.logs) {
      res.write(`data: ${JSON.stringify({ type: 'log', line })}\n\n`);
    }
    if (job.done) {
      res.write(`data: ${JSON.stringify({ type: 'done', code: job.code, slug: job.slug, error: job.error || null })}\n\n`);
      res.end();
      return;
    }
    job.clients.add(res);
    req.on('close', () => job.clients.delete(res));
    return;
  }

  if (parsed.pathname === '/api/software/analyze' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, 64 * 1024 * 1024);
      const { fileName, base64Data, localPath, slug: customSlug, extract = true, decompile = true } = body;
      const rawName = path.basename(String(fileName || localPath || 'binary.exe'));
      const slug = (String(customSlug || rawName).toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '')) || `bin-${Date.now()}`;
      const outDir = path.join(ANALYSES_DIR, slug);
      fs.mkdirSync(outDir, { recursive: true });

      let targetPath = null;
      if (base64Data) {
        const inputDir = path.join(outDir, 'input');
        fs.mkdirSync(inputDir, { recursive: true });
        const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'sample.bin';
        targetPath = path.join(inputDir, safeName);
        fs.writeFileSync(targetPath, Buffer.from(base64Data, 'base64'));
      } else if (localPath && fs.existsSync(String(localPath))) {
        targetPath = path.resolve(String(localPath));
      } else {
        sendJson(res, 400, { error: 'Provide either base64Data upload or a valid localPath' });
        return;
      }

      const jobId = `sw-${slug}-${Date.now()}`;
      const job = { id: jobId, slug, logs: [], clients: new Set(), done: false, code: null, error: null };
      softwareJobs.set(jobId, job);

      const pushLog = (line) => {
        job.logs.push(line);
        if (job.logs.length > 200) job.logs.shift();
        for (const client of job.clients) {
          client.write(`data: ${JSON.stringify({ type: 'log', line })}\n\n`);
        }
      };

      analyzeSoftware(targetPath, outDir, {
        extract: Boolean(extract),
        decompile: Boolean(decompile),
        onProgress: (ev) => pushLog(`[${ev.phase}] ${ev.message}`)
      })
        .then(() => {
          job.done = true;
          job.code = 0;
          for (const client of job.clients) {
            client.write(`data: ${JSON.stringify({ type: 'done', code: 0, slug })}\n\n`);
            client.end();
          }
          job.clients.clear();
          setTimeout(() => softwareJobs.delete(jobId), 5 * 60 * 1000);
        })
        .catch((err) => {
          job.done = true;
          job.code = 1;
          job.error = err.message;
          pushLog(`[error] ${err.message}`);
          for (const client of job.clients) {
            client.write(`data: ${JSON.stringify({ type: 'done', code: 1, slug, error: err.message })}\n\n`);
            client.end();
          }
          job.clients.clear();
          setTimeout(() => softwareJobs.delete(jobId), 5 * 60 * 1000);
        });

      sendJson(res, 200, { ok: true, jobId, slug, outDir });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (parsed.pathname === '/api/inspect' && req.method === 'GET') {
    const name = String(parsed.query.name || '');
    const clones = getAllClones();
    const match = clones.find(c => c.name === name);
    if (!match) {
      sendJson(res, 404, { error: `Clone "${name}" not found` });
      return;
    }
    const manifest = readJsonSafe(path.join(match.path, 'clone-manifest.json'));
    const reaBundle = readJsonSafe(path.join(match.path, 'rea-bundle.json')) || manifest?.rea || null;
    const reaAnalysis = readJsonSafe(path.join(match.path, 'rea-analysis.json'));
    const auditReport = readJsonSafe(path.join(match.path, 'audit-report.json'));
    sendJson(res, 200, { clone: match, manifest, reaBundle, reaAnalysis, auditReport });
    return;
  }

  if (parsed.pathname === '/api/clone/stream' && req.method === 'GET') {
    const jobId = String(parsed.query.jobId || '');
    const job = captureJobs.get(jobId);
    if (!job) {
      sendJson(res, 404, { error: 'Capture job not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    for (const line of job.logs) {
      res.write(`data: ${JSON.stringify({ type: 'log', line })}\n\n`);
    }
    if (job.done) {
      res.write(`data: ${JSON.stringify({ type: 'done', code: job.code, slug: job.slug })}\n\n`);
      res.end();
      return;
    }
    job.clients.add(res);
    req.on('close', () => {
      job.clients.delete(res);
    });
    return;
  }

  if (parsed.pathname === '/api/clone' && req.method === 'POST') {
    try {
      const { targetUrl, name, port, engine = 'cdp', rea = true, fetchSourceMaps = false, crawl = false, cookies = '', headers = '' } = await readJsonBody(req);
      if (!targetUrl) {
        sendJson(res, 400, { error: 'Missing targetUrl' });
        return;
      }

      const slug = (name || targetUrl.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '-') + '-clone')
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, '-')
        .replace(/^-+|-+$/g, '') || 'cloned-site';
      const targetDir = path.join(CLONES_DIR, slug);
      const assignedPort = port || (3010 + Math.floor(Math.random() * 80));
      const jobId = `${slug}-${Date.now()}`;

      let child;
      if (engine === 'static') {
        const pythonScript = path.join(__dirname, 'engine', 'cloner.py');
        child = spawn('python3', [pythonScript, '--url', targetUrl, '--out', targetDir, '--port', String(assignedPort)], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } else {
        const cdpScript = path.join(__dirname, 'engine', 'cdp_capture.mjs');
        const cdpArgs = [cdpScript, targetUrl, targetDir, String(assignedPort)];
        if (rea) cdpArgs.push('--rea');
        if (rea && fetchSourceMaps) cdpArgs.push('--fetch-source-maps');
        if (crawl) cdpArgs.push('--crawl');
        if (cookies && String(cookies).trim()) cdpArgs.push('--cookies', String(cookies).trim());
        if (headers && String(headers).trim()) cdpArgs.push('--header', String(headers).trim());
        child = spawn('node', cdpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      }

      const job = { id: jobId, slug, logs: [], clients: new Set(), done: false, code: null };
      captureJobs.set(jobId, job);

      const pushLine = (line) => {
        const clean = line.trimEnd();
        if (!clean) return;
        job.logs.push(clean);
        if (job.logs.length > 250) job.logs.shift();
        for (const client of job.clients) {
          client.write(`data: ${JSON.stringify({ type: 'log', line: clean })}\n\n`);
        }
      };

      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        let buf = '';
        stream.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() || '';
          lines.forEach(pushLine);
        });
      }

      child.on('close', (code) => {
        job.done = true;
        job.code = code;
        for (const client of job.clients) {
          client.write(`data: ${JSON.stringify({ type: 'done', code, slug })}\n\n`);
          client.end();
        }
        job.clients.clear();
        setTimeout(() => captureJobs.delete(jobId), 5 * 60 * 1000);
        console.log(`Cloning (${engine}) finished for ${slug} with code ${code}`);
      });

      sendJson(res, 200, { ok: true, jobId, slug, targetDir, port: assignedPort, engine, rea: Boolean(rea), crawl: Boolean(crawl) });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (parsed.pathname === '/api/clone' && req.method === 'DELETE') {
    const name = String(parsed.query.name || '');
    const clones = getAllClones();
    const match = clones.find(c => c.name === name);
    if (!match) {
      sendJson(res, 404, { error: `Clone "${name}" not found` });
      return;
    }
    const proc = activeServers.get(match.name);
    if (proc) {
      try { proc.kill(); } catch {}
      activeServers.delete(match.name);
    }
    fs.rmSync(match.path, { recursive: true, force: true });
    sendJson(res, 200, { ok: true, removed: match.name });
    return;
  }

  if (parsed.pathname === '/api/export' && req.method === 'GET') {
    const name = String(parsed.query.name || '');
    const format = String(parsed.query.format || 'zip').toLowerCase();
    const clones = getAllClones();
    const match = clones.find(c => c.name === name);
    if (!match) {
      sendJson(res, 404, { error: `Clone "${name}" not found` });
      return;
    }
    if (format === 'docker') {
      const dockerfile = `FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nENV PORT=3000\nEXPOSE 3000\nCMD ["node", "server.js"]\n`;
      fs.writeFileSync(path.join(match.path, 'Dockerfile'), dockerfile, 'utf8');
      sendJson(res, 200, { ok: true, format: 'docker', path: path.join(match.path, 'Dockerfile') });
      return;
    }
    const zipPath = path.join(CLONES_DIR, `${match.name}.zip`);
    const pyZip = spawn('python3', [
      '-c',
      'import shutil, sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])',
      zipPath,
      match.path
    ]);
    pyZip.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(zipPath)) {
        sendJson(res, 500, { error: 'Failed to build zip archive' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${match.name}.zip"`
      });
      fs.createReadStream(zipPath).pipe(res);
    });
    return;
  }

  if (parsed.pathname === '/api/serve' && req.method === 'POST') {
    try {
      const { name, action = 'start', offline = false } = await readJsonBody(req);
      const clones = getAllClones();
      const match = clones.find(c => c.name === name);
      if (!match) {
        sendJson(res, 404, { error: `Clone "${name}" not found` });
        return;
      }

      if (action === 'stop') {
        const proc = activeServers.get(match.name);
        if (proc) {
          try { proc.kill(); } catch {}
          activeServers.delete(match.name);
        }
        sendJson(res, 200, { ok: true, name: match.name, running: false });
        return;
      }

      startCloneServer(match, Boolean(offline));
      sendJson(res, 200, { ok: true, name: match.name, running: true, port: match.port, offline: Boolean(offline) });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (parsed.pathname === '/api/analyze' && req.method === 'POST') {
    try {
      const { name } = await readJsonBody(req);
      const clones = getAllClones();
      const match = clones.find(c => c.name === name);
      if (!match) {
        sendJson(res, 404, { error: `Clone "${name}" not found` });
        return;
      }
      const summary = await runReaAppAnalysis(match.path);
      sendJson(res, 200, { ok: true, name: match.name, summary });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (parsed.pathname === '/api/verify' && req.method === 'POST') {
    let transientChild = null;
    let transientName = null;
    try {
      const { name } = await readJsonBody(req);
      const clones = getAllClones();
      const match = clones.find(c => c.name === name);
      if (!match) {
        sendJson(res, 404, { error: `Clone "${name}" not found` });
        return;
      }

      const srv = startCloneServer(match);
      if (srv.startedTransiently) {
        transientChild = srv.child;
        transientName = match.name;
      }

      const ready = await waitForHttpPort(match.port, 4000);
      if (!ready) {
        throw new Error(`Clone server did not respond on port ${match.port}`);
      }

      const report = await verifyClone(`http://localhost:${match.port}`, match.path, {
        quiet: true,
        timeout: 45000
      });
      sendJson(res, 200, { ok: true, name: match.name, report });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    } finally {
      if (transientChild) {
        try { transientChild.kill(); } catch {}
        if (transientName) activeServers.delete(transientName);
      }
    }
    return;
  }

  if (parsed.pathname.startsWith('/screenshot/')) {
    const projName = decodeURIComponent(parsed.pathname.replace('/screenshot/', ''));
    const match = getAllClones().find(c => c.name === projName);
    if (match) {
      const shotPath = path.join(match.path, 'screenshot.png');
      if (fs.existsSync(shotPath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(shotPath).pipe(res);
        return;
      }
    }
    res.writeHead(404);
    res.end();
    return;
  }

  if (parsed.pathname.startsWith('/audit-image/')) {
    const parts = parsed.pathname.split('/').filter(Boolean);
    const viewport = parts[1];
    const projName = decodeURIComponent(parts.slice(2).join('/'));
    const match = getAllClones().find(c => c.name === projName);
    if (match) {
      const candidates =
        viewport === 'mobile'
          ? ['screenshot_mobile.png', 'audit-mobile.png']
          : viewport === 'diff'
            ? ['diff-desktop.png']
            : ['screenshot.png', 'audit-desktop.png'];
      for (const file of candidates) {
        const candidatePath = path.join(match.path, file);
        if (fs.existsSync(candidatePath)) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          fs.createReadStream(candidatePath).pipe(res);
          return;
        }
      }
    }
    res.writeHead(404);
    res.end();
    return;
  }

  // Dashboard HTML (10-Pillar Workbench)
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(RENDER_DASHBOARD_HTML());
});

function RENDER_DASHBOARD_HTML() {
  return `<!DOCTYPE html>
<html lang="en" data-theme="linear">
<head>
  <meta charset="UTF-8" />
  <title>Mimic Studio</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,400&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

    :root, html[data-theme="linear"] {
      --bg: #08090a;
      --bg-elevated: #101216;
      --bg-subtle: #16191f;
      --bg-glass: rgba(12, 13, 16, 0.78);
      --border: rgba(255, 255, 255, 0.08);
      --border-strong: rgba(255, 255, 255, 0.16);
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --text-dim: #6b7280;
      --accent: #f59e0b;
      --accent-soft: rgba(245, 158, 11, 0.14);
      --accent-fg: #111111;
      --ok: #10b981;
      --ok-soft: rgba(16, 185, 129, 0.14);
      --danger: #f43f5e;
      --danger-soft: rgba(244, 63, 94, 0.14);
      --font-display: 'Inter', system-ui, sans-serif;
      --font-sans: 'Inter', system-ui, sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, monospace;
      --shadow-card: 0 1px 0 rgba(255,255,255,0.04) inset, 0 16px 36px -20px rgba(0,0,0,0.8);
    }

    html[data-theme="aesop"] {
      --bg: #f6f5e8;
      --bg-elevated: #eeecdb;
      --bg-subtle: #e5e2ce;
      --bg-glass: rgba(246, 245, 232, 0.85);
      --border: rgba(26, 25, 23, 0.11);
      --border-strong: rgba(26, 25, 23, 0.24);
      --text: #1a1917;
      --text-muted: #57534a;
      --text-dim: #787366;
      --accent: #8c5a32;
      --accent-soft: rgba(140, 90, 50, 0.12);
      --accent-fg: #f6f5e8;
      --ok: #2f6f4e;
      --ok-soft: rgba(47, 111, 78, 0.12);
      --danger: #a63434;
      --danger-soft: rgba(166, 52, 52, 0.12);
      --font-display: 'Cormorant Garamond', Georgia, serif;
      --font-sans: 'Inter', system-ui, sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, monospace;
      --shadow-card: 0 1px 2px rgba(26,25,23,0.05);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: var(--font-sans);
      background: var(--bg);
      color: var(--text);
      transition: background-color 280ms cubic-bezier(0.22, 1, 0.36, 1), color 280ms cubic-bezier(0.22, 1, 0.36, 1);
      -webkit-font-smoothing: antialiased;
    }

    .font-display { font-family: var(--font-display); }
    .font-mono { font-family: var(--font-mono); }
    .tabular-nums { font-variant-numeric: tabular-nums; }

    .surface {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      box-shadow: var(--shadow-card);
    }

    .glass-bar {
      background: var(--bg-glass);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border-bottom: 1px solid var(--border);
    }

    .spring-btn {
      transition: transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1), background-color 160ms ease, border-color 160ms ease, opacity 160ms ease;
    }
    .spring-btn:hover { transform: translateY(-1px); }
    .spring-btn:active { transform: scale(0.97); }

    .card-apple {
      transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1), border-color 220ms ease, box-shadow 280ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .card-apple:hover {
      transform: translateY(-2px);
      border-color: var(--border-strong);
    }

    .kbd-chip {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 5px;
      border: 1px solid var(--border-strong);
      background: var(--bg-subtle);
      color: var(--text-muted);
    }

    /* Stripe Pipeline Connector Flow */
    .pipeline-node {
      border: 1px solid var(--border);
      background: var(--bg-elevated);
      transition: border-color 260ms ease, background-color 260ms ease, transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .pipeline-node.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      transform: translateY(-1px);
    }
    .pipeline-node.done {
      border-color: var(--ok);
      background: var(--ok-soft);
    }
    .pipeline-line {
      height: 2px;
      background: var(--border);
      position: relative;
      overflow: hidden;
    }
    .pipeline-line.active::after {
      content: '';
      position: absolute;
      inset: 0;
      width: 45%;
      background: var(--accent);
      animation: flowPulse 1.1s cubic-bezier(0.22, 1, 0.36, 1) infinite;
    }
    @keyframes flowPulse {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(240%); }
    }

    /* Apple Side-Peek Drawer */
    .drawer-backdrop {
      opacity: 0;
      pointer-events: none;
      transition: opacity 260ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .drawer-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }
    .drawer-panel {
      transform: translateX(100%);
      transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1);
      background: var(--bg);
      border-left: 1px solid var(--border);
    }
    .drawer-panel.open {
      transform: translateX(0);
    }

    /* Command Palette */
    .palette-backdrop {
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease;
    }
    .palette-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }
    .palette-box {
      transform: scale(0.96) translateY(-8px);
      transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
      background: var(--bg-elevated);
      border: 1px solid var(--border-strong);
    }
    .palette-backdrop.open .palette-box {
      transform: scale(1) translateY(0);
    }

    input, select {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--accent);
    }
  </style>
</head>
<body class="min-h-screen flex flex-col">

  <!-- Sticky Translucent Top Header (Apple + Linear + Aesop Toggle) -->
  <header class="glass-bar sticky top-0 z-30 px-6 py-3">
    <div class="max-w-7xl mx-auto flex items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <div class="w-7 h-7 rounded-lg flex items-center justify-center font-mono text-xs font-semibold" style="background: var(--accent); color: var(--accent-fg);">M</div>
        <span class="font-display text-xl tracking-tight font-semibold">Mimic Studio</span>
        <span class="font-mono text-[11px] px-2 py-0.5 rounded-md tabular-nums" style="background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text-muted);">CDP + REA</span>
      </div>

      <div class="flex items-center gap-2.5">
        <button onclick="openCommandPalette()" class="spring-btn hidden sm:inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs" style="background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-muted);">
          <span>Commands</span>
          <span class="kbd-chip">Ctrl K</span>
        </button>

        <button id="themeToggle" onclick="toggleTheme()" title="Switch between Linear Dark and Aesop Editorial Light (T)" class="spring-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium" style="background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text);">
          <span id="themeLabel">Aesop Light</span>
          <span class="kbd-chip">T</span>
        </button>
      </div>
    </div>
  </header>

  <main class="max-w-7xl w-full mx-auto px-6 py-8 space-y-8 flex-1">

    <!-- Duolingo-Style 3-Step Interactive Onboarding Bar -->
    <section id="onboardingBar" class="surface rounded-2xl p-4 sm:p-5">
      <div class="flex items-center justify-between gap-4 mb-3">
        <div class="flex items-center gap-3">
          <span class="font-mono text-[11px] uppercase tracking-wider px-2 py-0.5 rounded" style="background: var(--accent-soft); color: var(--accent);">Workflow</span>
          <span class="text-sm font-medium">Workspace readiness</span>
          <span id="onboardingFraction" class="font-mono text-xs tabular-nums" style="color: var(--text-muted);">0/3 complete</span>
        </div>
        <button onclick="toggleOnboarding()" class="text-xs font-mono hover:underline" style="color: var(--text-muted);">Hide</button>
      </div>
      <div class="w-full h-1.5 rounded-full overflow-hidden mb-4" style="background: var(--bg-subtle);">
        <div id="onboardingProgress" class="h-full rounded-full transition-all duration-500" style="width: 0%; background: var(--ok);"></div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <div id="stepCapture" class="rounded-xl p-3 flex items-center justify-between" style="background: var(--bg); border: 1px solid var(--border);">
          <div>
            <div class="font-medium">1. Capture a site</div>
            <div style="color: var(--text-muted);" class="mt-0.5">Ingest rendered DOM &amp; network assets</div>
          </div>
          <button onclick="focusCapture()" class="spring-btn px-2.5 py-1 rounded-md font-mono text-[11px]" style="background: var(--bg-subtle); border: 1px solid var(--border);">Focus</button>
        </div>
        <div id="stepRea" class="rounded-xl p-3 flex items-center justify-between" style="background: var(--bg); border: 1px solid var(--border);">
          <div>
            <div class="font-medium">2. Inspect with REA</div>
            <div style="color: var(--text-muted);" class="mt-0.5">Extract chunks, routes, and API endpoints</div>
          </div>
          <button onclick="runFirstMissingRea()" class="spring-btn px-2.5 py-1 rounded-md font-mono text-[11px]" style="background: var(--bg-subtle); border: 1px solid var(--border);">Analyze</button>
        </div>
        <div id="stepVerify" class="rounded-xl p-3 flex items-center justify-between" style="background: var(--bg); border: 1px solid var(--border);">
          <div>
            <div class="font-medium">3. Serve or verify</div>
            <div style="color: var(--text-muted);" class="mt-0.5">Run offline proxy &amp; viewport audit</div>
          </div>
          <button onclick="runFirstMissingVerify()" class="spring-btn px-2.5 py-1 rounded-md font-mono text-[11px]" style="background: var(--bg-subtle); border: 1px solid var(--border);">Audit</button>
        </div>
      </div>
    </section>

    <!-- Capture Form + Stripe-Style Pipeline Flow Visualizer -->
    <section class="surface rounded-2xl p-6 sm:p-8 space-y-6">
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 class="font-display text-3xl sm:text-4xl font-semibold tracking-tight">Capture &amp; Reverse-Engineer</h1>
          <p class="text-sm mt-1.5" style="color: var(--text-muted);">
            Stream browser responses directly to disk via CDP or crawl static assets in parallel, then inspect bundles offline.
          </p>
        </div>
        <div class="flex items-center gap-2 text-xs font-mono" style="color: var(--text-dim);">
          <span>Shortcuts:</span>
          <span class="kbd-chip">C</span><span>Capture</span>
          <span class="kbd-chip">/</span><span>Search</span>
        </div>
      </div>

      <form id="cloneForm" onsubmit="triggerClone(event)" class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
          <div class="sm:col-span-5">
            <input id="urlInput" type="url" required placeholder="https://example.com" class="w-full px-3.5 py-2.5 rounded-xl text-sm font-mono" />
          </div>
          <div class="sm:col-span-2">
            <input id="nameInput" type="text" placeholder="slug (optional)" class="w-full px-3.5 py-2.5 rounded-xl text-sm font-mono" />
          </div>
          <div class="sm:col-span-2">
            <select id="engineSelect" class="w-full px-3 py-2.5 rounded-xl text-sm">
              <option value="cdp">CDP Stream</option>
              <option value="static">Static Python</option>
            </select>
          </div>
          <div class="sm:col-span-3">
            <button type="submit" id="submitBtn" class="spring-btn w-full py-2.5 px-4 rounded-xl text-sm font-semibold" style="background: var(--accent); color: var(--accent-fg);">
              Start Capture
            </button>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-5 text-xs" style="color: var(--text-muted);">
          <label class="inline-flex items-center gap-2 cursor-pointer select-none">
            <input id="reaCheck" type="checkbox" checked />
            <span>Run REA bundle analysis (<code class="font-mono">rea analyze-web-bundle</code>)</span>
          </label>
          <label class="inline-flex items-center gap-2 cursor-pointer select-none">
            <input id="sourceMapsCheck" type="checkbox" />
            <span>Fetch source maps</span>
          </label>
          <label class="inline-flex items-center gap-2 cursor-pointer select-none">
            <input id="crawlCheck" type="checkbox" />
            <span>Crawl internal routes (<code class="font-mono">--crawl</code>)</span>
          </label>
          <label class="inline-flex items-center gap-2 cursor-pointer select-none">
            <input id="offlineServeCheck" type="checkbox" />
            <span>Strict offline serve</span>
          </label>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <input id="cookiesInput" type="text" placeholder="Cookies JSON path or 'session=abc; ...' (optional)" class="w-full px-3 py-2 rounded-xl text-xs font-mono" />
          <input id="headerInput" type="text" placeholder="Custom header e.g. Authorization: Bearer ... (optional)" class="w-full px-3 py-2 rounded-xl text-xs font-mono" />
        </div>
      </form>

      <div id="liveLogPanel" class="hidden rounded-xl p-3 font-mono text-[11px] max-h-44 overflow-y-auto space-y-0.5" style="background: var(--bg); border: 1px solid var(--border); color: var(--text-muted);"></div>

      <!-- Stripe Connected Node Pipeline Visualizer -->
      <div id="pipelineFlow" class="pt-2">
        <div class="grid grid-cols-1 sm:grid-cols-7 items-center gap-2 text-xs">
          <div id="pipeNode1" class="pipeline-node rounded-xl p-3 sm:col-span-1">
            <div class="font-mono text-[10px] uppercase" style="color: var(--text-dim);">Stage 01</div>
            <div class="font-medium mt-0.5 truncate">Origin URL</div>
          </div>
          <div id="pipeLine1" class="pipeline-line hidden sm:block"></div>
          <div id="pipeNode2" class="pipeline-node rounded-xl p-3 sm:col-span-1">
            <div class="font-mono text-[10px] uppercase" style="color: var(--text-dim);">Stage 02</div>
            <div class="font-medium mt-0.5 truncate">CDP Stream</div>
          </div>
          <div id="pipeLine2" class="pipeline-line hidden sm:block"></div>
          <div id="pipeNode3" class="pipeline-node rounded-xl p-3 sm:col-span-1">
            <div class="font-mono text-[10px] uppercase" style="color: var(--text-dim);">Stage 03</div>
            <div class="font-medium mt-0.5 truncate">REA AST</div>
          </div>
          <div id="pipeLine3" class="pipeline-line hidden sm:block"></div>
          <div id="pipeNode4" class="pipeline-node rounded-xl p-3 sm:col-span-1">
            <div class="font-mono text-[10px] uppercase" style="color: var(--text-dim);">Stage 04</div>
            <div class="font-medium mt-0.5 truncate">Local Proxy</div>
          </div>
        </div>
      </div>

      <div id="statusNotice" class="hidden p-3 rounded-xl font-mono text-xs" style="background: var(--accent-soft); border: 1px solid var(--accent); color: var(--text);"></div>
    </section>

    <!-- Airbnb Filter Bar + Notion Gallery/Table View Switcher -->
    <section class="space-y-4">
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div class="flex flex-wrap items-center gap-1.5" id="filterPills">
          <!-- Populated dynamically with live counts -->
        </div>

        <div class="flex flex-wrap items-center gap-2.5">
          <input id="searchInput" type="search" placeholder="Filter by slug or URL (/)" oninput="renderClones()" class="px-3 py-1.5 rounded-lg text-xs w-52 font-mono" />

          <select id="sortSelect" onchange="renderClones()" class="px-2.5 py-1.5 rounded-lg text-xs font-mono">
            <option value="name">Sort: Name</option>
            <option value="size">Sort: Size</option>
            <option value="assets">Sort: Assets</option>
            <option value="port">Sort: Port</option>
          </select>

          <div class="inline-flex rounded-lg p-0.5" style="background: var(--bg-elevated); border: 1px solid var(--border);">
            <button id="viewGalleryBtn" onclick="setViewMode('gallery')" class="px-2.5 py-1 rounded-md text-xs font-medium transition">Gallery</button>
            <button id="viewTableBtn" onclick="setViewMode('table')" class="px-2.5 py-1 rounded-md text-xs font-medium transition">Table</button>
          </div>
        </div>
      </div>

      <!-- Clone Catalog Container -->
      <div id="catalogContainer"></div>
    </section>

    <!-- Software Analysis (.EXE / .MSI) Reverse-Engineering Section -->
    <section id="softwareAnalysisSection" class="surface rounded-2xl p-6 sm:p-8 space-y-6">
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div class="flex items-center gap-2.5">
            <h2 class="font-display text-2xl sm:text-3xl font-semibold tracking-tight">Software Analysis</h2>
            <span class="font-mono text-[10px] px-2 py-0.5 rounded-full" style="background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent);">Static &amp; Isolated Only</span>
          </div>
          <p class="text-sm mt-1.5" style="color: var(--text-muted);">
            Inspect, unpack, and decompile Windows <code class="font-mono">.exe</code> and <code class="font-mono">.msi</code> packages without executing them.
          </p>
        </div>
        <div id="swToolsBar" class="flex flex-wrap items-center gap-1.5 text-[11px] font-mono"></div>
      </div>

      <div id="swDropZone" class="rounded-2xl p-6 text-center transition cursor-pointer" style="background: var(--bg); border: 1.5px dashed var(--border);" onclick="document.getElementById('swFileInput').click()" ondragover="event.preventDefault(); this.style.borderColor='var(--accent)';" ondragleave="this.style.borderColor='var(--border)';" ondrop="handleSwDrop(event)">
        <input id="swFileInput" type="file" accept=".exe,.msi,.dll,.zip,.asar" class="hidden" onchange="handleSwFileSelect(event)" />
        <div class="text-sm font-medium">Drop a Windows <code class="font-mono">.exe</code> or <code class="font-mono">.msi</code> file here, or click to browse</div>
        <div id="swSelectedFileLabel" class="text-xs font-mono mt-1" style="color: var(--text-dim);">Supports PE32/PE32+, .NET, Electron, PyInstaller, Inno Setup, NSIS, WiX Burn, UPX, and MSI</div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
        <div class="sm:col-span-6">
          <input id="swLocalPathInput" type="text" placeholder="Or enter a local server path e.g. /tmp/app.exe (optional)" class="w-full px-3.5 py-2.5 rounded-xl text-xs font-mono" />
        </div>
        <div class="sm:col-span-3 flex items-center gap-4 text-xs" style="color: var(--text-muted);">
          <label class="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input id="swExtractCheck" type="checkbox" checked />
            <span>Extract</span>
          </label>
          <label class="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input id="swDecompileCheck" type="checkbox" checked />
            <span>Decompile</span>
          </label>
        </div>
        <div class="sm:col-span-3">
          <button id="swAnalyzeBtn" onclick="startSoftwareAnalysis()" class="spring-btn w-full py-2.5 px-4 rounded-xl text-sm font-semibold" style="background: var(--accent); color: var(--accent-fg);">
            Analyze Binary
          </button>
        </div>
      </div>

      <div id="swLiveLogPanel" class="hidden rounded-xl p-3 font-mono text-[11px] max-h-40 overflow-y-auto space-y-0.5" style="background: var(--bg); border: 1px solid var(--border); color: var(--text-muted);"></div>

      <div id="softwareListContainer" class="space-y-3"></div>
    </section>
  </main>

  <footer class="px-6 py-5 text-center font-mono text-xs" style="border-top: 1px solid var(--border); color: var(--text-dim);">
    Mimic Studio • Local Reverse-Engineering Workbench
  </footer>

  <!-- Software Analysis Side-Peek Drawer -->
  <div id="swDrawerBackdrop" class="drawer-backdrop fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onclick="closeSwInspector()"></div>
  <aside id="swInspectorDrawer" class="drawer-panel fixed top-0 right-0 bottom-0 w-full max-w-3xl z-50 flex flex-col shadow-2xl">
    <div class="px-6 py-4 flex items-center justify-between" style="border-bottom: 1px solid var(--border);">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <h2 id="swDrawerTitle" class="font-display text-xl font-semibold truncate">Software Inspector</h2>
          <span id="swDrawerStatusBadge" class="font-mono text-xs px-2 py-0.5 rounded"></span>
        </div>
        <div id="swDrawerSubtitle" class="font-mono text-xs truncate mt-0.5" style="color: var(--text-muted);"></div>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="exportSwZip()" class="spring-btn px-2.5 py-1 rounded-lg text-xs font-mono" style="background: var(--bg-subtle); border: 1px solid var(--border);">Export ZIP</button>
        <button onclick="closeSwInspector()" class="spring-btn px-2.5 py-1 rounded-lg text-xs" style="background: var(--bg-subtle); border: 1px solid var(--border);">Close</button>
      </div>
    </div>
    <div class="px-6 flex items-center gap-1 pt-2 overflow-x-auto" style="border-bottom: 1px solid var(--border); background: var(--bg-elevated);">
      <button onclick="setSwTab('overview')" data-swtab="overview" class="sw-tab px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap">Overview</button>
      <button onclick="setSwTab('structure')" data-swtab="structure" class="sw-tab px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap">PE / MSI Tables</button>
      <button onclick="setSwTab('strings')" data-swtab="strings" class="sw-tab px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap">Strings &amp; IOCs</button>
      <button onclick="setSwTab('files')" data-swtab="files" class="sw-tab px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap">Extracted Files</button>
      <button onclick="setSwTab('code')" data-swtab="code" class="sw-tab px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap">Decompiled / Disasm</button>
    </div>
    <div id="swDrawerBody" class="p-6 overflow-y-auto flex-1 space-y-5 text-xs"></div>
  </aside>

  <!-- Notion-Style Side-Peek Inspector Drawer -->
  <div id="drawerBackdrop" class="drawer-backdrop fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onclick="closeInspector()"></div>
  <aside id="inspectorDrawer" class="drawer-panel fixed top-0 right-0 bottom-0 w-full max-w-2xl z-50 flex flex-col shadow-2xl">
    <div class="px-6 py-4 flex items-center justify-between" style="border-bottom: 1px solid var(--border);">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <h2 id="drawerTitle" class="font-display text-xl font-semibold truncate">Inspector</h2>
          <span id="drawerPortBadge" class="font-mono text-xs px-2 py-0.5 rounded tabular-nums" style="background: var(--bg-subtle); border: 1px solid var(--border);"></span>
        </div>
        <div id="drawerUrl" class="font-mono text-xs truncate mt-0.5" style="color: var(--text-muted);"></div>
      </div>
      <div class="flex items-center gap-2">
        <span class="kbd-chip">Esc</span>
        <button onclick="closeInspector()" class="spring-btn px-2.5 py-1 rounded-lg text-xs" style="background: var(--bg-subtle); border: 1px solid var(--border);">Close</button>
      </div>
    </div>

    <!-- Drawer Tabs -->
    <div class="px-6 flex items-center gap-1 pt-2" style="border-bottom: 1px solid var(--border); background: var(--bg-elevated);">
      <button onclick="setInspectorTab('overview')" data-tab="overview" class="inspector-tab px-3 py-2 text-xs font-medium border-b-2">Overview &amp; Tokens</button>
      <button onclick="setInspectorTab('rea')" data-tab="rea" class="inspector-tab px-3 py-2 text-xs font-medium border-b-2">REA Intelligence</button>
      <button onclick="setInspectorTab('audit')" data-tab="audit" class="inspector-tab px-3 py-2 text-xs font-medium border-b-2">Visual Audit</button>
      <button onclick="setInspectorTab('cli')" data-tab="cli" class="inspector-tab px-3 py-2 text-xs font-medium border-b-2">CLI &amp; Proxy</button>
    </div>

    <div id="drawerBody" class="p-6 overflow-y-auto flex-1 space-y-6 text-xs"></div>
  </aside>

  <!-- Linear-Style Cmd+K Command Palette -->
  <div id="cmdPalette" class="palette-backdrop fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-24 px-4" onclick="if (event.target === this) closeCommandPalette()">
    <div class="palette-box w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl">
      <div class="p-3" style="border-bottom: 1px solid var(--border);">
        <input id="paletteInput" type="text" placeholder="Type a command or clone name..." oninput="renderPaletteItems()" class="w-full px-3 py-2 rounded-lg text-sm font-mono border-0 bg-transparent focus:ring-0" />
      </div>
      <div id="paletteList" class="max-h-80 overflow-y-auto p-2 space-y-1"></div>
    </div>
  </div>

  <script>
    const state = {
      clones: [],
      filter: 'all',
      viewMode: localStorage.getItem('mimic_view') || 'gallery',
      theme: localStorage.getItem('mimic_theme') || 'linear',
      inspector: { open: false, name: null, tab: 'overview', data: null, viewport: 'desktop' },
      paletteIndex: 0
    };

    function escapeHtml(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 B';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    function applyTheme(theme) {
      state.theme = theme;
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('mimic_theme', theme);
      const label = document.getElementById('themeLabel');
      if (label) label.textContent = theme === 'aesop' ? 'Linear Dark' : 'Aesop Light';
    }

    function toggleTheme() {
      applyTheme(state.theme === 'linear' ? 'aesop' : 'linear');
    }

    function setPipelineStage(activeStage, doneStages) {
      const doneSet = new Set(doneStages || []);
      for (let i = 1; i <= 4; i++) {
        const node = document.getElementById('pipeNode' + i);
        if (node) {
          node.classList.remove('active', 'done');
          if (doneSet.has(i)) node.classList.add('done');
          else if (activeStage === i) node.classList.add('active');
        }
        if (i < 4) {
          const line = document.getElementById('pipeLine' + i);
          if (line) {
            line.classList.toggle('active', activeStage === i || activeStage === i + 1);
          }
        }
      }
    }

    function updateOnboarding() {
      if (localStorage.getItem('mimic_onboarding_hidden') === '1') {
        document.getElementById('onboardingBar').classList.add('hidden');
        return;
      }
      const hasAnyClone = state.clones.length > 0;
      const hasAnyRea = state.clones.some(c => c.hasRea);
      const hasAnyLiveOrAudit = state.clones.some(c => c.running || c.hasAudit);

      const doneCount = (hasAnyClone ? 1 : 0) + (hasAnyRea ? 1 : 0) + (hasAnyLiveOrAudit ? 1 : 0);
      document.getElementById('onboardingFraction').textContent = doneCount + '/3 complete';
      document.getElementById('onboardingProgress').style.width = Math.round((doneCount / 3) * 100) + '%';

      markStep('stepCapture', hasAnyClone);
      markStep('stepRea', hasAnyRea);
      markStep('stepVerify', hasAnyLiveOrAudit);
    }

    function markStep(id, done) {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.borderColor = done ? 'var(--ok)' : 'var(--border)';
      el.style.background = done ? 'var(--ok-soft)' : 'var(--bg)';
    }

    function toggleOnboarding() {
      localStorage.setItem('mimic_onboarding_hidden', '1');
      document.getElementById('onboardingBar').classList.add('hidden');
    }

    function focusCapture() {
      const inp = document.getElementById('urlInput');
      if (inp) { inp.focus(); inp.select(); }
    }

    function setViewMode(mode) {
      state.viewMode = mode;
      localStorage.setItem('mimic_view', mode);
      document.getElementById('viewGalleryBtn').style.background = mode === 'gallery' ? 'var(--bg-subtle)' : 'transparent';
      document.getElementById('viewTableBtn').style.background = mode === 'table' ? 'var(--bg-subtle)' : 'transparent';
      renderClones();
    }

    function setFilter(f) {
      state.filter = f;
      renderFilterPills();
      renderClones();
    }

    function renderFilterPills() {
      const all = state.clones;
      const counts = {
        all: all.length,
        live: all.filter(c => c.running).length,
        rea: all.filter(c => c.hasRea).length,
        verified: all.filter(c => c.hasAudit).length,
        cdp: all.filter(c => c.engine === 'cdp').length,
        static: all.filter(c => c.engine === 'static').length
      };
      const defs = [
        { key: 'all', label: 'All' },
        { key: 'live', label: 'Live' },
        { key: 'rea', label: 'REA Analyzed' },
        { key: 'verified', label: 'Verified' },
        { key: 'cdp', label: 'CDP' },
        { key: 'static', label: 'Static' }
      ];
      document.getElementById('filterPills').innerHTML = defs.map(d => {
        const active = state.filter === d.key;
        const style = active
          ? 'background: var(--text); color: var(--bg); border-color: var(--text);'
          : 'background: var(--bg-elevated); color: var(--text-muted); border-color: var(--border);';
        return '<button onclick="setFilter(\\'' + d.key + '\\')" class="spring-btn px-3 py-1.5 rounded-full text-xs font-medium border tabular-nums" style="' + style + '">'
          + d.label + ' <span class="opacity-70 ml-1">' + counts[d.key] + '</span></button>';
      }).join('');
    }

    function getFilteredClones() {
      const q = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();
      const sort = document.getElementById('sortSelect')?.value || 'name';

      const filtered = state.clones.filter(c => {
        if (state.filter === 'live' && !c.running) return false;
        if (state.filter === 'rea' && !c.hasRea) return false;
        if (state.filter === 'verified' && !c.hasAudit) return false;
        if (state.filter === 'cdp' && c.engine !== 'cdp') return false;
        if (state.filter === 'static' && c.engine !== 'static') return false;
        if (q) {
          const hay = (c.name + ' ' + (c.targetUrl || '') + ' ' + (c.description || '')).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      filtered.sort((a, b) => {
        if (sort === 'size') return (b.metrics?.totalBytes || 0) - (a.metrics?.totalBytes || 0);
        if (sort === 'assets') return (b.metrics?.assetCount || 0) - (a.metrics?.assetCount || 0);
        if (sort === 'port') return (a.port || 0) - (b.port || 0);
        return a.name.localeCompare(b.name);
      });

      return filtered;
    }

    function renderBadge(label, tone) {
      let style = 'background: var(--bg-subtle); color: var(--text-muted); border: 1px solid var(--border);';
      if (tone === 'ok') style = 'background: var(--ok-soft); color: var(--ok); border: 1px solid var(--ok);';
      if (tone === 'accent') style = 'background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent);';
      if (tone === 'danger') style = 'background: var(--danger-soft); color: var(--danger); border: 1px solid var(--danger);';
      return '<span class="font-mono text-[10px] px-1.5 py-0.5 rounded uppercase" style="' + style + '">' + escapeHtml(label) + '</span>';
    }

    function renderClones() {
      const container = document.getElementById('catalogContainer');
      const items = getFilteredClones();

      if (items.length === 0) {
        container.innerHTML = '<div class="surface rounded-2xl p-12 text-center space-y-2">'
          + '<div class="font-display text-xl font-medium">No matching clones</div>'
          + '<div class="text-xs" style="color: var(--text-muted);">Capture a live URL above or clear your active search filters.</div>'
          + '</div>';
        return;
      }

      if (state.viewMode === 'table') {
        const rows = items.map(c => {
          const m = c.metrics || {};
          const safeName = escapeHtml(c.name);
          const jsName = c.name.replace(/'/g, "\\\\'");
          const auditLabel = c.hasAudit ? (m.passed ? renderBadge('PASS', 'ok') : renderBadge('WARN', 'danger')) : renderBadge('UNVERIFIED', 'neutral');
          return '<tr style="border-top: 1px solid var(--border);" class="hover:opacity-95">'
            + '<td class="py-3 px-4"><button onclick="openInspector(\\'' + jsName + '\\')" class="font-medium hover:underline text-left">' + safeName + '</button>'
            + '<div class="font-mono text-[11px] truncate max-w-xs" style="color: var(--text-dim);">' + escapeHtml(c.targetUrl || '') + '</div></td>'
            + '<td class="py-3 px-3 font-mono text-xs uppercase">' + escapeHtml(c.engine) + '</td>'
            + '<td class="py-3 px-3 font-mono text-xs tabular-nums">:' + c.port + (c.running ? ' ' + renderBadge('LIVE', 'ok') : '') + '</td>'
            + '<td class="py-3 px-3 font-mono text-xs tabular-nums">' + m.assetCount + ' (' + formatBytes(m.totalBytes) + ')</td>'
            + '<td class="py-3 px-3 font-mono text-xs tabular-nums">' + (c.hasRea ? (m.routesCount + ' routes / ' + m.nodeCount + ' nodes') : '—') + '</td>'
            + '<td class="py-3 px-3">' + auditLabel + '</td>'
            + '<td class="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">'
            + '<button onclick="toggleServer(\\'' + jsName + '\\', ' + c.running + ')" class="spring-btn px-2 py-1 rounded text-[11px] font-mono" style="background: var(--bg-subtle); border: 1px solid var(--border);">' + (c.running ? 'Stop' : 'Start') + '</button>'
            + '<button onclick="openInspector(\\'' + jsName + '\\')" class="spring-btn px-2 py-1 rounded text-[11px] font-mono" style="background: var(--bg-subtle); border: 1px solid var(--border);">Inspect</button>'
            + '<a href="/api/export?name=' + encodeURIComponent(c.name) + '&format=zip" class="spring-btn px-2 py-1 rounded text-[11px] font-mono" style="background: var(--bg-subtle); border: 1px solid var(--border);">ZIP</a>'
            + '<button onclick="deleteClone(\\'' + jsName + '\\')" class="spring-btn px-2 py-1 rounded text-[11px] font-mono" style="background: var(--danger-soft); color: var(--danger); border: 1px solid var(--danger);">Del</button>'
            + '</td></tr>';
        }).join('');

        container.innerHTML = '<div class="surface rounded-2xl overflow-x-auto">'
          + '<table class="w-full text-left border-collapse text-xs">'
          + '<thead><tr style="color: var(--text-dim);" class="font-mono text-[11px] uppercase">'
          + '<th class="py-3 px-4">Project</th><th class="py-3 px-3">Engine</th><th class="py-3 px-3">Port</th>'
          + '<th class="py-3 px-3">Assets</th><th class="py-3 px-3">REA</th><th class="py-3 px-3">Audit</th><th class="py-3 px-4 text-right">Actions</th>'
          + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
        return;
      }

      container.innerHTML = '<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">' + items.map(c => {
        const m = c.metrics || {};
        const safeName = escapeHtml(c.name);
        const jsName = c.name.replace(/'/g, "\\\\'");
        const shot = c.hasScreenshot
          ? '<div onclick="openInspector(\\'' + jsName + '\\')" class="cursor-pointer overflow-hidden" style="border-bottom: 1px solid var(--border);">'
            + '<img src="/screenshot/' + encodeURIComponent(c.name) + '" alt="' + safeName + '" class="w-full h-36 object-cover bg-black/20" loading="lazy" /></div>'
          : '';
        const swatches = (c.palette || []).map(col =>
          '<span title="' + escapeHtml(col) + '" class="inline-block w-3 h-3 rounded-full" style="background:' + escapeHtml(col) + '; border: 1px solid var(--border-strong);"></span>'
        ).join('');

        return '<div class="surface card-apple rounded-2xl overflow-hidden flex flex-col justify-between">'
          + '<div>' + shot + '<div class="p-4 space-y-3">'
          + '<div class="flex items-center justify-between gap-2">'
          + '<div class="flex flex-wrap items-center gap-1">'
          + renderBadge(c.engine, 'neutral')
          + (c.hasRea ? renderBadge('REA', 'accent') : '')
          + (c.hasAudit ? renderBadge(m.passed ? 'PASS' : 'WARN', m.passed ? 'ok' : 'danger') : '')
          + (c.running ? renderBadge('LIVE', 'ok') : '')
          + '</div>'
          + '<button onclick="copyText(\\'http://localhost:' + c.port + '\\', this)" title="Copy local URL" class="font-mono text-xs tabular-nums hover:underline" style="color: var(--accent);">:' + c.port + '</button>'
          + '</div>'
          + '<div>'
          + '<h3 onclick="openInspector(\\'' + jsName + '\\')" class="text-sm font-semibold cursor-pointer hover:underline truncate">' + safeName + '</h3>'
          + '<div class="font-mono text-[11px] truncate mt-0.5" style="color: var(--text-dim);">' + escapeHtml(c.targetUrl || c.description || 'Local workspace capture') + '</div>'
          + '</div>'
          + '<div class="grid grid-cols-3 gap-2 pt-1 font-mono text-[11px] tabular-nums" style="color: var(--text-muted);">'
          + '<div><span style="color: var(--text-dim);" class="block text-[10px]">ASSETS</span>' + m.assetCount + '</div>'
          + '<div><span style="color: var(--text-dim);" class="block text-[10px]">SIZE</span>' + formatBytes(m.totalBytes) + '</div>'
          + '<div><span style="color: var(--text-dim);" class="block text-[10px]">REA</span>' + (c.hasRea ? (m.routesCount + 'R / ' + m.endpointsCount + 'E') : '—') + '</div>'
          + '</div>'
          + (swatches ? '<div class="flex items-center gap-1.5 pt-1">' + swatches + '</div>' : '')
          + '</div></div>'
          + '<div class="px-4 py-2.5 flex items-center justify-between gap-1.5 text-xs" style="border-top: 1px solid var(--border); background: var(--bg);">'
          + '<div class="flex items-center gap-1.5 flex-wrap">'
          + '<button onclick="toggleServer(\\'' + jsName + '\\', ' + c.running + ')" class="spring-btn px-2.5 py-1 rounded-lg font-medium" style="background:' + (c.running ? 'var(--danger-soft)' : 'var(--ok-soft)') + '; color:' + (c.running ? 'var(--danger)' : 'var(--ok)') + '; border: 1px solid ' + (c.running ? 'var(--danger)' : 'var(--ok)') + ';">' + (c.running ? 'Stop' : 'Start') + '</button>'
          + '<button onclick="openInspector(\\'' + jsName + '\\')" class="spring-btn px-2.5 py-1 rounded-lg font-medium" style="background: var(--bg-subtle); border: 1px solid var(--border);">Inspect</button>'
          + '<button onclick="analyzeClone(\\'' + jsName + '\\', this)" class="spring-btn px-2 py-1 rounded-lg font-mono text-[11px]" style="background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent);">REA</button>'
          + '<button onclick="verifyProject(\\'' + jsName + '\\', this)" class="spring-btn px-2 py-1 rounded-lg font-mono text-[11px]" style="background: var(--bg-subtle); border: 1px solid var(--border);">Verify</button>'
          + '<a href="/api/export?name=' + encodeURIComponent(c.name) + '&format=zip" class="spring-btn px-2 py-1 rounded-lg font-mono text-[11px]" style="background: var(--bg-subtle); border: 1px solid var(--border);">ZIP</a>'
          + '<button onclick="deleteClone(\\'' + jsName + '\\')" title="Delete clone" class="spring-btn px-2 py-1 rounded-lg font-mono text-[11px]" style="background: var(--danger-soft); color: var(--danger); border: 1px solid var(--danger);">Del</button>'
          + '</div>'
          + '<a href="http://localhost:' + c.port + '" target="_blank" class="spring-btn px-2.5 py-1 rounded-lg font-medium" style="background: var(--text); color: var(--bg);">Open</a>'
          + '</div></div>';
      }).join('') + '</div>';
    }

    async function loadClones() {
      try {
        const res = await fetch('/api/clones');
        const data = await res.json();
        state.clones = data.clones || [];
        renderFilterPills();
        renderClones();
        updateOnboarding();
      } catch (err) {
        console.error(err);
      }
    }

    function showNotice(msg) {
      const notice = document.getElementById('statusNotice');
      notice.classList.remove('hidden');
      notice.textContent = msg;
    }

    async function copyText(text, btn) {
      try {
        await navigator.clipboard.writeText(text);
        if (btn) {
          const prev = btn.textContent;
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = prev; }, 1200);
        }
      } catch {}
    }

    async function toggleServer(name, isRunning) {
      setPipelineStage(4, [1, 2, 3]);
      const offlineEl = document.getElementById('offlineServeCheck');
      const offline = Boolean(offlineEl && offlineEl.checked);
      await fetch('/api/serve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, action: isRunning ? 'stop' : 'start', offline })
      });
      await loadClones();
      setPipelineStage(0, isRunning ? [] : [4]);
    }

    async function deleteClone(name) {
      try {
        const res = await fetch('/api/clone?name=' + encodeURIComponent(name), { method: 'DELETE' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Delete failed');
        showNotice('Removed clone "' + name + '".');
        if (state.inspector.open && state.inspector.name === name) closeInspector();
        await loadClones();
      } catch (err) {
        showNotice('Delete error: ' + err.message);
      }
    }

    async function triggerClone(e) {
      e.preventDefault();
      const targetUrl = document.getElementById('urlInput').value;
      const name = document.getElementById('nameInput').value;
      const engine = document.getElementById('engineSelect').value;
      const rea = document.getElementById('reaCheck').checked;
      const fetchSourceMaps = document.getElementById('sourceMapsCheck').checked;
      const crawl = document.getElementById('crawlCheck').checked;
      const cookies = (document.getElementById('cookiesInput')?.value || '').trim();
      const headers = (document.getElementById('headerInput')?.value || '').trim();
      const btn = document.getElementById('submitBtn');
      const logPanel = document.getElementById('liveLogPanel');

      btn.disabled = true;
      btn.textContent = 'Capturing...';
      if (logPanel) {
        logPanel.innerHTML = '';
        logPanel.classList.remove('hidden');
      }
      setPipelineStage(2, [1]);
      showNotice('Capturing ' + targetUrl + ' via ' + engine.toUpperCase() + (rea && engine === 'cdp' ? ' + REA' : '') + '...');

      try {
        const res = await fetch('/api/clone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl, name, engine, rea, fetchSourceMaps, crawl, cookies, headers })
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Clone failed');
        setPipelineStage(rea ? 3 : 4, [1, 2]);
        showNotice('Pipeline started for "' + d.slug + '" on port :' + d.port + '. Streaming live logs...');

        if (d.jobId && typeof EventSource !== 'undefined') {
          const es = new EventSource('/api/clone/stream?jobId=' + encodeURIComponent(d.jobId));
          es.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data);
              if (msg.type === 'log' && logPanel) {
                const lineEl = document.createElement('div');
                lineEl.textContent = msg.line;
                logPanel.appendChild(lineEl);
                logPanel.scrollTop = logPanel.scrollHeight;
              } else if (msg.type === 'done') {
                es.close();
                loadClones();
                btn.disabled = false;
                btn.textContent = 'Start Capture';
                setPipelineStage(0, [1, 2, 3, 4]);
                showNotice('Capture finished for "' + d.slug + '" (exit ' + msg.code + ').');
              }
            } catch {}
          };
          es.onerror = () => {
            es.close();
            loadClones();
            btn.disabled = false;
            btn.textContent = 'Start Capture';
            setPipelineStage(0, [1, 2, 3, 4]);
          };
        } else {
          setTimeout(() => {
            loadClones();
            btn.disabled = false;
            btn.textContent = 'Start Capture';
            setPipelineStage(0, [1, 2, 3, 4]);
          }, 4500);
        }
      } catch (err) {
        showNotice('Capture error: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Start Capture';
      }
    }

    async function analyzeClone(name, btn) {
      const prev = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '...'; }
      setPipelineStage(3, [1, 2]);
      showNotice('Running REA offline JavaScript application graph analysis for "' + name + '"...');
      try {
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        const d = await res.json();
        if (!res.ok || d.error) throw new Error(d.error || 'REA analysis failed');
        setPipelineStage(0, [1, 2, 3]);
        showNotice('REA analyzed ' + d.summary.analyzedModuleCount + ' modules (' + d.summary.nodeCount + ' nodes, ' + d.summary.edgeCount + ' edges) for "' + name + '".');
        await loadClones();
        if (state.inspector.open && state.inspector.name === name) {
          await openInspector(name, state.inspector.tab);
        }
      } catch (err) {
        showNotice('REA error: ' + err.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = prev; }
      }
    }

    async function verifyProject(name, btn) {
      const prev = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '...'; }
      setPipelineStage(4, [1, 2, 3]);
      showNotice('Running desktop (1440x900) and mobile (390x844) headless audit for "' + name + '"...');
      try {
        const res = await fetch('/api/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        const d = await res.json();
        if (!res.ok || d.error) throw new Error(d.error || 'Verification failed');
        setPipelineStage(0, [1, 2, 3, 4]);
        showNotice('Audit for "' + name + '": ' + (d.report.passed ? 'PASSED' : 'ISSUES DETECTED') + ' (console: ' + d.report.consoleErrors.length + ', network: ' + d.report.networkErrors.length + ').');
        await loadClones();
        if (state.inspector.open && state.inspector.name === name) {
          await openInspector(name, 'audit');
        }
      } catch (err) {
        showNotice('Verify error: ' + err.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = prev; }
      }
    }

    function runFirstMissingRea() {
      const target = state.clones.find(c => !c.hasRea) || state.clones[0];
      if (!target) { focusCapture(); return; }
      analyzeClone(target.name);
    }

    function runFirstMissingVerify() {
      const target = state.clones.find(c => !c.hasAudit) || state.clones[0];
      if (!target) { focusCapture(); return; }
      verifyProject(target.name);
    }

    /* Notion Side-Peek Inspector Drawer */
    async function openInspector(name, tab) {
      state.inspector.open = true;
      state.inspector.name = name;
      if (tab) state.inspector.tab = tab;
      document.getElementById('drawerBackdrop').classList.add('open');
      document.getElementById('inspectorDrawer').classList.add('open');
      document.getElementById('drawerTitle').textContent = name;
      document.getElementById('drawerBody').innerHTML = '<div class="font-mono" style="color: var(--text-muted);">Loading telemetry...</div>';

      try {
        const res = await fetch('/api/inspect?name=' + encodeURIComponent(name));
        const data = await res.json();
        state.inspector.data = data;
        document.getElementById('drawerPortBadge').textContent = ':' + data.clone.port;
        document.getElementById('drawerUrl').textContent = data.clone.targetUrl || data.clone.path;
        setInspectorTab(state.inspector.tab);
      } catch (err) {
        document.getElementById('drawerBody').innerHTML = '<div style="color: var(--danger);">' + escapeHtml(err.message) + '</div>';
      }
    }

    function closeInspector() {
      state.inspector.open = false;
      document.getElementById('drawerBackdrop').classList.remove('open');
      document.getElementById('inspectorDrawer').classList.remove('open');
    }

    function setInspectorTab(tab) {
      state.inspector.tab = tab;
      document.querySelectorAll('.inspector-tab').forEach(btn => {
        const active = btn.getAttribute('data-tab') === tab;
        btn.style.borderColor = active ? 'var(--accent)' : 'transparent';
        btn.style.color = active ? 'var(--text)' : 'var(--text-muted)';
      });
      renderInspectorBody();
    }

    function setAuditViewport(vp) {
      state.inspector.viewport = vp;
      renderInspectorBody();
    }

    function renderInspectorBody() {
      const body = document.getElementById('drawerBody');
      const d = state.inspector.data;
      if (!d) return;
      const c = d.clone;
      const jsName = c.name.replace(/'/g, "\\\\'");

      if (state.inspector.tab === 'overview') {
        const m = d.manifest || {};
        const page = m.page || {};
        const colors = (page.colors || []).map(col =>
          '<div class="flex items-center gap-2 px-2 py-1 rounded-lg" style="background: var(--bg-elevated); border: 1px solid var(--border);">'
          + '<span class="w-3.5 h-3.5 rounded-full" style="background:' + escapeHtml(col) + ';"></span>'
          + '<span class="font-mono text-[11px]">' + escapeHtml(col) + '</span></div>'
        ).join('');
        const fonts = (page.fonts || []).map(f => '<div class="font-mono text-[11px] py-1">' + escapeHtml(f) + '</div>').join('');
        const cssVars = Object.entries(page.cssVariables || {}).slice(0, 15).map(([k, v]) =>
          '<tr style="border-top: 1px solid var(--border);"><td class="py-1.5 pr-3 font-mono text-[11px]" style="color: var(--accent);">' + escapeHtml(k) + '</td><td class="py-1.5 font-mono text-[11px]">' + escapeHtml(v) + '</td></tr>'
        ).join('');

        const crawled = (m.crawledRoutes || []).map(r =>
          '<span class="font-mono text-[11px] px-2 py-0.5 rounded" style="background: var(--bg-subtle); border: 1px solid var(--border);">' + escapeHtml(r) + '</span>'
        ).join(' ');

        body.innerHTML =
          '<div class="grid grid-cols-3 sm:grid-cols-6 gap-3">'
          + '<div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">DOM</div><div class="font-mono text-sm font-semibold tabular-nums mt-0.5">' + formatBytes(m.domBytes || 0) + '</div></div>'
          + '<div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">ASSETS</div><div class="font-mono text-sm font-semibold tabular-nums mt-0.5">' + (m.assetCount || 0) + '</div></div>'
          + '<div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">TRACKERS</div><div class="font-mono text-sm font-semibold tabular-nums mt-0.5">' + (m.skippedTrackers || 0) + '</div></div>'
          + '<div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">CDNS</div><div class="font-mono text-sm font-semibold tabular-nums mt-0.5">' + ((m.externalHosts || []).length) + '</div></div>'
          + '<div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">FIXTURES</div><div class="font-mono text-sm font-semibold tabular-nums mt-0.5">' + (m.fixtureCount || 0) + '</div></div>'
          + '<div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">ROUTES</div><div class="font-mono text-sm font-semibold tabular-nums mt-0.5">' + ((m.crawledRoutes || []).length) + '</div></div>'
          + '</div>'
          + (crawled ? '<div><div class="font-medium mb-2">Crawled routes</div><div class="flex flex-wrap gap-1.5">' + crawled + '</div></div>' : '')
          + '<div><div class="font-medium mb-2">Extracted palette</div><div class="flex flex-wrap gap-2">' + (colors || '<span style="color: var(--text-dim);">No manifest palette recorded yet.</span>') + '</div></div>'
          + '<div><div class="font-medium mb-2">Fonts</div>' + (fonts || '<span style="color: var(--text-dim);">None recorded.</span>') + '</div>'
          + (cssVars ? '<div><div class="font-medium mb-2">CSS custom properties</div><table class="w-full">' + cssVars + '</table></div>' : '');
        return;
      }

      if (state.inspector.tab === 'rea') {
        const rb = d.reaBundle;
        const ra = d.reaAnalysis;
        const routes = (rb?.routes || []).map(r => '<span class="font-mono text-[11px] px-2 py-0.5 rounded" style="background: var(--bg-subtle); border: 1px solid var(--border);">' + escapeHtml(r) + '</span>').join(' ');
        const endpoints = (rb?.endpoints || []).map(ep => '<span class="font-mono text-[11px] px-2 py-0.5 rounded" style="background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent);">' + escapeHtml(ep) + '</span>').join(' ');
        const chunks = (rb?.chunks || []).slice(0, 12).map(ch =>
          '<tr style="border-top: 1px solid var(--border);"><td class="py-1.5 pr-2 font-mono text-[11px] truncate max-w-xs">' + escapeHtml(ch.url) + '</td><td class="py-1.5 pr-2 font-mono text-[11px] tabular-nums">' + formatBytes(ch.bytes) + '</td><td class="py-1.5 font-mono text-[10px]" style="color: var(--text-dim);">' + escapeHtml((ch.sha256 || '').slice(0, 12)) + '</td></tr>'
        ).join('');
        const families = (ra?.semanticFamilies || []).map(f =>
          '<span class="font-mono text-[11px] px-2 py-0.5 rounded" style="background: var(--bg-subtle); border: 1px solid var(--border);">' + escapeHtml(f.family) + ': ' + f.retainedRelations + '</span>'
        ).join(' ');

        body.innerHTML =
          '<div class="flex items-center justify-between gap-2">'
          + '<div>' + (ra?.evidenceId ? '<span class="font-mono text-[11px]" style="color: var(--text-dim);">Evidence: ' + escapeHtml(ra.evidenceId.slice(0, 20)) + '...</span>' : 'No offline JS graph saved yet.') + '</div>'
          + '<button onclick="analyzeClone(\\'' + jsName + '\\', this)" class="spring-btn px-3 py-1.5 rounded-lg font-medium" style="background: var(--accent); color: var(--accent-fg);">Run Offline REA Analysis</button>'
          + '</div>'
          + (ra ? '<div class="grid grid-cols-3 gap-3"><div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">NODES</div><div class="font-mono text-sm font-semibold tabular-nums">' + ra.nodeCount + '</div></div><div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">EDGES</div><div class="font-mono text-sm font-semibold tabular-nums">' + ra.edgeCount + '</div></div><div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">MODULES</div><div class="font-mono text-sm font-semibold tabular-nums">' + ra.analyzedModuleCount + '</div></div></div>' : '')
          + '<div><div class="font-medium mb-1.5">Discovered routes (' + (rb?.routes?.length || 0) + ')</div><div class="flex flex-wrap gap-1.5">' + (routes || '<span style="color: var(--text-dim);">Run CDP capture with --rea to extract live routes.</span>') + '</div></div>'
          + '<div><div class="font-medium mb-1.5">Auto-mocked API endpoints (' + (rb?.endpoints?.length || 0) + ')</div><div class="flex flex-wrap gap-1.5">' + (endpoints || '<span style="color: var(--text-dim);">No endpoints extracted.</span>') + '</div></div>'
          + (families ? '<div><div class="font-medium mb-1.5">Semantic families</div><div class="flex flex-wrap gap-1.5">' + families + '</div></div>' : '')
          + (chunks ? '<div><div class="font-medium mb-1.5">Captured script chunks</div><table class="w-full">' + chunks + '</table></div>' : '');
        return;
      }

      if (state.inspector.tab === 'audit') {
        const ar = d.auditReport;
        const vp = state.inspector.viewport;
        const imgUrl = '/audit-image/' + vp + '/' + encodeURIComponent(c.name) + '?t=' + Date.now();
        const errorsList = (ar?.consoleErrors || []).concat(ar?.networkErrors || []).map(e =>
          '<div class="font-mono text-[11px] p-2 rounded" style="background: var(--danger-soft); color: var(--danger);">' + escapeHtml(e) + '</div>'
        ).join('');
        const vd = ar?.visualDiff;

        body.innerHTML =
          '<div class="flex items-center justify-between gap-2">'
          + '<div class="inline-flex rounded-lg p-0.5" style="background: var(--bg-elevated); border: 1px solid var(--border);">'
          + '<button onclick="setAuditViewport(\\'desktop\\')" class="px-3 py-1 rounded-md text-xs font-medium" style="background:' + (vp === 'desktop' ? 'var(--bg-subtle)' : 'transparent') + ';">Desktop 1440×900</button>'
          + '<button onclick="setAuditViewport(\\'mobile\\')" class="px-3 py-1 rounded-md text-xs font-medium" style="background:' + (vp === 'mobile' ? 'var(--bg-subtle)' : 'transparent') + ';">Mobile 390×844</button>'
          + (vd ? '<button onclick="setAuditViewport(\\'diff\\')" class="px-3 py-1 rounded-md text-xs font-medium" style="background:' + (vp === 'diff' ? 'var(--bg-subtle)' : 'transparent') + ';">Diff (' + vd.diffPercent + '%)</button>' : '')
          + '</div>'
          + '<button onclick="verifyProject(\\'' + jsName + '\\', this)" class="spring-btn px-3 py-1.5 rounded-lg font-medium" style="background: var(--accent); color: var(--accent-fg);">Run Verify Audit</button>'
          + '</div>'
          + (ar ? '<div class="grid grid-cols-3 sm:grid-cols-6 gap-3">'
            + '<div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">STATUS</div><div class="font-mono text-sm font-semibold" style="color:' + (ar.passed ? 'var(--ok)' : 'var(--danger)') + ';">' + (ar.passed ? 'PASS' : 'ISSUES') + '</div></div>'
            + '<div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">CONSOLE</div><div class="font-mono text-sm font-semibold tabular-nums">' + ar.consoleErrors.length + '</div></div>'
            + '<div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">HTTP ERR</div><div class="font-mono text-sm font-semibold tabular-nums">' + ar.networkErrors.length + '</div></div>'
            + '<div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">BROKEN IMG</div><div class="font-mono text-sm font-semibold tabular-nums">' + (ar.desktop?.brokenImages ?? 0) + ' / ' + (ar.mobile?.brokenImages ?? 0) + '</div></div>'
            + '<div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">FONTS/SVG</div><div class="font-mono text-sm font-semibold tabular-nums">' + ((ar.desktop?.brokenFonts ?? 0) + (ar.desktop?.brokenSvgUses ?? 0)) + '</div></div>'
            + '<div class="surface p-3 rounded-xl"><div class="text-[10px] font-mono" style="color: var(--text-dim);">VISUAL DIFF</div><div class="font-mono text-sm font-semibold tabular-nums">' + (vd ? (vd.diffPercent + '%') : '—') + '</div></div>'
            + '</div>' : '<div style="color: var(--text-muted);">No audit-report.json yet. Run Verify Audit to test console errors, broken images, and mobile overflow.</div>')
          + '<div class="rounded-xl overflow-hidden" style="border: 1px solid var(--border);"><img src="' + imgUrl + '" alt="Audit viewport preview" class="w-full h-auto bg-black/20" onerror="this.style.display=\\'none\\'" /></div>'
          + (errorsList ? '<div class="space-y-1.5"><div class="font-medium">Deduplicated issues</div>' + errorsList + '</div>' : '');
        return;
      }

      if (state.inspector.tab === 'cli') {
        const cmds = [
          { label: 'Serve locally', cmd: 'node src/cli.js serve ' + c.name + ' --port ' + c.port },
          { label: 'REA static JS analysis', cmd: 'node src/cli.js analyze ' + c.name + ' --json' },
          { label: 'Headless verify audit', cmd: 'node src/cli.js verify ' + c.name + ' --port ' + c.port }
        ];
        if (c.targetUrl) {
          cmds.unshift({ label: 'Re-capture with CDP + REA', cmd: 'node src/cli.js capture ' + c.targetUrl + ' ' + c.name + ' --rea' });
        }
        body.innerHTML = '<div class="space-y-3">' + cmds.map(item =>
          '<div class="surface p-3 rounded-xl flex items-center justify-between gap-3">'
          + '<div class="min-w-0"><div class="text-[11px] font-medium mb-1">' + escapeHtml(item.label) + '</div>'
          + '<code class="font-mono text-[11px] break-all" style="color: var(--text-muted);">' + escapeHtml(item.cmd) + '</code></div>'
          + '<button onclick="copyText(\\'' + escapeHtml(item.cmd).replace(/'/g, "\\\\'") + '\\', this)" class="spring-btn shrink-0 px-2.5 py-1 rounded-lg font-mono text-[11px]" style="background: var(--bg-subtle); border: 1px solid var(--border);">Copy</button>'
          + '</div>'
        ).join('') + '</div>';
      }
    }

    /* Linear Command Palette (Ctrl/Cmd + K) */
    function buildPaletteCommands() {
      const items = [
        { title: 'Focus Capture URL input', hint: 'C', run: () => focusCapture() },
        { title: 'Switch Theme (Linear Dark / Aesop Light)', hint: 'T', run: () => toggleTheme() },
        { title: 'Toggle Gallery / Table View', hint: 'View', run: () => setViewMode(state.viewMode === 'gallery' ? 'table' : 'gallery') },
        { title: 'Filter: Live Running Servers', hint: 'Filter', run: () => setFilter('live') },
        { title: 'Filter: All Clones', hint: 'Filter', run: () => setFilter('all') }
      ];
      state.clones.forEach(c => {
        items.push({ title: 'Inspect ' + c.name, hint: 'Drawer', run: () => openInspector(c.name, 'overview') });
        items.push({ title: 'Analyze ' + c.name + ' with REA', hint: 'REA', run: () => analyzeClone(c.name) });
        items.push({ title: (c.running ? 'Stop' : 'Start') + ' ' + c.name + ' (:' + c.port + ')', hint: 'Server', run: () => toggleServer(c.name, c.running) });
      });
      return items;
    }

    function openCommandPalette() {
      document.getElementById('cmdPalette').classList.add('open');
      const inp = document.getElementById('paletteInput');
      inp.value = '';
      state.paletteIndex = 0;
      renderPaletteItems();
      setTimeout(() => inp.focus(), 10);
    }

    function closeCommandPalette() {
      document.getElementById('cmdPalette').classList.remove('open');
    }

    function renderPaletteItems() {
      const q = (document.getElementById('paletteInput').value || '').trim().toLowerCase();
      const all = buildPaletteCommands().filter(item => !q || item.title.toLowerCase().includes(q));
      const visible = all.slice(0, 12);
      window._paletteVisible = visible;
      if (state.paletteIndex >= visible.length) state.paletteIndex = 0;

      document.getElementById('paletteList').innerHTML = visible.map((item, idx) => {
        const active = idx === state.paletteIndex;
        const style = active ? 'background: var(--accent-soft); color: var(--text);' : 'color: var(--text-muted);';
        return '<button onclick="runPaletteItem(' + idx + ')" class="w-full text-left px-3 py-2 rounded-lg flex items-center justify-between text-xs" style="' + style + '">'
          + '<span class="truncate">' + escapeHtml(item.title) + '</span>'
          + '<span class="kbd-chip ml-2 shrink-0">' + escapeHtml(item.hint) + '</span></button>';
      }).join('') || '<div class="p-4 text-center text-xs" style="color: var(--text-dim);">No matching commands</div>';
    }

    function runPaletteItem(idx) {
      const item = (window._paletteVisible || [])[idx];
      closeCommandPalette();
      if (item && item.run) item.run();
    }

    document.addEventListener('keydown', (e) => {
      const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
      const inInput = tag === 'input' || tag === 'textarea' || tag === 'select';

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (document.getElementById('cmdPalette').classList.contains('open')) closeCommandPalette();
        else openCommandPalette();
        return;
      }

      if (e.key === 'Escape') {
        if (document.getElementById('cmdPalette').classList.contains('open')) closeCommandPalette();
        else if (state.inspector.open) closeInspector();
        return;
      }

      if (document.getElementById('cmdPalette').classList.contains('open')) {
        const visible = window._paletteVisible || [];
        if (e.key === 'ArrowDown' && visible.length) {
          e.preventDefault();
          state.paletteIndex = (state.paletteIndex + 1) % visible.length;
          renderPaletteItems();
        } else if (e.key === 'ArrowUp' && visible.length) {
          e.preventDefault();
          state.paletteIndex = (state.paletteIndex - 1 + visible.length) % visible.length;
          renderPaletteItems();
        } else if (e.key === 'Enter' && visible[state.paletteIndex]) {
          e.preventDefault();
          runPaletteItem(state.paletteIndex);
        }
        return;
      }

      if (inInput) return;
      if (e.key.toLowerCase() === 'c') { e.preventDefault(); focusCapture(); }
      else if (e.key.toLowerCase() === 't') { e.preventDefault(); toggleTheme(); }
      else if (e.key === '/') { e.preventDefault(); document.getElementById('searchInput').focus(); }
    });

    const swState = {
      selectedFile: null,
      analyses: [],
      tools: {},
      inspector: { open: false, slug: null, tab: 'overview', report: null, previewPath: null, previewContent: null }
    };

    function handleSwFileSelect(e) {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      swState.selectedFile = f;
      document.getElementById('swSelectedFileLabel').textContent = 'Selected: ' + f.name + ' (' + formatBytes(f.size) + ')';
    }

    function handleSwDrop(e) {
      e.preventDefault();
      e.currentTarget.style.borderColor = 'var(--border)';
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      swState.selectedFile = f;
      document.getElementById('swSelectedFileLabel').textContent = 'Selected: ' + f.name + ' (' + formatBytes(f.size) + ')';
    }

    async function loadSoftwareTools() {
      try {
        const res = await fetch('/api/software/tools');
        const data = await res.json();
        swState.tools = data.tools || {};
        const keys = ['7z', 'objdump', 'ilspycmd', 'ghidra', 'msiinfo', 'innoextract', 'upx', 'python3'];
        document.getElementById('swToolsBar').innerHTML = keys.map(k => {
          const t = swState.tools[k];
          if (!t) return '';
          const ok = t.available;
          const style = ok
            ? 'background: rgba(16,185,129,0.12); color: #10b981; border: 1px solid rgba(16,185,129,0.3);'
            : 'background: var(--bg); color: var(--text-dim); border: 1px solid var(--border);';
          return '<span title="' + escapeHtml(t.version || t.purpose) + '" class="px-2 py-0.5 rounded-md" style="' + style + '">'
            + (ok ? '✓ ' : '✗ ') + escapeHtml(k) + '</span>';
        }).join('');
      } catch {}
    }

    async function loadSoftwareAnalyses() {
      try {
        const res = await fetch('/api/software/list');
        const data = await res.json();
        swState.analyses = data.analyses || [];
        renderSoftwareAnalyses();
      } catch {}
    }

    function swStatusBadgeStyle(status) {
      if (status === 'decompiled' || status === 'extracted') return 'background: rgba(16,185,129,0.12); color: #10b981; border: 1px solid rgba(16,185,129,0.3);';
      if (status === 'partial') return 'background: rgba(245,158,11,0.12); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3);';
      return 'background: rgba(239,68,68,0.12); color: #ef4444; border: 1px solid rgba(239,68,68,0.3);';
    }

    function renderSoftwareAnalyses() {
      const container = document.getElementById('softwareListContainer');
      if (!swState.analyses.length) {
        container.innerHTML = '<div class="rounded-xl p-6 text-center text-xs font-mono" style="background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);">No binaries analyzed yet. Drop an .exe or .msi above to begin.</div>';
        return;
      }
      container.innerHTML = swState.analyses.map(item => {
        return '<div class="rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3" style="background: var(--bg); border: 1px solid var(--border);">'
          + '<div class="min-w-0 space-y-1">'
          + '  <div class="flex flex-wrap items-center gap-2">'
          + '    <span class="font-mono text-sm font-semibold truncate">' + escapeHtml(item.fileName) + '</span>'
          + '    <span class="font-mono text-[10px] px-2 py-0.5 rounded" style="' + swStatusBadgeStyle(item.overallStatus) + '">' + escapeHtml(item.overallStatus) + '</span>'
          + '    <span class="font-mono text-[10px] px-2 py-0.5 rounded" style="background: var(--bg-subtle); border: 1px solid var(--border);">' + escapeHtml(item.kind) + '</span>'
          + (item.installerFramework ? '<span class="font-mono text-[10px] px-2 py-0.5 rounded" style="background: var(--accent-soft); color: var(--accent);">' + escapeHtml(item.installerFramework) + '</span>' : '')
          + '  </div>'
          + '  <div class="font-mono text-[11px] truncate" style="color: var(--text-dim);">'
          + escapeHtml(item.fileType) + ' • ' + formatBytes(item.size) + ' • SHA256: ' + escapeHtml((item.sha256 || '').slice(0, 16)) + '…'
          + ' • Extracted: ' + item.extractedCount + ' • Decompiled: ' + item.decompiledCount
          + '  </div>'
          + '</div>'
          + '<div class="flex items-center gap-2 shrink-0">'
          + '  <button onclick="openSwInspector(\\'' + escapeHtml(item.slug) + '\\')" class="spring-btn px-3 py-1.5 rounded-lg text-xs font-medium" style="background: var(--accent); color: var(--accent-fg);">Inspect</button>'
          + '  <a href="/api/software/export?name=' + encodeURIComponent(item.slug) + '" class="spring-btn px-3 py-1.5 rounded-lg text-xs font-mono" style="background: var(--bg-subtle); border: 1px solid var(--border);">ZIP</a>'
          + '</div>'
          + '</div>';
      }).join('');
    }

    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const res = String(reader.result || '');
          const idx = res.indexOf(',');
          resolve(idx >= 0 ? res.slice(idx + 1) : res);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    async function startSoftwareAnalysis() {
      const btn = document.getElementById('swAnalyzeBtn');
      const logPanel = document.getElementById('swLiveLogPanel');
      const localPath = (document.getElementById('swLocalPathInput').value || '').trim();
      const extract = document.getElementById('swExtractCheck').checked;
      const decompile = document.getElementById('swDecompileCheck').checked;

      if (!swState.selectedFile && !localPath) {
        alert('Please drop/select a file or enter a local server file path.');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Analyzing...';
      logPanel.classList.remove('hidden');
      logPanel.innerHTML = '<div>[init] Starting static analysis &amp; isolated extraction...</div>';

      try {
        const payload = { localPath, extract, decompile };
        if (swState.selectedFile) {
          payload.fileName = swState.selectedFile.name;
          payload.base64Data = await readFileAsBase64(swState.selectedFile);
        }
        const res = await fetch('/api/software/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Analysis failed');

        const es = new EventSource('/api/software/stream?jobId=' + encodeURIComponent(data.jobId));
        es.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'log') {
            const div = document.createElement('div');
            div.textContent = msg.line;
            logPanel.appendChild(div);
            logPanel.scrollTop = logPanel.scrollHeight;
          } else if (msg.type === 'done') {
            es.close();
            btn.disabled = false;
            btn.textContent = 'Analyze Binary';
            loadSoftwareAnalyses();
            if (msg.code === 0 && msg.slug) openSwInspector(msg.slug);
          }
        };
        es.onerror = () => {
          es.close();
          btn.disabled = false;
          btn.textContent = 'Analyze Binary';
          loadSoftwareAnalyses();
        };
      } catch (err) {
        const div = document.createElement('div');
        div.textContent = '[error] ' + err.message;
        logPanel.appendChild(div);
        btn.disabled = false;
        btn.textContent = 'Analyze Binary';
      }
    }

    async function openSwInspector(slug) {
      swState.inspector.open = true;
      swState.inspector.slug = slug;
      swState.inspector.tab = 'overview';
      swState.inspector.previewPath = null;
      swState.inspector.previewContent = null;
      document.getElementById('swDrawerBackdrop').classList.add('open');
      document.getElementById('swInspectorDrawer').classList.add('open');
      document.getElementById('swDrawerTitle').textContent = slug;
      document.getElementById('swDrawerBody').innerHTML = '<div class="font-mono p-4">Loading analysis report...</div>';

      const res = await fetch('/api/software/inspect?name=' + encodeURIComponent(slug));
      const data = await res.json();
      swState.inspector.report = data.report;
      const r = data.report;
      if (r) {
        document.getElementById('swDrawerTitle').textContent = r.file?.name || slug;
        document.getElementById('swDrawerSubtitle').textContent = (r.identity?.fileType || '') + ' • SHA256: ' + (r.file?.sha256 || '');
        const badge = document.getElementById('swDrawerStatusBadge');
        badge.textContent = r.overallStatus || 'partial';
        badge.setAttribute('style', swStatusBadgeStyle(r.overallStatus));
      }
      renderSwTab();
    }

    function closeSwInspector() {
      swState.inspector.open = false;
      document.getElementById('swDrawerBackdrop').classList.remove('open');
      document.getElementById('swInspectorDrawer').classList.remove('open');
    }

    function setSwTab(tab) {
      swState.inspector.tab = tab;
      renderSwTab();
    }

    function exportSwZip() {
      if (!swState.inspector.slug) return;
      window.open('/api/software/export?name=' + encodeURIComponent(swState.inspector.slug), '_blank');
    }

    async function previewSwFile(relPath) {
      const slug = swState.inspector.slug;
      if (!slug) return;
      swState.inspector.previewPath = relPath;
      swState.inspector.previewContent = 'Loading...';
      renderSwTab();
      const res = await fetch('/api/software/file?name=' + encodeURIComponent(slug) + '&path=' + encodeURIComponent(relPath));
      const data = await res.json();
      swState.inspector.previewContent = data.content || data.error || '';
      renderSwTab();
    }

    function renderSwTab() {
      document.querySelectorAll('.sw-tab').forEach(btn => {
        const active = btn.getAttribute('data-swtab') === swState.inspector.tab;
        btn.style.borderColor = active ? 'var(--accent)' : 'transparent';
        btn.style.color = active ? 'var(--text)' : 'var(--text-muted)';
      });

      const r = swState.inspector.report;
      const body = document.getElementById('swDrawerBody');
      if (!r) { body.innerHTML = '<div>Report unavailable.</div>'; return; }

      const tab = swState.inspector.tab;
      if (tab === 'overview') {
        const id = r.identity || {};
        const notes = [...(r.notes || []), ...(r.extraction?.notes || []), ...(r.decompilation?.notes || [])];
        body.innerHTML =
          '<div class="rounded-xl p-3 font-mono text-[11px]" style="background: rgba(16,185,129,0.08); border: 1px solid rgba(16,185,129,0.25); color: #10b981;">'
          + escapeHtml(r.safetyNotice || 'Static analysis only.') + '</div>'
          + '<div class="grid grid-cols-2 gap-3">'
          + '  <div class="rounded-xl p-3" style="background: var(--bg); border: 1px solid var(--border);"><div style="color: var(--text-dim);">Architecture</div><div class="font-mono font-semibold mt-1">' + escapeHtml(id.architecture || 'N/A') + '</div></div>'
          + '  <div class="rounded-xl p-3" style="background: var(--bg); border: 1px solid var(--border);"><div style="color: var(--text-dim);">Runtime / Framework</div><div class="font-mono font-semibold mt-1">' + escapeHtml(id.runtime || 'N/A') + '</div></div>'
          + '  <div class="rounded-xl p-3" style="background: var(--bg); border: 1px solid var(--border);"><div style="color: var(--text-dim);">Installer Framework</div><div class="font-mono font-semibold mt-1">' + escapeHtml(id.installerFramework || 'None detected') + '</div></div>'
          + '  <div class="rounded-xl p-3" style="background: var(--bg); border: 1px solid var(--border);"><div style="color: var(--text-dim);">Packers</div><div class="font-mono font-semibold mt-1">' + escapeHtml((id.packers && id.packers.length) ? id.packers.join(', ') : 'None detected') + '</div></div>'
          + '  <div class="rounded-xl p-3" style="background: var(--bg); border: 1px solid var(--border);"><div style="color: var(--text-dim);">Extraction</div><div class="font-mono font-semibold mt-1">' + escapeHtml(r.extraction?.status) + ' (' + (r.extraction?.files?.length || 0) + ' files)</div></div>'
          + '  <div class="rounded-xl p-3" style="background: var(--bg); border: 1px solid var(--border);"><div style="color: var(--text-dim);">Decompilation</div><div class="font-mono font-semibold mt-1">' + escapeHtml(r.decompilation?.status) + ' (' + (r.decompilation?.files?.length || 0) + ' files)</div></div>'
          + '</div>'
          + (notes.length ? '<div class="rounded-xl p-3 space-y-1 font-mono text-[11px]" style="background: var(--bg); border: 1px solid var(--border);"><div class="font-semibold" style="color: var(--text);">Notes &amp; Limitations</div>' + notes.map(n => '<div style="color: var(--text-muted);">• ' + escapeHtml(n) + '</div>').join('') + '</div>' : '');
      } else if (tab === 'structure') {
        if (r.pe?.isPE) {
          const secs = (r.pe.sections || []).map(s => '<tr><td class="py-1 pr-3 font-mono">' + escapeHtml(s.name) + '</td><td class="py-1 pr-3 font-mono">0x' + s.virtualAddress.toString(16) + '</td><td class="py-1 pr-3 font-mono">' + s.rawSize + '</td><td class="py-1 font-mono">' + s.entropy + '</td></tr>').join('');
          const deps = (r.pe.dependencies || []).map(d => '<span class="px-2 py-0.5 rounded font-mono text-[11px]" style="background: var(--bg-subtle); border: 1px solid var(--border);">' + escapeHtml(d) + '</span>').join('');
          body.innerHTML =
            '<div class="rounded-xl p-4 space-y-2" style="background: var(--bg); border: 1px solid var(--border);">'
            + '<div class="font-semibold">PE Sections</div>'
            + '<table class="w-full text-left text-[11px]"><thead><tr style="color: var(--text-dim);"><th>Name</th><th>VAddr</th><th>Raw Size</th><th>Entropy</th></tr></thead><tbody>' + secs + '</tbody></table>'
            + '</div>'
            + '<div class="rounded-xl p-4 space-y-2" style="background: var(--bg); border: 1px solid var(--border);">'
            + '<div class="font-semibold">DLL Dependencies (' + (r.pe.dependencies?.length || 0) + ')</div>'
            + '<div class="flex flex-wrap gap-1.5">' + (deps || '<span style="color: var(--text-dim);">None</span>') + '</div>'
            + '</div>';
        } else if (r.msi?.isMsi) {
          const tblNames = (r.msi.ole2?.tablesDetected || []).join(', ');
          const cabs = (r.msi.ole2?.embeddedCabs || []).length + ' embedded, ' + (r.msi.ole2?.externalCabs || []).length + ' external';
          body.innerHTML =
            '<div class="rounded-xl p-4 space-y-2" style="background: var(--bg); border: 1px solid var(--border);">'
            + '<div class="font-semibold">MSI OLE2 Container</div>'
            + '<div class="font-mono text-[11px]" style="color: var(--text-muted);">CABs: ' + escapeHtml(cabs) + '</div>'
            + '<div class="font-mono text-[11px]" style="color: var(--text-muted);">Tables: ' + escapeHtml(tblNames || 'None') + '</div>'
            + '</div>'
            + (r.msi.fileMappings?.length ? '<div class="rounded-xl p-4 space-y-1" style="background: var(--bg); border: 1px solid var(--border);"><div class="font-semibold">File Mappings (' + r.msi.fileMappings.length + ')</div>' + r.msi.fileMappings.slice(0, 100).map(f => '<div class="font-mono text-[11px]" style="color: var(--text-muted);">' + escapeHtml(f.targetPath) + '</div>').join('') + '</div>' : '');
        } else {
          body.innerHTML = '<div style="color: var(--text-dim);">No PE or MSI structural metadata available.</div>';
        }
      } else if (tab === 'strings') {
        const s = r.strings || {};
        const renderList = (title, arr) => '<div class="rounded-xl p-3 space-y-1" style="background: var(--bg); border: 1px solid var(--border);"><div class="font-semibold">' + title + ' (' + (arr?.length || 0) + ')</div>' + ((arr && arr.length) ? arr.slice(0, 60).map(x => '<div class="font-mono text-[11px] break-all" style="color: var(--text-muted);">' + escapeHtml(x) + '</div>').join('') : '<div style="color: var(--text-dim);">None</div>') + '</div>';
        body.innerHTML = renderList('URLs', s.urls) + renderList('IP Addresses', s.ipAddresses) + renderList('Registry Keys', s.registryKeys) + renderList('Windows Paths', s.paths) + renderList('PDB Debug Paths', s.pdbPaths);
      } else if (tab === 'files' || tab === 'code') {
        const isCode = tab === 'code';
        const basePrefix = isCode ? '' : (r.identity?.kind === 'msi' ? 'extracted/msi/' : r.identity?.kind === 'pyinstaller' ? 'extracted/pyinstaller/' : r.identity?.packers?.includes('UPX') ? 'extracted/unpacked/' : 'extracted/payload/');
        const list = isCode ? (r.decompilation?.files || []).map(f => f.output) : (r.extraction?.files || []).map(f => basePrefix + f);
        body.innerHTML =
          '<div class="space-y-2">'
          + (list.length ? '<div class="rounded-xl p-3 max-h-56 overflow-y-auto space-y-1" style="background: var(--bg); border: 1px solid var(--border);">' + list.slice(0, 200).map(p => '<button onclick="previewSwFile(\\'' + escapeHtml(p) + '\\')" class="block w-full text-left font-mono text-[11px] px-2 py-1 rounded hover:opacity-80" style="color: var(--accent);">' + escapeHtml(p) + '</button>').join('') + '</div>' : '<div class="rounded-xl p-4" style="background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);">No files available for this stage.</div>')
          + (swState.inspector.previewPath ? '<div class="rounded-xl p-3 space-y-2" style="background: var(--bg); border: 1px solid var(--border);"><div class="font-mono text-[11px] font-semibold">' + escapeHtml(swState.inspector.previewPath) + '</div><pre class="font-mono text-[11px] overflow-x-auto max-h-96 whitespace-pre-wrap" style="color: var(--text-muted);">' + escapeHtml(swState.inspector.previewContent || '') + '</pre></div>' : '')
          + '</div>';
      }
    }

    applyTheme(state.theme);
    setViewMode(state.viewMode);
    loadClones();
    loadSoftwareTools();
    loadSoftwareAnalyses();
  </script>
</body>
</html>`;
}

function shutdownServers() {
  for (const proc of activeServers.values()) {
    try { proc.kill(); } catch {}
  }
  activeServers.clear();
  process.exit(0);
}

process.on('SIGINT', shutdownServers);
process.on('SIGTERM', shutdownServers);

server.listen(PORT, () => {
  console.log(`\n=======================================================`);
  console.log(`🌟 Mimic Studio: http://localhost:${PORT}`);
  console.log(`📁 Scanning Clones from:`);
  console.log(`   - ${CLONES_DIR}`);
  console.log(`   - ${LEGACY_CLONES_DIR}`);
  console.log(`=======================================================\n`);
});
