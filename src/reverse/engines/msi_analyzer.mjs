/**
 * Windows Installer (.msi) OLE2 & Database Analyzer
 * Parses OLE2 Compound File directory streams without executing MSI actions,
 * decodes MSI 6-bit stream names, detects embedded/external CABs, and
 * optionally queries `msiinfo` for full MSI database table inspection.
 */

import fs from 'fs';
import path from 'path';
import { runToolSafe } from '../orchestrator/tool_registry.mjs';

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const MSI_B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._';

const KEY_MSI_TABLES = [
  'Property',
  'File',
  'Component',
  'Feature',
  'Directory',
  'Media',
  'CustomAction',
  'Registry',
  'Shortcut',
  'ServiceInstall',
  'ServiceControl',
  'LaunchCondition',
  'InstallExecuteSequence',
  'InstallUISequence'
];

/**
 * Decodes MSI 6-bit compressed stream names (used for MSI database tables in OLE2).
 */
export function decodeMsiStreamName(rawName) {
  let out = '';
  let isTable = false;
  for (let i = 0; i < rawName.length; i++) {
    const code = rawName.charCodeAt(i);
    if (code === 0x4840) {
      isTable = true;
    } else if (code >= 0x4800 && code < 0x4840) {
      out += MSI_B64[code - 0x4800] || '';
    } else if (code >= 0x3800 && code < 0x4800) {
      const val = code - 0x3800;
      out += (MSI_B64[val & 0x3f] || '') + (MSI_B64[(val >> 6) & 0x3f] || '');
    } else {
      out += rawName[i];
    }
  }
  return { name: out, isTable };
}

/**
 * Parses an OLE2 Compound File header + FAT + Directory entries (pure JS).
 */
export function parseOle2Container(buf) {
  if (!buf || buf.length < 512 || !buf.subarray(0, 8).equals(OLE2_MAGIC)) {
    return { isOle2: false, error: 'Invalid OLE2 Compound File header' };
  }

  const sectorShift = buf.readUInt16LE(0x1e);
  const sectorSize = 1 << (sectorShift >= 9 && sectorShift <= 16 ? sectorShift : 9);
  const firstDirSector = buf.readUInt32LE(0x30);

  // Build FAT table from the 109 DIFAT entries in header (starting at 0x4c)
  const fatEntries = [];
  const entriesPerSector = sectorSize / 4;
  for (let i = 0; i < 109; i++) {
    const fatSec = buf.readUInt32LE(0x4c + i * 4);
    if (fatSec >= 0xfffffffa) break;
    const off = (fatSec + 1) * sectorSize;
    if (off + sectorSize > buf.length) break;
    for (let j = 0; j < entriesPerSector; j++) {
      fatEntries.push(buf.readUInt32LE(off + j * 4));
    }
  }

  // Follow directory stream chain
  const dirChunks = [];
  const visited = new Set();
  let cur = firstDirSector;
  while (cur < 0xfffffffa && !visited.has(cur) && dirChunks.length < 4096) {
    visited.add(cur);
    const off = (cur + 1) * sectorSize;
    if (off + sectorSize > buf.length) break;
    dirChunks.push(buf.subarray(off, off + sectorSize));
    cur = fatEntries[cur] ?? 0xfffffffe;
  }

  const dirBuf = Buffer.concat(dirChunks);
  const streams = [];
  const tables = [];

  for (let off = 0; off + 128 <= dirBuf.length; off += 128) {
    const nameByteLen = dirBuf.readUInt16LE(off + 64);
    const entryType = dirBuf.readUInt8(off + 66); // 1=storage, 2=stream, 5=root
    if (entryType === 0 || nameByteLen < 2 || nameByteLen > 64) continue;
    const rawName = dirBuf.subarray(off, off + nameByteLen - 2).toString('utf16le');
    const decoded = decodeMsiStreamName(rawName);
    const startSector = dirBuf.readUInt32LE(off + 116);
    const size = dirBuf.readUInt32LE(off + 120);

    const item = {
      rawName,
      name: decoded.name,
      isTable: decoded.isTable,
      type: entryType === 5 ? 'root' : entryType === 1 ? 'storage' : 'stream',
      startSector,
      size
    };
    streams.push(item);
    if (decoded.isTable && item.type === 'stream') {
      tables.push(decoded.name);
    }
  }

  // Scan for embedded MSCF CAB signatures
  const embeddedCabs = [];
  let searchIdx = 0;
  const MSCF = Buffer.from([0x4d, 0x53, 0x43, 0x46, 0x00, 0x00, 0x00, 0x00]);
  while (searchIdx < buf.length && embeddedCabs.length < 32) {
    const found = buf.indexOf(MSCF, searchIdx);
    if (found === -1) break;
    const cabSize = found + 12 <= buf.length ? buf.readUInt32LE(found + 8) : 0;
    embeddedCabs.push({ offset: found, declaredSize: cabSize });
    searchIdx = found + Math.max(cabSize, 64);
  }

  return {
    isOle2: true,
    sectorSize,
    streams,
    tables: [...new Set(tables)],
    embeddedCabs
  };
}

