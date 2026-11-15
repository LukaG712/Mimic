/**
 * Mimic Chrome DevTools Protocol (CDP) In-Flight Stream Capture Engine
 * Captures fully hydrated client-side SPAs, streams network assets in-flight directly
 * from browser memory to disk via async I/O, rewrites external CDNs, emits a compact
 * clone-manifest.json, and captures viewport screenshots.
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findChromePath, getChromeLaunchArgs } from './chrome_finder.mjs';
import { isBlockedTrackerUrl, mapUrlToFilePath, rewriteExternalAssetUrls } from './url_mapper.mjs';
import { runReaWebBundle } from './rea_bridge.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_CONCURRENCY = 10;
const COMMAND_TIMEOUT_MS = 15000;

/**
 * Polls Chrome's remote debugging endpoint until ready instead of sleeping a fixed duration.
 */
export async function waitForChromeReady(port, maxWaitMs = 5000, isAborted = () => false) {
  const deadline = Date.now() + maxWaitMs;
  let lastErr;
  while (Date.now() < deadline && !isAborted()) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (resp.ok) {
        return await resp.json();
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 80));
  }
  if (isAborted()) return null;
  throw new Error(`Chrome debug endpoint on port ${port} did not become ready within ${maxWaitMs}ms${lastErr ? `: ${lastErr.message}` : ''}`);
}

function loadCookiesOption(cookiesOpt, targetUrl) {
  if (!cookiesOpt) return [];
  const originUrl = new URL(targetUrl);
  if (typeof cookiesOpt === 'string' && fs.existsSync(cookiesOpt)) {
    const raw = JSON.parse(fs.readFileSync(cookiesOpt, 'utf-8'));
    const list = Array.isArray(raw) ? raw : (raw.cookies || []);
    return list.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || originUrl.hostname,
      path: c.path || '/',
      secure: c.secure ?? originUrl.protocol === 'https:',
      httpOnly: Boolean(c.httpOnly)
    }));
  }
  if (typeof cookiesOpt === 'string') {
    return cookiesOpt.split(';').map(pair => {
      const eq = pair.indexOf('=');
      if (eq <= 0) return null;
      return {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        domain: originUrl.hostname,
        path: '/',
        secure: originUrl.protocol === 'https:'
      };
    }).filter(Boolean);
  }
  return Array.isArray(cookiesOpt) ? cookiesOpt : [];
}

