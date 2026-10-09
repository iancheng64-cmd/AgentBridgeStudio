# AgentBridge Studio
0.5.7 修正最高權限的資料夾限制、未送出草稿遺失、模型偏好重設及雙 Agent 另開對話。保留先前停止接續、SSH、額度与長對話修正；實測界線見 [發布前檢查](docs/PUBLISH_READINESS.md)。

[繁體中文](README.md) · [English](README_EN.md)

在 Mac 上與 Codex、Claude Code 對話，讓 Agent 處理**這台 Mac** 的檔案、命令、應用程式與網頁。模型 Runtime 與登入保留在你選擇的遠端主機，工作工具在本機執行。

**版本 0.5.6 · Apple Silicon · macOS 13 或更新版本**

> 這是遠端 Runtime 用戶端。安裝後不用另外下載 Node.js、Python、Homebrew、Codex Mac 執行器、Computer Use MCP 或瀏覽器；第一次使用仍須填入可連線、已登入的遠端 Runtime，並授予 macOS 所需權限。它不包含免費 AI 帳號或離線模型。

## 0.5.7：可執行任務的內建工具

新增容錯檔案／內容搜尋、精準文字編輯、可追蹤命令、內建 Node 執行、任務進度保存、公開網頁讀取，以及 MCP 資源／提示範本。這些核心能力包在 App 內，無須另外下載工具。Codex 與 Claude 使用相同的 Mac 工具通道；一般模式仍會依操作請求授權，最高權限模式套用既有設定。

直接描述工作即可。AI 可保存任務目標、步驟及下一個動作；停止後在原對話補充要求繼續。命令輸出有上限與查詢游標，停止／回合結束／斷線會取消該通道啟動的命令。資料夾搜尋遇到無權讀取的子目錄會繼續，並回報搜尋範圍不完整。

[能力與限制](docs/AGENT_CAPABILITIES.md) 區分內建功能、已接通 MCP 和選用外部依賴。GitNexus 等第三方工具不隨此 DMG 安裝；若專案明確要求，需另外接通指定工具，不能用其他搜尋冒充。遠端原生帳戶與 macOS 權限仍須設定。

## 0.5.6 穩定性修正

最高權限不再受工作資料夾範圍限制，檔案讀取可指定任何絕對路徑。需要 root 的唯讀操作可透過 macOS 系統視窗輸入管理員密碼；不將密碼交給模型，不讓整個 App 長期以 root 執行。完整磁碟存取、SIP 與磁碟權限仍適用。

未送出的文字與附件按對話保存，切換對話、正常關閉與重新啟動後可以繼續編輯。各 Agent 的模型及推理強度保留；雙 Agent 暫停後使用同一對話與有界歷史接續。

停止後可在同一個對話輸入補充要求，優先恢復原生對話；若重開 App、換設備、目錄或沒有原生識別碼，使用本機文字上下文在同一個對話接續。恢復文字包含最初目標與最近進度，最多 24,000 字元；完整本機紀錄保留，過去的工具與附件不重播。停止在初始化階段也會解除忙碌狀態。

登入未完成時顯示黃色狀態及輸入框旁的處理入口，保留草稿。朋友完成原生登入後，按「重新檢查登入」或再次發送即可重新查詢，下一回合重新載入原生憑證。查詢失敗與真正未登入分開；防止登入檢查期間重複 Enter 產生多個請求。

長訊息分段顯示，長對話可查看前後訊息；完整文字仍可複製及匯出。串流文字合併更新，已完成的訊息不重複解析。對話改為本機檔案保存，只寫入變動的對話；舊紀錄成功遷移後才移除舊儲存鍵，關閉視窗會等候最後一次保存。

## 0.5.0 新增

