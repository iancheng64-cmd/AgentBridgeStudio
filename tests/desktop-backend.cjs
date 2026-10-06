const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-backend-'));
const handlers = new Map();
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    app: { getPath: () => path.join(root, 'userData') },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
  };
  return originalLoad.call(this, name, ...args);
};
const { registerDesktopBackend } = require('../dist-main/desktop-backend.js');
Module._load = originalLoad;
const events = [], uploads = [], commands = [];
let mode = 'success';
let capturedPrompt = '';
const conn = { exec(command, options, callback) {
  if (typeof options === 'function') callback = options;
  commands.push(command);
  const channel = new EventEmitter();
  channel.stderr = new EventEmitter();
  channel.close = () => channel.emit('close', null);
  channel.signal = () => {};
  channel.resume = () => {};
  channel.end = (prompt) => {
    capturedPrompt = prompt;
    if (mode === 'failure') { channel.emit('close', 1); return; }
    channel.emit('data', Buffer.from(JSON.stringify({type:'thread.started',thread_id:'session-123'})+'\n'));
    channel.emit('data', Buffer.from(JSON.stringify({type:'item.completed',item:{id:'msg',type:'agent_message',text:'你好'}})+'\n'));
    channel.emit('data', Buffer.from('{"type":"turn.completed"}\n'));
    channel.emit('close', 0);
    channel.emit('close', 0); // duplicate close must not emit a second terminal event.
  };
  callback(null, channel);
} };
registerDesktopBackend({
  session: (id) => id === 'ssh-1' ? {id, conn, remoteHome:'/home/test'} : undefined,
  window: () => null,
  emit: (channel, payload) => events.push({channel,...payload}),
  upload: async (session, localPath, remotePath, signal) => {
    assert(!signal?.aborted);
    assert(fs.existsSync(localPath));
    uploads.push({localPath,remotePath});
  }
});
const call = (name, ...args) => handlers.get(name)({}, ...args);
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const source = path.join(root, '資料 $(touch nope).txt');
  fs.writeFileSync(source, '附件內容');
  const [file] = await call('library:addPaths', [source]);
  assert.equal(file.name, path.basename(source));
  assert.notEqual(file.localPath, source);
  fs.writeFileSync(source, '外部修改');
  assert.equal(fs.readFileSync(file.localPath, 'utf8'), '附件內容');
  assert.deepEqual(await call('library:choose'), []);
  assert.equal(call('library:list').length, 1);
  assert.throws(() => call('chat:send', {sessionId:'missing',agent:'codex',prompt:'hello'}), /連線/);
  await call('chat:send', {sessionId:'ssh-1',requestId:'test-1',agent:'codex',prompt:'請讀附件 $(uname)',attachments:[{id:file.id}]});
  await flush();
  assert.equal(uploads.length, 1);
  assert(capturedPrompt.includes(uploads[0].remotePath));
  assert(capturedPrompt.includes('$(uname)'));
  assert(!commands[0].includes('$(uname)'));
  assert.equal(events.filter(e => e.requestId === 'test-1' && e.type === 'done').length, 1);
  assert.equal(events.find(e => e.type === 'done').status, 'completed');
  assert.equal(events.find(e => e.type === 'session').conversationId, 'session-123');
  assert.equal(call('library:list')[0].remoteSessionId, 'ssh-1');
  await call('chat:send', {sessionId:'ssh-1',requestId:'cancelled',agent:'claude',prompt:'cancel me'});
  assert(call('chat:cancel', 'cancelled').cancelled);
  await flush();
  assert.equal(events.find(e => e.requestId === 'cancelled' && e.type === 'done').status, 'cancelled');
  assert.equal(commands.length, 1);
  mode = 'failure';
  await call('chat:send', {sessionId:'ssh-1',requestId:'failed',agent:'codex',prompt:'fail'});
  await flush();
  assert.equal(events.find(e => e.requestId === 'failed' && e.type === 'done').status, 'error');
  assert.equal(call('library:remove', file.id).length, 0);
  assert(fs.existsSync(source));
  assert(!fs.existsSync(file.localPath));
  console.log('PASS: library managed copies, persistence/removal, upload-before-send, stdin-only prompt, session events, completion, early cancellation, and CLI failure.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, {recursive:true,force:true}));
