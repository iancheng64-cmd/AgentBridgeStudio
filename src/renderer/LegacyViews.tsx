import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SPRINGS } from "./motion";
import type { DoctorCheck, DoctorReport, ExposureMode, ExposureState } from "./global";

type View = "workspace" | "files" | "computer" | "extensions" | "settings";
type Agent = "codex" | "claude";
type AuthType = "agent" | "key" | "password";

interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  keyPath?: string;
  savePassword?: boolean;
  hasSavedPassword?:boolean;
  encryptedPassword?: string;
  runtimePlatform?: 'auto' | 'windows' | 'posix';
}
interface SessionInfo {
  sessionId: string;
  profile: Profile;
  remoteHome: string;
  system: string;
}
interface RemoteFile {
  name: string;
  path: string;
  size: number;
  modified: number;
  isDirectory: boolean;
}
interface TransferInfo {
  id: string;
  sessionId: string;
  direction: "upload" | "download";
  source: string;
  target: string;
  name: string;
  isDirectory: boolean;
  state: "queued" | "running" | "paused" | "completed" | "error" | "cancelled";
  totalBytes: number;
  transferredBytes: number;
  filesTotal: number;
  filesDone: number;
  speedBytesPerSec: number;
  startedAt?: number;
  updatedAt: number;
  error?: string;
}
interface Address {
  name: string;
  address: string;
  kind: string;
}

const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    sparkle: "M12 2l1.25 4.1L17 7.5l-3.75 1.4L12 13l-1.25-4.1L7 7.5l3.75-1.4L12 2zm6 10 .85 2.65L21.5 15.5l-2.65.85L18 19l-.85-2.65-2.65-.85 2.65-.85L18 12zM5 13l1.05 3.45L9.5 17.5l-3.45 1.05L5 22l-1.05-3.45L.5 17.5l3.45-1.05L5 13z",
    terminal: "M4 5l5 4-5 4M11 15h7",
    files: "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11z",
    computer: "M3 4.5h18v12H3zM8 20h8M12 16.5V20",
    extension: "M8.5 3A2.5 2.5 0 1 0 11 5.5V8H8.5A2.5 2.5 0 1 0 6 10.5V13h5v2.5a2.5 2.5 0 1 0 2.5 2.5H16v-5h2.5a2.5 2.5 0 1 0 0-5H16V3h-5v2.5A2.5 2.5 0 0 0 8.5 3z",
    settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm8.5 3a6.8 6.8 0 0 0-.1-1l2-1.55-2-3.45-2.45 1a7 7 0 0 0-1.75-1L15.85 3h-4L11.5 6a7 7 0 0 0-1.75 1L7.3 6 5.3 9.45 7.3 11a6.8 6.8 0 0 0 0 2l-2 1.55L7.3 18l2.45-1a7 7 0 0 0 1.75 1l.35 3h4l.35-3a7 7 0 0 0 1.75-1l2.45 1 2-3.45-2-1.55a6.8 6.8 0 0 0 .1-1z",
    plus: "M12 5v14M5 12h14",
    refresh: "M20 6v5h-5M4 18v-5h5M5.7 9A7 7 0 0 1 17 6l3 5M18.3 15A7 7 0 0 1 7 18l-3-5",
    upload: "M12 16V4m0 0L7 9m5-5 5 5M4 18v2h16v-2",
    download: "M12 4v12m0 0 5-5m-5 5-5-5M4 20h16",
    pause: "M8 5v14M16 5v14",
    play: "M8 5l11 7-11 7V5z",
    close: "M6 6l12 12M18 6L6 18",
    folderplus: "M3 7h7l2 2h9v10H3zM15 12v5M12.5 14.5h5",
    chevron: "M9 6l6 6-6 6",
    back: "M15 18l-6-6 6-6",
    plug: "M8 3v6m8-6v6M6 9h12v2a6 6 0 0 1-6 6v4",
    cursor: "M5 3l13 8-6 1 3 6-2.5 1.2-3-6L5 17V3z",
    eye: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zm10-2.5A2.5 2.5 0 1 0 12 14a2.5 2.5 0 0 0 0-4.5z",
    check: "M5 12.5l4.5 4.5L19 7",
    minus: "M6 12h12",
    info: "M12 11v6M12 7.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
    alert: "M12 3.5L22 20H2L12 3.5zM12 10v4M12 17.2h.01",
    lock: "M6 10h12v10H6zM8 10V7a4 4 0 0 1 8 0v3"
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name] || paths.sparkle} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusDot({ state = "idle" }: { state?: string }) {
  return <span className={`status-dot ${state}`} />;
}

