/**
 * Mimic Quality & Visual Verifier Engine
 * Audits console errors, HTTP 4xx/5xx failures, broken images, horizontal overflow,
 * captures multi-viewport screenshots, and emits a deduplicated audit-report.json.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { waitForChromeReady } from './cdp_capture.mjs';
import { findChromePath, getChromeLaunchArgs } from './chrome_finder.mjs';
import { comparePngFiles } from './png_diff.mjs';

const COMMAND_TIMEOUT_MS = 15000;

function formatDeduplicatedMap(map) {
  const out = [];
  for (const [key, count] of map.entries()) {
    out.push(count > 1 ? `${key} (×${count})` : key);
  }
  return out;
}

export async function verifyClone(localUrl, outputDir = '.', options = {}) {
  const port = options.port || (9300 + Math.floor(Math.random() * 400));
  const timeoutMs = options.timeout || 45000;
  const log = (...args) => {
    if (!options.quiet && !options.json) console.log(...args);
  };
  const logErr = (...args) => {
    if (!options.quiet && !options.json) console.error(...args);
  };

  log(`\n=======================================================`);
  log(`🔍 [Mimic Verifier] Auditing: ${localUrl}`);
  log(`🔌 Chrome Debug Port: ${port}`);
  log(`=======================================================\n`);

  const chromePath = findChromePath();
  fs.mkdirSync(outputDir, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-verify-chrome-'));

  let chromeStderr = '';
  let chromeExitMessage = null;
  const chrome = spawn(
    chromePath,
    getChromeLaunchArgs(port, { userDataDir }),
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  chrome.stderr?.on('data', (chunk) => {
    if (chromeStderr.length < 2048) {
      chromeStderr += chunk.toString('utf8');
    }
  });
  chrome.on('exit', (code, signal) => {
    if (!aborted) {
      const detail = chromeStderr.trim() ? `: ${chromeStderr.trim().slice(0, 500)}` : '';
      chromeExitMessage = `Chrome exited prematurely (code=${code}, signal=${signal})${detail}`;
    }
  });

  let ws;
  let overallTimer;
  let aborted = false;
  const pendingRequests = new Map();

  const runVerify = async () => {
    const consoleErrorCounts = new Map();
    const networkErrorCounts = new Map();
    const inflightRequests = new Set();
    let lastNetworkActivity = Date.now();

    const versionData = await waitForChromeReady(port, 15000, () => aborted, () => chromeExitMessage);
    if (aborted || !versionData) return;

    ws = new WebSocket(versionData.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    if (aborted) return;

    let msgId = 1;
    let activeSessionId = null;

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

    async function waitForNetworkIdle(maxWaitMs = 3000, idleWindowMs = 500) {
      const start = Date.now();
      await new Promise(r => setTimeout(r, Math.min(250, maxWaitMs)));
      while (!aborted && Date.now() - start < maxWaitMs) {
        if (inflightRequests.size === 0 && Date.now() - lastNetworkActivity >= idleWindowMs) {
          return;
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }

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
        inflightRequests.add(data.params.requestId);
        lastNetworkActivity = Date.now();
      } else if (data.method === 'Network.loadingFinished' || data.method === 'Network.loadingFailed') {
        inflightRequests.delete(data.params.requestId);
        lastNetworkActivity = Date.now();
      } else if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
        const msg = (data.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').trim() || 'Console error';
        const prev = consoleErrorCounts.get(msg) || 0;
        consoleErrorCounts.set(msg, prev + 1);
        if (prev === 0) logErr(`  ⚠️ [Browser Console Error]: ${msg}`);
      } else if (data.method === 'Runtime.exceptionThrown') {
        const ex = data.params.exceptionDetails?.text || 'Unhandled exception';
        const prev = consoleErrorCounts.get(ex) || 0;
        consoleErrorCounts.set(ex, prev + 1);
        if (prev === 0) logErr(`  ⚠️ [Browser Exception]: ${ex}`);
      } else if (data.method === 'Network.responseReceived' && data.params.response?.status >= 400) {
        const entry = `HTTP ${data.params.response.status}: ${data.params.response.url}`;
        const prev = networkErrorCounts.get(entry) || 0;
        networkErrorCounts.set(entry, prev + 1);
        if (prev === 0) logErr(`  ⚠️ [${entry}]`);
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

    await sendSession('Page.enable');
    await sendSession('Runtime.enable');
    await sendSession('Network.enable');

    async function inspectLayoutHealth() {
      const res = await sendSession('Runtime.evaluate', {
        expression: `(() => {
          const imgs = Array.from(document.querySelectorAll('img'));
          const brokenImages = imgs.filter(img => img.getAttribute('src') && (!img.complete || img.naturalWidth === 0)).length;
          const brokenVideos = Array.from(document.querySelectorAll('video')).filter(v => Boolean(v.error)).length;
          const brokenFonts = document.fonts
            ? Array.from(document.fonts).filter(f => f.status === 'error').length
            : 0;
          const brokenSvgUses = Array.from(document.querySelectorAll('svg use')).filter(u => {
            const href = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
            if (!href.startsWith('#')) return false;
            return !document.getElementById(href.slice(1));
          }).length;
          const horizontalOverflow = document.documentElement.scrollWidth > window.innerWidth;
          return { brokenImages, brokenVideos, brokenFonts, brokenSvgUses, horizontalOverflow };
        })()`,
        returnByValue: true
      });
      return res?.result?.value || {
        brokenImages: 0,
        brokenVideos: 0,
        brokenFonts: 0,
        brokenSvgUses: 0,
        horizontalOverflow: false
      };
    }

    // 1. Desktop Audit (1440x900)
    await sendSession('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    log(`▶ Loading desktop viewport (1440x900)...`);
    await sendSession('Page.navigate', { url: localUrl });
    await waitForNetworkIdle(3000, 500);

    const desktopHealth = await inspectLayoutHealth();
    const desktopShot = await sendSession('Page.captureScreenshot', { format: 'png' });
    const desktopPath = path.join(outputDir, 'screenshot.png');
    await fs.promises.writeFile(desktopPath, Buffer.from(desktopShot.data, 'base64'));
    log(`  ✓ Desktop screenshot saved: ${desktopPath}`);

    // Optional visual diff against live capture baseline
    let visualDiff = null;
    const baselinePath = path.join(outputDir, 'baseline-desktop.png');
    if (fs.existsSync(baselinePath)) {
      try {
        visualDiff = comparePngFiles(baselinePath, desktopPath, {
          diffOutputPath: path.join(outputDir, 'diff-desktop.png')
        });
        log(`  ✓ Visual diff vs baseline: ${visualDiff.diffPercent}% (${visualDiff.mismatchedPixels} px)`);
      } catch (diffErr) {
        log(`  ⚠️ Visual diff skipped: ${diffErr.message}`);
      }
    }

    // 2. Mobile Audit (390x844 iPhone)
    await sendSession('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });

    log(`▶ Loading mobile viewport (390x844)...`);
    await waitForNetworkIdle(1200, 350);

    const mobileHealth = await inspectLayoutHealth();
    const mobileShot = await sendSession('Page.captureScreenshot', { format: 'png' });
    const mobilePath = path.join(outputDir, 'screenshot_mobile.png');
    await fs.promises.writeFile(mobilePath, Buffer.from(mobileShot.data, 'base64'));
    log(`  ✓ Mobile screenshot saved: ${mobilePath}`);

    const consoleErrors = formatDeduplicatedMap(consoleErrorCounts);
    const networkErrors = formatDeduplicatedMap(networkErrorCounts);
    const passed =
      consoleErrors.length === 0 &&
      networkErrors.length === 0 &&
      desktopHealth.brokenImages === 0 &&
      mobileHealth.brokenImages === 0 &&
      desktopHealth.brokenFonts === 0 &&
      mobileHealth.brokenFonts === 0;

    const report = {
      url: localUrl,
      auditedAt: new Date().toISOString(),
      passed,
      consoleErrors,
      networkErrors,
      desktop: desktopHealth,
      mobile: mobileHealth,
      ...(visualDiff ? { visualDiff } : {})
    };

    await fs.promises.writeFile(
      path.join(outputDir, 'audit-report.json'),
      JSON.stringify(report, null, 2),
      'utf-8'
    );

    log(`\n=======================================================`);
    log(`📊 Audit Results:`);
    log(`   Console Errors:      ${consoleErrors.length}`);
    log(`   HTTP 4xx/5xx:        ${networkErrors.length}`);
    log(`   Broken Images (D/M): ${desktopHealth.brokenImages} / ${mobileHealth.brokenImages}`);
    log(`   Overflow (D/M):      ${desktopHealth.horizontalOverflow} / ${mobileHealth.horizontalOverflow}`);
    if (passed) {
      log(`   Status:              ✅ 100% HEALTHY / ZERO CRITICAL ISSUES`);
    } else {
      log(`   Status:              ⚠️ Issues Detected (see audit-report.json)`);
    }
    log(`=======================================================\n`);

    return report;
  };

  try {
    const verifyPromise = runVerify();
    verifyPromise.catch(() => {});

    const timeoutPromise = new Promise((_, reject) => {
      overallTimer = setTimeout(() => {
        aborted = true;
        reject(new Error(`Verifier timed out after ${timeoutMs}ms for ${localUrl}`));
      }, timeoutMs);
    });

    return await Promise.race([verifyPromise, timeoutPromise]);
  } catch (err) {
    if (!options.quiet && !options.json) {
      console.error(`❌ Verifier Error: ${err.message}`);
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
    try { chrome.kill('SIGKILL'); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

if (process.argv[1] && process.argv[1].endsWith('verifier.mjs')) {
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

  const urlArg = positional[0] || 'http://localhost:3000';
  const outArg = positional[1] || '.';
  verifyClone(urlArg, path.resolve(outArg), {
    quiet: Boolean(flags.quiet),
    json: Boolean(flags.json),
    timeout: flags.timeout ? parseInt(flags.timeout, 10) : undefined
  })
    .then((report) => {
      if (flags.json) console.log(JSON.stringify(report));
    })
    .catch((err) => {
      if (flags.json) console.log(JSON.stringify({ error: err.message }));
      process.exit(1);
    });
}
