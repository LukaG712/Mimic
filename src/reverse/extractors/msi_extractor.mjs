/**
 * Safe Windows Installer (.msi) Extractor
 * Extracts MSI payloads without installing or executing custom actions.
 * Supports msiextract (msitools), lessmsi, and 7z, with strict path-traversal validation.
 */

import fs from 'fs';
import path from 'path';
import { runToolSafe, isSafeSubpath } from '../orchestrator/tool_registry.mjs';

function walkSafeFiles(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!isSafeSubpath(rootDir, full)) continue;
      if (entry.isSymbolicLink()) {
        // Remove symlinks inside extracted payloads for safety
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

export async function extractMsi(filePath, outDir, tools = {}, msiAnalysis = null) {
  const extractDir = path.join(outDir, 'extracted', 'msi');
  fs.mkdirSync(extractDir, { recursive: true });

  const attempts = [];

  // 1. Prefer msiextract (reconstructs directory structure natively)
  if (tools.msiextract?.available && tools.msiextract.path) {
    try {
      const res = await runToolSafe(tools.msiextract.path, ['-C', extractDir, filePath], { timeoutMs: 60000 });
      const files = walkSafeFiles(extractDir);
      if (res.code === 0 && files.length > 0) {
        return {
          status: 'extracted',
          toolUsed: 'msiextract',
          extractDir,
          files,
          notes: []
        };
      }
      attempts.push(`msiextract exited ${res.code}: ${res.stderr.trim()}`);
    } catch (err) {
      attempts.push(`msiextract error: ${err.message}`);
    }
  }

  // 2. lessmsi (Windows)
  if (tools.lessmsi?.available && tools.lessmsi.path) {
    try {
      const res = await runToolSafe(tools.lessmsi.path, ['x', filePath, extractDir + path.sep], { timeoutMs: 60000 });
      const files = walkSafeFiles(extractDir);
      if (res.code === 0 && files.length > 0) {
        return {
          status: 'extracted',
          toolUsed: 'lessmsi',
          extractDir,
          files,
          notes: []
        };
      }
      attempts.push(`lessmsi exited ${res.code}: ${res.stderr.trim()}`);
    } catch (err) {
      attempts.push(`lessmsi error: ${err.message}`);
    }
  }

  // 3. 7-Zip fallback (extracts raw streams + embedded CABs, then unpacks any .cab)
  const sevenZ = tools['7z'];
  if (sevenZ?.available && sevenZ.path) {
    try {
      const res = await runToolSafe(sevenZ.path, ['x', '-y', `-o${extractDir}`, filePath], { timeoutMs: 60000 });
      // Also try extracting any embedded CAB streams or external CABs present alongside the MSI
      const initialFiles = walkSafeFiles(extractDir);
      for (const rel of initialFiles) {
        if (rel.toLowerCase().endsWith('.cab') || rel.toLowerCase().includes('cab')) {
          const cabPath = path.join(extractDir, rel);
          try {
            const head = Buffer.alloc(4);
            const fd = fs.openSync(cabPath, 'r');
            fs.readSync(fd, head, 0, 4, 0);
            fs.closeSync(fd);
            if (head.toString('ascii') === 'MSCF') {
              const cabOut = path.join(extractDir, '_cab_' + path.basename(rel, '.cab'));
              fs.mkdirSync(cabOut, { recursive: true });
              await runToolSafe(sevenZ.path, ['x', '-y', `-o${cabOut}`, cabPath], { timeoutMs: 45000 });
            }
          } catch {}
        }
      }

      if (msiAnalysis?.ole2?.externalCabs?.length) {
        const msiDir = path.dirname(filePath);
        for (const extCab of msiAnalysis.ole2.externalCabs) {
          if (extCab.presentAlongsideMsi) {
            const cabSrc = path.join(msiDir, extCab.name);
            const cabOut = path.join(extractDir, '_external_' + path.basename(extCab.name, '.cab'));
            fs.mkdirSync(cabOut, { recursive: true });
            await runToolSafe(sevenZ.path, ['x', '-y', `-o${cabOut}`, cabSrc], { timeoutMs: 45000 });
          }
        }
      }

      const files = walkSafeFiles(extractDir);
      if (files.length > 0) {
        return {
          status: res.code === 0 ? 'extracted' : 'partial',
          toolUsed: '7z',
          extractDir,
          files,
          notes: attempts
        };
      }
      attempts.push(`7z exited ${res.code}: ${res.stderr.trim()}`);
    } catch (err) {
      attempts.push(`7z error: ${err.message}`);
    }
  }

  return {
    status: attempts.length > 0 ? 'failed' : 'unsupported',
    toolUsed: null,
    extractDir,
    files: [],
    notes: attempts.length > 0
      ? attempts
      : ['No MSI extraction tool found (install msitools, lessmsi, or 7z to extract MSI payloads).']
  };
}
