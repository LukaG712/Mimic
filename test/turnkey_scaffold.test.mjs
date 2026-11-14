// test/turnkey_scaffold.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scaffoldCloneManifests } from '../src/engine/cdp_capture.mjs';

const testDir = path.resolve('test-scaffold-dir');
fs.mkdirSync(testDir, { recursive: true });

scaffoldCloneManifests('https://linear.app', testDir, 3003);

assert.ok(fs.existsSync(path.join(testDir, 'server.js')), 'server.js must be created');
assert.ok(fs.existsSync(path.join(testDir, 'package.json')), 'package.json must be created');
assert.ok(fs.existsSync(path.join(testDir, 'README.md')), 'README.md must be created');

const srv = fs.readFileSync(path.join(testDir, 'server.js'), 'utf8');
assert.ok(srv.includes('3003'), 'server.js must bind assigned port');
assert.ok(srv.includes('https://linear.app'), 'server.js must bind upstream');

const pkg = JSON.parse(fs.readFileSync(path.join(testDir, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'test-scaffold-dir');
assert.ok(pkg.scripts && pkg.scripts.start);

fs.rmSync(testDir, { recursive: true, force: true });
console.log('✓ turnkey_scaffold tests passed');
