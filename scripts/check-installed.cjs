#!/usr/bin/env node
// Invoke using the packaged Electron executable in Node mode. No project dependencies.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
async function check(resources) {
  const appRoot = path.join(resources, 'app.asar');
  const {LocalToolStdio} = require(path.join(appRoot,'dist-main/local-tool-stdio.js'));
  const {browserRuntimeArgs} = require(path.join(appRoot,'dist-main/browser-runtime.js'));
  const {readExposure} = require(path.join(appRoot,'dist-main/exposure.js'));
  const {ComputerProviderStore} = require(path.join(appRoot,'dist-main/computer-provider.js'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'agentbridge-install-check-'));
  const env = {...process.env, PATH:'/usr/bin:/bin:/usr/sbin:/sbin', ELECTRON_RUN_AS_NODE:'1',
    PLAYWRIGHT_BROWSERS_PATH:path.join(temp,'empty-browser-cache'), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'};
  const nativeFile = path.join(resources,'computer-use/claudex-computer-use');
  const native = new LocalToolStdio({command:nativeFile, env}, 30000);
  const browser = new LocalToolStdio({command:process.execPath, env,
    args:[path.join(appRoot,'node_modules/@playwright/mcp/cli.js'),...browserRuntimeArgs(path.join(resources,'browser')),
      '--caps','vision,pdf,devtools','--snapshot-boxes','--headless','--user-data-dir',path.join(temp,'browser-profile'),'--output-dir',path.join(temp,'output')]}, 30000);
  const server = http.createServer((_request,response) => {
    response.setHeader('Content-Type','text/html; charset=utf-8');
    response.end('<!doctype html><title>AgentBridge install check</title><h1>AgentBridge bundled browser verified</h1>');
  });
  try {
    const policy = readExposure(path.join(temp,'missing-exposure.json'));
    if (policy.mode!=='localhost'||policy.bindHost!=='127.0.0.1') throw new Error('Fresh-install exposure is not local-only');
    const provider = new ComputerProviderStore(path.join(temp,'missing-provider.json'),nativeFile,temp).status();
    if (provider.provider!=='bundled') throw new Error('Fresh-install provider needs an external installation');
    const codex = spawnSync(path.join(resources,'codex/bin/codex'),['--version'],{encoding:'utf8',env,timeout:10000});
    if (codex.status!==0||!codex.stdout.includes('0.160.0')) throw new Error('Bundled Codex unavailable');
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const nativeTools = await native.start();
    const doctor = await native.call('doctor',{prompt:false});
    if (doctor.isError||!doctor.structuredContent?.permissions) throw new Error('Native MCP failed to run');
    const browserTools = await browser.start();
    const navigation = await browser.call('browser_navigate',{url:`http://127.0.0.1:${server.address().port}/`});
    if (navigation.isError) throw new Error('Bundled browser failed to open local test page');
    const snapshot = await browser.call('browser_snapshot',{});
    if (snapshot.isError||!JSON.stringify(snapshot).includes('AgentBridge bundled browser verified')) throw new Error('Bundled browser failed readback');
    return {version:JSON.parse(fs.readFileSync(path.join(appRoot,'package.json'),'utf8')).version,
      passed:true,codex:codex.stdout.trim(),nativeTools:nativeTools.length,nativePermissions:doctor.structuredContent.permissions,
      browserTools:browserTools.length,browserNavigation:true,browserReadback:true,
      source:'installed payload only',externalDependenciesUsed:false,network:'loopback test page only',
      provider:provider.provider,exposure:policy.mode};
  } finally {
    await Promise.all([native.stop(),browser.stop()]);
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
const resources = path.resolve(process.argv[2]||'');
if (!process.versions.electron || !fs.existsSync(path.join(resources,'app.asar'))) throw new Error('Run with packaged Electron in Node mode and its Resources path');
check(resources).then(report => console.log(JSON.stringify(report,null,2))).catch(error => {console.error(error.message);process.exitCode=1;});