function TerminalPane({ sessionId, agent }: { sessionId: string; agent: Agent }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const t = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      convertEol: true,
      fontFamily: "'SFMono-Regular', ui-monospace, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.45,
      letterSpacing: 0.1,
      scrollback: 10000,
      theme: {
        background: "#0f1012",
        foreground: "#e9e9e6",
        cursor: "#f3f3ed",
        cursorAccent: "#0f1012",
        selectionBackground: "#3c414b88",
        black: "#191a1d",
        red: "#ed7171",
        green: "#9fcf9d",
        yellow: "#dbc47d",
        blue: "#94b9f4",
        magenta: "#c8a8ef",
        cyan: "#91ced5",
        white: "#e8e8e5",
        brightBlack: "#686a70"
      }
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current);
    terminal.current = t;
    fit.current = f;
    requestAnimationFrame(() => {
      f.fit();
      window.agentBridge.terminal.resize(sessionId, t.cols, t.rows);
    });
    const disposable = t.onData((data) => window.agentBridge.terminal.input(sessionId, data));
    const unsub = window.agentBridge.terminal.onData((payload) => {
      if (payload.sessionId === sessionId) t.write(payload.data);
    });
    const ro = new ResizeObserver(() => {
      try {
        f.fit();
        window.agentBridge.terminal.resize(sessionId, t.cols, t.rows);
      } catch {}
    });
    ro.observe(host.current);
    window.agentBridge.terminal.start(sessionId, agent).catch((error) => {
      t.writeln("\r\n\x1b[31mFailed to start remote agent: " + error.message + "\x1b[0m");
    });
    return () => {
      disposable.dispose();
      unsub();
      ro.disconnect();
      t.dispose();
      terminal.current = null;
    };
  }, [sessionId, agent]);

  return <div className="terminal-host" ref={host} />;
}

