const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const handlers = new Map();
const events = [];
const codexCalls = [];
const claudeCalls = [];
const relay = { sends: [], closes: [], counter: 0 };
let blockedReject = null;
let cancelCodexCount = 0;
let cancelClaudeCount = 0;

const fakeRelay = {
  create(role, topic) {
    return { conversationId: 'relay-' + (++relay.counter), role, topic };
  },
  send(role, conversationId, message) {
    relay.sends.push({ role, conversationId, message });
    return { deliveredTo: role === 'codex' ? 'claude' : 'codex' };
  },
  close(role, conversationId) {
    relay.closes.push({ role, conversationId });
    return { closed: true };
  }
};

async function fakeCodex(input) {
  codexCalls.push(input);
  if (input.prompt.includes('BLOCK_FOR_CANCEL')) {
    return new Promise((_resolve, reject) => { blockedReject = reject; });
  }
  const index = codexCalls.length;
  return {
    requestId: input.requestId,
    conversationId: input.conversationId || 'codex-thread',
    text: index === 3 ? 'Codex final synthesis' : 'Codex response ' + index,
    status: 'completed'
  };
}

async function fakeClaude(input) {
  claudeCalls.push(input);
  const index = claudeCalls.length;
  return {
    requestId: input.requestId,
    conversationId: input.conversationId || 'claude-thread',
    text: 'Claude response ' + index,
    status: 'completed'
  };
}

const originalLoad = Module._load;
Module._load = function(request, parent, main) {
  if (request === 'electron') return { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
  if (request === './agent-relay') return { agentRelayHub: fakeRelay };
  if (request === './runtime-backend') return {
    runCodexBackgroundTurn: fakeCodex,
    cancelCodexBackgroundTurn: async () => {
      cancelCodexCount++;
      if (blockedReject) { const reject = blockedReject; blockedReject = null; reject(new Error('cancelled')); }
      return { cancelled: true };
    }
  };
  if (request === './claude-local-backend') return {
    runClaudeBackgroundTurn: fakeClaude,
    cancelClaudeBackgroundTurn: async () => { cancelClaudeCount++; return { cancelled: true }; }
  };
  return originalLoad.apply(this, arguments);
};
const orchestrator = require('../dist-main/agent-orchestrator.js');
Module._load = originalLoad;

orchestrator.registerAgentOrchestrator({ emit: (_channel, payload) => events.push(payload) });
const invoke = (name, ...args) => handlers.get('orchestrator:' + name)({}, ...args);
const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for orchestrator');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test('orchestrator alternates Codex and Claude, preserves each model session, and synthesizes once', async () => {
  events.length = 0; codexCalls.length = 0; claudeCalls.length = 0; relay.sends.length = 0; relay.closes.length = 0;
  const started = await invoke('start', {
    codexRuntimeId: 'codex-runtime',
    claudeRuntimeId: 'claude-runtime',
    topic: 'Design a robust bridge',
    rounds: 2,
    leadAgent: 'codex',
    codexModel: 'gpt-test',
    claudeModel: 'claude-test'
  });
  assert.equal(started.rounds, 2);
  assert.equal(started.modelCalls, 5);
  await waitFor(() => events.some(event => event.runId === started.runId && event.type === 'done'));

  assert.equal(codexCalls.length, 3);
  assert.equal(claudeCalls.length, 2);
  assert.equal(codexCalls[0].conversationId, undefined);
  assert.equal(codexCalls[1].conversationId, 'codex-thread');
  assert.equal(codexCalls[2].conversationId, 'codex-thread');
  assert.equal(claudeCalls[0].conversationId, undefined);
  assert.equal(claudeCalls[1].conversationId, 'claude-thread');
  assert.match(claudeCalls[0].prompt, /Codex response 1/);
  assert.match(codexCalls[1].prompt, /Claude response 1/);
  assert.match(codexCalls[2].prompt, /final synthesis/i);

  assert.equal(relay.sends.length, 4);
  assert.deepEqual(relay.sends.map(item => item.role), ['codex', 'claude', 'codex', 'claude']);
  assert.equal(relay.closes.length, 1);
  assert.equal(events.filter(event => event.type === 'turn').length, 4);
  assert.equal(events.filter(event => event.type === 'final').length, 1);
  assert.equal(events.find(event => event.type === 'final').text, 'Codex final synthesis');
  assert.equal(events.find(event => event.type === 'done').status, 'completed');
  assert.equal(await invoke('status', started.runId), null);
});

test('orchestrator validates round bounds before starting model work', () => {
  assert.throws(() => invoke('start', { codexRuntimeId: 'c', claudeRuntimeId: 'd', topic: 'x', rounds: 0 }), /1 到 8/);
  assert.throws(() => invoke('start', { codexRuntimeId: 'c', claudeRuntimeId: 'd', topic: 'x', rounds: 9 }), /1 到 8/);
});

test('orchestrator cancel interrupts the active model and reports cancelled', async () => {
  events.length = 0; codexCalls.length = 0; claudeCalls.length = 0; cancelCodexCount = 0; cancelClaudeCount = 0;
  const started = await invoke('start', {
    codexRuntimeId: 'codex-runtime',
    claudeRuntimeId: 'claude-runtime',
    topic: 'BLOCK_FOR_CANCEL',
    rounds: 1,
    leadAgent: 'codex'
  });
  await waitFor(() => codexCalls.length === 1);
  assert.deepEqual(await invoke('cancel', started.runId), { cancelled: true });
  await waitFor(() => events.some(event => event.runId === started.runId && event.type === 'done'));
  assert.equal(cancelCodexCount, 1);
  assert.equal(cancelClaudeCount, 0);
  assert.equal(events.find(event => event.runId === started.runId && event.type === 'done').status, 'cancelled');
});
