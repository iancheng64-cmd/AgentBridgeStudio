# Split Runtime 驗收紀錄

更新：2026-10-03（Asia/Taipei），App 0.3.1。工作目錄無 Git metadata；以目前原始碼、產物及實測為準。

## 狀態

| 項目 | 狀態 | 證據與限制 |
|---|---|---|
| Windows SSH、ChatGPT Pro、模型清單 | 使用者截圖確認 | 2026-10-02 畫面顯示 Runtime 0.160.0、已登入、Pro、8 個模型選項。這是使用者提供證據，不代表新版工具路由已通過。首次 host key 畫面只證明待核對流程，不能替使用者核對。 |
| 0.160.0 配對修正 | PASS（本機） | 本版 package.json/package-lock 固定官方 npm 0.160.0；實際包內 codex --version 讀回 0.160.0，包含完整同版執行端。精確允許 0.159.2、0.160.0，未測版本仍封鎖。Windows 0.160.0 不必降版。 |
| 編譯與 DMG | PASS | npm run build 成功；electron-builder 成功產生 dist-split/AgentBridge-Studio-0.3.1-arm64.dmg。Apple Silicon、未經 Apple Developer ID 公證；產物附 SHA-256。 |
| 完整 Node／handoff 測試 | PASS | npm test：41項、40通過、0失敗、1略過（opt-in Calculator）；handoff：4項通過。Calculator 已另以 opt-in 真實桌面實測通過，並非把略過列為通過。 |
| Runtime focused tests | PASS | Astra 最新 19 項測試通過，含精確160允許、161拒絕、執行位置、核准與附件政策。完整測試結果見上一列。 |
| 真 exec-server 與 SSH loopback | PASS（本機） | build/acceptance-evidence/runtime-0.160.0-direct.json、runtime-0.160.0-code-mode.json：同台 Mac 的兩程序、真 SSH2 加密反向轉送，真 app-server→exec-server。模型為隔離合成 Responses SSE，無帳號或模型推論。 |
| 原生命令、檔案與圖片 | PASS（上述路由） | environment/info canonical Mac cwd、shell process marker、讀寫、shell apply_patch、獨立 apply_patch 新增/修改/刪除、view_image 圖片；Runtime sentinel 保持。project 模式3次原生核准。 |
| Mac MCP／電腦／瀏覽器 | PASS（上述路由） | Mac mac_fs_read、native doctor、Playwright browser_tabs；原有 Runtime MCP 禁用並核對 inventory，resume 仍綁定 Mac。沒有將原有 Windows 擴充清單視為可在 Mac 執行。 |
| 禁止回退 Runtime | PASS（版本限定） | 預設環境 none 的負向工具測試不會在 Runtime 執行；exec-server 死亡即關閉 Runtime，新 turn 拒絕。env.toml 覆蓋只檢查存在並拒絕，不讀內容或自動修改。 |
| 附件輸入 | PASS（IPC／協定） | trusted library ID、canonical path、symlink/record substitution 拒絕、PNG magic/MIME、貼圖入庫/縮圖。probe 讀到圖片 bytes dataURL 與一般附件 Mac 路徑；不把 Mac localImage 路徑交 Windows 開檔。 |
| 原生 Calculator 操作 | PASS（本機原生） | 真 MCP 各以背景座標 AXPress、明確 direct 座標完成2+3=5並讀回；截圖方向及游標對齊目視確認。Swift 非對稱像素回歸測試、release build 完成。無 AXPress 背景事件只標示送出、效果未驗證。 |
| 實際桌面 UI | PARTIAL | 先前 CUA 加入合成 PNG 出現正確縮圖，檔案庫2→3；本版 CUA 開啟真正 packaged App、原有檔案庫/SSH設定/工作目錄保留、權限文案與工具頁呈現。新版完整聊天及工具結果仍待真雙機驗收。 |
| macOS 權限 | WAITING（App 程序） | bundled CLI 從開發終端 doctor 回報已授權，但從真正 App 的 doctor 回報輔助使用與螢幕錄製需要授權。兩者程序脈絡不同，不能以開發工具結果宣告 App 已授權。修正 screenRecordingTrusted 欄位解析，使用者須在系統設定允許實際 App。 |
| Windows／Mac 新版完整對話 | WAITING | 新版已開啟、載入已存 SSH 設定，密碼欄空白且未勾儲存。需使用者在 App 輸入密碼重新連接，讀回 Mac executor，進行真 Pro 串流與 Mac 工具驗收。未使用或複製朋友登入憑證。 |

probe 的 completeToolRoutingVerified 保持 false：它不宣告全部內建 namespace、所有模型與兩台機器／真帳號皆已驗證。通過項目只限上述明列路由。

## 可重跑檢查

```sh
npm run build
npm test
npm run test:handoff
node scripts/probe-split-runtime.cjs node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex --project-mode --code-mode --desktop-tools --ssh-transport
```

原生 desktop integration opt-in 測試會開啟本次專用 Calculator 程序，詳見 tests/local-tool-host-native.cjs；一般 npm test 不自動操作使用者桌面。

## 尚需雙機驗收

重新連線後，要求 Agent 回傳 Mac 作業系統與 cwd，讀寫合成測試目錄，在 App 上傳一張合成圖片和文字文件，驗證回覆、工具位置、核准、拒絕及停止。Computer Use 先完成 App 的系統權限。Windows 原生 setup/preflight 腳本及正式 Pro 模型輸出未有本機替代證據。

## 產物核對

打包後 CLI 與原生工具的 SHA-256 與已驗證原始執行檔逐一比對；App 內附0.160.0，不依賴 Mac 的全域 Codex 或 ChatGPT.app。原始碼 ZIP 包含 docs/evidence 的去識別本機 probe JSON，不含短效 token 或登入資料。