function ConnectionForm({
  draft,
  setDraft,
  onSave,
  onConnect,
  busy,
  connectLabel = "連線"
}: {
  draft: any;
  setDraft: (v: any) => void;
  onSave: () => void;
  onConnect: () => void;
  busy: boolean;
  connectLabel?: string;
}) {
  return (
    <fieldset disabled={busy} className="connect-form">
      <div className="field-grid two">
        <label>
          <span>名稱</span>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="朋友的 Windows" />
        </label>
        <label>
          <span>Tailscale / Host</span>
          <input value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} placeholder="100.x.x.x 或 MagicDNS" />
        </label>
      </div>
      <div className="field-grid three">
        <label>
          <span>使用者</span>
          <input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} placeholder="ian" />
        </label>
        <label>
          <span>Port</span>
          <input type="number" value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} />
        </label>
        <label>
          <span>認證</span>
          <select value={draft.authType} onChange={(e) => setDraft({ ...draft, authType: e.target.value })}>
            <option value="agent">SSH Agent</option>
            <option value="key">Private Key</option>
            <option value="password">Password</option>
          </select>
        </label>
      </div>
      {draft.authType === "key" && (
        <div className="inline-field">
          <input value={draft.keyPath || ""} onChange={(e) => setDraft({ ...draft, keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" />
          <button className="secondary" onClick={async () => {
            const p = await window.agentBridge.dialogs.chooseKey();
            if (p) setDraft({ ...draft, keyPath: p });
          }}>選擇</button>
        </div>
      )}
      {draft.authType === "password" && (
        <div className="field-grid two">
          <label>
            <span>{draft.hasSavedPassword?'Password（已加密記住）':'Password'}</span>
            <input type="password" autoComplete="off" placeholder={draft.hasSavedPassword?"留白使用已記住的密碼":"SSH 密碼"} value={draft.password || ""} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
          </label>
          <label className="check-field">
            <input type="checkbox" checked={!!draft.savePassword} onChange={(e) => setDraft({ ...draft, savePassword: e.target.checked })} />
            <span>使用 macOS Keychain 加密後儲存</span>
          </label>
        </div>
      )}
      <div className="form-actions">
        <button className="secondary" onClick={onSave}>儲存連線</button>
        <button className="primary" disabled={busy || !draft.host || !draft.username} onClick={onConnect}>
          {busy ? "連線中…" : connectLabel}
        </button>
      </div>
    </fieldset>
  );
}

function FilesView({ session }: { session: SessionInfo }) {
  const [pathValue, setPathValue] = useState(session.remoteHome);
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [transfers, setTransfers] = useState<TransferInfo[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const refresh = useCallback(async (target = pathValue) => {
    setBusy(true);
    try {
      setFiles(await window.agentBridge.files.list(session.sessionId, target));
      setPathValue(target);
    } finally {
      setBusy(false);
    }
  }, [pathValue, session.sessionId]);

  useEffect(() => {
    refresh(session.remoteHome);
    window.agentBridge.files.transfers(session.sessionId).then(setTransfers);
    const offTransfer = window.agentBridge.files.onTransfer((payload: TransferInfo) => {
      if (payload.sessionId !== session.sessionId) return;
      setTransfers((current) => {
        const next = current.filter((item) => item.id !== payload.id);
        return [payload, ...next].sort((a, b) => b.updatedAt - a.updatedAt);
      });
      if (payload.direction === "upload" && payload.state === "completed") {
        setTimeout(() => refresh(pathValue), 120);
      }
    });
    const offRemoved = window.agentBridge.files.onTransferRemoved(({ id }) => {
      setTransfers((current) => current.filter((item) => item.id !== id));
    });
    return () => { offTransfer(); offRemoved(); };
  }, [session.sessionId]);

  const parent = pathValue === "/" ? "/" : pathValue.split("/").slice(0, -1).join("/") || "/";
  const LIVE: TransferInfo["state"][] = ["queued", "running", "paused"];
  const live = transfers.filter((t) => LIVE.includes(t.state));
  const settled = transfers.filter((t) => !LIVE.includes(t.state));
  const failed = settled.filter((t) => t.state === "error");

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => window.agentBridge.files.pathForFile(file))
      .filter(Boolean);
    if (paths.length) await window.agentBridge.files.uploadPaths(session.sessionId, pathValue, paths);
  };

  const control = (id: string, action: "pause" | "resume" | "cancel" | "clear" | "retry") =>
    window.agentBridge.files.transferControl(id, action);

  return (
    <div
      className={`view-shell file-transfer-view ${dragActive ? "drag-active" : ""}`}
      onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragActive(false);
      }}
      onDrop={handleDrop}
    >
      {dragActive && (
        <div className="drop-overlay">
          <div><Icon name="upload" /><b>拖到這裡上傳</b><span>檔案與整個資料夾都可直接傳到 {pathValue}</span></div>
        </div>
      )}
      <div className="view-heading">
        <div>
          <h2>遠端檔案</h2>
          <p>串流 SFTP · 可續傳 · 不限制副檔名或 App 端單檔大小。</p>
        </div>
        <div className="toolbar">
          <button className="secondary compact" onClick={() => refresh()}><Icon name="refresh" />重新整理</button>
          <button className="secondary compact" onClick={() => window.agentBridge.files.uploadFolder(session.sessionId, pathValue)}>
            <Icon name="folderplus" />資料夾
          </button>
          <button className="primary compact" onClick={() => window.agentBridge.files.upload(session.sessionId, pathValue)}>
            <Icon name="upload" />上傳檔案
          </button>
        </div>
      </div>
      <div className="pathbar">
        <button className="icon-button" onClick={() => refresh(parent)} disabled={pathValue === "/"}><Icon name="back" /></button>
        <input value={pathValue} onChange={(e) => setPathValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && refresh(pathValue)} />
      </div>
      <div className="file-table">
        <div className="file-row header"><span>名稱</span><span>大小</span><span>修改時間</span><span /></div>
        {busy && <div className="empty-state">讀取中…</div>}
        {!busy && files.map((f) => (
          <div className="file-row" key={f.path} onDoubleClick={() => f.isDirectory && refresh(f.path)}>
            <span className="file-name"><span className={`file-symbol ${f.isDirectory ? "folder" : ""}`}>{f.isDirectory ? "▸" : "·"}</span>{f.name}</span>
            <span>{f.isDirectory ? "—" : formatBytes(f.size)}</span>
            <span>{new Date(f.modified).toLocaleString()}</span>
            <span className="row-actions">
              <button className="icon-button" title={f.isDirectory ? "下載整個資料夾" : "下載"} onClick={() => window.agentBridge.files.download(session.sessionId, f.path)}>
                <Icon name="download" />
              </button>
              {f.isDirectory && <button className="icon-button" title="打開" onClick={() => refresh(f.path)}><Icon name="chevron" /></button>}
            </span>
          </div>
        ))}
      </div>

      <TransferCenter
        live={live}
        settled={showDone ? settled : []}
        failedCount={failed.length}
        settledCount={settled.length}
        showDone={showDone}
        onToggleDone={() => setShowDone((value) => !value)}
        onControl={control}
      />
    </div>
  );
}

/**
 * The progress bar reports a fact, so it is written straight from the byte
 * count with no tween — a bar that eases toward the truth is a bar that lies
 * about the transfer for a fifth of a second on every update. Only the state
 * colour animates, because that is a categorical change rather than a position.
 */
