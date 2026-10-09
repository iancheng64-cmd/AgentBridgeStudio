import {connectNetwork} from './connection-network';
import {permissionMode} from "./permission-policy";
import { ipcMain, shell, type BrowserWindow } from "electron";
import path from "node:path";
import {connectTrustedRuntimeSsh} from "./runtime-backend";
import {resolveRemotePlatform} from './remote-shell';
import {launchRemoteClaude} from "./claude-remote-launch";
import {LoopbackForward} from "./loopback-forward";
import type {Client,ConnectConfig} from "ssh2";
import type {MacExtensionServer} from './mac-extension-servers';
import { findClaudeExecutable } from "./claude-local-runtime";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ClaudeLocalRuntime, type ClaudePermission, type ClaudePermissionMode } from "./claude-local-runtime";
import { LocalToolHost, type LocalToolCall, type LocalToolCommand } from "./local-tool-host";
import { runtimeInput, type RuntimeAttachment } from "./runtime-attachments";

export interface ClaudeLocalDependencies {
  extensionServers?(cwd:string):Promise<MacExtensionServer[]>;
  connectConfig?(input:any):ConnectConfig;
  connectRelay?(input:any):Promise<Client>;
  emit(channel: string, payload: unknown): void;
  window(): BrowserWindow | null;
  libraryEntries?(ids: string[]): Promise<RuntimeAttachment[]>;
  libraryRoot?: string; stateDirectory?:string;
  localTools?: { nativeCommand?: LocalToolCommand; browserCommand?: LocalToolCommand } | (()=>{nativeCommand?:LocalToolCommand;browserCommand?:LocalToolCommand});
  claudeManifest?: () => unknown;
}
interface Pending { isQuestion:boolean; resolve(answer: { allow: boolean; updatedInput?: Record<string, unknown> }): void; input: Record<string, unknown>; questions?: any[]; dispose(): void }
interface Runtime { sendPending?:boolean;network?:any; conn?:Client;forward?:LoopbackForward;hostName?:string;hostKey?:string;cli: ClaudeLocalRuntime; host?: LocalToolHost; pending: Map<string, Pending>; permissionMode: ClaudePermissionMode; cwd: string; closed: boolean; backgroundTextOnly?: boolean; deps: ClaudeLocalDependencies }
const runtimes = new Map<string, Runtime>();
function get(id: string) { const runtime = runtimes.get(id); if (!runtime || runtime.closed) throw new Error("Claude 本機連線已中斷，請重新連線。"); return runtime; }
function emit(runtime: Runtime, event: any) { runtime.deps.emit("claude:event", { runtimeId: runtime.cli.id, ...(runtime.cli.activeRequestId ? { requestId: runtime.cli.activeRequestId } : {}), ...event }); }
function snapshot(runtime: Runtime) { const native=runtime.cli.status();return { ...native,...runtime.network,capabilities:{...native.capabilities,localTools:native.capabilities.localTools&&!!runtime.host?.status().ok},...(runtime.hostName?{hostName:runtime.hostName,hostKey:runtime.hostKey}:{}),macTools: runtime.host?.status(), localToolNames: runtime.host?.listTools().map(t => t.name) || [], toolHostConnected: !!runtime.host?.status().ok }; }
function clearPending(runtime: Runtime) { for (const [id, pending] of runtime.pending) { pending.dispose(); pending.resolve({ allow: false }); emit(runtime, { type: "requestClosed", approvalId: id }); } runtime.pending.clear(); }
function ask(runtime: Runtime, input: Record<string, unknown>, name: string, signal?: AbortSignal): Promise<{ allow: boolean; updatedInput?: Record<string, unknown> }> {
  if (runtime.closed || !runtime.cli.busy || signal?.aborted || runtime.backgroundTextOnly) return Promise.resolve({ allow: false });
  const isQuestion = name === "AskUserQuestion";
  if (!isQuestion && runtime.permissionMode === "full") return Promise.resolve({ allow: true });
  const approvalId = randomUUID();
  return new Promise(resolve => {
    const finish = (answer: { allow: boolean; updatedInput?: Record<string, unknown> }) => { const entry = runtime.pending.get(approvalId); if (!entry) return; runtime.pending.delete(approvalId); entry.dispose(); emit(runtime, { type: "requestClosed", approvalId }); resolve(answer); };
    const cancel = () => finish({ allow: false });
    const timer = setTimeout(cancel, 120_000);
    const questions = isQuestion && Array.isArray(input.questions) ? input.questions : undefined;
    runtime.pending.set(approvalId, { isQuestion, resolve: finish, input, questions, dispose: () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); } });
    signal?.addEventListener("abort", cancel, { once: true });
    emit(runtime, { type: isQuestion ? "userInput" : "approval", approvalId, executionLocation: "local", title: isQuestion ? "Claude 需要你的回答" : `允許 Claude 在這台 Mac 使用 ${name}？`,
      detail: JSON.stringify(input, null, 2).slice(0, 8000), ...(questions ? { questions: questions.map((q: any, index: number) => ({ id: String(index), question: q.question, header: q.header, options: q.options })) } : {}) });
  });
}
async function close(runtime: Runtime, reason = "Claude 本機連線已關閉。") {
  if (runtime.closed) return; runtime.closed = true; runtimes.delete(runtime.cli.id); clearPending(runtime);
  await runtime.cli.stop();runtime.forward?.stop();runtime.conn?.end();await runtime.host?.stop(); emit(runtime, { type: "closed", text: reason });
}
export async function stopAllClaudeLocalRuntimes() { await Promise.all([...runtimes.values()].map(runtime => close(runtime))); }

