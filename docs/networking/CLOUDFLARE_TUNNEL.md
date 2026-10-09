# Cloudflare Tunnel 設定

Gateway 安裝包已內含 cloudflared。你尚未提供公開網址，本次沒有代你建立 Cloudflare 帳戶、網域或 Tunnel；這些需要遠端主機擁有者自行登入。

## 暫時測試

先開啟 Gateway，再開啟 `QuickTunnel`。cloudflared 會顯示臨時 HTTPS 網址；在 Mac App 填此網址、重新產生配對碼並配對。此方式不需 SSH 或自行開放入站埠，但網址不固定、不適合正式長期使用。Quick Tunnel 的服務限制由 Cloudflare 決定。

## 固定網域

使用自己的 Cloudflare 網域，在遠端 Gateway 資料夾執行內建 cloudflared：

```text
cloudflared tunnel login
cloudflared tunnel create agentbridge
cloudflared tunnel route dns agentbridge bridge.example.com
```

Windows 使用 `cloudflared.exe`；Mac 使用 `./cloudflared`。登入由瀏覽器完成，勿把憑證傳给其他人。

在使用者家目錄 `.cloudflared/config.yml` 設定：

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: ABSOLUTE_PATH_TO_TUNNEL_CREDENTIALS_JSON
ingress:
  - hostname: bridge.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

使用真實 Tunnel ID 與憑證檔路徑替换範例，開啟 `StartTunnel`。不把憑證檔、配對碼或 token 提交 GitHub。Gateway 只接受原生 App 的 bearer 認證，不支援中間的 Cloudflare Access 瀏覽器登入頁；若額外啟用 Access，需要自行配置相容的服務身分，不能在 App 關閉 TLS 驗證來繞過。

Mac 用 HTTPS/WSS **443** 連線，但遠端 cloudflared 的出口需 **7844 TCP（HTTP/2）或 UDP（QUIC）**，不能把「Mac 只需 443」理解成所有設備都只需 443。若 Gateway 主機的網路也封鎖 7844，改用能提供標準 HTTPS/WSS 的自有反向代理，或把 Gateway 放在出口可用的設備。沒有修改／繞過任何校園防火牆。

官方依據：[Tunnel 防火牆需求](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)、[路由與 WebSocket 支援](https://developers.cloudflare.com/tunnel/concepts/routing/)、[Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)。
