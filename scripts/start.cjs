#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const mainJs = path.join(root, 'dist-main/main.js');
const browserRuntimeJson = path.join(root, 'build/runtime-browsers/browser-runtime.json');

// 若尚未編譯或環境未就緒，自動執行 setup
if (!fs.existsSync(mainJs) || !fs.existsSync(browserRuntimeJson)) {
  console.log('⚡ 偵測到首次啟動或缺少編譯產物，正在自動執行建置...');
  const setupResult = spawnSync(process.execPath, [path.join(__dirname, 'setup.cjs')], {
    cwd: root,
    stdio: 'inherit'
  });
  if (setupResult.status !== 0) {
    process.exit(setupResult.status || 1);
  }
}

// 尋找 electron 執行檔路徑
const electronBin = path.join(root, 'node_modules/.bin/electron');
const electronCmd = process.platform === 'win32' ? `${electronBin}.cmd` : electronBin;

console.log('🚀 正在啟動 AgentBridge Studio...');
const child = spawn(electronCmd, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code || 0);
  }
});
