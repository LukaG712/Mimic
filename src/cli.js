#!/usr/bin/env node
/**
 * Mimic Master CLI Tool
 * Fast, elegant terminal command center for website cloning, runtime ingestion, and verification.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
  serve [name] [--port 3000]           Start hybrid fallback server for cloned site
  verify [name] [--port 3000]          Audit console errors, layout & capture screenshots
  list                                 Show all cloned projects in workspace
  help                                 Show this guide

Options:
  --port <num>                         Local server port (default: 3000)
  --quiet                              Suppress verbose progress output
  --json                               Emit compact JSON output only

Examples:
  node src/cli.js clone https://linear.app linear-clone --port 3001
  node src/cli.js capture https://linear.app linear-runtime --port 3003 --json
  node src/cli.js serve linear-clone
  node src/cli.js verify linear-clone --json
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
          hasManifest: fs.existsSync(path.join(projPath, 'clone-manifest.json'))
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

      const proc = spawn('node', cdpArgs, { stdio: 'inherit' });
      proc.on('close', (code) => {
        if (code !== 0) process.exit(code);
      });
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

      if (!options.quiet) {
        console.log(`Starting server for \x1b[36m${path.basename(targetDir)}\x1b[0m...`);
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
