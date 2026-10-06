import {ComputerProviderStore} from "./computer-provider";
import {browserRuntimeArgs} from "./browser-runtime";
import {hasLiveLocalToolHosts} from "./local-tool-host";
import {httpToolHealth,requirePrivateHttpBinding,browserHttpAllowedHosts} from "./http-tool-health";
import {probeNativePermissions,nativePermissions,StandaloneToolHealth} from "./native-diagnostics";
import { publicProfile, saveCredentialProfile, savedCredentialFor } from "./profile-credentials";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, systemPreferences } from "electron";
import path from "node:path";
import { registerDesktopBackend, cancelSessionChats, resolveLibraryEntries, libraryRoot } from "./desktop-backend";
import { registerRuntimeBackend, stopAllRuntimes, codexComputerDiagnostics, codexToolHealth } from "./runtime-backend";
import { discoverMacCodexServers } from "./mac-extension-servers";
import {MacMcpOAuthProvider,beginMacMcpLogin,stopMacMcpLogin} from './mac-mcp-auth';
import { registerClaudeLocalBackend, stopAllClaudeLocalRuntimes, claudeComputerDiagnostics, claudeToolHealth } from "./claude-local-backend";
import { registerAgentOrchestrator } from "./agent-orchestrator";
import { localExtensions, remoteExtensionScript } from "./extensions";
import { shellQuote } from "./chat-protocol";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import {
  BindRelay,
  BROWSER_USE_PORT,
  COMPUTER_USE_PORT,
  OAUTH_DEFAULT_PORT,
  readExposure,
  writeExposure,
  type ExposureMode,
  type ExposureState
} from "./exposure";

type AuthType = "agent" | "key" | "password";

interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  keyPath?: string;
  savePassword?: boolean;
  encryptedPassword?: string;
  runtimePlatform?: 'auto' | 'windows' | 'posix';
}

interface ConnectPayload {
  profile: ConnectionProfile;
  password?: string;
}

interface RemoteSession {
  id: string;
  conn: Client;
  profile: ConnectionProfile;
  shell?: ClientChannel;
  remoteHome: string;
  oauthServers: Map<number, net.Server>;
}

interface ManagedService {
  name: string;
  child?: ChildProcessWithoutNullStreams;
  command: string;
  status: "stopped" | "starting" | "running" | "error";
  logs: string[];
  url?:string; computerProvider?:"bundled"|"open-computer-use"; health?:any;
}

type TransferDirection = "upload" | "download";
type TransferState = "queued" | "running" | "paused" | "completed" | "error" | "cancelled";

interface TransferTask {
  id: string;
  sessionId: string;
  direction: TransferDirection;
  source: string;
  target: string;
  name: string;
  isDirectory: boolean;
  state: TransferState;
  totalBytes: number;
  transferredBytes: number;
  filesTotal: number;
  filesDone: number;
  startedAt?: number;
  updatedAt: number;
  error?: string;
  cancelRequested: boolean;
  activeRead?: NodeJS.ReadableStream & { pause?: () => void; resume?: () => void; destroy?: (error?: Error) => void };
  activeWrite?: NodeJS.WritableStream & { destroy?: (error?: Error) => void };
}

const sessions = new Map<string, RemoteSession>();
const services = new Map<string, ManagedService>();
const transfers = new Map<string, TransferTask>();
let mainWindow: BrowserWindow | null = null;

process.on("uncaughtException", (error: any) => {
  if (error && (error.code === "ECONNRESET" || error.code === "EPIPE" || error.code === "ECANCELED" || error.message?.includes("ECONNRESET"))) {
    console.warn("Ignored socket teardown error in main process:", error.message);
    return;
  }
  console.error("Uncaught exception in main process:", error);
});

// Packaged and preview copies share the same userData and runtime ports.
// Keep one process so launching another copy raises the existing workspace.
const dataArgument = process.argv.find(value => value.startsWith('--user-data-dir='));
if (dataArgument) {
  const directory = dataArgument.slice('--user-data-dir='.length);
  if (!path.isAbsolute(directory)) throw new Error('--user-data-dir must be an absolute directory.');
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  app.setPath('userData', directory);
}
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on("second-instance", () => {
  if (!mainWindow) {
    if (app.isReady()) void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function appDataPath(...parts: string[]) {
  return path.join(app.getPath("userData"), ...parts);
}
function exposurePath() {
  return appDataPath("exposure.json");
}
// Resolved lazily: `app.getPath` is not guaranteed to answer before the app is
// ready, and this module is imported at startup.
let exposureCache: ExposureState | undefined;
function currentExposure(): ExposureState {
  if (!exposureCache) exposureCache = readExposure(exposurePath());
  return exposureCache;
}
let computerUseRelay: BindRelay | undefined;

function profilesPath() {
  return appDataPath("profiles.json");
}
function readProfiles(): ConnectionProfile[] {
  try {
    return JSON.parse(fs.readFileSync(profilesPath(), "utf8"));
  } catch {
    return [];
  }
}
function writeProfiles(profiles: ConnectionProfile[]) {
  fs.mkdirSync(path.dirname(profilesPath()), { recursive: true });
  fs.writeFileSync(profilesPath()+".tmp",JSON.stringify(profiles,null,2),{encoding:"utf8",mode:0o600});fs.renameSync(profilesPath()+".tmp",profilesPath());fs.chmodSync(profilesPath(),0o600);
}
function decryptPassword(profile: ConnectionProfile) {
  if (!profile.encryptedPassword || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(profile.encryptedPassword, "base64"));
  } catch {
    return undefined;
  }
}
function connectConfig(payload: ConnectPayload): ConnectConfig {
  const p = payload.profile;
  const cfg: ConnectConfig = {
    host: p.host,
    port: p.port || 22,
    username: p.username,
    readyTimeout: 15_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3
  };
  if (p.authType === "agent") {
    if (process.env.SSH_AUTH_SOCK) cfg.agent = process.env.SSH_AUTH_SOCK;
  } else if (p.authType === "key") {
    if (!p.keyPath) throw new Error("Private key path is required.");
    cfg.privateKey = fs.readFileSync(p.keyPath);
  } else {
    const saved=savedCredentialFor(p,readProfiles());cfg.password=payload.password||(saved?decryptPassword(saved):undefined);
    if (!cfg.password) throw new Error("Password is required.");
  }
  return cfg;
}
function execOn(conn: Client, command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: false }, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      stream.on("data", (d: Buffer) => (stdout += d.toString()));
      stream.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      stream.on("close", (code: number) => resolve({ stdout, stderr, code }));
    });
  });
}
function withSftp<T>(session: RemoteSession, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    session.conn.sftp(async (err, sftp) => {
      if (err) return reject(err);
      try {
        resolve(await fn(sftp));
      } catch (error) {
        reject(error);
      } finally {
        sftp.end();
      }
    });
  });
}
function networkAddresses() {
  const result: Array<{ name: string; address: string; kind: "tailscale" | "lan" | "other" }> = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const info of addrs || []) {
      if (info.family !== "IPv4" || info.internal) continue;
      const octets = info.address.split(".").map(Number);
      const isTailscale = octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
      const isLan =
        octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168);
      result.push({
        name,
        address: info.address,
        kind: isTailscale ? "tailscale" : isLan ? "lan" : "other"
      });
    }
  }
  return result.sort((a, b) => (a.kind === "tailscale" ? -1 : b.kind === "tailscale" ? 1 : 0));
}
function emit(channel: string, payload: unknown) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function transferSnapshot(task: TransferTask) {
  const elapsed = task.startedAt ? Math.max(0.001, (Date.now() - task.startedAt) / 1000) : 0;
  return {
    id: task.id,
    sessionId: task.sessionId,
    direction: task.direction,
    source: task.source,
    target: task.target,
    name: task.name,
    isDirectory: task.isDirectory,
    state: task.state,
    totalBytes: task.totalBytes,
    transferredBytes: task.transferredBytes,
    filesTotal: task.filesTotal,
    filesDone: task.filesDone,
    speedBytesPerSec: elapsed > 0 ? task.transferredBytes / elapsed : 0,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    error: task.error
  };
}

