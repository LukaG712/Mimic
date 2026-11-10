/**
 * Asset URL to Local Disk Path Normalizer
 * Accurately maps both same-origin assets and third-party CDNs to clean filesystem paths.
 */

import path from 'path';

/**
 * Maps an incoming network asset URL to a sanitized local disk path.
 * 
 * @param {string} rawUrl - Full or relative asset URL
 * @param {string} baseUrl - Base root URL of the target site
 * @param {string} outputDir - Root output directory for the clone
 * @returns {{ diskPath: string, isExternal: boolean } | null}
 */
export function mapUrlToFilePath(rawUrl, baseUrl, outputDir) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  const trimmed = rawUrl.trim();
  if (
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('#')
  ) {
    return null;
  }

  let parsedUrl;
  let parsedBase;
  try {
    parsedBase = new URL(baseUrl);
    parsedUrl = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return null;
  }

  // Sanitize pathname: split by '/' and filter out empty or illegal segments
  let rawPath = parsedUrl.pathname;
  if (!rawPath || rawPath === '/') {
    rawPath = '/index.html';
  } else if (rawPath.endsWith('/')) {
    rawPath = rawPath + 'index.html';
  }

  const segments = rawPath
    .split('/')
    .filter(Boolean)
    .map(seg => {
      // Decode URI components and sanitize illegal Windows filename characters: \/:*?"<>|
      try {
        seg = decodeURIComponent(seg);
      } catch {}
      return seg.replace(/[\\:*?"<>|]/g, '_');
    });

  if (segments.length === 0) {
    segments.push('index.html');
  }

  const isSameHost = parsedUrl.hostname === parsedBase.hostname;

  let diskPath;
  if (isSameHost) {
    diskPath = path.join(outputDir, ...segments);
  } else {
    const safeHost = parsedUrl.hostname.replace(/[\\:*?"<>|]/g, '_');
    diskPath = path.join(outputDir, 'external', safeHost, ...segments);
  }

  return {
    diskPath,
    isExternal: !isSameHost
  };
}
