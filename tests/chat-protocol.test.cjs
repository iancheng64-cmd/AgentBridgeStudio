const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { ChatProtocol, buildChatCommand, shellQuote } = require("../dist-main/chat-protocol.js");

function jsonLine(event) {
  return `${JSON.stringify(event)}\n`;
}

test("Codex JSONL aggregates multiple assistant messages and reports tool activity", () => {
  const events = [];
  const pids = [];
  const protocol = new ChatProtocol((event) => events.push(event), (pid) => pids.push(pid));

  protocol.push([
    { type: "bridge.process", pid: 4210 },
    { type: "thread.started", thread_id: "thread_123" },
    { type: "item.started", item: { id: "answer-1", type: "agent_message", text: "第一段" } },
    { type: "item.updated", item: { id: "answer-1", type: "agent_message", text: "第一段已更新" } },
    { type: "item.started", item: { id: "tool-1", type: "mcp_tool_call", status: "in_progress" } },
    { type: "item.completed", item: { id: "answer-2", type: "agent_message", text: "第二段" } },
    { type: "turn.completed" }
  ].map(jsonLine).join(""));
  protocol.finish();

  assert.deepEqual(pids, [4210]);
  assert.ok(events.some((event) => event.type === "session" && event.conversationId === "thread_123"));
  assert.ok(events.some((event) => event.type === "activity" && event.itemId === "tool-1"));
  assert.deepEqual(events.filter((event) => event.type === "message").map((event) => event.text), [
    "第一段",
    "第一段已更新",
    "第一段已更新\n\n第二段"
  ]);
  assert.equal(protocol.didComplete, true);
  assert.equal(protocol.didFail, false);
});

test("JSONL decoder preserves CJK text split inside a UTF-8 code point", () => {
  const events = [];
  const protocol = new ChatProtocol((event) => events.push(event));
  const bytes = Buffer.from(jsonLine({
    type: "item.completed",
    item: { id: "utf8", type: "agent_message", text: "繁體中文與表情 🌏" }
  }));
  const split = bytes.indexOf(Buffer.from("體")) + 1;

  protocol.push(bytes.subarray(0, split));
  assert.equal(events.length, 0);
  protocol.push(bytes.subarray(split));
  protocol.finish();

  assert.equal(events.at(-1).text, "繁體中文與表情 🌏");
});

test("Claude partial text is replaced by its final assistant message without duplication", () => {
  const events = [];
  const protocol = new ChatProtocol((event) => events.push(event));
  const push = (event) => protocol.push(jsonLine(event));

  push({ type: "stream_event", event: { type: "message_start", message: { id: "msg-1" } } });
  push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "這是" } } });
  push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "部分文字" } } });
  push({ type: "assistant", message: { id: "msg-1", content: [{ type: "text", text: "這是完整的最終訊息" }] } });
  push({ type: "result", result: "這是完整的最終訊息" });

  assert.equal(events.filter((event) => event.type === "message").at(-1).text, "這是完整的最終訊息");
  assert.equal(protocol.didComplete, true);
  assert.equal(protocol.didFail, false);
});

test("CLI errors are surfaced and mark the protocol failed", () => {
  const events = [];
  const protocol = new ChatProtocol((event) => events.push(event));
  protocol.push(`${jsonLine({ type: "error", error: { message: "CLI 登入已失效" } })}not-json\n`);
  protocol.finish();

  assert.equal(protocol.didFail, true);
  assert.equal(protocol.didComplete, false);
  assert.ok(events.some((event) => event.type === "error" && event.text === "CLI 登入已失效"));
});

test("finish parses a final JSONL record without a trailing newline", () => {
  const events = [];
  const protocol = new ChatProtocol((event) => events.push(event));
  protocol.push(JSON.stringify({ type: "result", result: "完成" }));
  protocol.finish();

  assert.equal(protocol.didComplete, true);
  assert.ok(events.some((event) => event.type === "message" && event.text === "完成"));
});

test("Codex and Claude resume command arguments are present and conversation IDs are validated", () => {
  const codex = buildChatCommand({
    sessionId: "session-1",
    agent: "codex",
    prompt: "PROMPT_MUST_STAY_ON_STDIN",
    conversationId: "thread_resume_123",
    model: "gpt-6-luna"
  }, "/tmp/project directory");
  const claude = buildChatCommand({
    sessionId: "session-1",
    agent: "claude",
    prompt: "PROMPT_MUST_STAY_ON_STDIN",
    conversationId: "session_resume_456"
  }, "/tmp/project");

  assert.match(codex, /codex/);
  assert.match(codex, /resume/);
  assert.match(codex, /thread_resume_123/);
  assert.match(codex, /gpt-6-luna/);
  assert.match(claude, /claude/);
  assert.match(claude, /--resume/);
  assert.match(claude, /session_resume_456/);
  assert.doesNotMatch(codex, /PROMPT_MUST_STAY_ON_STDIN/);
  assert.throws(() => buildChatCommand({ sessionId: "s", agent: "codex", prompt: "", conversationId: "bad;id" }, "/tmp"), /對話識別碼無效/);
});

test("shell quoting keeps metacharacters literal and rejects NUL", () => {
  const value = "input'; printf INJECTED >&2; $(printf BAD)";
  const quoted = shellQuote(value);
  const output = execFileSync("bash", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  assert.equal(output, value);
  assert.throws(() => shellQuote("bad\0value"), /無效字元/);
});
