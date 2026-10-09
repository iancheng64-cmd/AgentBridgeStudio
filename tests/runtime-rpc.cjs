const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { AppServerRpc, appServerCommand, chooseStdioFlag, accountSummary, accountUpdateSummary, modelSummary } = require('../dist-main/app-server-rpc.js');

class Transport extends EventEmitter {
  writes = [];
  closeCount = 0;
  write(line) { this.writes.push(JSON.parse(line)); }
  close() { this.closeCount++; this.emit('close'); }
}

test('RPC preserves fragmented UTF-8 and interleaved responses, notifications and server requests', async () => {
  const channel = new Transport(); const rpc = new AppServerRpc(channel);
  const seen = [];
  rpc.on('notification', value => seen.push(value));
  rpc.on('request', value => rpc.respond(value.id, { currentTimeAt: 123 }));
  const a = rpc.request('a'); const b = rpc.request('b');
  const bytes = Buffer.from('{"id":2,"result":"繁體中文"}\n{"method":"notice"}\n{"id":"server-1","method":"currentTime/read"}\n{"id":1,"result":{"ok":true}}\n');
  for (let i = 0; i < bytes.length; i += 2) channel.emit('data', bytes.subarray(i, i + 2));
  assert.equal(await b, '繁體中文'); assert.deepEqual(await a, { ok: true });
  assert.deepEqual(seen, [{ method: 'notice' }]);
  assert.deepEqual(channel.writes[2], { id: 'server-1', result: { currentTimeAt: 123 } });
  rpc.close(); rpc.close(); assert.equal(channel.closeCount, 1);
});

test('RPC rejects pending calls and closes transport after a malformed frame', async () => {
  const channel = new Transport(); const rpc = new AppServerRpc(channel);
  const pending = rpc.request('waiting'); const failed = assert.rejects(pending, /非 JSON/);
  channel.emit('data', 'unexpected banner\n');
  await failed;
  assert.equal(rpc.isClosed, true); assert.equal(channel.closeCount, 1);
  await assert.rejects(rpc.request('after'), /未連線/);
});

test('RPC timeout removes only its pending request and remote errors remain errors', async () => {
  const channel = new Transport(); const rpc = new AppServerRpc(channel);
  await assert.rejects(rpc.request('slow', {}, 5), /逾時/);
  channel.emit('data', '{"id":1,"result":"late"}\n');
  const pending = rpc.request('next');
  channel.emit('data', '{"id":2,"error":{"code":-1,"message":"remote failure"}}\n');
  await assert.rejects(pending, /remote failure/);
  const malformed = rpc.request('missing');
  channel.emit('data', '{"id":3}\n');
  await assert.rejects(malformed, /缺少/); rpc.close();
});

test('PowerShell command keeps executable and every argument literal', () => {
  const executable = "C:\\Program Files\\O'Brien\\codex.exe";
  const text = appServerCommand('windows', executable, ['app-server', '--listen', 'stdio://']);
  const script = Buffer.from(text.split(' ').at(-1), 'base64').toString('utf16le');
  assert.equal(script, "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; & 'C:\\Program Files\\O''Brien\\codex.exe' 'app-server' '--listen' 'stdio://'; exit $LASTEXITCODE");
  assert.throws(() => appServerCommand('windows', 'codex\nexit', []), /執行檔路徑/);
  assert.equal(chooseStdioFlag('--listen <URL> [default: stdio://]'), '--listen');
  assert.equal(chooseStdioFlag('--stdio'), '--stdio');
  assert.throws(() => chooseStdioFlag('--port'), /stdio/);
});

test('account and model summaries whitelist public capability fields and clear account on logout', () => {
  assert.deepEqual(accountSummary({ account: { type: 'chatgpt', planType: 'pro', email: 'private', accessToken: 'secret' } }), { authenticated: true, type: 'chatgpt', planType: 'pro' });
  assert.deepEqual(accountUpdateSummary({ authMode: null, planType: null }), { authenticated: false, type: 'none' });
  assert.deepEqual(accountUpdateSummary({ authMode: 'chatgpt', planType: null }), { authenticated: true, type: 'chatgpt' });
  const models = modelSummary({ data: [null, { hidden: true, id: 'hidden' }, { id: 'available', supportedReasoningEfforts: [null, { reasoningEffort: 'high', description: 'High', secret: 'private' }], token: 'private' }] });
  assert.equal(models.length, 1); assert.equal(models[0].id, 'available');
  assert.deepEqual(models[0].supportedReasoningEfforts, [{ reasoningEffort: 'high', description: 'High' }]);
  assert.equal(JSON.stringify(models).includes('private'), false);
});
