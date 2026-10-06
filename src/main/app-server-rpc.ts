import { EventEmitter } from "node:events";
export type RpcId = string | number;
export interface RpcTransport {
  write(data: string): unknown;
  on(event: "data" | "close" | "error", callback: (...args: any[]) => void): unknown;
  close?(): unknown;
}
export interface RpcRequest { id: RpcId; method: string; params?: any }
/** Newline-delimited App Server JSON-RPC; no HTTP listener or credential transport. */
export class AppServerRpc extends EventEmitter {
  private nextId = 0;
  private decoder = new TextDecoder();
  private buffer = "";
  private closed = false;
  private pending = new Map<RpcId, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  get isClosed() { return this.closed; }
  constructor(private transport: RpcTransport) {
    super();
    transport.on("data", (chunk: Buffer | string) => {
      try { this.consume(chunk); } catch (error) { this.shutdown(error instanceof Error ? error : new Error(String(error))); }
    });
    transport.on("error", (error: Error) => this.shutdown(error));
    transport.on("close", () => this.shutdown(new Error("App Server 連線已關閉。")));
  }
  request<T = any>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("App Server 未連線。"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`App Server ${method} 逾時。`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params?: unknown) { this.send({ method, ...(params === undefined ? {} : { params }) }); }
  respond(id: RpcId, result: unknown) { this.send({ id, result }); }
  reject(id: RpcId, message: string, code = -32601) { this.send({ id, error: { code, message } }); }
  private send(value: unknown) {
    if (this.closed) throw new Error("App Server 未連線。");
    this.transport.write(JSON.stringify(value) + "\n");
  }
  private consume(chunk: Buffer | string) {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.buffer.length > 16 * 1024 * 1024) throw new Error("App Server 訊息超過解析上限。");
    let offset: number;
    while ((offset = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, offset).trim();
      this.buffer = this.buffer.slice(offset + 1);
      if (!line) continue;
      let message: any;
      try { message = JSON.parse(line); } catch { throw new Error("App Server 傳回非 JSON 資料。請檢查啟動腳本沒有額外輸出。"); }
      if (message === null || typeof message !== "object" || Array.isArray(message)) throw new Error("App Server 訊息格式無效。");
      if (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number") throw new Error("App Server request id 格式無效。");
      if (typeof message.method === "string") this.emit(message.id === undefined ? "notification" : "request", message);
      else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(typeof message.error.message === "string" ? message.error.message : "App Server RPC 失敗。"));
        else if (Object.prototype.hasOwnProperty.call(message, "result")) pending.resolve(message.result);
        else pending.reject(new Error("App Server 回覆缺少 result 或 error。"));
      }
    }
  }
  close() { this.shutdown(new Error("已中斷 App Server 連線。")); }
  private shutdown(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit("closed", error);
    this.transport.close?.();
  }
}
export function powershellQuote(value: string) {
  if (/[\0\r\n]/.test(value)) throw new Error("執行檔路徑包含無效字元。");
  return "'" + value.replace(/'/g, "''") + "'";
}
export function appServerCommand(platform: "windows" | "posix", executable: string, args: string[], isolateExecutor = false) {
  if (!executable || executable.length > 4096 || /[\0\r\n]/.test(executable)) throw new Error("請提供有效的 Codex 執行檔路徑。");
  if (platform === "windows") {
    const isolated = isolateExecutor ? "$bridgeHome=if($env:CODEX_HOME){$env:CODEX_HOME}else{Join-Path $env:USERPROFILE '.codex'}; if(Test-Path -LiteralPath (Join-Path $bridgeHome 'environments.toml')){throw 'AgentBridge requires no Runtime environments.toml override; rename it before connecting.'}; $env:CODEX_EXEC_SERVER_URL='none'; " : "";
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; ${isolated}& ${[executable, ...args].map(powershellQuote).join(" ")}; exit $LASTEXITCODE`;
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  const quote = (value: string) => { if (value.includes("\0")) throw new Error("參數包含無效字元。"); return "'" + value.replace(/'/g, "'\\''") + "'"; };
  const isolated = isolateExecutor ? 'bridge_home="${CODEX_HOME:-$HOME/.codex}"; if [ -e "$bridge_home/environments.toml" ]; then echo "AgentBridge requires no Runtime environments.toml override; rename it before connecting." >&2; exit 78; fi; export CODEX_EXEC_SERVER_URL=none; ' : "";
  return `bash -lc ${quote(`${isolated}exec ${[executable, ...args].map(quote).join(" ")}`)}`;
}
export function chooseStdioFlag(help: string) {
  if (/--stdio\b/.test(help)) return "--stdio";
  if (/--listen\b/.test(help) && /stdio:\/\//.test(help)) return "--listen";
  throw new Error("這個 Codex 版本沒有可驗證的 App Server stdio 支援，請在 Runtime 主機更新 Codex。");
}
export function accountSummary(response: any) {
  const account = response?.account;
  return { authenticated: Boolean(account), type: typeof account?.type === "string" ? account.type : "none", ...(typeof account?.planType === "string" ? { planType: account.planType } : {}) };
}
export function accountUpdateSummary(params: any) {
  // An account/updated notification uses authMode, including null on logout.
  // Never retain authenticated=true or a previous plan after account changes.
  return accountSummary({ account: typeof params?.authMode === "string" ? { type: params.authMode, planType: params.planType } : null });
}
export function modelSummary(response: any) {
  return (Array.isArray(response?.data) ? response.data : []).filter((item: any) => item && typeof item.id === "string" && !item.hidden).map((item: any) => ({
    id: String(item.id), model: String(item.model || item.id), displayName: String(item.displayName || item.id),
    supportedReasoningEfforts: Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.filter((e: any) => e && typeof e.reasoningEffort === "string").map((e: any) => ({ reasoningEffort: e.reasoningEffort, description: typeof e.description === "string" ? e.description : "" })) : [],
    defaultReasoningEffort: item.defaultReasoningEffort || "medium", isDefault: item.isDefault === true
  }));
}
