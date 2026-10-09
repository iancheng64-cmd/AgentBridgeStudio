# 雙 Agent 原生能力與路由評估

更新日期：2026-10-03

## 結論

「Codex」和「Claude」各自用自己的 Mac 本機 agent process，讀取 Mac 上該 Agent 的登入、模型設定、MCP、Skills、Plugins，再由 Mac 執行工具，技術上可行。建議兩個模式都把 agent process 放在 Mac：Codex 用 Mac 上的 Codex App Server；Claude 用 Mac 上已登入的 Claude Code CLI，以 `claude --print --output-format stream-json` 串流。SSH 只運送 RPC／CLI 輸入輸出、附件與檔案資料，不搬移或讀出登入憑證。

Codex App Server 提供最完整的原生 UI 控制面，但官方仍將 app-server 命令列為實驗性，WebSocket transport 也明確不支援 production；優先採 SSH 保護的 stdio JSONL，並保留版本／能力探測。Codex 的 plugin 列表與安裝 API 目前標示 under development，production UI 應呼叫 Mac 上的 `codex plugin` CLI，而非依賴那些 App Server API。

Claude Pro／Max 訂閱可用在 Mac 上已登入的原生 Claude Code CLI 非互動 `-p` 模式，前提是不使用 `--bare`，且沒有較高優先權的 API key／provider credential 蓋過訂閱登入。**但 Anthropic 明文規定，未獲預先批准時，第三方產品不可提供 claude.ai 登入或訂閱 rate limits；這包含以 Claude Agent SDK 建置的 agent。**因此不能把 Claude 訂閱登入做成 AgentBridge 自有的 SDK 認證方式。若要保留訂閱帳戶，最保守路徑是讓使用者先在 Mac 原生 Claude Code 完成登入，App 只呼叫該本機 CLI，不複製 token、不提供 OAuth 登入流程；產品是否可包裝／提供這種訂閱式 CLI 整合仍應取得 Anthropic 批准。無批准時，正式 Agent SDK 整合走 Anthropic Console API key 或受支援的雲端 provider。

這是協定可行性和現有程式碼對照，不代表已完成雙機、真實訂閱推論或所有第一方桌面／雲端功能的端到端驗收。

## 能力與驗證矩陣

