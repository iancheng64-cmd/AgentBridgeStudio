const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {discoverMacCodexServers}=require('../dist-main/mac-extension-servers.js');
const {LocalToolHost}=require('../dist-main/local-tool-host.js');

test('private Codex config parsing preserves transports, skips disabled/auth-helper servers, and exposes only sanitized status',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ab-ext-config-'));const configFile=path.join(dir,'config.toml');
 try{
  await fs.writeFile(configFile,`[mcp_servers."quoted.name"]\ncommand = "node"\nargs = ["server.js"]\nenv = { PRIVATE = "test-private-value" }\n[mcp_servers.web]\nurl = "https://example.invalid/mcp"\nbearer_token_env_var = "TEST_MCP_TOKEN"\n[mcp_servers.disabled]\ncommand = "never"\nenabled = false\n[mcp_servers.oauth]\nurl = "https://example.invalid/login"\nhttp_headers_helper = "never-execute"\n`);
  const result=await discoverMacCodexServers({configFile,cwd:dir,environment:{TEST_MCP_TOKEN:'private-token'}});
  assert.equal(result.servers.length,2);assert.equal(result.servers[0].name,'quoted.name');
  assert.equal(result.servers[0].command.env.PRIVATE,'test-private-value');assert.equal(result.servers[1].headers.Authorization,'Bearer private-token');
  assert.equal(JSON.stringify(result.statuses).includes('private'),false);assert.equal(JSON.stringify(result.statuses).includes('example.invalid'),false);
  assert.equal(result.statuses.find(x=>x.name==='oauth').status,'needs-auth');
  const disabled=await discoverMacCodexServers({configFile,enabledIds:new Set(),environment:{}});assert.equal(disabled.servers.length,0);
  const missing=await discoverMacCodexServers({configFile,environment:{}});assert.equal(missing.statuses.find(x=>x.name==='web').status,'needs-auth');
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('real authenticated HTTP extension is proxied on Mac, namespaced, approved, and stripped from public status',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ab-ext-http-'));const root=await fs.realpath(dir);await fs.writeFile(path.join(root,'proof.txt'),'Mac extension proof');
 const downstream=new LocalToolHost({allowedRoots:[root],authorize:()=>true});const endpoint=await downstream.start();let approved=false;const observed=[];
 const proxy=new LocalToolHost({allowedRoots:[root],authorize:call=>{observed.push(call);return approved;},extensionServers:[{id:'http-fixture',name:'Local extension fixture',transport:'http',url:endpoint.url,headers:{Authorization:`Bearer ${endpoint.token}`},enabledTools:['mac_fs_read']}]});
 try{
  const front=await proxy.start();const tool=proxy.listTools().find(x=>x.name.startsWith('mac_ext_'));assert.ok(tool);assert.equal(proxy.status().extensions[0].status,'connected');assert.equal(proxy.status().extensions[0].toolCount,1);
  assert.equal(JSON.stringify(proxy.status()).includes(endpoint.token),false);assert.equal(JSON.stringify(proxy.status()).includes(endpoint.url),false);
  const call=async()=> (await(await fetch(front.url,{method:'POST',headers:{Authorization:`Bearer ${front.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool.name,arguments:{path:path.join(root,'proof.txt')}}})})).json()).result;
  assert.equal((await call()).isError,true);assert.equal(observed[0].category,'extension');approved=true;
  assert.match(JSON.stringify(await call()),/Mac extension proof/);
 }finally{await proxy.stop();await downstream.stop();await fs.rm(root,{recursive:true,force:true})}
});

test('extension stdio pagination, private environment, and child cleanup are real',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ab-ext-stdio-'));
 const script=`const r=require('readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='tools/list')result=m.params.cursor?{tools:[{name:'second',inputSchema:{type:'object'}}]}:{tools:[{name:'first',inputSchema:{type:'object'}}],nextCursor:'page2'};if(m.method==='tools/call')result={content:[{type:'text',text:process.env.PRIVATE}],structuredContent:{pid:process.pid}};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')});`;
 const host=new LocalToolHost({allowedRoots:[dir],authorize:()=>true,extensionServers:[{id:'stdio',name:'stdio fixture',transport:'stdio',command:{command:process.execPath,args:['-e',script],env:{PRIVATE:'local-env-proof'}}}]});
 try{const endpoint=await host.start();const tools=host.listTools().filter(x=>x.name.startsWith('mac_ext_'));assert.equal(tools.length,2);
 const result=(await(await fetch(endpoint.url,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tools[1].name,arguments:{}}})})).json()).result;
 assert.equal(result.content[0].text,'local-env-proof');const pid=result.structuredContent.pid;await host.stop();assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{await host.stop();await fs.rm(dir,{recursive:true,force:true})}
});
