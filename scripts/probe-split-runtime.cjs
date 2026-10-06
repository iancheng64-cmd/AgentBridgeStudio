#!/usr/bin/env node
// Offline routing check: real Codex processes, deterministic local model responses.
// No ChatGPT sign-in, external model request, or credential files are used.
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { LocalExecServer } = require('../dist-main/local-exec-server.js');
const { LocalToolHost } = require('../dist-main/local-tool-host.js');
const { macThreadConfig, isolatedRuntimeArgs, validateMacMcpInventory } = require('../dist-main/runtime-policy.js');
const { runtimeInput } = require('../dist-main/runtime-attachments.js');
const { openSshLoopback } = require('./probe-ssh-transport.cjs');
const { AppServerRpc } = require('../dist-main/app-server-rpc.js');

async function probe(executable, codeMode = false, projectMode = false, desktopTools = false) {
  const modelName = codeMode ? 'gpt-6-astra' : 'gpt-5.5';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-route-'));
  const runtimeCwd = path.join(root, 'runtime'); const executorCwd = path.join(root, 'executor');
  fs.mkdirSync(runtimeCwd); fs.mkdirSync(executorCwd);
  const home = path.join(root, 'config'); fs.mkdirSync(home);
  // Both processes see the same filesystem, so a cwd alone is insufficient proof.
  // Inherited process markers distinguish where the shell was actually spawned.
  const cleanEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, SHELL: '/bin/zsh', TMPDIR: root };
  const version = await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], { env: cleanEnv }); let text = '';
    child.stdout.on('data', c => text += c); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(text.trim()) : reject(new Error('version check failed')));
  });
  const calls = []; const notifications = []; let executor; let child; let rpc; let localHost; let ssh; let boundEnvironment; const approvals = [];
  const tools = [
    { name: 'exec_command', arguments: { cmd: 'pwd; printenv AGENTBRIDGE_PROBE_LOCATION; printf executor-proof > native-probe.txt; cat native-probe.txt', max_output_tokens: 1000 } },
    { name: 'exec_command', arguments: { cmd: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Delete File: native-probe.txt\n*** Add File: patched-probe.txt\n+patch-proof\n*** End Patch\nPATCH", max_output_tokens: 1000 } },
    { name: 'view_image', arguments: { path: path.join(fs.realpathSync(executorCwd), 'image.png') } },
    { name: 'apply_patch', input: '*** Begin Patch\n*** Add File: native-patch.txt\n+native-patch-proof\n*** Update File: patched-probe.txt\n@@\n-patch-proof\n+patch-proof-updated\n*** Delete File: obsolete.txt\n*** End Patch' },
    { search: true, arguments: { query: 'agentbridge_probe mac_fs_read', limit: 1 } },
    { name: 'mac_fs_read', namespace: 'mcp__agentbridge_probe', arguments: { path: path.join(fs.realpathSync(executorCwd), 'patched-probe.txt') } }
  ];
  fs.writeFileSync(path.join(executorCwd, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8AARGDiPwMAHfAD/aAzCYkAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(path.join(runtimeCwd, 'native-probe.txt'), 'runtime-sentinel');
  fs.writeFileSync(path.join(executorCwd, 'obsolete.txt'), 'delete-me');
  const model = http.createServer((req, res) => {
    let text = ''; req.on('data', c => text += c);
    req.on('end', () => {
      calls.push(JSON.parse(text)); const index = calls.length - 1; const id = `probe-${index}`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [{ type: 'response.created', response: { id } }];
      if (tools[index]) events.push({ type: 'response.output_item.done', item: tools[index].search ? { type: "tool_search_call", call_id: id, execution: "client", arguments: tools[index].arguments } : tools[index].input ? { type: 'custom_tool_call', call_id: id, name: tools[index].name, input: tools[index].input } : { type: 'function_call', call_id: id, name: tools[index].name, ...(tools[index].namespace ? {namespace: tools[index].namespace} : {}), arguments: JSON.stringify(tools[index].arguments) } });
      if (codeMode && tools[index] && !tools[index].search) {
        const tool = tools[index];
        const name = tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
        const input = tool.input || tool.arguments;
        const operation = `await tools.${name}(${JSON.stringify(input)})`;
        const code = tool.name === 'view_image' ? `const result = ${operation}; image(result.image_url);` : `text(${operation});`;
        events[events.length - 1].item = { type: 'custom_tool_call', call_id: id, name: 'exec', namespace: 'functions', input: code };
      }
      events.push({ type: 'response.completed' , response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  try {
    await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
    executor = new LocalExecServer({ codexExecutable: executable, executable: '', version }, () => { rpc?.close(); });
    const directUrl = await executor.start(executorCwd, { ...cleanEnv, AGENTBRIDGE_PROBE_LOCATION: 'executor-process' });
    ssh = await openSshLoopback();
    const url = await executor.reverseForward(ssh.conn);
    const unauthenticatedRejected = await new Promise((resolve, reject) => {
      const socket = new WebSocket(url); const timer = setTimeout(() => { socket.terminate(); reject(new Error('auth probe timed out')); }, 5000);
      socket.on('open', () => { clearTimeout(timer); socket.close(); resolve(false); });
      socket.on('unexpected-response', (_req, response) => { clearTimeout(timer); response.resume(); socket.terminate(); resolve(response.statusCode === 401 || response.statusCode === 403); });
      socket.on('error', error => { clearTimeout(timer); if (!/closed before/.test(error.message)) reject(error); });
    });
    assert.equal(unauthenticatedRejected, true, 'executor must reject unauthenticated clients');
    localHost = new LocalToolHost({ allowedRoots: [executorCwd], authorize: () => true,
      ...(desktopTools ? { nativeCommand: {command: path.resolve(__dirname, '../vendor/open-codex-computer-use/.build/release/claudex-computer-use')}, browserCommand: {command: process.execPath, args: [path.resolve(__dirname, '../node_modules/@playwright/mcp/cli.js'), '--browser', 'chrome', '--isolated']} } : {}) });
    const hostInfo = await localHost.start();
    const remoteMcpMarker = path.join(runtimeCwd, 'remote-mcp-started.txt');
    fs.writeFileSync(path.join(home, 'config.toml'), `[mcp_servers.forbidden_remote]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-e", ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(remoteMcpMarker)},'unsafe');setTimeout(()=>{},60000)`)}]\n`);
    const flags = ['features.deferred_executor=true', 'model_provider="probe"', `model="${modelName}"`, 'model_providers.probe.name="Offline probe"', `model_providers.probe.base_url="http://127.0.0.1:${model.address().port}/v1"`, 'model_providers.probe.wire_api="responses"', 'model_providers.probe.requires_openai_auth=false'];
    child = spawn(executable, ['app-server', '--listen', 'stdio://', ...isolatedRuntimeArgs(), ...flags.flatMap(flag => ['-c', flag])], { cwd: runtimeCwd, env: { ...cleanEnv, AGENTBRIDGE_PROBE_LOCATION: 'runtime-process', CODEX_EXEC_SERVER_URL: 'none' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const transport = new EventEmitter(); transport.write = line => child.stdin.write(line); transport.close = () => child.kill();
    child.stdout.on('data', chunk => transport.emit('data', chunk)); child.on('close', () => transport.emit('close')); child.on('error', error => transport.emit('error', error)); child.stderr.on('data', () => {});
    rpc = new AppServerRpc(transport); rpc.on('request', request => {
      if (projectMode && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
        if (request.method.includes('commandExecution')) assert.equal(request.params.environmentId, boundEnvironment, 'approval must belong to Mac executor');
        approvals.push(request.method); rpc.respond(request.id, { decision: 'accept' });
      } else rpc.reject(request.id, 'Offline probe does not accept account or unrelated approval requests.');
    });
    await rpc.request('initialize', { clientInfo: { name: 'agentbridge_offline_probe', version: '1' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized');
    const registration = await executor.register(rpc, url); boundEnvironment = registration.environmentId;
    const effective = await rpc.request('config/read', { includeLayers: false });
    const threadConfig = macThreadConfig(effective.config, { name: 'agentbridge_probe', url: hostInfo.url, token: hostInfo.token });
    threadConfig.mcp_servers.agentbridge_probe.environment_id = registration.environmentId;
    const thread = await rpc.request('thread/start', { config: threadConfig, cwd: runtimeCwd, model: modelName, approvalPolicy: projectMode ? 'untrusted' : 'never', sandbox: projectMode ? 'read-only' : 'danger-full-access', environments: [{ environmentId: registration.environmentId, cwd: fs.realpathSync(executorCwd) }] });
    const inventory = await rpc.request('mcpServerStatus/list', { threadId: thread.thread.id });
    validateMacMcpInventory(inventory.data, 'agentbridge_probe');
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('native tool routing probe timed out')), 30000);
      rpc.on('notification', notification => { notifications.push(notification); if (notification.method === 'turn/completed') { clearTimeout(timer); resolve(); } });
    });
    await rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Execute the deterministic offline routing checks.' }] }); await done;
    const exposed = calls[0].tools || calls[0].input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools);
    const advertised = exposed.map(tool => tool.name || tool.type);
    if (!codeMode) {
    assert.ok(advertised.includes('exec_command'), 'exec_command must be advertised to the model');
    assert.ok(advertised.includes('apply_patch'), 'apply_patch must be advertised to the model');
    assert.ok(advertised.includes('view_image'), 'view_image must be advertised to the model');
    } else assert.ok(exposed.some(tool => tool.name === 'functions' && tool.tools.some(inner => inner.name === 'exec')), 'Code Mode must expose functions.exec');
    const outputs = calls.at(-1).input.filter(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type));
    assert.equal(fs.existsSync(remoteMcpMarker), false, 'disabled original runtime MCP must never start');
    const mcpOutput = outputs.find(item => item.call_id === 'probe-5')?.output;
    assert.match(JSON.stringify(mcpOutput), /patch-proof-updated/);
    const shell = outputs.find(item => item.call_id === 'probe-0')?.output || '';
    const patch = outputs.find(item => item.call_id === 'probe-1')?.output || '';
    const image = outputs.find(item => item.call_id === 'probe-2')?.output;
    assert.match(JSON.stringify(shell), /executor-process/); assert.doesNotMatch(JSON.stringify(shell), /runtime-process/);
    assert.equal(fs.readFileSync(path.join(runtimeCwd, 'native-probe.txt'), 'utf8'), 'runtime-sentinel');
    assert.equal(fs.existsSync(path.join(executorCwd, 'native-probe.txt')), false);
    assert.equal(fs.readFileSync(path.join(executorCwd, 'patched-probe.txt'), 'utf8'), 'patch-proof-updated\n');
    assert.equal(fs.readFileSync(path.join(executorCwd, 'native-patch.txt'), 'utf8'), 'native-patch-proof\n');
    assert.equal(fs.existsSync(path.join(executorCwd, 'obsolete.txt')), false);
    assert.match(JSON.stringify(patch), /Success/);
    const imageReturned = Array.isArray(image) && image.some(item => item.type === 'input_image');
    const report = { version, projectMode, nativeApprovalCount: approvals.length, modelMetadata: modelName, codeMode, model: 'offline synthetic Responses SSE; no inference or account test', transport: 'real SSH2 loopback reverse-forward; same Mac, no Windows host', environmentInfoVerified: true, unauthenticatedRejected, nativeShellExecutorProcess: true, shellReadWrite: true, interceptedApplyPatchAddDelete: true, standaloneApplyPatchAddUpdateDelete: true, runtimeSentinelIntact: true, imageReturned, macMcpFilesystemRead: true, originalRuntimeMcpDisabled: true, completeToolRoutingVerified: false, standaloneApplyPatchAdvertised: advertised.includes('apply_patch'), advertisedTools: advertised };
    assert.equal(imageReturned, true, 'view_image should return image data through the selected environment');
    if (desktopTools) {
      const doctor = await rpc.request('mcpServer/tool/call', { threadId: thread.thread.id, server: 'agentbridge_probe', tool: 'mac_computer_doctor', arguments: {} });
      const tabs = await rpc.request('mcpServer/tool/call', { threadId: thread.thread.id, server: 'agentbridge_probe', tool: 'mac_browser_browser_tabs', arguments: { action: 'list' } });
      if (doctor.isError || tabs.isError) throw new Error('Real Mac desktop MCP health calls failed');
      report.nativeDoctorRoundtrip = !doctor.isError; report.browserTabsRoundtrip = !tabs.isError;
    }
    await rpc.request('thread/resume', { threadId: thread.thread.id, config: threadConfig, model: modelName, approvalPolicy: projectMode ? 'untrusted' : 'never', sandbox: projectMode ? 'read-only' : 'danger-full-access' });
    const resumeInventory = await rpc.request('mcpServerStatus/list', { threadId: thread.thread.id }); validateMacMcpInventory(resumeInventory.data, 'agentbridge_probe');
    const imagePath = path.join(executorCwd, 'image.png'); const textPath = path.join(executorCwd, 'patched-probe.txt');
    const attachInput = await runtimeInput('Inspect the attached image and text file.', [{ id: 'image', name: 'image.png', path: imagePath, size: fs.statSync(imagePath).size, mimeType: 'image/png' }, { id: 'text', name: 'patched-probe.txt', path: textPath, size: fs.statSync(textPath).size }]);
    const resumedDone = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('resumed attachment turn timed out')), 15000);
      const listener = message => { if (message.method === 'turn/completed') { clearTimeout(timer); rpc.off('notification', listener); resolve(); } }; rpc.on('notification', listener);
    });
    await rpc.request('turn/start', { threadId: thread.thread.id, environments: [{environmentId: registration.environmentId, cwd: fs.realpathSync(executorCwd)}], input: attachInput }); await resumedDone;
    const userContent = calls.at(-1).input.filter(item => item.type === 'message' && item.role === 'user').flatMap(item => item.content);
    assert.ok(userContent.some(item => item.type === 'input_image' && item.image_url.startsWith('data:image/png;base64,')), 'image attachment must reach the model as bytes');
    assert.ok(userContent.some(item => item.type === 'input_text' && item.text.includes(textPath)), 'ordinary attachment must retain its Mac path');
    report.resumeMacInventoryVerified = true; report.imageAttachmentBytesReceived = true; report.ordinaryAttachmentMacPathReceived = true;
    const unboundConfig = macThreadConfig(effective.config, undefined);
    const unbound = await rpc.request('thread/start', { config: unboundConfig, cwd: runtimeCwd, model: modelName, approvalPolicy: 'never', sandbox: 'danger-full-access', environments: [] });
    const fallbackMarker = path.join(runtimeCwd, 'forbidden-fallback.txt');
    const unboundIndex = calls.length;
    tools[unboundIndex] = { name: 'exec_command', arguments: { cmd: `printf forbidden > ${JSON.stringify(fallbackMarker)}`, max_output_tokens: 500 } };
    const unboundDone = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no-default environment check timed out')), 15000);
      const listener = message => { if (message.method === 'turn/completed' && message.params.threadId === unbound.thread.id) { clearTimeout(timer); rpc.off('notification', listener); resolve(); } }; rpc.on('notification', listener);
    });
    await rpc.request('turn/start', { threadId: unbound.thread.id, environments: [], input: [{type:'text',text:'Attempt the deliberately unavailable native shell.'}] }); await unboundDone;
    assert.equal(fs.existsSync(fallbackMarker), false, 'missing environment must not execute on Runtime');
    const unavailableOutput = calls.at(-1).input.find(item => item.call_id === `probe-${unboundIndex}` && ['function_call_output','custom_tool_call_output'].includes(item.type))?.output;
    assert.match(JSON.stringify(unavailableOutput), /unsupported|not.*function|not.*available|unknown|not found|not defined/i);
    report.noDefaultEnvironmentRejectsNativeTool = true;
    // Match the production lifecycle: loss of the local executor closes Runtime RPC,
    // rather than leaving a session alive to choose another execution environment.
    const closed = new Promise(resolve => rpc.once('closed', resolve));
    executor.child.kill('SIGTERM');
    await closed;
    await assert.rejects(rpc.request('turn/start', { threadId: thread.thread.id, input: [] }), /未連線/);
    report.executorLossClosesRuntime = true;
    report.disconnectedTurnRejected = true;
    const tokenBytes = Buffer.from(hostInfo.token);
    const tokenFiles = [];
    const scan = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) scan(file); else if (entry.isFile()) { try { if(fs.readFileSync(file).includes(tokenBytes)) tokenFiles.push(path.relative(home,file)); } catch(error) { if(error.code !== 'ENOENT') throw error; } } } };
    scan(home); report.ephemeralMcpTokenPersistedFiles = tokenFiles;
    return report;
  } finally {
    rpc?.close(); executor?.stop(); await localHost?.stop(); await ssh?.close(); child?.kill(); model.close(); model.closeAllConnections();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (require.main === module) {
  const executable = process.argv[2];
  if (!executable) { console.error('Usage: node scripts/probe-split-runtime.cjs /absolute/path/to/codex'); process.exitCode = 2; }
  else probe(executable, process.argv.includes('--code-mode'), process.argv.includes('--project-mode'), process.argv.includes('--desktop-tools')).then(report => console.log(JSON.stringify(report, null, 2)), error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { probe };
