/**
 * Mimic Visual Management Studio & Dashboard
 * Runs on http://localhost:4000
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { runReaAppAnalysis } from './engine/rea_bridge.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLONES_DIR = path.resolve(ROOT, 'clones');
const LEGACY_CLONES_DIR = 'C:\\Users\\gosse\\Documents\\Gemini\\Clones';

const PORT = 4000;
const activeServers = new Map();

function getAllClones() {
  const list = [];
  const dirsToScan = [
    { base: CLONES_DIR, tag: 'Mimic' },
    { base: LEGACY_CLONES_DIR, tag: 'Gemini' }
  ];

  for (const { base, tag } of dirsToScan) {
    if (fs.existsSync(base)) {
      try {
        const entries = fs.readdirSync(base, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            const projectPath = path.join(base, e.name);
            let description = '';
            let port = 3000;
            const pkgPath = path.join(projectPath, 'package.json');
            if (fs.existsSync(pkgPath)) {
              try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                description = pkg.description || '';
              } catch {}
            }
            const serverPath = path.join(projectPath, 'server.js');
            if (fs.existsSync(serverPath)) {
              try {
                const srvText = fs.readFileSync(serverPath, 'utf8');
                const portMatch = srvText.match(/PORT\s*=\s*(?:process\.env\.PORT\s*\|\|\s*)?(\d+)/);
                if (portMatch) port = parseInt(portMatch[1], 10);
              } catch {}
            }
            const hasScreenshot = fs.existsSync(path.join(projectPath, 'screenshot.png'));
            const hasManifest = fs.existsSync(path.join(projectPath, 'clone-manifest.json'));
            const hasRea = fs.existsSync(path.join(projectPath, 'rea-analysis.json')) || fs.existsSync(path.join(projectPath, 'rea-bundle.json'));

            list.push({
              name: e.name,
              path: projectPath,
              source: tag,
              description,
              port,
              hasScreenshot,
              hasManifest,
              hasRea,
              running: activeServers.has(e.name)
            });
          }
        }
      } catch (err) {
        console.error('Scan error:', err.message);
      }
    }
  }
  return list;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/api/clones') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ clones: getAllClones() }));
    return;
  }

  if (parsed.pathname === '/api/clone' && req.method === 'POST') {
    try {
      const { targetUrl, name, port, engine = 'cdp', rea = false } = await readJsonBody(req);
      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing targetUrl' }));
        return;
      }

      const slug = (name || targetUrl.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '-') + '-clone')
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, '-');
      const targetDir = path.join(CLONES_DIR, slug);
      const assignedPort = port || (3010 + Math.floor(Math.random() * 80));

      let child;
      if (engine === 'static') {
        const pythonScript = path.join(__dirname, 'engine', 'cloner.py');
        child = spawn('python', [pythonScript, '--url', targetUrl, '--out', targetDir, '--port', String(assignedPort)], {
          stdio: 'inherit'
        });
      } else {
        const cdpScript = path.join(__dirname, 'engine', 'cdp_capture.mjs');
        const cdpArgs = [cdpScript, targetUrl, targetDir, String(assignedPort)];
        if (rea) cdpArgs.push('--rea');
        child = spawn('node', cdpArgs, {
          stdio: 'inherit'
        });
      }

      child.on('close', (code) => {
        console.log(`Cloning (${engine}) finished for ${slug} with code ${code}`);
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, slug, targetDir, port: assignedPort, engine }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (parsed.pathname === '/api/serve' && req.method === 'POST') {
    try {
      const { name, action = 'start' } = await readJsonBody(req);
      const clones = getAllClones();
      const match = clones.find(c => c.name === name);

      if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Clone "${name}" not found` }));
        return;
      }

      if (action === 'stop') {
        const proc = activeServers.get(match.name);
        if (proc) {
          try { proc.kill(); } catch {}
          activeServers.delete(match.name);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: match.name, running: false }));
        return;
      }

      if (activeServers.has(match.name)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: match.name, running: true, port: match.port }));
        return;
      }

      const serverPath = path.join(match.path, 'server.js');
      if (!fs.existsSync(serverPath)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `server.js missing in ${match.path}` }));
        return;
      }

      const child = spawn('node', ['server.js'], {
        cwd: match.path,
        env: { ...process.env, PORT: String(match.port) },
        stdio: 'ignore'
      });

      activeServers.set(match.name, child);
      child.on('exit', () => {
        activeServers.delete(match.name);
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: match.name, running: true, port: match.port }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (parsed.pathname === '/api/analyze' && req.method === 'POST') {
    try {
      const { name } = await readJsonBody(req);
      const clones = getAllClones();
      const match = clones.find(c => c.name === name);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Clone "${name}" not found` }));
        return;
      }
      const summary = await runReaAppAnalysis(match.path);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: match.name, summary }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (parsed.pathname.startsWith('/screenshot/')) {
    const projName = decodeURIComponent(parsed.pathname.replace('/screenshot/', ''));
    const clones = getAllClones();
    const match = clones.find(c => c.name === projName);
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

  // Dashboard HTML
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <title>Mimic Studio — Reverse-Engineering & Cloning Suite</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600;700&display=swap');
    body { font-family: 'Inter', system-ui, sans-serif; background-color: #0c0d0e; color: #e5e5e5; }
    .font-editorial { font-family: 'Cormorant Garamond', Georgia, serif; }
  </style>
</head>
<body class="min-h-screen antialiased flex flex-col justify-between">
  <div>
    <!-- Header -->
    <header class="border-b border-white/10 px-8 py-5 flex items-center justify-between bg-stone-950/80 backdrop-blur sticky top-0 z-40">
      <div class="flex items-center gap-3">
        <div class="size-8 rounded-lg bg-amber-400 text-stone-950 font-bold flex items-center justify-center text-sm">M</div>
        <div>
          <span class="font-editorial text-2xl text-white">Mimic Studio</span>
          <span class="text-xs text-stone-400 ml-2 font-mono">v1.1.0</span>
        </div>
      </div>
      <div class="flex items-center gap-4 text-xs">
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
          <span class="size-1.5 rounded-full bg-emerald-400"></span> In-Flight CDP Ready
        </span>
      </div>
    </header>

    <!-- Main Container -->
    <main class="max-w-6xl mx-auto px-6 py-12 space-y-12">
      <!-- Hero / Input Box -->
      <section class="rounded-3xl border border-white/10 bg-stone-900/60 p-8 sm:p-10 shadow-2xl relative overflow-hidden">
        <h1 class="font-editorial text-4xl sm:text-5xl font-normal text-white leading-tight">
          High-Fidelity Reverse-Engineering & Cloning Engine
        </h1>
        <p class="text-sm text-stone-400 mt-2 max-w-2xl leading-relaxed">
          Ingest any production URL via real-time CDP stream interception or parallel static crawling with automated multi-CDN proxy scaffolding.
        </p>

        <form id="cloneForm" class="mt-8" onsubmit="triggerClone(event)">
          <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div class="sm:col-span-5">
              <input 
                id="urlInput"
                type="url" 
                required 
                placeholder="https://example.com" 
                class="w-full px-4 py-3 rounded-xl bg-black/60 border border-white/10 text-white placeholder-stone-500 text-sm focus:outline-none focus:border-amber-400"
              />
            </div>
            <div class="sm:col-span-2">
              <input 
                id="nameInput"
                type="text" 
                placeholder="slug (optional)" 
                class="w-full px-4 py-3 rounded-xl bg-black/60 border border-white/10 text-white placeholder-stone-500 text-sm focus:outline-none focus:border-amber-400"
              />
            </div>
            <div class="sm:col-span-2">
              <select
                id="engineSelect"
                class="w-full px-3 py-3 rounded-xl bg-black/60 border border-white/10 text-white text-sm focus:outline-none focus:border-amber-400"
              >
                <option value="cdp">In-Flight CDP</option>
                <option value="static">Static Python</option>
              </select>
            </div>
            <div class="sm:col-span-3">
              <button 
                type="submit" 
                id="submitBtn"
                class="w-full py-3 px-6 rounded-xl bg-white text-stone-900 font-semibold text-sm hover:bg-stone-200 active:scale-[0.98] transition shadow-md"
              >
                Clone Experience
              </button>
            </div>
          </div>
          <label class="inline-flex items-center gap-2 mt-4 text-xs text-stone-300 cursor-pointer select-none">
            <input id="reaCheck" type="checkbox" checked class="rounded bg-black/60 border-white/20 text-amber-400 focus:ring-0" />
            <span>Run REA live bundle &amp; endpoint analysis (CDP mode)</span>
          </label>
        </form>

        <div id="statusNotice" class="hidden mt-4 p-3 rounded-xl bg-amber-400/10 border border-amber-400/30 text-amber-300 text-xs font-mono"></div>
      </section>

      <!-- Cloned Projects Directory -->
      <section class="space-y-6">
        <div class="flex items-center justify-between pb-3 border-b border-white/10">
          <h2 class="font-editorial text-3xl font-normal text-white">Ingested Architectures & Clones</h2>
          <span id="cloneCount" class="text-xs text-stone-400 font-mono">Loading...</span>
        </div>

        <div id="grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <!-- Dynamically populated -->
        </div>
      </section>
    </main>
  </div>

  <footer class="border-t border-white/10 py-6 text-center text-xs text-stone-400 font-mono">
    Mimic Studio • Local Reverse-Engineering Suite
  </footer>

  <script>
    async function loadClones() {
      try {
        const res = await fetch('/api/clones');
        const data = await res.json();
        const grid = document.getElementById('grid');
        const count = document.getElementById('cloneCount');
        count.textContent = data.clones.length + ' clones detected';

        grid.innerHTML = data.clones.map(c => \`
          <div class="rounded-2xl border border-white/10 bg-stone-900/40 overflow-hidden flex flex-col justify-between hover:border-white/20 transition group">
            <div>
              \${c.hasScreenshot ? \`<img src="/screenshot/\${encodeURIComponent(c.name)}" alt="\${c.name}" class="w-full h-36 object-cover border-b border-white/10 bg-black/40" loading="lazy" />\` : ''}
              <div class="p-5 pb-3">
                <div class="flex items-center justify-between text-xs text-stone-400 mb-2">
                  <div class="flex items-center gap-1.5">
                    <span class="px-2 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[10px]">\${c.source}</span>
                    \${c.hasRea ? '<span class="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 font-mono text-[10px]">REA</span>' : ''}
                    \${c.running ? '<span class="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-mono text-[10px]">LIVE</span>' : ''}
                  </div>
                  <span class="font-mono text-amber-400">Port :\${c.port}</span>
                </div>
                <h3 class="text-base font-semibold text-white tracking-tight group-hover:text-amber-300 transition">\${c.name}</h3>
                <p class="text-xs text-stone-400 mt-1 line-clamp-2 leading-relaxed">\${c.description || 'Full 1:1 reconstruction with autonomous proxy fallback.'}</p>
              </div>
            </div>

            <div class="px-5 py-3 border-t border-white/5 flex items-center justify-between gap-2 text-xs">
              <div class="flex items-center gap-1.5">
                <button
                  onclick="toggleServer('\${c.name}', \${c.running})"
                  class="px-2.5 py-1.5 rounded-lg border font-medium transition text-xs \${c.running ? 'border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'}"
                >
                  \${c.running ? 'Stop' : 'Start'}
                </button>
                <button
                  onclick="analyzeClone('\${c.name}', this)"
                  class="px-2.5 py-1.5 rounded-lg border border-amber-400/30 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20 font-medium transition text-xs"
                >
                  Analyze (REA)
                </button>
              </div>
              <a href="http://localhost:\${c.port}" target="_blank" class="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white text-white hover:text-stone-950 font-medium transition text-xs">
                Launch →
              </a>
            </div>
          </div>
        \`).join('');
      } catch (err) {
        console.error(err);
      }
    }

    async function analyzeClone(name, btn) {
      const notice = document.getElementById('statusNotice');
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Analyzing...';
      notice.classList.remove('hidden');
      notice.textContent = 'Running REA static JS application analysis for ' + name + '...';
      try {
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        const d = await res.json();
        if (!res.ok || d.error) throw new Error(d.error || 'Analysis failed');
        notice.textContent = 'REA analyzed ' + d.summary.analyzedModuleCount + ' module(s) (' + d.summary.nodeCount + ' nodes, ' + d.summary.edgeCount + ' edges) -> saved rea-analysis.json';
        await loadClones();
      } catch (err) {
        notice.textContent = 'REA Error: ' + err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    }

    async function toggleServer(name, isRunning) {
      try {
        await fetch('/api/serve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, action: isRunning ? 'stop' : 'start' })
        });
        await loadClones();
      } catch (err) {
        console.error(err);
      }
    }

    async function triggerClone(e) {
      e.preventDefault();
      const url = document.getElementById('urlInput').value;
      const name = document.getElementById('nameInput').value;
      const engine = document.getElementById('engineSelect').value;
      const rea = document.getElementById('reaCheck').checked;
      const btn = document.getElementById('submitBtn');
      const notice = document.getElementById('statusNotice');

      btn.disabled = true;
      btn.textContent = 'Ingesting Pipeline...';
      notice.classList.remove('hidden');
      notice.textContent = 'Running ' + engine.toUpperCase() + ' capture for ' + url + '...';

      try {
        const res = await fetch('/api/clone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: url, name: name, engine: engine, rea: rea })
        });
        const d = await res.json();
        notice.textContent = 'Clone pipeline initialized for ' + d.slug + ' on port ' + d.port + ' (' + d.engine + ')! Refreshing...';
        setTimeout(() => {
          loadClones();
          btn.disabled = false;
          btn.textContent = 'Clone Experience';
          notice.classList.add('hidden');
        }, 4000);
      } catch (err) {
        notice.textContent = 'Error: ' + err.message;
        btn.disabled = false;
        btn.textContent = 'Clone Experience';
      }
    }

    loadClones();
  </script>
</body>
</html>`);
});

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
  console.log(`🌟 Mimic Studio Dashboard: http://localhost:${PORT}`);
  console.log(`📁 Scanning Clones from:`);
  console.log(`   - ${CLONES_DIR}`);
  console.log(`   - ${LEGACY_CLONES_DIR}`);
  console.log(`=======================================================\n`);
});
