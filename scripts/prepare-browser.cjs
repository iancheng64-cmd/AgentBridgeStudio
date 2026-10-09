#!/usr/bin/env node
// Developer/build-time download only. End users receive these files inside the DMG.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'build/runtime-browsers');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This release supports an Apple Silicon macOS build host.');
process.env.PLAYWRIGHT_BROWSERS_PATH = destination;
const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
const result = spawnSync(process.execPath, [cli, 'install', 'chromium', '--no-shell'], {stdio: 'inherit', env: process.env});
if (result.status !== 0) process.exit(result.status || 1);
const {chromium} = require('playwright-core');
const executable = chromium.executablePath();
fs.accessSync(executable, fs.constants.X_OK);
const relative = path.relative(destination, executable);
if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unexpected browser installation path');
fs.writeFileSync(path.join(destination, 'browser-runtime.json'), JSON.stringify({
  executable: relative, architecture: process.arch,
  playwrightVersion: require('playwright-core/package.json').version,
  browser: require('../node_modules/playwright-core/browsers.json').browsers.find(b => b.name === 'chromium')
}, null, 2) + '\n');
console.log('Browser prepared for packaging; no runtime download is required.');