function TransferRow({ transfer, onControl }: { transfer: TransferInfo; onControl: (id: string, action: "pause" | "resume" | "cancel" | "clear" | "retry") => void }) {
  const known = transfer.totalBytes > 0;
  const progress = known ? Math.min(100, (transfer.transferredBytes / transfer.totalBytes) * 100) : 0;
  const stateLabel: Record<TransferInfo["state"], string> = {
    queued: "等待中",
    running: formatBytes(transfer.speedBytesPerSec) + "/s",
    paused: "已暫停",
    completed: "完成",
    error: "失敗",
    cancelled: "已取消"
  };
  const remaining = known && transfer.state === "running" && transfer.speedBytesPerSec > 0
    ? Math.max(0, Math.round((transfer.totalBytes - transfer.transferredBytes) / transfer.speedBytesPerSec))
    : null;

  return (
    <motion.li
      className={`transfer-row ${transfer.state}`}
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={SPRINGS.snappy}
    >
      <div className="transfer-direction"><Icon name={transfer.direction === "upload" ? "upload" : "download"} /></div>
      <div className="transfer-main">
        <div className="transfer-meta">
          <b title={transfer.source}>{transfer.name}</b>
          <span className={`transfer-state ${transfer.state}`}>{stateLabel[transfer.state]}</span>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
          aria-label={`${transfer.name} 傳輸進度`}
        >
          <i style={{ width: `${progress}%` }} />
        </div>
        <div className="transfer-detail">
          <span>
            {formatBytes(transfer.transferredBytes)} / {known ? formatBytes(transfer.totalBytes) : "計算中"}
            {remaining !== null ? ` · 剩餘 ${formatDuration(remaining)}` : ""}
          </span>
          <span>
            {transfer.filesTotal > 1 ? `${transfer.filesDone}/${transfer.filesTotal} 個檔案 · ` : ""}
            {known ? `${Math.round(progress)}%` : ""}
          </span>
        </div>
        {transfer.error && <div className="transfer-error" role="alert">{transfer.error}</div>}
      </div>
      <div className="transfer-actions">
        {transfer.state === "running" && <button className="icon-button" title="暫停" aria-label={`暫停 ${transfer.name}`} onClick={() => onControl(transfer.id, "pause")}><Icon name="pause" /></button>}
        {transfer.state === "paused" && <button className="icon-button" title="繼續" aria-label={`繼續 ${transfer.name}`} onClick={() => onControl(transfer.id, "resume")}><Icon name="play" /></button>}
        {(transfer.state === "error" || transfer.state === "cancelled") && (
          <button className="icon-button" title="重試（從續傳點接續）" aria-label={`重試 ${transfer.name}`} onClick={() => onControl(transfer.id, "retry")}><Icon name="refresh" /></button>
        )}
        {["queued", "running", "paused"].includes(transfer.state)
          ? <button className="icon-button danger-icon" title="取消" aria-label={`取消 ${transfer.name}`} onClick={() => onControl(transfer.id, "cancel")}><Icon name="close" /></button>
          : <button className="icon-button" title="從清單移除" aria-label={`從清單移除 ${transfer.name}`} onClick={() => onControl(transfer.id, "clear")}><Icon name="close" /></button>}
      </div>
    </motion.li>
  );
}

