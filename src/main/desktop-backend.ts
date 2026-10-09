import { app, dialog, ipcMain, nativeImage, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Client, ClientChannel } from "ssh2";
import { ChatProtocol, buildChatCommand, shellQuote, type ChatInput, type ChatEvent } from "./chat-protocol";
import { localExtensions, remoteExtensionScript } from "./extensions";

interface LibraryItem { id: string; name: string; localPath: string; size: number; addedAt: number; mimeType?: string; remotePath?: string; remoteSessionId?: string }
interface Session { id: string; conn: Client; remoteHome: string }
interface Dependencies {
  session(id: string): Session | undefined;
  window(): BrowserWindow | null;
  emit(channel: string, payload: unknown): void;
  upload(session: Session, localPath: string, remotePath: string, signal?: AbortSignal): Promise<void>;
}
interface ChatRun { requestId: string; sessionId: string; cancelled: boolean; abort: AbortController; stream?: ClientChannel; remotePid?: number; finish?: (code: number | null) => void }
const runs = new Map<string, ChatRun>();
export function libraryRoot() { return path.join(app.getPath("userData"), "library"); }
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
function imageMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}
export async function resolveLibraryEntries(ids: string[]) {
  if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))) throw new Error("一次最多傳送 20 個有效附件。");
  const items = readLibrary(); const resolved = [];
  let total = 0;
  for (const id of [...new Set(ids)]) {
    const item = items.find(entry => entry.id === id);
    if (!item || path.basename(item.name) !== item.name || [".", ".."].includes(item.name)) throw new Error("附件已移除或紀錄無效，請重新加入。");
    const expected = path.join(libraryRoot(), "files", id, item.name);
    // Never trust a renderer path or a substituted library index pathname.
    const canonicalRoot = await fs.promises.realpath(libraryRoot());
    const canonical = await fs.promises.realpath(expected);
    const relative = path.relative(canonicalRoot, canonical);
    if (item.localPath !== expected || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || (await fs.promises.lstat(expected)).isSymbolicLink()) throw new Error("附件路徑不屬於受管理的檔案庫。");
    const stat = await fs.promises.stat(canonical);
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES || (total += stat.size) > MAX_ATTACHMENT_BYTES) throw new Error("附件總大小上限為 100 MB。");
    const handle = await fs.promises.open(canonical, "r");
    const header = Buffer.alloc(16); try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
    resolved.push({ id, name: item.name, path: canonical, localPath: canonical, size: stat.size, mimeType: imageMime(header) });
  }
  return resolved;
}
function readLibrary(): LibraryItem[] {
  try { return JSON.parse(fs.readFileSync(path.join(libraryRoot(), "index.json"), "utf8")); } catch { return []; }
}
function writeLibrary(items: LibraryItem[]) {
  fs.mkdirSync(libraryRoot(), { recursive: true });
  const target = path.join(libraryRoot(), "index.json");
  fs.writeFileSync(target + ".tmp", JSON.stringify(items, null, 2), { mode: 0o600 });
  fs.renameSync(target + ".tmp", target);
}
async function addPaths(paths: string[]) {
  if (!Array.isArray(paths) || paths.length > 100) throw new Error("一次最多加入 100 個檔案。");
  const added: LibraryItem[] = [];
  for (const source of paths) {
    const stat = await fs.promises.stat(source);
    if (!stat.isFile()) throw new Error("附件請選擇檔案；資料夾可透過遠端檔案頁上傳。");
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error("單一附件上限為 100 MB。");
    const id = randomUUID();
    const localPath = path.join(libraryRoot(), "files", id, path.basename(source));
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    await fs.promises.copyFile(source, localPath);
    await fs.promises.chmod(localPath, 0o600);
    const handle = await fs.promises.open(localPath, "r"); const header = Buffer.alloc(16);
    try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
    const item = { id, name: path.basename(source), localPath, size: stat.size, addedAt: Date.now(), mimeType: imageMime(header) };
    // Merge after the awaited copy so concurrent imports cannot lose index records.
    writeLibrary([...readLibrary(), item]);
    added.push(item);
  }
  return added;
}
function execMetadata(conn: Client, command: string) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { channel?.close(); reject(new Error("遠端擴充掃描逾時。")); }, 20000);
    let channel: ClientChannel | undefined;
    conn.exec(command, (error, stream) => {
      if (error) { clearTimeout(timer); reject(error); return; }
      channel = stream;
      let output = "";
      stream.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 4_000_000) stream.close(); });
      stream.on("error", (error: Error) => { clearTimeout(timer); reject(error); });
      stream.on("close", (code: number) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error("無法掃描遠端擴充；請確認主機已安裝 Python 3。")); });
    });
  });
}
function cancelRun(run: ChatRun, deps: Dependencies) {
  run.cancelled = true;
  run.abort.abort();
  if (run.remotePid) {
    // Both launch paths emit the leader of a private process group for this request.
    deps.session(run.sessionId)?.conn.exec(`kill -TERM -- -${run.remotePid} 2>/dev/null || true`, (_error, stream) => stream?.resume());
  }
  try { run.stream?.signal("TERM"); } catch {}
  if (run.stream) setTimeout(() => { try { run.stream?.close(); } catch {} run.finish?.(null); }, 2500).unref();
}
export function cancelSessionChats(sessionId: string, deps: Dependencies) {
  for (const run of runs.values()) if (run.sessionId === sessionId) cancelRun(run, deps);
}
export function registerDesktopBackend(deps: Dependencies) {
  const getSession = (id: string) => { const session = deps.session(id); if (!session) throw new Error("請先連線至遠端主機。"); return session; };
  const upload = async (sessionId: string, ids: string[], remoteDir?: string, signal?: AbortSignal) => {
    const session = getSession(sessionId);
    const results: LibraryItem[] = [];
    for (const id of [...new Set(ids)]) {
      if (signal?.aborted) throw new Error("已停止傳送。");
      const item = readLibrary().find((x) => x.id === id);
      if (!item) throw new Error("附件已從檔案庫移除。");
      const target = path.posix.join(remoteDir || path.posix.join(session.remoteHome, ".agentbridge", "attachments"), item.id, item.name);
      // Always transfer the managed copy; an old remote pathname alone is not proof the file still exists.
      await deps.upload(session, item.localPath, target, signal);
      if (signal?.aborted) throw new Error("已停止傳送。");
      const updated = { ...item, remotePath: target, remoteSessionId: sessionId };
      writeLibrary(readLibrary().map((x) => x.id === id ? updated : x));
      results.push(updated);
    }
    return results;
  };
  ipcMain.handle("library:list", () => readLibrary());
  ipcMain.handle("library:choose", async () => {
    const options = { title: "加入檔案", properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections"> };
    const window = deps.window();
    const selection = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return selection.canceled ? [] : addPaths(selection.filePaths);
  });
  ipcMain.handle("library:addPaths", (_event, paths: string[]) => addPaths(paths));
  ipcMain.handle("library:addImage", async (_event, input: { dataUrl: string }) => {
    if (typeof input?.dataUrl !== "string" || input.dataUrl.length > 28_000_000) throw new Error("貼上的圖片上限為 20 MB。");
    const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.dataUrl);
    if (!match) throw new Error("請貼上 PNG、JPEG、GIF 或 WebP 圖片。");
    const bytes = Buffer.from(match[2], "base64");
    const mimeType = imageMime(bytes);
    if (!mimeType || bytes.length > 20 * 1024 * 1024) throw new Error("無法辨識圖片內容，或圖片超過 20 MB。");
    const id = randomUUID(), name = `貼上圖片-${Date.now()}.${mimeType.split("/")[1] === "jpeg" ? "jpg" : mimeType.split("/")[1]}`;
    const localPath = path.join(libraryRoot(), "files", id, name);
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    await fs.promises.writeFile(localPath, bytes, { flag: "wx", mode: 0o600 });
    const item = { id, name, localPath, size: bytes.length, addedAt: Date.now(), mimeType };
    writeLibrary([...readLibrary(), item]); return [item];
  });
  ipcMain.handle("library:preview", async (_event, id: string) => {
    const [item] = await resolveLibraryEntries([id]);
    if (!item?.mimeType || item.size > 20 * 1024 * 1024) return null;
    const image = nativeImage.createFromBuffer(await fs.promises.readFile(item.path));
    if (image.isEmpty()) return null;
    const size = image.getSize();
    return (Math.max(size.width, size.height) > 640 ? image.resize({ ...(size.width > size.height ? { width: 640 } : { height: 640 }), quality: "good" }) : image).toDataURL();
  });
  ipcMain.handle("library:remove", (_event, id: string) => {
    const item = readLibrary().find((x) => x.id === id);
    writeLibrary(readLibrary().filter((x) => x.id !== id));
    if (item && /^[a-f0-9-]{36}$/.test(id)) fs.rmSync(path.join(libraryRoot(), "files", id), { recursive: true, force: true });
    return readLibrary();
  });
  ipcMain.handle("library:upload", (_event, sessionId: string, ids: string[], remoteDir?: string) => upload(sessionId, ids, remoteDir));
  ipcMain.handle("extensions:list", async (_event, sessionId?: string) => {
    const local = await localExtensions();
    if (!sessionId) return local;
    try {
      const data = JSON.parse(await execMetadata(getSession(sessionId).conn, `python3 -c ${shellQuote(remoteExtensionScript)}`));
      return { items: [...local.items, ...data.items], warnings: data.warnings || [] };
    } catch (error) { return { ...local, warnings: [error instanceof Error ? error.message : String(error)] }; }
  });
  ipcMain.handle("chat:send", (_event, input: ChatInput) => {
    const session = getSession(input.sessionId);
    if (typeof input.prompt !== "string" || input.prompt.length > 1_000_000 || (!input.prompt.trim() && !input.attachments?.length)) throw new Error("請輸入訊息或加入附件。");
    const command = buildChatCommand(input, input.remoteCwd || session.remoteHome);
    const requestId = input.requestId || randomUUID();
    if (runs.has(requestId)) throw new Error("這次回覆仍在進行中。");
    const run: ChatRun = { requestId, sessionId: input.sessionId, cancelled: false, abort: new AbortController() };
    runs.set(requestId, run);
    const send = (event: Omit<ChatEvent, "requestId" | "sessionId">) => deps.emit("chat:event", { ...event, requestId, sessionId: input.sessionId });
    let settled = false;
    const done = (status: string, code: number | null = null) => {
      if (settled) return; settled = true;
      runs.delete(requestId);
      send({ type: "done", status, code });
    };
    // Start on the next turn so invoke resolves before any streamed event reaches the renderer.
    setImmediate(async () => {
      try {
        if (input.attachments?.length && !run.cancelled) send({ type: "activity", text: "正在上傳附件" });
        const attachments = input.attachments?.length ? await upload(input.sessionId, input.attachments.map((x) => x.id), undefined, run.abort.signal) : [];
        if (run.cancelled) { done("cancelled"); return; }
        const prompt = input.prompt + (attachments.length ? "\n\n使用者附加的檔案已上傳至這台主機。請依需要讀取以下絕對路徑（路徑以 JSON 字串表示）：\n" + attachments.map((x) => JSON.stringify(x.remotePath)).join("\n") : "");
        const protocol = new ChatProtocol(send, (pid) => { run.remotePid = pid; if (run.cancelled) cancelRun(run, deps); });
        session.conn.exec(command, { pty: false }, (error, stream) => {
          if (error) { send({ type: "error", text: error.message }); done(run.cancelled ? "cancelled" : "error"); return; }
          run.stream = stream;
          let stderr = "";
          let protocolError = false;
          run.finish = (code) => {
            if (settled) return;
            try { protocol.finish(); } catch { protocolError = true; }
            if (run.cancelled) { done("cancelled", code); return; }
            if (code !== 0 || protocol.didFail || protocolError || !protocol.didComplete) {
              if (!protocol.didFail) send({ type: "error", text: stderr.trim().slice(-3000) || (protocolError ? "助理資料解析失敗。" : "助理未完成回覆。請確認遠端 CLI 版本與登入狀態。") });
              done("error", code);
            } else done("completed", code);
          };
          stream.on("data", (chunk: Buffer) => { if (settled) return; try { protocol.push(chunk); } catch { protocolError = true; stream.close(); } });
          stream.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
          stream.on("error", (err: Error) => { send({ type: "error", text: err.message }); done(run.cancelled ? "cancelled" : "error"); });
          stream.on("close", (code: number) => run.finish?.(code));
          if (run.cancelled) { cancelRun(run, deps); return; }
          send({ type: "activity", text: "助理正在思考" });
          stream.end(prompt + "\n");
        });
      } catch (error) {
        if (!run.cancelled) send({ type: "error", text: error instanceof Error ? error.message : String(error) });
        done(run.cancelled ? "cancelled" : "error");
      }
    });
    return { requestId };
  });
  ipcMain.handle("chat:cancel", (_event, requestId: string) => {
    const run = runs.get(requestId);
    if (run) cancelRun(run, deps);
    return { cancelled: Boolean(run) };
  });
}
