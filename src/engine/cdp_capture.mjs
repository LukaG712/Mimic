/**
 * Webstack Chrome DevTools Protocol (CDP) Runtime Capture Engine
 * Captures fully hydrated client-side SPAs, dynamic network waterfalls, and screenshots.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export async function captureRuntime(targetUrl, outputDir, options = {}) {
  const width = options.width || 1440;
  const height = options.height || 900;
  const waitMs = options.waitMs || 4000;
  const port = options.port || 9222;

  console.log(`\n=======================================================`);
  console.log(`🤖 [CDP Capture] Launching headless browser for ${targetUrl}`);
  console.log(`📁 Target Directory: ${outputDir}`);
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
        ws.send(JSON.stringify({ id, sessionId, method, params }));
      });
    }

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

    // Scroll smoothly to trigger lazy elements
    console.log(`▶ Triggering lazy-load elements via viewport scroll...`);
    await sendSession('Runtime.evaluate', {
      expression: `
        new Promise((resolve) => {
          let totalHeight = 0;
          const distance = 400;
          const timer = setInterval(() => {
            window.scrollBy(0, distance);
            totalHeight += distance;
            if (totalHeight >= document.body.scrollHeight) {
              clearInterval(timer);
              window.scrollTo(0, 0);
              resolve();
            }
          }, 150);
        })
      `,
      awaitPromise: true
    });

    await new Promise(r => setTimeout(r, 1500));

    // Extract hydrated HTML
    console.log(`▶ Extracting hydrated DOM...`);
    const domResult = await sendSession('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true
    });

    if (domResult && domResult.result && domResult.result.value) {
      const htmlPath = path.join(outputDir, 'index.html');
      fs.writeFileSync(htmlPath, domResult.result.value, 'utf-8');
      console.log(`  ✓ Saved hydrated DOM to index.html (${domResult.result.value.length.toLocaleString()} bytes)`);
    }

    // Capture screenshot
    console.log(`▶ Capturing high-resolution viewport screenshot...`);
    const screenshot = await sendSession('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    });

    const screenshotPath = path.join(outputDir, 'screenshot.png');
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    console.log(`  ✓ Saved screenshot to screenshot.png`);

    console.log(`\n🎉 CDP Runtime Capture Complete!\n`);
  } catch (err) {
    console.error(`❌ CDP Capture Error: ${err.message}`);
    throw err;
  } finally {
    if (ws) ws.close();
    chrome.kill();
  }
}

// CLI invoker
if (process.argv[1] && process.argv[1].endsWith('cdp_capture.mjs')) {
  const urlArg = process.argv[2];
  const outArg = process.argv[3] || './clones/captured-site';
  if (!urlArg) {
    console.log('Usage: node cdp_capture.mjs <url> [outputDir]');
    process.exit(1);
  }
  captureRuntime(urlArg, path.resolve(outArg));
}