function emitTransfer(task: TransferTask) {
  task.updatedAt = Date.now();
  emit("transfer:event", transferSnapshot(task));
}

function sftpStat(sftp: SFTPWrapper, remotePath: string) {
  return new Promise<any>((resolve, reject) => {
    sftp.stat(remotePath, (err, attrs) => err ? reject(err) : resolve(attrs));
  });
}

function sftpReaddir(sftp: SFTPWrapper, remotePath: string) {
  return new Promise<any[]>((resolve, reject) => {
    sftp.readdir(remotePath, (err, entries) => err ? reject(err) : resolve(entries));
  });
}

function sftpMkdir(sftp: SFTPWrapper, remotePath: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => err ? reject(err) : resolve());
  });
}

async function ensureRemoteDir(sftp: SFTPWrapper, remoteDir: string) {
  if (!remoteDir || remoteDir === "/") return;
  const parts = remoteDir.split("/").filter(Boolean);
  let current = remoteDir.startsWith("/") ? "/" : "";
  for (const part of parts) {
    current = current === "/" ? `/${part}` : current ? `${current}/${part}` : part;
    try {
      const attrs = await sftpStat(sftp, current);
      if (!attrs.isDirectory()) throw new Error(`Remote path exists and is not a directory: ${current}`);
    } catch (error: any) {
      if (error?.code !== 2) throw error;
      await sftpMkdir(sftp, current);
    }
  }
}

async function collectLocalTree(root: string) {
  const files: Array<{ absolute: string; relative: string; size: number }> = [];
  const dirs: string[] = [""];
  const rootStat = await fs.promises.stat(root);
  if (!rootStat.isDirectory()) {
    return { files: [{ absolute: root, relative: path.basename(root), size: rootStat.size }], dirs: [], totalBytes: rootStat.size };
  }
  async function walk(dir: string, relativeDir: string) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(relative);
        await walk(absolute, relative);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const stat = await fs.promises.stat(absolute);
        files.push({ absolute, relative, size: stat.size });
      }
    }
  }
  await walk(root, "");
  return { files, dirs, totalBytes: files.reduce((sum, file) => sum + file.size, 0) };
}

async function collectRemoteTree(sftp: SFTPWrapper, root: string) {
  const files: Array<{ absolute: string; relative: string; size: number }> = [];
  const dirs: string[] = [""];
  const rootAttrs = await sftpStat(sftp, root);
  if (!rootAttrs.isDirectory()) {
    return { files: [{ absolute: root, relative: path.posix.basename(root), size: rootAttrs.size }], dirs: [], totalBytes: rootAttrs.size };
  }
  async function walk(remoteDir: string, relativeDir: string) {
    const entries = await sftpReaddir(sftp, remoteDir);
    for (const entry of entries) {
      if (entry.filename === "." || entry.filename === "..") continue;
      const absolute = path.posix.join(remoteDir, entry.filename);
      const relative = path.posix.join(relativeDir, entry.filename);
      const isDir = (entry.attrs.mode & 0o170000) === 0o040000;
      if (isDir) {
        dirs.push(relative);
        await walk(absolute, relative);
      } else {
        files.push({ absolute, relative, size: entry.attrs.size });
      }
    }
  }
  await walk(root, "");
  return { files, dirs, totalBytes: files.reduce((sum, file) => sum + file.size, 0) };
}

function streamFile(
  task: TransferTask,
  read: NodeJS.ReadableStream & { pause?: () => void; resume?: () => void; destroy?: (error?: Error) => void },
  write: NodeJS.WritableStream & { destroy?: (error?: Error) => void }
) {
  task.activeRead = read;
  task.activeWrite = write;
  return new Promise<void>((resolve, reject) => {
    let lastEmit = 0;
    const cleanup = () => {
      task.activeRead = undefined;
      task.activeWrite = undefined;
    };
    read.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      task.transferredBytes += bytes;
      const now = Date.now();
      if (now - lastEmit > 120) {
        lastEmit = now;
        emitTransfer(task);
      }
      if (task.cancelRequested) {
        read.destroy?.(new Error("Transfer cancelled"));
        write.destroy?.(new Error("Transfer cancelled"));
      }
    });
    read.on("error", (error) => { cleanup(); reject(error); });
    write.on("error", (error) => { cleanup(); reject(error); });
    write.on("finish", () => {
      cleanup();
      resolve();
    });
    read.pipe(write);
  });
}

async function uploadOneFile(task: TransferTask, sftp: SFTPWrapper, localPath: string, remotePath: string, size: number, completedBefore: number) {
  await ensureRemoteDir(sftp, path.posix.dirname(remotePath));
  let existing = -1;
  try {
    const attrs = await sftpStat(sftp, remotePath);
    if (!attrs.isDirectory() && attrs.size <= size) existing = attrs.size;
  } catch {}
  if (existing === size) {
    task.transferredBytes = completedBefore + size;
    return;
  }
  existing = Math.max(0, existing);
  task.transferredBytes = completedBefore + existing;
  const read = fs.createReadStream(localPath, { start: existing });
  const write = sftp.createWriteStream(remotePath, {
    flags: existing > 0 ? "r+" : "w",
    start: existing,
    mode: 0o644
  });
  await streamFile(task, read, write);
}

async function downloadOneFile(task: TransferTask, sftp: SFTPWrapper, remotePath: string, localPath: string, size: number, completedBefore: number) {
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  let existing = 0;
  try {
    const stat = await fs.promises.stat(localPath);
    if (stat.isFile() && stat.size <= size) existing = stat.size;
  } catch {}
  if (existing === size) {
    task.transferredBytes = completedBefore + size;
    return;
  }
  task.transferredBytes = completedBefore + existing;
  const read = sftp.createReadStream(remotePath, { start: existing });
  const write = fs.createWriteStream(localPath, { flags: existing > 0 ? "r+" : "w", start: existing });
  await streamFile(task, read, write);
}

