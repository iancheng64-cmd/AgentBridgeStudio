# AgentBridge Gateway 0.5.0

將 AI Runtime 接到 AgentBridge Mac App 的 HTTPS/WSS 方案。Gateway 使用 Runtime 擁有者的帳號啟動原生 Codex／Claude Code，不使用 SSH。

## Windows x64

解壓縮 `AgentBridge-Gateway-0.5.0-windows-x64.zip`：

1. 雙擊 `Install.cmd`，複製到 `%LOCALAPPDATA%\AgentBridgeGateway` 並啟動 Gateway。這個視窗需保持開啟。
2. 先在該 Windows 使用者帳戶登入原生 Codex／Claude Code；選 Codex 時需相容的 0.160.0 Runtime。Gateway 包含 Node.js、WebSocket 套件與 cloudflared，不會另外下載這些元件。AI CLI、AI 訂閱與登入不是 Gateway 的一部分。
3. 依附帶 `CLOUDFLARE_TUNNEL.md` 設定公開 HTTPS 網址。沒有網域時可先用 `QuickTunnel.cmd` 暫時測試；請從視窗取得網址，重啟後網址會改變。
4. 双擊 `Pair.cmd` 產生 10 分鐘內有效的一次性配對碼；只貼到你自己的 Mac App「設定 → 連線與 Agent → Relay 網址／一次性配對碼」。不需提供 Windows 密碼。
5. App 選「只用 HTTPS / WSS」並連線。若兩條路都已設定，可選「自動」。SSH 資訊和 Relay 配對各自獨立。

## Apple Silicon Mac

解壓縮 Mac Gateway 包，開啟 `StartGateway.command`、`Pair.command`；其餘設定相同。Gateway 套件含自己的 Node，不需另裝 npm。Mac App DMG 的本機工作工具與 Gateway 是不同角色。

## 設定與移除

把 `config.example.json` 複製為 `config.json` 可改工作資料夾及埠；預設使用目前使用者家目錄及 8787。Gateway 始終只監聽 loopback。無需開放路由器入站埠、不修改防火牆、不開啟遠端登入。

Gateway 主機會保存設備授權的雜湊。若要撤銷設備，在 Gateway 資料夾執行內建 Node：`node gateway.cjs --revoke DEVICE_ID`。Mac 上移除設備也會清除該 App 的加密配對；兩端都撤銷最完整。

關閉 Gateway／Tunnel 視窗即停止服務，**沒有自動安裝背景服務**。Windows 要移除，先關閉視窗，再刪除 `%LOCALAPPDATA%\AgentBridgeGateway`；若也刪除家目錄 `.agentbridge-gateway`，會撤銷所有既有配對。

## 信任與功能界線

只有主機擁有者產生配對碼；配對允許該設備執行 Runtime 命令與工作資料夾內的檔案傳輸。勿把配對碼、設備授權或 Tunnel 憑證放入 GitHub。Mac 要先正常完成 macOS 權限授權。Gateway 不會把 AI 登入憑證傳回 Mac。

Claude 訂閱額度從 Runtime 的原生 OAuth 登入唯讀查詢，只回傳允許的數值欄位。這是原生 CLI 使用的未版本化端點；服務或登入狀態變更時會顯示錯誤／先前快照。API 模式不提供訂閱額度。自動壓縮仍由原生 Claude 執行，原生開關若明確停用，App 會啟用該單一設定，保留其餘設定。

本版 HTTPS 命令通道提供指令／輸出串流，沒有完整 PTY；完整互動式 TUI 用原本 SSH 終端機。HTTPS 檔案傳輸上限 64 MiB，上傳不覆蓋同名檔。睡眠／斷線的工作保留歷史並標記中斷；恢復連線不會自動重做先前指令。
