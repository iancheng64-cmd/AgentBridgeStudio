# Split Runtime 研究紀錄

更新日期：2026-10-03

## 2026-10-03 版本差異：Windows 0.160.0 與 Mac 0.159.2

### 結論

**已實測的基準是同版 0.160.0；不應要求朋友把 Windows Codex 降版。** 官方 `rust-v0.159.2` 與 `rust-v0.160.0` 的 executor wire/API 來源相同，但 source 一致本身不是官方版本相容承諾，也不是這個產品對 `0.160.0 controller → 0.159.2 Mac executor` 版本組合的驗收證據。本專案的已驗收路徑使用 0.160.0，版本支援應按精確測過的版本組合管理；不得將兩個各自出現在 allowlist 的版本推論成已驗證其交叉組合。

Astra 提供的兩份 0.160.0 acceptance evidence 顯示：Codex 0.160.0 的 direct 與 Code Mode 工具路徑都經真正的 SSH2 loopback reverse-forward 測試，涵蓋 Mac executor、檔案工具、圖片與 MCP；兩份測試使用同台 Mac、合成 Responses SSE，並未連真實 Windows 主機或呼叫線上模型。因此可把「同版 0.160.0 的 SSH executor/tool plumbing」作為已驗證基線，但不能把它寫成 Windows + 真實 Pro 模型端到端已通過，也不能用它宣稱 .160/.159 混版已支援。

版本提示應避免要求使用者回退既有 Windows Codex/ChatGPT。若需要修正未驗證的 Mac executor 版本，優先由 AgentBridge 管理或提供已驗證的 Mac helper 更新；否則顯示明確的「此版本組合尚未驗證」及診斷結果，等配對測試完成再列入支援矩陣。不要靜默改寫朋友既有的 Codex 安裝。

### 已核實的來源事實

| 項目 | 查證結果 |
|---|---|
| 0.160.0 release | 官方 stable release tag `rust-v0.160.0`，release note 未列 exec-server、executor wire protocol 或 remote environment 變更；內容涵蓋 UI、文件、Windows 子程序／sandbox 修正、plugin cache 與資料庫空間回收。 |
| wire protocol | 對照 `rust-v0.159.2` 與 `rust-v0.160.0` tag，`exec-server-protocol/src/protocol.rs`、`exec-server-protocol/src/rpc.rs` 逐位元組相同；`exec-server/src/server.rs`、`client_api.rs`、`environment.rs` 亦相同。 |
| App Server 接口測試 | `app-server/tests/suite/v2/mcp_tool.rs` 在兩 tag 相同；沒有看到 0.160.0 對 `environment/add` / MCP environment 測試的 schema 變更。 |
| exec-server 其他改動 | 0.160.0 的 exec-server 只見 background process 啟動、Windows 子程序終止，以及 Windows sandbox PowerShell fallback；不是 wire protocol 改動。Windows 端 core 也更新了 environment selection/startup retry 與 Windows sandbox 選擇，這些仍需在實際 Windows controller 上做端到端測試。 |
| executor 身分資料 | 兩版 protocol 都有 `executorVersion`、`providerId`、`platformOs` 與 `capabilities`。`providerId` 是 build commit/target 衍生的相容性識別值，不是 binary checksum 或安全證明；舊版或未標記 build 可回報 `0.0.0` / 不帶 `providerId`。 |
| 本專案 0.160.0 測試 | `build/acceptance-evidence/runtime-0.160.0-direct.json` 與 `runtime-0.160.0-code-mode.json`：真 SSH2 loopback tunnel、同台 Mac 上 0.160.0、synthetic SSE；檔案與圖片附件/MCP/executor 相關驗證為 true。`completeToolRoutingVerified:false`，且 JSON 明確註記 no Windows host、no inference。 |

使用者回報的 Windows 0.160.0 與 Mac 0.159.2 是本案目標組合；目前沒有直接讀取朋友兩台裝置的版本輸出，因此此組合版本值屬於使用者提供，官方來源比較則已查證。

