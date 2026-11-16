<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/logo-light.svg">
  <img src="docs/logo-dark.svg" alt="Mimic" width="220" height="54">
</picture>

<br/>

[![CI](https://github.com/LukaG712/Mimic/actions/workflows/ci.yml/badge.svg)](https://github.com/LukaG712/Mimic/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.8%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](package.json)
[![Zero-Dep Server](https://img.shields.io/badge/Clone%20Runtime-Zero--Dependency-0ea5e9)](#local-proxy--deterministic-replay)

**Capture live SPAs, unpack Electron apps, inspect Windows .exe and .msi binaries, and replay everything offline with deterministic API fixtures and pixel-diff verification.**

[Features](#-core-capabilities) · [Architecture](#-architecture) · [Quick Start](#-quick-start) · [CLI Reference](#-cli-reference) · [Reverse Engineering](#-windows--desktop-reverse-engineering) · [Tests](#-testing)

</div>

---

**Mimic** is a full-stack website cloning, runtime ingestion, and software reverse-engineering suite. It captures modern client-rendered web applications in flight via the Chrome DevTools Protocol (CDP), extracts static assets in parallel via Python, unpacks Electron `.asar` bundles, and performs static analysis & safe decompilation on Windows PE/MSI packages — outputting self-contained, zero-dependency local projects ready for offline replay, visual auditing, or containerized export.

---

## ✨ Core Capabilities

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>🌐 In-Flight CDP Stream Capture</h3>
      Intercepts network responses directly from Chrome before eviction or mutation. Hydrates lazy images, serializes <code>&lt;canvas&gt;</code> elements to inline PNGs, strips analytics/tracker noise, rewrites external CDNs to local routes, and records API responses for offline replay.
    </td>
    <td width="50%" valign="top">
      <h3>⚡ Parallel Static Crawler</h3>
      A 12-worker Python crawler (<code>cloner.py</code>) that ingests root HTML, stylesheets, scripts, and media, recursively resolving <code>@font-face</code> and CSS <code>url(...)</code> dependencies into a turnkey local bundle.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🔁 Zero-Dependency Local Proxy</h3>
      Every captured project ships with a standalone <code>server.js</code> supporting MD5 query-hash matching, magic-byte MIME sniffing, deterministic API fixture replay (<code>mocks/fixtures.json</code>), strict path-traversal guards, and toggleable offline/caching modes.
    </td>
    <td width="50%" valign="top">
      <h3>🎯 Automated Visual &amp; DOM Audit</h3>
      Boots the clone on an ephemeral port in headless Chrome across Desktop (<code>1440×900</code>) and Mobile (<code>390×844</code>), checks broken images, fonts, video, SVG symbols, and horizontal overflow, and generates a pixel-level <code>diff-desktop.png</code>.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>📦 Electron <code>.asar</code> &amp; Export Pipeline</h3>
      Unpacks Electron desktop apps (<code>.asar</code> or app directories) into runnable web clones, and exports any captured project as a <code>.zip</code> archive, production <code>Dockerfile</code>, or packaged Windows Electron wrapper.
    </td>
    <td width="50%" valign="top">
      <h3>🔬 Windows <code>.exe</code> / <code>.msi</code> Reverse Engineering</h3>
      Safely inspects PE32/PE32+, .NET, PyInstaller, Nuitka, AutoIt, UPX/VMProtect packers, and MSI OLE2 databases without executing untrusted code—integrating <code>ilspycmd</code>, Ghidra, <code>objdump</code>, and <code>7z</code>.
    </td>
  </tr>
</table>

> **Mimic Studio (`npm start`)** — Includes a built-in local web dashboard on `http://localhost:4000` featuring live Server-Sent Events (SSE) execution logs, a **Clone Inspector**, and a **Software Analysis** workbench.

---

## 🏗 Architecture

```mermaid
flowchart LR
    subgraph Targets["Target Inputs"]
        W["Live SPA / Web App"]
        S["Static Website"]
        E["Electron .asar / App"]
        B["Windows .exe / .msi"]
    end

    subgraph Engines["Mimic Ingestion & Analysis"]
        CDP["CDP Capture Engine<br/>(cdp_capture.mjs)"]
        PY["12-Worker Crawler<br/>(cloner.py)"]
        ASAR["Desktop Unpacker<br/>(desktop_unpacker.mjs)"]
        REV["Reverse Pipeline<br/>(src/reverse/)"]
        REA["REA Graph Bridge<br/>(rea_bridge.mjs)"]
    end

    subgraph Artifacts["Self-Contained Output"]
        CLONE["clones/&lt;project&gt;/<br/>index.html + assets + server.js<br/>mocks/fixtures.json + manifest"]
        AN["analyses/&lt;binary&gt;/<br/>PE/MSI report + strings + sources"]
    end

    subgraph Runtime["Replay, Audit & Export"]
        SRV["Local Proxy Server<br/>(Offline / Caching)"]
        VER["Headless Verifier<br/>(1440p + 390p + PNG Diff)"]
        EXP["Export<br/>(.zip / Docker / Electron)"]
    end

    W --> CDP
    W -.-> REA
    S --> PY
    E --> ASAR
    B --> REV

    CDP --> CLONE
    PY --> CLONE
    ASAR --> CLONE
    REA --> CLONE
    REV --> AN

    CLONE --> SRV
    CLONE --> VER
    CLONE --> EXP
```

---

## 🚀 Quick Start

### Prerequisites

| Requirement | Version | Purpose |
| :--- | :--- | :--- |
| **Node.js** | `18+` | Core CLI, CDP capture, Mimic Studio, local proxy servers |
| **Chrome / Chromium** | Stable | Headless/headed capture & verification (auto-detected across Linux/macOS/Windows, or set `CHROME_PATH`) |
| **Python** | `3.8+` | Parallel static crawler (`clone`) and archive packaging (`export --format zip`) |
| **`rea-agents`** *(optional)* | Latest | `rea` on `PATH` for live bundle & offline JS graph analysis (`--rea`, `analyze`) |

### 1. Launch Mimic Studio (Web UI)

```bash
git clone https://github.com/LukaG712/Mimic.git
cd Mimic
npm start
```

Open **`http://localhost:4000`** in your browser.
- Override the UI port with `DASHBOARD_PORT=<port>`.
- Scan an additional workspace directory with `MIMIC_EXTRA_CLONES_DIR=/path/to/clones`.

### 2. Capture, Verify & Serve via CLI

```bash
# 1. Capture a client-rendered SPA with live network stream + API fixture recording
node src/cli.js capture https://example.com example-app

# 2. Run automated Desktop + Mobile visual audit & pixel diff
node src/cli.js verify example-app

# 3. Serve locally in strict offline mode (no upstream requests)
node src/cli.js serve example-app --port 3000 --offline
```

---

## 🧭 CLI Reference

Run commands via `node src/cli.js <command>` (or `npx mimic <command>` when linked).

### Web Capture & Static Cloning

```bash
# Headless Chrome CDP capture (recommended for React/Next.js/Vue/SPAs)
node src/cli.js capture https://example.com example-app

# Capture with REA live bundle analysis + multi-route internal crawling
node src/cli.js capture https://example.com example-app --rea --crawl --max-routes 10

# Capture authenticated apps via cookies, headers, or interactive headed login
node src/cli.js capture https://app.example.com app-clone --cookies cookies.json --header "Authorization: Bearer token"
node src/cli.js capture https://app.example.com app-clone --interactive-login

# Parallel static HTML/CSS/font/script crawl via Python
node src/cli.js clone https://example.com example-static --port 3001

# Run offline REA JavaScript application graph analysis on a captured clone
node src/cli.js analyze example-app
```

### Serving, Verification & Packaging

```bash
# Start local hybrid proxy server (omit --offline to cache missing assets from origin)
node src/cli.js serve example-app --port 3000
node src/cli.js serve example-app --port 3000 --offline

# Audit DOM, fonts, console/network errors, and pixel diff at 1440x900 & 390x844
node src/cli.js verify example-app

# Export as .zip archive, Dockerfile, or Windows Electron wrapper
node src/cli.js export example-app --format zip
node src/cli.js export example-app --format docker
node src/cli.js export example-app --format electron

# Workspace management
node src/cli.js list
node src/cli.js remove example-app
```

### Desktop & Binary Reverse Engineering

```bash
# Unpack an Electron .asar archive or unpacked app directory into a clone
node src/cli.js unpack /path/to/app.asar electron-clone

# Inspect, extract, and decompile Windows .exe and .msi packages
node src/cli.js inspect-bin /path/to/app.exe
node src/cli.js inspect-bin /path/to/installer.msi --json

# Check which optional reverse-engineering tools are installed on this machine
node src/cli.js tools
```

<details>
<summary><strong>Full CLI Flags &amp; Options Matrix</strong></summary>

| Flag | Applies to | Description |
| :--- | :--- | :--- |
| `--port <number>` | `clone`, `capture`, `serve`, `verify` | Local port to write into `server.js` or bind when serving (default `3000`). |
| `--offline` | `serve` | Disable upstream fallback and return `404` on uncaptured assets (`MIMIC_OFFLINE=1`). |
| `--crawl` | `capture` | Crawl internal same-origin `<a>` and REA-discovered routes in the same CDP session. |
| `--max-routes <num>` | `capture` | Maximum internal routes to crawl when `--crawl` is set (default `10`). |
| `--cookies <file\|str>` | `capture` | Path to a cookies JSON file or `k=v; ...` cookie string to inject before navigation. |
| `--header <k:v>` | `capture` | Custom HTTP request header to inject during capture. |
| `--interactive-login` | `capture` | Launch a headed Chrome window and wait for `[Enter]` before capturing. |
| `--rea` | `capture` | Run `rea analyze-web-bundle` against the live page and save `rea-bundle.json`. |
| `--fetch-source-maps` | `capture` | Fetch script source maps when running `capture --rea`. |
| `--full-evidence` | `analyze` | Save the complete REA Evidence record to `rea-evidence.json` alongside `rea-analysis.json`. |
| `--source-path <paths>` | `analyze` | Comma-separated relative JS paths to restrict static analysis scope. |
| `--no-scroll` | `capture` | Skip the full-page scroll pass before extracting the DOM. |
| `--timeout <ms>` | `capture`, `verify` | Max run time in ms before aborting (`60000` for `capture`, `45000` for `verify`). |
| `--format <zip\|docker\|electron>` | `export` | Package format for `export` (default `zip`). |
| `--out <path>` | `export` | Output `.zip` file path. |
| `--quiet`, `-q` | `capture`, `clone`, `verify`, `analyze`, `export`, `remove` | Suppress progress logs. |
| `--json` | `capture`, `clone`, `verify`, `analyze`, `export`, `remove`, `list`, `inspect-bin`, `tools` | Emit compact JSON output to stdout. |

</details>

---

## ⚙️ How It Works Under the Hood

### In-Flight CDP Capture ([`cdp_capture.mjs`](src/engine/cdp_capture.mjs))
1. **Network Stream Interception:** Attaches to Chrome's `Network` domain to capture raw response bodies in flight before garbage collection or SPA state mutation. Telemetry/analytics hosts (`google-analytics.com`, `segment.io`, `sentry.io`, `intercom.io`, etc.) are filtered out automatically.
2. **DOM Hydration & Normalization:** Scrolls the full page to trigger intersection observers, converts lazy attributes (`loading="lazy"`, `data-src`, `data-srcset`) to eager loading, and serializes `<canvas>` elements into inline PNG data URLs.
3. **CDN Rewriting & Fixtures:** Rewrites external CDN references in HTML/CSS to `/external/<host>/...` to eliminate CORS errors locally. Records JSON, GraphQL, and `/api/` responses to `mocks/fixtures.json`, saves `baseline-desktop.png`, and writes a compact `clone-manifest.json`.

### Local Proxy & Deterministic Replay ([`proxy_server.template.js`](src/server/proxy_server.template.js))
Every captured site receives a self-contained, zero-dependency `server.js`:
1. **Local Resolution:** Matches requested paths and query strings against MD5 query-hash suffixes (`_<hash>`) generated by [`url_mapper.mjs`](src/engine/url_mapper.mjs).
2. **Magic-Byte Sniffing:** For extensionless or `.bin` assets, inspects buffer headers to infer `PNG`, `JPEG`, `GIF`, `WebP`, `AVIF`, `WOFF`/`WOFF2`, `SVG`, `HTML`, or `JSON` and serves the exact `Content-Type`.
3. **API Fixture Replay:** Matches `/api/*`, `/_next/data/*`, and `POST`/`PUT`/`DELETE` requests against `mocks/fixtures.json` (by method, path, query, and body hash), falling back to a clean synthetic `200 OK` JSON stub when unrecorded.
4. **Hybrid Caching & Security:** When online (`--offline` omitted), fetches missing assets from origin/CDN, streams them to the browser, and caches them to disk. All paths are validated against the clone root to block directory traversal (`/../`, `%2e%2e`).

### Automated Verification ([`verifier.mjs`](src/engine/verifier.mjs) & [`png_diff.mjs`](src/engine/png_diff.mjs))
`verify` boots the clone on an ephemeral port, loads it in headless Chrome at `1440×900` and `390×844`, and audits:
- Broken `<img>` elements, failed `document.fonts`, `<video>` playback errors, and missing `<svg><use>` targets
- Horizontal viewport overflow
- Deduplicated console & network failures
- Pixel-level comparison of `screenshot.png` against `baseline-desktop.png`, outputting `diff-desktop.png` and `audit-report.json`.

---

## 🔬 Windows & Desktop Reverse Engineering

Mimic includes a modular static analysis, safe extraction, and decompilation subsystem in [`src/reverse/`](src/reverse/), accessible via `inspect-bin`, `tools`, and the **Software Analysis** tab in Mimic Studio.

- **Format & Packer Detection ([`file_identifier.mjs`](src/reverse/detection/file_identifier.mjs)):** Identifies PE32/PE32+, .NET Framework, Modern/Single-File .NET, Electron, PyInstaller, Nuitka, AutoIt, UPX/ASPack/Themida/VMProtect packers, MSI OLE2 packages, and installers (Inno Setup, NSIS, WiX Burn, InstallShield, Advanced Installer, Squirrel, 7-Zip SFX, WinRAR SFX).
- **Static PE & Strings Analysis ([`pe_analyzer.mjs`](src/reverse/engines/pe_analyzer.mjs), [`strings_analyzer.mjs`](src/reverse/analysis/strings_analyzer.mjs)):** Extracts sections with Shannon entropy, DLL imports/exports, CodeView PDB paths, CLR `.NET` headers, Authenticode presence, embedded XML manifests, URLs, IPv4 addresses, Windows paths, and registry keys.
- **MSI Database & Extraction ([`msi_analyzer.mjs`](src/reverse/engines/msi_analyzer.mjs), [`msi_extractor.mjs`](src/reverse/extractors/msi_extractor.mjs)):** Parses OLE2 Compound File containers, decodes 6-bit MSI table names, detects embedded `MSCF` CABs and external `.cab` references, and extracts payloads without executing custom actions.
- **Decompilation Adapters:**
  - **.NET ([`dotnet_decompiler.mjs`](src/reverse/engines/dotnet_decompiler.mjs)):** `ilspycmd` for C# source recovery.
  - **Native PE ([`native_decompiler.mjs`](src/reverse/engines/native_decompiler.mjs)):** Ghidra Headless (`analyzeHeadless`) for C pseudocode or GNU `objdump` for Intel disassembly.
  - **PyInstaller ([`python_decompiler.mjs`](src/reverse/engines/python_decompiler.mjs)):** Built-in CArchive extractor + `uncompyle6`/`decompyle3` or Python stdlib `marshal`/`dis` disassembly.

### Optional External Toolchain

Mimic performs PE, MSI, and PyInstaller static inspection out of the box with **zero** optional tools installed. Installing optional tools unlocks deeper extraction and source recovery:

| Tool | Purpose | Linux (Debian / Ubuntu) | Windows 11 |
| :--- | :--- | :--- | :--- |
| `7z` / `7za` | Extract NSIS, Burn, CAB, SFX, ZIP | `sudo apt install p7zip-full` | `winget install 7zip.7zip` |
| `ilspycmd` | Decompile `.NET` assemblies to C# | `dotnet tool install -g ilspycmd` | `dotnet tool install -g ilspycmd` |
| `analyzeHeadless` | Ghidra native C pseudocode decompilation | Install Ghidra & set `GHIDRA_HOME` | Install Ghidra & set `GHIDRA_HOME` |
| `objdump` | Intel-syntax native PE disassembly | `sudo apt install binutils` | MSYS2 / MinGW `binutils` |
| `innoextract` | Extract Inno Setup `.exe` installers | `sudo apt install innoextract` | `winget install dsquier.innoextract` |
| `upx` | Unpack UPX-packed executables | `sudo apt install upx-ucl` | `winget install UPX.UPX` |
| `msiinfo` / `msiextract` | Inspect & extract `.msi` databases | `sudo apt install msitools` | Built-in read-only COM fallback + `lessmsi` |
| `uncompyle6` / `decompyle3` | Decompile `.pyc` bytecode to `.py` | `pip install decompyle3 uncompyle6` | `pip install decompyle3 uncompyle6` *(stdlib `dis` built-in)* |

### 🛡️ Security Boundaries

- Static analysis and extraction run in-process or via timeout-bounded child processes (`runToolSafe`) with strict path-traversal validation (`isSafeSubpath`); they are **not** OS-level sandboxes.
- Target binaries, extracted scripts, and MSI `CustomAction` entries are **never** automatically executed.
- Always run Mimic inside a dedicated VM or container when analyzing untrusted malware.
- Reports honestly distinguish `decompiled`, `extracted`, `partial`, `unsupported`, and `failed` outcomes.

---

## 📁 Project Structure

```text
Mimic/
├── .github/workflows/ci.yml           # GitHub Actions CI (Node 22 + stable Chrome)
├── clones/                            # Captured web projects (gitignored)
├── analyses/                          # Binary & MSI analysis outputs (gitignored)
├── docs/                              # Architecture plans & visual assets
├── src/
│   ├── cli.js                         # Master CLI entry point
│   ├── dashboard.js                   # Mimic Studio web UI (port 4000) with SSE logs
│   ├── engine/                        # CDP capture, Python crawler, Chrome finder, PNG diff, REA bridge, ASAR unpacker
│   ├── reverse/                       # PE/MSI detection, extractors, decompilers & orchestration pipeline
│   └── server/
│       └── proxy_server.template.js   # Zero-dependency per-clone proxy & fixture server
└── test/                              # 8 unit & end-to-end integration test suites
```

---

## 🧪 Testing

Run the full unit and integration suite (verified on every push via [GitHub Actions](.github/workflows/ci.yml)):

```bash
npm test
```

<details>
<summary><strong>Test Suites Included (8 suites)</strong></summary>

| Suite | Coverage |
| :--- | :--- |
| [`url_mapper.test.mjs`](test/url_mapper.test.mjs) | URL mapping, tracker filtering, CDN rewriting |
| [`turnkey_scaffold.test.mjs`](test/turnkey_scaffold.test.mjs) | Proxy scaffolding, magic-byte MIME sniffing, path-traversal protection |
| [`rea_bridge.test.mjs`](test/rea_bridge.test.mjs) | REA output parsing & offline JS application graph analysis |
| [`dashboard.test.mjs`](test/dashboard.test.mjs) | Mimic Studio API endpoints & client script compilation |
| [`new_features.test.mjs`](test/new_features.test.mjs) | Chrome auto-discovery, PNG diffing, fixture replay & offline mode |
| [`desktop_unpacker.test.mjs`](test/desktop_unpacker.test.mjs) | Electron `.asar` archive unpacking |
| [`cdp_stream.test.mjs`](test/cdp_stream.test.mjs) | End-to-end headless CDP capture, route crawling, fixtures & timeouts |
| [`reverse_engineering.test.mjs`](test/reverse_engineering.test.mjs) | PE, .NET, PyInstaller, MSI analysis & extraction path-traversal safety |

</details>

---

## 📄 License

Released under the [MIT License](package.json).