| 項目 | Codex | Claude Code | 證據狀態／邊界 |
|---|---|---|---|
| Agent 執行位置 | 在 Mac 啟動本機 Codex App Server；SSH 把 stdin/stdout JSONL 連到 App Server，工作目錄、Codex 設定及可用擴充皆由 Mac process 決定。 | 在 Mac 透過 SSH 啟動本機 `claude --print --verbose --output-format stream-json --include-partial-messages`；設定、Skills、MCP、CLI plugins 由 Mac 的 Claude Code 載入。 | 專案已有 SSH 與 JSONL/stream-json parser；目前 Codex Runtime 實際是 Windows App Server + Mac executor，不能當作「Mac 原生 Codex agent」。Claude 舊版 chat 會在 SSH host 執行 CLI，只有 host 選到 Mac 才能用 Mac 原生 Claude 設定。程式位置：[chat-protocol.ts](../src/main/chat-protocol.ts)、[runtime-backend.ts](../src/main/runtime-backend.ts)。 |
| 模型發現／選取 | App Server `model/list` 分頁回傳模型 ID、顯示名稱、推理程度、模態與預設值；用回傳資料建選單，`thread/start.model` 或 `turn/start.model` 選取。成功 `model/list` 不保證該帳戶可推論每個模型，需以實際 turn 驗證。 | 原生 CLI 接受 `--model <alias|name>`，互動 CLI 可用 `/model`；串流 `system/init` 可回報目前 model、tools、MCP、plugins。沒有在本次審閱的 Agent SDK 文件中找到等同 Codex `model/list` 的 Claude Code 帳戶模型目錄 API；可用原生 alias、讀回目前 model，或讓使用者透過原生 CLI picker 選擇。Anthropic Models API 是另一個 API-key 模型目錄，不等於 Pro／Max 訂閱可用清單。 | Codex：官方 App Server protocol + 本機 0.160.0 產生的 schema。Claude：官方 CLI help 2.1.170 有 `--model`；最新版文件中的 model alias、SDK `setModel()` 等功能有最低版本要求，不可倒推為本機 2.1.170 都支援。 |
| 帳戶／原生計費 | Mac App Server 用 Mac 本機 Codex 登入；不將 Windows 的 ChatGPT token 複製到 Mac。`model/list` 是選單資料而非 entitlement 保證。 | 原生 CLI 可使用 Mac 上使用者以 `/login` 完成的 Claude.ai Pro／Max 登入；API key 在非互動 `-p` 中有較高優先權，`--bare` 完全不讀 OAuth/keychain。 | 官方 Claude auth 文件與本機 CLI help 已核對；本次未檢查本機憑證、未登入或送出任何模型請求。Agent SDK 使用 claude.ai 訂閱需 Anthropic 預先批准，否則應用 API key／支援的 provider。 |
| Agent 串流／控制 | 官方雙向 JSON-RPC 2.0 App Server：`initialize`、`thread/start`／`thread/resume`、`turn/start`、`turn/steer`、`turn/interrupt`；透過 notification 讀回增量文字、工具項目與完成狀態，透過 server request 實作核准／拒絕。 | CLI `stream-json` 是逐行 JSON event stream，可支援即時顯示與收尾；`--input-format stream-json` 支援串流輸入。SDK `ClaudeSDKClient` 提供 streaming input、取消／追加訊息、`canUseTool`／permissions 等互動控制。 | Claude Code CLI stream 不是 App Server 式任意 JSON-RPC 控制協定；如果要互動式 UI，需實作 stdin/stdout session protocol，或在 Mac 以 SDK 建立獨立 control bridge。 |
| MCP 發現／執行 | App Server `mcpServerStatus/list` 可列出連線、工具、resources、auth 狀態；`app/list`／`app/installed` 可列出 Codex Apps/connectors 的可用與啟用狀態。Mac App Server 載入 Mac 使用者設定；MCP 工具本身在哪執行仍以伺服器位置為準。管理設定可用 App Server config/MCP API，或 Mac `codex mcp` CLI。 | CLI `claude mcp list/get/add/remove/login/logout` 可管理 Mac Claude Code MCP；Agent SDK 可直接傳入 `mcpServers`，啟動訊息可確認實際工具／server 狀態。自訂 SDK 只應宣稱明確配置的 MCP；claude.ai connectors 是不同來源，僅在合適的 claude.ai login 下載入。 | App Server status/CLI help 可做真實執行狀態的 discovery；專案現在的 extension scanner 只讀設定檔／manifest，不等於每個 MCP 已連線：[extensions.ts](../src/main/extensions.ts)。 |
| Skills 發現／使用 | App Server `skills/list` 可依 cwd 重新掃描；`skills/changed` 通知變化，`skills/config/write` 可按路徑啟用／停用；turn 可附 `skill` input item，App Server 注入完整 skill 指示。 | SDK Skills 是 Mac 檔案系統中的 `SKILL.md`，按 `settingSources` 和 `cwd` 發現；`skills` option 控制可呼叫項目；CLI 可原生呼叫 `/skill-name`。啟用的本機 plugin 也能提供技能。 | Codex 0.160.0 本機 schema 與官方 App Server 文件均確認。Claude CLI 的 `--disable-slash-commands`、`--add-dir` 等 help 已檢查；本地 CLI 版本早於許多最新 SDK 功能，須執行時檢查。 |
| Plugins 發現／管理 | `codex plugin list/add/remove` 與 `codex plugin marketplace ...` 本機 CLI 已確認存在；`codex plugin list --json [--available]` 可供 UI 解析。App Server `plugin/list/read/install/uninstall` 在官方 API overview 明確標示 under development，不應用於正式 UI。 | `claude plugin list/install/enable/disable/uninstall/update/marketplace` 等本機 CLI 指令已確認；Agent SDK 的 `plugins` option 只載入本機 plugin directory，需要自行先把 marketplace／remote plugin 下載到 Mac。SDK `system/init` 可核實載入 plugin/skills/commands。 | Codex CLI、Claude CLI help 均在本機讀取；未執行任何 install/list 動作。只整合 CLI 能操作的 plugin package，不代表接上第一方 Apps／Claude Desktop 專有 marketplace、雲端外掛或團隊政策 UI。 |
| 第一方桌面與雲端功能 | App Server 只提供其明列的 protocol；Codex plugin 功能在不同 surface 可能不同，hooks 需在實際執行環境存在。 | Claude Code CLI／Agent SDK 與 Claude Desktop/網頁產品是不同 surface；SDK 文件只列可程式化暴露項目。 | 自訂 UI 不承諾複製閉源桌面 UI、專有雲端工作流程、跨產品 connector、第一方 marketplace 全部功能，或管理帳戶頁面。 |

## 最直接可實作的雙模式

