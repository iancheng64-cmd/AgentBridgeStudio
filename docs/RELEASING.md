# 發布到 GitHub

## 使用本次產物

1. 解壓 `AgentBridgeStudio-0.4.7-source.zip`。將其中 `AgentBridgeStudio/` 目錄的內容放進新 GitHub 儲存庫，包括 `.gitignore` 與 `.github/workflows/`。
2. 不要直接上傳原工作資料夾；它含歷史本機證據與建置資料。不要把 DMG、node_modules 或個人設定提交進 Git。
3. 建立 tag `v0.4.7` 的 GitHub Release，將 DMG、來源 ZIP、SHA256SUMS.txt 附加在 Release assets。
4. 將 RELEASE_NOTES.md 作為版本說明。發布本次 DMG 時必須標示「Apple Silicon；ad-hoc signed；not notarized」，不能標示 Apple 公證。
5. 發布前讓另一位 Mac 使用者下載測試：Gatekeeper、首次啟動、系統權限、其自己的遠端 Runtime 以及真實模型／工具任務。本機測試不能替代跨機驗收。

## 重建

Apple Silicon macOS 建置者安裝 Node.js 22、Python 3 與 Xcode Command Line Tools 後：

```sh
npm ci
npm run dist
npm test
npm run test:handoff
python3 -m unittest discover -s tests -p 'test_package_public.py'
npm run package:public
```

原生工具最低 target 為 macOS 13。瀏覽器按 package-lock.json 配對，在建置時下載並內建；執行 App 不會下載。不要更新個別 CLI／瀏覽器二進位後沿用舊驗收結果。

本機包內元件檢查（不使用專案 node_modules，也不借用全域瀏覽器）：

```sh
ELECTRON_RUN_AS_NODE=1 'dist/mac-arm64/AgentBridge Studio.app/Contents/MacOS/AgentBridge Studio' scripts/check-installed.cjs 'dist/mac-arm64/AgentBridge Studio.app/Contents/Resources'
codesign --verify --deep --strict 'dist/mac-arm64/AgentBridge Studio.app'
```

檢查會啟動包內 MCP，以獨立新瀏覽器設定檔讀取 loopback 測試頁，並在結束時停止本次子程序。它不登入帳號、不送出模型請求、不讀取私人網站資料。

## Developer ID 簽章與公證

若要讓一般網路下載者不用處理未驗證開發者提示，需 Apple Developer Program 的 Developer ID Application 憑證與 Apple 公證。提供的簽章路徑必須以真實資格驗證，不能把 ad-hoc 的完整性驗證當成公證。

GitHub Repository Secrets：

| Secret | 用途 |
| --- | --- |
| CSC_LINK | Developer ID Application `.p12` 的 base64 或 electron-builder 支援的憑證位置 |
| CSC_KEY_PASSWORD | 憑證密碼 |
| APPLE_API_KEY_CONTENT | App Store Connect 公證 API `.p8` 的完整內容；工作流程寫入權限 0600 的暫存檔，再把其路徑提供給 electron-builder |
| APPLE_API_KEY_ID | API key ID |
| APPLE_API_ISSUER | API issuer ID |

不要把密碼、憑證或 `.p8` 提交到儲存庫，也不要放在 issue、README 或聊天裡。本機建置的 `APPLE_API_KEY` 必須是 `.p8` 檔案路徑，不是金鑰內容。工作流程使用 `AGENTBRIDGE_SIGNED_RELEASE=1` 才開啟簽章與公證，缺少所需資格會直接失敗。

執行 GitHub Actions 的 **Build macOS release**，勾選 `signed`。預設只產生 Actions artifact；只有另外勾選 `draft_release` 才建立草稿 Release，不自動公開發布。工作流程目前設定 `macos-14` arm64 runner；主機架構檢查失敗時停止，不能產生混用架構的 App。

確認 App 與 DMG 的 Gatekeeper 驗證、stapled ticket 及下載後啟動成功，再把草稿公開。簽章資源實際可用前，這條公證路徑屬待驗證，不保證 CI 已成功。

參考：[Electron 簽章](https://www.electronjs.org/docs/latest/tutorial/code-signing)、[Apple 公證](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)、[GitHub macOS runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