async function runWithRetry(task: TransferTask, operation: () => Promise<void>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (task.cancelRequested) throw new Error("Transfer cancelled");
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (task.cancelRequested) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function runUploadTask(task: TransferTask, session: RemoteSession) {
  task.state = "running";
  task.startedAt = Date.now();
  emitTransfer(task);
  try {
    const tree = await collectLocalTree(task.source);
    task.totalBytes = tree.totalBytes;
    task.filesTotal = tree.files.length;
    const rootStat = await fs.promises.stat(task.source);
    await withSftp(session, async (sftp) => {
      if (rootStat.isDirectory()) {
        await ensureRemoteDir(sftp, task.target);
        for (const dir of tree.dirs) {
          if (task.cancelRequested) throw new Error("Transfer cancelled");
          if (dir) await ensureRemoteDir(sftp, path.posix.join(task.target, dir.split(path.sep).join("/")));
        }
        let completedBytes = 0;
        for (const file of tree.files) {
          if (task.cancelRequested) throw new Error("Transfer cancelled");
          const remote = path.posix.join(task.target, file.relative.split(path.sep).join("/"));
          await runWithRetry(task, () => uploadOneFile(task, sftp, file.absolute, remote, file.size, completedBytes));
          completedBytes += file.size;
          task.transferredBytes = completedBytes;
          task.filesDone += 1;
          emitTransfer(task);
        }
      } else {
        await runWithRetry(task, () => uploadOneFile(task, sftp, task.source, task.target, tree.totalBytes, 0));
        task.filesDone = 1;
      }
    });
    task.state = "completed";
    task.transferredBytes = task.totalBytes;
  } catch (error: any) {
    task.state = task.cancelRequested ? "cancelled" : "error";
    task.error = error?.message || String(error);
  }
  emitTransfer(task);
}

async function runDownloadTask(task: TransferTask, session: RemoteSession) {
  task.state = "running";
  task.startedAt = Date.now();
  emitTransfer(task);
  try {
    await withSftp(session, async (sftp) => {
      const tree = await collectRemoteTree(sftp, task.source);
      task.totalBytes = tree.totalBytes;
      task.filesTotal = tree.files.length;
      const rootAttrs = await sftpStat(sftp, task.source);
      if (rootAttrs.isDirectory()) {
        await fs.promises.mkdir(task.target, { recursive: true });
        for (const dir of tree.dirs) {
          if (task.cancelRequested) throw new Error("Transfer cancelled");
          if (dir) await fs.promises.mkdir(path.join(task.target, ...dir.split("/")), { recursive: true });
        }
        let completedBytes = 0;
        for (const file of tree.files) {
          if (task.cancelRequested) throw new Error("Transfer cancelled");
          const local = path.join(task.target, ...file.relative.split("/"));
          await runWithRetry(task, () => downloadOneFile(task, sftp, file.absolute, local, file.size, completedBytes));
          completedBytes += file.size;
          task.transferredBytes = completedBytes;
          task.filesDone += 1;
          emitTransfer(task);
        }
      } else {
        await runWithRetry(task, () => downloadOneFile(task, sftp, task.source, task.target, tree.totalBytes, 0));
        task.filesDone = 1;
      }
    });
    task.state = "completed";
    task.transferredBytes = task.totalBytes;
  } catch (error: any) {
    task.state = task.cancelRequested ? "cancelled" : "error";
    task.error = error?.message || String(error);
  }
  emitTransfer(task);
}

function createTransferTask(input: Omit<TransferTask, "id" | "state" | "totalBytes" | "transferredBytes" | "filesTotal" | "filesDone" | "updatedAt" | "cancelRequested">) {
  const task: TransferTask = {
    ...input,
    id: randomUUID(),
    state: "queued",
    totalBytes: 0,
    transferredBytes: 0,
    filesTotal: 0,
    filesDone: 0,
    updatedAt: Date.now(),
    cancelRequested: false
  };
  transfers.set(task.id, task);
  emitTransfer(task);
  return task;
}

function addServiceLog(service: ManagedService, chunk: string) {
  const lines = chunk.replace(/\r/g, "").split("\n").filter(Boolean);
  service.logs.push(...lines);
  if (service.logs.length > 300) service.logs.splice(0, service.logs.length - 300);
  emit("service:event", {
    name: service.name,
    status: service.status,
    logs: service.logs.slice(-80)
  });
}

function computerUseBinary(name = "claudex-computer-use") {
  return app.isPackaged
    ? path.join(process.resourcesPath, "computer-use", name)
    : path.join(app.getAppPath(), "vendor", "open-codex-computer-use", ".build", "release", name);
}

function bundledModulePath(...parts: string[]) {
  return path.join(app.getAppPath(), "node_modules", ...parts);
}

function bundledBrowserArgs() {
  return browserRuntimeArgs(app.isPackaged ? path.join(process.resourcesPath, 'browser') : path.join(app.getAppPath(), 'build/runtime-browsers'));
}

function startManagedProcess(
  name: string,
  executable: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
) {
  const current = services.get(name);
  if (current?.child && !current.child.killed) return current;

  const printable = [executable, ...args].map((part) => JSON.stringify(part)).join(" ");
  const service: ManagedService = { name, command: printable, status: "starting", logs: [] };
  services.set(name, service);

  const child = spawn(executable, args, {
    env: { ...process.env, ...extraEnv, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"], detached:process.platform!=="win32"
  });
  service.child = child;
  child.stdout.on("data", (d) => addServiceLog(service, d.toString()));
  child.stderr.on("data", (d) => addServiceLog(service, d.toString()));
  child.once("spawn", () => {
    service.status = "running";
    emit("service:event", { name, status: service.status, logs: service.logs });
  });
  child.once("error", (err) => {
    service.status = "error";
    addServiceLog(service, err.message);
  });
  child.once("exit", (code) => {
    service.status = code === 0 ? "stopped" : "error";
    addServiceLog(service, `process exited with code ${code}`);
    service.child = undefined;
  });
  return service;
}

async function captureProcess(executable: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn(executable, args, {
      env: { ...process.env, ...extraEnv, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.on("error", (error) => resolve({ stdout, stderr: stderr + error.message, code: -1 }));
  });
}

function startManagedService(name: string, command: string) {
  const current = services.get(name);
  if (current?.child && !current.child.killed) return current;
  const service: ManagedService = { name, command, status: "starting", logs: [] };
  services.set(name, service);
  const child = spawn("/bin/zsh", ["-lc", command], {
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  service.child = child;
  child.stdout.on("data", (d) => addServiceLog(service, d.toString()));
  child.stderr.on("data", (d) => addServiceLog(service, d.toString()));
  child.once("spawn", () => {
    service.status = "running";
    emit("service:event", { name, status: service.status, logs: service.logs });
  });
  child.once("error", (err) => {
    service.status = "error";
    addServiceLog(service, err.message);
  });
  child.once("exit", (code) => {
    service.status = code === 0 ? "stopped" : "error";
    addServiceLog(service, `process exited with code ${code}`);
    service.child = undefined;
  });
  return service;
}
async function stopManagedService(name: string) {
  const service=services.get(name);const child=service?.child;if(!service||!child)return;
  service.health=undefined;
  const signal=(value:NodeJS.Signals)=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,value);else child.kill(value);}catch{}};
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));signal('SIGTERM');
  let timer:NodeJS.Timeout|undefined;
  await Promise.race([exited,new Promise<void>(resolve=>{timer=setTimeout(()=>{signal('SIGKILL');resolve();},2500);})]);
  clearTimeout(timer);
  if(!service.child||service.child===child){service.child=undefined;service.status='stopped';}
  emit('service:event',{name,status:service.status,logs:service.logs,url:service.url});
}

