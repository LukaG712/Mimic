#!/usr/bin/env python3
"""
Webstack Universal Website Cloner (Python Engine)
High-fidelity parallel asset ingestion, font extraction, script capture, and proxy scaffold generator.
"""

import os
import sys
import re
import json
import ssl
import argparse
import concurrent.futures
import urllib.request
import urllib.parse
from bs4 import BeautifulSoup

# Bypass Windows Python missing local root certificates
SSL_CONTEXT = ssl._create_unverified_context()

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
}

def clean_url_path(raw_url, base_url):
    """Normalize relative and absolute URLs to clean file paths."""
    if not raw_url or not isinstance(raw_url, str):
        return None, None
    raw_url = raw_url.strip()
    if raw_url in [',', ';', '.', '/', '\\'] or raw_url.startswith(('javascript:', 'data:', 'mailto:', '#')):
        return None, None

    parsed = urllib.parse.urlparse(raw_url)
    full_url = urllib.parse.urljoin(base_url, raw_url)

    # If same domain or relative path
    parsed_base = urllib.parse.urlparse(base_url)
    if not parsed.netloc or parsed.netloc == parsed_base.netloc:
        path = parsed.path.lstrip('/')
        if not path or path.endswith('/'):
            path = path + 'index.html'
        return full_url, path
    else:
        # External resource: map into external/<domain>/<path>
        safe_path = f"external/{parsed.netloc}/{parsed.path.lstrip('/')}"
        return full_url, safe_path

def download_file(url, dest_path):
    """Download a single asset safely with directories creation."""
    try:
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=20, context=SSL_CONTEXT) as resp:
            content = resp.read()
            with open(dest_path, 'wb') as f:
                f.write(content)
            return content
    except Exception:
        # Ignore 404s gracefully as the proxy server will handle dynamic misses
        return None

def download_batch(candidates, max_workers=12, log_fn=print):
    """Download unique (full_url, dest, rel_path, label) tuples in parallel."""
    unique_tasks = []
    seen_dests = set()
    for full_url, dest, rel_path, label in candidates:
        if dest in seen_dests or os.path.exists(dest):
            continue
        seen_dests.add(dest)
        unique_tasks.append((full_url, dest, rel_path, label))

    if not unique_tasks:
        return []

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {
            executor.submit(download_file, full_url, dest): (full_url, dest, rel_path, label)
            for full_url, dest, rel_path, label in unique_tasks
        }
        for future in concurrent.futures.as_completed(future_map):
            full_url, dest, rel_path, label = future_map[future]
            try:
                content = future.result()
                if content is not None:
                    results.append((full_url, dest, rel_path, content))
                    log_fn(f"  ✓ {label}: {rel_path}")
            except Exception:
                pass
    return results

