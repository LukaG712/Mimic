/**
 * Cross-platform Chrome / Chromium executable discovery and launch flags.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const CANDIDATES_BY_PLATFORM = {
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ...(process.env.LOCALAPPDATA
      ? [path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')]
      : [])
  ]
};

export function findChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const platform = process.platform;
  const candidates = CANDIDATES_BY_PLATFORM[platform] || CANDIDATES_BY_PLATFORM.linux;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (platform !== 'win32') {
    for (const bin of ['google-chrome', 'chromium', 'chromium-browser']) {
      try {
        const resolved = execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (resolved && fs.existsSync(resolved)) {
          return resolved;
        }
      } catch {}
    }
  }

  throw new Error(
    'Chrome/Chromium executable not found. Set CHROME_PATH or install Google Chrome / Chromium.'
  );
}

export function getChromeLaunchArgs(port, options = {}) {
  const headless = options.headless !== false;
  const args = [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-gpu',
    '--disable-dev-shm-usage'
  ];

  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }

  args.push('about:blank');
  return args;
}