function parseTsvTable(tsv) {
  const lines = tsv.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };
  const columns = lines[0].split('\t');
  // msiinfo export has 3 header lines: column names, column types, table/key spec
  const dataStart = lines.length >= 3 ? 3 : 1;
  const rows = [];
  for (let i = dataStart; i < lines.length && rows.length < 2000; i++) {
    const vals = lines[i].split('\t');
    const row = {};
    for (let c = 0; c < columns.length; c++) {
      row[columns[c]] = vals[c] ?? '';
    }
    rows.push(row);
  }
  return { columns, rows, totalRows: Math.max(0, lines.length - dataStart) };
}

function buildDirectoryTreeMap(dirRows) {
  const byId = new Map();
  for (const r of dirRows) {
    const id = r.Directory;
    if (!id) continue;
    const defaultDir = (r.DefaultDir || id).split('|').pop().split(':')[0];
    byId.set(id, {
      id,
      parent: r.Directory_Parent || null,
      name: defaultDir === '.' ? '' : defaultDir
    });
  }

  const resolveDir = (id, depth = 0) => {
    if (!id || depth > 25 || !byId.has(id)) return id || '';
    const node = byId.get(id);
    if (!node.parent || node.parent === id || id === 'TARGETDIR') {
      return node.name || 'TARGETDIR';
    }
    const parentPath = resolveDir(node.parent, depth + 1);
    if (!node.name) return parentPath;
    return parentPath === 'TARGETDIR' ? node.name : `${parentPath}/${node.name}`;
  };

  const resolved = {};
  for (const id of byId.keys()) {
    resolved[id] = resolveDir(id);
  }
  return resolved;
}

