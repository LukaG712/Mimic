# ⚡ Mimic — Production Website Reverse-Engineering & Cloning Suite

A comprehensive, automated toolkit for 1:1 website cloning, client-side runtime reverse engineering, asset harvesting, and autonomous fallback proxy serving.

---

## 🏗️ Architecture & Core Components

```
C:\Users\gosse\Documents\Gemini\Webstack
├── clones/                          # All cloned projects live here
├── src/
│   ├── cli.js                       # Master CLI orchestrator
│   ├── dashboard.js                 # Visual browser studio (http://localhost:4000)
│   ├── engine/
│   │   ├── cloner.py                # Deep recursive static & font crawler
│   │   ├── cdp_capture.mjs          # Chrome DevTools Protocol (CDP) runtime capture
│   │   └── verifier.mjs             # Multi-viewport screenshot & health auditor
│   └── server/
│       └── proxy_server.template.js # Autonomous hybrid caching server template
├── package.json
└── README.md
```

---

## 🚀 Quick Start

### 1. Launch the Visual Dashboard
```bash
cd C:\Users\gosse\Documents\Gemini\Webstack
npm start
```
Open **[http://localhost:4000](http://localhost:4000)** to view all existing clones across `Gemini\Clones` and `Webstack\clones`, or trigger a new clone with 1 click.

---

### 2. Command Line Workflows

#### A. Static Recursive Clone (Recommended for most sites)
Ingests the root HTML, all linked stylesheets, scans CSS files recursively to download embedded webfonts (`.woff2`, `.woff`, `.ttf`) and background images, client JavaScript bundles, and scaffolds an autonomous proxy server.
```bash
# Syntax: node src/cli.js clone <url> [name] [--port 3000]
node src/cli.js clone https://linear.app linear-clone --port 3001
```

#### B. Runtime CDP Capture (For heavy SPAs, React, Next.js App Router)
Launches headless Chrome via Chrome DevTools Protocol (CDP), navigates to the target, scrolls to trigger lazy loading, and captures the fully hydrated DOM and a desktop screenshot.
```bash
# Syntax: node src/cli.js capture <url> [name]
node src/cli.js capture https://stripe.com stripe-runtime
```

#### C. Run Any Cloned Site
Starts the intelligent hybrid server for a cloned site.
```bash
# Syntax: node src/cli.js serve [name] [--port 3000]
node src/cli.js serve linear-clone
```

#### D. Visual & Console Health Audit
Audits console errors, 404 network misses, and captures desktop (1440x900) + mobile (390x844) screenshots.
```bash
# Syntax: node src/cli.js verify [name] [--port 3000]
node src/cli.js verify linear-clone
```

#### E. List All Projects
```bash
node src/cli.js list
```

---

## 🛡️ Autonomous Fallback Proxy (`server.js`)

Every site cloned by Webstack includes a dedicated `server.js` configured with:
1. **Static Local Serving:** High-performance local file delivery with accurate modern MIME types.
2. **On-Demand Upstream Caching:** If the client requests any asset that wasn't captured during initial crawling (e.g. dynamic sub-chunks, localized fonts, lazy images), the server automatically fetches it from the original live site, streams it to the browser, and saves it to disk locally.
3. **API Mock Layer:** Prevents client-side script crashes by answering common POST and API endpoints with mocked successful payloads.
