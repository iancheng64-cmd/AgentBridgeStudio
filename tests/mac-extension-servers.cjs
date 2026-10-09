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

test('resource-only MCP is connected without tools/list and exposes resources/templates/prompts with approval',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ab-resource-'));let allow=true;
 const script=`require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={capabilities:{resources:{},prompts:{}}};if(m.method==='tools/list')throw Error('resources-only must not call tools/list');if(m.method==='resources/list')result={resources:[{uri:'fixture://proof',name:'proof'}],nextCursor:'next'};if(m.method==='resources/templates/list')result={resourceTemplates:[{uriTemplate:'fixture://{id}',name:'template'}]};if(m.method==='resources/read')result={contents:[{uri:m.params.uri,text:'Resource readback'}]};if(m.method==='prompts/list')result={prompts:[{name:'review'}]};if(m.method==='prompts/get')result={messages:[{role:'user',content:{type:'text',text:'Review '+m.params.arguments.subject}}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`;
 const host=new LocalToolHost({allowedRoots:[root],authorize:()=>allow,extensionServers:[{id:'resource',name:'Resource fixture',transport:'stdio',command:{command:process.execPath,args:['-e',script]}}]});
 try{const endpoint=await host.start();const call=async(name,args)=>(await(await fetch(endpoint.url,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;
 assert.equal(host.status().extensions[0].status,'connected');assert.equal(host.status().extensions[0].toolCount,0);
 const resources=JSON.parse((await call('mac_mcp_resources',{serverId:'resource',action:'list'})).content[0].text);assert.equal(resources.nextCursor,'next');assert.equal(resources.resources[0].uri,'fixture://proof');
 assert.match(JSON.stringify(await call('mac_mcp_resources',{serverId:'resource',action:'templates'})),/uriTemplate/);
 assert.match(JSON.stringify(await call('mac_mcp_resources',{serverId:'resource',action:'read',uri:resources.resources[0].uri})),/Resource readback/);
 assert.match(JSON.stringify(await call('mac_mcp_prompts',{serverId:'resource',action:'get',name:'review',arguments:{subject:'actual subject'}})),/actual subject/);
 allow=false;assert.equal((await call('mac_mcp_resources',{serverId:'resource',action:'read',uri:'fixture://proof'})).isError,true);
 }finally{await host.stop();await fs.rm(root,{recursive:true,force:true});}
});

test('HTTP MCP resources use the configured authenticated transport without leaking its header',async()=>{
 const http=require('node:http');const server=http.createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer fixture-only-secret');if(req.method!=='POST'){res.writeHead(405);res.end();return;}const chunks=[];for await(const chunk of req)chunks.push(chunk);const m=JSON.parse(Buffer.concat(chunks).toString());if(m.id===undefined){res.writeHead(202);res.end();return;}const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{resources:{}},serverInfo:{name:'resources',version:'1'}}:m.method==='resources/read'?{contents:[{uri:m.params.uri,text:'HTTP resource actual readback'}]}:{resources:[{uri:'fixture://http',name:'HTTP'}]};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ab-resource-http-'));const host=new LocalToolHost({allowedRoots:[root],authorize:()=>true,extensionServers:[{id:'http-resource',name:'HTTP resource',transport:'http',url:`http://127.0.0.1:${server.address().port}/mcp`,headers:{Authorization:'Bearer fixture-only-secret'}}]});
 try{const endpoint=await host.start();assert.equal(host.status().extensions[0].status,'connected');assert.equal(JSON.stringify(host.status()).includes('fixture-only-secret'),false);
 const response=await(await fetch(endpoint.url,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'mac_mcp_resources',arguments:{serverId:'http-resource',action:'read',uri:'fixture://http'}}})})).json();assert.match(JSON.stringify(response.result),/HTTP resource actual readback/);assert.notEqual(response.result.isError,true);
 }finally{await host.stop();await fs.rm(root,{recursive:true,force:true});server.closeAllConnections();await new Promise(r=>server.close(r));}
});