export async function runClaudeBackgroundTurn(input: {
  runtimeId: string;
  prompt: string;
  conversationId?: string;
  model?: string;
  effort?: string;
  requestId?: string;
}) {
  const runtime = get(input.runtimeId);
  const status = runtime.cli.status();
  if (!status.account?.authenticated) throw new Error("Claude Code 尚未登入。");
  if (runtime.cli.busy) throw new Error("Claude 正在處理其他工作，無法開始自動討論。");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 120_000) throw new Error("自動討論提示內容無效。");
  runtime.backgroundTextOnly = true;
  try {
    return await runtime.cli.sendAndWait({
      requestId: input.requestId,
      prompt: input.prompt.trim(),
      conversationId: input.conversationId,
      model: input.model,
      effort: input.effort
    });
  } finally {
    runtime.backgroundTextOnly = false;
    clearPending(runtime);
    runtime.host?.cancelActive();
  }
}

export async function cancelClaudeBackgroundTurn(runtimeId: string) {
  const runtime = runtimes.get(runtimeId);
  if (!runtime || runtime.closed || !runtime.backgroundTextOnly) return { cancelled: false };
  return runtime.cli.cancel(runtime.cli.activeRequestId);
}

export async function claudeComputerDiagnostics(id:string){return get(id).host?.computerDiagnostics();}
export async function claudeToolHealth(id:string){return get(id).host?.toolHealth();}

