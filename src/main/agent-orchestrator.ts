import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { agentRelayHub, type AgentRelayRole } from "./agent-relay";
import { runCodexBackgroundTurn, cancelCodexBackgroundTurn } from "./runtime-backend";
import { runClaudeBackgroundTurn, cancelClaudeBackgroundTurn } from "./claude-local-backend";

interface OrchestratorDependencies {
  emit(channel: string, payload: unknown): void;
}

interface OrchestratorInput {
  codexRuntimeId: string;
  claudeRuntimeId: string;
  topic: string;
  rounds?: number;
  leadAgent?: AgentRelayRole;
  codexModel?: string;
  claudeModel?: string;
  codexEffort?: string;
  claudeEffort?: string;
}

interface OrchestratorRun {
  id: string;
  relayConversationId: string;
  input: Required<Pick<OrchestratorInput, "codexRuntimeId" | "claudeRuntimeId" | "topic">> & Omit<OrchestratorInput, "codexRuntimeId" | "claudeRuntimeId" | "topic"> & { rounds: number; leadAgent: AgentRelayRole };
  cancelled: boolean;
  activeAgent?: AgentRelayRole;
  codexConversationId?: string;
  claudeConversationId?: string;
}

const runs = new Map<string, OrchestratorRun>();
const MAX_ROUNDS = 8;
const MAX_TOPIC_CHARS = 20_000;
const MAX_CONTEXT_CHARS = 28_000;

const peerOf = (agent: AgentRelayRole): AgentRelayRole => agent === "codex" ? "claude" : "codex";
const label = (agent: AgentRelayRole) => agent === "codex" ? "Codex" : "Claude";

function text(value: unknown, name: string, max: number) {
  if (typeof value !== "string") throw new Error(`${name} 格式無效。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${name} 長度必須介於 1 到 ${max} 個字元。`);
  return normalized;
}

function optionalText(value: unknown, name: string, max = 200) {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, name, max);
}

function clip(value: string, max = MAX_CONTEXT_CHARS) {
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.65);
  const tail = max - head;
  return value.slice(0, head) + "\n\n[中間內容因上下文限制省略]\n\n" + value.slice(-tail);
}

function checkCancelled(run: OrchestratorRun) {
  if (run.cancelled) throw new Error("AUTO_DISCUSSION_CANCELLED");
}

function emit(deps: OrchestratorDependencies, run: OrchestratorRun, payload: Record<string, unknown>) {
  deps.emit("orchestrator:event", { runId: run.id, conversationId: run.relayConversationId, ...payload });
}

async function turn(run: OrchestratorRun, agent: AgentRelayRole, prompt: string) {
  checkCancelled(run);
  run.activeAgent = agent;
  const requestId = randomUUID();
  if (agent === "codex") {
    const result = await runCodexBackgroundTurn({
      runtimeId: run.input.codexRuntimeId,
      requestId,
      prompt,
      conversationId: run.codexConversationId,
      model: run.input.codexModel,
      effort: run.input.codexEffort
    });
    run.codexConversationId = result.conversationId;
    return result.text;
  }
  const result = await runClaudeBackgroundTurn({
    runtimeId: run.input.claudeRuntimeId,
    requestId,
    prompt,
    conversationId: run.claudeConversationId,
    model: run.input.claudeModel,
    effort: run.input.claudeEffort
  });
  run.claudeConversationId = result.conversationId;
  return result.text;
}

function openingPrompt(run: OrchestratorRun, agent: AgentRelayRole, round: number) {
  return [
    `You are ${label(agent)} in an automatic cross-model discussion with ${label(peerOf(agent))}.`,
    `User topic: ${run.input.topic}`,
    `Exchange ${round} of ${run.input.rounds}.`,
    "Give your own substantive analysis first. Identify assumptions, trade-offs, failure modes, and concrete implementation implications where relevant.",
    "Do not use tools, browse, execute commands, inspect files, or ask the user questions. This is a text-only reasoning discussion.",
    "Do not merely agree. State where another strong model might reasonably disagree.",
    "Keep the response focused so the peer can critique it in the next turn."
  ].join("\n\n");
}

function replyPrompt(run: OrchestratorRun, agent: AgentRelayRole, peerText: string, round: number) {
  return [
    `Continue the cross-model discussion on this user topic: ${run.input.topic}`,
    `Exchange ${round} of ${run.input.rounds}. The latest message from ${label(peerOf(agent))} is below:`,
    "----- peer message -----",
    clip(peerText),
    "----- end peer message -----",
    `Respond as ${label(agent)}. Critique the peer's strongest claims, correct errors, preserve good ideas, and advance the discussion toward a more robust answer.`,
    "Do not use tools or ask the user questions. Return text only."
  ].join("\n\n");
}

function synthesisPrompt(run: OrchestratorRun, lead: AgentRelayRole, peerText: string) {
  return [
    `The automatic ${label(lead)} ↔ ${label(peerOf(lead))} discussion is complete.`,
    `Original user topic: ${run.input.topic}`,
    `The peer's final position is:`,
    "----- peer final position -----",
    clip(peerText),
    "----- end peer final position -----",
    "Using the full discussion context already present in this conversation, produce the final synthesis for the user.",
    "Separate: (1) points of agreement, (2) meaningful disagreements or uncertainty, (3) the integrated conclusion / implementation plan.",
    "Do not claim consensus where there was none. Do not use tools. Return only the final user-facing synthesis."
  ].join("\n\n");
}

