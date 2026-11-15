/**
 * Safe Extractor for EXE Installers, Electron Bundles, Archives, and UPX Binaries
 * Never executes target binaries or installers. Enforces strict path-traversal checks.
 */

import fs from 'fs';
import path from 'path';
import { runToolSafe, isSafeSubpath } from '../orchestrator/tool_registry.mjs';
import { unpackDesktopApp } from '../../engine/desktop_unpacker.mjs';

function collectSafeFiles(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!isSafeSubpath(rootDir, full)) continue;
      if (entry.isSymbolicLink()) {
        try { fs.unlinkSync(full); } catch {}
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(path.relative(rootDir, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(rootDir);
  return out;
}

export async function extractInstallerOrArchive(filePath, outDir, identity, tools = {}) {
  const extractDir = path.join(outDir, 'extracted', 'payload');
  fs.mkdirSync(extractDir, { recursive: true });
  const notes = [];
  let toolUsed = null;

  // 1. UPX unpacking (on a safe copy, never in-place on original)
  if (identity.packers?.includes('UPX')) {
    if (tools.upx?.available && tools.upx.path) {
      const unpackedDir = path.join(outDir, 'extracted', 'unpacked');
      fs.mkdirSync(unpackedDir, { recursive: true });
      const copyPath = path.join(unpackedDir, path.basename(filePath));
      fs.copyFileSync(filePath, copyPath);
      try {
        const res = await runToolSafe(tools.upx.path, ['-d', copyPath], { timeoutMs: 30000 });
        if (res.code === 0) {
          return {
            status: 'extracted',
            toolUsed: 'upx',
            extractDir: unpackedDir,
            files: [path.basename(copyPath)],
            unpackedBinaryPath: copyPath,
            notes: ['Successfully unpacked UPX-compressed binary into extracted/unpacked/.']
          };
        }
        notes.push(`upx -d exited ${res.code}: ${res.stderr.trim()}`);
      } catch (err) {
        notes.push(`upx error: ${err.message}`);
      }
    } else {
      notes.push('UPX packer detected, but `upx` is not installed on PATH.');
    }
  }

  // 2. Inno Setup via innoextract
  if (identity.installerFramework === 'Inno Setup') {
    if (tools.innoextract?.available && tools.innoextract.path) {
      try {
        const res = await runToolSafe(tools.innoextract.path, ['-s', '-d', extractDir, filePath], { timeoutMs: 60000 });
        const files = collectSafeFiles(extractDir);
        if (res.code === 0 && files.length > 0) {
          return {
            status: 'extracted',
            toolUsed: 'innoextract',
            extractDir,
            files,
            notes
          };
        }
        notes.push(`innoextract exited ${res.code}: ${res.stderr.trim()}`);
      } catch (err) {
        notes.push(`innoextract error: ${err.message}`);
      }
    } else {
      notes.push('Inno Setup detected, but `innoextract` is not installed on PATH.');
    }
  }

  // 3. Electron .asar / directory / installer
  if (identity.kind === 'electron') {
    try {
      const asarRes = await unpackDesktopApp(filePath, extractDir);
      if (asarRes?.files?.length) {
        return {
          status: 'extracted',
          toolUsed: 'mimic-asar-unpacker',
          extractDir,
          files: collectSafeFiles(extractDir),
          notes
        };
      }
    } catch {
      // May be an Electron installer/exe wrapping resources; fall through to 7z
    }
  }

  // 4. 7-Zip extraction for NSIS, WiX Burn, 7-Zip SFX, Squirrel, ZIP, WinRAR SFX, etc.
  const sevenZ = tools['7z'];
  if (sevenZ?.available && sevenZ.path) {
    try {
      const res = await runToolSafe(sevenZ.path, ['x', '-y', `-o${extractDir}`, filePath], { timeoutMs: 60000 });
      let files = collectSafeFiles(extractDir);
      // If an extracted Electron installer contains app.asar, unpack it too
      for (const rel of files) {
        if (rel.endsWith('app.asar')) {
          const asarPath = path.join(extractDir, rel);
          const asarOut = path.join(extractDir, '_asar_unpacked');
          try {
            await unpackDesktopApp(asarPath, asarOut);
          } catch {}
        }
      }
      files = collectSafeFiles(extractDir);
      if (files.length > 0) {
        toolUsed = '7z';
        return {
          status: res.code === 0 ? 'extracted' : 'partial',
          toolUsed,
          extractDir,
          files,
          notes
        };
      }
      notes.push(`7z could not extract payload (exit ${res.code}).`);
    } catch (err) {
      notes.push(`7z error: ${err.message}`);
    }
  } else {
    notes.push('7-Zip (7z/7za) is not installed; cannot extract installer/archive payload.');
  }

  return {
    status: notes.some(n => n.includes('not installed')) ? 'unsupported' : 'failed',
    toolUsed,
    extractDir,
    files: [],
    notes
  };
}