### 版本提示與驗收建議

版本檢查應按 `(controllerVersion, executorVersion, OS/arch, providerId, capabilities)` 記錄精確配對，不用 semver 範圍推論支援。首次配對讀兩端版本和 Mac `environment/info`，用 Mac `platformOs`、cwd/sentinel 與 capabilities 確認目標；同版 0.160.0 的本地 SSH acceptance 可作為當前基線。0.160.0 controller 與 0.159.2 executor 應標「尚未完成版本配對驗收」，不可因 tag source 一致就顯示為受支援，也不可要求朋友將 Windows Codex 降版。若未來要支援混版，先對該精確版本 tuple 跑本機 SSH round-trip 和真實 Windows/controller acceptance，通過後才記錄該 tuple。

`environment/info` 成功仍不能取代具 Mac 唯一檔案的讀寫 round-trip；合成 SSE 測試也不能取代 Windows host + 真實模型工具路由驗收。

## 目前可確認的結論

Codex 的 `--code-mode-host` 不能單獨完成「Windows 保留 ChatGPT Pro 登入，Mac 執行命令與讀寫檔案」的需求。官方 Code Mode protocol 將 host 定義為 stateful JavaScript runtime；巢狀工具呼叫會委派回 session owner。因此把 Mac 的 `codex-code-mode-host` 接到 Windows app-server，只能把 Code Mode JavaScript 執行環境移到 Mac，不能據此推論 `exec_command`、檔案工具或 MCP 也會在 Mac 執行。

Codex 專案另有 `exec-server` 與 App Server 的實驗性 remote environment protocol。App Server protocol 定義 `environment/add`，參數含 `environmentId`、`execServerUrl`，以及可選的 bearer token；官方整合測試以 `ws://` executor URL 加入環境時未提供 bearer token。這表示本機直接連線路徑和 Agents API 的註冊／relay 路徑是兩件事，不能把後者需要的 API key 當成所有連線都必需，也不能把 API relay 可用等同於 ChatGPT Pro 帳戶可用。

截至 2026-10-01，尚未完成 direct executor route 的端到端實測，也尚未確認一般模型產生的 shell/file 工具呼叫會否自動選用新增環境。`environment/add`、`environment/info` 和 deferred executor 能力屬於實驗性、版本敏感介面；不得在完成 RPC 驗證前宣稱 Mac 已接管工具執行。2026-10-03 的同版 0.160.0 SSH acceptance 後續補上了本機工具 plumbing 證據，但仍沒有真實 Windows host 或線上模型驗收。

## 2026-10-01 快速補查：可用控制面，尚無安全的完整工具路由（當時狀態）

已對照官方 `rust-v0.155.0`（與本案 Windows Runtime 約同代）及 `rust-v0.159.2` 原始碼：App Server 有 experimental `environment/add` / `environment/info`；官方同版整合測試啟用 `deferred_executor`，以 `execServerUrl: ws://...` 註冊執行環境，並在 `thread/start` 指定 `environments`。未帶 `authBearerToken` 的 loopback 形式出現在官方測試中，因此此直接本機連線路徑不必先用 Agents API key 註冊；這只證明介面及連線測試存在，不能證明標準模型工具都由 executor 執行。