- SSH 與 HTTPS/WSS 雙路徑：設定可選「自動／只用 SSH／只用 HTTPS」，共用 Codex 與 Claude Runtime。
- 遠端 Gateway 安裝包（Windows x64、Apple Silicon Mac），內含 Node、WebSocket 套件、cloudflared；不用另裝這些相依工具。原生 AI CLI 與帳戶仍由遠端主機擁有者提供。
- Claude 官方訂閱額度獨立查詢，5 小時／7 天及方案提供的分模型額度、更新時間、過期／錯誤狀態；API 模式不假造訂閱剩餘比例。
- Claude 原生自動壓縮門檻下一回合生效，壓縮事件保存在對話；原生門檻可能比選項更早。
- 斷線恢復目前選擇的連線，保留歷史，操作不自動重送。

[HTTPS 設定](docs/networking/RELAY.md) · [Cloudflare Tunnel](docs/networking/CLOUDFLARE_TUNNEL.md) · [連線診斷](docs/networking/NETWORK_DIAGNOSTICS.md) · [Gateway 安裝](gateway/README.md)

Mac 使用標準 HTTPS/WSS 443；Cloudflare Tunnel 所在的遠端設備仍需可用的 7844 出口。HTTPS 遠端命令通道未提供完整 PTY，完整 TUI 保留 SSH。功能與實測界線詳見 [發行驗收](docs/RELEASE_ACCEPTANCE.md)。

## 🏗️ 架構與實現原理 (Architecture & How It Works)

AgentBridge Studio 採用 **「大腦與手腳分離 (Split-Execution)」** 的雙端解耦設計：**遠端主機負責 AI 模型推理與對話上下文，本機 Mac 負責安全執行真實世界工具與系統操作**。

```mermaid
flowchart TD
    subgraph Local["🖥️ 使用者 Mac (Local Client)"]
        UI["桌面應用介面 (Electron / React 19)"]
        Core["本機執行核心 (Local Executor)"]
        
        subgraph Tools["本機工具箱 (Local Tools)"]
            FS["檔案與 Shell (依權限模式)"]
            CU["原生 Computer Use (Swift / AXUIElement)"]
            Browser["獨立 Playwright (Chromium 隔離無痕)"]
            MCPGateway["本機 MCP 通訊網關 (127.0.0.1 Loopback)"]
        end
        
        UI <--> Core
        Core --> Tools
    end

    subgraph Tunnel["🔒 加密通訊通道"]
        SSH["SSH 或 WSS 反向工具通道"]
    end

    subgraph Remote["☁️ 遠端主機 (Remote Runtime)"]
        Daemon["Codex 0.160.0 App-Server / Claude Code CLI"]
        LLM["AI 模型提供商 (OpenAI / Anthropic API)"]
        Daemon <--> LLM
    end

    UI <-- SSH 或 HTTPS 配對 --> Daemon
    Daemon <-- 工具呼叫轉發 --> SSH --> Core
```

### 核心實現原理

1. **遠端推理，憑證不落地 (Remote Runtime & Credential Isolation)**
   * 原生 AI 登入憑證留在遠端 Runtime；App 在 Mac 保存自己的聊天歷史與附件。
   * 自訂 API 模式輸入的金鑰只用於這次連線，不持久保存；斷線後需要重新輸入。
   * SSH 連線憑證與 Relay 設備授權透過 macOS Keychain 支援的加密機制保存。

2. **安全反向隧道 (Reverse Loopback Tunneling)**
   * App 透過安全的 SSH 連線與遠端主機握手，並驗證主機公鑰指紋以防止中間人攻擊 (MITM)。
   * SSH 反向連接埠轉發或已配對的 WSS 通道將遠端工具請求回傳至本機。
   * 本機端點嚴格限制於 `127.0.0.1` 迴路，阻止任何來自外網或未授權局域網的非法存取。