def clone_site(base_url, target_dir, port=3000, quiet=False, json_output=False):
    def log(msg=""):
        if not quiet and not json_output:
            print(msg)

    log(f"\n=======================================================")
    log(f"🌐 [Mimic Static Cloner] Ingesting: {base_url}")
    log(f"📁 Destination: {target_dir}")
    log(f"🔌 Assigned Local Port: {port}")
    log(f"=======================================================\n")

    os.makedirs(target_dir, exist_ok=True)
    parsed_base = urllib.parse.urlparse(base_url)
    origin = f"{parsed_base.scheme}://{parsed_base.netloc}"

    # 1. Fetch Main Page HTML
    log("▶ Step 1: Fetching root HTML document...")
    try:
        req = urllib.request.Request(base_url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=25, context=SSL_CONTEXT) as resp:
            raw_html = resp.read().decode('utf-8', errors='ignore')
    except Exception as e:
        if json_output:
            print(json.dumps({"error": str(e)}))
        else:
            print(f"❌ Failed to connect to {base_url}: {e}", file=sys.stderr)
        sys.exit(1)

    html_file = os.path.join(target_dir, 'index.html')
    with open(html_file, 'w', encoding='utf-8') as f:
        f.write(raw_html)
    log(f"  ✓ Saved index.html ({len(raw_html):,} bytes)")

    soup = BeautifulSoup(raw_html, 'html.parser')
    downloaded_count = 0
    css_files = []

    # 2. Extract and Download Stylesheets in parallel
    log("\n▶ Step 2: Ingesting stylesheets (.css)...")
    css_candidates = []
    for link in soup.find_all('link', rel=lambda r: r and 'stylesheet' in r):
        href = link.get('href')
        if href:
            full_url, rel_path = clean_url_path(href, base_url)
            if full_url and rel_path:
                dest = os.path.join(target_dir, rel_path.replace('/', os.sep))
                css_candidates.append((full_url, dest, rel_path, 'CSS'))

    for full_url, dest, rel_path, _ in download_batch(css_candidates, log_fn=log):
        css_files.append((dest, full_url))
        downloaded_count += 1

    # 3. Extract and Download Preloaded Fonts & Icons in parallel
    log("\n▶ Step 3: Ingesting preloaded fonts & media...")
    preload_candidates = []
    for link in soup.find_all('link', rel=lambda r: r and ('preload' in r or 'prefetch' in r or 'icon' in r)):
        href = link.get('href')
        if href:
            full_url, rel_path = clean_url_path(href, base_url)
            if full_url and rel_path:
                dest = os.path.join(target_dir, rel_path.replace('/', os.sep))
                preload_candidates.append((full_url, dest, rel_path, 'Preload/Icon'))

    downloaded_count += len(download_batch(preload_candidates, log_fn=log))

    # 4. Recursively Extract CSS Assets (url(...) fonts and background images) in parallel
    log("\n▶ Step 4: Scanning CSS bundles for embedded fonts & vector graphics...")
    css_url_pattern = re.compile(r'url\((?![\'"]?(?:data:|blob:))[\'"]?([^\'")]+)[\'"]?\)')
    css_asset_candidates = []
    for css_path, css_full_url in css_files:
        if os.path.exists(css_path):
            try:
                with open(css_path, 'r', encoding='utf-8', errors='ignore') as f:
                    css_text = f.read()
                matches = css_url_pattern.findall(css_text)
                for u in matches:
                    u_clean = u.split('?')[0].split('#')[0]
                    full_asset_url = urllib.parse.urljoin(css_full_url, u)
                    _, rel_path = clean_url_path(u_clean, css_full_url)
                    if rel_path:
                        dest = os.path.join(target_dir, rel_path.replace('/', os.sep))
                        css_asset_candidates.append((full_asset_url, dest, rel_path, 'CSS asset'))
            except Exception:
                pass

    downloaded_count += len(download_batch(css_asset_candidates, log_fn=log))

    # 5. Extract and Download Client Scripts (.js, .mjs, chunks) in parallel
    log("\n▶ Step 5: Ingesting JavaScript runtime bundles & RSC chunks...")
    script_candidates = []
    for script in soup.find_all('script', src=True):
        src = script.get('src')
        if src:
            full_url, rel_path = clean_url_path(src, base_url)
            if full_url and rel_path:
                dest = os.path.join(target_dir, rel_path.replace('/', os.sep))
                script_candidates.append((full_url, dest, rel_path, 'Script'))

    downloaded_count += len(download_batch(script_candidates, log_fn=log))

    # 6. Extract Images (src, srcset, pictures) in parallel
    log("\n▶ Step 6: Ingesting high-resolution visual assets & responsive pictures...")
    image_candidates = set()
    for img in soup.find_all(['img', 'source']):
        src = img.get('src')
        if src and not src.startswith('data:'):
            image_candidates.add(src)
        srcset = img.get('srcset')
        if srcset:
            for part in srcset.split(','):
                tokens = part.strip().split()
                if tokens and not tokens[0].startswith('data:'):
                    image_candidates.add(tokens[0])

    img_tasks = []
    for img_src in image_candidates:
        full_url, rel_path = clean_url_path(img_src, base_url)
        if full_url and rel_path:
            dest = os.path.join(target_dir, rel_path.replace('/', os.sep))
            img_tasks.append((full_url, dest, rel_path, 'Image'))

    downloaded_count += len(download_batch(img_tasks, log_fn=log))

    # 7. Scaffold Hybrid Proxy Server (server.js)
    log("\n▶ Step 7: Generating autonomous hybrid proxy server...")
    template_path = os.path.join(os.path.dirname(__file__), '..', 'server', 'proxy_server.template.js')
    if os.path.exists(template_path):
        with open(template_path, 'r', encoding='utf-8') as f:
            server_tpl = f.read()
        server_code = server_tpl.replace('{{PORT}}', str(port)).replace('{{UPSTREAM}}', origin)
    else:
        server_code = f"""const http = require('http');
const fs = require('fs');
const path = require('path');
const server = http.createServer((req, res) => {{
  let p = req.url === '/' ? '/index.html' : req.url;
  let file = path.join(__dirname, p.split('?')[0]);
  if (fs.existsSync(file)) fs.createReadStream(file).pipe(res);
  else {{ res.writeHead(404); res.end('Not Found'); }}
}});
server.listen({port}, () => console.log('Listening on http://localhost:{port}'));
"""

    with open(os.path.join(target_dir, 'server.js'), 'w', encoding='utf-8') as f:
        f.write(server_code)

    # 8. Scaffold package.json with sanitized npm package name
    slug = os.path.basename(os.path.abspath(target_dir))
    safe_slug = re.sub(r'[^a-z0-9-_]', '-', slug.lower()).strip('-') or 'cloned-site'
    package_json = json.dumps({
        "name": safe_slug,
        "version": "1.0.0",
        "description": f"High-fidelity clone of {base_url} generated with Mimic Static Cloner.",
        "main": "server.js",
        "scripts": {
            "start": "node server.js",
            "dev": "node server.js"
        },
        "keywords": ["mimic", "clone", "replica"],
        "author": "Antigravity",
        "license": "MIT"
    }, indent=2)
    with open(os.path.join(target_dir, 'package.json'), 'w', encoding='utf-8') as f:
        f.write(package_json)

    # 9. Scaffold README.md
    readme_md = f"""# {safe_slug} — 1:1 Production Clone

Exact 1:1 reconstruction of [{base_url}]({base_url}) generated with **Mimic**.

## 🚀 Instant Launch

```bash
cd "{target_dir}"
npm start
```

Open your browser at: **[http://localhost:{port}](http://localhost:{port})**

## 🛡️ Autonomous Fallback Proxy
This clone is powered by an intelligent hybrid server:
- All static assets captured during crawling are served instantly from disk.
- Any dynamically requested assets, lazy-loaded components, or font variants are fetched from `{origin}` on-demand, served to the browser, and cached locally for permanent offline availability.
"""
    with open(os.path.join(target_dir, 'README.md'), 'w', encoding='utf-8') as f:
        f.write(readme_md)

    summary = {
        "url": base_url,
        "targetDir": target_dir,
        "port": port,
        "assetsDownloaded": downloaded_count + 1,
        "htmlBytes": len(raw_html.encode('utf-8'))
    }

    if json_output:
        print(json.dumps(summary))
    else:
        log(f"\n=======================================================")
        log(f"🎉 Clone Completed Successfully!")
        log(f"📊 Total Assets Ingested: {downloaded_count + 1}")
        log(f"🚀 To run: cd \"{target_dir}\" && npm start")
        log(f"🔗 Local URL: http://localhost:{port}")
        log(f"=======================================================\n")

    return summary

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Mimic Static Cloner Engine')
    parser.add_argument('--url', required=True, help='Target URL to clone')
    parser.add_argument('--out', required=True, help='Destination directory')
    parser.add_argument('--port', type=int, default=3000, help='Port to assign to cloned server')
    parser.add_argument('--quiet', action='store_true', help='Suppress verbose stdout logging')
    parser.add_argument('--json', action='store_true', help='Output JSON summary only')
    args = parser.parse_args()

    clone_site(args.url, os.path.abspath(args.out), args.port, quiet=args.quiet, json_output=args.json)
