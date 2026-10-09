import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";

/**
 * MCP exposure policy.
 *
 * The Studio bridges two unauthenticated MCP servers to a remote agent. How
 * widely those are reachable is a security decision, so it is an explicit,
 * visible setting rather than a constant buried in a spawn argument.
 *
 *   tailscale  — bind only the Tailnet address. The default, and the right
 *                answer whenever Tailscale is installed.
 *   lan        — bind only the LAN address.
 *   all        — bind 0.0.0.0, so LAN and Tailnet both reach it. Only sensible
 *                on a network you control.
 *   localhost  — bind loopback only; the remote agent must arrive via the SSH
 *                reverse tunnel.
 *
 * Public Internet exposure is deliberately not an option. A Computer Use MCP
 * with no authentication is a remote-control surface.
 */
export type ExposureMode = "tailscale" | "lan" | "all" | "localhost";

export interface ExposureState {
  mode: ExposureMode;
  bindHost: string;
  advertiseHost: string;
  /** Why a mode could not be honoured, e.g. Tailscale requested but not installed. */
  note?: string;
}

export const COMPUTER_USE_PORT = 8932;
export const BROWSER_USE_PORT = 8931;
export const OAUTH_DEFAULT_PORT = 1455;

export function readExposure(file: string): ExposureState {
  let mode: ExposureMode = "localhost";
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { mode?: string };
    if (parsed && ["tailscale", "lan", "all", "localhost"].includes(parsed.mode as string)) {
      mode = parsed.mode as ExposureMode;
    }
  } catch {
    /* first run — fall through to the default */
  }
  return resolveExposure(mode);
}

export function writeExposure(file: string, mode: ExposureMode): ExposureState {
  const state = resolveExposure(mode);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mode }, null, 2), "utf8");
  } catch {
    /* non-fatal: the mode still applies for this session */
  }
  return state;
}

function interfaceAddresses() {
  const found: { address: string; kind: "tailscale" | "lan" | "other" }[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const info of addrs || []) {
      if (info.family !== "IPv4" || info.internal) continue;
      const o = info.address.split(".").map(Number);
      const isTailscale = o[0] === 100 && o[1] >= 64 && o[1] <= 127;
      const isLan = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
      found.push({ address: info.address, kind: isTailscale ? "tailscale" : isLan ? "lan" : "other" });
    }
  }
  return found;
}

export function resolveExposure(mode: ExposureMode): ExposureState {
  const addrs = interfaceAddresses();
  const tailscale = addrs.find((a) => a.kind === "tailscale");
  const lan = addrs.find((a) => a.kind === "lan");

  // Advertise host is what the remote agent is told to dial. Tailscale wins
  // whenever it exists: the address is stable and reachable off-LAN.
  const advertiseHost = tailscale?.address || lan?.address || "127.0.0.1";

  switch (mode) {
    case "localhost":
      return { mode, bindHost: "127.0.0.1", advertiseHost };
    case "all":
      return { mode, bindHost: "0.0.0.0", advertiseHost };
    case "lan":
      return lan
        ? { mode, bindHost: lan.address, advertiseHost }
        : { mode, bindHost: "127.0.0.1", advertiseHost, note: "找不到 LAN IPv4 位址，已退回 localhost。" };
    case "tailscale":
    default:
      return tailscale
        ? { mode: "tailscale", bindHost: tailscale.address, advertiseHost }
        : lan
          ? { mode, bindHost: lan.address, advertiseHost, note: "Tailscale 未安裝，已改用 LAN 位址。" }
          : { mode, bindHost: "127.0.0.1", advertiseHost, note: "找不到 Tailscale 或 LAN 位址，服務僅限本機。" };
  }
}

/**
 * Supergateway's Streamable HTTP server has no bind-address flag — it always
 * takes every interface. Rather than give that up, keep it on loopback and
 * front it with a byte-forwarder bound to exactly the address the user chose.
 * No HTTP parsing here, so session semantics pass through untouched.
 */
export class BindRelay {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    readonly bindHost: string,
    readonly bindPort: number,
    private readonly upstreamPort: number,
    private readonly forceRelay = false
  ) {}

  start(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.forceRelay && (this.bindHost === "0.0.0.0" || this.bindHost === "127.0.0.1")) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      const server = net.createServer((client) => {
        const upstream = net.connect(this.upstreamPort, "127.0.0.1");
        this.sockets.add(client);
        this.sockets.add(upstream);
        const drop = () => {
          this.sockets.delete(client);
          this.sockets.delete(upstream);
          client.destroy();
          upstream.destroy();
        };
        client.on("error", drop);
        upstream.on("error", drop);
        client.on("close", drop);
        upstream.on("close", drop);
        client.pipe(upstream).pipe(client);
      });
      server.on("error", (error) => resolve({ ok: false, reason: error.message }));
      server.listen(this.bindPort, this.bindHost, () => resolve({ ok: true }));
      this.server = server;
    });
  }

  /** The port actually bound — resolves the OS-assigned port when asked for 0. */
  get port(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : undefined;
  }

  stop() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server?.close();
    this.server = undefined;
  }
}