3. **零依賴全內建模組 (Self-Contained Native Subsystems)**
   * **原生 Computer Use**：以 Swift 語言開發，直接透過 macOS Accessibility APIs (`AXUIElement`) 與 Quartz 顯示服務截取螢幕與模擬事件，並具有即時畫面覆蓋游標 (Overlay Cursor)，效能極致且不依賴外部 Python/Node 套件。
   * **隔離式瀏覽器引擎**：內建 Playwright 專用 Chromium 與 FFmpeg，具備獨立 User Data Profile，不讀取、不污染使用者日常 Chrome/Safari 的 Cookies 與隱私資料。
   * **路徑嚴格校驗**：本機工作目錄具備防路徑穿越 (Path Traversal) 與符號連結限制，防止危險的系統根目錄竄改。

4. **系統級權限邊界 (Operating System Permission Boundary)**
   * App 內的「最高權限」模式僅控制是否彈出重複確認對話框，無法繞過 macOS 系統層級的「輔助使用」與「螢幕錄製」隱私安全防護，嚴格遵循 Apple 系統安全模型。

## 快速開始 (Quick Start)

你可以選擇直接下載打包好的 DMG 執行，或透過 Git Clone 從原始碼直接執行。

### 方式一：在 Mac 從原始碼執行（開發者）

複製專案並執行內建的一鍵啟動腳本：

```sh
git clone https://github.com/iancheng64-cmd/AgentBridgeStudio.git
cd AgentBridgeStudio
./start.sh
```

或使用 npm：

```sh
git clone https://github.com/iancheng64-cmd/AgentBridgeStudio.git
cd AgentBridgeStudio
npm install
npm start
```

> **說明**：`./start.sh` 與 `npm start` 會自動檢測環境、安裝依賴、編譯 TypeScript/Vite，並配置 Playwright 瀏覽器運行環境，即使初次 Clone 也能一鍵完整啟動。
> 若需使用原生 macOS Computer Use（滑鼠點擊/畫面辨識），請確保系統已安裝 Xcode Command Line Tools（執行 `xcode-select --install`）。

### 方式二：下載打包好的 DMG 安裝檔（免編譯）

