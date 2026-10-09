import {connectNetwork} from './connection-network';
import {runtimeFailure} from './runtime-errors';
import { rateLimitSummary, mergeRateLimitSummary, tokenCount, tokenDelta, type TokenCount } from "./runtime-usage";
import {permissionMode,codexPermissionPolicy} from './permission-policy';
import {captureRemote, resolveRemotePlatform, remoteLaunchError, type RuntimePlatform} from './remote-shell';
import { app, dialog, ipcMain, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { AppServerRpc, appServerCommand, chooseStdioFlag, accountSummary, accountUpdateSummary, modelSummary, type RpcRequest } from "./app-server-rpc";
import { findHostInstallation, LocalCodeModeHost, parseCodexVersion } from "./local-code-mode-host";

import { LocalExecServer, type ExecutorRegistration } from "./local-exec-server";
import { LoopbackForward } from "./loopback-forward";
import { LocalToolHost, type LocalToolCall, type LocalToolCommand } from "./local-tool-host";
import { isolatedRuntimeArgs, macThreadConfig, validateMacMcpInventory, isVerifiedExecutorVersion, VERIFIED_EXECUTOR_VERSIONS } from "./runtime-policy";
import { runtimeInput, type RuntimeAttachment } from "./runtime-attachments";
import type { MacExtensionServer } from "./mac-extension-servers";
import { localExtensionCatalog, writeExtensionManifest, macRuntimeInstructions, type RuntimeExtensionCatalog } from "./runtime-extensions";

interface ConnectInput {
  profile: any; password?: string; platform: RuntimePlatform; executable?: string;
  permissionMode?: "ask" | "project" | "full"; trustedFingerprint?: string; localCwd?: string; localHostExecutable?: string;
  autoCompactPercent?: number;
}
interface Dependencies { connectRelay?(input:any):Promise<Client>; connectConfig(payload: any): ConnectConfig; emit(channel: string, payload: unknown): void; window(): BrowserWindow | null;
  libraryEntries?(ids: string[]): Promise<RuntimeAttachment[]>; libraryRoot?: string; stateDirectory?:string;
  extensionServers?(cwd: string): Promise<MacExtensionServer[]>;
  extensions?(cwd: string): Promise<RuntimeExtensionCatalog>; readOnlyExtensionRoots?: string[];
  localTools?: { nativeCommand?: LocalToolCommand; browserCommand?: LocalToolCommand } | (()=>{nativeCommand?:LocalToolCommand;browserCommand?:LocalToolCommand});
}
export interface BackgroundTurnResult { requestId: string; conversationId?: string; text: string; status: "completed" | "cancelled" | "error" }
interface TurnRun { turnStarting?:boolean;acceptUsage?:boolean; usageBaseline?:TokenCount; usageComplete?:boolean; requestId: string; threadId?: string; turnId?: string; cancelled: boolean; messages: Map<string, string>; backgroundTextOnly?: boolean; backgroundError?: string; completion?: { resolve: (result: BackgroundTurnResult) => void; reject: (error: Error) => void } }
interface PendingRequest { request: RpcRequest; requestId?: string; localResolve?: (accepted: boolean) => void; timer?: NodeJS.Timeout }
interface Runtime {
  id: string; conn: Client; rpc: AppServerRpc; host?: LocalCodeModeHost; executor?: LocalExecServer; snapshot: any;
  executorUrl?:string; toolHost?: LocalToolHost; toolForward?: LoopbackForward; mcp?: { name: string; url: string; token: string; environmentId: string }; permissionMode: "ask" | "project" | "full"; manifestPath: string; extensionCatalog: RuntimeExtensionCatalog;
  run?: TurnRun; requests: Map<string, PendingRequest>; closed: boolean; localCwd: string;
  quotaEpoch:number;quotaRevision:number;quotaRequest:number;
  autoCompactPercent?: number;
  threadContextWindows: Map<string, number>;
  threadContextTokens: Map<string, number>;
  compactingThreads: Set<string>;
}
const runtimes = new Map<string, Runtime>();
const usageByThread=new Map<string,TokenCount>();
const quotaByRuntime=new Map<string,ReturnType<typeof rateLimitSummary>>();
async function readRuntimeQuota(runtime:Runtime){
  const {id,quotaEpoch:epoch,quotaRevision:revision}=runtime,sequence=++runtime.quotaRequest;
  const unavailable=(error:string)=>({...rateLimitSummary(null),error});
  if(!runtime.snapshot.account.authenticated)return unavailable('此 Runtime 帳戶尚未登入，無法讀取剩餘用量。');
  try{
    const raw=await runtime.rpc.request('account/rateLimits/read',{},15000);
    if(runtime.closed||epoch!==runtime.quotaEpoch)return{...unavailable('登入狀態已變更，請重新更新帳戶剩餘用量。'),resetBaseline:true};
    if(sequence!==runtime.quotaRequest||revision!==runtime.quotaRevision)return quotaByRuntime.get(id)||unavailable('剩餘用量正在更新，請稍後再試。');
    const quota=rateLimitSummary(raw);quotaByRuntime.set(id,quota);
    return quota.available?quota:{...quota,error:'此 Runtime 未提供可顯示的帳戶額度視窗。'};
  }catch{
    if(runtime.closed||epoch!==runtime.quotaEpoch)return{...unavailable('登入狀態已變更，請重新更新帳戶剩餘用量。'),resetBaseline:true};
    if(sequence!==runtime.quotaRequest||revision!==runtime.quotaRevision)return quotaByRuntime.get(id)||unavailable('剩餘用量正在更新，請稍後再試。');
    return{...unavailable('Runtime 暫時無法讀取剩餘用量；請按更新重試。'),...(quotaByRuntime.get(id)?.available?{lastKnown:quotaByRuntime.get(id)}:{})};
  }
}

function trustedHostsPath() { return path.join(app.getPath("userData"), "runtime-known-hosts.json"); }
function readTrustedHosts(): Record<string, string> { try { return JSON.parse(fs.readFileSync(trustedHostsPath(), "utf8")); } catch { return {}; } }
function trustHost(key: string, fingerprint: string) {
  const file = trustedHostsPath(); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify({ ...readTrustedHosts(), [key]: fingerprint }, null, 2), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
export function hostFingerprint(key: Buffer) { return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, ""); }
async function listModels(rpc: AppServerRpc) {
  const data: any[] = []; let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const response = await rpc.request("model/list", { ...(cursor ? { cursor } : {}) });
    data.push(...(Array.isArray(response.data) ? response.data : []));
    if (!response.nextCursor || response.nextCursor === cursor) break;
    cursor = response.nextCursor;
  }
  return modelSummary({ data });
}
function execChannel(conn: Client, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => conn.exec(command, { pty: false }, (error, stream) => error ? reject(error) : resolve(stream)));
}
function closeRuntime(runtime: Runtime, deps: Dependencies, reason = "Runtime 已中斷連線。") {
  if (runtime.closed) return; runtime.closed = true; runtimes.delete(runtime.id);quotaByRuntime.delete(runtime.id);
  for(const key of usageByThread.keys())if(key.startsWith(runtime.id+":"))usageByThread.delete(key);
  for (const pending of runtime.requests.values()) { clearTimeout(pending.timer); pending.localResolve?.(false); }
  for (const approvalId of runtime.requests.keys()) deps.emit("runtime:event", { runtimeId: runtime.id, type: "requestClosed", approvalId });
  runtime.requests.clear();
  if (runtime.run) {
    if (runtime.run.backgroundTextOnly) runtime.run.completion?.reject(new Error(reason));
    else deps.emit("runtime:event", { runtimeId: runtime.id, requestId: runtime.run.requestId, type: "done", status: "error", text: reason });
  }
  runtime.run = undefined;
  void fs.promises.rm(runtime.manifestPath, { force: true }).catch(() => {});
  runtime.rpc.close(); runtime.host?.stop(); runtime.executor?.stop(); runtime.toolForward?.stop(); void runtime.toolHost?.stop(); runtime.conn.end();
  deps.emit("runtime:event", { runtimeId: runtime.id, type: "closed", text: reason });
}
export function stopAllRuntimes(deps: Dependencies) { for (const runtime of runtimes.values()) closeRuntime(runtime, deps); }
function emitForRun(runtime: Runtime, deps: Dependencies, event: any) {
  if (runtime.run?.backgroundTextOnly) return;
  deps.emit("runtime:event", { runtimeId: runtime.id, ...(runtime.run ? { requestId: runtime.run.requestId } : {}), ...event });
}
/** Code Mode Host alone is insufficient. Only the version-matched, authenticated executor
 * enables chat; each turn separately verifies the Mac-only MCP inventory and environment binding. */
