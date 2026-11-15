# Mimic

Mimic captures live websites into self-contained local directories that run offline or behind a local caching proxy. It includes two capture engines: a Chrome DevTools Protocol (CDP) engine for client-rendered applications and a multi-threaded Python crawler for static sites.

## Requirements

- Node.js 18+
- Google Chrome or Chromium (auto-detected across Linux, macOS, and Windows, or set `CHROME_PATH`)
- Python 3.8+ (used by `clone` and `export --format zip`)
- `rea-agents` (`rea` on PATH or installed globally via npm, optional, used by `analyze` and `capture --rea`)

## Usage

Start the local web UI on `http://localhost:4000` (override with `DASHBOARD_PORT`, and optionally scan an extra clones directory with `MIMIC_EXTRA_CLONES_DIR`):

```bash
npm start
```

Or run the CLI directly through `node src/cli.js` (or `npx mimic` when linked):

```bash
# Capture a rendered page and its network stream via headless Chrome (recommended for SPAs)
node src/cli.js capture https://example.com example-app

# Capture with REA live bundle analysis + multi-route internal crawling
node src/cli.js capture https://example.com example-app --rea --crawl --max-routes 10

# Capture an authenticated app with cookies, custom headers, or interactive headed login
node src/cli.js capture https://app.example.com app-clone --cookies cookies.json --header "Authorization: Bearer token"
node src/cli.js capture https://app.example.com app-clone --interactive-login

# Analyze captured JavaScript bundles offline with REA
node src/cli.js analyze example-app

# Crawl static HTML, stylesheets, fonts, and scripts via Python
node src/cli.js clone https://example.com example-static --port 3001

# Serve a captured site locally (use --offline to disable upstream fallback)
node src/cli.js serve example-app --port 3000
node src/cli.js serve example-app --port 3000 --offline

# Run a headless audit at desktop (1440x900) and mobile (390x844) viewports + visual diff
node src/cli.js verify example-app

# Export a clone as a .zip archive or generate a Dockerfile
node src/cli.js export example-app --format zip
node src/cli.js export example-app --format docker

# List or remove captured projects
node src/cli.js list
node src/cli.js remove example-app
```

### CLI flags

| Flag | Applies to | Description |
| :--- | :--- | :--- |
| `--port <number>` | `clone`, `serve`, `verify` | Local port to write into `server.js` or bind when serving (default `3000`). |
| `--offline` | `serve` | Disable upstream fallback and return `404` on uncaptured assets (`MIMIC_OFFLINE=1`). |
| `--crawl` | `capture` | Crawl internal same-origin `<a>` and REA-discovered routes in the same CDP session. |
| `--max-routes <num>` | `capture` | Maximum number of internal routes to crawl when `--crawl` is set (default `10`). |
| `--cookies <file\|str>` | `capture` | Path to a cookies JSON file or a `k=v; ...` cookie string to inject before navigation. |
| `--header <k:v>` | `capture` | Custom HTTP request header to inject during capture. |
| `--interactive-login` | `capture` | Launch a headed Chrome window and wait for `[Enter]` before capturing. |
| `--rea` | `capture` | Run `rea analyze-web-bundle` against the live page and save `rea-bundle.json`. |
| `--fetch-source-maps` | `capture` | Fetch script source maps when running `capture --rea`. |
| `--full-evidence` | `analyze` | Save the complete REA Evidence record to `rea-evidence.json` alongside `rea-analysis.json`. |
| `--source-path <paths>` | `analyze` | Comma-separated relative JS paths to restrict static analysis scope. |
| `--no-scroll` | `capture` | Skip the full-page scroll pass before extracting the DOM. |
| `--timeout <ms>` | `capture`, `verify` | Maximum run time in milliseconds before aborting (`60000` for `capture`, `45000` for `verify`). |
| `--format <zip\|docker>` | `export` | Package format for `export` (default `zip`). |
| `--out <path>` | `export` | Output `.zip` file path. |
| `--quiet`, `-q` | `capture`, `clone`, `verify`, `analyze`, `export`, `remove` | Suppress progress logs. |
| `--json` | `capture`, `clone`, `verify`, `analyze`, `export`, `remove`, `list` | Print a single JSON summary line to stdout. |

## How capture and serving work

### CDP capture (`src/engine/cdp_capture.mjs`)

`capture` launches Chrome with the Network domain enabled and intercepts responses in flight before the browser discards or mutates them. Common analytics and telemetry hosts (`google-analytics.com`, `segment.io`, `sentry.io`, `intercom.io`, and similar) are dropped during capture so tracker noise does not land on disk.

