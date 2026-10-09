const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalToolHost } = require('../dist-main/local-tool-host.js');

async function fixture(options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbridge-mac-shell-'));
  const root = await fs.realpath(temp);
  const previousHome = process.env.HOME;
  const previousZdotdir = process.env.ZDOTDIR;
  // /bin/zsh -l reads startup files. Point them at this empty fixture directory.
  process.env.HOME = root;
  process.env.ZDOTDIR = root;
  const host = new LocalToolHost({ allowedRoots: [root], authorize: () => true, ...options });
  try {
    const endpoint = await host.start();
    let id = 0;
    const request = (method, params = {}, signal) => fetch(endpoint.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal
    });
    const call = async (name, args, signal) => {
      const response = await request('tools/call', { name, arguments: args }, signal);
      return (await response.json()).result;
    };
    return {
      host, endpoint, root, request, call,
      cleanup: async () => {
        await host.stop();
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
        if (previousZdotdir === undefined) delete process.env.ZDOTDIR; else process.env.ZDOTDIR = previousZdotdir;
        await fs.rm(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await host.stop();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousZdotdir === undefined) delete process.env.ZDOTDIR; else process.env.ZDOTDIR = previousZdotdir;
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

const data = result => JSON.parse(result.content[0].text);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fs.access(file); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for fixture file: ${path.basename(file)}`);
}

test('mac shell is absent unless enabled', async () => {
  const f = await fixture();
  try {
    assert.equal(f.host.listTools().some(tool => tool.name === 'mac_shell_execute'), false);
    const response = await f.request('tools/call', { name: 'mac_shell_execute', arguments: { command: 'printf should-not-run' } });
    const result = await response.json();
    assert.equal(result.error.code, -32602);
    assert.match(result.error.message, /Unknown tool/);
  } finally { await f.cleanup(); }
});

test('shell calls require approval and approved calls return stdout, stderr, exit code, and activity', async () => {
  let approve;
  let notifyRequested;
  let observed;
  const requested = new Promise(resolve => { notifyRequested = resolve; });
  const denied = await fixture({
    enableShell: true,
    authorize: call => {
      observed = call;
      return new Promise(resolve => { approve = resolve; notifyRequested(); });
    }
  });
  const deniedMarker = path.join(denied.root, 'denied.txt');
  try {
    assert.ok(denied.host.listTools().some(tool => tool.name === 'mac_shell_execute'));
    const pending = denied.call('mac_shell_execute', { command: `printf denied > ${quote(deniedMarker)}` });
    await requested;
    assert.equal(observed.name, 'mac_shell_execute');
    assert.equal(observed.category, 'shell');
    approve(false);
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /permission denied/);
    await assert.rejects(fs.stat(deniedMarker), { code: 'ENOENT' });
  } finally { await denied.cleanup(); }

  const activities = [];
  let approvedCall;
  const allowed = await fixture({
    enableShell: true,
    authorize: call => { approvedCall = call; return true; },
    onActivity: activity => activities.push(activity)
  });
  try {
    const result = data(await allowed.call('mac_shell_execute', {
      command: "printf 'stdout-proof'; printf 'stderr-proof' >&2; exit 7"
    }));
    assert.equal(approvedCall.category, 'shell');
    assert.equal(approvedCall.arguments.command.includes('stdout-proof'), true);
    assert.equal(result.stdout, 'stdout-proof');
    assert.equal(result.stderr, 'stderr-proof');
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false);
    assert.equal(result.executionLocation, 'local');
    assert.deepEqual(activities.map(activity => activity.status), ['started', 'completed']);
    assert.ok(activities.every(activity => activity.category === 'shell'));
  } finally { await allowed.cleanup(); }
});

test('shell cwd defaults to the selected root, accepts a nested root path, and rejects an outside path', async () => {
  const f = await fixture({ enableShell: true });
  const outside = `${f.root}-outside`;
  try {
    await fs.mkdir(path.join(f.root, 'nested'));
    await fs.mkdir(outside);
    const defaultCwd = data(await f.call('mac_shell_execute', { command: 'pwd' }));
    assert.equal(defaultCwd.cwd, f.root);
    assert.equal(defaultCwd.stdout.trim(), f.root);

    const nested = path.join(f.root, 'nested');
    const nestedCwd = data(await f.call('mac_shell_execute', { command: 'pwd', cwd: nested }));
    assert.equal(nestedCwd.cwd, nested);
    assert.equal(nestedCwd.stdout.trim(), nested);

    const rejected = await f.call('mac_shell_execute', { command: 'pwd', cwd: outside });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /outside the permitted roots/);
  } finally {
    await f.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('shell timeout stops the command and reports output captured before timeout', { timeout: 10000 }, async () => {
  const f = await fixture({ enableShell: true });
  try {
    const result = data(await f.call('mac_shell_execute', {
      command: "printf before-timeout; sleep 5; printf after-timeout",
      timeoutMs: 150
    }));
    assert.equal(result.timedOut, true);
    assert.match(result.stdout, /before-timeout/);
    assert.doesNotMatch(result.stdout, /after-timeout/);
    assert.equal(result.signal, 'SIGKILL');
  } finally { await f.cleanup(); }
});

test('cancelling an active shell kills it and leaves the host available', { timeout: 10000 }, async () => {
  const f = await fixture({ enableShell: true, requestTimeoutMs: 8000 });
  const started = path.join(f.root, 'started.txt');
  const finished = path.join(f.root, 'finished.txt');
  try {
    const pending = f.call('mac_shell_execute', {
      command: `printf started > ${quote(started)}; sleep 5; printf finished > ${quote(finished)}`
    });
    await waitForFile(started);
    f.host.cancelActive();
    const cancelled = await pending;
    assert.equal(cancelled.isError, true);
    assert.match(cancelled.content[0].text, /Request cancelled/);
    await new Promise(resolve => setTimeout(resolve, 250));
    await assert.rejects(fs.stat(finished), { code: 'ENOENT' });

    const subsequent = data(await f.call('mac_shell_execute', { command: "printf 'still-alive'" }));
    assert.equal(subsequent.stdout, 'still-alive');
    assert.equal(f.host.status().ok, true);
  } finally { await f.cleanup(); }
});

test('shell output is bounded and reports truncation', { timeout: 10000 }, async () => {
  const f = await fixture({ enableShell: true });
  try {
    const result = data(await f.call('mac_shell_execute', { command: 'yes x | head -c 1100000' }));
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.length <= 1024 * 1024);
    assert.equal(result.timedOut, false);
  } finally { await f.cleanup(); }
});
