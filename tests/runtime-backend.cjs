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
  async register(_rpc,_url,environmentId) { if(environmentId)this.environmentId=environmentId;return { environmentId: this.environmentId, cwd: this.cwd, shell: { name: 'zsh', path: '/bin/zsh' } }; }
  stop() { this.isRunning = false; }
}
let account = { type: 'chatgpt', planType: 'pro', email: 'private', accessToken: 'private' };
let failResume=false;let resumeEnvironment;
let quotaResponse={},deferQuota=false,quotaError=false;const pendingQuotas=[];

class Channel extends EventEmitter {
  stderr = new EventEmitter();
  requests = [];
  closed = false;
  constructor(output) { super(); this.output = output; }
  end() { queueMicrotask(() => { this.emit('data', Buffer.from(this.output)); this.emit('close', this.exitCode || 0); }); }
  write(line) {
    const request = JSON.parse(line); this.requests.push(request);
    if (request.id === undefined || !request.method) return;
    if (['thread/start','thread/resume'].includes(request.method)) this.threadConfig = request.params.config;
    const macName = Object.keys(this.threadConfig?.mcp_servers || {}).find(name => name.startsWith('agentbridge_mac_'));
    const result = request.method === 'initialize' ? { platformOs: 'windows' }
      : request.method === 'account/read' ? { account }
      : request.method === 'account/rateLimits/read' ? quotaResponse
      : request.method === 'model/list' ? { data: [{ id: request.params.cursor ? 'second' : 'first', model: 'fixture-model', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }] }], nextCursor: request.params.cursor ? null : 'page-2' }
      : request.method === 'config/read' ? { config: { mcp_servers: { original_windows: { command: 'forbidden', enabled: true } } } }
      : ['thread/start','thread/resume'].includes(request.method) ? { thread: { id: 'fixture-thread' } }
      : request.method === 'mcpServerStatus/list' ? { data: unexpectedMcp ? [{ name: 'unexpected_windows', tools: { dangerous: {} } }] : macName ? [{ name: macName,runtimeStatus:resumeEnvironment&&this.threadConfig.mcp_servers[macName].environment_id!==resumeEnvironment?'disabled':'ready', tools: resumeEnvironment&&this.threadConfig.mcp_servers[macName].environment_id!==resumeEnvironment?{}:{ mac_fs_read: {} } }] : [] }
      : request.method === 'turn/start' ? { turn: { id: 'fixture-turn' } }
      : {};
    const deliver=()=>this.emit('data',Buffer.from(JSON.stringify({id:request.id,...(request.method==='thread/resume'&&failResume?{error:{code:-32600,message:'no rollout found for thread id missing-thread'}}:request.method==='account/rateLimits/read'&&quotaError?{error:{code:-1,message:'quota failed'}}:{result})})+'\n'));
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

test('missing remote rollout offers recovery without replaying tools or dropping the connected runtime',async()=>{
 executorEnabled=true;failResume=true;const state=await invoke('connect',input),channel=clients.at(-1).channel;
 try{await invoke('send',{runtimeId:state.runtimeId,prompt:'next',conversationId:'missing-thread'});await waitFor(()=>events.some(e=>e.runtimeId===state.runtimeId&&e.type==='done'));
 assert.ok(events.some(e=>e.runtimeId===state.runtimeId&&e.type==='sessionUnavailable'&&e.conversationId==='missing-thread'));
 assert.equal(channel.requests.some(r=>r.method==='turn/start'),false);assert.equal((await invoke('status',state.runtimeId)).status,'connected');
 }finally{failResume=false;executorEnabled=false;await invoke('disconnect',state.runtimeId);}
});
test('native retry notifications do not poison a subsequently successful turn; quota codes get a specific message',async()=>{
 executorEnabled=true;const state=await invoke('connect',input),channel=clients.at(-1).channel;
 const emit=(method,params)=>channel.emit('data',Buffer.from(JSON.stringify({method,params:{threadId:'fixture-thread',...params}})+'\n'));
 try{await invoke('send',{runtimeId:state.runtimeId,prompt:'fixture'});await waitFor(()=>channel.requests.some(r=>r.method==='turn/start'));
 emit('error',{willRetry:true,error:{message:'stream disconnected, retrying'}});
 emit('turn/completed',{turn:{id:'fixture-turn',status:'completed'}});
 assert.equal(events.filter(e=>e.runtimeId===state.runtimeId&&e.type==='done').at(-1).status,'completed');
 await invoke('send',{runtimeId:state.runtimeId,prompt:'again'});await waitFor(()=>channel.requests.filter(r=>r.method==='turn/start').length===2);
 emit('turn/completed',{turn:{id:'fixture-turn',status:'failed',error:{codexErrorInfo:'UsageLimitExceeded'}}});
 assert.match(events.filter(e=>e.runtimeId===state.runtimeId&&e.type==='error').at(-1).text,/額度已用完/);
 }finally{executorEnabled=false;await invoke('disconnect',state.runtimeId);}
});

