const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Client, Server } = require('ssh2');
const WebSocket = require('ws');
const { LoopbackForward } = require('../dist-main/loopback-forward.js');
const { LocalExecServer } = require('../dist-main/local-exec-server.js');
const { LocalToolHost } = require('../dist-main/local-tool-host.js');

const timeout = ms => new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms));

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function waitForWebSocket(url, headers) {
  return Promise.race([
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers });
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    }),
    timeout(3000),
  ]);
}

function rpcOverHttp(url, token, method, params = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

function createRemoteForwardServer(password) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const sshServer = new Server({ hostKeys: [privateKey] });
  const connections = [];
  const listeners = new Map();
  sshServer.on('connection', conn => {
    connections.push(conn);
    conn.on('error', () => {});
    conn.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'split-test' && ctx.password === password) ctx.accept();
      else ctx.reject();
    });
    conn.on('ready', () => {
      conn.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          if (info.bindAddr !== '127.0.0.1') { reject(); return; }
          const listener = net.createServer(socket => {
            conn.forwardOut(
              info.bindAddr,
              boundPort,
              '127.0.0.1',
              socket.remotePort || 0,
              (error, channel) => {
                if (error) { socket.destroy(); return; }
                socket.pipe(channel).pipe(socket);
                channel.once('close', () => socket.destroy());
                socket.once('close', () => channel.destroy());
              },
            );
          });
          let boundPort;
          listener.once('error', reject);
          listener.listen(info.bindPort, '127.0.0.1', () => {
            listener.off('error', reject);
            boundPort = listener.address().port;
            listeners.set(boundPort, listener);
            accept(boundPort);
          });
          return;
        }
        if (name === 'cancel-tcpip-forward') {
          const listener = listeners.get(info.bindPort);
          if (info.bindAddr === '127.0.0.1' && listener) {
            listeners.delete(info.bindPort);
            listener.close();
            accept();
          } else reject();
          return;
        }
        reject();
      });
    });
  });
  return { sshServer, connections, listeners };
}

