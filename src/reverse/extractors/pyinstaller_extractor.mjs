/**
 * Pure-JS PyInstaller CArchive Extractor
 * Parses PyInstaller MEI\x0c\x0b\x0a\x0b\x0e cookies and TOCs, safely decompresses
 * embedded scripts/modules/PYZ archives, and enforces strict path-traversal checks.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { isSafeSubpath } from '../orchestrator/tool_registry.mjs';

const PYI_MAGIC = Buffer.from([0x4d, 0x45, 0x49, 0x0c, 0x0b, 0x0a, 0x0b, 0x0e]);

export function parsePyInstallerArchive(buf) {
  const cookiePos = buf.lastIndexOf(PYI_MAGIC);
  if (cookiePos === -1) {
    return { isPyInstaller: false, error: 'PyInstaller MEI cookie not found' };
  }

  const remaining = buf.length - cookiePos;
  const cookieSize = remaining >= 88 ? 88 : remaining >= 24 ? 24 : 0;
  if (!cookieSize) {
    return { isPyInstaller: false, error: 'Truncated PyInstaller cookie' };
  }

  const pkgLen = buf.readUInt32BE(cookiePos + 8);
  const tocOffset = buf.readUInt32BE(cookiePos + 12);
  const tocLen = buf.readUInt32BE(cookiePos + 16);
  const pyVersion = buf.readUInt32BE(cookiePos + 20);
  const pyLibName = cookieSize === 88
    ? buf.subarray(cookiePos + 24, cookiePos + 88).toString('utf8').replace(/\0.*$/, '')
    : null;

  const overlayStart = (cookiePos + cookieSize) - pkgLen;
  if (overlayStart < 0 || overlayStart + tocOffset + tocLen > buf.length) {
    return { isPyInstaller: false, error: 'Invalid PyInstaller CArchive offsets' };
  }

  const entries = [];
  let pos = overlayStart + tocOffset;
  const tocEnd = pos + tocLen;

  while (pos + 18 <= tocEnd) {
    const entryLen = buf.readUInt32BE(pos);
    if (entryLen < 18 || pos + entryLen > tocEnd) break;
    const entryPos = buf.readUInt32BE(pos + 4);
    const compressedSize = buf.readUInt32BE(pos + 8);
    const uncompressedSize = buf.readUInt32BE(pos + 12);
    const compressedFlag = buf.readUInt8(pos + 16);
    const typeChar = String.fromCharCode(buf.readUInt8(pos + 17));
    const rawName = buf.subarray(pos + 18, pos + entryLen).toString('utf8').replace(/\0.*$/, '');

    entries.push({
      name: rawName,
      offset: overlayStart + entryPos,
      compressedSize,
      uncompressedSize,
      compressed: compressedFlag === 1,
      type: typeChar
    });
    pos += entryLen;
  }

  return {
    isPyInstaller: true,
    pyVersion,
    pyLibName,
    overlayStart,
    entries
  };
}

export function extractPyInstaller(filePath, outDir, existingBuffer = null) {
  const buf = existingBuffer || fs.readFileSync(filePath);
  const parsed = parsePyInstallerArchive(buf);
  if (!parsed.isPyInstaller) {
    return {
      status: 'failed',
      files: [],
      pycFiles: [],
      blockedPaths: [],
      notes: [parsed.error]
    };
  }

  const extractDir = path.join(outDir, 'extracted', 'pyinstaller');
  fs.mkdirSync(extractDir, { recursive: true });

  const files = [];
  const pycFiles = [];
  const blockedPaths = [];
  const notes = [];

  for (const entry of parsed.entries) {
    if (!entry.name || entry.type === 'o') continue;
    const cleanRel = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
    let targetName = cleanRel;
    if ((entry.type === 's' || entry.type === 'm' || entry.type === 'M') && !targetName.endsWith('.pyc') && !targetName.endsWith('.py')) {
      targetName += '.pyc';
    }

    const destPath = path.resolve(extractDir, targetName);
    if (!isSafeSubpath(extractDir, destPath)) {
      blockedPaths.push(entry.name);
      continue;
    }

    if (entry.offset < 0 || entry.offset + entry.compressedSize > buf.length) {
      notes.push(`Skipped out-of-bounds entry: ${entry.name}`);
      continue;
    }

    let payload = buf.subarray(entry.offset, entry.offset + entry.compressedSize);
    if (entry.compressed) {
      try {
        payload = zlib.inflateSync(payload);
      } catch (err) {
        notes.push(`Zlib inflate failed for ${entry.name}: ${err.message}`);
        continue;
      }
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, payload);
    const relOut = path.relative(extractDir, destPath).replace(/\\/g, '/');
    files.push(relOut);
    if (relOut.endsWith('.pyc')) {
      pycFiles.push(destPath);
    }
  }

  if (blockedPaths.length > 0) {
    notes.push(`Blocked ${blockedPaths.length} path-traversal archive entries.`);
  }

  return {
    status: files.length > 0 ? 'extracted' : 'partial',
    pyVersion: parsed.pyVersion,
    pyLibName: parsed.pyLibName,
    extractDir,
    files,
    pycFiles,
    blockedPaths,
    notes
  };
}
