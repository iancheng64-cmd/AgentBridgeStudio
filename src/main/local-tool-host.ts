import {computerReport} from "./native-diagnostics";
import { spawn } from "node:child_process";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import path from "node:path";
import { LocalToolStdio, type LocalToolCommand, type LocalMcpTool } from "./local-tool-stdio.js";
import { MacExtensionClient, type MacExtensionServer, type MacExtensionServerStatus } from "./mac-extension-servers.js";
import { agentRelayHub, type AgentRelayRole } from "./agent-relay.js";
export type { LocalToolCommand } from "./local-tool-stdio.js";

export interface LocalToolCall { name: string; arguments: Record<string, unknown>; category: "shell" | "filesystem-read" | "filesystem-write" | "computer" | "browser" | "extension" | "agent-bridge" }
export interface LocalToolHostOptions {
  allowedRoots: string[];
  enableShell?:boolean;
  readOnlyRoots?: string[];
  nativeCommand?: LocalToolCommand;
  browserCommand?: LocalToolCommand;
  extensionServers?: MacExtensionServer[];
  agentRole?: AgentRelayRole;
  appPath?: string;
  resourcesPath?: string;
  port?: number;
  requestTimeoutMs?: number;
  authorize: (call: LocalToolCall) => boolean | Promise<boolean>;
  onActivity?: (info: { name: string; category: LocalToolCall["category"]; status: "started" | "completed" | "failed" }) => void;
}
interface Entry { available?: () => boolean; tool: LocalMcpTool; category: LocalToolCall["category"]; invoke: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> }
const textResult = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Session-scoped, authenticated, stateless Streamable HTTP MCP host on IPv4 loopback only.
 * Filesystem roots constrain these file tools, NOT native shell or GUI operations.
 * Native exec-server remains responsible for shell/PTY and its own approval policy.
 */
const liveHosts=new Set<LocalToolHost>();
export const hasLiveLocalToolHosts=()=>liveHosts.size>0;
export class LocalToolHost {
  private server?: http.Server;
  private token = "";
  private port = 0;
  private roots: string[] = [];
  private readonlyRoots: string[] = [];
  private entries = new Map<string, Entry>();
  private children = new Map<string, LocalToolStdio>();
  private unavailable: string[] = [];
  private extensionClients = new Map<string, MacExtensionClient>();
  private extensionStatuses: MacExtensionServerStatus[] = [];
  private relayDetach?: () => void;
  private active = new Set<AbortController>();
  private generation = 0;
  private starting = false;
  constructor(private options: LocalToolHostOptions) {}

