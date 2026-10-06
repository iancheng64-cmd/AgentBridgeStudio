import fs from "node:fs";
import { LoopbackForward } from "./loopback-forward";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Client } from "ssh2";
import type { AppServerRpc } from "./app-server-rpc";
import type { HostInstallation } from "./local-code-mode-host";

export interface ExecutorRegistration { environmentId: string; cwd: string; shell: { name: string; path: string } }
export function parseExecutorListener(output: string): number | undefined {
  const match = /^ws:\/\/127\.0\.0\.1:(\d+)\s*$/m.exec(output);
  const port = match ? Number(match[1]) : 0;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}
/** Direct executor transport is deliberately distinct from complete model-tool routing.
 * A successful environment/info is not permission to enable ordinary model turns.
 */
export class LocalExecServer {
  readonly environmentId = `agentbridge-mac-${randomUUID()}`;
  private token = randomBytes(32).toString("base64url");
  private child?: ChildProcessWithoutNullStreams;
  private localPort?: number;
  private cwd?: string;
  private forward?: LoopbackForward;
  constructor(readonly installation: HostInstallation, private onClosed: (reason: string) => void) {}
  get isRunning() { return Boolean(this.child && this.child.exitCode === null && !this.child.killed); }
  get localUrl() { if (!this.localPort) throw new Error("Mac Executor 尚未啟動。"); return `ws://127.0.0.1:${this.localPort}`; }
  async start(cwd: string, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
    if (this.child) throw new Error("Mac Executor 已啟動。");
    this.cwd = await fs.promises.realpath(cwd);
    if (!(await fs.promises.stat(this.cwd)).isDirectory()) throw new Error("Mac 工作目錄不存在。");
    // Only a hash appears in the process argv; the bearer token stays in memory.
    const digest = createHash("sha256").update(this.token).digest("hex");
    return new Promise((resolve, reject) => {
      const child = spawn(this.installation.codexExecutable, ["exec-server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token", "--ws-token-sha256", digest], { cwd: this.cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      let output = "", stderr = "", ready = false;
      const timer = setTimeout(() => { reject(new Error("Mac Executor 啟動逾時。")); this.stop(); }, 12000);
      child.stdout.on("data", chunk => {
        output = (output + chunk.toString()).slice(-32000);
        const port = parseExecutorListener(output);
        if (!ready && port) { ready = true; clearTimeout(timer); this.localPort = port; resolve(this.localUrl); }
      });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", () => {
        clearTimeout(timer);
        if (!ready) reject(new Error(stderr.trim() || "Mac Executor 無法啟動。"));
        if (this.child === child) { this.child = undefined; this.onClosed("Mac Executor 已結束，工具通道已中斷。"); }
      });
    });
  }
  async reverseForward(conn: Client): Promise<string> {
    if (!this.localPort) throw new Error("Mac Executor 尚未啟動。");
    if (this.forward) throw new Error("Mac Executor 通道已建立。");
    this.forward = new LoopbackForward(conn, this.localPort);
    return `ws://127.0.0.1:${await this.forward.start()}`;
  }

  async register(rpc: AppServerRpc, execServerUrl: string): Promise<ExecutorRegistration> {
    if (!this.isRunning || !this.cwd) throw new Error("Mac Executor 尚未啟動。");
    const url = new URL(execServerUrl);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("Executor 僅允許 SSH loopback 通道。");
    await rpc.request("environment/add", { environmentId: this.environmentId, execServerUrl, authBearerToken: this.token, connectTimeoutMs: 8000 }, 12000);
    const info = await rpc.request("environment/info", { environmentId: this.environmentId }, 12000);
    if (!this.isRunning) throw new Error("Mac Executor 在驗證期間已結束。");
    // The canonical executor cwd must be the specific Mac directory used at startup.
    if (info.cwd !== pathToFileURL(this.cwd).href || typeof info.shell?.name !== "string" || typeof info.shell?.path !== "string" || !info.shell.path.startsWith("/")) throw new Error("Executor 回報的工作目錄或 shell 不符合此 Mac，拒絕使用。");
    return { environmentId: this.environmentId, cwd: info.cwd, shell: { name: info.shell.name, path: info.shell.path } };
  }
  stop() {
    this.forward?.stop(); this.forward = undefined; this.localPort = undefined;
    const child = this.child; this.child = undefined;
    if (child) { child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000).unref(); }
  }
}