function startOAuthForward(session: RemoteSession, port: number) {
  if (session.oauthServers.has(port)) return;
  const server = net.createServer((localSocket) => {
    session.conn.forwardOut(
      localSocket.localAddress || "127.0.0.1",
      localSocket.localPort || 0,
      "127.0.0.1",
      port,
      (err, remoteStream) => {
        if (err) {
          localSocket.destroy(err);
          return;
        }
        localSocket.pipe(remoteStream).pipe(localSocket);
      }
    );
  });
  server.on("error", (err) => {
    emit("toast", { tone: "error", message: `OAuth forward :${port} failed: ${err.message}` });
  });
  server.listen(port, "127.0.0.1");
  session.oauthServers.set(port, server);
}
function stopSession(session: RemoteSession) {
  cancelSessionChats(session.id, desktopDependencies);
  try { session.shell?.close(); } catch {}
  for (const server of session.oauthServers.values()) {
    try { server.close(); } catch {}
  }
  try { session.conn.end(); } catch {}
  sessions.delete(session.id);
}
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0d0e10",
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  if (process.env.AGENTBRIDGE_DEV_URL) {
    await mainWindow.loadURL(process.env.AGENTBRIDGE_DEV_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../dist-renderer/index.html"));
  }
}

if (primaryInstance) app.whenReady().then(createWindow);
app.on("activate", () => { if (primaryInstance && BrowserWindow.getAllWindows().length === 0) void createWindow(); });
app.on("before-quit",()=>{void standaloneHealth?.stop();});
app.on("window-all-closed", () => {
  stopMacMcpLogin();
  stopAllRuntimes(runtimeDependencies);
  void stopAllClaudeLocalRuntimes();
  void standaloneHealth?.stop();
  for (const session of sessions.values()) stopSession(session);
  for (const name of services.keys()) stopManagedService(name);
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("profiles:list", () => readProfiles().map(publicProfile));
ipcMain.handle("profiles:save", (_event, incoming: ConnectionProfile & { password?: string }) => {
  const profiles=readProfiles(),index=profiles.findIndex(profile=>profile.id===incoming.id);
  const profile=saveCredentialProfile(incoming,index>=0?profiles[index]:undefined,value=>safeStorage.encryptString(value).toString("base64"),safeStorage.isEncryptionAvailable());
  if(index>=0)profiles[index]=profile;else profiles.unshift(profile);writeProfiles(profiles);return profiles.map(publicProfile);
});
ipcMain.handle("profiles:delete", (_event,id:string)=>{const profiles=readProfiles().filter(profile=>profile.id!==id);writeProfiles(profiles);return profiles.map(publicProfile);});

ipcMain.handle("ssh:connect", async (_event, payload: ConnectPayload) => {
  const conn = new Client();
  conn.on("error", () => {});
  const id = randomUUID();
  const cfg = connectConfig(payload);
  const result = await new Promise<{ remoteHome: string; system: string }>((resolve, reject) => {
    conn.once("ready", async () => {
      try {
        const home = await execOn(conn, 'printf "%s" "$HOME"');
        const sys = await execOn(conn, 'uname -srm 2>/dev/null || cmd /c ver');
        resolve({ remoteHome: home.stdout.trim() || ".", system: sys.stdout.trim() || sys.stderr.trim() });
      } catch (err) {
        reject(err);
      }
    });
    conn.once("error", reject);
    conn.connect(cfg);
  });
  const session: RemoteSession = {
    id,
    conn,
    profile: payload.profile,
    remoteHome: result.remoteHome,
    oauthServers: new Map()
  };
  sessions.set(id, session);
  conn.on("error", (error) => emit("toast", { tone: "error", message: error.message }));
  conn.on("close", () => {
    cancelSessionChats(id, desktopDependencies);
    sessions.delete(id);
    emit("ssh:closed", { sessionId: id });
  });
  try { startOAuthForward(session, OAUTH_DEFAULT_PORT); } catch {}
  return { sessionId: id, remoteHome: result.remoteHome, system: result.system };
});
ipcMain.handle("ssh:disconnect", (_event, sessionId: string) => {
  const session = sessions.get(sessionId);
  if (session) stopSession(session);
});
ipcMain.handle("ssh:exec", async (_event, sessionId: string, command: string) => {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("SSH session is not connected.");
  return execOn(session.conn, command);
});

ipcMain.handle("terminal:start", async (_event, sessionId: string, initialCommand?: string) => {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("SSH session is not connected.");
  if (session.shell) {
    try { session.shell.close(); } catch {}
  }
  await new Promise<void>((resolve, reject) => {
    session.conn.shell({ term: "xterm-256color", cols: 140, rows: 40 }, (err, stream) => {
      if (err) return reject(err);
      session.shell = stream;
      stream.on("data", (data: Buffer) => emit("terminal:data", { sessionId, data: data.toString("utf8") }));
      stream.stderr.on("data", (data: Buffer) => emit("terminal:data", { sessionId, data: data.toString("utf8") }));
      stream.on("close", () => emit("terminal:closed", { sessionId }));
      if (initialCommand) stream.write(initialCommand + "\n");
      resolve();
    });
  });
});
ipcMain.handle("terminal:input", (_event, sessionId: string, data: string) => {
  sessions.get(sessionId)?.shell?.write(data);
});
ipcMain.handle("terminal:resize", (_event, sessionId: string, cols: number, rows: number) => {
  sessions.get(sessionId)?.shell?.setWindow(rows, cols, 0, 0);
});
ipcMain.handle("oauth:forward", (_event, sessionId: string, port: number) => {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("SSH session is not connected.");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Port must be an integer between 1024 and 65535 (got ${port}).`);
  }
  startOAuthForward(session, port);
  return { port };
});

ipcMain.handle("files:list", async (_event, sessionId: string, remotePath?: string) => {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("SSH session is not connected.");
  const target = remotePath || session.remoteHome;
  return withSftp(session, (sftp) => new Promise((resolve, reject) => {
    sftp.readdir(target, (err, list) => {
      if (err) return reject(err);
      resolve(list.map((entry) => ({
        name: entry.filename,
        path: path.posix.join(target, entry.filename),
        size: entry.attrs.size,
        modified: entry.attrs.mtime * 1000,
        isDirectory: (entry.attrs.mode & 0o170000) === 0o040000
      })).filter((entry) => entry.name !== "." && entry.name !== ".."));
    });
  }));
});
ipcMain.handle("files:upload", async (_event, sessionId: string, remoteDir: string) => {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("SSH session is not connected.");
  const chosen = await dialog.showOpenDialog(mainWindow!, {
    title: "Upload files to remote",
    properties: ["openFile", "multiSelections", "showHiddenFiles"]
  });
  if (chosen.canceled) return [];
  const tasks = chosen.filePaths.map((localPath) => createTransferTask({
    sessionId,
    direction: "upload",
    source: localPath,
    target: path.posix.join(remoteDir, path.basename(localPath)),
    name: path.basename(localPath),
    isDirectory: false
  }));
  for (const task of tasks) void runUploadTask(task, session);
  return tasks.map(transferSnapshot);
});

ipcMain.handle("files:uploadFolder", async (_event, sessionId: string, remoteDir: string) => {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("SSH session is not connected.");
  const chosen = await dialog.showOpenDialog(mainWindow!, {
    title: "Upload folder to remote",
    properties: ["openDirectory", "showHiddenFiles", "createDirectory"]
  });
  if (chosen.canceled || !chosen.filePaths[0]) return [];
  const localPath = chosen.filePaths[0];
  const task = createTransferTask({
    sessionId,
    direction: "upload",
    source: localPath,
    target: path.posix.join(remoteDir, path.basename(localPath)),
    name: path.basename(localPath),
    isDirectory: true
  });
  void runUploadTask(task, session);
  return [transferSnapshot(task)];
});

ipcMain.handle("files:uploadPaths", async (_event, sessionId: string, remoteDir: string, localPaths: string[]) => {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("SSH session is not connected.");
  const tasks: TransferTask[] = [];
  for (const localPath of localPaths) {
    const stat = await fs.promises.stat(localPath);
    const task = createTransferTask({
      sessionId,
      direction: "upload",
      source: localPath,
      target: path.posix.join(remoteDir, path.basename(localPath)),
      name: path.basename(localPath),
      isDirectory: stat.isDirectory()
    });
    tasks.push(task);
    void runUploadTask(task, session);
  }
  return tasks.map(transferSnapshot);
});

ipcMain.handle("files:download", async (_event, sessionId: string, remotePath: string) => {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("SSH session is not connected.");
  const chosen = await dialog.showOpenDialog(mainWindow!, {
    title: "Choose download folder",
    properties: ["openDirectory", "createDirectory"]
  });
  if (chosen.canceled || !chosen.filePaths[0]) return null;
  const remoteInfo = await withSftp(session, (sftp) => sftpStat(sftp, remotePath));
  const isDirectory = remoteInfo.isDirectory();
  const localPath = path.join(chosen.filePaths[0], path.posix.basename(remotePath));
  const task = createTransferTask({
    sessionId,
    direction: "download",
    source: remotePath,
    target: localPath,
    name: path.posix.basename(remotePath),
    isDirectory
  });
  void runDownloadTask(task, session);
  return transferSnapshot(task);
});

ipcMain.handle("files:transfers", (_event, sessionId?: string) => {
  return Array.from(transfers.values())
    .filter((task) => !sessionId || task.sessionId === sessionId)
    .map(transferSnapshot)
    .sort((a, b) => b.updatedAt - a.updatedAt);
});

ipcMain.handle("files:transferControl", (_event, transferId: string, action: "pause" | "resume" | "cancel" | "clear" | "retry") => {
  const task = transfers.get(transferId);
  if (!task) return null;
  if (action === "pause" && task.state === "running") {
    task.state = "paused";
    task.activeRead?.pause?.();
  } else if (action === "resume" && task.state === "paused") {
    task.state = "running";
    task.activeRead?.resume?.();
  } else if (action === "cancel" && ["queued", "running", "paused"].includes(task.state)) {
    task.cancelRequested = true;
    task.state = "cancelled";
    task.activeRead?.destroy?.(new Error("Transfer cancelled"));
    task.activeWrite?.destroy?.(new Error("Transfer cancelled"));
  } else if (action === "retry" && ["error", "cancelled"].includes(task.state)) {
    // Resume from whatever is already on disk. `uploadOneFile` /
    // `downloadOneFile` both size the existing partial file and continue from
    // its length, so a retry never re-sends bytes that already arrived.
    const session = sessions.get(task.sessionId);
    if (!session) return null;
    task.state = "queued";
    task.error = undefined;
    task.cancelRequested = false;
    task.filesDone = 0;
    void (task.direction === "upload" ? runUploadTask(task, session) : runDownloadTask(task, session));
    return transferSnapshot(task);
  } else if (action === "clear" && ["completed", "error", "cancelled"].includes(task.state)) {
    transfers.delete(task.id);
    emit("transfer:removed", { id: task.id });
    return null;
  }
  emitTransfer(task);
  return transferSnapshot(task);
});
ipcMain.handle("dialog:chooseKey", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Choose SSH private key",
    properties: ["openFile"],
    defaultPath: path.join(os.homedir(), ".ssh")
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("local:network", () => networkAddresses());

type CheckState = "ok" | "warn" | "fail" | "unknown";
interface DoctorCheck {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
  hint?: string;
}

function probePort(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.on("error", () => done(false));
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(600, () => done(false));
    socket.once("connect", () => done(true));
  });
}

let computerProviders:ComputerProviderStore|undefined;
function computerProvider(){return computerProviders||=new ComputerProviderStore(appDataPath('computer-provider.json'),computerUseBinary(),os.homedir());}
let providerChanging=false;const serviceStarting=new Set<string>();
function selectedComputerCommand(){if(providerChanging)throw new Error('工具來源正在切換，請稍後重新連接。');return computerProvider().command();}
let standaloneHealth:StandaloneToolHealth|undefined;
ipcMain.handle('local:computerProvider',()=>computerProvider().status());
ipcMain.handle('local:selectComputerProvider',async(_event,value:unknown)=>{
  if(providerChanging||serviceStarting.size||hasLiveLocalToolHosts()||['computer','browser'].some(name=>!!services.get(name)?.child))throw new Error('請先中斷模型 Runtime 並停止 HTTP 服務，再切換工具來源。');
  providerChanging=true;try{await standaloneHealth?.stop();standaloneHealth=undefined;if(hasLiveLocalToolHosts())throw new Error('模型工具正在連線，請先中斷 Runtime。');return computerProvider().select(value);}finally{providerChanging=false;}
});
function localHealth(){return standaloneHealth||=new StandaloneToolHealth({native:selectedComputerCommand(),browser:{command:process.execPath,args:[bundledModulePath('@playwright','mcp','cli.js'),...bundledBrowserArgs(),'--caps','vision,pdf,devtools','--snapshot-boxes','--user-data-dir',appDataPath('tool-health-browser-profile'),'--output-dir',appDataPath('tool-health-browser-output')],env:{ELECTRON_RUN_AS_NODE:'1'}}});}
ipcMain.handle('local:permissionDiagnostics',async()=>{
  const appPermissions={accessibility:systemPreferences.isTrustedAccessibilityClient(false),screenRecording:systemPreferences.getMediaAccessStatus('screen')};
  const command=selectedComputerCommand();
  const detached=await probeNativePermissions({...command,detached:true});const attached=await probeNativePermissions({...command,detached:false});
  return {app:appPermissions,detached:{...nativePermissions(detached),process:detached.diagnosticProcess},attached:{...nativePermissions(attached),process:attached.diagnosticProcess}};
});
ipcMain.handle('local:requestPermissions',()=>probeNativePermissions(selectedComputerCommand(),true));
ipcMain.handle('local:stopToolHealth',()=>standaloneHealth?.stop());
ipcMain.handle("local:toolHealth",async(_event,target:any={})=>{
  if(target.runtimeId){await standaloneHealth?.stop();if(!['codex','claude'].includes(target.provider))throw new Error('Runtime 類型無效。');return target.provider==='claude'?claudeToolHealth(target.runtimeId):codexToolHealth(target.runtimeId);}
  if(target.reset)await standaloneHealth?.stop();return localHealth().health();
});
ipcMain.handle("local:doctor", async (_event,target:any={}) => {
  const selected=computerProvider().status();
  const nativeServer = selected.command;
  const nativeCli = computerUseBinary("claudex-computer-use-cli");
  const overlay = computerUseBinary("claudex-computer-use-overlay-helper");
  const gateway = bundledModulePath("supergateway", "dist", "index.js");
  const playwright = bundledModulePath("@playwright", "mcp", "cli.js");

  let report:any;let raw='';
  try {
    if(target.runtimeId)await standaloneHealth?.stop();
    report=target.runtimeId?(target.provider==='claude'?await claudeComputerDiagnostics(target.runtimeId):await codexComputerDiagnostics(target.runtimeId)):await standaloneHealth?.doctor()||await probeNativePermissions(selectedComputerCommand());
    if(!report)throw new Error('Runtime 電腦工具尚未接通。');
    raw=(report.source==='open-computer-use'?'來源：Open Computer Use；應用程式清單已可讀取；此來源不回報權限。 ':selected.label+'。 ')+(target.runtimeId?'權限來源：目前 Runtime 的原生 MCP 工具':'權限來源：這台 Mac 的原生 MCP 工具（獨立診斷）');
  }catch{raw='原生 MCP 權限檢查失敗；請重新連接工具後更新狀態。';}
  const permissions=nativePermissions(report);
  const permissionCheck = (
    id: string,
    label: string,
    value: boolean | undefined,
    hint: string
  ): DoctorCheck => ({
    id,
    label,
    state: value === undefined ? "unknown" : value ? "ok" : "fail",
    detail: value === undefined ? "所選工具未回報權限；請以實際操作檢查" : value ? "已授權" : "此工具程序尚未獲授權；系統清單中的既有項目可能使用不同身分",
    hint: value === false ? hint : undefined
  });

  const checks: DoctorCheck[] = [
    {
      id: "computer_use_server",
      label: selected.label,
      state: fs.existsSync(nativeServer) ? "ok" : "fail",
      detail: fs.existsSync(nativeServer) ? nativeServer : "missing",
      hint: fs.existsSync(nativeServer) ? undefined : "執行 npm run build:computer-use 後重新封裝。"
    },
    {
      id: "computer_use_cli",
      label: "Computer Use CLI",
      state: fs.existsSync(nativeCli) ? "ok" : "fail",
      detail: fs.existsSync(nativeCli) ? nativeCli : "missing"
    },
    {
      id: "overlay_helper",
      label: "Overlay helper",
      state: fs.existsSync(overlay) ? "ok" : "warn",
      detail: fs.existsSync(overlay) ? overlay : "missing",
      hint: fs.existsSync(overlay) ? undefined : "缺少時 virtual cursor 疊層不會顯示，其餘功能仍可用。"
    },
    {
      id: "supergateway",
      label: "Supergateway",
      state: fs.existsSync(gateway) ? "ok" : "fail",
      detail: fs.existsSync(gateway) ? gateway : "missing"
    },
    {
      id: "playwright_mcp",
      label: "Playwright MCP",
      state: fs.existsSync(playwright) ? "ok" : "fail",
      detail: fs.existsSync(playwright) ? playwright : "missing"
    },
    permissionCheck(
      "accessibility",
      "輔助使用權限",
      permissions.accessibility,
      "在系統設定的隱私權與安全性，開啟 AgentBridge Studio 的裝置控制和資料取用／輔助使用權限；若已開啟，重新啟動 App 後更新狀態。"
    ),
    permissionCheck(
      "screen_recording",
      "螢幕錄製權限",
      permissions.screenRecording,
      "在系統設定的隱私權與安全性，開啟 AgentBridge Studio 的螢幕與系統錄音／螢幕錄製權限；若已開啟，重新啟動 App 後更新狀態。"
    )
  ];

  for (const [id, label, port, serviceName] of [
    ["computer_listener", "Computer Use HTTP 端點（選用）", COMPUTER_USE_PORT, "computer"],
    ["browser_listener", "Browser Use HTTP 端點（選用）", BROWSER_USE_PORT, "browser"]
  ] as const) {
    const service=services.get(serviceName);
    const healthy=service?.health?.ok&&service.status==='running'&&Date.now()-service.health.checkedAt<60_000;
    const listening = service?.url?await probePort(port,new URL(service.url).hostname):false;
    const running = services.get(serviceName)?.status === "running";
    checks.push({
      id,
      label,
      state: healthy&&listening ? "ok" : running ? "unknown" : "warn",
      detail: healthy&&listening ? `${service!.url} · MCP 握手、${service!.health.probe} 成功` : running ? "服務執行中；請檢查 HTTP 工具確認可呼叫" : "尚未啟動；Runtime 使用獨立工具通道",
      hint: !listening && running ? "查看該服務的日誌以找出啟動失敗的原因。" : undefined
    });
  }

  const exposure = currentExposure();
  checks.push({
    id: "exposure",
    label: "曝光模式",
    state: exposure.bindHost === "0.0.0.0" ? "warn" : "ok",
    detail: `${exposure.mode} · 綁定 ${exposure.bindHost}`,
    hint: exposure.bindHost === "0.0.0.0" ? "Computer Use MCP 沒有驗證。建議改用 Tailscale 模式。" : undefined
  });

  return { checks, raw };
});
ipcMain.handle("local:installEngines", async () => {
  const nativeServer = computerUseBinary();
  const gateway = bundledModulePath("supergateway", "dist", "index.js");
  const playwright = bundledModulePath("@playwright", "mcp", "cli.js");
  return {
    status: fs.existsSync(nativeServer) && fs.existsSync(gateway) && fs.existsSync(playwright) ? "ready" : "missing"
  };
});
ipcMain.handle("service:start", async (_event, name: "computer" | "browser") => {
  if(serviceStarting.has(name))throw new Error("HTTP 工具正在啟動，請稍候。");
  serviceStarting.add(name);try{
  if(!['computer','browser'].includes(name))throw new Error('HTTP 工具名稱無效。');
  const exposure = currentExposure();requirePrivateHttpBinding(exposure.mode,exposure.bindHost);
  if(providerChanging)throw new Error('工具來源正在切換，請稍後啟動服務。');
  if(['running','starting'].includes(services.get(name)?.status||''))return await serviceHealth(name);
  if (name === "computer") {
    const nativeCommand = selectedComputerCommand();
    const nativeServer=nativeCommand.command;
    const gateway = bundledModulePath("supergateway", "dist", "index.js");
    if (!fs.existsSync(nativeServer)) throw new Error(`Bundled Computer Use server not found: ${nativeServer}`);
    if (!fs.existsSync(gateway)) throw new Error(`Bundled Supergateway not found: ${gateway}`);

    // A child-only preload constrains Supergateway's hostless listen() to
    // loopback and a relay fronts it on exactly the chosen address.
    const loopbackPort = COMPUTER_USE_PORT === 8932 ? 8933 : COMPUTER_USE_PORT;
    if(await probePort(loopbackPort))throw new Error("電腦 HTTP 內部連接埠已被其他服務使用；未停止其他程序。");
    if (exposure.bindHost !== "0.0.0.0") {
      if(await probePort(COMPUTER_USE_PORT,exposure.bindHost))throw new Error('電腦 HTTP 連接埠已被其他服務使用；未停止其他程序。');
      computerUseRelay?.stop();
      computerUseRelay = new BindRelay(exposure.bindHost, COMPUTER_USE_PORT, loopbackPort, true);
      const result = await computerUseRelay.start();
      if (!result.ok) {
        computerUseRelay = undefined;
        throw new Error(`無法在 ${exposure.bindHost}:${COMPUTER_USE_PORT} 綁定：${result.reason}`);
      }
    } else {
      computerUseRelay?.stop();
      computerUseRelay = undefined;
    }

    const service = startManagedProcess(
      "computer",
      process.execPath,
      [
        "--require",path.join(app.getAppPath(),"dist-main","gateway-loopback.js"),gateway,
        "--stdio", [nativeServer,...(nativeCommand.args||[])].map(shellQuote).join(" "),
        "--outputTransport", "streamableHttp",
        "--stateful",
        "--sessionTimeout", "600000",
        "--port", String(loopbackPort),
        "--streamableHttpPath", "/mcp",
        "--healthEndpoint", "/healthz",
        "--logLevel", "info"
      ],
      { ELECTRON_RUN_AS_NODE: "1" }
    );
    service.url=`http://${exposure.bindHost}:${COMPUTER_USE_PORT}/mcp`;service.computerProvider=nativeCommand.computerProvider;
    return await waitForServiceHealth("computer");
  }

  if(await probePort(BROWSER_USE_PORT,exposure.bindHost))throw new Error("瀏覽器 HTTP 連接埠已被其他服務使用；未停止其他程序。");
  const playwright = bundledModulePath("@playwright", "mcp", "cli.js");
  if (!fs.existsSync(playwright)) throw new Error(`Bundled Playwright MCP not found: ${playwright}`);
  // `--allowed-hosts` must not stay a wildcard: the header check is the only
  // thing standing between this server and a DNS-rebinding attack.
  const allowedHosts = browserHttpAllowedHosts(exposure.advertiseHost,BROWSER_USE_PORT,
    networkAddresses().map((a) => a.address));
  const service = startManagedProcess(
    "browser",
    process.execPath,
    [
      playwright,
      "--host", exposure.bindHost,
      "--port", String(BROWSER_USE_PORT),
      "--allowed-hosts", allowedHosts,
      ...bundledBrowserArgs(),
      "--caps", "vision,pdf,devtools",
      "--snapshot-boxes",
      "--shared-browser-context",
        "--user-data-dir", appDataPath("playwright-profile"),
      "--output-dir", appDataPath("playwright-output")
    ],
    { ELECTRON_RUN_AS_NODE: "1" }
  );
  service.url=`http://${exposure.bindHost}:${BROWSER_USE_PORT}/mcp`;
  return await waitForServiceHealth("browser");
  }finally{serviceStarting.delete(name);}
});
async function serviceHealth(name:'computer'|'browser'){
  const service=services.get(name);if(!service?.url||service.status!=='running')throw new Error('HTTP 工具尚未啟動。');
  try{const health=await httpToolHealth(service.url,name,service.computerProvider);if(services.get(name)!==service||service.status!=='running')throw new Error('HTTP 工具已停止，檢查結果已作廢。');service.health=health;return {name,status:service.status,url:service.url,health:service.health};}
  catch(error){service.health=undefined;throw error;}
}
async function waitForServiceHealth(name:'computer'|'browser'){
  let error:unknown;for(let attempt=0;attempt<8;attempt++){
    try{return await serviceHealth(name);}catch(e){error=e;if(services.get(name)?.status==='error')break;await new Promise(resolve=>setTimeout(resolve,400));}
  }
  await stopManagedService(name);if(name==='computer'){computerUseRelay?.stop();computerUseRelay=undefined;}
  throw new Error('HTTP 工具握手或唯讀檢查失敗：'+(error instanceof Error?error.message:String(error)));
}
ipcMain.handle('service:health',(_event,name:'computer'|'browser')=>{if(!['computer','browser'].includes(name))throw new Error('HTTP 工具名稱無效。');return serviceHealth(name);});
ipcMain.handle("service:stop", async (_event, name: string) => {
  if(!["computer","browser"].includes(name))throw new Error("HTTP 工具名稱無效。");
  await stopManagedService(name);
  if (name === "computer") {
    computerUseRelay?.stop();
    computerUseRelay = undefined;
  }
  return { name, status: "stopped" };
});
ipcMain.handle("service:status", () => Array.from(services.values()).map((s) => ({
  name: s.name,
  status: s.status,
  logs: s.logs.slice(-80),url:s.url,computerProvider:s.computerProvider,health:s.health&&Date.now()-s.health.checkedAt<60_000?s.health:undefined
})));

