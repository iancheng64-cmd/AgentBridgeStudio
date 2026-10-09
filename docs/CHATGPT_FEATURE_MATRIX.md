# ChatGPT 桌面版功能與介面參考

研究日期：2026-09-28。這份文件以 OpenAI 官方 Help Center / Release Notes 為準，整理目前 macOS 桌面版可參考的功能與介面行為，供 AgentBridge Studio 重設使用。文件提到的介面建議是實作規格，不代表 OpenAI 公布了像素尺寸或動畫時間。

本機有 `/Applications/ChatGPT.app`，安裝資訊顯示版本 `26.924.22138`、bundle id `com.openai.codex`。OpenAI 已將 Codex 桌面 App 演進成含 Chat、Work、Codex 的新 ChatGPT Desktop；因此本次以新統一桌面版為主，舊 ChatGPT macOS 文件只用來補充仍有參考價值的原生 macOS 行為。無法從本機擷取 ChatGPT 視窗畫面，本文件不宣稱已完成實際視覺比對。

## 功能矩陣

| 區域 | 使用者看到與能做的事 | AgentBridge Studio 建議的介面行為 | 服務／狀態需求 |
|---|---|---|---|
| 桌面 App 外框 | 左上角切換 ChatGPT / Codex；ChatGPT 內再切 Chat / Work。Chat 是快速對話；Work 做多步驟研究與產出；Codex 專注程式工作。 | 保留固定 App 外框和頂部模式切換。模式切換後更新側欄、主視圖、輸入列和工具狀態，不要把每個功能做成互不相關的孤島。 | 登入、工作區、方案/角色權限、可用模式和預設模式。不同模式的對話資料範圍要清楚。 |
| 左側導覽 | 新對話、Search、Recents、Projects，以及 Plugin Directory / Plugins 入口；帳號與設定入口。官方新桌面版將 Chat 和 Work 對話放在同一 Recents，Codex 歷史獨立。 | 預設展開，支援收合；主要入口常駐且有文字標籤。底部保留使用者/工作區選單與 Settings。窄視窗以收合圖示導覽，選取頁面後仍能辨識當前位置。 | 每頁應可獨立載入、顯示空狀態/離線狀態；入口依權限標示 unavailable，而不是消失。 |
| Search | 從側欄找聊天、Projects、圖片、文件；依 Chats、Images、Documents、Projects 等類型篩選。結果可直接開啟項目。Web/macOS 有 Cmd+K 快捷鍵。 | 點擊 Search 或 Cmd+K 打開搜尋面板；輸入即顯示 loading、結果、無結果和錯誤狀態；搜尋結果可按種類篩選。不要將此搜尋和網路搜尋混為一談。 | 對話標題/內容索引、Project/file metadata 索引、工作區範圍和權限篩選；刪除項目需從搜尋結果消失。官方跨內容搜尋說明列 web/iOS/Android，桌面完整索引範圍未明確承諾。 |
| Recents / 歷史 | 桌面版合併 Chat/Work 對話，可排序、依 Chat/Work 篩選、釘選；側欄展示最近聊天。聊天選單有 rename、archive、delete；封存聊天可搜尋，刪除需確認。Codex history 分開。 | 顯示可辨識的最近項目、目前選取狀態及固定區；hover/••• 顯示 rename、pin、archive、delete。封存與刪除分開，刪除前確認；保留載入更多和搜尋舊聊天入口。 | 持久化聊天、標題、模式、排序、釘選、封存；CRUD、搜尋、分頁/最近清單同步。刪除要和 Archive 分開處理。 |
| Projects | 專案把相關聊天、來源檔案、指示和記憶放一起；可新增名稱、圖示、顏色、說明/指示、檔案/連結/已儲存回覆；可在專案內開始 Chat 或以該上下文開始 Work。 | 側欄有 Projects 清單與 New project；點專案進入專案首頁，可看到 chats / sources / instructions / memory 設定。支援專案聊天建立、移入/移出、來源新增和專案選單。 | Project CRUD、成員/共享權限、檔案和指示關聯、Project memory scope、專案內搜尋、聊天和來源的 retention。 |
| Library / 檔案庫 | 可瀏覽、搜尋、篩選、上傳、下載、刪除上傳或產生的檔案；可從 Library 把檔案加到其他聊天。連線的 Drive/Box/Dropbox/SharePoint 來源在具備權限時可顯示。完整 Library 目前官方標示為 web；行動版有 composer 最近檔案與 file search。 | 使用者要求檔案庫入口，因此側欄應有可用的「檔案庫」頁；提供 Upload、搜尋、種類/上傳或生成篩選、檔案預覽、下載、刪除、Storage 使用量。Composer 的 Add from library 可選多個檔案。這是 AgentBridge 的桌面延伸規格，不能宣稱是 ChatGPT 現行 desktop parity。 | 檔案上傳/儲存、metadata、縮圖/預覽、檢索、下載 URL、刪除/回收、配額/檔案限制；雲端來源要有 app connector 和來源權限。注意 chat 刪除不等於 library 檔案刪除。 |
| Plugins / Apps | 目前 OpenAI 將工作流程能力放在 Plugin Directory；plugin 可包 Skills、外部 apps 和 app templates。Apps 可搜尋資料、提供互動卡片/地圖、或執行被允許的動作；連線及權限仍需使用者/管理員授權。 | 側欄顯示 Plugins；進入目錄後分頁/分類瀏覽、搜尋、開啟詳細頁、Install/Connect、狀態標籤、授權管理。設定頁能看已安裝/已連線/失效/管理員停用狀態。Composer 的 + / @ 可叫用已連線工具。 | plugin/app manifest 與目錄、OAuth/多帳號連線、憑證刷新、工具 schema/呼叫、授權提示、逐項 permission、workspace 管理限制、可用/失敗/重連狀態。只顯示靜態外掛卡片不構成功能。 |
| Composer / 上傳 | 訊息輸入區提供附件/加號按鈕。macOS Chat Bar 文件明列 Upload File、Upload Photo、Take Screenshot；亦可拍照。新體驗可把既有 Library 檔案加回聊天。 | 固定於主視圖底部、空白聊天和既有聊天都顯示；左側加號開選單，至少包含 Upload file、Add from Library、本機/截圖入口（支援時）、已連接 App/來源。檔案選取後顯示檔名、預覽/移除、上傳中/失敗/重試。拖放和貼上也要有附件狀態。 | OS 檔案選擇器、附件上傳與續傳/錯誤、MIME/大小/方案限制、儲存與聊天關聯、圖片/PDF/文件/試算表處理；Windows/Linux 和 macOS 捕捉能力不同。 |
| 聊天訊息 | 同一對話串連使用者與助理訊息；支援串流回覆、複製、回饋、引用來源、圖片/表格/圖表/程式碼、工具結果和進度。 | 新聊天顯示歡迎/建議 prompt 與醒目的 Composer；送出後訊息立即入列，助理文字逐段顯示，有 generating、stop、完成/錯誤狀態；重回已完成聊天不可假裝重新生成。長工作顯示進度、待答問題和待核准操作。 | 模型/工具串流事件、訊息排序與狀態、stop/cancel/resume、引用和 artifact payload、重試與錯誤恢復、草稿持久化。 |
| Voice / 桌面情境 | 新桌面版可在 Work、Codex 開 Voice；語音可自然插話並跟著文字回覆。桌面 Work 可在權限允許時使用本機檔案和桌面 App；可用內建瀏覽器。 | Composer 保留明確的 Voice 控制；錄音/連線/聽取/說話/結束各有狀態。桌面情境與雲端工具分開標示並清楚說明正在使用的來源。不要在未授權時讀取螢幕或桌面 App。 | 語音串流、麥克風權限、工作/模型 entitlement、桌面權限；macOS Screen & Audio Recording / Accessibility 只在功能需要且使用者同意時要求。 |
| Settings | 官方文件有 Personalization/Memory、Data controls、Plugins/Apps、Voice、工作區設定等控制；macOS 還有 Chat Bar 快捷鍵和原生 App 選項。 | 點個人/工作區選單→Settings；在設定頁左側/頂端有分類導覽，右側同頁切換內容，不要把所有設定塞成單一長表。優先完成 General/Appearance、Personalization/Memory、Data controls、Apps/Plugins、Keyboard & desktop permissions、About/plan。 | 使用者偏好持久化、account/workspace scope、記憶和訓練開關、連接帳號/權限、快捷鍵、主題/縮減動態、版本和方案；需要明確 loading、saved、failed。 |

