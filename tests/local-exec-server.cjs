const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { LocalExecServer, parseExecutorListener } = require('../dist-main/local-exec-server.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-executor-test-'));
const executable = path.join(root, 'fake-codex');
fs.writeFileSync(executable, '#!/usr/bin/env node\nprocess.stdout.write("ws://127.0.0.1:49123\\n");process.stdin.resume();\n', { mode: 0o755 });
const installation = { codexExecutable: executable, executable: '', version: '0.159.2' };
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('executor listener accepts only a valid loopback websocket announcement', () => {
  assert.equal(parseExecutorListener('startup\nws://127.0.0.1:4567\n'), 4567);
  for (const output of ['ws://0.0.0.0:1234', 'ws://127.0.0.1:0', 'ws://127.0.0.1:65536', 'http://127.0.0.1:12', 'ws://127.0.0.1:1/private']) assert.equal(parseExecutorListener(output), undefined);
});

test('registration authenticates the executor but requires the exact canonical Mac cwd', async () => {
  const executor = new LocalExecServer(installation, () => {}); const calls = [];
  try {
    await executor.start(root);
    const rpc = { request: async (method, params) => { calls.push({ method, params }); return method === 'environment/info' ? { cwd: pathToFileURL(fs.realpathSync(root)).href, shell: { name: 'zsh', path: '/bin/zsh' } } : {}; } };
    const result = await executor.register(rpc, executor.localUrl);
    assert.equal(result.shell.name, 'zsh'); assert.equal(calls.length, 2);
    assert.match(calls[0].params.authBearerToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.stringify(result).includes(calls[0].params.authBearerToken), false);
    await assert.rejects(executor.register(rpc, 'ws://192.168.1.10:1234'), /loopback/);
    await assert.rejects(executor.register({ request: async method => method === 'environment/info' ? { cwd: 'file:///wrong', shell: { name: 'zsh', path: '/bin/zsh' } } : {} }, executor.localUrl), /不符合此 Mac/);
  } finally { executor.stop(); }
});

test('reverse forwarding only accepts its own loopback port and removes listener on stop', async () => {
  class Connection extends EventEmitter {
    forwardIn(host, port, callback) { assert.equal(host, '127.0.0.1'); assert.equal(port, 0); callback(null, 45678); }
    unforwardIn(host, port, callback) { this.removed = { host, port }; callback(); }
  }
  const executor = new LocalExecServer(installation, () => {}); const conn = new Connection();
  try {
    await executor.start(root); assert.equal(await executor.reverseForward(conn), 'ws://127.0.0.1:45678');
    let rejected = 0;
    conn.emit('tcp connection', { destIP: '0.0.0.0', destPort: 45678 }, () => assert.fail('must not accept public address'), () => rejected++);
    conn.emit('tcp connection', { destIP: '127.0.0.1', destPort: 1234 }, () => assert.fail('must not accept another port'), () => rejected++);
    assert.equal(rejected, 2); executor.stop();
    assert.equal(conn.listenerCount('tcp connection'), 0); assert.deepEqual(conn.removed, { host: '127.0.0.1', port: 45678 });
  } finally { executor.stop(); }
});

test('unexpected executor termination invokes fail-closed hook; intentional stop does not', async () => {
  let calls = 0; let closed; const done = new Promise(resolve => closed = resolve);
  const executor = new LocalExecServer(installation, () => { calls++; closed(); });
  await executor.start(root); executor.child.kill('SIGTERM'); await done;
  assert.equal(calls, 1); assert.equal(executor.isRunning, false); executor.stop();
  const stopped = new LocalExecServer(installation, () => assert.fail('intentional shutdown is not unexpected'));
  await stopped.start(root); stopped.stop();
});

test('a resumed Mac environment can rebind its historical identifier only after canonical cwd verification',async()=>{
 const executor=new LocalExecServer(installation,()=>{}),calls=[];
 const old='agentbridge-mac-11111111-2222-4333-8444-555555555555';
 try{await executor.start(root);const rpc={request:async(method,params)=>{calls.push({method,params});return method==='environment/info'?{cwd:pathToFileURL(fs.realpathSync(root)).href,shell:{name:'zsh',path:'/bin/zsh'}}:{};}};
 await executor.register(rpc,executor.localUrl,old);assert.equal(executor.environmentId,old);assert.equal(calls[0].params.environmentId,old);
 await executor.register(rpc,executor.localUrl,old);assert.equal(calls.filter(c=>c.method==='environment/add').length,1,'repeated resume reuses the verified registration');
 await assert.rejects(executor.register(rpc,executor.localUrl,'foreign-runtime'),/識別碼/);
 const current=executor.environmentId;await assert.rejects(executor.register({request:async method=>method==='environment/info'?{cwd:'file:///wrong',shell:{name:'zsh',path:'/bin/zsh'}}:{}},executor.localUrl,'agentbridge-mac-66666666-7777-4888-9999-000000000000'),/不符合此 Mac/);assert.equal(executor.environmentId,current);
 }finally{executor.stop();}
});