async function execute(run: OrchestratorRun, deps: OrchestratorDependencies) {
  const lead = run.input.leadAgent;
  const peer = peerOf(lead);
  let lastByLead = "";
  let lastByPeer = "";
  try {
    emit(deps, run, { type: "started", topic: run.input.topic, rounds: run.input.rounds, leadAgent: lead, modelCalls: run.input.rounds * 2 + 1 });
    for (let round = 1; round <= run.input.rounds; round++) {
      checkCancelled(run);
      emit(deps, run, { type: "activity", round, agent: lead, text: `${label(lead)} 正在進行第 ${round} 輪分析…` });
      lastByLead = await turn(run, lead, round === 1 ? openingPrompt(run, lead, round) : replyPrompt(run, lead, lastByPeer, round));
      checkCancelled(run);
      agentRelayHub.send(lead, run.relayConversationId, lastByLead);
      emit(deps, run, { type: "turn", round, agent: lead, text: lastByLead });

      emit(deps, run, { type: "activity", round, agent: peer, text: `${label(peer)} 正在回應第 ${round} 輪…` });
      lastByPeer = await turn(run, peer, replyPrompt(run, peer, lastByLead, round));
      checkCancelled(run);
      agentRelayHub.send(peer, run.relayConversationId, lastByPeer);
      emit(deps, run, { type: "turn", round, agent: peer, text: lastByPeer });
    }

    checkCancelled(run);
    emit(deps, run, { type: "activity", round: run.input.rounds + 1, agent: lead, text: `${label(lead)} 正在整理雙方結論…` });
    const final = await turn(run, lead, synthesisPrompt(run, lead, lastByPeer));
    checkCancelled(run);
    emit(deps, run, { type: "final", agent: lead, text: final });
    agentRelayHub.close(lead, run.relayConversationId);
    emit(deps, run, { type: "done", status: "completed", final });
  } catch (error) {
    const cancelled = run.cancelled || (error instanceof Error && error.message === "AUTO_DISCUSSION_CANCELLED");
    if (!cancelled) emit(deps, run, { type: "error", text: error instanceof Error ? error.message : String(error) });
    try { agentRelayHub.close(run.input.leadAgent, run.relayConversationId); } catch {}
    emit(deps, run, { type: "done", status: cancelled ? "cancelled" : "error" });
  } finally {
    run.activeAgent = undefined;
    runs.delete(run.id);
  }
}

export function registerAgentOrchestrator(deps: OrchestratorDependencies) {
  ipcMain.handle("orchestrator:start", (_event, raw: OrchestratorInput) => {
    const topic = text(raw?.topic, "討論主題", MAX_TOPIC_CHARS);
    const codexRuntimeId = text(raw?.codexRuntimeId, "Codex Runtime ID", 128);
    const claudeRuntimeId = text(raw?.claudeRuntimeId, "Claude Runtime ID", 128);
    const rounds = raw.rounds === undefined ? 3 : raw.rounds;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) throw new Error(`討論輪數必須介於 1 到 ${MAX_ROUNDS} 輪。`);
    const leadAgent: AgentRelayRole = raw.leadAgent === "claude" ? "claude" : "codex";
    const id = randomUUID();
    const relay = agentRelayHub.create(leadAgent, topic.slice(0, 500));
    const run: OrchestratorRun = {
      id,
      relayConversationId: relay.conversationId,
      cancelled: false,
      input: {
        codexRuntimeId,
        claudeRuntimeId,
        topic,
        rounds,
        leadAgent,
        codexModel: optionalText(raw.codexModel, "Codex 模型"),
        claudeModel: optionalText(raw.claudeModel, "Claude 模型"),
        codexEffort: optionalText(raw.codexEffort, "Codex 思考強度", 40),
        claudeEffort: optionalText(raw.claudeEffort, "Claude 思考強度", 40)
      }
    };
    runs.set(id, run);
    setImmediate(() => { void execute(run, deps); });
    return { runId: id, conversationId: run.relayConversationId, rounds, modelCalls: rounds * 2 + 1 };
  });

  ipcMain.handle("orchestrator:cancel", async (_event, runId: string) => {
    const run = runs.get(runId);
    if (!run) return { cancelled: false };
    run.cancelled = true;
    if (run.activeAgent === "codex") await cancelCodexBackgroundTurn(run.input.codexRuntimeId);
    if (run.activeAgent === "claude") await cancelClaudeBackgroundTurn(run.input.claudeRuntimeId);
    return { cancelled: true };
  });

  ipcMain.handle("orchestrator:status", (_event, runId?: string) => {
    if (runId) {
      const run = runs.get(runId);
      return run ? { runId: run.id, conversationId: run.relayConversationId, activeAgent: run.activeAgent, cancelled: run.cancelled, topic: run.input.topic, rounds: run.input.rounds } : null;
    }
    return [...runs.values()].map(run => ({ runId: run.id, conversationId: run.relayConversationId, activeAgent: run.activeAgent, cancelled: run.cancelled, topic: run.input.topic, rounds: run.input.rounds }));
  });
}