1. **Codex 原生模式**：以 SSH 在 Mac 啟動 `codex app-server --listen stdio://`，前端透過已 host-key 驗證的 SSH stdio 連線；用 Mac 上既有 Codex 登入及設定。採 App Server JSON-RPC 作為 chat、模型選單、MCP 狀態、Skills 列表、工具事件及核准控制面。模型列表每次由 `model/list` 取得；使用 `thread/start`／`turn/start` 明確設 cwd、模型與權限。MCP 管理用 Mac `codex mcp` CLI。Plugins 管理用 `codex plugin` CLI，因 App Server plugin APIs 還在開發中。App Server 仍是 experimental，發版前鎖定測試版本並於啟動時檢查協定能力；不要把未文件化欄位當穩定契約。
2. **Claude 原生模式（訂閱）**：以 SSH 在 Mac 以使用者登入帳戶執行 Claude Code CLI stream-json；不要傳 `--bare`，不要由 App 注入 `ANTHROPIC_API_KEY` 或 `CLAUDE_CODE_OAUTH_TOKEN`。把 `system/init` 的 model/tools/MCP/plugin 資訊用來顯示實際啟用狀態；以 CLI `--model` 設定模型 alias。訂閱認證保持由原生 Claude Code 管理，`/login`、keychain 與 token 不離開 Mac。注意，非互動 `-p` 不顯示 workspace trust/per-server approval dialog；只在使用者選定的可信目錄執行，並在 App 自己提供逐工具核准。
3. **Claude 原生模式（SDK/產品化）**：若產品需要 SDK 的 typed message、權限 callback、plugin path、Skills、MCP server 與 hooks，使用 Claude Agent SDK；以 Anthropic Console API key 或官方支援的 Bedrock／Google Cloud Agent Platform／Microsoft Foundry 認證。沒有 Anthropic 預先批准時，不以 Pro／Max OAuth 作為 SDK agent 的產品登入方案。

兩模式要各有獨立連線狀態及設定範圍：`Codex Mac session` 載入 `~/.codex`、Codex 的 project config 和 skills/plugins；`Claude Mac session` 載入 `~/.claude`、Claude project settings、MCP 與 plugin paths。不要把兩套擴充清單合成一個「都會執行」狀態，也不要從一個 Agent 的設定推論另一個 Agent 能讀取同名擴充。

## 已驗證與未驗證

**本機已驗證**：`codex-cli 0.160.0`、`Claude Code 2.1.170` 版本/help；Codex 0.160.0 使用 `app-server generate-ts --experimental` 產生的本機型別包含 `model/list`、`skills/list`、`plugin/list/install/uninstall`、`mcpServerStatus/list`、`turn/start/steer/interrupt`；Codex/Claude CLI 的 MCP 與 plugin 子命令可由 help 查詢。只輸出至 `/tmp/agentbridge-codex-app-server-schema`，沒有寫入本專案、登入帳號或讀取 secrets。

**尚未驗證**：Mac 原生 Codex App Server + 本機登入的真實模型請求；Mac Claude CLI 非互動 Pro/Max 訂閱請求；Agent SDK 版本與真實 auth；各 Agent 的 MCP OAuth、plugin 安裝後狀態和多輪對話；Windows UI 到 Mac 本機雙 Agent 的真機 SSH 全流程。既有 `npm test`／split runtime SSH 測試不涵蓋以上行為。

## 官方來源

- OpenAI [Codex App Server protocol](https://developers.openai.com/codex/app-server)：JSON-RPC、transport、models、skills、MCP、apps 與 plugin API lifecycle。
- OpenAI [Sign in with ChatGPT: Codex App Server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)：App Server 與 ChatGPT plan、model catalog 的限制。
- OpenAI [Package your plugin](https://developers.openai.com/plugins/build/plugins)：Codex 插件／marketplace 的 CLI 與 surface-specific capability 說明。
- Anthropic [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)：第三方產品使用 claude.ai login／rate limits 的限制。
- Anthropic [Authentication](https://code.claude.com/docs/en/authentication)：Pro/Max 登入、憑證優先序和 Keychain 行為。
- Anthropic [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)：`-p`、非互動權限、`--bare` 和 stream-json。
- Anthropic [Model configuration](https://code.claude.com/docs/en/model-config)：CLI model alias、選取與版本差異。
- Anthropic [Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features)、[Skills](https://code.claude.com/docs/en/agent-sdk/skills)、[MCP](https://code.claude.com/docs/en/agent-sdk/mcp)、[Plugins](https://code.claude.com/docs/en/agent-sdk/plugins)：SDK 可用擴充及其 discovery/control 介面。