function TransferCenter({
  live,
  settled,
  failedCount,
  settledCount,
  showDone,
  onToggleDone,
  onControl
}: {
  live: TransferInfo[];
  settled: TransferInfo[];
  failedCount: number;
  settledCount: number;
  showDone: boolean;
  onToggleDone: () => void;
  onControl: (id: string, action: "pause" | "resume" | "cancel" | "clear" | "retry") => void;
}) {
  if (!live.length && !settledCount) return null;
  const liveBytes = live.reduce((sum, t) => sum + (t.totalBytes - t.transferredBytes), 0);

  return (
    <section className="transfer-center" aria-label="Transfer Center">
      <div className="transfer-center-head">
        <div>
          <h3>Transfer Center</h3>
          <p>
            {live.length
              ? `${live.length} 個進行中${liveBytes > 0 ? ` · 還有 ${formatBytes(liveBytes)}` : ""}`
              : `沒有進行中的傳輸`}
            {failedCount > 0 && <span className="transfer-alert"> · {failedCount} 個失敗</span>}
          </p>
        </div>
        <div className="transfer-head-actions">
          {failedCount > 0 && (
            <button className="secondary compact" onClick={() => settled.filter((t) => t.state === "error").forEach((t) => onControl(t.id, "retry"))}>
              <Icon name="refresh" />全部重試
            </button>
          )}
          {live.some((t) => t.state === "paused") && (
            <button className="secondary compact" onClick={() => live.filter((t) => t.state === "paused").forEach((t) => onControl(t.id, "resume"))}>
              <Icon name="play" />全部繼續
            </button>
          )}
          {settledCount > 0 && (
            <button className="secondary compact" onClick={onToggleDone} aria-expanded={showDone}>
              {showDone ? "隱藏已完成" : `已完成 ${settledCount}`}
            </button>
          )}
        </div>
      </div>
      <ul className="transfer-list">
        <AnimatePresence initial={false} mode="popLayout">
          {live.map((t) => <TransferRow key={t.id} transfer={t} onControl={onControl} />)}
          {settled.map((t) => <TransferRow key={t.id} transfer={t} onControl={onControl} />)}
        </AnimatePresence>
      </ul>
      <p className="transfer-footnote">串流傳輸 · 中斷後從續傳點接續 · 失敗自動重試 3 次</p>
    </section>
  );
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`;
}

/**
 * A short, user-initiated demonstration of the virtual cursor.
 *
 * It runs once, on demand, and only when asked. The previous version looped on
 * a six-second cycle forever, which is exactly the kind of ambient oscillation
 * that reads as noise rather than as feedback — and it burned attention in the
 * one place on this screen where attention belongs: whether the engine is
 * actually healthy.
 */
function VirtualCursorDemo() {
  const [replayKey, setReplayKey] = useState(0);
  const [running, setRunning] = useState(false);

  const replay = () => {
    setRunning(false);
    setReplayKey((key) => key + 1);
    requestAnimationFrame(() => setRunning(true));
  };

  return (
    <div className="virtual-cursor-demo">
      <div className="mock-window">
        <div className="mock-topbar"><span /><span /><span /></div>
        <div className="mock-sidebar" />
        <div className="mock-lines"><i /><i /><i /><i /></div>
      </div>
      {running ? (
        <motion.div
          key={replayKey}
          className="virtual-cursor"
          initial={{ x: 12, y: 58, opacity: 0 }}
          animate={{ x: [12, 84, 128, 84], y: [58, 32, 46, 32], opacity: [0, 1, 1, 0] }}
          transition={{ duration: 1.5, times: [0, 0.35, 0.7, 1], ease: [0.32, 0, 0.24, 1] }}
          onAnimationComplete={() => setRunning(false)}
        >
          <Icon name="cursor" /><span>操作示意</span>
        </motion.div>
      ) : null}
      <button className="virtual-cursor-replay" onClick={replay} aria-label="播放 virtual cursor 示意">
        <Icon name="play" />{running ? "播放中" : "播放示意"}
      </button>
    </div>
  );
}

const EXPOSURE_OPTIONS: Array<{ value: ExposureMode; label: string; detail: string }> = [
  { value: "tailscale", label: "Tailscale", detail: "只綁 Tailnet 位址。遠端 agent 走加密的 WireGuard 網路。" },
  { value: "lan", label: "LAN", detail: "只綁區域網路位址。同一個 Wi-Fi 下才連得到。" },
  { value: "all", label: "所有介面", detail: "綁 0.0.0.0，LAN 與 Tailnet 都能連。Computer Use 沒有驗證，請只在受控網路使用。" },
  { value: "localhost", label: "僅本機", detail: "只綁 loopback。遠端 agent 必須走 SSH reverse tunnel。" }
];

function CheckRow({ check }: { check: DoctorCheck }) {
  const glyph = check.state === "ok" ? "check" : check.state === "fail" ? "close" : check.state === "warn" ? "info" : "minus";
  return (
    <li className={`check-row ${check.state}`}>
      <span className="check-mark" aria-hidden="true"><Icon name={glyph} /></span>
      <span className="check-text">
        <b>{check.label}</b>
        <code title={check.detail}>{check.detail}</code>
        {check.hint && <em>{check.hint}</em>}
      </span>
      <span className="check-state" role="status">
        {check.state === "ok" ? "正常" : check.state === "fail" ? "需要處理" : check.state === "warn" ? "注意" : "未知"}
      </span>
    </li>
  );
}

function ComputerView({
  session,
  addresses,
  services,
  refreshDoctor,
  doctor
}: {
  session: SessionInfo | null;
  addresses: Address[];
  services: any[];
  refreshDoctor: () => Promise<void>;
  doctor: DoctorReport | null;
}) {
  const [selectedHost, setSelectedHost] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [exposure, setExposure] = useState<ExposureState | null>(null);
  const computer = services.find((s) => s.name === "computer");
  const browser = services.find((s) => s.name === "browser");
  const listening = (name: string) => services.find((s) => s.name === name)?.status === "running";

  useEffect(() => {
    void window.agentBridge.exposure.get().then(setExposure).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedHost) {
      const preferred = exposure?.advertiseHost;
      const match = addresses.find((a) => a.address === preferred) || addresses[0];
      if (match) setSelectedHost(match.address);
    }
  }, [addresses, selectedHost, exposure]);

  const serviceAction = async (name: "computer" | "browser", running: boolean) => {
    setBusy(true);
    try {
      if (running) await window.agentBridge.services.stop(name);
      else await window.agentBridge.services.start(name);
    } finally {
      setBusy(false);
      void refreshDoctor();
    }
  };

  const setMode = async (mode: ExposureMode) => {
    const next = await window.agentBridge.exposure.set(mode);
    setExposure(next);
  };

  const endpointHost = exposure?.advertiseHost || selectedHost || "127.0.0.1";
  const checks = doctor?.checks || [];
  const blocking = checks.filter((c) => c.state === "fail");

  return (
    <div className="view-shell">
      <div className="view-heading">
        <div>
          <div className="eyebrow">Codex-style execution layer</div>
          <h2>Computer &amp; Browser Use</h2>
          <p>本機執行、遠端 Agent 透過 Tailscale / LAN 直接呼叫。</p>
        </div>
        <button className="secondary compact" disabled={busy} onClick={async () => { setBusy(true); try { await window.agentBridge.local.installEngines(); await refreshDoctor(); } finally { setBusy(false); } }}>
          檢查 Bundled Engines
        </button>
      </div>

      <div className="engine-grid">
        <motion.div className="engine-card hero-engine" layout>
          <div className="engine-head">
            <div className="engine-icon cursor"><Icon name="cursor" /></div>
            <div>
              <h3>Native Computer Use</h3>
              <p>Codex-style macOS engine · AX tree · screenshots · virtual cursor</p>
            </div>
            <span className={`pill ${listening("computer") ? "success" : ""}`}>
              <StatusDot state={listening("computer") ? "running" : "idle"} />
              {computer?.status || "stopped"}
            </span>
          </div>

          <VirtualCursorDemo />

          <div className="capability-grid">
            {["App-aware virtual cursor", "Accessibility Tree", "element_index clicks", "Background typing", "Drag & scroll", "Per-step screenshots", "Keyboard chords", "set_value / AX actions"].map((x) => (
              <span key={x}>✓ {x}</span>
            ))}
          </div>
          <div className="engine-actions">
            <button className={listening("computer") ? "danger" : "primary"} disabled={busy} onClick={() => serviceAction("computer", listening("computer"))}>
              {listening("computer") ? "停止 Computer Use" : "啟動 Computer Use"}
            </button>
            <code>http://{endpointHost}:8932/mcp</code>
          </div>
        </motion.div>

        <motion.div className="engine-card" layout>
          <div className="engine-head">
            <div className="engine-icon"><Icon name="eye" /></div>
            <div>
              <h3>Browser Use</h3>
              <p>Playwright MCP · dedicated persistent profile</p>
            </div>
            <span className={`pill ${listening("browser") ? "success" : ""}`}>
              <StatusDot state={listening("browser") ? "running" : "idle"} />
              {browser?.status || "stopped"}
            </span>
          </div>
          <div className="browser-visual">
            <div className="browser-tabs"><span /><span /><span /></div>
            <div className="browser-address">https://</div>
            <div className="browser-content"><i /><i /><i /></div>
          </div>
          <div className="engine-actions">
            <button className={listening("browser") ? "danger" : "primary"} disabled={busy} onClick={() => serviceAction("browser", listening("browser"))}>
              {listening("browser") ? "停止 Browser Use" : "啟動 Browser Use"}
            </button>
            <code>http://{endpointHost}:8931/mcp</code>
          </div>
        </motion.div>
      </div>

      <div className="section-card">
        <div className="section-title">
          <div>
            <h3>曝光模式</h3>
            <p>Computer Use 與 Browser Use 都沒有驗證，綁在哪個位址就是誰能用。</p>
          </div>
          {exposure && <span className={`pill ${exposure.bindHost === "0.0.0.0" ? "warning" : ""}`}>
            目前綁定 {exposure.bindHost}
          </span>}
        </div>
        <div className="exposure-grid" role="radiogroup" aria-label="曝光模式">
          {EXPOSURE_OPTIONS.map((option) => (
            <label key={option.value} className={`exposure-option ${exposure?.mode === option.value ? "active" : ""}`}>
              <input
                type="radio"
                name="exposure"
                checked={exposure?.mode === option.value}
                onChange={() => setMode(option.value)}
              />
              <span><b>{option.label}</b><small>{option.detail}</small></span>
            </label>
          ))}
        </div>
        {exposure?.note && <p className="notice warning">{exposure.note}</p>}
        <p className="muted">變更會在重新啟動服務後套用。Computer Use MCP 沒有驗證，因此不提供「公開到 Internet」這個選項。</p>
      </div>

      <div className="section-card">
        <div className="section-title">
          <div>
            <h3>Engine Doctor</h3>
            <p>
              {doctor
                ? blocking.length
                  ? `${blocking.length} 個項目需要處理：${blocking.map((c) => c.label).join("、")}`
                  : "所有必要元件都已就緒。"
                : "尚未檢查。"}
            </p>
          </div>
          <button className="secondary compact" disabled={busy} onClick={() => refreshDoctor()}>
            <Icon name="refresh" />{doctor ? "重新檢查" : "執行檢查"}
          </button>
        </div>
        {doctor && (
          <ul className="check-list">
            {checks.map((check) => <CheckRow key={check.id} check={check} />)}
          </ul>
        )}
        {doctor?.raw && <details className="doctor-raw"><summary>bundled engine 原始輸出</summary><pre className="result-console">{doctor.raw}</pre></details>}
      </div>

      <div className="section-card">
        <div className="section-title">
          <div>
            <h3>接到遠端 Agent</h3>
            <p>一次把兩個 MCP 都寫進遠端 Codex 與 Claude Code 的設定。</p>
          </div>
          <span className="pill"><Icon name="lock" /> 不對 Internet 開 port</span>
        </div>
        <div className="address-list">
          {addresses.map((a) => (
            <label className={`address-row ${selectedHost === a.address ? "selected" : ""}`} key={a.name + a.address}>
              <input type="radio" checked={selectedHost === a.address} onChange={() => setSelectedHost(a.address)} />
              <span><b>{a.address}</b><small>{a.name}</small></span>
              <span className={`network-badge ${a.kind}`}>{a.kind}</span>
            </label>
          ))}
          {!addresses.length && <div className="empty-state">目前沒有偵測到可用 IPv4 網路介面。</div>}
        </div>
        <button className="primary full" disabled={!session || !selectedHost || busy} onClick={async () => {
          if (!session) return;
          setBusy(true);
          setOutput("正在設定遠端 Codex / Claude Code…");
          try {
            const r = await window.agentBridge.remote.configureMcp(session.sessionId, selectedHost);
            setOutput((r.stdout + "\n" + r.stderr).trim());
          } finally {
            setBusy(false);
          }
        }}>
          <Icon name="plug" /> 一鍵接到目前遠端 Codex + Claude Code
        </button>
        {output && <pre className="result-console">{output}</pre>}
      </div>

      <div className="section-card compact-card">
        <h3>Computer Use 行為模型</h3>
        <div className="workflow-strip">
          <span>1. get_app_state</span><b>→</b><span>2. AX tree + screenshot</span><b>→</b><span>3. fine-grained action</span><b>→</b><span>4. post-action state</span>
        </div>
        <p className="muted">Agent 使用自己的 virtual cursor / background action lane，不需要搶走你正在使用的實體滑鼠。</p>
      </div>
    </div>
  );
}

function ExtensionsView({ session }: { session: SessionInfo }) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"codex"|"claude">("codex");
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillRepo, setSkillRepo] = useState("");

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await window.agentBridge.remote.extensions(session.sessionId);
      setRaw((r.stdout + "\n" + r.stderr).trim());
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { refresh(); }, [session.sessionId]);

  const addMcp = async () => {
    if (!mcpName || !mcpUrl) return;
    const cmd = kind === "codex"
      ? `codex mcp add ${shellQuote(mcpName)} --url ${shellQuote(mcpUrl)}`
      : `claude mcp add --transport http --scope user ${shellQuote(mcpName)} ${shellQuote(mcpUrl)}`;
    const r = await window.agentBridge.ssh.exec(session.sessionId, cmd);
    setRaw((r.stdout + "\n" + r.stderr).trim());
    await refresh();
  };
  const installSkill = async () => {
    if (!skillName || !skillRepo) return;
    if (!/^[A-Za-z0-9._-]+$/.test(skillName)) {
      setRaw("Skill 名稱只能包含英數字、.、_、-，不可包含路徑符號。");
      return;
    }
    const root = kind === "codex" ? "$HOME/.codex/skills" : "$HOME/.claude/skills";
    const cmd = `mkdir -p ${root} && test ! -e ${root}/${shellQuote(skillName)} && git clone --depth 1 ${shellQuote(skillRepo)} ${root}/${shellQuote(skillName)}`;
    const r = await window.agentBridge.ssh.exec(session.sessionId, cmd);
    setRaw((r.stdout + "\n" + r.stderr).trim());
    await refresh();
  };

  return (
    <div className="view-shell">
      <div className="view-heading">
        <div>
          <h2>MCP · Skills · Plugins</h2>
          <p>管理遠端 Agent 的擴充能力；不只是 MCP 清單。</p>
        </div>
        <button className="secondary compact" onClick={refresh}><Icon name="refresh" />{busy ? "讀取中" : "重新整理"}</button>
      </div>
      <div className="extension-grid">
        <div className="section-card">
          <div className="section-title">
            <div><h3>新增 HTTP MCP</h3><p>直接寫入目前遠端 Agent 設定。</p></div>
            <div className="segmented mini">
              <button className={kind === "codex" ? "active" : ""} onClick={() => setKind("codex")}>Codex</button>
              <button className={kind === "claude" ? "active" : ""} onClick={() => setKind("claude")}>Claude</button>
            </div>
          </div>
          <label><span>名稱</span><input value={mcpName} onChange={(e) => setMcpName(e.target.value)} placeholder="my-server" /></label>
          <label><span>Streamable HTTP URL</span><input value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} placeholder="https://…/mcp" /></label>
          <button className="primary full" onClick={addMcp}>新增 MCP</button>
        </div>
        <div className="section-card">
          <div className="section-title">
            <div><h3>安裝 Skill</h3><p>從 Git repository 安裝到遠端。</p></div>
            <span className="pill">SKILL.md</span>
          </div>
          <label><span>Skill 名稱</span><input value={skillName} onChange={(e) => setSkillName(e.target.value)} placeholder="research-professor" /></label>
          <label><span>Git URL</span><input value={skillRepo} onChange={(e) => setSkillRepo(e.target.value)} placeholder="https://github.com/…" /></label>
          <button className="primary full" onClick={installSkill}>安裝到 {kind === "codex" ? "Codex" : "Claude"}</button>
        </div>
      </div>
      <div className="section-card">
        <div className="section-title"><div><h3>目前安裝內容</h3><p>Codex MCP、Claude MCP、Skills 與 plugin manifests。</p></div></div>
        <pre className="result-console large">{raw || "尚無資料"}</pre>
      </div>
    </div>
  );
}

function SettingsView({
  session,
  doctor,
  addresses
}: {
  session: SessionInfo | null;
  doctor: DoctorReport | null;
  addresses: Address[];
}) {
  const [port, setPort] = useState(1455);
  const [forwards, setForwards] = useState<number[]>([]);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const refreshForwards = useCallback(async () => {
    if (!session) { setForwards([]); return; }
    try { setForwards(await window.agentBridge.oauth.list(session.sessionId)); } catch { setForwards([]); }
  }, [session]);

  useEffect(() => { void refreshForwards(); }, [refreshForwards]);

  const invalid = !Number.isInteger(port) || port < 1024 || port > 65535;

  return (
    <div className="view-shell">
      <div className="view-heading"><div><h2>設定</h2><p>連線、OAuth callback 與本機依賴狀態。</p></div></div>
      <div className="settings-grid">
        <div className="section-card">
          <div className="section-title">
            <div>
              <h3>OAuth Callback Forward</h3>
              <p>遠端 CLI 顯示 localhost callback port 時，在這裡建立本機 → 遠端轉發。</p>
            </div>
          </div>
          <div className="inline-field">
            <input
              type="number"
              aria-label="Callback port"
              min={1024}
              max={65535}
              value={Number.isNaN(port) ? "" : port}
              onChange={(e) => setPort(e.target.value === "" ? NaN : Number(e.target.value))}
            />
            <button
              className="primary"
              disabled={!session || invalid}
              onClick={async () => {
                if (!session || invalid) return;
                try {
                  await window.agentBridge.oauth.forward(session.sessionId, port);
                  setMessage({ tone: "success", text: `localhost:${port} 已轉發到遠端 localhost:${port}` });
                  await refreshForwards();
                } catch (error) {
                  setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
                }
              }}
            >
              建立 Forward
            </button>
          </div>
          {invalid && <p className="notice warning">Port 必須是 1024 到 65535 之間的整數。</p>}
          {message && <div className={`notice ${message.tone}`}>{message.text}</div>}

          {forwards.length > 0 && (
            <ul className="forward-list">
              {forwards.map((value) => (
                <li key={value}>
                  <code>localhost:{value}</code>
                  <span>→ 遠端 localhost:{value}</span>
                  <button
                    className="secondary compact"
                    onClick={async () => {
                      if (!session) return;
                      await window.agentBridge.oauth.close(session.sessionId, value);
                      await refreshForwards();
                    }}
                  >
                    關閉
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="notice">Codex 預設 :1455 會在 SSH 連線建立時自動嘗試轉發。</div>
        </div>
        <div className="section-card">
          <h3>本機網路</h3>
          <div className="plain-list">
            {addresses.map(a => <div key={a.name+a.address}><span>{a.name}</span><code>{a.address}</code><b>{a.kind}</b></div>)}
          </div>
        </div>
        <div className="section-card wide">
          <div className="section-title">
            <div><h3>Runtime Doctor</h3><p>元件、權限與端點狀態。</p></div>
          </div>
          {doctor
            ? <ul className="check-list">{doctor.checks.map((check) => <CheckRow key={check.id} check={check} />)}</ul>
            : <div className="empty-state">尚未檢查。</div>}
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number) {
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return value.toFixed(value >= 10 ? 1 : 2) + " " + units[i];
}

export { Icon, StatusDot, TerminalPane, ConnectionForm, FilesView, ComputerView, ExtensionsView, SettingsView, formatBytes };
export type { Profile, SessionInfo, Address, Agent };
