import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface LocalToolCommand { computerProvider?:"bundled"|"open-computer-use"; detached?:boolean; command: string; args?: string[]; env?: NodeJS.ProcessEnv; cwd?: string }
export interface LocalMcpTool { name: string; description?: string; inputSchema: Record<string, unknown>; [key: string]: unknown }

/** A private stdio child, never a second unauthenticated HTTP listener. */
export class LocalToolStdio {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = Buffer.alloc(0);
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  constructor(private spec: LocalToolCommand, private timeoutMs = 60_000) {}
  get processId(){return this.child?.pid;}
  get running() { return !!this.child && !this.closing; }
  async start(): Promise<LocalMcpTool[]> {
    this.closing = false;
    this.child = spawn(this.spec.command, this.spec.args || [], {
      cwd: this.spec.cwd, env: { ...process.env, ...this.spec.env }, stdio: "pipe", detached: this.spec.detached ?? process.platform !== "win32"
    });
    this.child.on("error", () => this.fail(new Error("Local MCP process could not start")));
    this.child.on("exit", () => { this.closing = true; this.fail(new Error("Local MCP process exited")); });
    this.child.stdin.on("error", () => this.fail(new Error("Local MCP input closed")));
    this.child.stderr.on("data", () => {}); // Drain without leaking local app data or credentials into logs.
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 32 * 1024 * 1024) { void this.stop(); return; }
      for (;;) {
        const newline = this.buffer.indexOf(10);
        if (newline < 0) break;
        const line = this.buffer.subarray(0, newline).toString("utf8").trim();
        this.buffer = this.buffer.subarray(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error("Local MCP tool request failed"));
          else pending.resolve(message.result);
        } catch { this.fail(new Error("Invalid local MCP response")); void this.stop(); break; }
      }
    });
    try {
      await this.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "AgentBridge", version: "0.3.0" } });
      this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const tools: LocalMcpTool[] = []; let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const result = await this.request("tools/list", cursor ? { cursor } : {});
        if (!Array.isArray(result?.tools)) throw new Error("Local MCP returned no tool catalog");
        tools.push(...result.tools.filter((tool: any) => typeof tool.name === "string" && tool.inputSchema));
        if (!result.nextCursor) return tools;
        if (result.nextCursor === cursor || page === 99) throw new Error("Incomplete local MCP tool catalog");
        cursor = result.nextCursor;
      }
      return tools;
    } catch (error) { await this.stop(); throw error; }
  }
  /** Serialize GUI actions, while independent HTTP calls keep their own response IDs. */
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const operation = this.queue.then(async () => {
      if (signal?.aborted) throw new Error("Request cancelled");
      const abort = () => { void this.stop(); };
      signal?.addEventListener("abort", abort, { once: true });
      try { return await this.request("tools/call", { name, arguments: args }); }
      finally { signal?.removeEventListener("abort", abort); }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  private request(method: string, params: unknown): Promise<any> {
    if (!this.running) return Promise.reject(new Error("Local MCP process unavailable"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.stop(); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  private fail(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  async stop() {
    this.closing = true;
    this.fail(new Error("Local MCP stopped or timed out"));
    const child = this.child;
    this.child = undefined;
    if (!child?.pid) return;
    const kill = (signal: NodeJS.Signals) => { try { if (process.platform !== "win32" && this.spec.detached!==false) process.kill(-child.pid!, signal); else child.kill(signal); } catch {} };
    kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { kill("SIGKILL"); resolve(); }, 500);
      child.once("exit", () => { clearTimeout(timer); kill("SIGKILL"); resolve(); });
    });
  }
}