function parseHeadersOption(headersOpt) {
  if (!headersOpt) return {};
  if (typeof headersOpt === 'object' && !Array.isArray(headersOpt)) return headersOpt;
  const arr = Array.isArray(headersOpt) ? headersOpt : [headersOpt];
  const out = {};
  for (const h of arr) {
    const idx = String(h).indexOf(':');
    if (idx > 0) {
      out[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    }
  }
  return out;
}

export async function captureRuntime(targetUrl, outputDir, options = {}) {
  const width = options.width || 1440;
  const height = options.height || 900;
  const waitMs = options.waitMs || 3500;
  const port = options.port || (9222 + Math.floor(Math.random() * 400));
  const doScroll = options.scroll !== false;
  const targetPort = options.targetPort || 3000;
  const timeoutMs = options.timeout || 60000;
  const log = (...args) => {
    if (!options.quiet && !options.json) console.log(...args);
  };

  log(`\n=======================================================`);
  log(`🤖 [Mimic CDP In-Flight Engine] Navigating: ${targetUrl}`);
  log(`📁 Destination: ${outputDir}`);
  log(`🔌 Chrome Debug Port: ${port}`);
  log(`=======================================================\n`);

  const chromePath = findChromePath();
  fs.mkdirSync(outputDir, { recursive: true });

  const chrome = spawn(chromePath, getChromeLaunchArgs(port, { headless: !options.interactiveLogin }));

  let ws;
  let overallTimer;
  let aborted = false;
  const pendingRequests = new Map();

  const runCapture = async () => {
    let assetCount = 0;
    let skippedTrackers = 0;
    let totalBytes = 0;
    let domBytes = 0;
    let screenshotBytes = 0;
    const capturedExternalHosts = new Set();
    const cssDiskPaths = new Set();
    const createdDirs = new Map();
    const mimeBreakdown = {};

    const versionData = await waitForChromeReady(port, 5000, () => aborted);
    if (aborted || !versionData) return;

    ws = new WebSocket(versionData.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    if (aborted) return;

    let msgId = 1;
    let activeSessionId = null;
    const pendingResponses = new Map();
    const requestMeta = new Map();
    const recordedFixtures = {};
    const inflightRequests = new Set();
    let lastNetworkActivity = Date.now();
    const taskQueue = [];
    let activeWorkers = 0;
    let totalQueued = 0;
    const drainResolvers = [];

    function ensureDir(dirPath) {
      if (!createdDirs.has(dirPath)) {
        createdDirs.set(dirPath, fs.promises.mkdir(dirPath, { recursive: true }));
      }
      return createdDirs.get(dirPath);
    }

    function pumpQueue() {
      while (activeWorkers < MAX_CONCURRENCY && taskQueue.length > 0) {
        const job = taskQueue.shift();
        activeWorkers++;
        Promise.resolve()
          .then(job)
          .catch(() => {})
          .finally(() => {
            activeWorkers--;
            pumpQueue();
            if (activeWorkers === 0 && taskQueue.length === 0) {
              const resolvers = drainResolvers.splice(0);
              for (const res of resolvers) res();
            }
          });
      }
    }

    function waitForQueueDrain(maxWaitMs = 15000) {
      if (activeWorkers === 0 && taskQueue.length === 0) {
        return Promise.resolve();
      }
      return Promise.race([
        new Promise(resolve => drainResolvers.push(resolve)),
        new Promise(resolve => setTimeout(resolve, maxWaitMs))
      ]);
    }

    async function waitForNetworkIdle(maxWaitMs = 3500, idleWindowMs = 500) {
      const start = Date.now();
      await new Promise(r => setTimeout(r, Math.min(300, maxWaitMs)));
      while (!aborted && Date.now() - start < maxWaitMs) {
        if (inflightRequests.size === 0 && Date.now() - lastNetworkActivity >= idleWindowMs) {
          return;
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }

    function sendCommand(method, params = {}, sessionId = undefined) {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error(`WebSocket closed before sending ${method}`));
          return;
        }
        const id = msgId++;
        const timer = setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error(`CDP command timed out: ${method}`));
          }
        }, COMMAND_TIMEOUT_MS);

        pendingRequests.set(id, { resolve, reject, timer });
        const payload = sessionId ? { id, sessionId, method, params } : { id, method, params };
        ws.send(JSON.stringify(payload));
      });
    }

    function send(method, params = {}) {
      return sendCommand(method, params);
    }

    function sendSession(method, params = {}) {
      return sendCommand(method, params, activeSessionId);
    }

    // Single centralized O(1) WebSocket message dispatcher
    ws.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (data.id !== undefined && pendingRequests.has(data.id)) {
        const { resolve, reject, timer } = pendingRequests.get(data.id);
        pendingRequests.delete(data.id);
        clearTimeout(timer);
        if (data.error) {
          reject(new Error(data.error.message || 'CDP Error'));
        } else {
          resolve(data.result);
        }
        return;
      }

      if (!activeSessionId || data.sessionId !== activeSessionId) return;

      if (data.method === 'Network.requestWillBeSent') {
        const reqUrl = data.params?.request?.url;
        if (reqUrl && !reqUrl.startsWith('data:') && !reqUrl.startsWith('blob:') && !isBlockedTrackerUrl(reqUrl)) {
          inflightRequests.add(data.params.requestId);
          lastNetworkActivity = Date.now();
          requestMeta.set(data.params.requestId, {
            method: (data.params.request.method || 'GET').toUpperCase(),
            postData: data.params.request.postData || ''
          });
        }
      } else if (data.method === 'Network.responseReceived') {
        const { requestId, response } = data.params;
        const assetUrl = response?.url;
        if (isBlockedTrackerUrl(assetUrl)) {
          skippedTrackers++;
          inflightRequests.delete(requestId);
          requestMeta.delete(requestId);
          return;
        }
        if (response && (response.status === 200 || response.status === 206)) {
          if (assetUrl && !assetUrl.startsWith('data:') && !assetUrl.startsWith('blob:')) {
            pendingResponses.set(requestId, {
              url: assetUrl,
              mimeType: response.mimeType || 'application/octet-stream',
              status: response.status
            });
          }
        }
      } else if (data.method === 'Network.loadingFailed') {
        const { requestId } = data.params;
        pendingResponses.delete(requestId);
        requestMeta.delete(requestId);
        inflightRequests.delete(requestId);
        lastNetworkActivity = Date.now();
      } else if (data.method === 'Network.loadingFinished') {
        const { requestId } = data.params;
        inflightRequests.delete(requestId);
        lastNetworkActivity = Date.now();
        const info = pendingResponses.get(requestId);
        const meta = requestMeta.get(requestId) || { method: 'GET', postData: '' };
        requestMeta.delete(requestId);
        if (info) {
          pendingResponses.delete(requestId);
          totalQueued++;
          taskQueue.push(async () => {
            try {
              const bodyRes = await sendSession('Network.getResponseBody', { requestId });
              if (bodyRes && typeof bodyRes.body === 'string') {
                const buf = bodyRes.base64Encoded
                  ? Buffer.from(bodyRes.body, 'base64')
                  : Buffer.from(bodyRes.body, 'utf-8');
                const cleanMime = (info.mimeType || 'application/octet-stream').split(';')[0].trim().toLowerCase();

                // Record API / JSON / GraphQL fixtures for deterministic offline replay
                try {
                  const parsedAssetUrl = new URL(info.url, targetUrl);
                  const isApiLike =
                    meta.method !== 'GET' ||
                    cleanMime.includes('json') ||
                    parsedAssetUrl.pathname.startsWith('/api/') ||
                    parsedAssetUrl.pathname.startsWith('/_next/data/') ||
                    parsedAssetUrl.pathname.includes('graphql');
                  if (isApiLike && buf.length > 0 && buf.length <= 1024 * 1024) {
                    const bodyHash = meta.postData
                      ? crypto.createHash('md5').update(meta.postData).digest('hex').slice(0, 8)
                      : '';
                    const exactKey = `${meta.method}:${parsedAssetUrl.pathname}${parsedAssetUrl.search}${bodyHash ? `:${bodyHash}` : ''}`;
                    const fallbackKey = `${meta.method}:${parsedAssetUrl.pathname}`;
                    const fixtureEntry = {
                      status: info.status,
                      contentType: info.mimeType || 'application/json; charset=utf-8',
                      body: buf.toString('utf-8')
                    };
                    recordedFixtures[exactKey] = fixtureEntry;
                    if (!recordedFixtures[fallbackKey]) {
                      recordedFixtures[fallbackKey] = fixtureEntry;
                    }
                  }
                } catch {}

                const mapped = mapUrlToFilePath(info.url, targetUrl, outputDir, info.mimeType);
                if (mapped && mapped.diskPath) {
                  await ensureDir(path.dirname(mapped.diskPath));
                  await fs.promises.writeFile(mapped.diskPath, buf);

                  if (mapped.isExternal) {
                    try {
                      capturedExternalHosts.add(new URL(info.url, targetUrl).hostname);
                    } catch {}
                  }

                  if (!mimeBreakdown[cleanMime]) mimeBreakdown[cleanMime] = { count: 0, bytes: 0 };
                  mimeBreakdown[cleanMime].count++;
                  mimeBreakdown[cleanMime].bytes += buf.length;

                  if (cleanMime.includes('text/css') || mapped.diskPath.endsWith('.css')) {
                    cssDiskPaths.add(mapped.diskPath);
                  }

                  assetCount++;
                  totalBytes += buf.length;
                  const rel = path.relative(outputDir, mapped.diskPath);
                  if (assetCount <= 15 || assetCount % 20 === 0) {
                    log(`  ✓ [In-Flight Stream] ${info.mimeType} -> ${rel} (${buf.length.toLocaleString()} B)`);
                  }
                }
              }
            } catch {
              // Ignore transient or purged response bodies gracefully
            }
          });
          pumpQueue();
        }
      }
    });

    ws.addEventListener('close', () => {
      for (const [id, entry] of pendingRequests.entries()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP WebSocket connection closed'));
        pendingRequests.delete(id);
      }
    });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const attachRes = await send('Target.attachToTarget', { targetId, flatten: true });
    activeSessionId = attachRes.sessionId;

    // Enable domains
    await sendSession('Page.enable');
    await sendSession('Runtime.enable');
    await sendSession('Network.enable');

    const extraHeaders = parseHeadersOption(options.headers);
    if (Object.keys(extraHeaders).length > 0) {
      await sendSession('Network.setExtraHTTPHeaders', { headers: extraHeaders });
      log(`▶ Applied ${Object.keys(extraHeaders).length} custom HTTP header(s)`);
    }

    const cookiesToSet = loadCookiesOption(options.cookies, targetUrl);
    if (cookiesToSet.length > 0) {
      await sendSession('Network.setCookies', { cookies: cookiesToSet });
      log(`▶ Injected ${cookiesToSet.length} session cookie(s)`);
    }

    await sendSession('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });

    log(`▶ Navigating to ${targetUrl}...`);
    await sendSession('Page.navigate', { url: targetUrl });

    if (options.interactiveLogin) {
      log(`🔐 Interactive login mode: complete authentication in the Chrome window, then press [Enter] here to capture...`);
      await new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.once('data', () => {
          process.stdin.pause();
          resolve();
        });
      });
    }

    // Wait for network idle rather than blind sleep
    await waitForNetworkIdle(waitMs, 500);

    // Scroll smoothly to trigger lazy elements if requested
    if (doScroll) {
      log(`▶ Triggering lazy-load elements via viewport scroll...`);
      await sendSession('Runtime.evaluate', {
        expression: `
          new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 450;
            const fallback = setTimeout(() => { clearInterval(timer); resolve(); }, 15000);
            const timer = setInterval(() => {
              try {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (!document.body || totalHeight >= Math.min(document.body.scrollHeight, 18000)) {
                  clearInterval(timer);
                  clearTimeout(fallback);
                  window.scrollTo(0, 0);
                  resolve();
                }
              } catch {
                clearInterval(timer);
                clearTimeout(fallback);
                resolve();
              }
            }, 120);
          })
        `,
        awaitPromise: true
      });
      await waitForNetworkIdle(1500, 400);
    }

    // Await bounded queue drain
    log(`▶ Finalizing in-flight stream downloads (${totalQueued} assets queued)...`);
    await waitForQueueDrain(15000);

    // Freeze lazy attributes/canvases and gather compact manifest metadata in one browser call
    log(`▶ Freezing dynamic media & extracting hydrated DOM...`);
    const prepResult = await sendSession('Runtime.evaluate', {
      expression: `(() => {
        try {
          document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach(el => {
            el.setAttribute('loading', 'eager');
          });
          document.querySelectorAll('img, source').forEach(el => {
            const curSrc = el.getAttribute('src') || '';
            const dataSrc = el.getAttribute('data-src');
            if (dataSrc && (!curSrc || curSrc.startsWith('data:image/gif') || curSrc.startsWith('data:image/svg'))) {
              el.setAttribute('src', dataSrc);
            }
            const curSrcset = el.getAttribute('srcset') || '';
            const dataSrcset = el.getAttribute('data-srcset');
            if (dataSrcset && !curSrcset) {
              el.setAttribute('srcset', dataSrcset);
            }
          });
          document.querySelectorAll('canvas').forEach(canvas => {
            try {
              if (canvas.width > 0 && canvas.height > 0) {
                const dataUrl = canvas.toDataURL('image/png');
                if (dataUrl && dataUrl.length < 200000) {
                  canvas.style.backgroundImage = 'url(' + dataUrl + ')';
                  canvas.style.backgroundSize = 'contain';
                  canvas.style.backgroundRepeat = 'no-repeat';
                }
              }
            } catch {}
          });

          const fonts = new Set();
          const colors = new Set();
          document.querySelectorAll('body, h1, h2, h3, p, a, header').forEach(el => {
            const st = getComputedStyle(el);
            if (st.fontFamily && fonts.size < 10) fonts.add(st.fontFamily);
            if (st.color && colors.size < 12) colors.add(st.color);
            if (st.backgroundColor && st.backgroundColor !== 'rgba(0, 0, 0, 0)' && colors.size < 12) {
              colors.add(st.backgroundColor);
            }
          });

          const cssVariables = {};
          const rootStyle = getComputedStyle(document.documentElement);
          for (let i = 0; i < rootStyle.length && Object.keys(cssVariables).length < 30; i++) {
            const prop = rootStyle[i];
            if (prop && prop.startsWith('--')) {
              const val = rootStyle.getPropertyValue(prop).trim();
              if (val && val.length <= 80) cssVariables[prop] = val;
            }
          }

          const landmarks = [];
          document.querySelectorAll('header, nav, main, section, footer').forEach(el => {
            if (landmarks.length >= 15) return;
            const headings = Array.from(el.querySelectorAll('h1, h2, h3'))
              .slice(0, 3)
              .map(h => (h.textContent || '').trim().slice(0, 80))
              .filter(Boolean);
            landmarks.push({
              tag: el.tagName.toLowerCase(),
              id: el.id || undefined,
              classes: typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0, 4).join(' ') || undefined : undefined,
              headings: headings.length ? headings : undefined
            });
          });

          const metaDesc = document.querySelector('meta[name="description"]');
          return {
            html: document.documentElement.outerHTML,
            page: {
              title: document.title || '',
              description: metaDesc ? (metaDesc.getAttribute('content') || '').slice(0, 200) : '',
              lang: document.documentElement.lang || '',
              fonts: Array.from(fonts),
              colors: Array.from(colors),
              cssVariables,
              landmarks
            }
          };
        } catch (err) {
          return { html: document.documentElement ? document.documentElement.outerHTML : '', page: {} };
        }
      })()`,
      returnByValue: true
    });

    const extracted = prepResult?.result?.value || {};
    if (extracted.html) {
      let html = extracted.html;
      if (!html.trim().toLowerCase().startsWith('<!doctype')) {
        html = '<!DOCTYPE html>\n' + html;
      }
      html = rewriteExternalAssetUrls(html, capturedExternalHosts);
      const htmlPath = path.join(outputDir, 'index.html');
      await fs.promises.writeFile(htmlPath, html, 'utf-8');
      domBytes = Buffer.byteLength(html, 'utf-8');
      log(`  ✓ Saved hydrated DOM to index.html (${domBytes.toLocaleString()} bytes)`);
    }

    // Rewrite external CDN references in downloaded CSS files
    if (capturedExternalHosts.size > 0 && cssDiskPaths.size > 0) {
      for (const cssPath of cssDiskPaths) {
        try {
          const cssText = await fs.promises.readFile(cssPath, 'utf-8');
          const rewritten = rewriteExternalAssetUrls(cssText, capturedExternalHosts);
          if (rewritten !== cssText) {
            await fs.promises.writeFile(cssPath, rewritten, 'utf-8');
          }
        } catch {}
      }
    }

    // Capture screenshot + live baseline for visual diffing
    log(`▶ Capturing high-resolution viewport screenshot...`);
    const screenshot = await sendSession('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    });

    const screenshotPath = path.join(outputDir, 'screenshot.png');
    const baselinePath = path.join(outputDir, 'baseline-desktop.png');
    const shotBuf = Buffer.from(screenshot.data, 'base64');
    await fs.promises.writeFile(screenshotPath, shotBuf);
    await fs.promises.writeFile(baselinePath, shotBuf);
    screenshotBytes = shotBuf.length;
    log(`  ✓ Saved screenshot to screenshot.png (${screenshotBytes.toLocaleString()} bytes)`);

    // Optional REA live bundle analysis before crawling / closing Chrome
    let reaSummary = null;
    if (options.rea && !aborted) {
      try {
        await send('Target.detachFromTarget', { sessionId: activeSessionId });
      } catch {}

      log(`▶ Running REA static bundle & endpoint analysis...`);
      try {
        reaSummary = await runReaWebBundle(`http://127.0.0.1:${port}`, targetId, outputDir, {
          fetchSourceMaps: Boolean(options.fetchSourceMaps),
          timeoutMs: 30000
        });
        log(`  ✓ REA analyzed ${reaSummary.scriptsAnalyzed} script(s): ${reaSummary.routes.length} routes, ${reaSummary.endpoints.length} endpoints`);
      } catch (reaErr) {
        log(`  ⚠️ REA bundle analysis skipped: ${reaErr.message}`);
      }

      if (options.crawl && !aborted) {
        try {
          const reattachRes = await send('Target.attachToTarget', { targetId, flatten: true });
          activeSessionId = reattachRes.sessionId;
          await sendSession('Page.enable');
          await sendSession('Runtime.enable');
          await sendSession('Network.enable');
        } catch {}
      } else {
        try {
          if (ws) {
            ws.close();
            ws = null;
          }
        } catch {}
      }
    }

    // Optional multi-route SPA crawl within the same CDP session (DOM links + REA routes)
    const crawledRoutes = [];
    if (options.crawl && !aborted) {
      const maxRoutes = Math.max(1, Math.min(50, parseInt(options.maxRoutes || '10', 10)));
      const origin = new URL(targetUrl).origin;
      const linkRes = await sendSession('Runtime.evaluate', {
        expression: `(() => {
          const out = [];
          const seen = new Set();
          for (const a of document.querySelectorAll('a[href]')) {
            try {
              const u = new URL(a.getAttribute('href'), window.location.href);
              if (u.origin === ${JSON.stringify(origin)} && u.pathname !== window.location.pathname) {
                const p = u.pathname.replace(/\\/+$/, '') || '/';
                if (!seen.has(p) && !p.match(/\\.(png|jpg|jpeg|gif|svg|pdf|zip|css|js)$/i)) {
                  seen.add(p);
                  out.push(p);
                }
              }
            } catch {}
          }
          return out;
        })()`,
        returnByValue: true
      });

      const mergedSet = new Set(linkRes?.result?.value || []);
      for (const r of (reaSummary?.routes || [])) {
        if (typeof r === 'string' && r.startsWith('/') && !r.includes(':') && !r.includes('[') && !r.includes('*')) {
          const clean = r.replace(/\/+$/, '') || '/';
          if (clean !== '/') mergedSet.add(clean);
        }
      }

      const discoveredRoutes = [...mergedSet].slice(0, maxRoutes);
      if (discoveredRoutes.length > 0) {
        log(`▶ Crawling ${discoveredRoutes.length} internal route(s)...`);
      }
      for (const routePath of discoveredRoutes) {
        if (aborted) break;
        const routeUrl = `${origin}${routePath}`;
        try {
          log(`  ↪ Navigating route: ${routePath}`);
          await sendSession('Page.navigate', { url: routeUrl });
          await waitForNetworkIdle(Math.min(waitMs, 2500), 400);
          await waitForQueueDrain(8000);
          const routeDomRes = await sendSession('Runtime.evaluate', {
            expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
            returnByValue: true
          });
          let routeHtml = routeDomRes?.result?.value || '';
          if (routeHtml) {
            if (!routeHtml.trim().toLowerCase().startsWith('<!doctype')) {
              routeHtml = '<!DOCTYPE html>\n' + routeHtml;
            }
            routeHtml = rewriteExternalAssetUrls(routeHtml, capturedExternalHosts);
            const cleanSegs = routePath.replace(/^\/+|\/+$/g, '');
            const routeFile = cleanSegs
              ? path.join(outputDir, cleanSegs, 'index.html')
              : path.join(outputDir, 'index.html');
            await ensureDir(path.dirname(routeFile));
            await fs.promises.writeFile(routeFile, routeHtml, 'utf-8');
            crawledRoutes.push(routePath);
          }
        } catch {
          // Continue crawling remaining routes
        }
      }
    }

    // Persist recorded API / JSON fixtures for deterministic offline replay
    const fixtureCount = Object.keys(recordedFixtures).length;
    if (fixtureCount > 0) {
      const mocksDir = path.join(outputDir, 'mocks');
      await ensureDir(mocksDir);
      await fs.promises.writeFile(
        path.join(mocksDir, 'fixtures.json'),
        JSON.stringify(recordedFixtures, null, 2),
        'utf-8'
      );
      log(`  ✓ Recorded ${fixtureCount} API fixture key(s) to mocks/fixtures.json`);
    }

    // Scaffold standalone clone server and manifests
    scaffoldCloneManifests(targetUrl, outputDir, targetPort);

    // Emit compact clone-manifest.json for token-efficient AI inspection
    const manifest = {
      url: targetUrl,
      capturedAt: new Date().toISOString(),
      domBytes,
      screenshotBytes,
      assetCount,
      skippedTrackers,
      totalBytes,
      fixtureCount,
      crawledRoutes,
      externalHosts: [...capturedExternalHosts],
      mimeBreakdown,
      page: extracted.page || {},
      ...(reaSummary ? { rea: reaSummary } : {})
    };
    await fs.promises.writeFile(
      path.join(outputDir, 'clone-manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );

    log(`\n=======================================================`);
    log(`🎉 In-Flight Stream Capture Complete!`);
    log(`📊 Intercepted Assets: ${assetCount} (${(totalBytes / 1024).toFixed(1)} KB) | Skipped Trackers: ${skippedTrackers}`);
    log(`📁 Saved in: ${outputDir}`);
    log(`=======================================================\n`);

    return {
      domBytes,
      screenshotBytes,
      assetCount,
      skippedTrackers,
      totalBytes,
      fixtureCount,
      crawledRoutes,
      externalHosts: [...capturedExternalHosts],
      ...(reaSummary ? { rea: reaSummary } : {})
    };
  };

  try {
    const capturePromise = runCapture();
    capturePromise.catch(() => {});

    const timeoutPromise = new Promise((_, reject) => {
      overallTimer = setTimeout(() => {
        aborted = true;
        reject(new Error(`CDP Capture timed out after ${timeoutMs}ms for ${targetUrl}`));
      }, timeoutMs);
    });

    return await Promise.race([capturePromise, timeoutPromise]);
  } catch (err) {
    if (!options.quiet && !options.json) {
      console.error(`❌ CDP Capture Error: ${err.message}`);
    }
    throw err;
  } finally {
    aborted = true;
    clearTimeout(overallTimer);
    for (const [id, entry] of pendingRequests.entries()) {
      clearTimeout(entry.timer);
      pendingRequests.delete(id);
    }
    if (ws) {
      try { ws.close(); } catch {}
    }
    try { chrome.kill(); } catch {}
  }
}

/**
 * Scaffolds an autonomous hybrid server.js, package.json and README.md
 * inside the clone directory so it can be launched immediately.
 */
export function scaffoldCloneManifests(targetUrl, outputDir, port = 3000) {
  const origin = new URL(targetUrl).origin;
  const rawSlug = path.basename(outputDir);
  const safeName = rawSlug.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '') || 'cloned-site';

  const templatePath = path.resolve(__dirname, '..', 'server', 'proxy_server.template.js');
  let serverCode = '';
  if (fs.existsSync(templatePath)) {
    const tpl = fs.readFileSync(templatePath, 'utf8');
    serverCode = tpl.replace(/\{\{PORT\}\}/g, String(port)).replace(/\{\{UPSTREAM\}\}/g, origin);
  } else {
    serverCode = `const http = require('http');
const fs = require('fs');
const path = require('path');
const server = http.createServer((req, res) => {
  let p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  let file = path.join(__dirname, p);
  if (fs.existsSync(file)) fs.createReadStream(file).pipe(res);
  else { res.writeHead(404); res.end('Not Found'); }
});
server.listen(${port}, () => console.log('Listening on http://localhost:${port}'));
`;
  }

  fs.writeFileSync(path.join(outputDir, 'server.js'), serverCode, 'utf8');

  const packageJson = {
    name: safeName,
    version: '1.0.0',
    description: `High-fidelity 1:1 clone of ${targetUrl} captured via Mimic In-Flight Engine.`,
    main: 'server.js',
    scripts: {
      start: 'node server.js',
      dev: 'node server.js'
    },
    keywords: ['mimic', 'clone', 'replica'],
    author: 'Antigravity Mimic',
    license: 'MIT'
  };

  fs.writeFileSync(path.join(outputDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');

  const readmeMd = `# ${safeName} — 1:1 In-Flight Clone

Autonomous 1:1 reproduction of [${targetUrl}](${targetUrl}) captured with **Mimic In-Flight Stream Engine**.

## 🚀 Quick Launch

\`\`\`bash
cd "${outputDir}"
npm start
\`\`\`

Available locally at: **[http://localhost:${port}](http://localhost:${port})**

## 🛡️ Autonomous Fallback Proxy
- All assets intercepted during Chrome runtime streaming are served statically from disk.
- Any dynamic misses or upstream requests are fetched on demand from \`${origin}\` (or \`/external/<host>/\`), served with CORS headers, and cached permanently on disk.
`;

  fs.writeFileSync(path.join(outputDir, 'README.md'), readmeMd, 'utf8');
}

// CLI invoker
if (process.argv[1] && process.argv[1].endsWith('cdp_capture.mjs')) {
  const rawArgs = process.argv.slice(2);
  const positional = [];
  const flags = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = rawArgs[i + 1];
      if (next && !next.startsWith('--')) {
        flags[k] = next;
        i++;
      } else {
        flags[k] = true;
      }
    } else {
      positional.push(a);
    }
  }

  const urlArg = positional[0];
  const outArg = positional[1] || './clones/captured-site';
  const portArg = parseInt(flags.port || positional[2] || '3000', 10);
  if (!urlArg) {
    console.log('Usage: node cdp_capture.mjs <url> [outputDir] [port] [--quiet] [--json] [--no-scroll] [--timeout 60000] [--rea] [--fetch-source-maps] [--crawl] [--max-routes 10] [--cookies <file|str>] [--header "K: V"]');
    process.exit(1);
  }

  captureRuntime(urlArg, path.resolve(outArg), {
    targetPort: portArg,
    quiet: Boolean(flags.quiet),
    json: Boolean(flags.json),
    scroll: flags['no-scroll'] ? false : true,
    timeout: flags.timeout ? parseInt(flags.timeout, 10) : undefined,
    rea: Boolean(flags.rea),
    fetchSourceMaps: Boolean(flags['fetch-source-maps']),
    crawl: Boolean(flags.crawl),
    maxRoutes: flags['max-routes'] ? parseInt(flags['max-routes'], 10) : undefined,
    cookies: flags.cookies,
    headers: flags.header,
    interactiveLogin: Boolean(flags['interactive-login'])
  })
    .then((res) => {
      if (flags.json) console.log(JSON.stringify(res));
    })
    .catch((err) => {
      if (flags.json) console.log(JSON.stringify({ error: err.message }));
      process.exit(1);
    });
}