test('stopping before initialization completes releases the turn and the same Runtime can resume',async()=>{
 executorEnabled=true;const state=await invoke('connect',{...input,trustedFingerprint:backend.hostFingerprint(currentKey)}),channel=clients.at(-1).channel;
 const start=await invoke('send',{runtimeId:state.runtimeId,requestId:'early-stop',prompt:'first'});
 assert.equal((await invoke('cancel',state.runtimeId,start.requestId)).cancelled,true);
 await waitFor(()=>events.some(e=>e.requestId==='early-stop'&&e.type==='done'&&e.status==='cancelled'));
 assert.equal(channel.requests.some(r=>r.method==='turn/start'),false);
 await invoke('send',{runtimeId:state.runtimeId,requestId:'after-early-stop',prompt:'continue'});
 await waitFor(()=>channel.requests.some(r=>r.method==='turn/start'));
 await invoke('disconnect',state.runtimeId);
});

test('cold resume rebinds the saved Mac executor before validating MCP and starting a model turn',async()=>{
 executorEnabled=true;resumeEnvironment='agentbridge-mac-11111111-2222-4333-8444-555555555555';const state=await invoke('connect',input),channel=clients.at(-1).channel;
 try{await invoke('send',{runtimeId:state.runtimeId,requestId:'cold-resume',prompt:'remember',conversationId:'fixture-thread',executorEnvironmentId:resumeEnvironment});
 await waitFor(()=>events.some(e=>e.requestId==='cold-resume'&&e.type==='error')||channel.requests.some(r=>r.method==='turn/start'));
 assert.ok(channel.requests.some(r=>r.method==='turn/start'),'cold resume must reach the model turn without disabling Mac MCP');
 const cfg=channel.requests.find(r=>r.method==='thread/resume').params.config.mcp_servers;assert.equal(Object.values(cfg).find(x=>x.enabled).environment_id,resumeEnvironment);assert.equal(channel.requests.find(r=>r.method==='turn/start').params.environments[0].environmentId,resumeEnvironment);
 }finally{resumeEnvironment=undefined;executorEnabled=false;await invoke('disconnect',state.runtimeId);}
});

test('stopping during turn start still releases the turn when the runtime never reports completion',async()=>{
 executorEnabled=true;const state=await invoke('connect',{...input,trustedFingerprint:backend.hostFingerprint(currentKey)}),channel=clients.at(-1).channel;
 try{
  const start=await invoke('send',{runtimeId:state.runtimeId,requestId:'mid-stop',prompt:'first'});
  await waitFor(()=>channel.requests.some(r=>r.method==='turn/start'));
  assert.equal((await invoke('cancel',state.runtimeId,start.requestId)).cancelled,true);
  await waitFor(()=>events.some(e=>e.requestId==='mid-stop'&&e.type==='done'&&e.status==='cancelled'),8000);
  await invoke('send',{runtimeId:state.runtimeId,requestId:'after-mid-stop',prompt:'continue'});
  await waitFor(()=>channel.requests.filter(r=>r.method==='turn/start').length===2);
 }finally{executorEnabled=false;await invoke('disconnect',state.runtimeId);}
});

test('a late turn completion after the release fallback does not emit a second done',async()=>{
 executorEnabled=true;const state=await invoke('connect',{...input,trustedFingerprint:backend.hostFingerprint(currentKey)}),channel=clients.at(-1).channel;
 try{
  const start=await invoke('send',{runtimeId:state.runtimeId,requestId:'late-stop',prompt:'first'});
  await waitFor(()=>channel.requests.some(r=>r.method==='turn/start'));
  assert.equal((await invoke('cancel',state.runtimeId,start.requestId)).cancelled,true);
  await waitFor(()=>events.some(e=>e.requestId==='late-stop'&&e.type==='done'&&e.status==='cancelled'),8000);
  channel.emit('data',Buffer.from(JSON.stringify({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed'}}})+'\n'));
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(events.filter(e=>e.requestId==='late-stop'&&e.type==='done').length,1,'late completion must not double-fire done');
 }finally{executorEnabled=false;await invoke('disconnect',state.runtimeId);}
});

test('cancelling a background discussion turn resolves even when the runtime never reports completion',async()=>{
 executorEnabled=true;const state=await invoke('connect',{...input,trustedFingerprint:backend.hostFingerprint(currentKey)}),channel=clients.at(-1).channel;
 try{
  const started=backend.runCodexBackgroundTurn({runtimeId:state.runtimeId,prompt:'discuss'});
  await waitFor(()=>channel.requests.some(r=>r.method==='turn/start'));
  assert.deepEqual(await backend.cancelCodexBackgroundTurn(state.runtimeId),{cancelled:true});
  // Cancel may race the in-flight turn/start: either a resolved cancelled result
  // or a rejected "turn interrupted" is acceptable. Hanging forever is not.
  const result=await Promise.race([started.then(value=>value,()=>'rejected'),new Promise(resolve=>setTimeout(()=>resolve('TIMED_OUT'),3000))]);
  assert.notEqual(result,'TIMED_OUT','background turn must settle on cancel instead of hanging');
  if(result!=='rejected')assert.equal(result.status,'cancelled');
 }finally{executorEnabled=false;await invoke('disconnect',state.runtimeId);}
});