export async function analyzeMsi(filePath, tools = {}, existingBuffer = null) {
  const buf = existingBuffer || fs.readFileSync(filePath);
  const ole2 = parseOle2Container(buf);
  if (!ole2.isOle2) {
    return { isMsi: false, error: ole2.error };
  }

  const result = {
    isMsi: true,
    ole2: {
      sectorSize: ole2.sectorSize,
      streamCount: ole2.streams.length,
      tablesDetected: ole2.tables,
      embeddedCabs: ole2.embeddedCabs,
      externalCabs: []
    },
    summaryInfo: {},
    tables: {},
    properties: {},
    fileMappings: [],
    directories: {},
    customActions: [],
    registryChanges: [],
    shortcuts: [],
    services: [],
    status: 'partial',
    notes: []
  };

  // Detect external .cab references from Media/raw strings if msiinfo isn't available
  const rawCabMatches = buf.toString('latin1').match(/[A-Za-z0-9_.-]+\.cab/gi) || [];
  const externalCabSet = new Set(
    rawCabMatches
      .filter(c => !c.startsWith('#'))
      .map(c => c.trim())
  );

  const msiinfo = tools?.msiinfo;
  if (msiinfo?.available && msiinfo.path) {
    try {
      const sumRes = await runToolSafe(msiinfo.path, ['suminfo', filePath], { timeoutMs: 15000 });
      if (sumRes.code === 0) {
        for (const line of sumRes.stdout.split(/\r?\n/)) {
          const idx = line.indexOf(':');
          if (idx > 0) {
            const k = line.slice(0, idx).trim();
            const v = line.slice(idx + 1).trim();
            if (k && v) result.summaryInfo[k] = v;
          }
        }
      }

      const tblRes = await runToolSafe(msiinfo.path, ['tables', filePath], { timeoutMs: 15000 });
      const availableTables = tblRes.code === 0
        ? tblRes.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
        : ole2.tables;

      if (availableTables.length > 0) {
        result.ole2.tablesDetected = availableTables;
      }

      for (const tbl of KEY_MSI_TABLES) {
        if (!availableTables.includes(tbl)) continue;
        const exp = await runToolSafe(msiinfo.path, ['export', filePath, tbl], { timeoutMs: 15000 });
        if (exp.code === 0 && exp.stdout.trim()) {
          result.tables[tbl] = parseTsvTable(exp.stdout);
        }
      }

      // Extract structured summaries from parsed tables
      if (result.tables.Property) {
        for (const r of result.tables.Property.rows) {
          if (r.Property) result.properties[r.Property] = r.Value;
        }
      }
      if (result.tables.Directory) {
        result.directories = buildDirectoryTreeMap(result.tables.Directory.rows);
      }
      if (result.tables.File && result.tables.Component) {
        const compToDir = new Map();
        for (const c of result.tables.Component.rows) {
          compToDir.set(c.Component, c.Directory_);
        }
        for (const f of result.tables.File.rows) {
          const dirId = compToDir.get(f.Component_);
          const targetDir = result.directories[dirId] || dirId || '';
          const fileName = (f.FileName || f.File || '').split('|').pop();
          result.fileMappings.push({
            id: f.File,
            fileName,
            component: f.Component_,
            targetDir,
            targetPath: targetDir ? `${targetDir}/${fileName}` : fileName,
            size: Number(f.FileSize) || 0,
            version: f.Version || null
          });
        }
      }
      if (result.tables.Media) {
        for (const m of result.tables.Media.rows) {
          if (m.Cabinet && !m.Cabinet.startsWith('#')) {
            externalCabSet.add(m.Cabinet);
          }
        }
      }
      if (result.tables.CustomAction) {
        result.customActions = result.tables.CustomAction.rows.map(r => ({
          action: r.Action,
          type: Number(r.Type) || r.Type,
          source: r.Source,
          target: r.Target
        }));
      }
      if (result.tables.Registry) {
        result.registryChanges = result.tables.Registry.rows.map(r => ({
          root: r.Root,
          key: r.Key,
          name: r.Name,
          value: r.Value
        }));
      }
      if (result.tables.Shortcut) {
        result.shortcuts = result.tables.Shortcut.rows.map(r => ({
          name: (r.Name || '').split('|').pop(),
          directory: result.directories[r.Directory_] || r.Directory_,
          target: r.Target,
          description: r.Description
        }));
      }
      if (result.tables.ServiceInstall) {
        result.services = result.tables.ServiceInstall.rows;
      }

      result.status = 'extracted';
    } catch (err) {
      result.notes.push(`msiinfo inspection error: ${err.message}`);
    }
  } else {
    result.notes.push('msiinfo (msitools) is not installed; reporting OLE2 container structure and embedded CAB metadata only.');
  }

  const msiDir = path.dirname(filePath);
  result.ole2.externalCabs = [...externalCabSet].map(cabName => ({
    name: cabName,
    presentAlongsideMsi: fs.existsSync(path.join(msiDir, cabName))
  }));

  return result;
}
