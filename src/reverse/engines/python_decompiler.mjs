/**
 * Python Bytecode (.pyc) Decompiler & Disassembler
 * Uses uncompyle6 / decompyle3 when available for full .py recovery,
 * and falls back to Python stdlib marshal + dis for safe static disassembly.
 */

import fs from 'fs';
import path from 'path';
import { runToolSafe } from '../orchestrator/tool_registry.mjs';

const PY_DISASM_SCRIPT = `
import sys, marshal, dis, io

path = sys.argv[1]
data = open(path, 'rb').read()
code = None
for offset in (16, 12, 8, 0):
    if offset >= len(data):
        continue
    try:
        obj = marshal.loads(data[offset:])
        if hasattr(obj, 'co_code'):
            code = obj
            break
    except Exception:
        pass

if code is None:
    sys.stderr.write('Unable to unmarshal code object\\n')
    sys.exit(2)

buf = io.StringIO()
buf.write(f"# Python Bytecode Disassembly: {path}\\n")
buf.write(f"# co_name={code.co_name} co_filename={code.co_filename} co_varnames={code.co_varnames}\\n")
buf.write(f"# co_names={code.co_names}\\n\\n")
dis.dis(code, file=buf)
sys.stdout.write(buf.getvalue())
`;

export async function decompilePythonBytecode(pycFiles, outDir, tools = {}) {
  const decompiledDir = path.join(outDir, 'decompiled', 'python');
  fs.mkdirSync(decompiledDir, { recursive: true });

  const results = [];
  const decompiler = tools.decompyle3?.available
    ? tools.decompyle3
    : tools.uncompyle6?.available
      ? tools.uncompyle6
      : null;

  const python3 = tools.python3;
  let decompiledCount = 0;
  let disassembledCount = 0;
  const notes = [];

  for (const pycPath of pycFiles.slice(0, 50)) {
    const baseName = path.basename(pycPath, '.pyc');
    if (decompiler?.path) {
      try {
        const res = await runToolSafe(decompiler.path, [pycPath], { timeoutMs: 20000 });
        if (res.code === 0 && res.stdout.trim()) {
          const outFile = path.join(decompiledDir, `${baseName}.py`);
          fs.writeFileSync(outFile, res.stdout, 'utf8');
          results.push({
            source: path.basename(pycPath),
            output: path.relative(outDir, outFile).replace(/\\/g, '/'),
            mode: 'decompiled',
            tool: decompiler.id
          });
          decompiledCount++;
          continue;
        }
      } catch (err) {
        notes.push(`${decompiler.id} failed on ${baseName}: ${err.message}`);
      }
    }

    if (python3?.available && python3.path) {
      try {
        const res = await runToolSafe(python3.path, ['-c', PY_DISASM_SCRIPT, pycPath], { timeoutMs: 15000 });
        if (res.code === 0 && res.stdout.trim()) {
          const outFile = path.join(decompiledDir, `${baseName}.dis.txt`);
          fs.writeFileSync(outFile, res.stdout, 'utf8');
          results.push({
            source: path.basename(pycPath),
            output: path.relative(outDir, outFile).replace(/\\/g, '/'),
            mode: 'disassembled',
            tool: 'python3-dis'
          });
          disassembledCount++;
        }
      } catch (err) {
        notes.push(`python3 dis failed on ${baseName}: ${err.message}`);
      }
    }
  }

  let status = 'unsupported';
  if (decompiledCount > 0) status = 'decompiled';
  else if (disassembledCount > 0) status = 'partial';
  else if (pycFiles.length === 0) status = 'unsupported';

  if (!decompiler && disassembledCount > 0) {
    notes.push('uncompyle6/decompyle3 not installed; recovered Python bytecode disassembly (.dis.txt) instead of .py source.');
  }

  return {
    status,
    toolUsed: decompiler?.id || (disassembledCount > 0 ? 'python3-dis' : null),
    decompiledDir,
    files: results,
    notes
  };
}
