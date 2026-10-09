const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const http=require('node:http');const {execFileSync}=require('node:child_process');
const {ComputerProviderStore}=require('../dist-main/computer-provider');
const {LocalToolHost,hasLiveLocalToolHosts}=require('../dist-main/local-tool-host');
const {probeNativePermissions,nativePermissions}=require('../dist-main/native-diagnostics');
const {httpToolHealth,requireTailnetBinding}=require('../dist-main/http-tool-health');
const externalPath=home=>path.join(home,'.hermes/node/lib/node_modules/open-computer-use/dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse');
test('explicit provider persists across reopen; missing external never falls back to a valid bundled executable',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ab-provider-'));const file=path.join(home,'provider.json');const external=externalPath(home);
 try{await fs.mkdir(path.dirname(external),{recursive:true});await fs.writeFile(external,'fixture',{mode:0o700});const store=new ComputerProviderStore(file,process.execPath,home);assert.equal(store.status().provider,'bundled');store.select('open-computer-use');const reopened=new ComputerProviderStore(file,process.execPath,home);assert.deepEqual(reopened.command(),{command:external,args:['mcp'],computerProvider:'open-computer-use'});await fs.rm(external);assert.equal(reopened.status().provider,'open-computer-use');assert.throws(()=>reopened.command(),/不存在/);assert.throws(()=>reopened.select('unexpected'),/無效/);reopened.select('bundled');assert.equal(new ComputerProviderStore(file,process.execPath,home).status().provider,'bundled');await fs.writeFile(file,'not-json');assert.throws(()=>new ComputerProviderStore(file,process.execPath,home),/損壞/);}finally{await fs.rm(home,{recursive:true,force:true});}
});
const schema={type:'object',properties:{app:{type:'string'},text_limit:{anyOf:[{type:'integer'},{const:'max'}]}},required:['app']};
const fixture=`require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='tools/list')result={tools:[{name:'list_apps',inputSchema:{type:'object'}},{name:'get_app_state',inputSchema:${JSON.stringify(schema)}}]};if(m.method==='tools/call'){if(m.params.name==='doctor')process.exit(2);result={content:[{type:'text',text:'fixture'},{type:'image',mimeType:'image/png',data:'ZmFrZQ=='}],structuredContent:{app:m.params.arguments.app,pid:process.pid}};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`;
const command={command:process.execPath,args:['-e',fixture],computerProvider:'open-computer-use'};
test('external provider forwards original schemas/images through authenticated Runtime tool host and reads list_apps without fabricating permissions',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ab-computer-'));const host=new LocalToolHost({allowedRoots:[root],nativeCommand:command,authorize:()=>true});
 try{const endpoint=await host.start();assert.equal(hasLiveLocalToolHosts(),true);const tool=host.listTools().find(t=>t.name==='mac_computer_get_app_state');assert.deepEqual(tool.inputSchema,schema);assert.equal(host.status().computerProvider,'open-computer-use');assert.equal(host.listTools().some(t=>t.name==='mac_computer_doctor'),false);
 const report=await host.computerDiagnostics();assert.equal(report.health.probe,'list_apps');assert.deepEqual(nativePermissions(report),{accessibility:undefined,screenRecording:undefined});
 const reply=await (await fetch(endpoint.url,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool.name,arguments:{app:'fixture.app',text_limit:'max'}}})})).json();assert.equal(reply.result.structuredContent.app,'fixture.app');assert.equal(reply.result.content[1].type,'image');const pid=reply.result.structuredContent.pid;await host.stop();assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 const privateProbe=await probeNativePermissions(command);assert.equal(privateProbe.source,'open-computer-use');assert.equal(privateProbe.permissions,undefined);await assert.rejects(probeNativePermissions(command,true),/不提供權限請求/);
 }finally{await host.stop();await fs.rm(root,{recursive:true,force:true});}
});
test('selected external startup failure does not register bundled computer tools',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ab-computer-fail-'));const host=new LocalToolHost({allowedRoots:[root],nativeCommand:{command:path.join(root,'missing'),computerProvider:'open-computer-use'},appPath:process.cwd(),authorize:()=>true});
 try{await host.start();assert.equal(host.status().computer,'unavailable');assert.equal(host.status().computerProvider,'open-computer-use');assert.equal(host.listTools().some(t=>t.name.startsWith('mac_computer_')),false);await assert.rejects(host.computerDiagnostics(),/尚未啟動/);}finally{await host.stop();await fs.rm(root,{recursive:true,force:true});}
});
async function httpFixture(tool,isError,run){let deleted=0;const calls=[];const server=http.createServer(async(req,res)=>{
 if(req.method==='DELETE'){deleted++;res.writeHead(200).end();return;}if(req.method==='GET'){res.writeHead(405).end();return;}
 let body='';for await(const part of req)body+=part;const m=JSON.parse(body);if(m.id===undefined){res.writeHead(202).end();return;}
 let result={};if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic provider',version:'fixture'}};
 if(m.method==='tools/list')result={tools:[{name:tool,inputSchema:{type:'object'}}]};if(m.method==='tools/call'){calls.push(m.params);result={isError,content:[{type:'text',text:'private fixture contents'}]};}
 res.writeHead(200,{'Content-Type':'application/json','mcp-session-id':'fixture-session'}).end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{await run(`http://127.0.0.1:${server.address().port}/mcp`,calls);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}assert.ok(deleted>0,'health terminates its owned HTTP session');
}
test('HTTP health initializes actual protocol, calls selected read-only tool and releases session without retaining app contents',async()=>{
 await httpFixture('list_apps',false,async(url,calls)=>{const result=await httpToolHealth(url,'computer','open-computer-use');assert.equal(result.source,'open-computer-use');assert.equal(result.probe,'list_apps');assert.equal(result.toolCount,1);assert.equal(JSON.stringify(result).includes('private fixture contents'),false);assert.deepEqual(calls,[{name:'list_apps',arguments:{}}]);});
 await httpFixture('browser_tabs',false,async(url,calls)=>{assert.equal((await httpToolHealth(url,'browser')).source,'playwright');assert.deepEqual(calls,[{name:'browser_tabs',arguments:{action:'list'}}]);});
 await httpFixture('list_apps',true,async url=>{await assert.rejects(httpToolHealth(url,'computer','open-computer-use'),/唯讀檢查失敗/);});
 await httpFixture('doctor',false,async url=>{await assert.rejects(httpToolHealth(url,'computer','open-computer-use'),/不是所選/);});
});
test('HTTP binding policy rejects all-interface and non-Tailnet hosts; gateway preload binds real listening socket only to loopback',()=>{
 requireTailnetBinding('tailscale','100.99.1.2');for(const [mode,host]of [['tailscale','0.0.0.0'],['all','100.99.1.2'],['tailscale','127.0.0.1'],['tailscale','192.168.1.10'],['tailscale','100.128.1.2']])assert.throws(()=>requireTailnetBinding(mode,host),/Tailscale/);
 const preload=path.join(__dirname,'../dist-main/gateway-loopback.js');const script="const server=require('http').createServer();server.listen(0,()=>{process.stdout.write(JSON.stringify(server.address()));server.close();});";
 const address=JSON.parse(execFileSync(process.execPath,['--require',preload,'-e',script],{encoding:'utf8'}));assert.equal(address.address,'127.0.0.1');assert.equal(address.family,'IPv4');
 const denied=execFileSync(process.execPath,['--require',preload,'-e',"try{require('http').createServer().listen(0,'0.0.0.0')}catch{process.stdout.write('denied')}"],{encoding:'utf8'});assert.equal(denied,'denied');
});
