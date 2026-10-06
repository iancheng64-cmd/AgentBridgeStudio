#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function run(command, description) {
  console.log(`\n▶ ${description}...`);
  try {
    execSync(command, { cwd: root, stdio: 'inherit' });
  } catch (error) {
    console.error(`\n❌ ${description} 失敗。`);
    throw error;
  }
}

console.log('==========================================');
console.log('🛠️ AgentBridge Studio 環境建置與檢查');
console.log('==========================================');

// 1. 檢查 node_modules
if (!fs.existsSync(path.join(root, 'node_modules'))) {
  run('npm install', '安裝專案依賴套件 (npm install)');
}

// 2. 編譯主程序與前端
run('npm run build', '編譯 TypeScript 主程序與 Vite 前端 (npm run build)');

// 3. 準備內建瀏覽器
const browserRuntimeJson = path.join(root, 'build/runtime-browsers/browser-runtime.json');
if (!fs.existsSync(browserRuntimeJson)) {
  run('npm run prepare:browser', '下載並配置 Playwright 瀏覽器運行環境 (npm run prepare:browser)');
} else {
  console.log('✔ 內建瀏覽器運行環境已就緒。');
}

// 4. 編譯 Swift Computer Use 工具（如果在 macOS 上）
if (process.platform === 'darwin') {
  const nativeBinary = path.join(root, 'vendor/open-codex-computer-use/.build/release/claudex-computer-use');
  let hasSwift = false;
  try {
    execSync('swift --version', { stdio: 'ignore' });
    hasSwift = true;
  } catch {
    hasSwift = false;
  }

  if (hasSwift) {
    if (!fs.existsSync(nativeBinary)) {
      run('npm run build:computer-use', '編譯原生 macOS Computer Use 工具 (npm run build:computer-use)');
    } else {
      console.log('✔ 原生 Computer Use 工具已編譯。');
    }
  } else {
    console.log('⚠️ 未檢測到 Swift/Xcode 命令列工具，略過原生 Computer Use 編譯。');
    console.log('   （如需完整螢幕點擊功能，可在日後執行 xcode-select --install 並重新執行 npm run setup）');
  }
}

console.log('\n✅ 建置完成！隨時可執行 npm start 或 ./start.sh 啟動應用程式。');
