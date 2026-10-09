const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalToolHost } = require('../dist-main/local-tool-host.js');

// Explicit opt-in: this opens and controls only a newly launched Calculator PID.
// AGENTBRIDGE_NATIVE_ACCEPTANCE=1 node --test tests/local-tool-host-native.cjs
test('real Mac MCP Calculator AX actions, coordinate click, screenshot and cleanup', { skip: process.platform !== 'darwin' || process.env.AGENTBRIDGE_NATIVE_ACCEPTANCE !== '1', timeout: 90000 }, async () => {
  const pids = () => { try { return execFileSync('/usr/bin/pgrep', ['-x', 'Calculator'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { return []; } };
  const before = pids();
  execFileSync('/usr/bin/open', ['-n', '-a', 'Calculator']);
  await new Promise(resolve => setTimeout(resolve, 800));
  const pid = pids().find(pid => !before.includes(pid));
  assert.ok(pid, 'A distinct Calculator process is required; never target an existing user session');
  const host = new LocalToolHost({ allowedRoots: [process.cwd()], appPath: process.cwd(), authorize: call => call.category === 'filesystem-read' || call.arguments.app === pid });
  let client;
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const endpoint = await host.start();
    client = new Client({ name: 'agentbridge-native-acceptance', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } } }));
    const call = (name, args) => client.callTool({ name, arguments: args });
    for (const delivery of ['background', 'direct']) {
    for (const identifier of ['AllClear', 'AllClear', 'Two', 'Add', 'Three', 'Equals']) {
      const state = await call('mac_computer_get_app_state', { app: pid });
      assert.notEqual(state.isError, true);
      const elements = state.structuredContent.snapshot.elements;
      const element = elements.find(element => element.identifier === identifier || (identifier === 'AllClear' && element.identifier === 'Clear'));
      assert.ok(element, `AX button ${identifier} exists; available: ${elements.map(element => element.identifier).filter(Boolean).join(', ')}`);
      // The last operation uses a global coordinate derived from the real AX frame,
      // verifying that image orientation changes do not alter input coordinates.
      const args = identifier === 'Equals'
        ? { app: pid, x: element.frame.x + element.frame.width / 2, y: element.frame.y + element.frame.height / 2, delivery }
        : { app: pid, element_index: element.index };
      const result = await call('mac_computer_click', args);
      if (identifier === 'Equals') console.log(JSON.stringify({ coordinateInput: args, windowFrame: state.structuredContent.screenshot?.window?.frame }));
      assert.notEqual(result.isError, true, `Calculator action ${identifier} succeeds`);
    }
    const result = await call('mac_computer_get_app_state', { app: pid });
    const values = result.structuredContent.snapshot.elements.map(element => element.value).filter(Boolean);
    const image = result.content.find(item => item.type === 'image');
    assert.ok(image, 'Native window capture returns an image');
    const file = path.join(os.tmpdir(), 'agentbridge-calculator-mcp-fixed.png');
    const png = Buffer.from(image.data, 'base64');
    fs.writeFileSync(file, png);
    assert.ok(values.includes('5'), `Actual AX display must equal 5 after 2+3; observed: ${JSON.stringify(values)}`);
    console.log(JSON.stringify({ actualAXResult: '5', coordinateClick: true, delivery, screenshot: file, pngBytes: png.length, captureMetadata: result.structuredContent.screenshot }));
    }
    const failure = await call('mac_computer_press_key', { app: pid, key: 'unsupported_test_key' });
    assert.equal(failure.isError, true);
    assert.notEqual((await call('mac_fs_list', { path: process.cwd() })).isError, true, 'Native error must not disable file tools');
    host.cancelActive();
    assert.notEqual((await call('mac_fs_list', { path: process.cwd() })).isError, true, 'Cancellation keeps idle endpoint usable');
  } finally {
    await client?.close(); await host.stop();
    assert.equal(host.listTools().length, 0); assert.equal(host.status().computer, 'unavailable');
    try { process.kill(Number(pid), 'SIGTERM'); } catch {}
  }
});