最直接的反證是官方 open issue [#41563](https://github.com/openai/codex/issues/41563)：在 CLI/App Server 0.144.5 上，`environment/add`、`environment/info`、`deferred_executor`、thread/turn environment 選擇及 `externalSandbox` 均成功，但模型要求的 `whoami.exe` 仍以 app-server 主機身分執行。該 issue 仍未提供已修復版本或修復證據；相關 [#33820](https://github.com/openai/codex/issues/33820) 也記錄 `apply_patch` delete 可能作用於主機本機檔案系統。因而目前不能把 exec-server 當成可靠的透明 Mac shell/file 接管方案，也不能在未按相同版本實測前宣稱只會在 Mac 執行。

官方協定另有 client dynamic tool：`thread/start.dynamicTools` 與 `item/tool/call` 可讓 App 明確提供並執行工具。但這些欄位不構成停用 Runtime 原生 shell、檔案及其他內建工具的證明。尚未找到可確證「Windows 原生工具全部禁用、所有命令/讀寫只能走 Mac dynamicTools」的穩定開關或 fail-closed 保證；prompt 限制不算邊界。故可用選項目前是：將 Mac 工具明確作為 client dynamic tools 提供，並在 RPC / 真實工具呼叫測試證明原生路徑不可用後再開放對話；否則保持 `localToolsReady=false`。

本機 ChatGPT.app 內的 CLI 實測為 `codex-cli 0.159.2`；`app-server --help` 有 `--code-mode-host`，`exec-server --help` 標為 experimental 並有 WebSocket listener/remote 相關選項。這不表示 App Server 已自動綁定 executor。Windows 端版本仍須由使用者主機的 read-only preflight 單獨記錄，不能以 Mac 版本代替。

## 本機版本與執行檔

此 Mac 上兩套已檢查的 Codex CLI：

| 來源 | CLI 版本 | Code Mode host |
|---|---:|---|
| PATH：`/Users/ian/.hermes/node/bin/codex` | `codex-cli 0.155.0` | 同一 npm 套件內的 `codex-code-mode-host` |
| ChatGPT.app：`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` | `codex-cli 0.159.2` | `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex-code-mode-host` |

`app-server --help` 提供 `--code-mode-host URL`。host 自己的 help 提供 `--listen stdio|stdio://|grpc://IP:PORT`；官方 repo 測試會啟動 `--listen grpc://127.0.0.1:0`，從 stdout 取回 `host_url`，再將它交給 app-server。host help 沒有 `--version`，應使用所屬 Codex distribution 的版本做配對，不要混用不同版本的 CLI 與 helper。

0.159.2 CLI 的 source/help/tests 實作以 HTTP/2 gRPC 連接 `http://HOST[:PORT]` 或 `https://HOST[:PORT]` 根 URL，拒絕 `wss://`、URL path、query、fragment 或 credentials。Learn app-server 文件目前出現 `wss://.../host` 範例，與此版本 repo 實作不一致，顯示文件或版本差異；部署時須以兩端實際版本測試結果為準，不能照抄 WSS 範例。

`exec-server` 是另一個協定：官方 CLI help/README 描述 WebSocket listener，例如 `ws://IP:PORT`；其 `forward` 與 `--remote` 選項使用 environment registry/relay。官方 Agents API self-hosted environment 指引以 API key 建立這種服務端註冊。App Server `environment/add` 直接接收 `execServerUrl`，測試範例使用沒有 bearer token 的本機 WebSocket URL；這條 direct route 看起來不必先經 Agents API。2026-10-03 的同版 0.160.0 direct acceptance 另以真正 SSH2 loopback reverse-forward 驗過 executor/MCP/files/image plumbing，但只在本機、使用合成 Responses SSE，並非真 Windows 或真實模型測試。

## 官方來源

- [Code Mode gRPC protocol](https://github.com/openai/codex/blob/main/codex-rs/code-mode-protocol/src/grpc/codex.code_mode.v1.proto)：Code Mode host 的 JavaScript runtime 與巢狀工具委派語意。
- [Code Mode host transport](https://github.com/openai/codex/blob/main/codex-rs/code-mode-host/src/transport.rs)：`grpc://` / stdio listener 格式。
- [App Server Code Mode host connector](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/code_mode_host.rs)：app-server 連接 host 的 URL 驗證與 HTTP/2 gRPC transport。
- [Code Mode host App Server test](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/code_mode_host.rs)：啟動 helper、讀 stdout `host_url`、將 host URL 傳入 app-server 的正式測試方式。
- [Exec Server README](https://github.com/openai/codex/blob/main/codex-rs/exec-server/README.md)：exec-server WebSocket、forward 與 remote registry/relay 說明。
- [App Server protocol types](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs)：實驗性 `environment/add`、`environment/info`、`environment/status` schema。
- [App Server MCP tool tests](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/mcp_tool.rs)：測試中的 `environment/add` 呼叫與可選 auth token。
- [0.155.0 App Server protocol types](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/app-server-protocol/src/protocol/common.rs) 及 [0.155.0 integration tests](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/app-server/tests/suite/v2/mcp_tool.rs)：版本固定的 environment API 與測試流程。
- [0.159.2 App Server protocol types](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server-protocol/src/protocol/common.rs) 及 [0.159.2 integration tests](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/tests/suite/v2/mcp_tool.rs)：新版本同樣保留 experimental environment API。
- [0.160.0 stable release](https://github.com/openai/codex/releases/tag/rust-v0.160.0)：2026-10-01 發布；release note 沒有列 executor protocol 變更。
- Tag 固定的 [0.159.2 executor protocol](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/exec-server-protocol/src/protocol.rs)、[0.160.0 executor protocol](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/exec-server-protocol/src/protocol.rs)、[0.159.2 RPC envelope](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/exec-server-protocol/src/rpc.rs)、[0.160.0 RPC envelope](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/exec-server-protocol/src/rpc.rs)：逐位元組比較相同；`EnvironmentInfo` 同時提供 executor version/build identity/OS/capabilities 欄位。
- Tag 對照：[0.159.2 至 0.160.0 source diff](https://github.com/openai/codex/compare/rust-v0.159.2...rust-v0.160.0)：exec-server 變更集中在子程序啟動/終止及 Windows sandbox fallback，非 wire schema；App Server MCP tool integration test 沒變。
- [App Server/exec-server fallback issue #41563](https://github.com/openai/codex/issues/41563)：註冊及選環境後，內建命令仍回落到 app-server 主機身分的實測報告。
- [Dynamic client tool protocol](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/app-server-protocol/src/protocol/common.rs)：`item/tool/call` client-side dynamic tool request；本身不提供關閉其他內建工具的保證。
- [Agents API self-hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)：以 API key 註冊遠端環境的另一種模式。
- [App Server documentation](https://learn.chatgpt.com/docs/app-server)：公開文件目前記載 `environment/info` 及 Code Mode host 範例；其 WebSocket host URL 範例與上方 0.159.2 source 的 gRPC URL 格式不同。

## 建議實作驗證順序

1. 記錄 Windows controller 和 Mac executor 的各自版本；以明確驗收過的版本組合作為支援條件，不能單憑相同或不同的版本號放行/封鎖。Mac 使用其 Codex distribution 隨附的 `exec-server`，不要混用 PATH 與 ChatGPT.app 內不同 build 的 helper。首次配對依上方流程驗證實際協定與工具路由。
2. Mac 只在 `127.0.0.1` 啟動 exec-server websocket listener，從程序 stdout 讀實際 listener URL；此階段不啟動 relay、不讀取或複製登入資料。
3. Windows app-server 以 experimental API 啟用後呼叫 `environment/add`，提供唯一測試 `environmentId`、Mac loopback websocket URL，省略 auth token；接著用 `environment/info` 檢查回報 shell/cwd 是否屬於 Mac。
4. 只有在以上 RPC 成功後，才測試 executor capability discovery 及具明確工作目錄的 shell/read/write 工具是否帶上該 `environmentId`。新版本 `environment/info` 可回報 `platformOs`；若版本未提供此欄位，使用 Mac 唯一測試目錄與 sentinel 做讀寫 round-trip，確認遠端主機身分。
5. 若模型的通用工具仍落在 Windows，則把 Mac 能力作為 app 自己明確呼叫的 dynamic tools，或停止宣稱透明接管 Codex 原生工具；不可把 Code Mode JS host 當成 shell/file remote executor。

目前不建議先研究「在 Pro app-server 中全面關閉 Windows native shell、filesystem、patch 及 MCP」作為 fallback：尚未找到可證明該模式安全且能保留所需能力的穩定公開設定；實驗性 feature flags 不是完整的安全邊界。
