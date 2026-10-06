const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-runtime-'));
const handlers = new Map(); const events = []; const clients = [];
let currentKey = Buffer.from('fixture-host-key');
let runtimeVersion = '0.159.2'; let executorEnabled = false; let unexpectedMcp = false; let probeFailure = false; const executors = [];
class FakeExecutor {
  environmentId = 'fixture-mac-environment'; isRunning = true;
  constructor(installation, onClosed) { this.installation = installation; this.onClosed = onClosed; executors.push(this); }
  async start(cwd) { this.cwd = cwd; }
  async reverseForward() { return 'ws://127.0.0.1:45678'; }
  async register() { return { environmentId: this.environmentId, cwd: this.cwd, shell: { name: 'zsh', path: '/bin/zsh' } }; }
  stop() { this.isRunning = false; }
}
let account = { type: 'chatgpt', planType: 'pro', email: 'private', accessToken: 'private' };
let quotaResponse={},deferQuota=false,quotaError=false;const pendingQuotas=[];

class Channel extends EventEmitter {
  stderr = new EventEmitter();
  requests = [];
  closed = false;
  threads = new Map();
  probeCount = 0;
  constructor(output) { super(); this.output = output; }
  end() { queueMicrotask(() => { this.emit('data', Buffer.from(this.output)); this.emit('close', this.exitCode || 0); }); }
  write(line) {
    const request = JSON.parse(line); this.requests.push(request);
    if (request.id === undefined || !request.method) return;
    let thread;
    if (['thread/start','thread/resume'].includes(request.method)) {
      this.threadConfig = request.params.config;
      const id = request.params.ephemeral ? `fixture-probe-${++this.probeCount}` : 'fixture-thread';
      const environments = request.params.ephemeral && this.probeEnvironments !== undefined ? this.probeEnvironments
        : request.method === 'thread/resume' && this.resumeEnvironments !== undefined ? this.resumeEnvironments
        : request.params.environments || [{ environmentId: 'fixture-mac-environment' }];
      thread = { id, environments };
      this.threads.set(id, { config: this.threadConfig, environments });
    }
    const fixture = this.threads.get(request.params?.threadId);
    const macName = Object.keys((fixture?.config || this.threadConfig)?.mcp_servers || {}).find(name => name.startsWith('agentbridge_mac_'));
    const inventory = unexpectedMcp ? [{ name: 'unexpected_windows', tools: { dangerous: {} } }]
      : request.params?.threadId?.startsWith('fixture-probe-') && this.probeMacFailure ? [{ name: macName, runtimeStatus: 'failed', tools: {}, toolsError: 'probe failed' }]
      : macName ? [{ name: macName, runtimeStatus: fixture?.environments?.length === 0 ? 'disabled' : 'connected', tools: fixture?.environments?.length === 0 ? {} : { mac_fs_read: {} } }] : [];
    const result = request.method === 'initialize' ? { platformOs: 'windows' }
      : request.method === 'account/read' ? { account }
      : request.method === 'account/rateLimits/read' ? quotaResponse
      : request.method === 'model/list' ? { data: [{ id: request.params.cursor ? 'second' : 'first', model: 'fixture-model', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }] }], nextCursor: request.params.cursor ? null : 'page-2' }
      : request.method === 'config/read' ? { config: { mcp_servers: { original_windows: { command: 'forbidden', enabled: true } } } }
      : ['thread/start','thread/resume'].includes(request.method) ? { thread, model: request.params.model || 'fixture-model' }
      : request.method === 'mcpServerStatus/list' ? { data: inventory }
      : request.method === 'turn/start' ? { turn: { id: 'fixture-turn' } }
      : {};
    const rpcError = request.method === 'account/rateLimits/read' && quotaError ? 'quota failed'
      : request.method === 'thread/unsubscribe' && this.unsubscribeError ? 'unsubscribe failed' : undefined;
    const deliver=()=>this.emit('data',Buffer.from(JSON.stringify({id:request.id,...(rpcError?{error:{code:-1,message:rpcError}}:{result})})+'\n'));
    if(request.method==='account/rateLimits/read'&&deferQuota)pendingQuotas.push(deliver);else queueMicrotask(deliver);
  }
  close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
}
class Client extends EventEmitter {
  commands = [];
  constructor() { super(); clients.push(this); }
  connect(config) { queueMicrotask(() => config.hostVerifier(currentKey) ? this.emit('ready') : this.emit('error', new Error('host key rejected'))); }
  exec(command, _options, callback) {
    if(command==='uname -s'){this.commands.push(command);const channel=new Channel('');channel.exitCode=1;callback(null,channel);return;}
    const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le'); this.commands.push(script);
    if(script.includes('AGENTBRIDGE_WINDOWS')){callback(null,new Channel(probeFailure?'unknown OS':'AGENTBRIDGE_WINDOWS\r\n'));return;}
    const channel = new Channel(script.includes("'--version'") ? `codex-cli ${runtimeVersion}\n` : '--listen <URL> [default: stdio://]\n' + (executorEnabled ? '--code-mode-host <URL>' : ''));
    if (!script.includes("'--version'") && !script.includes("'--help'")) this.channel = channel;
    callback(null, channel);
  }
  end() { this.ended = true; this.channel?.close(); this.emit('close'); }
}
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
  if (request === 'electron') return { app: { getPath: () => root, getVersion: () => 'test' }, dialog: {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
  if (request === 'ssh2') return { Client };
  if (request === './local-exec-server') return { LocalExecServer: FakeExecutor };
  if (request === './local-code-mode-host') return { ...originalLoad.apply(this, arguments), findHostInstallation: async version => ({ executable: 'fixture-helper', codexExecutable: 'fixture-codex', version }) };
  return originalLoad.apply(this, arguments);
};
const backend = require('../dist-main/runtime-backend.js');
Module._load = originalLoad;
const deps = { connectConfig: () => ({}), emit: (_channel, payload) => events.push(payload), window: () => null };
backend.registerRuntimeBackend(deps);
const invoke = (name, ...args) => handlers.get('runtime:' + name)({}, ...args);
const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Runtime test condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const input = { profile: { host: 'fixture.local', port: 22, name: 'Fixture' }, platform: 'windows', localCwd: root };
after(() => { backend.stopAllRuntimes(deps); fs.rmSync(root, { recursive: true, force: true }); });

test('host identity confirmation precedes any remote command; account/models connect without pretending local tools are ready', async () => {
  const challenge = await invoke('connect', input);
  assert.equal(challenge.status, 'host-confirmation'); assert.equal(challenge.hostChanged, false);
  assert.equal(clients.at(-1).commands.length, 0); assert.equal(clients.at(-1).ended, true);
  const state = await invoke('connect', { ...input, trustedFingerprint: challenge.hostFingerprint });
  assert.equal(state.status, 'connected'); assert.equal(state.runtimePlatform, 'windows');
  assert.equal(state.capabilities.localTools, false); assert.equal(state.toolExecution, 'unavailable');
  assert.equal(state.account.authenticated, true); assert.equal(state.models.length, 2);
  assert.equal(JSON.stringify(state).includes('private'), false);
  const channel = clients.at(-1).channel;
  await assert.rejects(invoke('send', { runtimeId: state.runtimeId, prompt: 'hello' }), /工具執行通道/);
  assert.equal(channel.requests.some(r => ['thread/start', 'thread/resume', 'turn/start'].includes(r.method)), false);
  assert.deepEqual(await invoke('cancel', state.runtimeId, 'missing'), { cancelled: false });
  channel.emit('data', Buffer.from('{"method":"account/updated","params":{"authMode":null,"planType":null}}\n'));
  assert.deepEqual(events.at(-1).snapshot.account, { authenticated: false, type: 'none' });
  channel.emit('data', Buffer.from('{"id":"credential","method":"account/chatgptAuthTokens/refresh"}\n'));
  assert.ok(channel.requests.at(-1).error); assert.equal(JSON.stringify(channel.requests.at(-1)).includes('private'), false);
  channel.emit('data', Buffer.from('{"id":"foreign","method":"item/commandExecution/requestApproval","params":{"threadId":"foreign"}}\n'));
  assert.ok(channel.requests.at(-1).error);
  await invoke('disconnect', state.runtimeId); await invoke('disconnect', state.runtimeId);
  await assert.rejects(invoke('status', state.runtimeId), /先連線/);
});

test('stored host fingerprint allows reconnect but a changed host key requires a new confirmation', async () => {
  const state = await invoke('connect', input); assert.equal(state.status, 'connected');
  const client = clients.at(-1);
  client.emit('error', new Error('fixture transport failure'));
  assert.equal(events.at(-1).type, 'closed'); assert.equal(client.ended, true);
  currentKey = Buffer.from('replacement-host-key');
  const challenge = await invoke('connect', input);
  assert.equal(challenge.hostChanged, true); assert.notEqual(challenge.hostFingerprint, challenge.previousFingerprint);
  assert.equal(clients.at(-1).commands.length, 0);
});

test('Code Mode JS host alone never advertises a verified Mac execution route', () => {
  assert.equal(backend.localToolCapability(true).localTools, false);
  assert.equal(backend.localToolCapability(false).localTools, false);
  assert.match(backend.localToolCapability(true).reason, /Runtime 主機/);
});

 test('validated executor enables bound Mac turns and its loss closes Runtime', async () => {
  executorEnabled = true;
  const state = await invoke('connect', { ...input, trustedFingerprint: backend.hostFingerprint(currentKey) });
  const client = clients.at(-1); const executor = executors.at(-1);
  assert.equal(state.executorConnected, true); assert.equal(state.executorVersion, '0.159.2');
  assert.equal(state.codeModeHostConnected, false); assert.equal(state.capabilities.localTools, true);
  assert.equal(state.capabilities.fileShell, true);
  assert.ok(client.commands.some(command => command.includes('features.deferred_executor=true') && command.includes('features.plugins=false')));
  await invoke('send', { runtimeId: state.runtimeId, prompt: 'hello' });
  await waitFor(() => client.channel.requests.some(request => request.method === 'turn/start'));
  const start = client.channel.requests.find(request => request.method === 'thread/start');
  assert.equal(start.params.environments[0].environmentId, executor.environmentId);
  assert.equal(start.params.config.mcp_servers.original_windows.enabled, false);
  const turn = client.channel.requests.find(request => request.method === 'turn/start');
  assert.equal(turn.params.environments[0].environmentId, executor.environmentId);
  assert.equal(turn.params.input[0].text, 'hello');
  client.channel.emit('data', Buffer.from(JSON.stringify({ id: 'remote-command', method: 'item/commandExecution/requestApproval', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', environmentId: 'wrong' } })+'\n'));
  assert.ok(client.channel.requests.at(-1).error);
  client.channel.emit('data', Buffer.from(JSON.stringify({ id: 'mac-command', method: 'item/commandExecution/requestApproval', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', environmentId: executor.environmentId, command: 'pwd' } })+'\n'));
  const approval = events.at(-1); assert.equal(approval.executionLocation, 'local');
  await invoke('respond', { runtimeId: state.runtimeId, approvalId: approval.approvalId, decision: 'accept' });
  assert.equal(client.channel.requests.find(request => request.id === 'mac-command' && request.result)?.result.decision, 'accept');
  executor.onClosed('executor fixture stopped');
  assert.equal(client.ended, true); assert.equal(executor.isRunning, false);
  await assert.rejects(invoke('status', state.runtimeId), /先連線/);
  executorEnabled = false;
});

test('unexpected Runtime MCP capability prevents model turn startup', async () => {
  executorEnabled = true; unexpectedMcp = true;
  const state = await invoke('connect', { ...input, trustedFingerprint: backend.hostFingerprint(currentKey) });
  const client = clients.at(-1);
  await invoke('send', { runtimeId: state.runtimeId, prompt: 'hello' });
  await waitFor(() => events.some(event => event.runtimeId === state.runtimeId && event.type === 'error' && /非 Mac 工具/.test(event.text)));
  assert.equal(client.channel.requests.some(request => request.method === 'turn/start'), false);
  assert.ok(events.some(event => event.runtimeId === state.runtimeId && event.type === 'error' && /非 Mac 工具/.test(event.text)));
  await invoke('disconnect', state.runtimeId); executorEnabled = false; unexpectedMcp = false;
});

test('0.160 unloaded resume verifies a Mac-bound ephemeral thread before starting the original turn', async () => {
  executorEnabled = true; runtimeVersion = '0.160.0';
  const state = await invoke('connect', { ...input, permissionMode: 'full' });
  const client = clients.at(-1); const channel = client.channel;
  channel.resumeEnvironments = [];
  try {
    await invoke('send', { runtimeId: state.runtimeId, prompt: 'continue', conversationId: 'fixture-thread', model: 'fixture-model' });
    await waitFor(() => channel.requests.some(r => r.method === 'turn/start'));
    const requests = channel.requests;
    const resume = requests.find(r => r.method === 'thread/resume');
    const probe = requests.find(r => r.method === 'thread/start' && r.params.ephemeral);
    const unsubscribe = requests.find(r => r.method === 'thread/unsubscribe');
    const turn = requests.find(r => r.method === 'turn/start');
    assert.equal(resume.params.environments, undefined);
    assert.deepEqual(probe.params.config, resume.params.config);
    assert.equal(probe.params.config.mcp_servers.original_windows.enabled, false);
    const mac = Object.values(probe.params.config.mcp_servers).find(server => server.environment_id);
    assert.equal(mac.environment_id, executors.at(-1).environmentId);
    assert.equal(probe.params.model, 'fixture-model');
    assert.equal(probe.params.approvalPolicy, 'never');
    assert.equal(probe.params.sandbox, 'danger-full-access');
    assert.deepEqual(probe.params.environments, [{ environmentId: executors.at(-1).environmentId, cwd: fs.realpathSync(root) }]);
    assert.equal(unsubscribe.params.threadId, 'fixture-probe-1');
    assert.ok(requests.indexOf(probe) < requests.indexOf(unsubscribe));
    assert.ok(requests.some(r => r.method === 'mcpServerStatus/list' && r.params.threadId === unsubscribe.params.threadId));
    assert.ok(requests.indexOf(unsubscribe) < requests.indexOf(turn));
    assert.equal(turn.params.threadId, 'fixture-thread');
    assert.deepEqual(turn.params.environments, probe.params.environments);
    assert.equal(requests.filter(r => r.method === 'turn/start').length, 1);
    assert.equal(client.ended, undefined);
  } finally {
    await invoke('disconnect', state.runtimeId); runtimeVersion = '0.159.2'; executorEnabled = false;
  }
});

test('0.160 new and already bound threads start without an ephemeral probe', async () => {
  executorEnabled = true; runtimeVersion = '0.160.0';
  const state = await invoke('connect', input); const channel = clients.at(-1).channel;
  try {
    await invoke('send', { runtimeId: state.runtimeId, prompt: 'new' });
    await waitFor(() => channel.requests.some(r => r.method === 'turn/start'));
    channel.emit('data', Buffer.from(JSON.stringify({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } } }) + '\n'));
    await invoke('send', { runtimeId: state.runtimeId, prompt: 'continue', conversationId: 'fixture-thread' });
    await waitFor(() => channel.requests.filter(r => r.method === 'turn/start').length === 2);
    assert.equal(channel.requests.some(r => r.method === 'thread/start' && r.params.ephemeral), false);
  } finally {
    await invoke('disconnect', state.runtimeId); runtimeVersion = '0.159.2'; executorEnabled = false;
  }
});

test('0.160 foreign or unverifiable resumed environments stop the Runtime before any model turn', async () => {
  executorEnabled = true; runtimeVersion = '0.160.0';
  try {
    for (const environments of [[{ environmentId: 'remote-windows' }], null]) {
      const state = await invoke('connect', input); const client = clients.at(-1);
      client.channel.resumeEnvironments = environments;
      await invoke('send', { runtimeId: state.runtimeId, prompt: 'continue', conversationId: 'fixture-thread' });
      await waitFor(() => client.ended);
      assert.equal(client.channel.requests.some(r => r.method === 'turn/start'), false);
      assert.equal(client.channel.requests.some(r => r.method === 'thread/start'), false);
      assert.ok(events.some(event => event.runtimeId === state.runtimeId && event.type === 'error' && /執行環境/.test(event.text)));
    }
  } finally { runtimeVersion = '0.159.2'; executorEnabled = false; }
});

test('resume preflight failures unsubscribe the probe and prevent inference', async () => {
  executorEnabled = true; runtimeVersion = '0.160.0';
  try {
    for (const failure of ['probeMacFailure', 'unsubscribeError', 'probeEnvironments']) {
      const state = await invoke('connect', input); const client = clients.at(-1); const channel = client.channel;
      channel.resumeEnvironments = [];
      channel[failure] = failure === 'probeEnvironments' ? [{ environmentId: 'remote-windows' }] : true;
      await invoke('send', { runtimeId: state.runtimeId, prompt: 'continue', conversationId: 'fixture-thread' });
      await waitFor(() => client.ended);
      assert.equal(channel.requests.some(r => r.method === 'turn/start'), false);
      assert.equal(channel.requests.find(r => r.method === 'thread/unsubscribe').params.threadId, 'fixture-probe-1');
    }
  } finally { runtimeVersion = '0.159.2'; executorEnabled = false; }
});

test('background discussion resumes through the same Mac preflight and keeps its permission policy', async () => {
  executorEnabled = true; runtimeVersion = '0.160.0';
  const state = await invoke('connect', input); const channel = clients.at(-1).channel;
  channel.resumeEnvironments = [];
  try {
    const resultPromise = backend.runCodexBackgroundTurn({ runtimeId: state.runtimeId, prompt: 'continue discussion', conversationId: 'fixture-thread' });
    await waitFor(() => channel.requests.some(r => r.method === 'turn/start'));
    const probe = channel.requests.find(r => r.method === 'thread/start' && r.params.ephemeral);
    assert.equal(probe.params.approvalPolicy, 'untrusted');
    assert.equal(probe.params.sandbox, 'read-only');
    assert.ok(channel.requests.find(r => r.method === 'thread/unsubscribe'));
    channel.emit('data', Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'fixture-thread', itemId: 'fixture-message', delta: 'Discussion resumed.' } }) + '\n'));
    channel.emit('data', Buffer.from(JSON.stringify({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } } }) + '\n'));
    const result = await resultPromise;
    assert.equal(result.status, 'completed'); assert.equal(result.text, 'Discussion resumed.');
    assert.equal(result.conversationId, 'fixture-thread');
  } finally {
    await invoke('disconnect', state.runtimeId); runtimeVersion = '0.159.2'; executorEnabled = false;
  }
});

test('matching verified 0.160.0 starts the Mac executor and unknown future versions remain unavailable', async () => {
  executorEnabled = true; runtimeVersion = '0.160.0';
  const current = await invoke('connect', { ...input, trustedFingerprint: backend.hostFingerprint(currentKey) });
  assert.equal(current.executorConnected, true); assert.equal(current.executorVersion, '0.160.0');
  assert.equal(current.capabilities.localTools, true); assert.equal(current.codeModeHostConnected, false);
  await invoke('disconnect', current.runtimeId);
  const count = executors.length; runtimeVersion = '0.161.0';
  const future = await invoke('connect', input);
  assert.equal(future.executorConnected, false); assert.equal(future.codeModeHostConnected, false);
  assert.equal(future.capabilities.localTools, false); assert.match(future.capabilities.reason, /0.161.0/);
  assert.equal(executors.length, count);
  await assert.rejects(invoke('send', { runtimeId: future.runtimeId, prompt: 'hello' }), /尚未完成/);
  await invoke('disconnect', future.runtimeId); runtimeVersion = '0.159.2'; executorEnabled = false;
});
test('automatic platform detection waits for trusted host confirmation before any remote probe',async()=>{
 const target={...input,platform:'auto',profile:{...input.profile,host:'auto-fixture.local'}};
 const challenge=await invoke('connect',target);assert.equal(challenge.status,'host-confirmation');assert.equal(clients.at(-1).commands.length,0);
 const state=await invoke('connect',{...target,trustedFingerprint:challenge.hostFingerprint});const client=clients.at(-1);
 assert.equal(state.status,'connected');assert.equal(state.runtimePlatform,'windows');assert.equal(state.connectionPlatform,'windows');assert.equal(client.commands[0],'uname -s');assert.match(client.commands[1],/AGENTBRIDGE_WINDOWS/);
 assert.match(client.commands[2],/'codex' '--version'/);await invoke('disconnect',state.runtimeId);
 const count=executors.length;probeFailure=true;
 try{await assert.rejects(invoke('connect',target),/無法自動辨識/);assert.equal(clients.at(-1).commands.length,2);assert.equal(clients.at(-1).ended,true);assert.equal(executors.length,count);}finally{probeFailure=false;}
});
test('quota IPC reads the remote account and rolling events retain all buckets while refetching the full snapshot',async()=>{
 quotaResponse={accountId:'private-account',accessToken:'private-token',ordinaryUsageAllowed:true,rateLimitsByLimitId:{codex:{limitName:'Codex',primary:{usedPercent:20,resetsAt:2000,windowDurationMins:300},secondary:{usedPercent:30,resetsAt:3000,windowDurationMins:10080}},extra:{primary:{usedPercent:50,resetsAt:4000}}}};
 const state=await invoke('connect',input),client=clients.at(-1);
 try{
  const full=await invoke('usage',state.runtimeId);assert.equal(full.available,true);assert.equal(full.buckets.length,2);assert.ok(!JSON.stringify(full).includes('private'));
  quotaResponse={...quotaResponse,rateLimitsByLimitId:{...quotaResponse.rateLimitsByLimitId,codex:{...quotaResponse.rateLimitsByLimitId.codex,primary:{usedPercent:22,resetsAt:2000,windowDurationMins:300}}}};
  const count=client.channel.requests.filter(request=>request.method==='account/rateLimits/read').length;
  client.channel.emit('data',Buffer.from(JSON.stringify({method:'account/rateLimits/updated',params:{rateLimits:{limitId:'codex',limitName:null,primary:{usedPercent:22,resetsAt:null,windowDurationMins:null},secondary:null}}})+'\n'));
  const rolling=events.at(-1).quota;assert.equal(rolling.buckets.length,2);assert.equal(rolling.buckets[0].primary.remainingPercent,78);assert.equal(rolling.buckets[0].primary.resetsAt,2000);assert.equal(rolling.buckets[0].secondary.remainingPercent,70);assert.equal(rolling.ordinaryUsageAllowed,true);
  assert.equal(client.channel.requests.filter(request=>request.method==='account/rateLimits/read').length,count+1);
  await waitFor(()=>events.at(-1).quota?.buckets[0]?.primary?.remainingPercent===78);await new Promise(resolve=>setImmediate(resolve));
  quotaError=true;const failure=await invoke('usage',state.runtimeId);assert.equal(failure.available,false);assert.match(failure.error,/更新重試/);assert.equal(failure.lastKnown.buckets.length,2);
 }finally{quotaError=false;quotaResponse={};await invoke('disconnect',state.runtimeId);}
});
test('account change invalidates in-flight quota reads and removes the old account fallback',async()=>{
 quotaResponse={rateLimits:{primary:{usedPercent:50}}};const state=await invoke('connect',input),client=clients.at(-1);
 try{
  assert.equal((await invoke('usage',state.runtimeId)).available,true);deferQuota=true;const old=invoke('usage',state.runtimeId);
  await waitFor(()=>pendingQuotas.length===1);
  client.channel.emit('data',Buffer.from(JSON.stringify({method:'account/updated',params:{authMode:null,planType:null}})+'\n'));
  pendingQuotas.shift()();const late=await old;assert.equal(late.available,false);assert.equal(late.resetBaseline,true);assert.equal(late.lastKnown,undefined);
  const loggedOut=await invoke('usage',state.runtimeId);assert.equal(loggedOut.available,false);assert.equal(loggedOut.lastKnown,undefined);assert.match(loggedOut.error,/尚未登入/);
 }finally{deferQuota=false;quotaResponse={};await invoke('disconnect',state.runtimeId);}
});


test('live full permission closes a pending Mac approval, accepts subsequent Mac operations, retains questions and rejects foreign environments',async()=>{
 executorEnabled=true;const state=await invoke('connect',{...input,permissionMode:'ask'}),client=clients.at(-1);const channel=client.channel;
 try{
  await invoke('send',{runtimeId:state.runtimeId,prompt:'fixture'});await waitFor(()=>channel.requests.some(r=>r.method==='turn/start'));
  const emitRequest=(id,method,extra={})=>channel.emit('data',Buffer.from(JSON.stringify({id,method,params:{threadId:'fixture-thread',turnId:'fixture-turn',environmentId:executors.at(-1).environmentId,...extra}})+'\n'));
  emitRequest('pending-full','item/commandExecution/requestApproval',{command:'pwd'});assert.equal(events.at(-1).type,'approval');
  const snapshot=await invoke('permission',state.runtimeId,'full');assert.equal(snapshot.permissionMode,'full');assert.throws(()=>invoke('permission',state.runtimeId,'ask'),/先停止/);assert.equal(channel.requests.find(r=>r.id==='pending-full').result.decision,'accept');
  emitRequest('next-full','item/commandExecution/requestApproval',{command:'pwd'});assert.equal(channel.requests.find(r=>r.id==='next-full').result.decision,'accept');
  emitRequest('foreign-full','item/commandExecution/requestApproval',{environmentId:'remote-untrusted'});assert.ok(channel.requests.find(r=>r.id==='foreign-full').error);
  emitRequest('question-full','item/tool/requestUserInput',{questions:[{id:'q',question:'Which project?'}]});assert.equal(channel.requests.some(r=>r.id==='question-full'),false);assert.equal(events.at(-1).type,'userInput');
  assert.throws(()=>invoke('permission',state.runtimeId,'invalid'),/有效/);
  channel.emit('data',Buffer.from(JSON.stringify({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed'}}})+'\n'));
  await invoke('send',{runtimeId:state.runtimeId,prompt:'next',conversationId:'fixture-thread'});await waitFor(()=>channel.requests.some(r=>r.method==='thread/resume'));
  const resume=channel.requests.find(r=>r.method==='thread/resume');assert.equal(resume.params.approvalPolicy,'never');assert.equal(resume.params.sandbox,'danger-full-access');
 }finally{await invoke('disconnect',state.runtimeId);executorEnabled=false;}
});
