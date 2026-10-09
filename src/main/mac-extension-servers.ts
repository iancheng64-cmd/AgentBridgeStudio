import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalToolStdio, type LocalToolCommand, type LocalMcpTool } from "./local-tool-stdio";
import type {OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';

/** Private main-process launch configuration. Never serialize this object to the renderer. */
export interface MacExtensionServer {
  id: string; name: string; transport: "stdio" | "http";
  command?: LocalToolCommand; url?: string; headers?: Record<string, string>;
  enabledTools?: string[]; disabledTools?: string[]; startupTimeoutMs?: number; toolTimeoutMs?: number;
  authProvider?: OAuthClientProvider;
}
export interface MacExtensionServerStatus { id: string; name: string; transport: "stdio" | "http"; status: "configured" | "disabled" | "connected" | "needs-auth" | "unsupported" | "failed"; toolCount?: number }
export interface MacExtensionServerDiscovery { servers: MacExtensionServer[]; statuses: MacExtensionServerStatus[] }
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const records = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const stringMap = (value: unknown): Record<string, string> => Object.fromEntries(records(value) ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string") : []);

/** Read only explicitly configured Mac MCP transport settings. No keychain/OAuth token extraction. */
export async function discoverMacCodexServers(options: { configFile?: string; cwd?: string; enabledIds?: Set<string>; environment?: NodeJS.ProcessEnv } = {}): Promise<MacExtensionServerDiscovery> {
  const configFile = options.configFile || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  const env = options.environment || process.env;
  let config: Record<string, any>;
  try { const { parse } = await import("smol-toml"); config = parse(await fs.readFile(configFile, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: [], statuses: [] }; throw new Error("無法解析 Mac Codex MCP 設定；未啟動任何外掛程序。"); }
  const servers: MacExtensionServer[] = []; const statuses: MacExtensionServerStatus[] = [];
  for (const [name, raw] of Object.entries(config.mcp_servers || {})) {
    if (!records(raw)) continue;
    const id = `local:codex:mcp:${name}`; const transport = typeof raw.url === "string" ? "http" : "stdio";
    const state: MacExtensionServerStatus = { id, name, transport, status: "configured" }; statuses.push(state);
    if (raw.enabled === false || (options.enabledIds && !options.enabledIds.has(id))) { state.status = "disabled"; continue; }
    // These require a native credential broker, which this adapter intentionally does not impersonate.
    if (raw.http_headers_helper || raw.oauth || raw.ema || raw.bearer_token) { state.status = "needs-auth"; continue; }
    const base: MacExtensionServer = { id, name, transport,
      ...(strings(raw.enabled_tools) ? { enabledTools: raw.enabled_tools } : {}), ...(strings(raw.disabled_tools) ? { disabledTools: raw.disabled_tools } : {}),
      ...(typeof raw.startup_timeout_sec === "number" ? { startupTimeoutMs: Math.max(1000, Math.min(30000, raw.startup_timeout_sec * 1000)) } : {}),
      ...(typeof raw.tool_timeout_sec === "number" ? { toolTimeoutMs: Math.max(1000, Math.min(180000, raw.tool_timeout_sec * 1000)) } : {}) };
    if (transport === "stdio") {
      if (typeof raw.command !== "string" || !raw.command || (raw.args !== undefined && !strings(raw.args))) { state.status = "unsupported"; continue; }
      const childEnv = stringMap(raw.env);
      for (const key of strings(raw.env_vars) ? raw.env_vars : []) if (typeof env[key] === "string") childEnv[key] = env[key]!;
      base.command = { command: raw.command, args: (raw.args || []) as string[], env: childEnv, cwd: typeof raw.cwd === "string" ? raw.cwd : options.cwd };
    } else {
      let url: URL; try { url = new URL(raw.url as string); } catch { state.status = "unsupported"; continue; }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) { state.status = "unsupported"; continue; }
      const headers = stringMap(raw.http_headers); let missingAuth = false;
      for (const [header, variable] of Object.entries(stringMap(raw.env_http_headers))) { if (typeof env[variable] === "string") headers[header] = env[variable]!; else missingAuth = true; }
      if (typeof raw.bearer_token_env_var === "string") { const token = env[raw.bearer_token_env_var]; if (token) headers.Authorization = `Bearer ${token}`; else missingAuth = true; }
      if (missingAuth) { state.status = "needs-auth"; continue; }
      base.url = url.href; base.headers = headers;
    }
    servers.push(base);
  }
  return { servers, statuses };
}

/** One main-process MCP adapter; configured secrets never enter tool descriptions or status. */
export class MacExtensionClient {
  private stdio?: LocalToolStdio;
  private client?: Client;
  private connected = false;
  constructor(readonly spec: MacExtensionServer) {}
  get running() { return this.spec.transport === "stdio" ? Boolean(this.stdio?.running) : this.connected; }
  async start(): Promise<LocalMcpTool[]> {
    let tools: LocalMcpTool[];
    if (this.spec.transport === "stdio") {
      if (!this.spec.command) throw new Error("Missing Mac MCP command");
      this.stdio = new LocalToolStdio(this.spec.command, this.spec.toolTimeoutMs || 60000);
      tools = await this.stdio.start();
    } else {
      if (!this.spec.url) throw new Error("Missing Mac MCP URL");
      const transport = new StreamableHTTPClientTransport(new URL(this.spec.url), { authProvider:this.spec.authProvider,requestInit: { headers: this.spec.headers, redirect: "error" } });
      this.client = new Client({ name: "AgentBridge Mac extension adapter", version: "0.3.0" });
      this.client.onclose = () => { this.connected = false; };
      this.client.onerror = () => {};
      await this.client.connect(transport, { timeout: this.spec.startupTimeoutMs || 10000 }); this.connected = true;
      if(!this.client.getServerCapabilities()?.tools)return [];
      tools = []; let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const listed = await this.client.listTools(cursor ? { cursor } : {}, { timeout: this.spec.startupTimeoutMs || 10000 });
        tools.push(...listed.tools as LocalMcpTool[]);
        if (!listed.nextCursor) break;
        if (listed.nextCursor === cursor || page === 99) throw new Error("Incomplete Mac MCP tool catalog");
        cursor = listed.nextCursor;
      }
    }
    return tools.filter(tool => typeof tool.name === "string" && tool.inputSchema && (!this.spec.enabledTools || this.spec.enabledTools.includes(tool.name)) && !this.spec.disabledTools?.includes(tool.name));
  }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    if (!this.running || signal?.aborted) throw new Error("Mac MCP unavailable or cancelled");
    if (this.stdio) return this.stdio.call(name, args, signal);
    return this.client!.callTool({ name, arguments: args }, undefined, { signal, timeout: this.spec.toolTimeoutMs || 60000 });
  }
  async resource(method:string,params:Record<string,unknown>,signal?:AbortSignal){
    if(!this.running||signal?.aborted)throw new Error('Mac MCP unavailable or cancelled');
    if(this.stdio)return this.stdio.resource(method,params,signal);
    const capability=method.startsWith('resources/')?'resources':'prompts';
    if(!this.client!.getServerCapabilities()?.[capability])throw new Error('Mac MCP server does not support '+capability);
    const options={signal,timeout:this.spec.toolTimeoutMs||60000};
    switch(method){
      case 'resources/list':return this.client!.listResources(params,options);
      case 'resources/templates/list':return this.client!.listResourceTemplates(params,options);
      case 'resources/read':return this.client!.readResource(params as {uri:string},options);
      case 'prompts/list':return this.client!.listPrompts(params,options);
      case 'prompts/get':return this.client!.getPrompt(params as {name:string;arguments?:Record<string,string>},options);
      default:throw new Error('Invalid MCP resource method');
    }
  }
  async stop() { this.connected = false; await this.stdio?.stop(); await this.client?.close(); this.client = undefined; }
}
