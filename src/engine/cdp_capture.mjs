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

export async function captureRuntime(targetUrl, outputDir, options = {}) {
  const width = options.width || 1440;
  const height = options.height || 900;
  const waitMs = options.waitMs || 3500;
  const port = options.port || (9222 + Math.floor(Math.random() * 400));
  const doScroll = options.scroll !== false;
  const targetPort = options.targetPort || 3000;

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

  await new Promise(r => setTimeout(r, 1500));

  let ws;
  let assetCount = 0;
  let totalBytes = 0;
  let domBytes = 0;
  let screenshotBytes = 0;

  try {
    const versionResp = await fetch(`http://127.0.0.1:${port}/json/version`);
    const versionData = await versionResp.json();
    ws = new WebSocket(versionData.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    function send(method, params = {}) {
      return new Promise((resolve) => {
        const id = msgId++;
        const handler = (event) => {
          const data = JSON.parse(event.data);
          if (data.id === id) {
            ws.removeEventListener('message', handler);
            resolve(data.result);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

    function sendSession(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        const handler = (event) => {
          const data = JSON.parse(event.data);
          if (data.id === id) {
            ws.removeEventListener('message', handler);
            if (data.error) {
              reject(new Error(data.error.message || 'CDP Error'));
            } else {
              resolve(data.result);
            }
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, sessionId, method, params }));
      });
    }

    // Set up in-flight asset capture listeners
    const pendingResponses = new Map();
    const downloadQueue = [];

    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.sessionId !== sessionId) return;

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
        } else if (data.method === 'Network.loadingFinished') {
          const { requestId } = data.params;
          const info = pendingResponses.get(requestId);
          if (info) {
            pendingResponses.delete(requestId);
            const task = (async () => {
              try {
                const bodyRes = await sendSession('Network.getResponseBody', { requestId });
                if (bodyRes && bodyRes.body) {
                  const mapped = mapUrlToFilePath(info.url, targetUrl, outputDir);
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
            })();
            downloadQueue.push(task);
          }
        }
      } catch {}
    });

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
            const timer = setInterval(() => {
              window.scrollBy(0, distance);
              totalHeight += distance;
              if (totalHeight >= Math.min(document.body.scrollHeight, 18000)) {
                clearInterval(timer);
                window.scrollTo(0, 0);
                resolve();
              }
            }, 120);
          })
        `,
        awaitPromise: true
      });
      await new Promise(r => setTimeout(r, 1500));
    }

    // Await all queued in-flight downloads with a timeout
    console.log(`▶ Finalizing in-flight stream downloads (${downloadQueue.length} assets queued)...`);
    await Promise.allSettled(downloadQueue);

    // Extract hydrated HTML
    console.log(`▶ Extracting hydrated DOM...`);
    const domResult = await sendSession('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true
    });

    if (domResult && domResult.result && domResult.result.value) {
      const htmlPath = path.join(outputDir, 'index.html');
      fs.writeFileSync(htmlPath, domResult.result.value, 'utf-8');
      domBytes = domResult.result.value.length;
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
  } catch (err) {
    console.error(`❌ CDP Capture Error: ${err.message}`);
    throw err;
  } finally {
    if (ws) ws.close();
    chrome.kill();
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