到這個儲存庫的 **[Releases](https://github.com/iancheng64-cmd/AgentBridgeStudio/releases)** 頁，下載最新版 `AgentBridge-Studio-0.5.6-arm64.dmg`。

1. 打開 DMG，將 **AgentBridge Studio** 拖到 **Applications**。
2. 從「應用程式」開啟 App；不要直接在 DMG 中執行。
3. 本發行檔尚未 Apple 公證；若 macOS 阻擋，先確認下載来源與校驗值，再依系統提示於「隱私權與安全性」處理。
4. 到「設定 → 連線與 Agent」，新增遠端設備，選擇 Codex 或 Claude Code；填入 SSH 資訊，或配對 HTTPS Gateway。
5. 選擇這台 Mac 的工作資料夾，連接 Runtime。SSH 首次連線需核對主機指紋；HTTPS 使用遠端產生的一次性配對碼。
6. 如需看螢幕、點擊或輸入，到「電腦與工具」請求並檢查「輔助使用」及「螢幕錄製」權限。

詳細步驟及故障排除：[安裝指南](docs/INSTALLATION.md)。

## 安裝檔包含什麼

| 元件 | 是否內建 |
| --- | --- |
| 桌面 App、Electron 與 Node 執行環境 | 是 |
| Mac Codex CLI／配對執行器 0.160.0 | 是 |
| 原生 Computer Use、CLI 與畫面 overlay helper | 是 |
| Playwright MCP 與版本配對的瀏覽器、FFmpeg | 是 |
| MCP 通訊與 HTTP gateway | 是 |
| 遠端 Runtime 的帳號／憑證、AI 模型 | 否，由使用者選定的 Runtime 與服務提供 |

第一次啟動不會安裝套件或下載瀏覽器。**瀏覽器工具使用 App 內的獨立瀏覽器**，不沿用你日常 Chrome 的登入狀態；網站登入需在該瀏覽器中完成。

內建 Computer Use 是新安裝的預設來源。原本已安裝 Open Computer Use 的使用者仍可明確選用外部來源；新使用者不需要安裝它。

## 遠端主機條件

- 可由 Mac 存取的 SSH 服務及正確登入資訊，或已部署／配對的 HTTPS Gateway。可用區域網路、既有 VPN 或其他安全 SSH 連線方式；一般 Runtime 連線不強制安裝 Tailscale。
- Codex：主機已安裝並登入 **Codex 0.160.0**，與 App 內建執行器配對。其他版本不保證 Mac 工具可用。
- Claude：主機已安裝可使用的原生 Claude Code CLI 與 Node.js 通訊橋，並完成帳號登入或 API provider 設定。
- 該主機必須保持開機且可連線；主機離線時無法執行 AI 工作。

這些是遠端設備的前提，DMG 無法替另一台電腦自動安裝或授權。SSH 密碼在 App 輸入，選擇記住時由 macOS Keychain 支援的加密儲存；遠端模型登入憑證不複製到 Mac。

## 功能

- 串流對話、停止、重試、模型與思考程度選擇。
- 本機聊天歷史、搜尋、專案、檔案庫、拖放檔案與貼上圖片。
- 檔案與命令在這台 Mac 執行；Computer Use 與瀏覽器工具顯示實際連線／權限狀態。
- Codex 與 Claude 的雙 Agent 文字討論；雙方需各自連線並有可用額度。
- Codex 用量由連線的 Runtime 回報；未回報時不顯示假造的剩餘額度。
- 操作權限模式，包括「最高權限：所有操作不逐次詢問」。此模式不免除 macOS 系統授權。
- 深色／淺色外觀、減少動態效果、可調側邊欄。
- 選用 HTTP MCP：新安裝預設 `127.0.0.1`，供本機其他 MCP 用戶端使用。對外曝光僅允許既有 Tailscale 位址；一般 AI 工具通道不依賴這兩個端點。

快捷鍵：`⌘ K` 搜尋、`⇧ ⌘ N` 新對話、`⌘ B` 側邊欄、`⌘ ,` 設定。

## 功能與驗證邊界

這是獨立用戶端，不會同步官方 ChatGPT 雲端對話。官方語音、圖像生成、所有官方 Apps／插件及桌面功能並未完整接入。使用者的個別命令仍可能需要專案自身依賴，例如 Git、Python 或套件；DMG 內建的是 AgentBridge 運作元件，不是所有軟體開發環境。

發布驗收狀態見 [Release 驗收](docs/RELEASE_ACCEPTANCE.md)，不等於已在每種 Mac／每個遠端帳號完成所有模型任務。Intel Mac 暫未提供發行檔。

## 開發與發布

下載 DMG 的一般使用者不需要以下工具；只有建置者需要 Apple Silicon Mac、Xcode Command Line Tools（Swift）、Node.js 22 或更新版本及 Python 3。

```sh
npm ci
npm run dist
npm test
npm run test:handoff
npm run package:public
```

`npm run dist` 在**建置時**下載版本配對的瀏覽器，編譯原生工具、建立授權告知，再產生 DMG。下載行為不在使用者安裝或第一次開啟時執行。

來源 ZIP 僅包含可公開檔案，不含 dependencies、編譯快取、私人設備、憑證、聊天資料及本機驗收紀錄。請以此 ZIP 中的專案作為 GitHub 儲存庫起點。

[發布步驟與簽章](docs/RELEASING.md) · [架構](docs/ARCHITECTURE.md) · [版本說明](docs/RELEASE_NOTES.md)

## 授權

AgentBridge 原始碼採 [MIT](LICENSE)。內建元件各自保留原始授權與告知，見 [第三方元件](THIRD_PARTY_NOTICES.md)。本專案非 OpenAI、Anthropic 或瀏覽器供應商的官方產品。

開啟 App 直接載入本機聊天紀錄，不必解鎖連線密碼。自動連線預設關閉，舊版開啟的設定也不會自動沿用；手動連線時若要讀取已保存的 SSH／HTTPS 憑證，macOS 仍可能要求解鎖鑰匙圈。
