#!/usr/bin/env node
/**
 * Mimic Master CLI Tool
 * Fast, elegant terminal command center for website cloning, runtime ingestion, and verification.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runReaAppAnalysis } from './engine/rea_bridge.mjs';
import { unpackDesktopApp } from './engine/desktop_unpacker.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLONES_DIR = path.resolve(ROOT, 'clones');

function showHelp() {
  console.log(`
┌─────────────────────────────────────────────────────────────┐
│  ⚡ MIMIC — High-Fidelity Website Reverse-Engineering Suite  │
└─────────────────────────────────────────────────────────────┘

Usage:
  node src/cli.js <command> [arguments] [options]

Commands:
  clone <url> [name] [--port 3000]     Run parallel static & font extraction clone
  capture <url> [name] [--port 3000]   Run in-flight CDP stream capture & scaffolding
  unpack <asar|dir> [name]             Unpack an Electron .asar or app folder into a clone
  analyze <name> [--full-evidence]     Run REA static JS application graph analysis
  serve [name] [--port 3000]           Start hybrid fallback server for cloned site
  verify [name] [--port 3000]          Audit console errors, layout & capture screenshots
  export <name> [--format zip|docker|electron]  Package clone (.zip, Docker, or Windows .exe/.msi Electron)
  remove <name>                        Delete a cloned project from workspace
  list                                 Show all cloned projects in workspace
  help                                 Show this guide

Options:
  --port <num>                         Local server port (default: 3000)
  --offline                            Disable upstream fallback when serving
  --crawl                              Crawl internal same-origin routes during capture
  --max-routes <num>                   Max internal routes to crawl (default: 10)
  --cookies <file|str>                 Cookies JSON file or header string for capture
  --header <k:v>                       Custom HTTP header for capture
  --interactive-login                  Open headed browser and wait for Enter before capture
  --rea                                Run REA live bundle & endpoint analysis during capture
  --fetch-source-maps                  Fetch source maps when running capture with --rea
  --quiet                              Suppress verbose progress output
  --json                               Emit compact JSON output only

Examples:
  node src/cli.js clone https://linear.app linear-clone --port 3001
  node src/cli.js capture https://linear.app linear-runtime --port 3003 --rea --crawl --json
  node src/cli.js analyze linear-runtime --json
  node src/cli.js serve linear-clone --offline
  node src/cli.js verify linear-clone --json
  node src/cli.js export linear-runtime --format zip
`);
}

function getArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  const positional = [];
  const options = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        options[key] = next;
        i++;
      } else {
        options[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, options };
}

function resolveProjectDir(nameOrUrl) {
  if (!nameOrUrl) return CLONES_DIR;
  if (nameOrUrl.startsWith('http://') || nameOrUrl.startsWith('https://')) {
    try {
      const u = new URL(nameOrUrl);
      const slug = u.hostname.replace(/[^a-zA-Z0-9]/g, '-') + '-clone';
      return path.join(CLONES_DIR, slug);
    } catch {
      return path.join(CLONES_DIR, 'cloned-site');
    }
  }
  return path.isAbsolute(nameOrUrl) ? nameOrUrl : path.join(CLONES_DIR, nameOrUrl);
}

async function main() {
  const { command, positional, options } = getArgs();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    showHelp();
    return;
  }

  fs.mkdirSync(CLONES_DIR, { recursive: true });

  switch (command) {
    case 'list': {
      const items = fs.readdirSync(CLONES_DIR, { withFileTypes: true });
      const dirs = items.filter(d => d.isDirectory());
      const projects = dirs.map(d => {
        const projPath = path.join(CLONES_DIR, d.name);
        const pkgPath = path.join(projPath, 'package.json');
        let description = '';
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            description = pkg.description || '';
          } catch {}
        }
        return {
          name: d.name,
          path: projPath,
          description,
          hasManifest: fs.existsSync(path.join(projPath, 'clone-manifest.json')),
          hasRea: fs.existsSync(path.join(projPath, 'rea-analysis.json')) || fs.existsSync(path.join(projPath, 'rea-bundle.json'))
        };
      });

      if (options.json) {
        console.log(JSON.stringify({ clonesDir: CLONES_DIR, projects }));
        break;
      }

      console.log(`\n📁 Cloned Projects in: ${CLONES_DIR}\n`);
      if (projects.length === 0) {
        console.log('  (No cloned sites found yet. Run `node src/cli.js capture <url>` to create one!)');
      } else {
        projects.forEach((p, idx) => {
          console.log(`  ${idx + 1}. \x1b[36m${p.name}\x1b[0m ${p.description ? `— ${p.description}` : ''}`);
        });
      }
      console.log();
      break;
    }

    case 'clone': {
      const targetUrl = positional[0];
      if (!targetUrl) {
        console.error('❌ Error: Missing URL. Usage: node src/cli.js clone <url> [name] [--port 3000]');
        process.exit(1);
      }
      const customName = positional[1];
      const targetDir = customName ? path.join(CLONES_DIR, customName) : resolveProjectDir(targetUrl);
      const port = options.port || 3000;

      const pythonScript = path.join(__dirname, 'engine', 'cloner.py');
      const pyArgs = [pythonScript, '--url', targetUrl, '--out', targetDir, '--port', String(port)];
      if (options.quiet) pyArgs.push('--quiet');
      if (options.json) pyArgs.push('--json');

      const proc = spawn('python', pyArgs, { stdio: 'inherit' });
      proc.on('close', (code) => {
        if (code !== 0) process.exit(code);
      });
      break;
    }

    case 'capture': {
      const targetUrl = positional[0];
      if (!targetUrl) {
        console.error('❌ Error: Missing URL. Usage: node src/cli.js capture <url> [name] [--port 3000]');
        process.exit(1);
      }
      const customName = positional[1];
      const targetDir = customName ? path.join(CLONES_DIR, customName) : resolveProjectDir(targetUrl);
      const port = options.port || 3000;

      const cdpScript = path.join(__dirname, 'engine', 'cdp_capture.mjs');
      const cdpArgs = [cdpScript, targetUrl, targetDir, String(port)];
      if (options.quiet) cdpArgs.push('--quiet');
      if (options.json) cdpArgs.push('--json');
      if (options['no-scroll']) cdpArgs.push('--no-scroll');
      if (options.timeout) cdpArgs.push('--timeout', String(options.timeout));
      if (options.rea) cdpArgs.push('--rea');
      if (options['fetch-source-maps']) cdpArgs.push('--fetch-source-maps');
      if (options.crawl) cdpArgs.push('--crawl');
      if (options['max-routes']) cdpArgs.push('--max-routes', String(options['max-routes']));
      if (options.cookies) cdpArgs.push('--cookies', String(options.cookies));
      if (options.header) cdpArgs.push('--header', String(options.header));
      if (options['interactive-login']) cdpArgs.push('--interactive-login');

      const proc = spawn('node', cdpArgs, { stdio: 'inherit' });
      proc.on('close', (code) => {
        if (code !== 0) process.exit(code);
      });
      break;
    }

    case 'analyze': {
      const name = positional[0];
      if (!name) {
        console.error('❌ Error: Missing clone name or path. Usage: node src/cli.js analyze <name> [--json]');
        process.exit(1);
      }
      const targetDir = resolveProjectDir(name);
      if (!fs.existsSync(targetDir)) {
        console.error(`❌ Error: Clone directory not found: ${targetDir}`);
        process.exit(1);
      }
      if (!options.quiet && !options.json) {
        console.log(`🔬 Running REA JavaScript Application Analysis on ${targetDir}...`);
      }
      const summary = await runReaAppAnalysis(targetDir, {
        fullEvidence: Boolean(options['full-evidence']),
        sourcePaths: options['source-path'] ? String(options['source-path']).split(',') : undefined
      });
      if (options.json) {
        console.log(JSON.stringify(summary));
      } else if (!options.quiet) {
        console.log(`✓ Saved REA summary to ${path.join(targetDir, 'rea-analysis.json')}`);
        console.log(`  Evidence ID: ${summary.evidenceId}`);
        console.log(`  Graph Nodes: ${summary.nodeCount} | Edges: ${summary.edgeCount} | Analyzed Modules: ${summary.analyzedModuleCount}`);
      }
      break;
    }

    case 'serve': {
      const name = positional[0];
      let targetDir = name ? resolveProjectDir(name) : null;
      if (!targetDir || !fs.existsSync(targetDir)) {
        const dirs = fs.readdirSync(CLONES_DIR).filter(d => fs.statSync(path.join(CLONES_DIR, d)).isDirectory());
        if (dirs.length > 0) {
          targetDir = path.join(CLONES_DIR, dirs[0]);
        } else {
          console.error('❌ Error: No cloned sites found to serve. Clone one first!');
          process.exit(1);
        }
      }

      const serverPath = path.join(targetDir, 'server.js');
      if (!fs.existsSync(serverPath)) {
        console.error(`❌ Error: server.js not found in ${targetDir}`);
        process.exit(1);
      }

      const env = { ...process.env };
      if (options.port) env.PORT = String(options.port);
      if (options.offline) env.MIMIC_OFFLINE = '1';

      if (!options.quiet) {
        console.log(`Starting server for \x1b[36m${path.basename(targetDir)}\x1b[0m${options.offline ? ' (strict offline)' : ''}...`);
      }
      const proc = spawn('node', ['server.js'], { cwd: targetDir, stdio: 'inherit', env });
      break;
    }

    case 'verify': {
      const name = positional[0];
      let targetDir = name ? resolveProjectDir(name) : '.';
      const port = options.port || 3000;
      const localUrl = options.url || `http://localhost:${port}`;

      const verifierScript = path.join(__dirname, 'engine', 'verifier.mjs');
      const verifyArgs = [verifierScript, localUrl, targetDir];
      if (options.quiet) verifyArgs.push('--quiet');
      if (options.json) verifyArgs.push('--json');
      if (options.timeout) verifyArgs.push('--timeout', String(options.timeout));

      const proc = spawn('node', verifyArgs, { stdio: 'inherit' });
      proc.on('close', (code) => {
        if (code !== 0) process.exit(code);
      });
      break;
    }

    case 'unpack': {
      const inputPath = positional[0];
      if (!inputPath) {
        console.error('❌ Error: Missing .asar or app directory path. Usage: node src/cli.js unpack <path> [name]');
        process.exit(1);
      }
      const slug = positional[1] || (path.basename(path.resolve(inputPath)).replace(/[^a-zA-Z0-9-_]/g, '-') || 'desktop-app');
      const targetDir = path.join(CLONES_DIR, slug);
      const port = options.port || 3000;
      const result = unpackDesktopApp(inputPath, targetDir, { port });
      if (options.json) {
        console.log(JSON.stringify({ ok: true, ...result }));
      } else if (!options.quiet) {
        console.log(`✓ Unpacked ${result.fileCount} files (${result.totalBytes} B) from ${result.asarFile} -> ${result.outputDir}`);
      }
      break;
    }

    case 'export': {
      const name = positional[0];
      if (!name) {
        console.error('❌ Error: Missing clone name. Usage: node src/cli.js export <name> [--format zip|docker|electron]');
        process.exit(1);
      }
      const targetDir = resolveProjectDir(name);
      if (!fs.existsSync(targetDir)) {
        console.error(`❌ Error: Clone directory not found: ${targetDir}`);
        process.exit(1);
      }
      const format = (options.format || 'zip').toLowerCase();
      const slug = path.basename(targetDir);
      if (format === 'docker') {
        const dockerfile = `FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nENV PORT=3000\nEXPOSE 3000\nCMD ["node", "server.js"]\n`;
        const dockerignore = `node_modules\n*.zip\naudit-*.png\ndiff-*.png\n`;
        fs.writeFileSync(path.join(targetDir, 'Dockerfile'), dockerfile, 'utf8');
        fs.writeFileSync(path.join(targetDir, '.dockerignore'), dockerignore, 'utf8');
        if (options.json) {
          console.log(JSON.stringify({ ok: true, format: 'docker', path: path.join(targetDir, 'Dockerfile') }));
        } else {
          console.log(`✓ Generated Dockerfile and .dockerignore in ${targetDir}`);
        }
      } else if (format === 'electron') {
        const electronMain = `const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let srvProc;
function createWindow() {
  const port = process.env.PORT || '3000';
  srvProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, PORT: port, MIMIC_OFFLINE: '1' },
    stdio: 'ignore'
  });
  const win = new BrowserWindow({ width: 1280, height: 840, autoHideMenuBar: true });
  setTimeout(() => win.loadURL('http://127.0.0.1:' + port), 350);
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (srvProc) try { srvProc.kill(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});
`;
        fs.writeFileSync(path.join(targetDir, 'electron-main.js'), electronMain, 'utf8');
        const pkgPath = path.join(targetDir, 'package.json');
        const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : { name: slug, version: '1.0.0' };
        pkg.main = 'electron-main.js';
        pkg.scripts = {
          ...(pkg.scripts || {}),
          'electron': 'electron .',
          'build:win': 'electron-builder --win nsis msi'
        };
        pkg.build = {
          appId: `com.mimic.${slug.replace(/[^a-z0-9]/gi, '')}`,
          productName: slug,
          win: { target: ['nsis', 'msi'] }
        };
        pkg.devDependencies = {
          ...(pkg.devDependencies || {}),
          electron: '^33.0.0',
          'electron-builder': '^25.0.0'
        };
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
        if (options.json) {
          console.log(JSON.stringify({ ok: true, format: 'electron', path: path.join(targetDir, 'electron-main.js') }));
        } else if (!options.quiet) {
          console.log(`✓ Generated Electron Windows (.exe NSIS + .msi) wrapper in ${targetDir}`);
          console.log(`  Run inside ${targetDir}: npm install && npm run build:win`);
        }
      } else {
        const outZip = options.out ? path.resolve(options.out) : path.join(CLONES_DIR, `${slug}.zip`);
        const pyZip = spawn('python3', [
          '-c',
          'import shutil, sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])',
          outZip,
          targetDir
        ], { stdio: 'inherit' });
        pyZip.on('close', (code) => {
          if (code !== 0) process.exit(code);
          if (options.json) {
            console.log(JSON.stringify({ ok: true, format: 'zip', path: outZip }));
          } else if (!options.quiet) {
            console.log(`✓ Exported ${slug} to ${outZip}`);
          }
        });
      }
      break;
    }

    case 'remove': {
      const name = positional[0];
      if (!name) {
        console.error('❌ Error: Missing clone name. Usage: node src/cli.js remove <name>');
        process.exit(1);
      }
      const targetDir = resolveProjectDir(name);
      if (!fs.existsSync(targetDir)) {
        console.error(`❌ Error: Clone directory not found: ${targetDir}`);
        process.exit(1);
      }
      fs.rmSync(targetDir, { recursive: true, force: true });
      if (options.json) {
        console.log(JSON.stringify({ ok: true, removed: targetDir }));
      } else if (!options.quiet) {
        console.log(`✓ Removed clone: ${targetDir}`);
      }
      break;
    }

    default:
      console.error(`❌ Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