Once network activity settles, Mimic scrolls the page to trigger intersection observers, converts lazy images (`loading="lazy"`, `data-src`, `data-srcset`) to eager attributes, serializes `<canvas>` elements to inline PNG data URLs, and writes the hydrated DOM to `index.html`. External CDN URLs referenced in HTML and CSS are rewritten to `/external/<host>/...` so the local server can resolve them without CORS failures.

JSON, GraphQL, and `/api/` responses observed during capture are recorded to `mocks/fixtures.json` for deterministic offline replay, and a baseline desktop screenshot is saved to `baseline-desktop.png` for visual diffing. Each capture writes a compact `clone-manifest.json` containing asset counts, total bytes, skipped tracker count, fixture count, crawled routes, and structural tags (`title`, `h1`, stylesheet and script paths).

### Static crawler (`src/engine/cloner.py`)

`clone` fetches the root document, parses linked stylesheets, scripts, and media, and recursively scans CSS files for `@font-face` and `url(...)` references. Assets are downloaded concurrently through a 12-worker thread pool and scaffolded with the same `proxy_server.template.js` local server.

### REA integration (`src/engine/rea_bridge.mjs`)

`capture --rea` runs `rea analyze-web-bundle` against the live Chrome target before crawling or closing the browser. It saves `rea-bundle.json` and merges detected routes, endpoints, chunks, and framework inferences into `clone-manifest.json`. `analyze <name>` runs `rea analyze-javascript-application` offline against captured scripts and writes a compact graph summary to `rea-analysis.json`.

### Local proxy server (`src/server/proxy_server.template.js`)

Every captured project gets a zero-dependency `server.js`. When a browser requests a file:

1. The server checks the local clone directory first, matching URL query strings against MD5 query-hash suffixes (`_<hash>`) generated by `url_mapper.mjs`.
2. If an asset has no file extension or uses `.bin`, the server inspects the first bytes of the buffer to detect PNG, JPEG, GIF, WebP, AVIF, WOFF/WOFF2, SVG, HTML, or JSON payloads and sets `Content-Type` accordingly.
3. For `/api/*`, `/_next/data/*`, `POST`/`PUT`/`DELETE` requests, or discovered endpoints, the server first checks `mocks/fixtures.json` (matching method, path, query, and request body hash) and replays the recorded payload; otherwise it returns `200 OK` with `{"ok":true,"status":"success","mocked":true}`.
4. If a static file is missing locally and `--offline` / `MIMIC_OFFLINE=1` is not set, the server fetches it from the origin (or from the target CDN for `/external/<host>/...` paths), streams the response to the browser, and caches the file on disk for subsequent requests.

All resolved paths are checked against the clone root directory to block path traversal (`/../` or URL-encoded `%2e%2e`).

### Verification (`src/engine/verifier.mjs` & `src/engine/png_diff.mjs`)

`verify` boots the clone's `server.js` on an ephemeral port, loads it in headless Chrome at `1440x900` and `390x844`, checks for broken `<img>` elements, failed `document.fonts`, `<video>` errors, missing `<svg><use>` targets, and horizontal overflow, deduplicates console and network errors, compares `screenshot.png` against `baseline-desktop.png` (writing `diff-desktop.png`), and writes `audit-report.json`.

## Repository layout

```text
├── .github/workflows/ci.yml         # CI workflow running npm test
├── clones/                          # Captured sites (gitignored except .gitkeep)
├── src/
│   ├── cli.js                       # CLI entry point
│   ├── dashboard.js                 # Local web UI (port 4000) with SSE logs & inspector
│   ├── engine/
│   │   ├── cdp_capture.mjs          # Headless/headed Chrome in-flight stream capture
│   │   ├── chrome_finder.mjs        # Cross-platform Chrome/Chromium discovery
│   │   ├── cloner.py                # Concurrent static HTML/CSS/font crawler
│   │   ├── png_diff.mjs             # Zero-dependency PNG pixel diffing
│   │   ├── rea_bridge.mjs           # REA bundle and static JS application bridge
│   │   ├── url_mapper.mjs           # URL-to-disk path mapping, tracker filter, CDN rewriter
│   │   └── verifier.mjs             # Headless viewport, asset health & visual diff auditor
│   └── server/
│       └── proxy_server.template.js # Per-clone local server, fixture replay & upstream cache
└── test/
    ├── cdp_stream.test.mjs          # End-to-end CDP capture, crawl, fixture & timeout test
    ├── dashboard.test.mjs           # Studio API & client script compilation test
    ├── new_features.test.mjs        # Chrome finder, PNG diff, fixture replay & offline mode tests
    ├── rea_bridge.test.mjs          # REA output parser & JS application analysis test
    ├── turnkey_scaffold.test.mjs    # Scaffold, MIME sniffing, & path-traversal test
    └── url_mapper.test.mjs          # URL mapping, tracker filter, & CDN rewrite unit tests
```

## Tests

Run the unit and integration test suite:

```bash
npm test
```
