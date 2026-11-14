/**
 * Webstack Chrome DevTools Protocol (CDP) In-Flight Stream Capture Engine
 * Captures fully hydrated client-side SPAs, streams network assets in-flight directly
 * from browser memory to disk, and takes high-resolution viewport screenshots.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mapUrlToFilePath } from './url_mapper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MAX_CONCURRENCY = 10;
const COMMAND_TIMEOUT_MS = 15000;

export async function captureRuntime(targetUrl, outputDir, options = {}) {
  const width = options.width || 1440;
  const height = options.height || 900;
  const waitMs = options.waitMs || 3500;
  const port = options.port || (9222 + Math.floor(Math.random() * 400));
  const doScroll = options.scroll !== false;
  const targetPort = options.targetPort || 3000;
  const timeoutMs = options.timeout || 60000;

  console.log(`\n=======================================================`);
  console.log(`🤖 [Mimic CDP In-Flight Engine] Navigating: ${targetUrl}`);
  console.log(`📁 Destination: ${outputDir}`);
  console.log(`🔌 Chrome Debug Port: ${port}`);
  console.log(`=======================================================\n`);

  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error(`Chrome executable not found at: ${CHROME_PATH}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const chrome = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-gpu',
    'about:blank'
  ]);

  let ws;
  let overallTimer;
  let aborted = false;
  const pendingRequests = new Map();

  const runCapture = async () => {
    let assetCount = 0;
    let totalBytes = 0;
    let domBytes = 0;
    let screenshotBytes = 0;

    await new Promise(r => setTimeout(r, 1500));
    if (aborted) return;

    const versionResp = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (aborted) return;
    const versionData = await versionResp.json();
    ws = new WebSocket(versionData.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    if (aborted) return;

    let msgId = 1;
    let activeSessionId = null;
    const pendingResponses = new Map();
    const taskQueue = [];
    let activeWorkers = 0;
    let totalQueued = 0;
    let drainResolvers = [];

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

      if (data.method === 'Network.responseReceived') {
        const { requestId, response } = data.params;
        if (response && (response.status === 200 || response.status === 206)) {
          const assetUrl = response.url;
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
      } else if (data.method === 'Network.loadingFinished') {
        const { requestId } = data.params;
        const info = pendingResponses.get(requestId);
        if (info) {
          pendingResponses.delete(requestId);
          totalQueued++;
          taskQueue.push(async () => {
            try {
              const bodyRes = await sendSession('Network.getResponseBody', { requestId });
              if (bodyRes && typeof bodyRes.body === 'string') {
                const mapped = mapUrlToFilePath(info.url, targetUrl, outputDir, info.mimeType);
                if (mapped && mapped.diskPath) {
                  const buf = bodyRes.base64Encoded
                    ? Buffer.from(bodyRes.body, 'base64')
                    : Buffer.from(bodyRes.body, 'utf-8');
                  fs.mkdirSync(path.dirname(mapped.diskPath), { recursive: true });
                  fs.writeFileSync(mapped.diskPath, buf);
                  assetCount++;
                  totalBytes += buf.length;
                  const rel = path.relative(outputDir, mapped.diskPath);
                  if (assetCount <= 15 || assetCount % 20 === 0) {
                    console.log(`  ✓ [In-Flight Stream] ${info.mimeType} -> ${rel} (${buf.length.toLocaleString()} B)`);
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

    await sendSession('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });

    console.log(`▶ Navigating to ${targetUrl}...`);
    await sendSession('Page.navigate', { url: targetUrl });

    // Wait for initial load
    await new Promise(r => setTimeout(r, waitMs));

    // Scroll smoothly to trigger lazy elements if requested
    if (doScroll) {
      console.log(`▶ Triggering lazy-load elements via viewport scroll...`);
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
      await new Promise(r => setTimeout(r, 1500));
    }

    // Await bounded queue drain
    console.log(`▶ Finalizing in-flight stream downloads (${totalQueued} assets queued)...`);
    await waitForQueueDrain(15000);

    // Extract hydrated HTML and preserve DOCTYPE to avoid Quirks Mode
    console.log(`▶ Extracting hydrated DOM...`);
    const domResult = await sendSession('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true
    });

    if (domResult && domResult.result && domResult.result.value) {
      let html = domResult.result.value;
      if (!html.trim().toLowerCase().startsWith('<!doctype')) {
        html = '<!DOCTYPE html>\n' + html;
      }
      const htmlPath = path.join(outputDir, 'index.html');
      fs.writeFileSync(htmlPath, html, 'utf-8');
      domBytes = Buffer.byteLength(html, 'utf-8');
      console.log(`  ✓ Saved hydrated DOM to index.html (${domBytes.toLocaleString()} bytes)`);
    }

    // Capture screenshot
    console.log(`▶ Capturing high-resolution viewport screenshot...`);
    const screenshot = await sendSession('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    });

    const screenshotPath = path.join(outputDir, 'screenshot.png');
    const shotBuf = Buffer.from(screenshot.data, 'base64');
    fs.writeFileSync(screenshotPath, shotBuf);
    screenshotBytes = shotBuf.length;
    console.log(`  ✓ Saved screenshot to screenshot.png (${screenshotBytes.toLocaleString()} bytes)`);

    // Scaffold standalone clone server and manifests
    scaffoldCloneManifests(targetUrl, outputDir, targetPort);

    console.log(`\n=======================================================`);
    console.log(`🎉 In-Flight Stream Capture Complete!`);
    console.log(`📊 Intercepted Assets: ${assetCount} (${(totalBytes / 1024).toFixed(1)} KB)`);
    console.log(`📁 Saved in: ${outputDir}`);
    console.log(`=======================================================\n`);

    return {
      domBytes,
      screenshotBytes,
      assetCount,
      totalBytes
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
    console.error(`❌ CDP Capture Error: ${err.message}`);
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
  const slug = path.basename(outputDir);

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
    name: slug,
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

  const readmeMd = `# ${slug} — 1:1 In-Flight Clone

Autonomous 1:1 reproduction of [${targetUrl}](${targetUrl}) captured with **Mimic In-Flight Stream Engine**.

## 🚀 Quick Launch

\`\`\`bash
cd "${outputDir}"
npm start
\`\`\`

Available locally at: **[http://localhost:${port}](http://localhost:${port})**

## 🛡️ Autonomous Fallback Proxy
- All assets intercepted during Chrome runtime streaming are served statically from disk.
- Any dynamic misses or upstream requests are fetched on demand from \`${origin}\`, served with CORS headers, and cached permanently on disk.
`;

  fs.writeFileSync(path.join(outputDir, 'README.md'), readmeMd, 'utf8');
}

// CLI invoker
if (process.argv[1] && process.argv[1].endsWith('cdp_capture.mjs')) {
  const urlArg = process.argv[2];
  const outArg = process.argv[3] || './clones/captured-site';
  const portArg = parseInt(process.argv[4] || '3000', 10);
  if (!urlArg) {
    console.log('Usage: node cdp_capture.mjs <url> [outputDir] [port]');
    process.exit(1);
  }
  captureRuntime(urlArg, path.resolve(outArg), { targetPort: portArg });
}