test('real SSH loopback forwarding carries authenticated Mac executor and file-tool state over two ports', { timeout: 15000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbridge-split-ssh-'));
  const root = await fs.realpath(temp);
  const sentinel = `mac-only-${crypto.randomUUID()}`;
  const file = path.join(root, 'only-on-mac.txt');
  await fs.writeFile(file, sentinel, { mode: 0o600 });

  const execTokenHashMarker = '--ws-token-sha256';
  const fakeCodex = path.join(root, 'fake-codex');
  const wsModulePath = require.resolve('ws');
  const executorScript = `#!/usr/bin/env node
const crypto = require('node:crypto');
const WebSocket = require(${JSON.stringify(wsModulePath)});
const expected = process.argv[process.argv.indexOf(${JSON.stringify(execTokenHashMarker)}) + 1];
const targetCwd = ${JSON.stringify(pathToFileURL(root).href)};
const server = new WebSocket.Server({ host: '127.0.0.1', port: 0, verifyClient: (info, done) => {
  const header = info.req.headers.authorization || '';
  const supplied = Buffer.from(crypto.createHash('sha256').update(header.startsWith('Bearer ') ? header.slice(7) : '').digest('hex'));
  const wanted = Buffer.from(expected || '');
  done(supplied.length === wanted.length && crypto.timingSafeEqual(supplied, wanted), 401, 'Unauthorized');
} });
server.on('listening', () => process.stdout.write('ws://127.0.0.1:' + server.address().port + '\\n'));
server.on('connection', socket => socket.on('message', raw => {
  let request; try { request = JSON.parse(raw.toString()); } catch { socket.close(); return; }
  const result = request.method === 'environment/info'
    ? { cwd: targetCwd, shell: { name: 'zsh', path: '/bin/zsh' }, machine: ${JSON.stringify(sentinel)} }
    : { machine: ${JSON.stringify(sentinel)}, platform: 'darwin' };
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.stdin.resume();
`;
  await fs.writeFile(fakeCodex, executorScript, { mode: 0o700 });

  const sshPassword = crypto.randomBytes(24).toString('hex');
  const remote = createRemoteForwardServer(sshPassword);
  const client = new Client();
  let toolHost;
  let executor;
  let executorForward;
  let fileForward;
  let execSocket;
  let executorToken;
  let executorChild;
  try {
    const sshPort = await listen(remote.sshServer);
    client.on('error', () => {});
    await Promise.race([
      new Promise((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
        client.connect({ host: '127.0.0.1', port: sshPort, username: 'split-test', password: sshPassword, hostVerifier: () => true });
      }),
      timeout(3000),
    ]);

    toolHost = new LocalToolHost({ allowedRoots: [root], authorize: () => true });
    const toolEndpoint = await toolHost.start();
    executor = new LocalExecServer({ codexExecutable: fakeCodex, executable: fakeCodex, version: 'fixture-only' }, () => {});
    await executor.start(root);
    executorForward = new LoopbackForward(client, Number(new URL(executor.localUrl).port));
    fileForward = new LoopbackForward(client, toolEndpoint.port);
    const executorRemotePort = await executorForward.start();
    const fileRemotePort = await fileForward.start();

    const registration = await executor.register({
      request: async (method, params) => {
        if (method === 'environment/add') {
          assert.equal(params.execServerUrl, `ws://127.0.0.1:${executorRemotePort}`);
          executorToken = params.authBearerToken;
          return {};
        }
        assert.equal(method, 'environment/info');
        return { cwd: pathToFileURL(root).href, shell: { name: 'zsh', path: '/bin/zsh' } };
      },
    }, `ws://127.0.0.1:${executorRemotePort}`);
    assert.equal(registration.cwd, pathToFileURL(root).href);
    assert.match(executorToken, /^[A-Za-z0-9_-]{43}$/);

    // The app-server-side peer connects to SSH's two dynamically assigned loopback listeners.
    const executorUrl = `ws://127.0.0.1:${executorRemotePort}`;
    await assert.rejects(waitForWebSocket(executorUrl, { Authorization: 'Bearer wrong-token' }), /401|Unexpected server response|unexpected server response/i);
    execSocket = await waitForWebSocket(executorUrl, { Authorization: `Bearer ${executorToken}` });
    const state = await Promise.race([
      new Promise((resolve, reject) => {
        execSocket.once('message', raw => {
          try { resolve(JSON.parse(raw.toString())); } catch (error) { reject(error); }
        });
        execSocket.send(JSON.stringify({ jsonrpc: '2.0', id: 'probe', method: 'environment/info', params: {} }));
      }),
      timeout(3000),
    ]);
    assert.equal(state.result.machine, sentinel);
    assert.equal(state.result.shell.path, '/bin/zsh');

    const forwardedHttpUrl = `http://127.0.0.1:${fileRemotePort}/mcp`;
    assert.equal((await rpcOverHttp(forwardedHttpUrl, 'wrong-token', 'tools/list')).status, 401);
    const toolsResponse = await rpcOverHttp(forwardedHttpUrl, toolEndpoint.token, 'tools/list');
    assert.equal(toolsResponse.status, 200);
    const tools = (await toolsResponse.json()).result.tools;
    assert.ok(tools.some(tool => tool.name === 'mac_fs_read'));
    const readResponse = await rpcOverHttp(forwardedHttpUrl, toolEndpoint.token, 'tools/call', { name: 'mac_fs_read', arguments: { path: file } });
    const readResult = (await readResponse.json()).result;
    assert.equal(readResponse.status, 200);
    assert.equal(JSON.parse(readResult.content[0].text).text, sentinel);

    // Even over the same authenticated SSH connection, an unregistered destination port is rejected.
    const serverConn = remote.connections[0];
    const unrequestedError = await Promise.race([
      new Promise(resolve => serverConn.forwardOut('127.0.0.1', 9, '127.0.0.1', 1234, (error, channel) => {
        channel?.destroy();
        resolve(error);
      })),
      timeout(3000),
    ]);
    assert.ok(unrequestedError, 'a TCPIP channel for an unrequested port must be rejected');
  } finally {
    execSocket?.close();
    executorForward?.stop();
    fileForward?.stop();
    executorChild = executor?.child;
    executor?.stop();
    if (toolHost) await toolHost.stop();
    client.end();
    for (const listener of remote.listeners.values()) listener.close();
    await new Promise(resolve => remote.sshServer.close(resolve));
    if (executorChild && executorChild.exitCode === null) {
      await Promise.race([
        new Promise(resolve => executorChild.once('close', resolve)),
        timeout(3000),
      ]).catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