ipcMain.handle("exposure:get", () => currentExposure());
ipcMain.handle("exposure:set", async (_event, mode: ExposureMode) => {
  const next = writeExposure(exposurePath(), mode);
  exposureCache = next;
  if (next.note) emit("toast", { tone: "warning", message: next.note });
  // The bind address is fixed at spawn time, so a change only takes effect on
  // the next start. Say so rather than letting the UI imply it is live.
  if (next.bindHost !== "0.0.0.0" && next.bindHost !== "127.0.0.1") {
    if (!fs.existsSync(computerUseBinary())) emit("toast", { tone: "info", message: "曝光模式已儲存，重新啟動服務後套用。" });
  } else {
    emit("toast", { tone: "info", message: "曝光模式已儲存，重新啟動服務後套用。" });
  }
  return next;
});

ipcMain.handle("oauth:forwards", (_event, sessionId: string) => {
  const session = sessions.get(sessionId);
  if (!session) return [];
  return Array.from(session.oauthServers.keys()).sort((a, b) => a - b);
});
ipcMain.handle("oauth:close", (_event, sessionId: string, port: number) => {
  const session = sessions.get(sessionId);
  const server = session?.oauthServers.get(port);
  if (!server) return { port, closed: false };
  server.close();
  session?.oauthServers.delete(port);
  return { port, closed: true };
});

