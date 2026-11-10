/**
 * Webstack Visual Management Studio & Dashboard
 * Runs on http://localhost:4000
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLONES_DIR = path.resolve(ROOT, 'clones');
const LEGACY_CLONES_DIR = 'C:\\Users\\gosse\\Documents\\Gemini\\Clones';

const PORT = 4000;

function getAllClones() {
  const list = [];
  const dirsToScan = [
    { base: CLONES_DIR, tag: 'Webstack' },
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

            list.push({
              name: e.name,
              path: projectPath,
              source: tag,
              description,
              port,
              hasScreenshot
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

const activeServers = new Map();

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/api/clones') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ clones: getAllClones() }));
    return;
  }

  if (parsed.pathname === '/api/clone' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { targetUrl, name, port } = JSON.parse(body);
        if (!targetUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing targetUrl' }));
          return;
        }

        const slug = name || targetUrl.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '-') + '-clone';
        const targetDir = path.join(CLONES_DIR, slug);
        const assignedPort = port || (3010 + Math.floor(Math.random() * 80));

        const pythonScript = path.join(__dirname, 'engine', 'cloner.py');
        const child = spawn('python', [pythonScript, '--url', targetUrl, '--out', targetDir, '--port', String(assignedPort)]);

        child.on('close', (code) => {
          console.log(`Cloning finished with code ${code}`);
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, slug, targetDir, port: assignedPort }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
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
  <title>Gemini Webstack — Architecture & Cloning Studio</title>
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
        <div class="size-8 rounded-lg bg-amber-400 text-stone-950 font-bold flex items-center justify-center text-sm">W</div>
        <div>
          <span class="font-editorial text-2xl text-white">Gemini Webstack</span>
          <span class="text-xs text-stone-400 ml-2 font-mono">v1.0.0</span>
        </div>
      </div>
      <div class="flex items-center gap-4 text-xs">
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
          <span class="size-1.5 rounded-full bg-emerald-400"></span> Engine Online
        </span>
        <a href="https://github.com" target="_blank" class="text-stone-400 hover:text-white transition">Documentation</a>
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
          Ingest any production URL, extract embedded Webfonts, client React bundles, and responsive media with automated fallback proxy scaffolding.
        </p>

        <form id="cloneForm" class="mt-8 grid grid-cols-1 sm:grid-cols-12 gap-3" onsubmit="triggerClone(event)">
          <div class="sm:col-span-6">
            <input 
              id="urlInput"
              type="url" 
              required 
              placeholder="https://example.com" 
              class="w-full px-4 py-3 rounded-xl bg-black/60 border border-white/10 text-white placeholder-stone-500 text-sm focus:outline-none focus:border-amber-400"
            />
          </div>
          <div class="sm:col-span-3">
            <input 
              id="nameInput"
              type="text" 
              placeholder="custom-slug (optional)" 
              class="w-full px-4 py-3 rounded-xl bg-black/60 border border-white/10 text-white placeholder-stone-500 text-sm focus:outline-none focus:border-amber-400"
            />
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
    Gemini Webstack Suite • Antwerp / Local Development
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
          <div class="rounded-2xl border border-white/10 bg-stone-900/40 p-5 flex flex-col justify-between hover:border-white/20 transition group">
            <div>
              <div class="flex items-center justify-between text-xs text-stone-400 mb-2">
                <span class="px-2 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[10px]">\${c.source}</span>
                <span class="font-mono text-amber-400">Port :\${c.port}</span>
              </div>
              <h3 class="text-base font-semibold text-white tracking-tight group-hover:text-amber-300 transition">\${c.name}</h3>
              <p class="text-xs text-stone-400 mt-1 line-clamp-2 leading-relaxed">\${c.description || 'Full 1:1 reconstruction with autonomous proxy fallback.'}</p>
            </div>

            <div class="mt-4 pt-3 border-t border-white/5 flex items-center justify-between text-xs">
              <span class="font-mono text-[10px] text-stone-400 truncate max-w-[160px]">\${c.path}</span>
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

    async function triggerClone(e) {
      e.preventDefault();
      const url = document.getElementById('urlInput').value;
      const name = document.getElementById('nameInput').value;
      const btn = document.getElementById('submitBtn');
      const notice = document.getElementById('statusNotice');

      btn.disabled = true;
      btn.textContent = 'Ingesting Pipeline...';
      notice.classList.remove('hidden');
      notice.textContent = 'Connecting to ' + url + ' and crawling stylesheets, fonts, and scripts...';

      try {
        const res = await fetch('/api/clone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: url, name: name })
        });
        const d = await res.json();
        notice.textContent = 'Clone pipeline initialized for ' + d.slug + ' on port ' + d.port + '! Refreshing...';
        setTimeout(() => {
          loadClones();
          btn.disabled = false;
          btn.textContent = 'Clone Experience';
          notice.classList.add('hidden');
        }, 3000);
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

server.listen(PORT, () => {
  console.log(`\n=======================================================`);
  console.log(`🌟 Gemini Webstack Dashboard: http://localhost:${PORT}`);
  console.log(`📁 Scanning Clones from:`);
  console.log(`   - ${CLONES_DIR}`);
  console.log(`   - ${LEGACY_CLONES_DIR}`);
  console.log(`=======================================================\n`);
});
