# Design Document: 10 Pillars Full-Page Cloning Pipeline

## 1. Intent & Context
The goal is to produce high-fidelity, 1:1 local reproductions of the 10 core design inspiration sites:
1. **Apple** (`https://www.apple.com`) — Showcase animations & hardware typography
2. **Duolingo** (`https://www.duolingo.com`) — Gamified onboarding flow & vector UI
3. **Linear** (`https://linear.app`) — Dark-mode workspace UI & design system
4. **Pentagram** (`https://www.pentagram.com`) — Monumental editorial typography & grid
5. **Muji** (`https://www.muji.us`) — Radical minimalism & Japanese catalog structure
6. **Airbnb** (`https://www.airbnb.com`) — Interactive search bar, filters & stay cards
7. **Aēsop** (`https://www.aesop.com/nl/en/`) — Warm editorial art direction & packaging
8. **Notion** (`https://www.notion.so`) — Productivity dashboard & modular blocks
9. **Stripe** (`https://stripe.com`) — High-converting landing page layout & SVG visuals
10. **Framer** (`https://www.framer.com`) — Canvas micro-interactions & kinetic motion

The user explicitly requested:
> *"CLONE THE WHOLE PAGES NOT JUST THE PARTS THAT ARE WITH IT"*

Every clone must run locally as a standalone web application, completely rendered, backed by an autonomous caching fallback proxy server so that missing assets or dynamic requests are fetched live and cached permanently.

---

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- **Full-Page Ingestion**: Every page must have its entire layout captured from top to bottom (via smooth scrolling in headless Chrome to trigger intersection observers and lazy loading).
- **Deep Asset Extraction**: Complete extraction of all stylesheets, webfonts (`.woff2`, `.woff`, `.ttf`), images, SVGs, and client script bundles.
- **Dedicated Port Mapping**: Fixed ports assigned from `3001` through `3010` to eliminate port conflicts.
- **Autonomous Proxy Serving**: Every clone includes a configured `server.js` proxy that serves local assets and caches upstream misses on the fly.
- **Automated Batch Execution**: A dedicated orchestrator (`src/engine/batch_cloner.mjs` / `node src/cli.js batch`) to clone and verify all 10 sites sequentially with console progress and error recovery.
- **Dashboard Synchronization**: Clones appear automatically in the Webstack dashboard at `http://localhost:4000` with verification screenshots.

### Non-Goals
- Crawling entire sub-domain trees or tens of thousands of auxiliary blog/subpages (the focus is 1:1 reproduction of the flagship page and key interactive flows).
- Decompiling private backend server logic (database mutations, private server APIs).

### Anti-Goals
- Broken visual layout or blank pages due to raw static scraping of JavaScript-heavy SPAs.
- Stopping on anti-bot TLS fingerprinting (raw urllib fails on Aesop/Akamai; headless Chrome CDP must be used).
- Freezing user terminal or crashing Chrome instances due to uncontrolled parallel browser spawning.

---

## 3. Constraints
- **Platform**: Windows 11 with Node.js 24 and Python 3.14.
- **Browser**: Google Chrome executable located at `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- **Target Folder**: `C:\Users\gosse\Documents\Gemini\Webstack\clones\<name>`.

---

## 4. Approaches Considered
1. **Approach A (Recommended — Automated Batch Pipeline with CDP + Asset Harvester)**:
   - Uses real headless Chrome via Chrome DevTools Protocol to scroll, hydrate, and extract full DOMs and screenshots, paired with deep font/CSS harvesting and autonomous fallback proxies.
   - *Status: Selected by user.*
2. **Approach B (Manual Sequential CLI Cloning)**:
   - Run each clone command manually one by one.
   - *Trade-off: High human overhead, repetitive manual monitoring.*
3. **Approach C (Static Crawl First, CDP Fallback on Failure)**:
   - Attempt `urllib` download first, switch to CDP only if status 403 or blank body.
   - *Trade-off: SPAs like Duolingo/Airbnb return HTTP 200 with an empty `<div id="root">`, making static detection unreliable.*

---

## 5. Technical Architecture & Decisions

### 5.1 Port Allocation Matrix
| Index | Site Name | URL | Directory | Port |
| :---: | :--- | :--- | :--- | :---: |
| 1 | `apple-clone` | `https://www.apple.com` | `clones/apple-clone` | 3001 |
| 2 | `duolingo-clone` | `https://www.duolingo.com` | `clones/duolingo-clone` | 3002 |
| 3 | `linear-clone` | `https://linear.app` | `clones/linear-clone` | 3003 |
| 4 | `pentagram-clone` | `https://www.pentagram.com` | `clones/pentagram-clone` | 3004 |
| 5 | `muji-clone` | `https://www.muji.us` | `clones/muji-clone` | 3005 |
| 6 | `airbnb-clone` | `https://www.airbnb.com` | `clones/airbnb-clone` | 3006 |
| 7 | `aesop-clone` | `https://www.aesop.com/nl/en/` | `clones/aesop-clone` | 3007 |
| 8 | `notion-clone` | `https://www.notion.so` | `clones/notion-clone` | 3008 |
| 9 | `stripe-clone` | `https://stripe.com` | `clones/stripe-clone` | 3009 |
| 10 | `framer-clone` | `https://www.framer.com` | `clones/framer-clone` | 3010 |