## macOS 與 web 的差異

| 能力 | macOS 桌面版 | Web | 對重設的影響 |
|---|---|---|---|
| Chat 對話 | 可用 Chat；一般 Chat 歷史與 web 同步。快速 Chat 可由桌面入口啟動。 | 可用 Chat；聊天同步到桌面版。 | Chat shell 和資料模型盡量共用。 |
| Work | 除雲端工作外，在符合方案/工作區權限時可使用本機資料夾和桌面 App；本機工作所用訊息/上下文仍可能存雲端。 | Work 在雲端執行，不能直接讀本機檔案。 | 把來源分為 uploaded file、cloud app、local folder/app，讓使用者知道上下文來自哪裡。 |
| Codex | 獨立視圖，可用本機資料夾、repository、terminal、developer tools；歷史與 ChatGPT 分開。 | 沒有可選的 Codex 視圖。 | 桌面專屬功能不要畫成兩端都有。 |
| Library | 官方文件目前沒有承諾完整桌面 Library；舊 macOS Chat Bar 支援上傳本機檔案/照片/截圖，新桌面 Work 可使用本機資料夾。 | 有完整 Library，可搜尋、管理、重用、下載/刪除檔案。 | AgentBridge 如要達成使用者期望，應自行提供桌面檔案庫並接上 metadata/storage。 |
| Search | macOS 既有版本提供聊天搜尋；目前跨聊天/專案/檔案的官方新說明主要列 web/iOS/Android，桌面支援面未明確說明。 | 支援 sidebar search；可用 Cmd+K，官方說明搜尋聊天、專案、圖片、文件、可用的連線資料。 | 桌面搜尋用一致 UI；若服務端未支援跨資料索引，應以 filter 顯示實際範圍。 |
| 本機快捷與視窗 | Option+Space 開 Chat Bar/launcher；可上傳檔案、照片、截圖/拍照，快捷鍵能在設定調整；可搭配 menu bar/桌面快捷操作。 | Cmd+K 開搜尋，不能開原生 Chat Bar 或呼叫系統截圖。 | macOS 增加快捷鍵、原生 file picker 和權限引導；web 維持瀏覽器行為。 |
| 內建瀏覽器 | ChatGPT Desktop macOS/Windows 之 Work/Codex 可從工具列或快捷鍵打開內建瀏覽器。 | 瀏覽器功能由 web 頁面或瀏覽器本身提供，沒有 desktop app 的內嵌 agent browser 狀態。 | 只在桌面版顯示 Browser 工具與目前頁面權限狀態。 |

