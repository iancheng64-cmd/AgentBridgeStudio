# 0.4.1 接續修正與驗收

日期：2026-10-03（Asia/Taipei）。本記錄只涵蓋這次「Claude 模型未顯示／兩個 App」修正；不代表所有原生產品功能已完整驗收。

## 修正

- 遠端 Claude 啟動不再把 `--help` 未列出隱藏旗標當成不相容；仍須真正 `initialize` 成功才提供模型。官方 CLI 文件說明 help 不包含所有旗標：https://code.claude.com/docs/en/cli-reference 。
- 模型選擇按 Codex／Claude 分別保存；完整連線目標變更可重試，過期連線結果會關閉而不覆蓋目前選擇。同一失敗設定不會無限自動重試。
- 主程序使用單一執行個體鎖；再次啟動會回到既有視窗。
- 恢復原 App 圖示；版本升至 0.4.1。
- OAuth 測試的合成註冊回應加入 request 的 redirect_uris，符合目前 SDK schema；沒有放寬正式 OAuth 驗證。

## 已驗證

- 完整 renderer／main build 通過。
- npm test：73 項，72 通過、1 跳過、0 失敗。
- npm run test:handoff：4 項通過。
- Claude SSH fixture 驗證 initialize 模型清單、Mac 工具轉送、拒絕操作、取消、登入模式隔離；連線狀態測試覆蓋失敗重試與過期結果。
- 正式 `/Applications/AgentBridge Studio.app` 為 0.4.1，icon.icns 存在。最終 app.asar SHA-256：`684185e215b44c6be1d4bb77554bb9d443fbfaa06e3d2e66e1236b34f2839f27`。
- 原生 UI 讀回來自 /Applications，檔案庫與歷史仍存在。嘗試啟動第二份相同程式後，程序清單仍只有 /Applications 一個主程序；第二份 CUA binding 因程序未保留而逾時，隨後正式視窗仍可讀取。
- 舊正式版與預覽版保留在專案 `.app-backups/20261003-174747/`，副檔名改為 `.bundle`，避免再次被當成 App 啟動。最終建置副本也保留為 `.bundle`；可用的 AgentBridge Studio.app 只保留正式安裝路徑。

## 尚未完成的真實驗收

朋友主機目前由 Tailscale 回報 offline；SSH 22 連接測試逾時，正式 UI 也回報 SSH handshake timeout。因此真實 Windows Claude 模型清單、帳戶可用性與模型回覆尚未驗證。需要朋友電腦開機、未睡眠、Tailscale／SSH 恢復，再於正式 App 的「連線與 Agent」重試。不能用 fixture 通過替代這一步。

## 後續清理

2026-10-03 使用者明確要求釋放 SSD 空間後，已刪除上述舊版備份、重複建置副本、開發依賴、Swift 建置快取、生成的 dist 與本次暫存檔；停止兩個無連線的舊版孤兒 Executor 程序。正式 App、原始碼與使用者資料保留。重新開發需 npm ci 並重建。精確刪除清單與空間讀值見 CLEANUP_2026-10-03.json。