export function localToolCapability(hasCodeModeHost: boolean, hasExecutor = false, hasMacTools = false) {
  return {
    localTools: hasExecutor,
    fileShell: hasExecutor,
    macMcp: hasMacTools,
    reason: hasExecutor
      ? "命令與檔案工具使用此 Mac Executor；可用的 Mac 擴充工具依連線狀態顯示。"
      : hasCodeModeHost
        ? "Mac Code Mode Host 已連線，但它不會接管 Runtime 主機的命令與檔案工具；請兩端使用相同且已驗證的 Codex 版本。"
        : "尚無已驗證的 Mac 工具執行通道；請兩端使用相同且已驗證的 Codex 版本並重新連線。"
  };
}
function authorizeMacTool(runtime: Runtime | undefined, deps: Dependencies, call: LocalToolCall): Promise<boolean> {
  if (!runtime || runtime.closed || !runtime.run || runtime.run.cancelled) return Promise.resolve(false);
  if (runtime.run.backgroundTextOnly) return Promise.resolve(false);
  if (call.category === "agent-bridge" || runtime.permissionMode === "full" || (runtime.permissionMode === "project" && call.category === "filesystem-read")) return Promise.resolve(true);
  const active = runtime; const approvalId = randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => { active.requests.delete(approvalId); emitForRun(active, deps, { type: "requestClosed", approvalId }); resolve(false); }, 120000);
    active.requests.set(approvalId, { request: { id: approvalId, method: "local/tool", params: call }, requestId: active.run!.requestId, localResolve: resolve, timer });
    emitForRun(active, deps, { type: "approval", approvalId, executionLocation: "local", title: `允許在這台 Mac 使用 ${call.name}？`, detail: JSON.stringify(call.arguments, null, 2).slice(0, 8000) });
  });
}
async function refreshMacExtensions(runtime: Runtime, deps: Dependencies) {
  const catalog = deps.extensions ? localExtensionCatalog(await deps.extensions(runtime.localCwd)) : { items: [], warnings: ["Mac 擴充目錄尚未提供；仍可使用已連線的工具。"] };
  await writeExtensionManifest(runtime.manifestPath, catalog);
  runtime.extensionCatalog = catalog;
  return { ...catalog, toolHost: runtime.toolHost?.status(), executionLocation: "local" as const, runtimeVersion: runtime.snapshot.runtimeVersion };
}
async function verifyThreadMcp(runtime: Runtime, threadId: string, expectedConfig?: Record<string, unknown>) {
  const inventory: any[] = []; let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await runtime.rpc.request("mcpServerStatus/list", { threadId, limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.data)) throw new Error("Runtime 未提供有效的 MCP 工具清單。");
    inventory.push(...result.data); if (!result.nextCursor) {
      try { validateMacMcpInventory(inventory, runtime.mcp?.name); }
      catch (error) {
        // Only capability metadata, never endpoints, headers, auth or tool arguments.
        fs.writeFileSync(path.join(app.getPath("userData"),"runtime-isolation-diagnostic.json"),JSON.stringify({
          version:runtime.snapshot.runtimeVersion, expected:Object.entries((expectedConfig?.mcp_servers as any)||{}).map(([name,value]:any)=>({name,enabled:value.enabled})),
          inventory:inventory.map(item=>({name:item.name,status:item.runtimeStatus,toolCount:Object.keys(item.tools||{}).length,resourceCount:item.resources?.length||0,templateCount:item.resourceTemplates?.length||0}))
        },null,2),{mode:0o600});
        throw error;
      }
      return;
    }
    if (result.nextCursor === cursor) break; cursor = result.nextCursor;
  }
  throw new Error("Runtime MCP 工具清單無法完整驗證。");
}