  async start() {
    if (this.server || this.starting) throw new Error("Local Tool Host already started");
    this.starting = true;liveHosts.add(this);
    this.generation++;
    const generation = this.generation;
    try {
      this.roots = await Promise.all(this.options.allowedRoots.map(root => fs.realpath(path.resolve(root))));
      this.readonlyRoots = await Promise.all((this.options.readOnlyRoots || []).map(root => fs.realpath(path.resolve(root))));
      for (const root of [...this.roots, ...this.readonlyRoots]) if (!(await fs.stat(root)).isDirectory()) throw new Error("Local tool root must be a directory");
      if (!this.roots.length && !this.readonlyRoots.length) throw new Error("At least one explicit local root is required");
      this.token = randomBytes(32).toString("base64url");
      this.unavailable = [];
      this.registerFilesystem();
      if(this.options.enableShell)this.registerShell();
      if (this.options.agentRole) {
        this.relayDetach = agentRelayHub.attach(this.options.agentRole);
        this.registerAgentRelay(this.options.agentRole);
      }
      const nativePath = this.options.resourcesPath
        ? path.join(this.options.resourcesPath, "computer-use", "claudex-computer-use")
        : this.options.appPath ? path.join(this.options.appPath, "vendor/open-codex-computer-use/.build/release/claudex-computer-use") : undefined;
      const native = this.options.nativeCommand || (nativePath && existsSync(nativePath) ? { command: nativePath } : undefined);
      this.extensionStatuses = [];
      await Promise.all([this.registerProxy("computer", native), this.registerProxy("browser", this.options.browserCommand)]);
      if (generation !== this.generation) throw new Error("Local Tool Host startup cancelled");
      const configured = this.options.extensionServers || [];
      for (let offset = 0; offset < configured.length; offset += 4) await Promise.all(configured.slice(offset, offset + 4).map(spec => this.registerExtension(spec)));
      this.server = http.createServer((req, res) => { void this.handle(req, res); });
      this.server.requestTimeout = 15_000;
      this.server.headersTimeout = 10_000;
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.options.port || 0, "127.0.0.1", () => { this.server!.off("error", reject); resolve(); });
      });
      if (generation !== this.generation) throw new Error("Local Tool Host startup cancelled");
      const address = this.server.address();
      if (!address || typeof address === "string") throw new Error("Local Tool Host did not bind");
      this.port = address.port;
      return { host: "127.0.0.1" as const, port: this.port, url: `http://127.0.0.1:${this.port}/mcp`, token: this.token, tools: this.listTools().map(tool => tool.name) };
    } catch (error) { await this.stop(); throw error; }
    finally { this.starting = false; }
  }
  listTools() { return [...this.entries.values()].filter(entry => (!entry.available || entry.available()) && (!["computer", "browser"].includes(entry.category) || this.children.get(entry.category)?.running)).map(entry => entry.tool); }
  status() {
    return { ok: !!this.server?.listening, platform: process.platform, version: "0.3.0", computerProvider:this.options.nativeCommand?.computerProvider||"bundled", tools: this.listTools().map(tool => tool.name),
      computer: this.children.get("computer")?.running ? "connected-permissions-unverified" : "unavailable",
      browser: this.children.get("browser")?.running ? "connected-browser-unverified" : "unavailable", extensions: this.extensionStatuses.map(item => ({ ...item, ...(item.status === "connected" && !this.extensionClients.get(item.id)?.running ? { status: "failed" as const } : {}) })), unavailable: [...this.unavailable] };
  }
  async computerDiagnostics(prompt=false){
    const computer=this.children.get('computer');
    if(!computer?.running)throw new Error('電腦工具通道尚未啟動，請重新連接工具。');
    return computerReport(computer,this.options.nativeCommand||{command:"bundled"},prompt);
  }
  async toolHealth(){
    const computer=await this.computerDiagnostics();
    const browser=this.children.get("browser");if(!browser?.running)throw new Error("瀏覽器工具尚未接通，請重新連接工具。");
    const result=await browser.call("browser_tabs",{action:"list"});if(result?.isError)throw new Error("瀏覽器工具健康檢查失敗。");
    return {computer,browser:{ok:true},checkedAt:Date.now()};
  }
  private recovering=false;
  async recoverProxyTools(){
    if(this.recovering)throw new Error("工具正在重新連接，請稍後重試。");
    if(!this.server?.listening||this.active.size)throw new Error("工具通道未連線或仍有操作執行中，請稍後重試。");
    this.recovering=true;try{
    this.unavailable=this.unavailable.filter(kind=>kind!=="computer"&&kind!=="browser");
    for(const kind of ['computer','browser'] as const){await this.children.get(kind)?.stop();this.children.delete(kind);for(const [name,entry]of this.entries)if(entry.category===kind)this.entries.delete(name);}
    const nativePath=this.options.resourcesPath?path.join(this.options.resourcesPath,'computer-use','claudex-computer-use'):this.options.appPath?path.join(this.options.appPath,'vendor/open-codex-computer-use/.build/release/claudex-computer-use'):undefined;
    await Promise.all([this.registerProxy('computer',this.options.nativeCommand||(nativePath&&existsSync(nativePath)?{command:nativePath}:undefined)),this.registerProxy('browser',this.options.browserCommand)]);
    return this.status();
    }finally{this.recovering=false;}
  }
  /** Invalidate approvals and cancel queued/running proxy calls without closing the endpoint. */
  cancelActive() {
    this.generation++;
    for (const controller of this.active) controller.abort();
  }
  async stop() {
    this.cancelActive();
    this.token = "";
    this.active.clear();
    const server = this.server; this.server = undefined;
    server?.closeAllConnections();
    await Promise.all([...this.children.values()].map(child => child.stop()));
    this.children.clear();
    await Promise.all([...this.extensionClients.values()].map(client => client.stop().catch(() => {})));
    this.extensionClients.clear(); this.extensionStatuses = [];
    this.relayDetach?.(); this.relayDetach = undefined;
    this.entries.clear();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    this.port = 0;liveHosts.delete(this);
  }
  private registerAgentRelay(role: AgentRelayRole) {
    const add = (name: string, description: string, properties: Record<string, unknown>, required: string[], invoke: Entry["invoke"]) => {
      this.entries.set(name, {
        category: "agent-bridge",
        tool: {
          name,
          description,
          inputSchema: { type: "object", properties, required, additionalProperties: false },
          annotations: { readOnlyHint: ["agentbridge_peer_status", "agentbridge_peer_read", "agentbridge_peer_wait", "agentbridge_peer_transcript"].includes(name), destructiveHint: false, openWorldHint: false }
        },
        invoke
      });
    };
    const conversation = { type: "string", description: "Relay conversation id returned by agentbridge_peer_open" };
    const afterSeq = { type: "integer", minimum: 0, description: "Only return peer messages with a sequence number greater than this cursor" };
    add(
      "agentbridge_peer_status",
      `Inspect the shared Codex↔Claude relay. Use this when the user asks to talk with the other model or when you need to discover active relay conversations. This MCP host represents ${role}.`,
      {},
      [],
      async () => textResult(agentRelayHub.status(role))
    );
    add(
      "agentbridge_peer_open",
      `Open a new shared Codex↔Claude relay conversation as ${role}. Only use it for an explicit cross-model collaboration/discussion request. After opening, send the task to the peer with agentbridge_peer_send.`,
      { topic: { type: "string", maxLength: 500, description: "Short topic or purpose for the cross-model conversation" } },
      [],
      async args => textResult(agentRelayHub.create(role, args.topic))
    );
    add(
      "agentbridge_peer_send",
      `Send one message from ${role} to the other model through the shared relay. This stores the message locally until the peer reads it; it does not itself start a peer model turn.`,
      { conversation_id: conversation, message: { type: "string", minLength: 1, maxLength: 32000, description: "Message to the peer model" } },
      ["conversation_id", "message"],
      async args => textResult(agentRelayHub.send(role, args.conversation_id, args.message))
    );
    add(
      "agentbridge_peer_read",
      `Read messages sent by the peer model to ${role}. Use the returned cursor as after_seq on the next read.`,
      { conversation_id: conversation, after_seq: afterSeq, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      ["conversation_id"],
      async args => textResult(agentRelayHub.read(role, args.conversation_id, args.after_seq, args.limit))
    );
    add(
      "agentbridge_peer_wait",
      `Wait briefly for the peer model to send a new message to ${role}. This is a bounded long-poll; it never invokes the peer automatically.`,
      { conversation_id: conversation, after_seq: afterSeq, timeout_ms: { type: "integer", minimum: 100, maximum: 55000, default: 30000 } },
      ["conversation_id"],
      async (args, signal) => textResult(await agentRelayHub.wait(role, args.conversation_id, args.after_seq, args.timeout_ms, signal))
    );
    add(
      "agentbridge_peer_transcript",
      `Read the recent two-sided Codex↔Claude transcript for this relay conversation as ${role}.`,
      { conversation_id: conversation, limit: { type: "integer", minimum: 1, maximum: 400, default: 100 } },
      ["conversation_id"],
      async args => textResult(agentRelayHub.transcript(role, args.conversation_id, args.limit))
    );
    add(
      "agentbridge_peer_close",
      `Close a Codex↔Claude relay conversation as ${role}; waiting peer calls are released.`,
      { conversation_id: conversation },
      ["conversation_id"],
      async args => textResult(agentRelayHub.close(role, args.conversation_id))
    );
  }
  private async registerExtension(spec: MacExtensionServer) {
    const client = new MacExtensionClient(spec); this.extensionClients.set(spec.id, client);
    const state: MacExtensionServerStatus = { id: spec.id, name: spec.name, transport: spec.transport, status: "configured", toolCount: 0 }; this.extensionStatuses.push(state);
    let timer: NodeJS.Timeout | undefined;
    try {
      const tools = await Promise.race([client.start(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Mac MCP startup timed out")), spec.startupTimeoutMs || 10000); })]);
      const prefix = `mac_ext_${createHash("sha256").update(spec.id).digest("hex").slice(0, 12)}_`;
      for (const original of tools) {
        const suffix = original.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 65);
        const hash = createHash("sha256").update(original.name).digest("hex").slice(0, 8);
        const name = `${prefix}${suffix}_${hash}`;
        this.entries.set(name, { category: "extension", available: () => client.running, tool: { ...original, name, description: `[Mac extension: ${spec.name.slice(0, 100)}; original tool: ${original.name.slice(0, 100)}] ${original.description || ""}` }, invoke: (args, signal) => client.call(original.name, args, signal) });
      }
      state.status = "connected"; state.toolCount = tools.length;
    } catch (error) { state.status = /401|403|unauthori[sz]ed|authentication/i.test(String(error)) ? "needs-auth" : "failed"; await client.stop().catch(() => {}); }
    finally { clearTimeout(timer); }
  }
  private async registerProxy(category: "computer" | "browser", command?: LocalToolCommand) {
    if (!command) { this.unavailable.push(category); return; }
    const child = new LocalToolStdio(command, this.options.requestTimeoutMs || 60_000);
    this.children.set(category, child);
    try {
      const tools = await child.start();
      for (const original of tools) {
        const name = `mac_${category}_${original.name}`;
        this.entries.set(name, { category, tool: { ...original, name, description: `[Executes on this Mac] ${original.description || original.name}` }, invoke: (args, signal) => child.call(original.name, args, signal) });
      }
    } catch { this.unavailable.push(category); await child.stop(); }
  }
  private registerShell(){
    this.entries.set("mac_shell_execute",{category:"shell",tool:{name:"mac_shell_execute",description:"Execute a command on the user Mac. Work directory defaults to the selected Mac folder. This shell is not restricted by file-tool roots; follow the user's authorization.",inputSchema:{type:"object",properties:{command:{type:"string"},cwd:{type:"string"},timeoutMs:{type:"integer",minimum:100,maximum:120000}},required:["command"],additionalProperties:false}},invoke:async(args,signal)=>{
      if(typeof args.command!=="string"||!args.command.trim()||args.command.length>100000||args.command.includes("\0"))throw new Error("Invalid Mac command");
      const cwd=args.cwd?await this.guard(args.cwd):this.roots[0];if(!(await fs.stat(cwd)).isDirectory())throw new Error("Mac command cwd must be a directory");
      if(signal?.aborted)throw new Error("Request cancelled");
      return await new Promise((resolve,reject)=>{
        const child=spawn('/bin/zsh',['-lc',args.command as string],{cwd,env:process.env,detached:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',truncated=false,reason='';
        const kill=()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}};const cancel=()=>{reason='cancelled';kill();};signal?.addEventListener('abort',cancel,{once:true});
        const timeout=setTimeout(()=>{reason='timeout';kill();},Math.min(120000,Math.max(100,Number(args.timeoutMs)||60000)));
        const append=(chunk:Buffer,error=false)=>{const text=chunk.toString('utf8');if(stdout.length+stderr.length+text.length>1024*1024){truncated=true;kill();return;}if(error)stderr+=text;else stdout+=text;};child.stdout.on('data',chunk=>append(chunk));child.stderr.on('data',chunk=>append(chunk,true));
        const dispose=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',cancel);};child.on('error',()=>{dispose();reject(new Error('Mac shell could not start'));});child.on('close',(code,exitSignal)=>{dispose();if(reason==='cancelled')reject(new Error('Request cancelled'));else resolve(textResult({stdout,stderr,exitCode:code,signal:exitSignal,timedOut:reason==='timeout',truncated,executionLocation:'local',cwd}));});
      });
    }});
  }
  private registerFilesystem() {
    const add = (name: string, description: string, properties: Record<string, unknown>, required: string[], write: boolean, invoke: Entry["invoke"]) => {
      this.entries.set(name, { category: write ? "filesystem-write" : "filesystem-read", tool: { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations: { readOnlyHint: !write, destructiveHint: write, openWorldHint: false } }, invoke });
    };
    const p = { type: "string", description: "Absolute Mac path within an explicitly allowed root" };
    add("mac_fs_list", "List up to 1000 entries in an allowed Mac directory", { path: p }, ["path"], false, async args => {
      const target = await this.guard(args.path);
      const entries = await fs.readdir(target, { withFileTypes: true });
      return textResult({ entries: entries.slice(0, 1000).map(entry => ({ name: entry.name, type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file" })), truncated: entries.length > 1000 });
    });
    add("mac_fs_stat", "Inspect an allowed Mac path", { path: p }, ["path"], false, async args => {
      const stat = await fs.stat(await this.guard(args.path));
      return textResult({ type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other", size: stat.size, modifiedAt: stat.mtime.toISOString() });
    });
    add("mac_fs_read", "Read UTF-8 text, limited to 1 MiB, from the Mac", { path: p }, ["path"], false, async args => {
      const target = await this.guard(args.path);
      const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile()) throw new Error("Only regular files may be read");
        await this.guard(target);
        const data = Buffer.alloc(1024 * 1024 + 1);
        const { bytesRead } = await file.read(data, 0, data.length, 0);
        return textResult({ text: data.subarray(0, Math.min(bytesRead, 1024 * 1024)).toString("utf8"), truncated: bytesRead > 1024 * 1024 });
      } finally { await file.close(); }
    });
    add("mac_fs_write", "Atomically replace/create a UTF-8 file within writable Mac roots (maximum 1 MiB)", { path: p, text: { type: "string" } }, ["path", "text"], true, async args => {
      if (typeof args.text !== "string" || Buffer.byteLength(args.text) > 1024 * 1024) throw new Error("Text must be at most 1 MiB");
      const target = await this.guard(args.path, true, true);
      const temporary = path.join(path.dirname(target), `.agentbridge-${randomBytes(12).toString("hex")}`);
      try {
        await fs.writeFile(temporary, args.text, { flag: "wx", mode: 0o600 });
        await this.guard(temporary, true); await this.guard(target, true, true);
        await fs.rename(temporary, target);
      } finally { await fs.unlink(temporary).catch(() => {}); }
      return textResult({ written: Buffer.byteLength(args.text) });
    });
    add("mac_fs_mkdir", "Create one directory within writable Mac roots", { path: p }, ["path"], true, async args => {
      await fs.mkdir(await this.guard(args.path, true, true), { mode: 0o700 }); return textResult({ created: true });
    });
    add("mac_fs_search", "Search filenames by glob (* and ?) within an allowed Mac root; skips symlinks; bounded to 10000 entries and 500 matches", { root: p, query: { type: "string" } }, ["root", "query"], false, async (args, signal) => {
      if (typeof args.query !== "string" || !args.query.length || args.query.length > 200) throw new Error("Invalid filename query");
      const pattern = new RegExp("^" + args.query.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
      const todo = [await this.guard(args.root)]; const matches: string[] = []; let scanned = 0;
      while (todo.length && scanned < 10000 && matches.length < 500) {
        if (signal?.aborted) throw new Error("Request cancelled");
        const directory = await this.guard(todo.shift());
        for (const item of await fs.readdir(directory, { withFileTypes: true })) {
          if (++scanned > 10000 || matches.length >= 500) break;
          if (item.isSymbolicLink()) continue;
          const target = path.join(directory, item.name);
          if (pattern.test(item.name)) matches.push(target);
          if (item.isDirectory()) todo.push(target);
        }
      }
      return textResult({ matches, scanned, truncated: todo.length > 0 || scanned >= 10000 || matches.length >= 500 });
    });
    for (const move of [false, true]) add(move ? "mac_fs_move" : "mac_fs_copy", `${move ? "Move" : "Copy"} a regular Mac file to a new path; never overwrite an existing destination`, { source: p, destination: p }, ["source", "destination"], true, async args => {
      const source = await this.guard(args.source, move);
      const destination = await this.guard(args.destination, true, true);
      if (!(await fs.lstat(source)).isFile()) throw new Error("Only regular files may be copied or moved");
      if (move) {
        // Hard-link creation is atomic and fails if the destination exists. Cross-volume moves fail safely.
        await fs.link(source, destination);
        await this.guard(source, true); await this.guard(destination, true);
        await fs.unlink(source);
      } else await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
      return textResult({ completed: true });
    });
    add("mac_fs_delete", "Delete one file or empty directory within writable Mac roots; recursive deletion is not supported", { path: p }, ["path"], true, async args => {
      const target = await this.guard(args.path, true);
      if ((await fs.lstat(target)).isDirectory()) await fs.rmdir(target); else await fs.unlink(target);
      return textResult({ deleted: true });
    });
  }
  /** Reject symlink components, including existing leafs. Root realpaths are pinned at start.
   * Rechecking and O_NOFOLLOW reduce races; this is not an OS sandbox against a hostile local process.
   */
  private async guard(value: unknown, write = false, mayCreate = false): Promise<string> {
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("An absolute Mac path is required");
    const target = path.resolve(value);
    const roots = [...this.roots, ...this.readonlyRoots];
    const root = roots.filter(root => inside(root, target)).sort((a, b) => b.length - a.length)[0];
    if (!root || (write && (!this.roots.some(root => inside(root, target)) || this.readonlyRoots.some(root => inside(root, target)) || roots.includes(target)))) throw new Error("Path is outside the permitted roots or is read-only");
    if (await fs.realpath(root) !== root) throw new Error("Allowed root changed");
    let current = root;
    const parts = path.relative(root, target).split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Symlink paths are not permitted"); }
      catch (error) { if (mayCreate && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") return target; throw error; }
    }
    if (!inside(root, await fs.realpath(target))) throw new Error("Path escaped its root");
    return target;
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, value?: unknown) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(value === undefined ? undefined : JSON.stringify(value)); };
    const expected = Buffer.from(`Bearer ${this.token}`);
    const supplied = Buffer.from(req.headers.authorization || "");
    if (!this.token || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { send(401, { error: "Unauthorized" }); return; }
    // Browsers are not MCP clients. Reject Origin entirely, including localhost web pages.
    if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || "")) { send(403, { error: "Forbidden origin or host" }); return; }
    if (req.url === "/health" && req.method === "GET") { send(200, this.status()); return; }
    if (req.url !== "/mcp") { send(404); return; }
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); send(405); return; }
    if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) { send(415); return; }
    let body: any;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) { send(413); return; } chunks.push(chunk); }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { send(400, { error: "Invalid JSON" }); return; }
    if (!object(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string" || (body.id !== undefined && typeof body.id !== "string" && typeof body.id !== "number")) { send(400, { error: "Invalid JSON-RPC request" }); return; }
    if (body.id === undefined) { send(202); return; }
    const params = object(body.params) ? body.params : {};
    const result = (result: unknown) => send(200, { jsonrpc: "2.0", id: body.id, result });
    const error = (code: number, message: string) => send(200, { jsonrpc: "2.0", id: body.id, error: { code, message } });
    if (body.method === "initialize") {
      const supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
      result({ protocolVersion: typeof params.protocolVersion === "string" && supported.includes(params.protocolVersion) ? params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "AgentBridge-Mac", version: "0.3.0" }, instructions: "These tools execute on the user's Mac. Shell/PTY use the registered Mac executor. File roots do not sandbox browser or computer actions." }); return;
    }
    if (body.method === "ping") { result({}); return; }
    if (body.method === "tools/list") { result({ tools: this.listTools() }); return; }
    if (body.method !== "tools/call") { error(-32601, "Method not found"); return; }
    const entry = typeof params.name === "string" ? this.entries.get(params.name) : undefined;
    if (!entry || !object(params.arguments || {})) { error(-32602, "Unknown tool or invalid arguments"); return; }
    if (this.active.size >= 16) { error(-32000, "Too many concurrent tool calls"); return; }
    const generation = this.generation;
    const controller = new AbortController(); this.active.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs || 120_000);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); }; res.on("close", disconnected);
    const call = { name: entry.tool.name, arguments: (params.arguments || {}) as Record<string, unknown>, category: entry.category };
    const activity = (status: "started" | "completed" | "failed") => { try { this.options.onActivity?.({ name: call.name, category: call.category, status }); } catch {} };
    try {
      const cancelled = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Request cancelled or timed out")), { once: true }));
      const work = async () => {
        if (!await this.options.authorize?.(call)) throw new Error("Local tool permission denied");
        if (controller.signal.aborted || generation !== this.generation) throw new Error("Request cancelled");
        activity("started");
        return entry.invoke(call.arguments, controller.signal);
      };
      const value = await Promise.race([work(), cancelled]);
      result(value); activity(object(value) && value.isError === true ? "failed" : "completed");
    } catch (failure) {
      // OS messages can include local file paths. Return a bounded reason without stack traces.
      const reason = (failure as Error).message;
      const safe = /^(Local tool permission denied|Request cancelled|Symlink paths|Path is outside|An absolute|Only regular|Text must|Allowed root|Path escaped)/.test(reason) ? reason : "Mac local tool failed; check local permissions and service status";
      result({ ...textResult(safe), isError: true }); activity("failed");
    } finally { clearTimeout(timeout); res.off("close", disconnected); this.active.delete(controller); }
  }
}
