const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {browserExecutable, browserRuntimeArgs} = require('../dist-main/browser-runtime');
const {requirePrivateHttpBinding} = require('../dist-main/http-tool-health');
const {BindRelay} = require('../dist-main/exposure');
test('local-only Computer HTTP forwards to its separate loopback gateway', async () => {
  const http = require('node:http');
  const upstream = http.createServer((_request, response) => response.end('computer-gateway-fixture'));
  await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve));
  const relay = new BindRelay('127.0.0.1',0,upstream.address().port,true);
  try {
    assert.deepEqual(await relay.start(),{ok:true});
    assert.ok(relay.port);
    const response = await fetch(`http://127.0.0.1:${relay.port}/`);
    assert.equal(await response.text(),'computer-gateway-fixture');
  } finally {
    relay.stop(); await new Promise(resolve => upstream.close(resolve));
  }
});
test('new installations can use loopback HTTP without widening remote access', () => {
  requirePrivateHttpBinding('localhost', '127.0.0.1');
  requirePrivateHttpBinding('tailscale', '100.99.1.2');
  for (const [mode, host] of [['localhost','0.0.0.0'], ['localhost','192.168.1.1'], ['lan','192.168.1.1'], ['all','0.0.0.0']]) assert.throws(() => requirePrivateHttpBinding(mode, host));
});
test('browser comes only from the packaged executable, including paths with spaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser runtime '));
  try {
    const file = path.join(root, 'browser app/Browser');
    fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'fixture'); fs.chmodSync(file, 0o755);
    fs.writeFileSync(path.join(root, 'browser-runtime.json'), JSON.stringify({executable: 'browser app/Browser'}));
    assert.equal(browserExecutable(root), file);
    assert.deepEqual(browserRuntimeArgs(root), ['--browser', 'chrome', '--executable-path', file]);
    fs.unlinkSync(file); assert.throws(() => browserExecutable(root));
  } finally {fs.rmSync(root, {recursive:true, force:true});}
});
test('a manifest cannot escape its package through traversal, absolute paths or links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-boundary-'));
  const outside = path.join(root, '../' + path.basename(root) + '-outside');
  fs.writeFileSync(outside, 'fixture'); fs.chmodSync(outside, 0o755);
  try {
    fs.symlinkSync(outside, path.join(root, 'link'));
    for (const executable of ['../' + path.basename(outside), outside, 'link']) {
      fs.writeFileSync(path.join(root, 'browser-runtime.json'), JSON.stringify({executable}));
      assert.throws(() => browserExecutable(root));
    }
  } finally {fs.rmSync(root, {recursive:true, force:true}); fs.unlinkSync(outside);}
});
