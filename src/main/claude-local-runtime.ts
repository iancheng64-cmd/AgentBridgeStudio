import {readNativeClaudeAuthStatus} from './claude-auth-probe';
import {enableNativeAutoCompact} from './claude-compaction';
import {readClaudeSubscriptionUsage} from './claude-usage-reader';
import {claudeSubscriptionSummary} from './runtime-usage';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareClaudeAuth, type ClaudeAuthLaunch, type ClaudeAuthMode, type ClaudeApiSettings } from "./claude-auth-mode";
import {mergeClaudeRateLimitSummary,type ClaudeQuotaSummary} from "./runtime-usage";
import { ClaudeLocalProtocol, type ClaudeTransport } from "./claude-local-protocol";

const capture = promisify(execFile);
export type ClaudePermissionMode = "ask" | "project" | "full";
export interface ClaudePermission { id: string; toolName: string; input: Record<string, unknown>; signal: AbortSignal }
export interface ClaudeLocalOptions {
  authMode?:ClaudeAuthMode; api?:ClaudeApiSettings;
  remote?:{launch(args:string[],options:{authMode:ClaudeAuthMode;api?:ClaudeApiSettings;mcpToken?:string;autoCompactPercent?:number}):Promise<{transport:ClaudeTransport;version:string;account:any;platform:string;cwd:string;configDir?:string;credentialDir?:string;close():Promise<void>}>};
  cwd: string; executable?: string; permissionMode?: ClaudePermissionMode;
  model?: string; effort?: string; additionalDirectories?: string[]; autoCompactPercent?: number;
  mcp?: { name?: string; url: string; token: string };
  onEvent?: (event: any) => void;
  onPermission?: (request: ClaudePermission) => Promise<{ allow: boolean; updatedInput?: Record<string, unknown> }>;
}
export const DEFAULT_CLAUDE_AUTOCOMPACT_PERCENT=70;
export function claudeAutoCompactEnv(base:NodeJS.ProcessEnv,percent=DEFAULT_CLAUDE_AUTOCOMPACT_PERCENT){
  const requested=Number.isFinite(percent)?Math.max(10,Math.min(95,Math.round(percent))):DEFAULT_CLAUDE_AUTOCOMPACT_PERCENT;
  const existing=Number(base.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  const effective=Number.isFinite(existing)&&existing>=1&&existing<=100?Math.min(existing,requested):requested;
  const env: NodeJS.ProcessEnv = { ...base, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(effective) };
  delete env.DISABLE_AUTO_COMPACT; delete env.DISABLE_COMPACT;
  return env;
}
export async function findClaudeExecutable(explicit?: string) {
  const candidates = explicit ? [explicit] : [path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", ...((process.env.PATH || "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, "claude")))];
  for (const file of candidates) {
    if (!path.isAbsolute(file)) continue;
    try { await fs.access(file, 1); if ((await fs.stat(file)).isFile()) return file; } catch {}
  }
  throw new Error("這台 Mac 尚未找到 Claude Code。請先安裝原生 Claude Code CLI。");
}
export async function probeClaudeAuth(executable:string,authLaunch?:ClaudeAuthLaunch,cwd=process.cwd()){
 return readNativeClaudeAuthStatus(executable,authLaunch?.args||[],authLaunch?.env||process.env,cwd);
}
export function claudeArguments(options: ClaudeLocalOptions, sessionId?: string) {
  const mode = options.permissionMode === "full" ? "bypassPermissions" : options.permissionMode === "project" ? "acceptEdits" : "default";
  const args = ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--permission-prompt-tool", "stdio", "--permission-mode", mode,
    "--append-system-prompt", options.remote?"Your native Claude Code Runtime and account run on the friend Runtime host. ALL user work files, shell commands, app interactions and browser operations must execute on the user Mac through agentbridge_mac tools. Mac working directory: "+options.cwd+". For commands automatically use mac_shell_execute; for files use mac_fs tools; for UI/browser use the matching Mac tools. Never execute a work command or edit a work file on the Runtime host. Choose tools automatically without requiring users to name MCP. Native Skills and slash commands from the Runtime may provide instructions; apply those instructions using the Mac tools. Native host hooks and non-Mac MCP servers are intentionally disabled for this split route.":"You are running inside AgentBridge Studio on the user's Mac. Native Bash, Read, Edit and Write tools execute on this Mac. For requests to inspect or operate apps, windows or browsers, use the connected agentbridge_mac MCP tools automatically; users do not need to name MCP tools. Read the tool's app state before interacting, verify the resulting state, prefer AX elements, and use delivery=direct only when foreground interaction is authorized. Never substitute a remote Windows shell. Preserve the user's native Claude skills, plugins and configured MCP integrations."];
  if (options.model && options.model !== "default") { if(options.model.length>200||/[\s\x00-\x1f]/.test(options.model))throw new Error("模型 ID 格式無效。");args.push("--model", options.model); }
  if (options.effort) { if (!["low", "medium", "high", "xhigh", "max"].includes(options.effort)) throw new Error("Claude 思考強度無效。"); args.push("--effort", options.effort); }
  if (sessionId) { if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error("Claude 對話識別碼無效。"); args.push("--resume", sessionId); }
  for (const dir of options.additionalDirectories || []) args.push("--add-dir", dir);
  if (options.mcp) {
    const url = new URL(options.mcp.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash) throw new Error("Mac MCP 必須使用本機 loopback 端點。");
    args.push("--mcp-config", JSON.stringify({ mcpServers: { [options.mcp.name || "agentbridge_mac"]: { type: "http", url: options.mcp.url, headers: { Authorization: "Bearer ${AGENTBRIDGE_MAC_MCP_TOKEN}" } } } }));
  }
  return args;
}
export function claudeModelSummary(models: any[]) {
  return (Array.isArray(models) ? models : []).filter(m => typeof m.value === "string").map(m => ({ id: m.value, model: m.value, displayName: m.displayName || m.value, description: m.description || "", isDefault: m.value === "default", supportedReasoningEfforts: (m.supportedEffortLevels || []).map((effort: string) => ({ reasoningEffort: effort, description: effort })), defaultReasoningEffort: m.supportsEffort&&m.supportedEffortLevels?.includes("high")?"high":undefined }));
}
/** One native Mac CLI session, restarted only for conversation/effort changes. */
export class ClaudeLocalRuntime {
  readonly id = randomUUID();
  private child?: ChildProcessWithoutNullStreams;
  private remoteProcess?:{close():Promise<void>};
  private remotePlatform?:string;
  private remoteCwd?:string;
  private remoteConfigDir?:string;
  private remoteCredentialDir?:string;
  private protocol?: ClaudeLocalProtocol;
  private executable = "";
  private initialized: any = {};
  private nativePlugins:Array<{name:string}>=[];
  private account: any = {};
  private version = "";
  private authLaunch?:ClaudeAuthLaunch;
  private sessionId?: string;
  private stopped = false;
  private permissionChanged = false;
  private credentialsChanged = false;
  private cancelling = false;
  private quota?:ClaudeQuotaSummary;
  private run?: { requestId: string; cancelled: boolean; messages: Map<string, string>; messageId: string; lastError?: string; completion?: { resolve: (result: { requestId: string; conversationId?: string; text: string; status: "completed" | "cancelled" | "error" }) => void; reject: (error: Error) => void } };
  private permissions = new Map<string, AbortController>();
  constructor(private options: ClaudeLocalOptions) {}
  get activeRequestId() { return this.run?.requestId; }
  get busy() { return !!this.run||this.cancelling; }
  setPermissionMode(mode:ClaudePermissionMode){if(this.busy&&this.options.permissionMode==='full'&&mode!=='full')throw new Error('請先停止目前工作，再降低操作權限。');if(this.options.permissionMode!==mode){this.options.permissionMode=mode;this.permissionChanged=true;}}
  private emit(event: any) { this.options.onEvent?.({ runtimeId: this.id, ...(this.run ? { requestId: this.run.requestId } : {}), ...event }); }
  async start() {
    this.options.cwd = await fs.realpath(this.options.cwd);
    if (!(await fs.stat(this.options.cwd)).isDirectory()) throw new Error("Claude 的 Mac 工作目錄必須是資料夾。");
    if(this.options.remote){await this.launch();return this.status();}
    this.executable = await findClaudeExecutable(this.options.executable);
    this.authLaunch=await prepareClaudeAuth(this.options.authMode||"api",this.options.cwd,this.options.api);
    const [version, auth] = await Promise.all([capture(this.executable, ["--version"], { timeout: 10_000, maxBuffer: 64 * 1024 }), probeClaudeAuth(this.executable,this.authLaunch,this.options.cwd)]);
    this.version = version.stdout.trim().slice(0, 120); this.account = auth;
    await this.launch(); return this.status();
  }
  status() {
    const source = this.initialized.account?.tokenSource;
    return { runtimeId: this.id, agent: "claude", status: this.stopped ? "closed" : "connected", runtimeVersion: this.version, runtimePlatform: this.remotePlatform||"darwin",runtimeLocation:this.options.remote?"remote":"local",remoteCwd:this.remoteCwd,claudeConfigDir:this.remoteConfigDir,claudeCredentialDir:this.remoteCredentialDir,hostName: "這台 Mac · Claude Code", localCwd: this.options.cwd, authMode:this.options.authMode||"api",
      toolExecution: "local-executor", executorConnected: !!(this.child||this.remoteProcess), permissionMode: this.options.permissionMode || "ask", models: claudeModelSummary(this.initialized.models),
      account: { ...this.account, ...(this.options.authMode==="official"&&(this.account.verified!==true||/api.?key|console|bedrock|vertex|foundry/i.test(this.account.authMethod||''))&&source&&!["oauth","claude.ai","claudeAiOauth"].some(kind=>String(source).toLowerCase().includes(kind.toLowerCase()))?{authenticated:false}:{}), ...(typeof source === "string" ? { credentialSource: source } : {}) },
      capabilities: { localTools: !!(this.child||this.remoteProcess), fileShell: !!(this.child||this.remoteProcess), macMcp: !!this.options.mcp, reason: this.options.remote?"Claude Code 與帳號在朋友主機；檔案、命令、電腦與瀏覽器工具在這台 Mac 執行。":"Claude Code 原生工具、Skills、Plugins 與 MCP 在這台 Mac 執行。" },
      commands: this.initialized.commands || [], agents: this.initialized.agents || [], quota:this.quota, autoCompactPercent:this.options.autoCompactPercent??DEFAULT_CLAUDE_AUTOCOMPACT_PERCENT,
      diagnostic: (this.account.nativeAuthenticated&&!this.account.authenticated?'原生設定已有登入（'+String(this.account.nativeAuthMethod)+'），目前官方隔離模式未驗證。請核對登入模式與設定。 ':'')+(this.options.authMode==="official"?"官方帳號模式已隔離自訂 API／模型覆寫；登入由原生 Claude Code 管理。模型是否可用以實際回覆為準。":"API 模式沿用現有供應商或本次設定；不代表官方訂閱，模型是否可用以實際回覆為準。") };
  }
  private quotaPending?:Promise<any>;
  private quotaChecked=0;
  async refreshQuota(){
    if(this.quotaPending)return this.quotaPending;
    if(Date.now()-this.quotaChecked<60000&&this.quota?.status==='available')return this.quota;
    const errors:Record<string,string>={CREDENTIAL_UNREADABLE:'Claude 憑證檔無法讀取或格式無效；請在 Runtime 核對檔案權限與原生登入。',USAGE_RESPONSE:'官方額度回應格式目前無法辨識；已保留先前快照。',USAGE_NETWORK:'Runtime 無法連到官方額度服務，請檢查網路後再更新。',API_MODE:'API 模式不提供 Claude 訂閱額度。',NO_OAUTH:'額度讀取器未找到目前 Claude 設定的官方 OAuth 憑證。這不代表您未登入；請核對 Runtime 使用者、設定資料夾與登入模式。',OAUTH_EXPIRED:'額度查詢憑證已過期或遭拒絕；請更新原生 Claude 登入後重試。',KEYCHAIN_UNAVAILABLE:'額度讀取器無法讀取這個 Claude 設定資料夾的原生鑰匙圈授權；登入仍可能有效。請在 Runtime 解鎖鑰匙圈並更新。',USAGE_RATE_LIMIT:'額度服務暫時限制查詢，請稍後再試。',OAUTH_USAGE_UNSUPPORTED:'目前使用 setup-token 官方登入：能執行模型工作，但此 Token 僅供模型請求，無法查詢訂閱額度。額度查詢需要 Runtime 的完整原生登入。',USAGE_FORBIDDEN:'官方額度服務拒絕查詢；目前憑證可能沒有額度讀取權限，這不代表訂閱已用完。'};
    this.quotaPending=(async()=>{
      try{const result=this.options.authMode!=='official'?{ok:false,code:'API_MODE'}:this.options.remote?await this.protocol!.request('agentbridge_usage',{},25000):await readClaudeSubscriptionUsage(this.authLaunch?.env.CLAUDE_CONFIG_DIR,this.authLaunch?.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,this.authLaunch?.env.CLAUDE_CODE_OAUTH_TOKEN);
        if(result.auth?.verified===true)this.account=result.auth;
        if(result.ok){this.account={...this.account,authenticated:true,verified:true,authMethod:'claude.ai',apiProvider:'firstParty'};this.quota=claudeSubscriptionSummary(result,result.checkedAt);this.emit({type:'status',snapshot:{account:this.status().account,quota:this.quota}});}else this.quota={...(this.quota||{updatedAt:0,windows:[]}),checkedAt:Date.now(),status:'unavailable',stale:true,error:(errors[result.code]||'目前無法取得 Claude 訂閱額度；保留先前快照，未提供不代表零。')+(result.auth?.nativeAuthenticated===true?' 原生設定已有登入（'+String(result.auth.nativeAuthMethod)+'），請核對官方帳號／API 模式是否一致。':'')+(result.auth?.verified===false?' 原生登入探測沒有回傳有效狀態，請更新 Runtime 狀態。':''),code:result.code};
      }catch{this.quota={...(this.quota||{updatedAt:0,windows:[]}),checkedAt:Date.now(),status:'unavailable',stale:true,error:'額度查詢未成功；請確認 Runtime 與 Claude 官方服務連線。'};}
      this.quotaChecked=Date.now();this.emit({type:'claudeQuota',quota:this.quota});return this.quota;
    })();try{return await this.quotaPending;}finally{this.quotaPending=undefined;}
  }
  async refreshAccount(){
    const next=this.options.remote?await this.protocol!.request('agentbridge_auth_status',{},20000):await probeClaudeAuth(this.executable,this.authLaunch,this.options.cwd);
    if(next.verified===true){
      const changed=!!(this.account.accountKey&&next.accountKey&&this.account.accountKey!==next.accountKey);
      if(changed||!this.account.authenticated&&next.authenticated)this.credentialsChanged=true;
      if(changed||!next.authenticated){this.quota=undefined;this.emit({type:'claudeQuota',quota:undefined});}
    }
    this.account=next;
    this.quotaChecked=0;return this.status();
  }
  async extensions() {
    let mcp: any = {};
    try { mcp = await this.protocol?.request("mcp_status"); } catch {}
    return { commands: this.initialized.commands || [], agents: this.initialized.agents || [], plugins:this.nativePlugins, mcp: Array.isArray(mcp.mcpServers) ? mcp.mcpServers.map((s: any) => ({ name: s.name, status: s.status, tools: Array.isArray(s.tools) ? s.tools.map((t: any) => ({ name: t.name })) : [] })) : [] };
  }
  private async launch(resume?: string) {
    if (this.stopped) throw new Error("Claude 本機連線已關閉。");
    let transport:ClaudeTransport;
    if(this.options.remote){
      const remote=await this.options.remote.launch(claudeArguments(this.options,resume),{authMode:this.options.authMode||"api",api:this.options.api,mcpToken:this.options.mcp?.token,autoCompactPercent:this.options.autoCompactPercent??DEFAULT_CLAUDE_AUTOCOMPACT_PERCENT});
      this.remoteProcess=remote;this.version=remote.version;this.account=remote.account;this.remotePlatform=remote.platform;this.remoteCwd=remote.cwd;this.remoteConfigDir=remote.configDir;this.remoteCredentialDir=remote.credentialDir;transport=remote.transport;
    }else{
      enableNativeAutoCompact(this.authLaunch?.env.CLAUDE_CONFIG_DIR);
      const env = claudeAutoCompactEnv({ ...(this.authLaunch?.env||process.env), ...(this.options.mcp ? { AGENTBRIDGE_MAC_MCP_TOKEN: this.options.mcp.token } : {}) },this.options.autoCompactPercent);
      const child = spawn(this.executable, [...(this.authLaunch?.args||[]),...claudeArguments(this.options, resume)], { cwd: this.options.cwd, env, stdio: "pipe", detached: true });this.child=child;
      transport = new EventEmitter() as ClaudeTransport;transport.write = data => child.stdin.write(data);
      child.stdout.on("data", chunk => transport.emit("data", chunk));child.stderr.on("data", () => {});
      child.stdin.on("error", () => transport.emit("error", new Error("stdin closed")));child.on("error", () => transport.emit("error", new Error("spawn failed")));child.on("close", () => transport.emit("close"));
    }
    const protocol = new ClaudeLocalProtocol(transport); this.protocol = protocol;
    protocol.on("request", message => { void this.permission(message, protocol); });
    protocol.on("message", message => { if (this.protocol === protocol) this.message(message); });
    protocol.on("closed", error => {
      if (this.protocol !== protocol) return;
      if (this.run) { this.emit({ type: "error", text: error.message }); this.finish("error"); }
      this.emit({ type: "closed", text: error.message }); this.stopped = true; void this.closeProcess();
    });
    try { this.initialized = await protocol.request("initialize", {}, 30_000); }
    catch (error) { await this.closeProcess(); throw error; }
  }
  async send(input: { requestId?: string; prompt: string; conversationId?: string; model?: string; effort?: string; autoCompactPercent?:number; content?: unknown[] }) {
    if (this.stopped) throw new Error("Claude 本機連線尚未就緒。");
    if (this.run) throw new Error("Claude 還在處理上一則訊息。");
    if (!input.prompt?.trim() && !input.content?.length) throw new Error("請輸入訊息或加入附件。");
    if(!this.protocol)await this.launch(input.conversationId);
    const run = { requestId: input.requestId || randomUUID(), cancelled: false, messages: new Map<string, string>(), messageId: "assistant" }; this.run = run;
    try {
      const changedSession = this.sessionId && input.conversationId !== this.sessionId;
      const resumeNew = input.conversationId && input.conversationId !== this.sessionId;
      const compactChanged=input.autoCompactPercent!==undefined&&input.autoCompactPercent!==this.options.autoCompactPercent;
      if(compactChanged)this.options.autoCompactPercent=Math.max(10,Math.min(95,Number(input.autoCompactPercent)||70));
      const changedOptions = compactChanged || (input.model !== undefined && input.model !== this.options.model) || (input.effort !== undefined && input.effort !== this.options.effort);
      if (changedSession || resumeNew || changedOptions || this.permissionChanged || this.credentialsChanged) {
        await this.closeProcess(); this.options.model = input.model ?? this.options.model; this.options.effort = input.effort ?? this.options.effort;
        this.sessionId = input.conversationId;
        if (run.cancelled) { this.finish("cancelled"); return { requestId: run.requestId }; }
        await this.launch(input.conversationId); this.permissionChanged=false;this.credentialsChanged=false;
      }
      if (run.cancelled || this.run !== run) { this.finish("cancelled"); return { requestId: run.requestId }; }
      this.emit({ type: "activity", text: "Claude Code 正在這台 Mac 處理訊息" });
      this.protocol!.user(input.content || [{ type: "text", text: input.prompt }], input.conversationId);
      return { requestId: run.requestId };
    } catch (error) { if (this.run === run) this.finish("error"); throw error; }
  }
  async sendAndWait(input: { requestId?: string; prompt: string; conversationId?: string; model?: string; effort?: string }) {
    const requestId = input.requestId || randomUUID();
    let resolve!: (result: { requestId: string; conversationId?: string; text: string; status: "completed" | "cancelled" | "error" }) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<{ requestId: string; conversationId?: string; text: string; status: "completed" | "cancelled" | "error" }>((res, rej) => { resolve = res; reject = rej; });
    await this.send({ ...input, requestId });
    if (!this.run || this.run.requestId !== requestId) throw new Error("Claude 討論回合未啟動。");
    this.run.completion = { resolve, reject };
    const result = await completion;
    if (result.status !== "completed") throw new Error(this.run?.lastError || (result.status === "cancelled" ? "Claude 討論回合已取消。" : "Claude 討論回合失敗。"));
    if (!result.text.trim()) throw new Error("Claude 討論回合沒有回傳文字。");
    return result;
  }
  private async permission(message: any, protocol: ClaudeLocalProtocol) {
    const id = message.request_id; const request = message.request;
    if (typeof id !== "string") return;
    if (request?.subtype !== "can_use_tool") { try { protocol.reject(id); } catch {} return; }
    const controller = new AbortController(); this.permissions.set(id, controller);
    const run = this.run;
    try {
      if (!run || run.cancelled || typeof request.tool_name !== "string") { protocol.respond(id, { behavior: "deny", message: "No active user turn" }); return; }
      const answer = await this.options.onPermission?.({ id, toolName: request.tool_name, input: request.input || {}, signal: controller.signal });
      const allow = answer?.allow && !controller.signal.aborted && this.run === run && !run.cancelled;
      protocol.respond(id, allow ? { behavior: "allow", updatedInput: answer.updatedInput || request.input || {} } : { behavior: "deny", message: "The user denied or cancelled this operation" });
    } catch { try { protocol.respond(id, { behavior: "deny", message: "Permission approval unavailable" }); } catch {} }
    finally { this.permissions.delete(id); }
  }
  private message(event: any) {
    if(event.type==="rate_limit_event"){this.quota=mergeClaudeRateLimitSummary(this.quota,event.rate_limit_info);this.emit({type:"claudeQuota",quota:this.quota});return;}
    if (event.type === "system" && event.subtype === "init") {
      this.nativePlugins=(event.plugins||[]).filter((p:any)=>typeof p.name==="string").map((p:any)=>({name:p.name}));
      this.emit({ type: "metadata", tools: event.tools || [], plugins: this.nativePlugins, mcpServers: event.mcp_servers || [], model: event.model });
    }
    if(event.type==="system"&&event.subtype==="compact_boundary"){
      const meta=event.compactMetadata||event.compact_metadata||{},pre=Number(meta.preTokens??meta.pre_tokens),post=Number(meta.postTokens??meta.post_tokens),duration=Number(meta.durationMs??meta.duration_ms);
      const before=Number.isFinite(pre)?Math.round(pre).toLocaleString("en-US"):null,after=Number.isFinite(post)?Math.round(post).toLocaleString("en-US"):null;
      this.emit({type:"contextCompacted",preTokens:Number.isFinite(pre)?pre:null,postTokens:Number.isFinite(post)?post:null,durationMs:Number.isFinite(duration)?duration:null,trigger:meta.trigger||"auto"});
      this.emit({type:"activity",text:before&&after?"Claude 已自動壓縮上下文："+before+" → "+after+" tokens":"Claude 已完成上下文自動壓縮"});
    }
    const run = this.run; if (!run) return;
    if (event.session_id && event.session_id !== this.sessionId) { this.sessionId = event.session_id; this.emit({ type: "session", conversationId: this.sessionId }); }
    if (event.parent_tool_use_id) return; // Nested-agent text does not overwrite the main reply.
    const publish = (id: string, text: string) => { run.messages.set(id, text); this.emit({ type: "message", text: [...run.messages.values()].filter(Boolean).join("\n\n") }); };
    if (event.type === "stream_event") {
      const inner = event.event || {};
      if (inner.type === "message_start") run.messageId = inner.message?.id || randomUUID();
      if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta") publish(run.messageId, (run.messages.get(run.messageId) || "") + inner.delta.text);
      if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use") this.emit({ type: "tool", itemId: inner.content_block.id, tool: inner.content_block.name, title: inner.content_block.name, status: "running", executionLocation: "local" });
    } else if (event.type === "assistant") {
      const parts = event.message?.content || [];
      const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
      if (text) publish(event.message.id || run.messageId, text);
      for (const tool of parts.filter((p: any) => p.type === "tool_use")) this.emit({ type: "tool", itemId: tool.id, tool: tool.name, title: tool.name, text: JSON.stringify(tool.input || {}).slice(0, 8000), status: "running", executionLocation: "local" });
    } else if (event.type === "user") {
      for (const tool of (event.message?.content || []).filter((p: any) => p.type === "tool_result")) {
        const content = Array.isArray(tool.content) ? tool.content : [];
        const image = content.find((p: any) => p.type === "image" && p.source?.type === "base64" && typeof p.source.data === "string" && p.source.data.length < 12 * 1024 * 1024 && /^image\/(png|jpeg|webp|gif)$/.test(p.source.media_type));
        this.emit({ type: "tool", itemId: tool.tool_use_id, status: tool.is_error ? "error" : "completed", text: typeof tool.content === "string" ? tool.content.slice(-16000) : content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n").slice(-16000), ...(image ? { image: `data:${image.source.media_type};base64,${image.source.data}` } : {}), executionLocation: "local" });
      }
    } else if (event.type === "result") {
      if (event.result && !run.messages.size && !event.is_error) publish("result", event.result);
      if (event.is_error) { run.lastError = typeof event.result === "string" ? event.result : (event.errors || []).join("\n") || "Claude Code 無法完成回覆。"; this.emit({ type: "error", text: run.lastError }); }
      const counts=[event.usage?.input_tokens,event.usage?.cache_read_input_tokens,event.usage?.cache_creation_input_tokens,event.usage?.output_tokens];
      this.emit({type:"usage",usage:{totalTokens:counts.every(n=>typeof n==="number"&&Number.isFinite(n)&&n>=0)?counts.reduce((a,b)=>a+b,0):null,cacheWriteTokens:event.usage?.cache_creation_input_tokens??null,inputTokens:event.usage?.input_tokens??null,cachedInputTokens:event.usage?.cache_read_input_tokens??null,outputTokens:event.usage?.output_tokens??null,costUsd:typeof event.total_cost_usd==="number"?event.total_cost_usd:null,source:"claude-native-result",complete:!!event.usage},turnId:event.session_id+":"+run.requestId});
      if(!this.cancelling)this.finish(run.cancelled ? "cancelled" : event.is_error ? "error" : "completed");
    }
  }
  private finish(status: string) {
    const run = this.run; if (!run) return;
    for (const controller of this.permissions.values()) controller.abort(); this.permissions.clear();
    this.emit({ type: "done", status, conversationId:this.sessionId, text: run.lastError, error: run.lastError });
    const result = { requestId: run.requestId, conversationId: this.sessionId, text: [...run.messages.values()].filter(Boolean).join("\n\n"), status: (status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "error") as "completed" | "cancelled" | "error" };
    this.run = undefined;
    run.completion?.resolve(result);
  }
  async cancel(requestId?: string) {
    const run = this.run; if (!run || (requestId && run.requestId !== requestId)) return { cancelled: false };
    if(this.cancelling)return{cancelled:true};
    this.cancelling=true;
    try{
    run.cancelled = true; for (const controller of this.permissions.values()) controller.abort();
    try { await this.protocol?.request("interrupt", {}, 5000); } catch {}
    // Even a version without reliable interruption must not leave a command running.
    await this.closeProcess();
    if(!this.stopped)try{await this.launch(this.sessionId);}catch{this.stopped=true;}
    if(this.run===run)this.finish("cancelled");
    if(this.stopped)this.emit({type:"closed",text:"Claude 已停止，請重新連線後在同一段對話接續。"});
    return { cancelled: true };
    }finally{this.cancelling=false;}
  }
  private async closeProcess() {
    const remote=this.remoteProcess;this.remoteProcess=undefined;
    const child = this.child; const protocol = this.protocol; this.child = undefined; this.protocol = undefined; protocol?.close();
    if(remote){await remote.close();return;}
    if (!child?.pid) return;
    const signal = (name: NodeJS.Signals) => { try { process.kill(-child.pid!, name); } catch {} };
    child.stdin.end(); signal("SIGTERM");
    await new Promise<void>(resolve => { const timer = setTimeout(() => { signal("SIGKILL"); resolve(); }, 800); child.once("close", () => { clearTimeout(timer); signal("SIGKILL"); resolve(); }); });
  }
  async stop() { this.stopped = true; for (const controller of this.permissions.values()) controller.abort(); await this.closeProcess(); if (this.run) this.finish("cancelled"); await this.authLaunch?.cleanup();this.authLaunch=undefined; }
}
