# 連線診斷

App「設定 → 連線與 Agent」會保留 Direct／Relay 失敗階段，連接成功時顯示目前 SSH 或 HTTPS/WSS。Relay 的「檢查 HTTPS 連線」真正完成 HTTPS、設備驗證及 WSS 握手；不是只確認安裝檔存在。

| 狀態 | 檢查方式 |
|---|---|
| SSH 認證失敗 | SSH 主機可達，但帳號、驗證方式或主機端設定未通過；不能只憑錯誤斷言密碼錯 |
| 主機指紋確認 | 向主機擁有者核對；取消／變更身分不自動繞過 |
| DNS 錯誤 | 核對 Relay 主機名與 Tunnel DNS |
| TLS 錯誤 | 使用有效 HTTPS 憑證與系統信任鏈，不停用驗證 |
| Relay 未配對／授權撤銷 | 在同一 Gateway 重新產生一次性碼、App 配對；網址改變需重新配對 |
| WSS 無法建立 | 核對代理允許 WebSocket upgrade，沒有 Access 登入頁／非 Gateway 路由 |
| 原生 Runtime 未就緒 | 在 Gateway 擁有者帳戶確認原生 CLI、路徑、版本與官方登入；Gateway ready 不代表模型可用 |
| Claude 額度未提供 | 核對官方模式、Runtime OAuth 登入及服務回應；API 餘額不冒充訂閱額度 |
| 壓縮沒有完成事件 | UI 已套用門檻不等於已壓縮；以原生 compact_boundary 與對話記錄判定 |

真實帳戶與校園／跨網路部署需在設定公開網址後完成驗收。可用兩種模式依序送出一則文字、一個 Mac 唯讀檔案工作、附件、停止操作，再關閉／重開 Gateway 驗證歷史與重新連線。不要在已中斷工作上自動重做修改或命令。
