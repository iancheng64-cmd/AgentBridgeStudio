const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { macThreadConfig, validateMacMcpInventory, isVerifiedExecutorVersion } = require('../dist-main/runtime-policy.js');
const { appServerCommand } = require('../dist-main/app-server-rpc.js');
const { runtimeInput } = require('../dist-main/runtime-attachments.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-policy-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('policy disables literal original MCP names and binds the authenticated Mac MCP to its environment', () => {
  const config = macThreadConfig({ mcp_servers: {'odd.name"quoted': {command:'remote'}, ordinary: {url:'https://remote'}} }, { name:'mac', url:'http://127.0.0.1:1234/mcp', token:'ephemeral', environmentId:'mac-environment' });
  assert.equal(config.mcp_servers['odd.name"quoted'].enabled, false);
  assert.equal(config.mcp_servers.ordinary.enabled, false);
  assert.equal(config.mcp_servers.composio.enabled, false);
  assert.equal(config.mcp_servers.composio.url, 'http://127.0.0.1:9/mcp');
  assert.equal(config.mcp_servers.mac.environment_id, 'mac-environment');
  assert.equal(config['features.hooks'], false); assert.equal(config['features.plugins'], false);
  const compactConfig = macThreadConfig({ mcp_servers: {}, model_context_window: 200000 }, undefined, 70);
  assert.equal(compactConfig.model_auto_compact_token_limit, 140000);
  assert.equal(compactConfig.model_auto_compact_token_limit_scope, 'total');
  validateMacMcpInventory([{name:'ordinary',runtimeStatus:'disabled',tools:{}},{name:'mac',tools:{mac_fs_read:{}}}], 'mac');
  assert.throws(() => validateMacMcpInventory([{name:'ordinary',runtimeStatus:'connected',tools:{}}]), /非 Mac/);
  assert.throws(() => validateMacMcpInventory([{name:'ordinary',runtimeStatus:'disabled',tools:{},resources:[{uri:'file:///secret'}]}]), /非 Mac/);
  assert.throws(() => validateMacMcpInventory([], 'mac'), /未載入/);
});

test('isolated shell startup disables the default executor and rejects an overriding environments.toml', () => {
  const fake = path.join(root, 'fake-codex');
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s" "$CODEX_EXEC_SERVER_URL"\n', { mode:0o755 });
  const command = appServerCommand('posix', fake, ['app-server'], true);
  assert.equal(execFileSync('/bin/sh', ['-c', command], { env:{...process.env,CODEX_HOME:root},encoding:'utf8' }), 'none');
  fs.writeFileSync(path.join(root, 'environments.toml'), 'secret sentinel');
  assert.throws(() => execFileSync('/bin/sh', ['-c', command], {env:{...process.env,CODEX_HOME:root},stdio:'pipe'}), /environments.toml/);
  assert.equal(fs.readFileSync(path.join(root, 'environments.toml'), 'utf8'), 'secret sentinel');
  const windows = appServerCommand('windows', "C:\\Program Files\\Codex.exe", ['app-server'], true);
  const powershell = Buffer.from(windows.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(powershell, /Test-Path -LiteralPath/); assert.match(powershell, /CODEX_EXEC_SERVER_URL='none'/);
  assert.doesNotMatch(powershell, /Get-Content|auth\.json|Copy-Item/);
});

test('attachments send image bytes and retain ordinary files as Mac references with image limits', async () => {
  const image = path.join(root, 'image.png'); fs.writeFileSync(image, Buffer.from([137,80,78,71]));
  const input = await runtimeInput('請閱讀', [{id:'img',name:'image.png',path:image,size:4,mimeType:'image/png'}, {id:'doc',name:'report.pdf',path:path.join(root,'report.pdf'),size:12}]);
  assert.equal(input.find(item => item.type === 'image').url, 'data:image/png;base64,iVBORw==');
  assert.ok(input.some(item => item.text?.includes('report.pdf') && item.text.includes('Mac')));
  assert.equal(input.some(item => item.type === 'localImage'), false);
  const large = path.join(root,'large.png'); fs.writeFileSync(large, ''); fs.truncateSync(large,9*1024*1024);
  await assert.rejects(runtimeInput('', [{id:'large',name:'large.png',path:large,size:9*1024*1024,mimeType:'image/png'}]), /8 MB/);
});

test('executor version support is an exact tested allowlist, never a semver range', () => {
  assert.equal(isVerifiedExecutorVersion('0.159.2'), true); assert.equal(isVerifiedExecutorVersion('0.160.0'), true);
  for (const version of ['0.160.1','0.160.0-beta.1','0.161.0','unknown','']) assert.equal(isVerifiedExecutorVersion(version), false);
});