ipcMain.handle("remote:configureMcp", async (_event, sessionId: string, host: string) => {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("SSH session is not connected.");
  const safeHost = host.replace(/[^a-zA-Z0-9.:-]/g, "");
  const script = `
set +e
echo "== Codex =="
if command -v codex >/dev/null 2>&1; then
  codex mcp remove my-mac-computer >/dev/null 2>&1 || true
  codex mcp remove my-mac-browser >/dev/null 2>&1 || true
  codex mcp add my-mac-computer --url http://${safeHost}:8932/mcp
  codex mcp add my-mac-browser --url http://${safeHost}:8931/mcp
  codex mcp list
else
  echo "codex:not-installed"
fi
echo "== Claude =="
if command -v claude >/dev/null 2>&1; then
  claude mcp remove my-mac-computer --scope user >/dev/null 2>&1 || true
  claude mcp remove my-mac-browser --scope user >/dev/null 2>&1 || true
  claude mcp add --transport http --scope user my-mac-computer http://${safeHost}:8932/mcp
  claude mcp add --transport http --scope user my-mac-browser http://${safeHost}:8931/mcp
  claude mcp list
else
  echo "claude:not-installed"
fi
`;
  return execOn(session.conn, script);
});
ipcMain.handle("remote:extensions", async (_event, sessionId: string) => {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("SSH session is not connected.");
  return execOn(session.conn, `python3 -c ${shellQuote(remoteExtensionScript)}`);
});
ipcMain.handle("system:openExternal", (_event, url: string) => shell.openExternal(url));
ipcMain.handle("system:reveal", (_event, targetPath: string) => shell.showItemInFolder(targetPath));

