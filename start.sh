#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=========================================="
echo "🚀 正在準備 AgentBridge Studio..."
echo "=========================================="

# 1. 檢查 Node.js 是否已安裝
if ! command -v node &> /dev/null; then
  echo "❌ 錯誤：未找到 Node.js。"
  echo "請先安裝 Node.js（推薦 Node.js 22 LTS 或 20+）："
  echo "  • 使用 Homebrew 安裝: brew install node"
  echo "  • 或前往官網下載: https://nodejs.org/"
  exit 1
fi

# 2. 檢查是否需要安裝依賴
if [ ! -d "node_modules" ]; then
  echo "📦 正在安裝專案套件依賴 (npm install)..."
  npm install
fi

# 3. 執行啟動（自動檢查編譯並啟動 Electron）
npm start
