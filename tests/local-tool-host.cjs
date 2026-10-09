const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { LocalToolHost } = require('../dist-main/local-tool-host.js');

async function fixture(options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbridge-mcp-'));
  const root = await fs.realpath(temp);
  const host = new LocalToolHost({ allowedRoots: [root], authorize: () => true, ...options });
  const endpoint = await host.start();
  let id = 0;
  const request = (method, params = {}, headers = {}) => fetch(endpoint.url, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const call = async (name, args) => (await (await request('tools/call', { name, arguments: args })).json()).result;
  return { host, endpoint, root, request, call, cleanup: async () => { await host.stop(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('all routes require authentication; origin/host validation; health has no credentials or local paths', async () => {
  const f = await fixture();
  try {
    for (const suffix of ['/health', '/mcp', '/missing']) assert.equal((await fetch(f.endpoint.url.replace('/mcp', suffix))).status, 401);
    assert.equal((await f.request('tools/list', {}, { Origin: 'http://localhost:5173' })).status, 403);
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const req = http.request(f.endpoint.url, { method: 'POST', headers: { Authorization: `Bearer ${f.endpoint.token}`, Host: 'evil.example', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });
    assert.equal(hostileHostStatus, 403);
    const health = await (await fetch(f.endpoint.url.replace('/mcp', '/health'), { headers: { Authorization: `Bearer ${f.endpoint.token}` } })).json();
    assert.equal(health.ok, true); assert.equal(health.computer, 'unavailable');
    assert.equal(JSON.stringify(health).includes(f.root), false); assert.equal(JSON.stringify(health).includes(f.endpoint.token), false);
    const init = await (await f.request('initialize', { protocolVersion: '2025-03-26' })).json();
    assert.equal(init.result.protocolVersion, '2025-03-26');
    const old = f.endpoint.token; await f.host.stop(); const newer = await f.host.start(); assert.notEqual(old, newer.token);
  } finally { await f.cleanup(); }
});

test('real file read/write/search/copy/move/delete plus traversal, symlink and readonly rejection', async () => {
  const readOnly = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbridge-readonly-'));
  const f = await fixture({ readOnlyRoots: [readOnly] });
  try {
    const file = path.join(f.root, '繁體.tsx');
    assert.equal((await f.call('mac_fs_write', { path: file, text: '實際本機內容' })).isError, undefined);
    assert.equal(JSON.parse((await f.call('mac_fs_read', { path: file })).content[0].text).text, '實際本機內容');
    assert.equal(JSON.parse((await f.call('mac_fs_search', { root: f.root, query: '*.tsx' })).content[0].text).matches[0], file);
    const copy = path.join(f.root, 'copy.txt'); const moved = path.join(f.root, 'moved.txt');
    assert.equal((await f.call('mac_fs_copy', { source: file, destination: copy })).isError, undefined);
    assert.equal((await f.call('mac_fs_move', { source: copy, destination: moved })).isError, undefined);
    assert.equal((await f.call('mac_fs_delete', { path: moved })).isError, undefined);
    assert.equal((await f.call('mac_fs_read', { path: path.join(f.root, '..', 'outside') })).isError, true);
    await fs.symlink(readOnly, path.join(f.root, 'escape'));
    assert.equal((await f.call('mac_fs_write', { path: path.join(f.root, 'escape', 'bad'), text: 'bad' })).isError, true);
    assert.equal((await f.call('mac_fs_write', { path: path.join(await fs.realpath(readOnly), 'bad'), text: 'bad' })).isError, true);
    await assert.rejects(fs.stat(path.join(readOnly, 'bad')), { code: 'ENOENT' });
    assert.equal((await f.call('mac_fs_delete', { path: f.root })).isError, true);
  } finally { await f.cleanup(); await fs.rm(readOnly, { recursive: true, force: true }); }
});

test('denied permission and timed-out approval never execute a write', async () => {
  let approve;
  const f = await fixture({ authorize: () => new Promise(resolve => { approve = resolve; }), requestTimeoutMs: 30 });
  try {
    const file = path.join(f.root, 'not-created');
    assert.equal((await f.call('mac_fs_write', { path: file, text: 'no' })).isError, true);
    approve(true); await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
  const denied = await fixture({ authorize: () => false });
  try { assert.match((await denied.call('mac_fs_list', { path: denied.root })).content[0].text, /permission denied/); }
  finally { await denied.cleanup(); }
});

test('stdio proxy correlates concurrent calls, keeps images, advertises only live tools, and cleans process', async () => {
  const program = `const r=require('readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='tools/list')result={tools:[{name:'inspect',inputSchema:{type:'object'},description:'fixture'}]};if(m.method==='tools/call')result={content:[{type:'text',text:String(m.params.arguments.number)},{type:'image',mimeType:'image/png',data:'AA=='}],structuredContent:{pid:process.pid}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`;
  const f = await fixture({ nativeCommand: { command: process.execPath, args: ['-e', program] } });
  try {
    assert.equal(f.host.status().computer, 'connected-permissions-unverified');
    const results = await Promise.all([1, 2, 3].map(number => f.call('mac_computer_inspect', { number })));
    assert.deepEqual(results.map(r => r.content[0].text), ['1', '2', '3']);
    assert.equal(results[0].content[1].type, 'image');
    const childPid = results[0].structuredContent.pid;
    await f.host.stop(); assert.equal(f.host.status().ok, false); assert.equal(f.host.listTools().length, 0);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally { await f.cleanup(); }
});

test('failed native executable does not claim computer readiness or block filesystem', async () => {
  const f = await fixture({ nativeCommand: { command: '/nonexistent/agentbridge-native' } });
  try { assert.equal(f.host.status().computer, 'unavailable'); assert.equal(f.host.listTools().some(t => t.name.startsWith('mac_computer_')), false); assert.equal((await f.call('mac_fs_list', { path: f.root })).isError, undefined); }
  finally { await f.cleanup(); }
});

test('shutdown invalidates outstanding approval before it can modify files', async () => {
  let approve; let requested;
  const seen = new Promise(resolve => { requested = resolve; });
  const f = await fixture({ authorize: () => new Promise(resolve => { approve = resolve; requested(); }) });
  try {
    const target = path.join(f.root, 'after-shutdown');
    const pending = f.call('mac_fs_write', { path: target, text: 'must not run' }).catch(() => undefined);
    await seen; await f.host.stop(); approve(true); await pending;
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('native timeout removes stale advertised tools and terminates its process', async () => {
  const program = `const r=require('readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined||m.method==='tools/call')return;process.stdout.write(JSON.stringify({id:m.id,result:m.method==='tools/list'?{tools:[{name:'hang',inputSchema:{type:'object'}}]}:{}})+'\\n')});`;
  // Leave enough headroom for process startup when the full test suite runs in parallel;
  // the fixture still verifies that a hung native tool is forcefully timed out and removed.
  const f = await fixture({ nativeCommand: { command: process.execPath, args: ['-e', program] }, requestTimeoutMs: 500 });
  try {
    assert.equal((await f.call('mac_computer_hang', {})).isError, true);
    assert.equal(f.host.status().computer, 'unavailable');
    assert.equal(f.host.listTools().some(t => t.name === 'mac_computer_hang'), false);
  } finally { await f.cleanup(); }
});

test('cancelActive invalidates approval but keeps authenticated endpoint and subsequent file calls alive', async () => {
  let approve; let requested; let block = true;
  const seen = new Promise(resolve => { requested = resolve; });
  const f = await fixture({ authorize: () => block ? new Promise(resolve => { approve = resolve; requested(); }) : true });
  try {
    const target = path.join(f.root, 'cancelled-turn');
    const pending = f.call('mac_fs_write', { path: target, text: 'must not run' });
    await seen; f.host.cancelActive(); approve(true);
    assert.equal((await pending).isError, true);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    block = false;
    assert.equal((await f.call('mac_fs_list', { path: f.root })).isError, undefined);
    assert.equal(f.host.status().ok, true);
  } finally { await f.cleanup(); }
});


test('Codex and Claude MCP hosts exchange messages through the shared bidirectional relay', async () => {
  const codex = await fixture({ agentRole: 'codex' });
  const claude = await fixture({ agentRole: 'claude' });
  const data = result => JSON.parse(result.content[0].text);
  try {
    assert.ok(codex.host.listTools().some(tool => tool.name === 'agentbridge_peer_send'));
    assert.ok(claude.host.listTools().some(tool => tool.name === 'agentbridge_peer_wait'));

    const codexStatus = data(await codex.call('agentbridge_peer_status', {}));
    assert.equal(codexStatus.role, 'codex');
    assert.equal(codexStatus.peerConnected, true);

    const opened = data(await codex.call('agentbridge_peer_open', { topic: 'relay integration test' }));
    const conversationId = opened.conversationId;
    const sent = data(await codex.call('agentbridge_peer_send', { conversation_id: conversationId, message: 'Hello from Codex' }));
    assert.equal(sent.deliveredTo, 'claude');

    const receivedByClaude = data(await claude.call('agentbridge_peer_read', { conversation_id: conversationId, after_seq: 0 }));
    assert.equal(receivedByClaude.messages.length, 1);
    assert.equal(receivedByClaude.messages[0].sender, 'codex');
    assert.equal(receivedByClaude.messages[0].text, 'Hello from Codex');

    const waitingForCodex = codex.call('agentbridge_peer_wait', { conversation_id: conversationId, after_seq: sent.seq, timeout_ms: 2000 });
    const reply = data(await claude.call('agentbridge_peer_send', { conversation_id: conversationId, message: 'Hello from Claude' }));
    assert.equal(reply.deliveredTo, 'codex');
    const receivedByCodex = data(await waitingForCodex);
    assert.equal(receivedByCodex.timedOut, false);
    assert.equal(receivedByCodex.messages[0].text, 'Hello from Claude');

    const transcript = data(await codex.call('agentbridge_peer_transcript', { conversation_id: conversationId }));
    assert.deepEqual(transcript.messages.map(message => message.sender), ['codex', 'claude']);
    assert.equal(data(await claude.call('agentbridge_peer_close', { conversation_id: conversationId })).closed, true);
  } finally {
    await claude.cleanup();
    const statusAfterClaudeStops = data(await codex.call('agentbridge_peer_status', {}));
    assert.equal(statusAfterClaudeStops.peerConnected, false);
    await codex.cleanup();
  }
});


test('private proxy health requires real calls and recovery replaces failed child without opening a second endpoint',async()=>{
 const program=`const r=require('readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='tools/list')result={tools:[{name:'doctor',inputSchema:{type:'object'}},{name:'browser_tabs',inputSchema:{type:'object'}}]};if(m.method==='tools/call')result={content:[],structuredContent:{permissions:{accessibilityTrusted:true,screenRecordingTrusted:false},pid:process.pid}};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')});`;
 const command={command:process.execPath,args:['-e',program]};const f=await fixture({nativeCommand:command,browserCommand:command});
 try{
  const initial=await f.host.toolHealth();assert.equal(initial.computer.permissions.screenRecordingTrusted,false);assert.equal(initial.browser.ok,true);const oldPid=initial.computer.pid;
  process.kill(oldPid,'SIGTERM');await new Promise(resolve=>setTimeout(resolve,40));await assert.rejects(f.host.computerDiagnostics(),/通道尚未啟動/);
  await f.host.recoverProxyTools();const after=await f.host.toolHealth();assert.notEqual(after.computer.pid,oldPid);assert.equal(f.host.status().ok,true);
  assert.equal((await f.request('tools/list')).status,200);assert.equal(f.host.status().unavailable.includes('computer'),false);
 }finally{await f.cleanup();}
});


test('filesystem root slash includes nested paths instead of requiring a double slash', async () => {
  const f = await fixture({allowedRoots:[path.parse(process.cwd()).root]});
  try { const result=await f.call('mac_fs_stat',{path:f.root});assert.equal(result.isError,undefined,result.content[0].text); }
  finally {await f.cleanup();}
});

test('explicit full access reaches outside the workspace and can be revoked live', async () => {
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'agentbridge-full-access-'));
  const f=await fixture({fullFilesystemAccess:true});
  try {
    const file=path.join(outside,'proof.txt');
    let result=await f.call('mac_fs_write',{path:file,text:'full access proof'});assert.equal(result.isError,undefined,result.content[0].text);
    assert.equal(JSON.parse((await f.call('mac_fs_read',{path:file})).content[0].text).text,'full access proof');
    const alias=path.join(f.root,'alias');await fs.symlink(outside,alias);
    assert.equal((await f.call('mac_fs_read',{path:path.join(alias,'proof.txt')})).isError,undefined);
    f.host.setFullFilesystemAccess(false);
    assert.equal((await f.call('mac_fs_read',{path:file})).isError,true);
    assert.equal((await f.call('mac_fs_write',{path:path.join(alias,'blocked'),text:'no'})).isError,true);
    f.host.setFullFilesystemAccess(true);
    assert.equal((await f.call('mac_fs_stat',{path:outside})).isError,undefined);
    assert.equal((await f.call('mac_fs_delete',{path:path.parse(outside).root})).isError,true);
  } finally {await f.cleanup();await fs.rm(outside,{recursive:true,force:true});}
});


test('administrator read requires full mode, ordinary authorization and explicit request', async () => {
  let calls=0,allowed=true;
  const f=await fixture({authorize:()=>allowed,administratorRead:async(action,target)=>{calls++;return {action,target};}});
  try {
    assert.equal((await f.call('mac_fs_stat',{path:'/fixture/system',administrator:true})).isError,true);assert.equal(calls,0);
    f.host.setFullFilesystemAccess(true);
    let result=await f.call('mac_fs_stat',{path:'/fixture/system',administrator:true});assert.equal(result.isError,undefined,result.content[0].text);assert.equal(calls,1);
    assert.equal(JSON.parse(result.content[0].text).action,'stat');
    allowed=false;assert.equal((await f.call('mac_fs_read',{path:'/fixture/system',administrator:true})).isError,true);assert.equal(calls,1);
  }finally{await f.cleanup();}
});