function routeNotification(runtime: Runtime, deps: Dependencies, message: any) {
  const params = message.params || {}; const run = runtime.run;
  if (message.method === "account/updated") {
    // Do not forward identity fields or bearer tokens to the renderer.
    runtime.snapshot.account = accountUpdateSummary(params);
    runtime.quotaEpoch++;runtime.quotaRevision++;
    quotaByRuntime.delete(runtime.id);for(const key of usageByThread.keys())if(key.startsWith(runtime.id+":"))usageByThread.delete(key);
    deps.emit("runtime:event",{runtimeId:runtime.id,type:"quota",quota:{...rateLimitSummary(null),error:"登入狀態已變更，請重新更新帳號額度。",resetBaseline:true}});
    emitForRun(runtime, deps, { type: "status", snapshot: runtime.snapshot }); return;
  }
  if(message.method==="account/rateLimits/updated"){
    if(!runtime.snapshot.account.authenticated)return;
    runtime.quotaRevision++;
    const value=mergeRateLimitSummary(quotaByRuntime.get(runtime.id),params);quotaByRuntime.set(runtime.id,value);deps.emit("runtime:event",{runtimeId:runtime.id,type:"quota",quota:value});
    // A rolling event is not a full multi-bucket/account snapshot.
    const epoch=runtime.quotaEpoch;
    void readRuntimeQuota(runtime).then(quota=>{if(!runtime.closed&&epoch===runtime.quotaEpoch)deps.emit("runtime:event",{runtimeId:runtime.id,type:"quota",quota});});return;
  }
  if (message.method === "serverRequest/resolved") {
    for (const [id, pending] of runtime.requests) if (pending.request.id === params.requestId) { runtime.requests.delete(id); emitForRun(runtime, deps, { type: "requestClosed", approvalId: id }); }
    return;
  }
  if (message.method === "thread/compacted") {
    deps.emit("runtime:event", { runtimeId: runtime.id, type: "activity", text: "Codex 對話上下文已完成自動壓縮" });
    return;
  }
  if (!run) return;
  if (params.threadId && run.threadId && params.threadId !== run.threadId) return;
  const eventTurnId = params.turnId || params.turn?.id;
  if (eventTurnId && run.turnId && eventTurnId !== run.turnId) return;
  if(message.method==="thread/tokenUsage/updated"){
    if(!run.acceptUsage||!run.threadId||params.threadId!==run.threadId)return;
    const total=tokenCount(params.tokenUsage?.total);const key=runtime.id+":"+params.threadId;
    usageByThread.set(key,total);
    const modelContextWindow = Number(params.tokenUsage?.modelContextWindow) || 0;
    if (modelContextWindow > 0) runtime.threadContextWindows.set(params.threadId, modelContextWindow);
    const lastUsage = tokenCount(params.tokenUsage?.last);
    const activeContextTokens = ((lastUsage.inputTokens || 0) + (lastUsage.cachedInputTokens || 0)) || (total.inputTokens || 0);
    if (activeContextTokens > 0) runtime.threadContextTokens.set(params.threadId, activeContextTokens);
    const usage=run.usageComplete?tokenDelta(total,run.usageBaseline):{...lastUsage,totalTokens:null};
    emitForRun(runtime,deps,{type:"usage",turnId:params.turnId,usage:{...usage,source:run.usageComplete?"codex-thread-delta":"codex-last-request",complete:run.usageComplete===true}});return;
  }
  if (message.method === "turn/started") { run.turnId = params.turn?.id; run.acceptUsage=true;emitForRun(runtime, deps, { type: "activity", text: "Codex 正在思考" }); }
  else if (message.method === "item/agentMessage/delta") {
    const id = params.itemId || "assistant"; run.messages.set(id, (run.messages.get(id) || "") + (params.delta || ""));
    emitForRun(runtime, deps, { type: "message", text: [...run.messages.values()].join("\n\n") });
  } else if (message.method === "item/completed" && params.item?.type === "agentMessage") {
    run.messages.set(params.item.id, params.item.text || ""); emitForRun(runtime, deps, { type: "message", text: [...run.messages.values()].join("\n\n") });
  } else if (["item/started", "item/completed"].includes(message.method) && ["commandExecution", "fileChange", "mcpToolCall"].includes(params.item?.type)) {
    const item = params.item; const isEnd = message.method === "item/completed";
    const content = Array.isArray(item.result?.content) ? item.result.content : [];
    const screenshot = content.find((block: any) => block?.type === "image" && typeof block.data === "string" && block.data.length < 8 * 1024 * 1024 && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.mimeType));
    const resultText = content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("\n").slice(-16000);
    emitForRun(runtime, deps, { type: "tool", itemId: item.id, tool: item.tool || item.type, title: item.command || item.tool || (item.type === "fileChange" ? "修改 Mac 檔案" : "使用 Mac 工具"), text: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.slice(-16000) : resultText || undefined, ...(screenshot ? { image: `data:${screenshot.mimeType};base64,${screenshot.data}` } : {}), status: isEnd ? (item.status === "failed" || item.error || item.result?.isError ? "error" : "completed") : "running", executionLocation: "local", durationMs: item.durationMs });
  } else if (message.method === "item/started") {
    const names: Record<string, string> = { commandExecution: "正在執行命令", fileChange: "正在修改檔案", mcpToolCall: "正在使用工具", webSearch: "正在搜尋", reasoning: "正在思考" };
    if (names[params.item?.type]) emitForRun(runtime, deps, { type: "activity", text: names[params.item.type] });
  } else if (message.method === "error") {
    const err = params.error || params;
    if(params.willRetry===true){emitForRun(runtime,deps,{type:'activity',text:'原生 Runtime 正在重試連線，已保留收到的內容。'});return;}
    const failure=runtimeFailure(err);run.backgroundError=failure.text;
    emitForRun(runtime, deps, { type: "error", ...failure });
  }
  else if (message.method === "turn/completed") {
    const turn = params.turn || {};
    const rawError = turn.error || params.error;
    const failed=turn.status === "failed" || turn.status === "error";
    const failure=rawError||failed?runtimeFailure(rawError||turn.statusDetails?.message||turn.failureReason):undefined;
    const errorText=failure?.text;
    if (errorText) {
      run.backgroundError = errorText;
      emitForRun(runtime, deps, { type: "error", ...failure });
      if(failure?.category==='quota'||failure?.category==='rate-limit')void readRuntimeQuota(runtime).then(quota=>{if(!runtime.closed)deps.emit('runtime:event',{runtimeId:runtime.id,type:'quota',quota});});
    }
    for (const [id, pending] of runtime.requests) if (pending.requestId === run.requestId) { clearTimeout(pending.timer); pending.localResolve?.(false); runtime.requests.delete(id); emitForRun(runtime, deps, { type: "requestClosed", approvalId: id }); }
    runtime.toolHost?.cancelActive();
    const status: BackgroundTurnResult["status"] = run.cancelled || turn.status === "interrupted" ? "cancelled" : turn.status === "failed" || turn.status === "error" || run.backgroundError ? "error" : "completed";
    const result = { requestId: run.requestId, conversationId: run.threadId, text: [...run.messages.values()].filter(Boolean).join("\n\n"), status };
    emitForRun(runtime, deps, { type: "done", status, conversationId:run.threadId, text: run.backgroundError, error: run.backgroundError });
    const currentThreadId = run.threadId;
    runtime.run = undefined;
    run.completion?.resolve(result);
    if (status === "completed" && currentThreadId && !runtime.compactingThreads.has(currentThreadId)) {
      const compactPct = runtime.autoCompactPercent || 70;
      const windowTokens = runtime.threadContextWindows.get(currentThreadId) || 128000;
      const currentTokens = runtime.threadContextTokens.get(currentThreadId) || 0;
      if (windowTokens > 0 && currentTokens >= Math.round(windowTokens * (compactPct / 100))) {
        runtime.compactingThreads.add(currentThreadId);
        setImmediate(async () => {
          try {
            deps.emit("runtime:event", { runtimeId: runtime.id, type: "activity", text: `上下文用量達 ${Math.round((currentTokens / windowTokens) * 100)}%，正在自動壓縮對話` });
            await runtime.rpc.request("thread/compact/start", { threadId: currentThreadId });
            deps.emit("runtime:event", { runtimeId: runtime.id, type: "activity", text: "Codex 對話上下文已完成自動壓縮" });
          } catch {
          } finally {
            runtime.compactingThreads.delete(currentThreadId);
          }
        });
      }
    }
  }
}
function routeServerRequest(runtime: Runtime, deps: Dependencies, request: RpcRequest) {
  const p = request.params || {};
  if (request.method === "account/chatgptAuthTokens/refresh" || request.method === "attestation/generate") { runtime.rpc.reject(request.id, "Account credentials remain managed on the Runtime host."); return; }
  if (request.method === "currentTime/read") { runtime.rpc.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) }); return; }
  if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput"].includes(request.method)) {
    fs.writeFileSync(path.join(app.getPath("userData"),"runtime-request-diagnostic.json"),JSON.stringify({method:request.method,keys:Object.keys(p),serverName:p.serverName,mode:p.mode,schemaType:p.requestedSchema?.type,properties:Object.entries(p.requestedSchema?.properties||{}).map(([name,value]:any)=>({name,type:value.type,choiceNames:(value.enum||[]).filter((choice:unknown)=>["approve","decline","accept","reject","yes","no","approve_for_session"].includes(String(choice)))}))},null,2),{mode:0o600});
    runtime.rpc.reject(request.id, "This client has no verified local executor for the requested capability."); return;
  }
  if (!runtime.run || runtime.run.cancelled || (p.threadId && p.threadId !== runtime.run.threadId) || (p.turnId && runtime.run.turnId && p.turnId !== runtime.run.turnId)) {
    runtime.rpc.reject(request.id, "The request does not belong to an active client turn."); return;
  }
  if (runtime.run.backgroundTextOnly) {
    runtime.rpc.reject(request.id, "Cross-model discussion turns are text-only; tools and interactive prompts are disabled.", -32000); return;
  }
  if (request.method === "item/commandExecution/requestApproval" && p.environmentId !== runtime.executor?.environmentId) {
    runtime.rpc.reject(request.id, "Command approval is not bound to the Mac executor."); return;
  }
  if(runtime.permissionMode==='full'&&request.method!=='item/tool/requestUserInput'){
    if(!runtime.executor?.isRunning){runtime.rpc.reject(request.id,'Mac Executor 尚未就緒。');return;}
    runtime.rpc.respond(request.id,{decision:'accept'});return;
  }
  const approvalId = randomUUID(); runtime.requests.set(approvalId, { request, requestId: runtime.run.requestId });
  const isQuestion = request.method === "item/tool/requestUserInput";
  emitForRun(runtime, deps, { type: isQuestion ? "userInput" : "approval", approvalId,
    executionLocation: "local", title: isQuestion ? "Codex 需要你的回答" : request.method.includes("fileChange") ? "允許修改 Mac 檔案？" : "允許在 Mac 執行命令？",
    detail: isQuestion ? "" : [p.command, p.cwd ? `工作目錄：${p.cwd}` : "", p.reason].filter(Boolean).join("\n"),
    ...(isQuestion ? { questions: (Array.isArray(p.questions) ? p.questions : []).map((q: any) => ({ id: q.id, header: q.header, question: q.question, isOther: q.isOther, isSecret: q.isSecret, options: q.options || [] })) } : {}) });
}
export async function connectTrustedRuntimeSsh(input:any,connectConfig:(input:any)=>ConnectConfig):Promise<{conn?:Client;confirmation?:any;key?:string;fingerprint?:string}>{
  if(!input?.profile||typeof input.profile.host!=="string"||!input.profile.host.trim())throw new Error("請提供有效的朋友 Runtime 主機。");
  if(!["auto","windows","posix"].includes(input.platform))throw new Error("請選擇 Runtime 作業系統。");
  const conn=new Client(),config=connectConfig(input),key=`${String(input.profile.host).toLowerCase()}:${input.profile.port||22}`;
  conn.on("error",()=>{});
  const previous=readTrustedHosts()[key];let confirmation:any,observed="";
  config.hostVerifier=(raw:Buffer)=>{observed=hostFingerprint(raw);if(observed===previous||observed===input.trustedFingerprint)return true;confirmation={status:"host-confirmation",hostFingerprint:observed,previousFingerprint:previous,hostChanged:!!previous};return false;};
  try{await new Promise<void>((resolve,reject)=>{conn.once("ready",resolve);conn.once("error",reject);conn.connect(config);});}
  catch(error){try{conn.end();conn.destroy();}catch{}if(confirmation)return{confirmation};throw error;}
  trustHost(key,observed);return{conn,key,fingerprint:observed};
}
function diagnosticRuntime(id:string){const runtime=runtimes.get(id);if(!runtime||runtime.closed)throw new Error('Codex Runtime 尚未連線。');return runtime;}
export async function codexToolHealth(id:string){return diagnosticRuntime(id).toolHost?.toolHealth();}
export async function codexComputerDiagnostics(id?:string,prompt=false){
  const runtime=id?diagnosticRuntime(id):[...runtimes.values()].find(value=>!value.closed&&value.toolHost?.status().computer.startsWith('connected'));
  return runtime?.toolHost?runtime.toolHost.computerDiagnostics(prompt):undefined;
}
export async function runCodexBackgroundTurn(input: {
  runtimeId: string;
  prompt: string;
  conversationId?: string;
  model?: string;
  effort?: string;
  requestId?: string;
}): Promise<BackgroundTurnResult> {
  const runtime = runtimes.get(input.runtimeId);
  if (!runtime || runtime.closed) throw new Error("Codex Runtime 尚未連線。");
  if (!runtime.executor?.isRunning || !runtime.snapshot.executorEnvironment) throw new Error("Codex Mac Executor 尚未就緒。");
  if (runtime.snapshot.account.type !== "chatgpt" || !runtime.snapshot.account.authenticated) throw new Error("Codex Runtime 尚未登入 ChatGPT。");
  if (runtime.run) throw new Error("Codex 正在處理其他工作，無法開始自動討論。");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 120_000) throw new Error("自動討論提示內容無效。");

  const run: TurnRun = {
    requestId: input.requestId || randomUUID(),
    cancelled: false,
    messages: new Map(),
    backgroundTextOnly: true
  };
  const completion = new Promise<BackgroundTurnResult>((resolve, reject) => { run.completion = { resolve, reject }; });
  runtime.run = run;

  try {
    const configuration = await runtime.rpc.request("config/read", { includeLayers: false });
    const config = macThreadConfig(configuration.config, runtime.mcp);
    const developerInstructions = [
      macRuntimeInstructions(runtime.localCwd, runtime.manifestPath, runtime.toolHost?.status().tools || [], runtime.extensionCatalog),
      "You are participating in a cross-model discussion inside AgentBridge Studio.",
      "This turn is TEXT-ONLY. Do not call tools, run commands, read files, browse, or ask the user interactive questions.",
      "Respond directly to the discussion prompt with substantive reasoning. Keep the answer focused enough for another model to critique."
    ].join("\n\n");
    const thread = await runtime.rpc.request(input.conversationId ? "thread/resume" : "thread/start", {
      ...(input.conversationId ? { threadId: input.conversationId } : {}),
      developerInstructions,
      model: input.model || undefined,
      ...(!input.conversationId ? { environments: [{ environmentId: runtime.executor.environmentId, cwd: runtime.localCwd }] } : {}),
      config,
      approvalPolicy: "untrusted",
      sandbox: "read-only"
    });
    if (runtime.closed || runtime.run !== run) throw new Error("Codex 討論回合已中斷。");
    const threadId = thread?.thread?.id;
    if (typeof threadId !== "string" || !threadId) throw new Error("Codex Runtime 未回傳有效的討論 Thread ID。");
    run.threadId = threadId;
    await verifyThreadMcp(runtime, threadId);
    if (runtime.closed || runtime.run !== run) throw new Error("Codex 討論回合已中斷。");
    const result = await runtime.rpc.request("turn/start", {
      threadId: run.threadId,
      environments: [{ environmentId: runtime.executor.environmentId, cwd: runtime.localCwd }],
      input: [{ type: "text", text: input.prompt.trim() }],
      model: input.model || undefined,
      effort: input.effort || undefined
    });
    run.turnId = result.turn.id;
  } catch (error) {
    if (runtime.run === run) runtime.run = undefined;
    run.completion?.reject(error instanceof Error ? error : new Error(String(error)));
  }

  const result = await completion;
  if (result.status !== "completed") throw new Error(run.backgroundError || (result.status === "cancelled" ? "Codex 討論回合已取消。" : "Codex 討論回合失敗。"));
  if (!result.text.trim()) throw new Error("Codex 討論回合沒有回傳文字。");
  return result;
}

