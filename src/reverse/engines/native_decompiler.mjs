/**
 * Native Binary Disassembly & Decompilation Adapter
 * Supports Ghidra Headless (`analyzeHeadless`) for full decompilation and
 * GNU `objdump` for x86/x64 PE disassembly. Clearly distinguishes disassembly (`partial`)
 * from C pseudocode decompilation (`decompiled`).
 */

import fs from 'fs';
import path from 'path';
import { runToolSafe } from '../orchestrator/tool_registry.mjs';

const GHIDRA_EXPORT_SCRIPT = `
# Ghidra headless postScript to export decompiled C pseudocode
from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor
import os

out_dir = os.environ.get("MIMIC_GHIDRA_OUT", ".")
decomp = DecompInterface()
decomp.openProgram(currentProgram)
fm = currentProgram.getFunctionManager()
funcs = fm.getFunctions(True)
out_path = os.path.join(out_dir, "decompiled_functions.c")
with open(out_path, "w") as f:
    f.write("// Decompiled by Ghidra Headless for Mimic\\n\\n")
    count = 0
    for func in funcs:
        if count >= 200:
            break
        res = decomp.decompileFunction(func, 30, ConsoleTaskMonitor())
        if res and res.decompileCompleted():
            f.write(res.getDecompiledFunction().getC())
            f.write("\\n")
            count += 1
`;

export async function decompileNative(filePath, outDir, tools = {}) {
  const nativeDir = path.join(outDir, 'decompiled', 'native');
  fs.mkdirSync(nativeDir, { recursive: true });
  const notes = [];

  // 1. Prefer Ghidra Headless if available
  if (tools.ghidra?.available && tools.ghidra.path) {
    const projDir = path.join(nativeDir, '_ghidra_proj');
    const scriptDir = path.join(nativeDir, '_ghidra_scripts');
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, 'MimicExportC.py');
    fs.writeFileSync(scriptPath, GHIDRA_EXPORT_SCRIPT, 'utf8');

    try {
      process.env.MIMIC_GHIDRA_OUT = nativeDir;
      const res = await runToolSafe(
        tools.ghidra.path,
        [projDir, 'MimicProj', '-import', filePath, '-scriptPath', scriptDir, '-postScript', 'MimicExportC.py', '-deleteProject'],
        { timeoutMs: 120000 }
      );
      const cFile = path.join(nativeDir, 'decompiled_functions.c');
      if (fs.existsSync(cFile) && fs.statSync(cFile).size > 0) {
        return {
          status: 'decompiled',
          toolUsed: 'ghidra',
          files: [{
            output: path.relative(outDir, cFile).replace(/\\/g, '/'),
            mode: 'decompiled',
            tool: 'ghidra'
          }],
          notes: []
        };
      }
      notes.push(`Ghidra exited ${res.code} without producing C output.`);
    } catch (err) {
      notes.push(`Ghidra error: ${err.message}`);
    }
  } else {
    notes.push('Ghidra (analyzeHeadless) is not installed; C pseudocode decompilation unavailable.');
  }

  // 2. Fall back to GNU objdump for x86/x64 disassembly (status: partial)
  if (tools.objdump?.available && tools.objdump.path) {
    try {
      const res = await runToolSafe(tools.objdump.path, ['-d', '-M', 'intel', filePath], { timeoutMs: 45000 });
      if (res.code === 0 && res.stdout.trim()) {
        const lines = res.stdout.split(/\r?\n/);
        const truncated = lines.length > 12000;
        const text = (truncated ? lines.slice(0, 12000).join('\n') + '\n\n; [Output truncated at 12,000 lines]' : res.stdout);
        const asmFile = path.join(nativeDir, 'disassembly.asm');
        fs.writeFileSync(asmFile, text, 'utf8');
        return {
          status: 'partial',
          toolUsed: 'objdump',
          files: [{
            output: path.relative(outDir, asmFile).replace(/\\/g, '/'),
            mode: 'disassembled',
            tool: 'objdump'
          }],
          notes: [...notes, 'Produced Intel-syntax disassembly via objdump (partial analysis; not C pseudocode).']
        };
      }
      notes.push(`objdump exited ${res.code}: ${res.stderr.trim()}`);
    } catch (err) {
      notes.push(`objdump error: ${err.message}`);
    }
  }

  return {
    status: 'unsupported',
    toolUsed: null,
    files: [],
    notes
  };
}