### 5.2 Two-Pass Clone Pipeline (`batch_cloner.mjs`)
For each target in the matrix:
1. **Pass 1: Headless Chrome CDP Hydration & Full Page Scroll**:
   - Spawn Chrome with `--remote-debugging-port`.
   - Connect via WebSocket CDP.
   - Enable `Page`, `DOM`, `Network`, `Runtime`.
   - Navigate to `targetUrl`.
   - Execute progressive window scroll down to `scrollHeight` in 500px steps with 150ms pauses, ensuring all lazy images, intersection observers, and client chunks load.
   - Extract `document.documentElement.outerHTML` and write to `clones/<dir>/index.html`.
   - Capture full viewport screenshot to `clones/<dir>/screenshot.png`.
   - Close browser instance cleanly.
2. **Pass 2: Deep Asset Harvesting**:
   - Parse the captured `index.html` with regex/DOM parser.
   - Fetch all linked stylesheets (`.css`).
   - Scan downloaded stylesheets with regex for `url(...)` declarations to discover and download webfonts (`.woff2`, `.woff`, `.ttf`) and SVGs.
   - Download client scripts and responsive images (`img`, `srcset`).
3. **Pass 3: Scaffold Local Server & Manifests**:
   - Write customized `server.js` from `proxy_server.template.js` with `{{PORT}}` and `{{UPSTREAM}}` substituted.
   - Write `package.json` with `npm start` script.
   - Write `README.md` with port documentation and quickstart instructions.
4. **Pass 4: Quality & Visual Verification**:
   - Check file existence (`index.html`, `server.js`, `package.json`, `screenshot.png`).
   - Log total byte size and assets ingested.

### 5.3 Error Handling & Resilience
- **Per-Phase Timeout Budgets**:
  - Pass 1 (CDP navigation, hydration & scroll): 60 seconds max per site to accommodate deep scrolling on tall pages (Apple, Stripe).
  - Pass 2 (Asset harvesting & font extraction): 90 seconds max per site.
- **Bot-Proof Asset Ingestion**: Assets are captured via CDP session context or with authenticated browser headers to bypass Akamai / Cloudflare TLS fingerprinting on sites like Aēsop and Airbnb.
- **Multi-Origin & Client Script Strategy**:
  - Client scripts are preserved to ensure animations (Apple), canvas physics (Framer), and UI interactions (Linear) execute.
  - Telemetry and backend API calls are caught by `proxy_server.template.js`'s built-in API mock layer, responding with `{ ok: true }` to suppress client-side hydration crashes.
  - Relative assets are routed locally and cached upstream on demand; absolute third-party CDNs load live as fallbacks.
- **Clean Chrome Lifecycle**: Each site runs in a cleanly isolated headless Chrome instance with dynamic port allocation (9222+), terminated before the next site begins.

---

## 6. Verification & Success Criteria
1. All 10 clones exist in `clones/<name>/` with `index.html` > 10KB, `server.js`, `package.json`, `README.md`, and `screenshot.png`.
2. Each clone runs independently on its assigned port (3001 through 3010) via `npm start`.
3. All 10 clones are listed and visible in the Webstack dashboard at `http://localhost:4000`.

---

## 7. What is Left to the Builder
- Implementing the sequential loop in `src/engine/batch_cloner.mjs`.
- Adding `node src/cli.js batch` to `src/cli.js` and `npm run batch` in `package.json`.
- Adding a "Clone All 10 Pillars" button in `src/dashboard.js`.