export async function cancelCodexBackgroundTurn(runtimeId: string) {
  const runtime = runtimes.get(runtimeId);
  const run = runtime?.run;
  if (!runtime || !run?.backgroundTextOnly) return { cancelled: false };
  run.cancelled = true;
  runtime.toolHost?.cancelActive();
  if (run.threadId && run.turnId) {
    try { await runtime.rpc.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId }); } catch {}
  }
  // The background turn's promise only resolves on turn/completed. A runtime that
  // never reports it would keep the orchestrator awaiting forever.
  const pending = run.completion;
  if (pending && runtime.run === run) {
    runtime.run = undefined;
    queueMicrotask(() => pending.resolve({ requestId: run.requestId, conversationId: run.threadId, text: [...run.messages.values()].filter(Boolean).join("\n\n"), status: "cancelled" }));
  }
  return { cancelled: true };
}

export function registerRuntimeBackend(deps: Dependencies) {
  const getRuntime = (id: string) => { const runtime = runtimes.get(id); if (!runtime || runtime.closed) throw new Error("請先連線至 Codex Runtime。"); return runtime; };
  ipcMain.handle("runtime:chooseLocalDirectory", async () => {
    const options = { title: "選擇這台 Mac 的工作資料夾", properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
    const window = deps.window(); const chosen = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return chosen.canceled ? null : chosen.filePaths[0] || null;
  });
  const connectRuntime = async (_event:any, input: ConnectInput):Promise<any> => {
    if (!["auto", "windows", "posix"].includes(input.platform)) throw new Error("請選擇 Runtime 作業系統。");
    const connected=await connectNetwork(input,()=>connectTrustedRuntimeSsh(input,deps.connectConfig),()=>{if(!deps.connectRelay)throw new Error('Relay 尚未就緒。');return deps.connectRelay(input);});
    if(connected.confirmation)return connected.confirmation;
    const conn:Client=connected.conn, key=connected.key, observed=connected.fingerprint;
    const executable = input.executable?.trim() || "codex";
    let host: LocalCodeModeHost | undefined; let executor: LocalExecServer | undefined; let executorUrl: string | undefined; let toolHost: LocalToolHost | undefined; let toolForward: LoopbackForward | undefined; let mcp: Runtime["mcp"]; let initializationFailure = ""; let rpc: AppServerRpc | undefined;
    try {
      const platform = connected.transport==='https-relay'?((conn as any).platform==='win32'?'windows':'posix'):await resolveRemotePlatform(conn, input.platform);
      const preflight = async (args:string[]) => {
        try { return await captureRemote(conn, appServerCommand(platform, executable, args)); }
        catch(error) { throw remoteLaunchError(platform, error instanceof Error ? error.message : String(error)); }
      };
      const version = parseCodexVersion(await preflight(["--version"]));
      if (!version) throw new Error("無法識別遠端 Codex CLI 版本。");
      const help = await preflight(["app-server", "--help"]);
      const flag = chooseStdioFlag(help); let hostUrl: string | undefined; let hostWarning = "";
      const localCwd = await fs.promises.realpath(input.localCwd || os.homedir());
      if (!(await fs.promises.stat(localCwd)).isDirectory()) throw new Error("Mac 工作目錄必須是資料夾。");
      let runtime: Runtime | undefined;
      const id = randomUUID();
      const manifestRoot = path.join(app.getPath("userData"), "runtime-extensions");
      await fs.promises.mkdir(manifestRoot, { recursive: true, mode: 0o700 });
      const extensionRoots: string[] = [];
      for (const root of deps.readOnlyExtensionRoots || []) { if (!path.isAbsolute(root)) continue; try { if ((await fs.promises.stat(root)).isDirectory()) extensionRoots.push(await fs.promises.realpath(root)); } catch {} }
      if (!isVerifiedExecutorVersion(version)) {
        hostWarning = `Runtime ${version} 尚未完成 Mac 工具路由驗證；目前支援 ${VERIFIED_EXECUTOR_VERSIONS.join("、")}。`;
      } else if (help.includes("--code-mode-host")) {
        try {
          const installation = await findHostInstallation(version, process.resourcesPath, input.localHostExecutable);
          // Never substitute a JS-only Code Mode host when the matching executor is unavailable.
          executor = new LocalExecServer(installation, reason => { if (runtime) closeRuntime(runtime, deps, reason); });
          await executor.start(localCwd); executorUrl = await executor.reverseForward(conn);
        } catch (error) { host?.stop(); executor?.stop(); executor = undefined; executorUrl = undefined; host = undefined; hostWarning = error instanceof Error ? error.message : String(error); }
      }
      if (executorUrl) {
        try {
          if (deps.libraryRoot) await fs.promises.mkdir(deps.libraryRoot, { recursive: true });
          const extensionServers = deps.extensionServers ? await deps.extensionServers(localCwd) : [];
          toolHost = new LocalToolHost({ stateDirectory:deps.stateDirectory, extensionServers, allowedRoots: [localCwd], readOnlyRoots: [...(deps.libraryRoot ? [deps.libraryRoot] : []), manifestRoot, ...extensionRoots], agentRole: "codex", ...(typeof deps.localTools==="function"?deps.localTools():deps.localTools),
            fullFilesystemAccess: input.permissionMode === "full", authorize: call => authorizeMacTool(runtime, deps, call) });
          const local = await toolHost.start();
          // The registered Mac executor forwards HTTP through the existing SSH channel.
          mcp = { name: `agentbridge_mac_${randomUUID().replaceAll("-", "")}`, url: local.url, token: local.token, environmentId: executor!.environmentId };
        } catch (error) { await toolHost?.stop(); toolHost = undefined; toolForward?.stop(); toolForward = undefined; mcp = undefined; hostWarning = "Mac 擴充工具尚未連線；仍可使用命令與檔案工具。"; }
      }
      const args = ["app-server", ...(flag === "--stdio" ? ["--stdio"] : ["--listen", "stdio://"]), ...(hostUrl ? ["--code-mode-host", hostUrl] : []), ...isolatedRuntimeArgs()];
      const channel = await execChannel(conn, appServerCommand(platform, executable, args, Boolean(executorUrl)));
      rpc = new AppServerRpc(channel); channel.stderr.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("AgentBridge requires no Runtime environments.toml override")) initializationFailure = "Runtime 主機已有 environments.toml，會覆蓋 Mac 專用執行設定。請先在 Runtime 主機停用該環境設定後重新連線；App 沒有讀取或修改它。";
      });
      const activeRpc = rpc;
      rpc.on("request", (request: RpcRequest) => {
        if (runtime) routeServerRequest(runtime, deps, request);
        else if (request.method === "currentTime/read") activeRpc.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
        else activeRpc.reject(request.id, "The client is still initializing; credentials remain managed by the Runtime host.");
      });
      // Managed ChatGPT authentication stays in this remote process. No login RPC or auth file is read.
      const initialized = await rpc.request("initialize", { clientInfo: { name: "agentbridge_studio", title: "AgentBridge Studio", version: app.getVersion() }, capabilities: { experimentalApi: true, requestAttestation: false } });
      rpc.notify("initialized");
      let executorEnvironment: ExecutorRegistration | undefined;
      if (executor && executorUrl) {
        try { executorEnvironment = await executor.register(rpc, executorUrl); }
        catch (error) { executor.stop(); executor = undefined; hostWarning = error instanceof Error ? error.message : String(error); }
      }
      const [account, modelResponse] = await Promise.all([rpc.request("account/read", { refreshToken: false }), listModels(rpc)]);
      if (rpc.isClosed) throw new Error("Runtime 在初始化期間已中斷連線。");
      if (executorEnvironment && !executor?.isRunning) throw new Error("Mac Executor 在初始化期間已結束。");
      if (hostUrl && !host?.isRunning) throw new Error("Mac Code Mode Host 在初始化期間已結束。");
      runtime = { id, conn, rpc, host, executor, executorUrl, toolHost, toolForward, mcp, quotaEpoch:0,quotaRevision:0,quotaRequest:0, manifestPath: path.join(manifestRoot, `${id}.json`), extensionCatalog: { items: [], warnings: [] }, permissionMode: ["ask", "full"].includes(input.permissionMode || "") ? input.permissionMode! : "project", requests: new Map(), closed: false, localCwd,
        autoCompactPercent: input.autoCompactPercent || 70, threadContextWindows: new Map(), threadContextTokens: new Map(), compactingThreads: new Set(), snapshot: {
        runtimeId: id, status: "connected", toolExecution: executorEnvironment ? "local-executor" : "unavailable", account: accountSummary(account), models: modelResponse,
        capabilities: { ...localToolCapability(Boolean(hostUrl), Boolean(executorEnvironment), Boolean(mcp)), ...(!executorEnvironment && hostWarning ? { reason: hostWarning } : {}) }, runtimeVersion: version, codeModeHostConnected: Boolean(hostUrl), localHostVersion: host?.installation.version,
        macTools: toolHost?.status(), permissionMode: input.permissionMode || "project", executorConnected: Boolean(executorEnvironment), executorVersion: executor?.installation.version, executorEnvironment,
        runtimePlatform: initialized.platformOs || platform, connectionPlatform: platform, hostName: input.profile.name || input.profile.host, hostKey: key,
        profileId:input.profile.id,relayUrl:input.profile.relayUrl,transport:connected.transport,networkDiagnostics:connected.diagnostics,hostFingerprint: observed, ...(hostWarning ? { diagnostic: hostWarning } : {})
      } };
      const current = runtime;
      runtimes.set(id, current);
      rpc.on("notification", message => routeNotification(current, deps, message));
      rpc.on("closed", error => closeRuntime(current, deps, error.message));
      conn.on('error',(error:Error)=>closeRuntime(current,deps,/ERR_AUTH/.test(error.message)?'ERR_AUTH：Relay 授權已失效，請重新配對。':'網路連線發生錯誤，Runtime 已關閉。'));
      conn.on("close", () => closeRuntime(current, deps, "網路已中斷，Runtime 與 Mac 工具通道已關閉；未重送指令。"));
      return current.snapshot;
    } catch (error) { rpc?.close(); host?.stop(); executor?.stop(); toolForward?.stop(); await toolHost?.stop(); conn.end(); if(input.profile.networkMode!=='direct'&&input.profile.networkMode!=='relay'&&connected.transport==='tailscale-ssh'&&input.profile.relayUrl&&/timeout|timed out|中斷|結束|handshake/i.test(String(initializationFailure||error)))return connectRuntime(_event,{...input,profile:{...input.profile,networkMode:'relay'}}); if (initializationFailure) throw new Error(initializationFailure); throw error; }
  };
  ipcMain.handle("runtime:connect",connectRuntime);
  ipcMain.handle("runtime:disconnect", (_event, id: string) => { const runtime = runtimes.get(id); if (runtime) closeRuntime(runtime, deps); });
  ipcMain.handle('runtime:permission',(_event,id:string,value:unknown)=>{
    const runtime=getRuntime(id),mode=permissionMode(value);
    if(runtime.run&&runtime.permissionMode==='full'&&mode!=='full')throw new Error('請先停止目前工作，再降低操作權限。');
    runtime.permissionMode=mode;runtime.toolHost?.setFullFilesystemAccess(mode==='full');runtime.snapshot.permissionMode=runtime.permissionMode;runtime.snapshot.macTools=runtime.toolHost?.status();
    if(runtime.permissionMode==='full')for(const [key,pending]of runtime.requests){
      if(pending.request.method==='item/tool/requestUserInput')continue;
      if(pending.localResolve){clearTimeout(pending.timer);pending.localResolve(Boolean(runtime.run&&!runtime.run.cancelled&&!runtime.run.backgroundTextOnly));}
      else if(runtime.executor?.isRunning&&runtime.run&&!runtime.run.cancelled&&!runtime.run.backgroundTextOnly&&(pending.request.method!=='item/commandExecution/requestApproval'||pending.request.params?.environmentId===runtime.executor.environmentId))runtime.rpc.respond(pending.request.id,{decision:'accept'});
      else runtime.rpc.reject(pending.request.id,'此操作不屬於可用的 Mac 執行環境。');
      runtime.requests.delete(key);emitForRun(runtime,deps,{type:'requestClosed',approvalId:key});
    }
    return runtime.snapshot;
  });
  ipcMain.handle('runtime:recoverTools',async(_event,id:string)=>{
    const runtime=getRuntime(id);if(runtime.run)throw new Error('請先停止目前工作，再重新連接電腦與瀏覽器工具。');
    await runtime.toolHost?.recoverProxyTools();runtime.snapshot.macTools=runtime.toolHost?.status();return runtime.snapshot;
  });
  ipcMain.handle("runtime:status", async (_event, id: string) => {
    const runtime = getRuntime(id);
    const [account, models] = await Promise.all([runtime.rpc.request("account/read", { refreshToken: false }), listModels(runtime.rpc)]);
    runtime.snapshot.account = accountSummary(account); runtime.snapshot.models = models; runtime.snapshot.macTools = runtime.toolHost?.status(); return runtime.snapshot;
  });
  ipcMain.handle("runtime:extensions", async (_event, id: string) => refreshMacExtensions(getRuntime(id), deps));
  ipcMain.handle("runtime:usage", async (_event,id:string)=>{
    return readRuntimeQuota(getRuntime(id));
  });
  ipcMain.handle("runtime:models", async (_event, id: string) => {
    const runtime = getRuntime(id); runtime.snapshot.models = await listModels(runtime.rpc); return runtime.snapshot.models;
  });
  ipcMain.handle("runtime:send", async (_event, input: any) => {
    const runtime = getRuntime(input.runtimeId);
    if (!runtime.snapshot.capabilities.localTools) throw new Error(runtime.snapshot.capabilities.reason);
    if (!runtime.executor?.isRunning || !runtime.snapshot.executorEnvironment) throw new Error("Mac Executor 尚未就緒；禁止回退到 Runtime 主機執行工具。");
    if (runtime.snapshot.account.type !== "chatgpt" || !runtime.snapshot.account.authenticated) throw new Error("請由 Runtime 擁有者在自己的電腦登入 ChatGPT 帳號。");
    if (runtime.run) throw new Error("這個 Runtime 仍在處理上一則訊息。");
    if (typeof input.prompt !== "string" || (!input.prompt.trim() && !input.attachments?.length)) throw new Error("請輸入訊息或加入附件。");
    const attachmentIds = input.attachments || [];
    if (!Array.isArray(attachmentIds) || attachmentIds.some((id: unknown) => typeof id !== "string") || attachmentIds.length > 20) throw new Error("附件識別碼無效。");
    if (attachmentIds.length && !deps.libraryEntries) throw new Error("檔案庫尚未就緒。");
    const attachments = attachmentIds.length ? await deps.libraryEntries!(attachmentIds) : [];
    const turnInput = await runtimeInput(input.prompt.trim() || "請查看並處理附加的檔案。", attachments);
    const localCwd = await fs.promises.realpath(input.localCwd || runtime.localCwd);
    if (!(await fs.promises.stat(localCwd)).isDirectory()) throw new Error("Mac 工作目錄必須是資料夾。");
    if (localCwd !== runtime.localCwd) throw new Error("變更 Mac 工作目錄後請重新連線，以同步檔案工具權限。");
    // A second send may have entered while filesystem validation was pending.
    if (runtime.closed || runtime.run) throw new Error("Runtime 已中斷或仍在處理上一則訊息。");
    if (typeof input.autoCompactPercent === "number") runtime.autoCompactPercent = input.autoCompactPercent;
    const run: TurnRun = { requestId: input.requestId || randomUUID(), cancelled: false, messages: new Map() }; runtime.run = run;
    setImmediate(async () => {
      try {
        await refreshMacExtensions(runtime, deps);
        if (runtime.closed || runtime.run !== run) return;
        if (run.cancelled) { emitForRun(runtime, deps, { type: "done", status: "cancelled" }); runtime.run = undefined; return; }
        if(input.conversationId&&input.executorEnvironmentId&&runtime.executor&&runtime.executorUrl&&input.executorEnvironmentId!==runtime.executor.environmentId){
          const environment=await runtime.executor.register(runtime.rpc,runtime.executorUrl,input.executorEnvironmentId);
          runtime.snapshot.executorEnvironment=environment;
          if(runtime.mcp)runtime.mcp.environmentId=environment.environmentId;
          emitForRun(runtime,deps,{type:"status",snapshot:runtime.snapshot});
        }
        const configuration = await runtime.rpc.request("config/read", { includeLayers: false });
        if (runtime.closed || runtime.run !== run) return;
        if (run.cancelled) { emitForRun(runtime, deps, { type: "done", status: "cancelled" }); runtime.run = undefined; return; }
        const config = macThreadConfig(configuration.config, runtime.mcp, runtime.autoCompactPercent);
        const thread = await runtime.rpc.request(input.conversationId ? "thread/resume" : "thread/start", {
          ...(input.conversationId ? { threadId: input.conversationId } : {}), developerInstructions: macRuntimeInstructions(localCwd, runtime.manifestPath, runtime.toolHost?.status().tools || [], runtime.extensionCatalog), model: input.model || undefined,
          ...(runtime.executor ? (!input.conversationId ? { environments: [{ environmentId: runtime.executor.environmentId, cwd: localCwd }] } : {}) : { cwd: localCwd }), config, ...codexPermissionPolicy(runtime.permissionMode)
        });
        if (runtime.closed || runtime.run !== run) return;
        run.threadId = thread.thread.id;
        run.usageBaseline=usageByThread.get(runtime.id+":"+run.threadId);
        run.usageComplete=!!run.usageBaseline||!input.conversationId;
        if(!run.usageBaseline&&!input.conversationId)run.usageBaseline={totalTokens:0,inputTokens:0,cachedInputTokens:0,outputTokens:0};
        try { await verifyThreadMcp(runtime, run.threadId!,config); }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          emitForRun(runtime, deps, { type: "error", text: reason }); closeRuntime(runtime, deps, reason); return;
        }
        if (runtime.closed || runtime.run !== run) return;
        emitForRun(runtime, deps, { type: "session", conversationId: run.threadId, executorEnvironmentId:runtime.executor?.environmentId });
        if (run.cancelled) { emitForRun(runtime, deps, { type: "done", status: "cancelled" }); runtime.run = undefined; return; }
        run.turnStarting=true;
        const result = await runtime.rpc.request("turn/start", { threadId: run.threadId, environments: [{ environmentId: runtime.executor!.environmentId, cwd: localCwd }], input: turnInput, model: input.model || undefined, effort: input.effort || undefined });
        if (runtime.closed || runtime.run !== run) return;
        run.turnId = result.turn.id;run.acceptUsage=true;
        if (run.cancelled) await runtime.rpc.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
      } catch (error) {
        if (runtime.closed || runtime.run !== run) return;
        const failure=runtimeFailure(error);
        // Recovery is offered only when resume failed before any model turn began.
        if(input.conversationId&&!run.threadId&&failure.category==='session-missing')emitForRun(runtime,deps,{type:'sessionUnavailable',conversationId:input.conversationId});
        emitForRun(runtime, deps, { type: "error", ...failure }); emitForRun(runtime, deps, { type: "done", status: "error",text:failure.text }); runtime.run = undefined;
      }
    });
    return { requestId: run.requestId };
  });
  ipcMain.handle("runtime:cancel", async (_event, id: string, requestId: string) => {
    const runtime = getRuntime(id); const run = runtime.run;
    if (!run || run.requestId !== requestId) return { cancelled: false }; run.cancelled = true; runtime.toolHost?.cancelActive();
    for (const [id, pending] of runtime.requests) if (pending.requestId === run.requestId) {
      clearTimeout(pending.timer);
      if (pending.localResolve) pending.localResolve(false); else runtime.rpc.reject(pending.request.id, "The client cancelled this turn.", -32000);
      runtime.requests.delete(id); emitForRun(runtime, deps, { type: "requestClosed", approvalId: id });
    }
    if (run.threadId && run.turnId) await runtime.rpc.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
    else if(!run.turnStarting){
      emitForRun(runtime,deps,{type:"done",status:"cancelled",conversationId:run.threadId});
      if(runtime.run===run)runtime.run=undefined;
      run.completion?.resolve({requestId:run.requestId,conversationId:run.threadId,text:[...run.messages.values()].join("\n\n"),status:"cancelled"});
    }
    // A turn in flight is normally released by the turn/completed notification.
    // Guard against a runtime that never reports it, or the composer stays locked.
    if ((run.turnId || run.turnStarting) && runtime.run === run) {
      setTimeout(() => {
        if (runtime.run !== run || !run.cancelled) return;
        emitForRun(runtime, deps, { type: "done", status: "cancelled", conversationId: run.threadId });
        runtime.run = undefined;
        run.completion?.resolve({ requestId: run.requestId, conversationId: run.threadId, text: [...run.messages.values()].join("\n\n"), status: "cancelled" });
      }, 5000).unref();
    }
    return { cancelled: true };
  });
  ipcMain.handle("runtime:respond", (_event, input: any) => {
    const runtime = getRuntime(input.runtimeId); const pending = runtime.requests.get(input.approvalId);
    if (!pending) throw new Error("這個要求已結束或不屬於目前連線。");
    if (!["accept", "decline"].includes(input.decision)) throw new Error("無效的回應。");
    const request = pending.request;
    if (pending.localResolve) {
      clearTimeout(pending.timer); pending.localResolve(input.decision === "accept" && Boolean(runtime.run && !runtime.run.cancelled));
      runtime.requests.delete(input.approvalId); emitForRun(runtime, deps, { type: "requestClosed", approvalId: input.approvalId }); return { resolved: true };
    }
    if (request.method === "item/tool/requestUserInput") {
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of request.params.questions || []) {
        const values = input.decision === "accept" ? input.answers?.[question.id] : [];
        if (!Array.isArray(values) || values.some((v: unknown) => typeof v !== "string")) throw new Error("請回答每一個問題。");
        answers[question.id] = { answers: values };
      }
      runtime.rpc.respond(request.id, { answers });
    } else {
      if (!runtime.executor?.isRunning || !runtime.run || runtime.run.cancelled) throw new Error("Mac 執行器或對話已停止。");
      if (request.method === "item/commandExecution/requestApproval" && request.params?.environmentId !== runtime.executor.environmentId) throw new Error("此要求不屬於 Mac 執行環境。");
      runtime.rpc.respond(request.id, { decision: input.decision });
    }
    runtime.requests.delete(input.approvalId); emitForRun(runtime, deps, { type: "requestClosed", approvalId: input.approvalId });
    return { resolved: true };
  });
}
