/**
 * Asset URL to Local Disk Path Normalizer
 * Accurately maps both same-origin assets and third-party CDNs to clean filesystem paths,
 * filters telemetry/tracker domains, and rewrites external CDN links to local proxy routes.
 */

import crypto from 'crypto';
import path from 'path';

export const TRACKER_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'sentry.io',
  'segment.io',
  'segment.com',
  'hotjar.com',
  'clarity.ms',
  'intercom.io',
  'facebook.net',
  'connect.facebook.net',
  'bat.bing.com',
  'mixpanel.com',
  'amplitude.com',
  'fullstory.com',
  'datadoghq.com',
  'bugsnag.com'
];

/**
 * Returns true if the URL belongs to a known analytics, ad, or telemetry tracker domain.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isBlockedTrackerUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    return TRACKER_HOSTS.some(t => host === t || host.endsWith('.' + t));
  } catch {
    return false;
  }
}

/**
 * Rewrites captured external origin URLs inside HTML or CSS text to local /external/<host>/ paths.
 *
 * @param {string} text
 * @param {Iterable<string>} capturedExternalHosts
 * @returns {string}
 */
export function rewriteExternalAssetUrls(text, capturedExternalHosts) {
  if (!text || !capturedExternalHosts) return text;

  let output = text;
  for (const host of capturedExternalHosts) {
    if (!host) continue;
    const safeHost = host.replace(/[\\:*?"<>|]/g, '_');
    const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:https?:\\/\\/|(?<![:/])\\/\\/)${escapedHost}\\/`, 'g');
    output = output.replace(pattern, `/external/${safeHost}/`);
  }
  return output;
}

/**
 * Maps an incoming network asset URL to a sanitized local disk path.
 * 
 * @param {string} rawUrl - Full or relative asset URL
 * @param {string} baseUrl - Base root URL of the target site
 * @param {string} outputDir - Root output directory for the clone
 * @param {string} [mimeType=''] - Optional HTTP MIME type of the response
 * @returns {{ diskPath: string, isExternal: boolean } | null}
 */
export function mapUrlToFilePath(rawUrl, baseUrl, outputDir, mimeType = '') {
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

  const lastIdx = segments.length - 1;
  const lastSeg = segments[lastIdx];
  if (!path.extname(lastSeg)) {
    if (mimeType && mimeType.toLowerCase().includes('text/html')) {
      segments[lastIdx] = `${lastSeg}.html`;
    } else if (parsedUrl.search) {
      const qHash = crypto.createHash('md5').update(parsedUrl.search).digest('hex').slice(0, 8);
      segments[lastIdx] = `${lastSeg}_${qHash}`;
    }
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