const desktopDependencies = {
  session: (id: string) => sessions.get(id),
  window: () => mainWindow,
  emit,
  upload: async (remoteSession: { id: string }, localPath: string, remotePath: string, signal?: AbortSignal) => {
    const session = sessions.get(remoteSession.id);
    if (!session) throw new Error("遠端連線已中斷。");
    if (signal?.aborted) throw new Error("已停止上傳。");
    await withSftp(session, (sftp) => ensureRemoteDir(sftp, path.posix.dirname(remotePath)));
    const task = createTransferTask({ sessionId: session.id, direction: "upload", source: localPath, target: remotePath, name: path.basename(localPath), isDirectory: false });
    const cancel = () => {
      task.cancelRequested = true;
      task.activeRead?.destroy?.(new Error("已停止上傳。"));
      task.activeWrite?.destroy?.(new Error("已停止上傳。"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      await runUploadTask(task, session);
      if (task.state !== "completed") throw new Error(task.error || "附件未完成上傳。");
    } finally { signal?.removeEventListener("abort", cancel); }
  }
};
registerDesktopBackend(desktopDependencies);

const macMcpCodec={available:()=>safeStorage.isEncryptionAvailable(),encrypt:(value:string)=>safeStorage.encryptString(value).toString('base64'),decrypt:(value:string)=>safeStorage.decryptString(Buffer.from(value,'base64'))};
function macMcpAuthFile(){return appDataPath('mac-mcp-auth.json');}
ipcMain.handle('extensions:loginMcp',async(_event,id:string)=>{
  const discovery=await discoverMacCodexServers();const spec=discovery.servers.find(item=>item.id===id&&item.transport==='http');
  if(!spec?.url)throw new Error('找不到可在 Mac 登入的 MCP 設定。');
  return beginMacMcpLogin({file:macMcpAuthFile(),url:spec.url,codec:macMcpCodec,open:url=>shell.openExternal(url),notify:message=>emit('toast',{message})});
});
const runtimeDependencies = {
  connectConfig, emit, window: () => mainWindow,
  extensions: async (cwd:string) => {
    const catalog=await localExtensions({cwd,agent:"codex"});
    const discovery=await discoverMacCodexServers({cwd});
    for(const state of discovery.statuses){const item=catalog.items.find(item=>item.id===state.id);if(item){item.status=state.status as any;item.enabled=state.status!=="disabled";}}
    return {items:catalog.items.map(item=>({...item,enabled:item.enabled===true,executionLocation:"local" as const})),warnings:catalog.warnings};
  },
  readOnlyExtensionRoots: [path.join(os.homedir(),".agents/skills"),path.join(process.env.CODEX_HOME||path.join(os.homedir(),".codex"),"skills"),path.join(process.env.CODEX_HOME||path.join(os.homedir(),".codex"),"plugins/cache")].filter(root=>fs.existsSync(root)),
  extensionServers: async(cwd:string)=>{
    const discovery=await discoverMacCodexServers({cwd});
    return discovery.servers.map(spec=>{if(spec.transport!=='http'||!spec.url)return spec;const authProvider=new MacMcpOAuthProvider(macMcpAuthFile(),spec.url,macMcpCodec);return authProvider.tokens()?{...spec,authProvider}:spec;});
  },
  libraryEntries: resolveLibraryEntries,
  libraryRoot: path.join(libraryRoot(), "files"),
  localTools: ()=>({
    nativeCommand: selectedComputerCommand(),
    browserCommand: {
      command: process.execPath,
      args: [bundledModulePath("@playwright", "mcp", "cli.js"), ...bundledBrowserArgs(), "--caps", "vision,pdf,devtools", "--snapshot-boxes", "--user-data-dir", appDataPath("runtime-browser-profile"), "--output-dir", appDataPath("runtime-browser-output")],
      env: { ELECTRON_RUN_AS_NODE: "1" }
    }
  })
};
registerRuntimeBackend(runtimeDependencies);

registerClaudeLocalBackend({...runtimeDependencies,localTools:()=>({...runtimeDependencies.localTools(),browserCommand:{...runtimeDependencies.localTools().browserCommand,args:[bundledModulePath("@playwright","mcp","cli.js"),...bundledBrowserArgs(),"--caps","vision,pdf,devtools","--snapshot-boxes","--user-data-dir",appDataPath("claude-browser-profile"),"--output-dir",appDataPath("claude-browser-output")]}})});
registerAgentOrchestrator({ emit });
