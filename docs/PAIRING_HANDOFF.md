# Windows Runtime／Mac 前端與工具交接

更新：2026-10-03（Asia/Taipei），App 0.3.1。

Windows 保留 Runtime、已有 ChatGPT 登入及模型請求；Mac 執行完整 App、附件與工具；OpenAI 服務執行模型運算。不要求 Mac API key，不複製 Windows auth.json、OAuth token、cookie 或 SSH 私鑰。

## 現有 Windows 0.160.0

使用者截圖顯示 Windows Runtime **0.160.0** 已連線、Pro 已登入並回傳模型清單。舊 Mac 包只有 0.159.2，造成配對失敗。新版 Mac App 0.3.1 內建 **0.160.0**，同版真 exec-server 及 SSH 轉送已通過本機測試，Windows 不必降版。

1. Mac 開啟新版 App，選取現有 SSH 設定與 Mac 工作資料夾。
2. 選擇 Windows 已有的 0.160.0 執行檔，重新連線。
3. 如需首次信任，請朋友從 Windows 核對 SSH host key 的 SHA-256 指紋；一致才由使用者信任。
4. 狀態卡確認 Runtime 0.160.0、Mac 執行端已連線、Mac 工作目錄正確。
5. 依下面清單驗證真實對話及工具，登入成功不代表工具已接管。

需隔離安裝時，Windows 執行 `scripts/setup-windows-runtime.ps1`，將輸出的 `appRuntimeExecutable` 填入 Mac App。它安裝官方 npm Codex 0.160.0，不更動全域 CLI、SSH、防火牆，不讀登入憑證。需 Node.js/npm；Windows 原生腳本尚未實機驗證。唯讀預檢可用 `scripts/runtime-preflight.ps1`。

## 給朋友 Codex 的工作指示

請在原始碼 ZIP 解壓後的 AgentBridgeStudio 工作目錄讀本文件及 SPLIT_RUNTIME_RESEARCH.md，確認 Windows Codex 0.160.0、同一位已授權使用者的 ChatGPT 登入及可供 Mac 存取的 SSH 服務。已有同版不必重裝，需隔離安裝才執行 setup-windows-runtime.ps1。回報實際執行檔路徑及預檢結果，不回傳密碼、私鑰、登入檔、token 或完整環境變數。Mac 更新至 App 0.3.1 後協作驗證下列項目。

## 執行位置與權限

前端至 Windows 使用 SSH App Server stdio JSON-RPC，不公開 App Server WebSocket。Windows 至 Mac 使用 SSH loopback 反向轉送的認證式 exec-server，短效 token 隨程序生命週期失效。thread、turn、resume 均指定 Mac 環境；Mac MCP 綁定同一環境及專用 bearer token。

Code Mode Host 只提供 JS 執行，不足以把 shell／檔案搬到 Mac，本 App 以 exec-server 環境路由處理。Windows 預設環境以 `CODEX_EXEC_SERVER_URL=none` 停用。若 Runtime CODEX_HOME 存在 environments.toml，App 只檢查存在、不讀取或修改，拒絕啟動以避免覆蓋 Mac 路由，由 Windows 擁有者決定如何停用該設定。版本未驗證或執行端失連，都不回退 Windows。

Mac 專用檔案工具限工作資料夾，附件庫唯讀；GUI、瀏覽器和 shell 不因此成為 OS 沙盒。預設可自動讀專案，其他 MCP 操作先核准；命令由 Codex 權限規則處理，部分唯讀命令可自動執行。完整模式跳過相應工具核准，須在 App 明確選擇，重連才生效。

## 雙機驗收

- 初始化並讀回 ChatGPT 登入、Pro 方案、模型清單。
- 建立對話、顯示真實串流回覆、停止工作。
- Agent 回傳作業系統、工作目錄和識別檔內容，確認都屬 Mac。
- 在 Mac 合成測試目錄建立、修改和讀回識別檔，Windows 原有檔案不受影響。
- 聊天框上傳文件及圖片，圖片 bytes 及文件 Mac 路徑可用，不把 Mac localImage 路徑當 Windows 路徑。
- 電腦觀測、瀏覽器操作發生在 Mac，結果在 App 顯示。所需 macOS 權限由使用者在系統設定完成。
- 核准、拒絕、取消返回 Runtime，拒絕後不執行待核准寫入。
- 失連不能在 Windows 繼續操作或顯示假成功，重連後歷史仍可辨識。

記錄 PASS／FAIL／WAITING。相同 Mac 的兩程序及真 SSH 測試不能稱 Windows／Mac 雙機通過，合成輸出也不能稱 Pro 對話。

官方依據：[App Server](https://learn.chatgpt.com/docs/app-server)、[0.160.0 Release](https://github.com/openai/codex/releases/tag/rust-v0.160.0)。具體協定以同版源碼與測試為準。
