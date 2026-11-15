/**
 * .NET Assembly Decompiler Adapter (ILSpy / ilspycmd)
 * Decompiles .NET Framework, Modern .NET, and Single-File assemblies into C# projects
 * when `ilspycmd` is installed. Never fabricates source code when unavailable.
 */

import fs from 'fs';
import path from 'path';
import { runToolSafe } from '../orchestrator/tool_registry.mjs';

function walkFiles(rootDir, baseOutDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(baseOutDir, full).replace(/\\/g, '/'));
    }
  };
  walk(rootDir);
  return out;
}

export async function decompileDotNet(filePath, outDir, tools = {}) {
  const ilspy = tools.ilspycmd;
  if (!ilspy?.available || !ilspy.path) {
    return {
      status: 'unsupported',
      toolUsed: null,
      files: [],
      notes: [
        'ilspycmd is not installed; .NET C# decompilation is unavailable. Install via: dotnet tool install -g ilspycmd'
      ]
    };
  }

  const decompiledDir = path.join(outDir, 'decompiled', 'dotnet');
  fs.mkdirSync(decompiledDir, { recursive: true });

  try {
    const res = await runToolSafe(ilspy.path, ['-p', '-o', decompiledDir, filePath], { timeoutMs: 90000 });
    const files = walkFiles(decompiledDir, outDir);
    if (res.code === 0 && files.length > 0) {
      return {
        status: 'decompiled',
        toolUsed: 'ilspycmd',
        files: files.map(f => ({ output: f, mode: 'decompiled', tool: 'ilspycmd' })),
        notes: []
      };
    }
    return {
      status: 'failed',
      toolUsed: 'ilspycmd',
      files: files.map(f => ({ output: f, mode: 'partial', tool: 'ilspycmd' })),
      notes: [`ilspycmd exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`]
    };
  } catch (err) {
    return {
      status: 'failed',
      toolUsed: 'ilspycmd',
      files: [],
      notes: [`ilspycmd error: ${err.message}`]
    };
  }
}
