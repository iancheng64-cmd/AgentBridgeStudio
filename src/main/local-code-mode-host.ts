import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Client } from "ssh2";

export interface HostInstallation { executable: string; codexExecutable: string; version: string }
export function captureExecutable(executable: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Codex 執行檔檢查逾時。")); }, timeoutMs);
    child.stdout.on("data", chunk => { out = (out + chunk.toString()).slice(-32000); });
    child.stderr.on("data", chunk => { err = (err + chunk.toString()).slice(-2000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || "Codex 執行檔檢查失敗。")); });
  });
}
export function parseCodexVersion(value: string) { return /codex-cli\s+([^\s]+)/.exec(value)?.[1] || ""; }
export async function findHostInstallation(remoteVersion: string, resourcesPath?: string, override?: string): Promise<HostInstallation> {
  const candidates = [
    override,
    resourcesPath ? path.join(resourcesPath, "codex", "bin", "codex-code-mode-host") : undefined,
    path.resolve(__dirname, "..", "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin", "codex-code-mode-host"),
    resourcesPath ? path.join(resourcesPath, "code-mode", "codex-code-mode-host") : undefined,
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex-code-mode-host",
    path.join(os.homedir(), ".hermes/node/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex-code-mode-host"),
    ...((process.env.PATH || "").split(path.delimiter).map(dir => path.join(dir, "codex-code-mode-host")))
  ].filter((item): item is string => Boolean(item));
  const found: string[] = [];
  for (const executable of [...new Set(candidates)]) {
    const codexExecutable = path.join(path.dirname(executable), "codex");
    if (!fs.existsSync(executable) || !fs.existsSync(codexExecutable)) continue;
    try {
      const version = parseCodexVersion(await captureExecutable(codexExecutable, ["--version"]));
      found.push(version);
      if (version !== remoteVersion) continue;
      const help = await captureExecutable(executable, ["--help"]);
      if (!help.includes("grpc://IP:PORT")) continue;
      return { executable, codexExecutable, version };
    } catch { /* Try another complete installation; never mix host and CLI bundles. */ }
  }
  throw new Error(`找不到與 Runtime ${remoteVersion} 相同版本的 Mac 工具執行器（本機已找到：${found.filter(Boolean).join("、") || "無"}）。請更新 AgentBridge App，或安裝相同版本的完整 Codex CLI 套件。`);
}
export class LocalCodeModeHost {
  private child?: ChildProcessWithoutNullStreams;
  private sockets = new Set<net.Socket>();
  private remotePort?: number;
  private localPort?: number;
  private connection?: Client;
  private forwardingHandler?: (...args: any[]) => void;
  constructor(readonly installation: HostInstallation, private onClosed: (reason: string) => void) {}
  get isRunning() { return Boolean(this.child && this.child.exitCode === null && !this.child.killed); }
  async start(cwd: string): Promise<number> {
    const realCwd = await fs.promises.realpath(cwd);
    if (!(await fs.promises.stat(realCwd)).isDirectory()) throw new Error("Mac 工作目錄不存在。");
    return new Promise((resolve, reject) => {
      const child = spawn(this.installation.executable, ["--listen", "grpc://127.0.0.1:0"], { cwd: realCwd, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      let output = "", stderr = "", resolved = false;
      const timer = setTimeout(() => { reject(new Error("Mac Code Mode Host 啟動逾時。")); this.stop(); }, 12000);
      child.stdout.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-32000);
        const match = /^http:\/\/127\.0\.0\.1:(\d+)\s*$/m.exec(output);
        if (!resolved && match && Number(match[1]) > 0 && Number(match[1]) <= 65535) { resolved = true; clearTimeout(timer); this.localPort = Number(match[1]); resolve(this.localPort); }
      });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", () => {
        clearTimeout(timer);
        if (!resolved) reject(new Error(stderr.trim() || "Mac Code Mode Host 無法啟動。"));
        if (this.child === child) { this.child = undefined; this.onClosed("Mac Code Mode Host 已結束，工具通道已中斷。"); }
      });
    });
  }
  async reverseForward(conn: Client): Promise<string> {
    if (!this.localPort) throw new Error("Mac Code Mode Host 尚未啟動。");
    this.connection = conn;
    this.forwardingHandler = (info: any, accept: () => any, reject: () => void) => {
      if (info.destPort !== this.remotePort || !["127.0.0.1", "localhost"].includes(info.destIP)) { reject(); return; }
      const channel = accept();
      const socket = net.connect({ host: "127.0.0.1", port: this.localPort! });
      this.sockets.add(socket);
      socket.on("connect", () => socket.pipe(channel).pipe(socket));
      socket.on("error", () => channel.destroy());
      channel.on("error", () => socket.destroy());
      channel.on("close", () => socket.destroy());
      socket.on("close", () => { this.sockets.delete(socket); channel.destroy(); });
    };
    conn.on("tcp connection", this.forwardingHandler);
    this.remotePort = await new Promise<number>((resolve, reject) => conn.forwardIn("127.0.0.1", 0, (error, port) => error ? reject(error) : port > 0 && port <= 65535 ? resolve(port) : reject(new Error("SSH 沒有分配有效的反向通道連接埠。"))));
    return `http://127.0.0.1:${this.remotePort}`;
  }
  stop() {
    if (this.forwardingHandler) this.connection?.removeListener("tcp connection", this.forwardingHandler);
    if (this.remotePort) { try { this.connection?.unforwardIn("127.0.0.1", this.remotePort, () => {}); } catch {} }
    this.forwardingHandler = undefined; this.connection = undefined; this.remotePort = undefined; this.localPort = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const child = this.child; this.child = undefined;
    if (child) { child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000).unref(); }
  }
}
