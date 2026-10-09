#!/usr/bin/env node
// Invoke using the packaged Electron executable in Node mode. No project dependencies.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
async function check(resources) {
  const appRoot = path.join(resources, 'app.asar');
  const {LocalToolHost}=require(path.join(appRoot,'dist-main/local-tool-host.js'));
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
  let coreHost;
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
    const root=await fs.promises.realpath(temp);
    coreHost=new LocalToolHost({allowedRoots:[root],stateDirectory:path.join(root,'checkpoints'),authorize:()=>true});
    let endpoint=await coreHost.start(),id=0;
    const call=async(name,args={})=>{const response=await(await fetch(endpoint.url,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args}})})).json();if(response.error||response.result?.isError)throw new Error('Packaged core tool failed: '+name);return JSON.parse(response.result.content[0].text);};
    const file=path.join(root,'acceptance.js');await call('mac_fs_write',{path:file,text:'module.exports = 1;\n'});await call('mac_fs_patch',{path:file,before:'= 1',after:'= 2'});
    const grep=await call('mac_fs_grep',{root,query:'= 2'});if(!grep.matches.some(item=>item.path===file))throw new Error('Packaged search/patch failed');
    const processJob=await call('mac_process_start',{runtime:'node',command:'const assert=require("node:assert/strict");assert.equal(require("./acceptance.js"),2);console.log("packaged task verified")',cwd:root});
    let processStatus;for(let attempt=0;attempt<100;attempt++){processStatus=await call('mac_process_status',{id:processJob.id});if(processStatus.state!=='running')break;await new Promise(resolve=>setTimeout(resolve,50));}
    if(processStatus.exitCode!==0||!processStatus.output.includes('packaged task verified'))throw new Error('Bundled Node task failed');
    await call('mac_task_plan',{action:'save',taskId:'installed-acceptance',goal:'verify packaged task',steps:[{text:'create/edit/test',status:'completed'}],expectedRevision:0,nextAction:'done'});
    await coreHost.stop();endpoint=await coreHost.start();const checkpoint=await call('mac_task_plan',{action:'read',taskId:'installed-acceptance'});if(checkpoint.goal!=='verify packaged task')throw new Error('Packaged checkpoint did not persist');
    const publicPage=await call('mac_web_fetch',{url:`http://127.0.0.1:${server.address().port}/`});if(!publicPage.text.includes('AgentBridge bundled browser verified'))throw new Error('Packaged web reader failed');
    const capabilities=await call('mac_agent_capabilities');if(!capabilities.tools.some(tool=>tool.name==='mac_mcp_resources'))throw new Error('Packaged MCP resource bridge missing');
    return {version:JSON.parse(fs.readFileSync(path.join(appRoot,'package.json'),'utf8')).version,
      coreWorkflow:true,bundledNodeExecution:true,checkpointReconnect:true,coreTools:capabilities.tools.length,
      passed:true,codex:codex.stdout.trim(),nativeTools:nativeTools.length,nativePermissions:doctor.structuredContent.permissions,
      browserTools:browserTools.length,browserNavigation:true,browserReadback:true,
      source:'installed payload only',externalDependenciesUsed:false,network:'loopback test page only',
      provider:provider.provider,exposure:policy.mode};
  } finally {
    await Promise.all([native.stop(),browser.stop(),coreHost?.stop()]);
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
const resources = path.resolve(process.argv[2]||'');
if (!process.versions.electron || !fs.existsSync(path.join(resources,'app.asar'))) throw new Error('Run with packaged Electron in Node mode and its Resources path');
check(resources).then(report => console.log(JSON.stringify(report,null,2))).catch(error => {console.error(error.message);process.exitCode=1;});
