/**
 * Static Strings, URLs, IPs, Paths, and Registry Key Analyzer
 * Extracts ASCII and UTF-16LE printable strings from binary buffers.
 */

const URL_RE = /https?:\/\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=%-]{4,200}/g;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const WIN_PATH_RE = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n\x00]{1,80}\\)*[^\\/:*?"<>|\r\n\x00]{1,80}/g;
const REG_KEY_RE = /(?:HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKEY_CLASSES_ROOT|HKLM|HKCU|HKCR)\\[A-Za-z0-9_\\.\- ]{3,120}/g;
const PDB_RE = /[A-Za-z0-9_:\\/.\- ]{3,180}\.pdb\b/gi;

function extractAsciiStrings(buf, minLen = 5, maxStrings = 4000) {
  const out = [];
  let start = -1;
  for (let i = 0; i < buf.length && out.length < maxStrings; i++) {
    const b = buf[i];
    if (b >= 0x20 && b <= 0x7e) {
      if (start === -1) start = i;
    } else {
      if (start !== -1 && i - start >= minLen) {
        out.push(buf.subarray(start, i).toString('ascii'));
      }
      start = -1;
    }
  }
  if (start !== -1 && buf.length - start >= minLen && out.length < maxStrings) {
    out.push(buf.subarray(start).toString('ascii'));
  }
  return out;
}

function extractUtf16LeStrings(buf, minLen = 5, maxStrings = 2000) {
  const out = [];
  let chars = [];
  for (let i = 0; i + 1 < buf.length && out.length < maxStrings; i += 2) {
    const lo = buf[i];
    const hi = buf[i + 1];
    if (hi === 0 && lo >= 0x20 && lo <= 0x7e) {
      chars.push(String.fromCharCode(lo));
    } else {
      if (chars.length >= minLen) {
        out.push(chars.join(''));
      }
      chars = [];
    }
  }
  if (chars.length >= minLen && out.length < maxStrings) {
    out.push(chars.join(''));
  }
  return out;
}

export function analyzeStrings(buf, options = {}) {
  const maxBytes = options.maxScanBytes || 16 * 1024 * 1024;
  const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;

  const ascii = extractAsciiStrings(slice, 5, 4000);
  const utf16 = extractUtf16LeStrings(slice, 5, 2000);
  const all = [...new Set([...ascii, ...utf16])];

  const urls = new Set();
  const ips = new Set();
  const paths = new Set();
  const registryKeys = new Set();
  const pdbPaths = new Set();

  for (const s of all) {
    for (const m of s.match(URL_RE) || []) if (urls.size < 100) urls.add(m);
    for (const m of s.match(IPV4_RE) || []) if (ips.size < 50) ips.add(m);
    for (const m of s.match(WIN_PATH_RE) || []) if (paths.size < 100) paths.add(m);
    for (const m of s.match(REG_KEY_RE) || []) if (registryKeys.size < 50) registryKeys.add(m);
    for (const m of s.match(PDB_RE) || []) if (pdbPaths.size < 20) pdbPaths.add(m);
  }

  return {
    totalUniqueStrings: all.length,
    truncatedScan: buf.length > maxBytes,
    urls: [...urls],
    ipAddresses: [...ips],
    paths: [...paths],
    registryKeys: [...registryKeys],
    pdbPaths: [...pdbPaths],
    sampleStrings: all.slice(0, 150)
  };
}
