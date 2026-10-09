# 驗收記錄

日期：2026-09-29  
範圍：目前三份自動化測試與 main/protocol 型別檢查；桌面 UI 驗收等新版 App 啟動完成後執行。

## 已完成

| 項目 | 執行方式 | 結果 |
|---|---|---|
| Chat protocol | `node --test tests/chat-protocol.test.cjs`（併入三套測試執行） | 通過 7 項：Codex 多訊息/工具活動、UTF-8 中文 chunk 邊界、Claude partial 到 final 不重複、CLI error、尾端無 newline、Codex/Claude resume 與對話 ID 驗證、shell quoting。 |
| Desktop backend | `node --test tests/desktop-backend.cjs`（併入三套測試執行） | 通過；包含 Library 管理副本/持久化/刪除、送出前上傳、prompt 只走 stdin、session/completion、提前取消、CLI 失敗。 |
| Extensions | `node --test tests/extensions.cjs`（併入三套測試執行） | 通過；包含本機/遠端 metadata-only 掃描、快取與設定狀態區分、manifest fallback、憑證/URL 排除。 |
| 三套自動化測試 | `node --test tests/desktop-backend.cjs tests/extensions.cjs tests/chat-protocol.test.cjs` | 全部通過：9 tests、0 failures。 |
| Main + protocol TypeScript | `./node_modules/.bin/tsc -p tsconfig.main.json` | 通過，退出碼 0，沒有診斷。 |

三份測試輸出均已在 2026-09-29 本機執行。chat protocol 測試使用目前編譯於 `dist-main/chat-protocol.js` 的 parser；main typecheck 隨後由 `tsconfig.main.json` 重新編譯。

## 待執行

前端檔案當日仍有修改，依主代理安排暫緩完整 Vite build 與 UI 操作。新版 App ready 後，使用 `cua_repl` 對該新版實際視窗驗收；不以 DOM 或 Playwright 代替真實 UI 操作。

- [ ] 前端 TypeScript 檢查與 `npm run build`。
- [ ] 離線時側欄每個頁面都能開啟並呈現合理狀態。
- [ ] Composer「＋」原生檔案選擇器、附件顯示/移除；加入本機 Library，重啟後 metadata 仍存在。
- [ ] 歷史搜尋、重命名、封存；資料更新後側欄狀態一致。
- [ ] Settings 主題與 reduced-motion 設定可切換並持久化。
- [ ] 窄視窗下側欄/主內容/Composer 不互相遮擋，仍可用鍵盤操作。
- [ ] MCP、Skills、Plugins 顯示實際掃描清單與連線/未連線狀態。

UI 測試附件：`build/acceptance-fixtures/attachment-test.txt`（主代理提供；可用原生 file picker 選取）。

## 驗收限制

未直接操作 `/Applications/ChatGPT.app` 作為參照；本機 CUA 對該 bundle id 有安全限制。設計基準取自 `docs/CHATGPT_FEATURE_MATRIX.md` 內列出的 OpenAI 官方文件。UI 驗收只針對 AgentBridge Studio 新版視窗，且需等主代理確認啟動完成。

---

# 設計重構：apple-design 套用（2026-09-30）

依 `apple-design` skill 重做介面層。分兩類記錄：**已用實際視窗驗證**、**僅經型別與邏輯驗證**。

## 已完成並實機驗證

| 項目 | 驗證方式 | 結果 |
|---|---|---|
| Build | `npm run build`（tsc renderer + vite + tsc main） | 通過 |
| 測試 | `npm test` | 11 tests、0 failures |
| 側邊欄 1:1 拖曳 | CDP `Input.dispatchMouseEvent` 逐步取樣 | 每一步 drift = 0px |
| 拖曳釋放速度交接 | 391 → 387 → 383 → 380 | 無跳動、無接縫 |
| 橡皮筋邊界 | 拖過上限 610px | 讓位量 5 → 178px 遞增衰減，落回 380 |
| 收合／展開 | ⌘B 循環 | 260 → 0 → 260，overlap 皆為 0 |
| 鍵盤調整 | 分隔器 focus + ArrowRight／Enter | 生效 |
| 材質套用 | 讀 computed style | sidebar/topbar `rgba(240,240,239,.8)` + `blur(30px) saturate(1.8)` |
| 字級 token | 讀 computed style | h1 `29px / -0.638px / 34.22px`（-0.022em / 1.18） |
| 捲動邊緣淡入 | 捲動前後取樣 opacity | 0 → 1，停止後 520ms 清除 |
| Engine Doctor | 實際執行 `local:doctor` | 10 項檢查，權限與端點狀態正確區分 ok/warn/unknown |
| 曝光模式 | 讀 resolved state | 預設 tailscale，綁 `100.114.13.35` |
| Transfer Center | 注入四種狀態 markup | 四列狀態色、進度、錯誤訊息、重試鈕皆正確 |
| 深色模式 | 實際切換 | 材質階層正確 |

## 修正的既有缺陷

1. **Playwright MCP 硬編 `--host 0.0.0.0` 與 `--allowed-hosts "*"`** — 無視使用者設定直接對所有介面公開，且放寬 Host header 檢查（DNS rebinding）。改為依曝光模式決定綁定位址，allowed-hosts 改為明確位址清單。
2. **Supergateway 無法指定綁定位址** — 維持 loopback，前面加一層 byte relay，只在選定的介面上開 8932。
3. **OAuth forward 接受任意 port** — 補上 1024–65535 整數驗證。
4. **`.exposure-option` 內的 radio 繼承 `width:100%`** — 由 base layer 的 `.section-card input` 造成，控件被撐滿且圖示置中。
5. **分隔器命中區只有 7px** — 放在 `<aside>` 內被 `overflow:hidden` 與 1px border 裁切。移到 `<aside>` 外層後為完整 16px。
6. **收合時殘留 25px 空隙** — `border-box` 下 `width:0` 仍會解出 padding+border。收合時一併歸零 padding 與 border。
7. **transfer 進度條以 0.15s tween 追趕真實值** — 條永遠落後資料。改為直接寫入寬度，只有狀態顏色做變化。
8. **Computer Use 示意游標 6 秒無限循環** — 約 0.17Hz，屬應避免的環境式振盪。改為使用者觸發、單次播放。
9. **失敗的 transfer 無法手動重試** — 新增 `retry` 動作，從既有續傳點接續，不重送已到達的位元組。
10. **Token 層被 base layer 蓋掉** — `styles.css` 與 `tokens.css` 匯入順序相反，設計 token 完全失效。

## 未驗證

- Transfer Center 的實際 SFTP 傳輸（需要可連線的遠端工作站）。元件邏輯經型別檢查，樣式與狀態以注入 markup 驗證，續傳邏輯沿用既有 `uploadOneFile`／`downloadOneFile` 的 partial file 長度計算。
- `prefers-reduced-transparency` 與 `prefers-contrast: more` 僅有 CSS 實作，未在對應系統設定下實機截圖。
- 曝光模式切換後的實際重啟套用流程。
