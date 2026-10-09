# SSH 與 HTTPS/WSS 雙路徑

0.5.0 在 Codex／Claude Runtime 下面共用連線層，保留既有 SSH。Auto 預設 SSH 優先，連線失敗或 Runtime 初始化逾時才改用已配對 Relay；未核對 SSH 指紋／指紋變更不會被繞過。Direct 只用 SSH，Relay 只用 HTTPS/WSS。

Mac 的 Relay 網址必須是標準 `https://hostname`、443、無路徑／query／帳密，WSS 使用相同主機 `/runtime`。Gateway 位於原生 AI CLI 所在設備，透過本機反向代理或 Cloudflare Tunnel 提供 HTTPS；Gateway 本身不需要 SSH。

首次配對：遠端 `Pair` 產生 256-bit 一次性碼，10 分鐘有效，使用一次失效。HTTPS 回傳設備授權，Mac 用 Electron safeStorage（macOS 鑰匙圈支援）加密保存並綁定 profile、HTTPS origin、Runtime ID。Gateway 保存授權雜湊。每次連線換取 5 分鐘 session，僅放在 Authorization header，WSS 更新授權；不放 URL、localStorage 或 log。撤銷設備後既有 socket 也會停止。

Gateway 命令、輸出、Codex JSON-RPC、Claude stream-json、Mac 本機執行器／MCP 反向通道共用 WSS。模型登入仍在遠端，Mac 工作工具仍在 Mac。不在 Mac 啟動另一個 AI CLI 來假裝遠端成功。

HTTPS 檔案上下載採 stream；64 MiB／檔，路徑限制在 Gateway root，跳過 symlink，上傳不覆蓋，取消會清理暫存檔。遠端命令通道可傳輸 stdin/stdout/stderr，不提供 PTY／完整 TUI；原本 SSH 的互動式終端機保留。

WSS／HTTP 握手 10 秒，SSH ready 10 秒，原生 Claude／Codex 初始化仍有各自 RPC 超時。heartbeat 20 秒。網路斷線／恢復或 Mac 喚醒會恢復目前選擇的連線，退避約 1/2/4/8/15 秒；手動中斷、憑證／TLS／身分錯誤會停止自動重試。恢復後保留原生 conversation ID 與 App 歷史，由使用者決定重送；不自動重播任何指令或工具。背景非目前選擇 provider 的連線需切回／手動連線，不能宣稱雙 provider 任務無縫恢復。

Claude 額度：Runtime 透過原生 OAuth 使用的 `/api/oauth/usage` 查詢，白名單回傳 5 小時／7 天／方案提供的分模型額度；`utilization` 為 0–100%，與回合 rate_limit_event 的比例分開解析。60 秒去重與節流，App 連線後及每 2 分鐘更新。API mode、過期登入、服務錯誤顯示未提供／先前快照，不猜剩餘比例。此端點未提供固定公用版本契約，版本變更可能需要更新。

Claude 自動壓縮：原生進程設定 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`，保留更積極的既有門檻；移除本進程 DISABLE_AUTO_COMPACT／DISABLE_COMPACT。原生 `.claude.json` 的 autoCompactEnabled 若為 false，僅把此欄位改為 true，保留其他欄位，無效設定檔不覆寫。變更門檻下一回合以同一 session 重新啟動並套用。實際門檻仍受原生 CLI 上限控制，95% 不代表一定能到 95%；收到 `compact_boundary` 才記錄完成。缺少 postTokens 不捏造壓縮後 token 數。

自訂 API 的一次性金鑰不持久保存；該連線中斷後需要重新輸入，不自動使用其他原生供應商的帳戶。編輯未儲存的設備資訊期間不自動重新登入。
