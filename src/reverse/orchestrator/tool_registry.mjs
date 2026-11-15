/**
 * External Reverse-Engineering Tool Registry & Auto-Discovery
 * Discovers optional CLI tools across Linux, macOS, and Windows without failing when absent.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';

const TOOL_SPECS = [
  {
    id: '7z',
    name: '7-Zip',
    bins: ['7z', '7za', 'C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'],
    versionArgs: ['i'],
    purpose: 'Extract NSIS, Burn, CAB, and self-extracting archives'
  },
  {
    id: 'upx',
    name: 'UPX',
    bins: ['upx'],
    versionArgs: ['--version'],
    purpose: 'Unpack UPX-compressed PE executables'
  },
  {
    id: 'innoextract',
    name: 'innoextract',
    bins: ['innoextract'],
    versionArgs: ['--version'],
    purpose: 'Extract Inno Setup installers without execution'
  },
  {
    id: 'ilspycmd',
    name: 'ILSpy CLI',
    bins: ['ilspycmd'],
    versionArgs: ['--version'],
    purpose: 'Decompile .NET assemblies into C# source projects'
  },
  {
    id: 'ghidra',
    name: 'Ghidra Headless',
    bins: [
      ...(process.env.GHIDRA_HOME ? [path.join(process.env.GHIDRA_HOME, 'support', process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless')] : []),
      'analyzeHeadless',
      '/opt/ghidra/support/analyzeHeadless',
      'C:\\ghidra\\support\\analyzeHeadless.bat'
    ],
    versionArgs: [],
    purpose: 'Disassemble and decompile native C/C++/Rust binaries'
  },
  {
    id: 'objdump',
    name: 'GNU objdump',
    bins: ['objdump', 'x86_64-w64-mingw32-objdump'],
    versionArgs: ['--version'],
    purpose: 'Disassemble native PE code sections'
  },
  {
    id: 'msiinfo',
    name: 'msitools (msiinfo)',
    bins: ['msiinfo'],
    versionArgs: ['--version'],
    purpose: 'Inspect Windows Installer (.msi) database tables'
  },
  {
    id: 'msiextract',
    name: 'msitools (msiextract)',
    bins: ['msiextract'],
    versionArgs: ['--version'],
    purpose: 'Extract files from Windows Installer (.msi) packages'
  },
  {
    id: 'lessmsi',
    name: 'lessmsi',
    bins: ['lessmsi'],
    versionArgs: ['--version'],
    purpose: 'Extract and inspect .msi packages on Windows'
  },
  {
    id: 'uncompyle6',
    name: 'uncompyle6',
    bins: ['uncompyle6'],
    versionArgs: ['--version'],
    purpose: 'Decompile Python .pyc bytecode into .py source'
  },
  {
    id: 'decompyle3',
    name: 'decompyle3',
    bins: ['decompyle3'],
    versionArgs: ['--version'],
    purpose: 'Decompile Python 3.7+ .pyc bytecode'
  },
  {
    id: 'python3',
    name: 'Python 3',
    bins: ['python3', 'python'],
    versionArgs: ['--version'],
    purpose: 'Run bytecode inspection (marshal/dis) and helper scripts'
  }
];

function resolveBinary(candidates) {
  for (const cand of candidates) {
    if (!cand) continue;
    if (cand.includes('/') || cand.includes('\\')) {
      if (fs.existsSync(cand)) return cand;
      continue;
    }
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const out = execFileSync(cmd, [cand], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000
      }).trim();
      const firstLine = out.split(/\r?\n/)[0]?.trim();
      if (firstLine && fs.existsSync(firstLine)) return firstLine;
    } catch {}
  }
  return null;
}

function probeVersion(binPath, args) {
  if (!args || args.length === 0) return 'detected';
  try {
    const out = execFileSync(binPath, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000
    }).trim();
    const first = out.split(/\r?\n/).find(l => l.trim().length > 0) || 'detected';
    return first.slice(0, 100);
  } catch (err) {
    const text = (err.stdout || err.stderr || '').toString().trim();
    const first = text.split(/\r?\n/).find(l => l.trim().length > 0);
    return first ? first.slice(0, 100) : 'detected';
  }
}

export function discoverTools() {
  const tools = {};
  for (const spec of TOOL_SPECS) {
    const resolved = resolveBinary(spec.bins);
    tools[spec.id] = {
      id: spec.id,
      name: spec.name,
      purpose: spec.purpose,
      available: Boolean(resolved),
      path: resolved,
      version: resolved ? probeVersion(resolved, spec.versionArgs) : null
    };
  }
  return tools;
}

/**
 * Runs an external tool in an isolated subprocess with a strict timeout.
 */
export function runToolSafe(binPath, args, options = {}) {
  const timeoutMs = options.timeoutMs || 45000;
  const cwd = options.cwd || process.cwd();
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Tool ${path.basename(binPath)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', d => {
      if (stdout.length < 2 * 1024 * 1024) stdout += d.toString('utf8');
    });
    child.stderr.on('data', d => {
      if (stderr.length < 2 * 1024 * 1024) stderr += d.toString('utf8');
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (!timedOut) {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

/**
 * Ensures an extracted path remains strictly inside rootDir (blocks path traversal).
 */
export function isSafeSubpath(rootDir, targetPath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