同步邊界要在 UI 裡說清楚：Chat 與 cloud Work 可以跨 web/桌面接續；Local Work 留在電腦上執行；Codex 的工作流和歷史獨立。方案、角色、地區、管理員設定也會改變外掛、檔案、Work 和語音入口是否可用。

## 可實作的介面節奏與狀態

OpenAI 公開的舊 macOS release note 有明確提到回覆採平滑 fade-in 動畫，並有逐字串流回覆；公開文件沒有提供當前桌面版的 easing、毫秒數或逐項 hover 動畫規格。以下是重建時的行為建議，而非 OpenAI 官方規格：

1. 側欄收合/展開時主視圖平滑移動，收合保留 icon 導覽；目前頁面以背景和文字狀態辨識。
2. 按鈕 hover / focus 用短暫底色變化，選單和搜尋面板淡入，避免裝飾性彈跳；遵守系統或 App 的 reduced-motion 設定。
3. Composer 的 + 選單應從按鈕旁出現；選檔後附件 chip 先顯示檔名/縮圖，再顯示上傳進度、失敗及重試。
4. 送出時立即顯示使用者訊息，助理內容持續串流；工具執行、等待使用者回答、等待核准、完成與失敗各自有清楚狀態。
5. 切換 Projects、Plugins、Library、Settings 使用同一主視圖容器和穩定導覽，空狀態也要有可執行的下一步（建立、上傳、連接、搜尋）。

## 後端與持久化能力

| 服務 | 必要能力 |
|---|---|
| Identity / account | 登入 session、工作區選擇、角色/方案/地區 entitlement、斷線/過期恢復。 |
| Chats | 建立/載入/排序/重命名/封存/刪除/釘選、Chat/Work 分類、搜尋與分頁、同步規則。 |
| Conversation protocol | 使用者/助理多訊息、串流 chunk、工具進度、stop/cancel、resume、失敗恢復；保留 UTF-8 邊界正確性和多工具輸出。 |
| Files | 本機選取、上傳、storage ID、chat/project 關聯、檔名/類型/大小/縮圖/建立時間 metadata、搜尋/篩選/預覽/下載/刪除、配額與授權錯誤。 |
| Plugins / Apps | 目錄與 manifest、plugin 內容、app connector OAuth、選帳號、token 刷新、連線狀態、工具 schema、read/write permissions、approval 與 admin deny 狀態。 |
| Projects | 專案/來源/chat/instructions/memory 資料、色彩圖示、共享/成員權限、專案搜尋和跨裝置同步。 |
| Settings | 使用者 vs 工作區設定 scope、更新確認、錯誤回復；local appearance / reduced motion / shortcut 不應錯寫到雲端工作區。 |
| Desktop bridge | macOS 原生 file picker、menu bar / global shortcut（若實作）、截圖/相機/麥克風/Accessibility 權限狀態；能力未實際連線時不得顯示已連線。 |

## 官方來源

- [Moving to the new ChatGPT desktop app](https://help.openai.com/en/articles/20001276-moving-to-the-new-chatgpt-desktop-app)
- [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)
- [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
- [Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex)
- [Connected apps in ChatGPT](https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt)
- [Using Library to manage files in ChatGPT](https://help.openai.com/en/articles/20001052-using-library-to-manage-files-in-chatgpt)
- [Finding chats, projects, and files](https://help.openai.com/en/articles/10056348-finding-your-chats-projects-and-files-in-chatgpt)
- [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
- [ChatGPT macOS app release notes](https://help.openai.com/en/articles/9703738-chatgpt-macos-app-release-notes)
- [How to launch the Chat Bar](https://help.openai.com/en/articles/9295241-how-to-launch-the-chat-bar)
- [Work with Apps on macOS](https://help.openai.com/en/articles/10119604-work-with-apps-on-macos)
- [Deleting and archiving chats](https://help.openai.com/en/articles/8809935-deleting-and-archiving-chats-in-chatgpt)
- [Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)
- [Data controls in ChatGPT](https://help.openai.com/en/articles/7730893-data-controls-in-chatgpt)
- [File Uploads FAQ](https://help.openai.com/en/articles/8555545-file-uploads-faq)
- [Using the built-in browser in the ChatGPT desktop app](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app)
