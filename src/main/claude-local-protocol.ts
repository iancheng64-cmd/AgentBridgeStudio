import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export interface ClaudeTransport extends EventEmitter { write(data: string): unknown }
/** Native Claude Code stream-json control channel. Credentials never traverse this class. */
export class ClaudeLocalProtocol extends EventEmitter {
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  constructor(private transport: ClaudeTransport) {
    super();
    transport.on("data", (chunk: Buffer | string) => this.push(chunk));
    transport.on("close", () => this.close(new Error("Claude Code 本機程序已結束。")));
    transport.on("error", () => this.close(new Error("Claude Code 本機通訊失敗。")));
  }
  request(subtype: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Claude Code 通道已關閉。"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Claude Code ${subtype} 回應逾時。`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ type: "control_request", request_id: id, request: { subtype, ...params } }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }
  respond(id: string, response: unknown) {
    this.write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
  }
  reject(id: string, error = "Client does not support this request") {
    this.write({ type: "control_response", response: { subtype: "error", request_id: id, error } });
  }
  user(content: unknown[], sessionId?: string) {
    this.write({ type: "user", uuid: randomUUID(), session_id: sessionId || "", parent_tool_use_id: null, message: { role: "user", content } });
  }
  private write(message: unknown) { if (this.closed) throw new Error("Claude Code 通道已關閉。"); this.transport.write(JSON.stringify(message) + "\n"); }
  private push(chunk: Buffer | string) {
    if (this.closed) return;
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) { this.close(new Error("Claude Code 單筆回應超過 32 MiB。")); return; }
    for (;;) {
      const newline = this.buffer.indexOf("\n"); if (newline < 0) break;
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: any;
      try { message = JSON.parse(line); } catch { this.close(new Error("Claude Code 傳回無效的 JSON 協定。")); return; }
      if (message.type === "control_response") {
        const reply = message.response; const pending = this.pending.get(reply?.request_id);
        if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(reply.request_id);
        reply.subtype === "success" ? pending.resolve(reply.response || {}) : pending.reject(new Error(typeof reply.error === "string" ? reply.error.slice(0, 1000) : "Claude Code 控制要求失敗。"));
      } else if (message.type === "control_request") this.emit("request", message);
      else this.emit("message", message);
    }
  }
  close(reason = new Error("Claude Code 通道已關閉。")) {
    if (this.closed) return; this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear(); this.emit("closed", reason);
  }
}
