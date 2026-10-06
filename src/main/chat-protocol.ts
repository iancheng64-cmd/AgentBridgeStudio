/** CLI JSONL is deliberately separate from the terminal renderer. */
export type ChatAgent = "codex" | "claude";
export interface ChatInput {
  sessionId: string;
  agent: ChatAgent;
  prompt: string;
  requestId?: string;
  conversationId?: string;
  remoteCwd?: string;
  attachments?: Array<{ id: string }>;
  model?: string;
}
export interface ChatEvent {
  requestId: string;
  sessionId: string;
  type: "session" | "delta" | "message" | "activity" | "done" | "error";
  conversationId?: string;
  text?: string;
  itemId?: string;
  status?: string;
  code?: number | null;
}
export function shellQuote(value: string) {
  if (value.includes("\0")) throw new Error("參數包含無效字元。");
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
export function buildChatCommand(input: ChatInput, cwd: string) {
  if (!["codex", "claude"].includes(input.agent)) throw new Error("未知的助理。");
  if (input.conversationId && !/^[a-zA-Z0-9_-]{1,160}$/.test(input.conversationId)) throw new Error("對話識別碼無效。");
  const args = input.agent === "codex"
    ? ["codex", "exec", ...(input.conversationId ? ["resume", input.conversationId] : []), "--json", "--skip-git-repo-check", ...(input.model ? ["--model", input.model] : []), "-"]
    : ["claude", "--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages", ...(input.conversationId ? ["--resume", input.conversationId] : []), ...(input.model ? ["--model", input.model] : [])];
  // Login shells supply the same CLI PATH as a normal SSH login. Prompt only goes to stdin.
  const command = args.map(shellQuote).join(" ");
  const grouped = `printf '{"type":"bridge.process","pid":%s}\\n' "$$"; exec ${command}`;
  // macOS has no setsid executable. Bash monitor mode gives the background CLI its own
  // process group; explicit stdin redirection preserves the prompt pipe in that mode.
  const portable = `set -m; ${command} <&0 & agent_pid=$!; printf '{"type":"bridge.process","pid":%s}\\n' "$agent_pid"; trap 'kill -TERM -- -"$agent_pid" 2>/dev/null || true; exit 143' TERM HUP; wait "$agent_pid"; agent_status=$?; trap - TERM HUP; exit "$agent_status"`;
  return `bash -lc ${shellQuote(`cd -- ${shellQuote(cwd)} && if command -v setsid >/dev/null 2>&1; then exec setsid sh -c ${shellQuote(grouped)}; else ${portable}; fi`)}`;
}
export class ChatProtocol {
  private buffer = "";
  private decoder = new TextDecoder();
  private messages = new Map<string, string>();
  private claudeCurrentId = "assistant";
  private claudePartial = "";
  private failed = false;
  private complete = false;
  constructor(private send: (event: Omit<ChatEvent, "requestId" | "sessionId">) => void, private processStarted?: (pid: number) => void) {}
  get didFail() { return this.failed; }
  get didComplete() { return this.complete; }
  push(chunk: Uint8Array | string) {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.buffer.length > 8 * 1024 * 1024) throw new Error("助理回傳資料超過安全解析上限。");
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      this.line(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 1);
    }
  }
  finish() { this.buffer += this.decoder.decode(); if (this.buffer.trim()) this.line(this.buffer); this.buffer = ""; }
  private message(id: string, text: string) {
    this.messages.set(id, text);
    // A message event is the full assistant text for this request, not an appended chunk.
    this.send({ type: "message", itemId: id, text: [...this.messages.values()].filter(Boolean).join("\n\n") });
  }
  private line(line: string) {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "bridge.process" && Number.isSafeInteger(event.pid) && event.pid > 1) this.processStarted?.(event.pid);
    if (event.type === "thread.started") this.send({ type: "session", conversationId: event.thread_id });
    if (event.session_id) this.send({ type: "session", conversationId: event.session_id });
    if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
      const item = event.item || {};
      if (item.type === "agent_message" && typeof item.text === "string") this.message(item.id || "assistant", item.text);
      else if (["command_execution", "mcp_tool_call", "web_search", "file_change"].includes(item.type)) this.send({ type: "activity", text: ({command_execution:"正在執行指令",mcp_tool_call:"正在使用擴充工具",web_search:"正在搜尋",file_change:"正在編輯檔案"} as Record<string,string>)[item.type], status: item.status || event.type, itemId: item.id });
    }
    if (event.type === "stream_event") {
      const inner = event.event || {};
      if (inner.type === "message_start") { this.claudeCurrentId = inner.message?.id || "assistant"; this.claudePartial = ""; }
      if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta") {
        this.claudePartial += inner.delta.text || "";
        this.message(this.claudeCurrentId, this.claudePartial);
      }
      if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use") this.send({ type: "activity", text: `正在使用 ${inner.content_block.name || "工具"}` });
    }
    if (event.type === "assistant") {
      const parts = event.message?.content || [];
      const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
      if (text) this.message(event.message?.id || this.claudeCurrentId, text);
    }
    if (event.type === "turn.completed" || event.type === "result") this.complete = true;
    if (event.type === "error" || event.type === "turn.failed" || event.is_error) {
      this.failed = true;
      const detail = event.error?.message || event.message || event.result || event.errors?.join("\n");
      this.send({ type: "error", text: typeof detail === "string" ? detail : "助理無法完成這次回覆。" });
    } else if (event.type === "result" && event.result && !this.messages.size) this.message("assistant", event.result);
  }
}
