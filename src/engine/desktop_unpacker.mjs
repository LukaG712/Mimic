/**
 * Mimic Desktop Web-Bundle Unpacker (.asar & unpacked Electron directories)
 * Pure Node.js ASAR archive reader/extractor (no external dependencies).
 */

import fs from 'fs';
import path from 'path';
import { scaffoldCloneManifests } from './cdp_capture.mjs';

/**
 * Reads an Electron ASAR archive header and extracts all files to outputDir.
 * ASAR binary layout (Chromium Pickle):
 *   [0..3]   uint32LE data size (4)
 *   [4..7]   uint32LE header pickle size
 *   [8..11]  uint32LE header payload size
 *   [12..15] uint32LE JSON string length
 *   [16..]   UTF-8 JSON directory tree, followed by concatenated file payloads
 */
export function unpackAsar(asarPath, outputDir) {
  if (!fs.existsSync(asarPath)) {
    throw new Error(`ASAR archive not found: ${asarPath}`);
  }

  const buf = fs.readFileSync(asarPath);
  if (buf.length < 16) {
    throw new Error('Invalid ASAR archive (file too small)');
  }

  const headerSize = buf.readUInt32LE(4);
  const jsonLen = buf.readUInt32LE(12);
  const headerJsonStart = 16;
  const headerJsonEnd = headerJsonStart + jsonLen;
  if (headerJsonEnd > buf.length) {
    throw new Error('Invalid ASAR header length');
  }

  const header = JSON.parse(buf.subarray(headerJsonStart, headerJsonEnd).toString('utf8'));
  const dataOffset = 8 + headerSize;
  fs.mkdirSync(outputDir, { recursive: true });

  let fileCount = 0;
  let totalBytes = 0;

  function walk(node, relDir) {
    if (!node || !node.files) return;
    for (const [name, entry] of Object.entries(node.files)) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        continue;
      }
      const targetPath = path.join(outputDir, relDir, name);
      if (entry.files) {
        fs.mkdirSync(targetPath, { recursive: true });
        walk(entry, path.join(relDir, name));
      } else if (entry.offset !== undefined && entry.size !== undefined) {
        const start = dataOffset + parseInt(entry.offset, 10);
        const size = parseInt(entry.size, 10);
        if (start >= dataOffset && start + size <= buf.length) {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, buf.subarray(start, start + size));
          fileCount++;
          totalBytes += size;
        }
      }
    }
  }

  walk(header, '');
  return { fileCount, totalBytes };
}

/**
 * Unpacks an .asar file (or locates resources/app.asar inside an unpacked app folder)
 * into a Mimic clone directory and scaffolds server.js + clone-manifest.json.
 */
export function unpackDesktopApp(inputPath, outputDir, options = {}) {
  const port = options.port || 3000;
  const resolvedInput = path.resolve(inputPath);
  if (!fs.existsSync(resolvedInput)) {
    throw new Error(`Input path not found: ${resolvedInput}`);
  }

  let asarFile = null;
  const stat = fs.statSync(resolvedInput);
  if (stat.isFile() && resolvedInput.toLowerCase().endsWith('.asar')) {
    asarFile = resolvedInput;
  } else if (stat.isDirectory()) {
    const candidates = [
      path.join(resolvedInput, 'resources', 'app.asar'),
      path.join(resolvedInput, 'app.asar')
    ];
    asarFile = candidates.find(c => fs.existsSync(c)) || null;
  }

  if (!asarFile) {
    throw new Error(
      'No .asar archive found. Provide a .asar file or an unpacked Electron app directory containing resources/app.asar.'
    );
  }

  const { fileCount, totalBytes } = unpackAsar(asarFile, outputDir);
  scaffoldCloneManifests('https://desktop.local', outputDir, port);

  const manifest = {
    url: `desktop://${path.basename(resolvedInput)}`,
    capturedAt: new Date().toISOString(),
    sourceType: 'electron-asar',
    assetCount: fileCount,
    totalBytes,
    skippedTrackers: 0,
    externalHosts: [],
    mimeBreakdown: {},
    page: { title: path.basename(outputDir) }
  };
  fs.writeFileSync(path.join(outputDir, 'clone-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  return { outputDir, asarFile, fileCount, totalBytes };
}
