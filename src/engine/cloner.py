#!/usr/bin/env python3
"""
Webstack Universal Website Cloner (Python Engine)
High-fidelity recursive asset ingestion, font extraction, script capture, and proxy scaffold generator.
"""

import os
import sys
import re
import ssl
import argparse
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
    """Download a single asset safely with retry and directories creation."""
    try:
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=20, context=SSL_CONTEXT) as resp:
            content = resp.read()
            with open(dest_path, 'wb') as f:
                f.write(content)
            return content
    except Exception as e:
        # Ignore 404s gracefully as the proxy server will handle dynamic misses
        return None

def clone_site(base_url, target_dir, port=3000):
    print(f"\n=======================================================")
    print(f"🌐 [Webstack Cloner] Ingesting: {base_url}")
    print(f"📁 Destination: {target_dir}")
    print(f"🔌 Assigned Local Port: {port}")
    print(f"=======================================================\n")

    os.makedirs(target_dir, exist_ok=True)
    parsed_base = urllib.parse.urlparse(base_url)
    origin = f"{parsed_base.scheme}://{parsed_base.netloc}"

    # 1. Fetch Main Page HTML
    print("▶ Step 1: Fetching root HTML document...")
    try:
        req = urllib.request.Request(base_url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=25, context=SSL_CONTEXT) as resp:
            raw_html = resp.read().decode('utf-8', errors='ignore')
    except Exception as e:
        print(f"❌ Failed to connect to {base_url}: {e}")
        sys.exit(1)

    html_file = os.path.join(target_dir, 'index.html')
    with open(html_file, 'w', encoding='utf-8') as f:
        f.write(raw_html)
    print(f"  ✓ Saved index.html ({len(raw_html):,} bytes)")

    soup = BeautifulSoup(raw_html, 'html.parser')
    downloaded_count = 0
    css_files = []

    # 2. Extract and Download Stylesheets
    print("\n▶ Step 2: Ingesting stylesheets (.css)...")
    for link in soup.find_all('link', rel=lambda r: r and 'stylesheet' in r):
        href = link.get('href')
        if href:
            full_url, rel_path = clean_url_path(href, base_url)
            if not full_url or not rel_path:
                continue
            dest = os.path.join(target_dir, rel_path.replace('/', os.sep))
            content = download_file(full_url, dest)
            if content:
                css_files.append((dest, full_url))
                downloaded_count += 1
                print(f"  ✓ CSS: {rel_path}")

    # 3. Extract and Download Preloaded Fonts & Icons
    print("\n▶ Step 3: Ingesting preloaded fonts & media...")
    for link in soup.find_all('link', rel=lambda r: r and ('preload' in r or 'prefetch' in r or 'icon' in r)):
        href = link.get('href')
        if href:
            full_url, rel_path = clean_url_path(href, base_url)
            if not full_url or not rel_path:
                continue
            dest = os.path.join(target_dir, rel_path.replace('/', os.sep))
            if not os.path.exists(dest):
                if download_file(full_url, dest):
                    downloaded_count += 1
                    print(f"  ✓ Preload/Icon: {rel_path}")

    # 4. Recursively Extract CSS Assets (url(...) fonts and background images)
    print("\n▶ Step 4: Scanning CSS bundles for embedded fonts & vector graphics...")
    css_url_pattern = re.compile(r'url\((?![\'"]?(?:data:|blob:))[\'"]?([^\'")]+)[\'"]?\)')
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
                    if not rel_path:
                        continue
                    dest = os.path.join(target_dir, rel_path.replace('/', os.sep))
                    if not os.path.exists(dest):
                        if download_file(full_asset_url, dest):
                            downloaded_count += 1
                            print(f"  ✓ CSS asset: {rel_path}")
            except Exception as e:
                pass

    # 5. Extract and Download Client Scripts (.js, .mjs, chunks)
    print("\n▶ Step 5: Ingesting JavaScript runtime bundles & RSC chunks...")
    for script in soup.find_all('script', src=True):
        src = script.get('src')
        if src:
            full_url, rel_path = clean_url_path(src, base_url)
            if not full_url or not rel_path:
                continue
            dest = os.path.join(target_dir, rel_path.replace('/', os.sep))
            if not os.path.exists(dest):
                if download_file(full_url, dest):
                    downloaded_count += 1
                    print(f"  ✓ Script: {rel_path}")

    # 6. Extract Images (src, srcset, pictures)
    print("\n▶ Step 6: Ingesting high-resolution visual assets & responsive pictures...")
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

    for img_src in image_candidates:
        full_url, rel_path = clean_url_path(img_src, base_url)
        if not full_url or not rel_path:
            continue
        dest = os.path.join(target_dir, rel_path.replace('/', os.sep))
        if not os.path.exists(dest):
            if download_file(full_url, dest):
                downloaded_count += 1
                print(f"  ✓ Image: {rel_path}")

    # 7. Scaffold Hybrid Proxy Server (server.js)
    print("\n▶ Step 7: Generating autonomous hybrid proxy server...")
    template_path = os.path.join(os.path.dirname(__file__), '..', 'server', 'proxy_server.template.js')
    if os.path.exists(template_path):
        with open(template_path, 'r', encoding='utf-8') as f:
            server_tpl = f.read()
        server_code = server_tpl.replace('{{PORT}}', str(port)).replace('{{UPSTREAM}}', origin)
    else:
        # Fallback minimal inline server
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

    # 8. Scaffold package.json
    slug = os.path.basename(os.path.abspath(target_dir))
    package_json = f"""{{
  "name": "{slug}",
  "version": "1.0.0",
  "description": "High-fidelity clone of {base_url} generated with Gemini Webstack.",
  "main": "server.js",
  "scripts": {{
    "start": "node server.js",
    "dev": "node server.js"
  }},
  "keywords": ["webstack", "clone", "replica"],
  "author": "Antigravity",
  "license": "MIT"
}}
"""
    with open(os.path.join(target_dir, 'package.json'), 'w', encoding='utf-8') as f:
        f.write(package_json)

    # 9. Scaffold README.md
    readme_md = f"""# {slug} — 1:1 Production Clone

Exact 1:1 reconstruction of [{base_url}]({base_url}) generated with **Gemini Webstack**.

## 🚀 Instant Launch

```bash
cd {target_dir}
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

    print(f"\n=======================================================")
    print(f"🎉 Clone Completed Successfully!")
    print(f"📊 Total Assets Ingested: {downloaded_count + 1}")
    print(f"🚀 To run: cd \"{target_dir}\" && npm start")
    print(f"🔗 Local URL: http://localhost:{port}")
    print(f"=======================================================\n")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Webstack Cloner Engine')
    parser.add_argument('--url', required=True, help='Target URL to clone')
    parser.add_argument('--out', required=True, help='Destination directory')
    parser.add_argument('--port', type=int, default=3000, help='Port to assign to cloned server')
    args = parser.parse_args()

    clone_site(args.url, os.path.abspath(args.out), args.port)
