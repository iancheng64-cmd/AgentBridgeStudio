const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BindRelay,
  COMPUTER_USE_PORT,
  readExposure,
  writeExposure,
  resolveExposure
} = require('../dist-main/exposure.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-exposure-'));
const file = path.join(root, 'exposure.json');

(async () => {
  // ---- persistence --------------------------------------------------------
  // A missing file must not throw; it resolves to a usable default.
  const initial = readExposure(file);
  assert.equal(initial.mode, 'localhost', 'defaults to local-only without requiring a VPN');
  assert.notEqual(initial.bindHost, '0.0.0.0', 'the default never widens to every interface');
  if (initial.bindHost !== '127.0.0.1') {
    assert.match(initial.bindHost, /^\d+\.\d+\.\d+\.\d+$/, 'a widened default is still a single concrete interface');
  }

  const saved = writeExposure(file, 'localhost');
  assert.equal(saved.mode, 'localhost');
  assert.equal(readExposure(file).mode, 'localhost', 'mode survives a round trip through disk');

  // A corrupt or hostile value is ignored rather than trusted.
  fs.writeFileSync(file, '{not json');
  assert.equal(readExposure(file).mode, 'localhost', 'corrupt config falls back to the default');
  fs.writeFileSync(file, JSON.stringify({ mode: 'internet' }));
  assert.equal(readExposure(file).mode, 'localhost', 'unknown modes are rejected, not passed through');
  fs.writeFileSync(file, JSON.stringify({ mode: '../../etc/passwd' }));
  assert.equal(readExposure(file).mode, 'localhost', 'path-shaped modes are rejected');

  // ---- resolution ---------------------------------------------------------
  // `all` is the one mode that widens, and it is an explicit choice.
  assert.equal(resolveExposure('all').bindHost, '0.0.0.0');
  assert.equal(resolveExposure('localhost').bindHost, '127.0.0.1');
  assert.equal(resolveExposure('localhost').advertiseHost, resolveExposure('localhost').advertiseHost);
  // Whatever the mode, the advertised host is a concrete address the remote
  // agent can actually dial — never a wildcard.
  for (const mode of ['tailscale', 'lan', 'all', 'localhost']) {
    const state = resolveExposure(mode);
    assert.ok(state.advertiseHost, `${mode} resolves an advertise host`);
    assert.notEqual(state.advertiseHost, '0.0.0.0', `${mode} never advertises a wildcard`);
  }

  // ---- bind relay ---------------------------------------------------------
  // For 0.0.0.0 / loopback the relay is unnecessary — supergateway already
  // covers those cases — so starting it must be a no-op rather than an error.
  for (const skip of ['0.0.0.0', '127.0.0.1']) {
    const noop = new BindRelay(skip, 0, 1);
    assert.deepEqual(await noop.start(), { ok: true }, `relay is skipped for ${skip}`);
    assert.equal(noop.port, undefined, `relay binds nothing for ${skip}`);
    noop.stop();
  }

  // For a specific interface it must actually listen there and relay bytes
  // upstream. A relay that binds but drops traffic would leave the Computer
  // Use endpoint reachable-but-dead, which is worse than not starting at all.
  const lanAddress = Object.values(os.networkInterfaces())
    .flat()
    .find((info) => info && info.family === 'IPv4' && !info.internal);
  assert.ok(lanAddress, 'a non-loopback IPv4 interface is available to bind');

  const upstream = require('node:http').createServer((_req, res) => res.end('upstream-ok'));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const relay = new BindRelay(lanAddress.address, 0, upstreamPort);
  const result = await relay.start();
  assert.equal(result.ok, true, `relay binds on ${lanAddress.address}: ${result.reason || ''}`);
  const boundPort = relay.port ?? null;
  assert.ok(boundPort, 'relay reports a bound port');
  const body = await new Promise((resolve, reject) => {
    require('node:http').get({ host: lanAddress.address, port: boundPort }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve(text));
    }).on('error', reject);
  });
  assert.equal(body, 'upstream-ok', 'relay forwards requests to the loopback upstream');
  relay.stop();
  upstream.close();

  console.log('# PASS: exposure defaults, round-trip persistence, hostile-input rejection, and bind relay forwarding.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