export function registerClaudeLocalBackend(deps: ClaudeLocalDependencies) {
  ipcMain.handle("claude:login",async(_event,input:any={})=>{
    const executable=await findClaudeExecutable(input.executable);
    const quote=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'";
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'agentbridge-claude-login-'));await fs.chmod(directory,0o700);
    const file=path.join(directory,'Claude 官方登入.command');
    const keys=Object.keys(process.env).filter(key=>/^ANTHROPIC_[A-Z0-9_]+$|^CLAUDE_CODE_(?:OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)$/.test(key));
    const script='#!/bin/zsh\n'+'unset '+[...new Set([...keys,'ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN'])].join(' ')+'\n'+quote(executable)+" --setting-sources '' auth login --claudeai\n"+"result=$?\nrm -f -- "+quote(file)+"\nrmdir -- "+quote(directory)+" 2>/dev/null\nexit $result\n";
    await fs.writeFile(file,script,{mode:0o700});const error=await shell.openPath(file);if(error){await fs.rm(directory,{recursive:true,force:true});throw new Error('無法開啟原生登入視窗。請在終端機執行 claude auth login --claudeai。');}
    return{opened:true};
  });
  const connectClaude = async (_event:any, input: any = {}):Promise<any> => {
    // A friend-host profile is mandatory for the remote path. Never fall back to the Mac CLI.
    const remote=input.location!=="local";
    let conn:Client|undefined;let forward:LoopbackForward|undefined;let network:any;
    if(remote){if(!deps.connectConfig)throw new Error("朋友 Runtime SSH 尚未就緒。");const connected=await connectNetwork(input,()=>connectTrustedRuntimeSsh(input,deps.connectConfig!),()=>{if(!deps.connectRelay)throw new Error('Relay 尚未就緒。');return deps.connectRelay(input);});network={requiresReconnectKey:!!input.api?.apiKey,profileId:input.profile.id,relayUrl:input.profile.relayUrl,transport:connected.transport,networkDiagnostics:connected.diagnostics};if(connected.confirmation)return connected.confirmation;conn=connected.conn;try{input={...input,platform:connected.transport==='https-relay'?((conn as any).platform==='win32'?'windows':'posix'):await resolveRemotePlatform(conn!,input.platform)};}catch(error){conn?.end();throw error;}}
    let cwd:string;try{cwd=await fs.realpath(input.localCwd||input.cwd||os.homedir());if(!(await fs.stat(cwd)).isDirectory())throw new Error("directory required");}catch{conn?.end();throw new Error("請選擇有效的 Mac 工作資料夾。");}
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error("請選擇 Mac 工作資料夾。");
    const permissionMode: ClaudePermissionMode = ["ask", "project", "full"].includes(input.permissionMode) ? input.permissionMode : "ask";
    let runtime: Runtime | undefined; let host: LocalToolHost | undefined; let endpoint: any;
    try {
      if (deps.libraryRoot) await fs.mkdir(deps.libraryRoot, { recursive: true });
      host = new LocalToolHost({ stateDirectory:deps.stateDirectory, allowedRoots: [cwd],extensionServers:await deps.extensionServers?.(cwd),enableShell:remote,readOnlyRoots: deps.libraryRoot ? [deps.libraryRoot] : [], agentRole: "claude", ...(typeof deps.localTools==="function"?deps.localTools():deps.localTools),
        fullFilesystemAccess:permissionMode === "full",
        authorize: async (call: LocalToolCall) => {
          if (!runtime || runtime.closed || !runtime.cli.busy || runtime.backgroundTextOnly) return false;
          if (call.category === "agent-bridge" || runtime.permissionMode === "full" || (runtime.permissionMode === "project" && call.category === "filesystem-read")) return true;
          return (await ask(runtime, call.arguments, call.name)).allow;
        } });
      endpoint = await host.start();
    } catch(error) { await host?.stop();conn?.end();throw new Error("Mac 工具通道啟動失敗；不會改在朋友電腦執行工作。"); }
    if(conn){try{forward=new LoopbackForward(conn,endpoint.port);const port=await forward.start();endpoint={...endpoint,url:`http://127.0.0.1:${port}/mcp`};}catch(error){await host?.stop();conn.end();throw error;}}
    const cli = new ClaudeLocalRuntime({ cwd, executable: input.executable, authMode:input.authMode==="official"?"official":"api",api:input.api,permissionMode, model: input.model, effort: input.effort, autoCompactPercent:Number.isFinite(Number(input.autoCompactPercent))?Number(input.autoCompactPercent):70,
      additionalDirectories: !remote&&deps.libraryRoot ? [deps.libraryRoot] : [],
      ...(conn?{remote:{launch:(args:string[],options:any)=>launchRemoteClaude(conn!,{platform:input.platform,nodeExecutable:input.nodeExecutable,executable:input.executable,remoteCwd:input.remoteCwd,configDir:input.configDir,args,...options})}}:{}),
      ...(endpoint && host ? { mcp: { url: endpoint.url, token: endpoint.token, name: "agentbridge_mac" } } : {}),
      onPermission: (request: ClaudePermission) => {
        // Mac MCP requests receive a single approval at the host, including calls the CLI auto-approves.
        if(request.toolName.startsWith("mcp__agentbridge_mac__"))return Promise.resolve({allow:!!runtime&&!runtime.closed&&runtime.cli.busy&&!request.signal.aborted});
        return runtime ? ask(runtime, request.input, request.toolName, request.signal) : Promise.resolve({allow:false});
      },
      onEvent: event => {
        if (runtime && event.type === "done") { clearPending(runtime); runtime.host?.cancelActive(); }
        if (!runtime?.backgroundTextOnly || event.type === "closed") deps.emit("claude:event", event);
        if (runtime && event.type === "closed" && !runtime.closed) void close(runtime, event.text);
      }
    });
    runtime = { cli, host,conn,forward,network,hostName:remote?(input.profile.name||input.profile.host):undefined,hostKey:remote?`${input.profile.username}@${input.profile.host}:${input.profile.port||22}|claude|${input.authMode}|${input.remoteCwd||''}`+(input.configDir?'|config:'+input.configDir:''):undefined,pending: new Map(), permissionMode, cwd, closed: false, deps };
    conn?.on('error',(error:Error)=>{if(runtime&&!runtime.closed)void close(runtime,/ERR_AUTH/.test(error.message)?'ERR_AUTH：Relay 授權已失效，請重新配對。':'網路連線已中斷。');});
    conn?.on("close",()=>{if(runtime&&!runtime.closed)void close(runtime,"朋友的 Claude 網路連線已中斷；未重送指令。");});
    try { await cli.start();const catalog=await cli.extensions();if(remote&&catalog.mcp.some((server:any)=>server.name!=="agentbridge_mac"))throw new Error("Claude 載入了非 Mac 工具，已停止這次連線。");runtimes.set(cli.id, runtime); return snapshot(runtime); }
    catch (error) { await cli.stop();forward?.stop();conn?.end();await host?.stop();if(input.profile?.networkMode!=='direct'&&input.profile?.networkMode!=='relay'&&network?.transport==='tailscale-ssh'&&input.profile?.relayUrl&&/timeout|timed out|handshake|中斷|結束/i.test(String(error)))return connectClaude(_event,{...input,profile:{...input.profile,networkMode:'relay'}});throw error; }
  };
  ipcMain.handle('claude:connect',connectClaude);
  ipcMain.handle('claude:permission',(_event,id:string,value:unknown)=>{
    const runtime=get(id),mode=permissionMode(value);runtime.cli.setPermissionMode(mode);runtime.permissionMode=mode;runtime.host?.setFullFilesystemAccess(mode==='full');
    if(runtime.permissionMode==='full')for(const pending of [...runtime.pending.values()])if(!pending.isQuestion)pending.resolve({allow:runtime.cli.busy&&!runtime.backgroundTextOnly});
    return snapshot(runtime);
  });
  ipcMain.handle('claude:recoverTools',async(_event,id:string)=>{const runtime=get(id);if(runtime.cli.busy)throw new Error('請先停止目前工作，再重新連接工具。');await runtime.host?.recoverProxyTools();return snapshot(runtime);});
  ipcMain.handle('claude:quota',(_event,id:string)=>get(id).cli.refreshQuota());
  ipcMain.handle("claude:status", async (_event, id: string) => {const runtime=get(id);await runtime.cli.refreshAccount();return snapshot(runtime);});
  ipcMain.handle("claude:models", (_event, id: string) => get(id).cli.status().models);
  ipcMain.handle("claude:extensions", async (_event, id: string) => {
    const runtime=get(id),native=await runtime.cli.extensions(),source=runtime.conn?"remote":"local";
    return{items:[...native.plugins.map((plugin:any)=>({id:`local:claude:plugin:${plugin.name}`,name:plugin.name,kind:"plugin",agent:"claude",source,status:"loaded",enabled:true})),...native.commands.map((command:any)=>({id:`local:claude:skill:${command.name}`,name:command.name,kind:"skill",agent:"claude",source,status:"loaded",enabled:true,description:command.description})),...native.mcp.map((server:any)=>({id:`local:claude:mcp:${server.name}`,name:server.name,kind:"mcp",agent:"claude",source,status:server.status,enabled:true}))],warnings:runtime.conn?["朋友主機的原生 Skills／指令仍可使用。此分離模式停用朋友主機的 hooks 與原有 MCP；電腦、檔案與命令改用 Mac 通道。"]:[]};
  });
  ipcMain.handle("claude:send", async (_event, input: any) => {
    const runtime = get(input.runtimeId);
    if(runtime.sendPending||runtime.cli.busy)throw new Error("Claude 還在處理上一則訊息。");
    runtime.sendPending=true;
    try{
    if(!runtime.cli.status().account.authenticated)await runtime.cli.refreshAccount();
    if (!runtime.cli.status().account.authenticated) throw new Error("Claude 原生登入尚未確認；朋友完成登入後可重新發送。");
    if (runtime.cli.busy) throw new Error("Claude 還在處理上一則訊息。");
    if (typeof input.prompt !== "string" || (!input.prompt.trim() && !input.attachments?.length)) throw new Error("請輸入訊息或加入附件。");
    const ids = input.attachments || [];
    if (!Array.isArray(ids) || ids.length > 20 || ids.some((id: unknown) => typeof id !== "string")) throw new Error("附件識別碼無效。");
    if (ids.length && !deps.libraryEntries) throw new Error("檔案庫尚未就緒。");
    if (input.localCwd && await fs.realpath(input.localCwd) !== runtime.cwd) throw new Error("變更 Mac 工作目錄後請重新連線。");
    const attachments = ids.length ? await deps.libraryEntries!(ids) : [];
    const blocks = await runtimeInput(input.prompt.trim() || "請查看並處理附加的檔案。", attachments);
    const content = blocks.map(block => {
      if (block.type === "text") return { type: "text", text: block.text };
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/.exec(block.url);
      if (!match) throw new Error("圖片附件格式無效。");
      return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
    });
    if (runtime.closed || runtime.cli.busy) throw new Error("Claude 已中斷或仍在處理上一則訊息。");
    return await runtime.cli.send({ ...input, content });
    }finally{runtime.sendPending=false;}
  });
  ipcMain.handle("claude:cancel", async (_event, id: string, requestId?: string) => {
    const runtime = get(id); if (requestId && runtime.cli.activeRequestId !== requestId) return { cancelled: false };
    clearPending(runtime); runtime.host?.cancelActive(); return runtime.cli.cancel(requestId);
  });
  ipcMain.handle("claude:respond", (_event, input: any) => {
    const runtime = get(input.runtimeId); const pending = runtime.pending.get(input.approvalId);
    if (!pending || !["accept", "decline"].includes(input.decision)) throw new Error("這個要求已結束或回應無效。");
    let updatedInput: Record<string, unknown> | undefined;
    if (input.decision === "accept" && pending.questions) {
      const answers: Record<string, string> = {};
      pending.questions.forEach((question: any, index: number) => {
        const values = input.answers?.[String(index)];
        if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== "string")) throw new Error("請回答每一個問題。");
        answers[question.question] = values.join(", ");
      });
      updatedInput = { ...pending.input, answers };
    }
    pending.resolve({ allow: input.decision === "accept" && runtime.cli.busy && !runtime.closed, updatedInput });
    return { resolved: true };
  });
  ipcMain.handle("claude:disconnect", async (_event, id: string) => { const runtime = runtimes.get(id); if (runtime) await close(runtime); });
}
