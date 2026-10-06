# 0.4.7 發布驗收

驗收日期：2026-10-06。環境：Apple Silicon、macOS 27.0。本頁描述本次實測結果；最低系統宣告為 macOS 13，未代表已在該版本或所有 Mac 上驗收。

## 已驗證

| 項目 | 結果 |
| --- | --- |
| TypeScript、前端與主程序建置 | 通過 |
| 原生工具 release 編譯 | 通過，三個 helper 都包含在 App |
| Node 測試 | 103 項：102 通過、0 失敗、1 跳過；跳過項為原本需額外啟用的原生測試 |
| 來源交接封裝測試 | 4 項通過 |
| 公開封裝隱私／symlink 排除測試 | 1 項通過 |
| DMG | 建立成功、映像完整性驗證通過，包含 App、Applications 捷徑與安裝指南 |
| 安裝副本 | 從唯讀 DMG 複製 App，嚴格簽章完整性驗證通過 |
| Codex 本機執行器 | 包內執行檔回報 0.160.0 |
| 原生 Computer Use | 包內 MCP 握手及唯讀 doctor 呼叫成功，回報 23 個工具 |
| 瀏覽器 | 包內 MCP 回報 45 個工具；內建瀏覽器開啟本機測試頁，並讀回預期標題文字 |
| 不依賴外部安裝 | 驗收使用包內 Electron／Node；PATH 僅含系統路徑、瀏覽器快取為獨立空目錄、禁止執行期下載 |
| 首次設定／介面 | 空白使用者資料可正常顯示完整主介面，沒有既有聊天或設備；預設內建 Computer Use、本機曝光模式 |
| GUI 工具檢查 | 原生電腦工具已回應、瀏覽器分頁讀取成功，介面顯示接通 |
| 選用 HTTP 端點 | GUI 啟動後使用真實 MCP 用戶端讀取：電腦 23、瀏覽器 45 個工具；僅監聽 loopback |
| 公開來源 | 使用明確允許清單，含 README、授權、公開文件及 GitHub workflow，排除私人證據、聊天、設備、金鑰與建置快取 |

最終 Release 附件包含 `INSTALL_CHECK.json` 與 `SHA256SUMS.txt`。JSON 的權限結果僅反映驗收 Mac 已有授權；新使用者仍須自行授予 macOS 權限。工具握手、doctor 及分頁讀取成功，不代表已對每種 App 的點擊、鍵盤或完整 AI 任務逐項驗證。

## 尚未驗證／不包含

- 無可用 Developer ID 簽章憑證；本次 DMG 為 ad-hoc signed、**not notarized**。完整性檢查不是 Apple 公證。
- 未從 GitHub 網路下載到另一台 Mac 驗證 Gatekeeper、首次授權及跨機啟動。發布前需要這項實際驗收。
- 沒有為本次發行重新測試使用者的遠端帳號、真正的模型回覆或完整模型到 Mac 工具任務；安裝後仍須設定已登入、版本相容的遠端 Runtime。
- Intel Mac 發行檔、macOS 13 實機測試尚未提供。
- GitHub Actions 與 Developer ID／公證路徑已提供設定，但尚未在 GitHub 或使用真實簽章資格執行。

請把上述界線保留在 GitHub Release 說明，不要將本機成功宣稱為所有 Mac、帳號與工作均已通過。
