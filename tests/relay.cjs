const {test}=require('node:test'),assert=require('node:assert/strict'),https=require('node:https'),fs=require('node:fs/promises'),net=require('node:net');
const {fixture}=require('./helpers/relay-fixture.cjs');const {relayUrl,relayRequest,RelayConnection}=require('../dist-main/relay-connection');const {connectNetwork,retryDelay}=require('../dist-main/connection-network');
const exec=(conn,command)=>new Promise((resolve,reject)=>conn.exec(command,{},(error,stream)=>{if(error)return reject(error);let out='',err='';stream.on('data',b=>out+=b);stream.stderr.on('data',b=>err+=b);stream.on('close',code=>resolve({out,err,code}));}));
const http=(f,route,token,method='GET',data,headers={})=>new Promise((resolve,reject)=>{const req=https.request(f.base+route,{ca:f.ca,method,headers:{Authorization:'Bearer '+token,...(data?{'Content-Length':data.length}:{}),...headers}},res=>{let body=[];res.on('data',b=>body.push(b));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(body)}));res.on('error',reject);});req.on('error',reject);req.end(data);});
test('HTTPS-only validation and fallback preserve identity confirmations; bounded retry',async()=>{
 for(const url of ['http://a.test','https://a.test:8787','https://user:secret@a.test','https://a.test/?token=x'])assert.throws(()=>relayUrl(url));assert.equal(relayUrl('https://a.test'),'https://a.test');
 let relays=0;const relay=async()=>{relays++;return{end(){}}};const input={profile:{networkMode:'auto',relayUrl:'https://a.test',id:'test'}};
 const challenge={confirmation:{status:'host-confirmation'}};assert.equal(await connectNetwork(input,async()=>challenge,relay),challenge);assert.equal(relays,0);
 const direct=await connectNetwork(input,async()=>({conn:{},key:'ssh'}),relay);assert.equal(direct.transport,'tailscale-ssh');assert.equal(relays,0);
 const fallback=await connectNetwork(input,async()=>{throw Error('timeout');},relay);assert.equal(fallback.transport,'https-relay');assert.equal(fallback.diagnostics[0].status,'failed');
 await assert.rejects(connectNetwork({...input,profile:{...input.profile,networkMode:'direct'}},async()=>{throw Error('timeout');},relay));assert.equal(relays,1);
 for(let i=0;i<20;i++)assert.ok(retryDelay(i,()=>1)<=15000);
});
test('real TLS/WSS stream, reverse TCP, cancel and HTTP files without SSH',async()=>{
 const f=await fixture();let echo;try{
  assert.equal((await exec(f.conn,"printf '繁體中文'; printf error >&2")).out,'繁體中文');
  assert.equal((await exec(f.conn,'printf hello')).code,0);assert.equal((await exec(f.conn,'node --version')).out.trim(),process.version);
  echo=net.createServer(socket=>socket.pipe(socket));await new Promise(r=>echo.listen(0,'127.0.0.1',r));f.conn.on('tcp connection',(_info,accept)=>{const stream=accept(),socket=net.connect(echo.address().port,'127.0.0.1');socket.pipe(stream).pipe(socket);socket.on('error',()=>stream.destroy());});
  const port=await new Promise((r,j)=>f.conn.forwardIn('127.0.0.1',0,(e,p)=>e?j(e):r(p)));assert.match((await exec(f.conn,`${JSON.stringify(process.execPath)} -e 'const s=require("net").connect(${port},"127.0.0.1");s.on("connect",()=>s.write("reverse-proof"));s.on("data",b=>{process.stdout.write(b);s.end()})'`)).out,/reverse-proof/);
  await new Promise(r=>f.conn.unforwardIn('127.0.0.1',port,r));
  const pid=await new Promise((r,j)=>f.conn.exec(`${JSON.stringify(process.execPath)} -e 'console.log(process.pid);setInterval(()=>{},1000)'`,{},(e,c)=>{if(e)return j(e);c.once('data',b=>{const pid=Number(b.toString().trim());c.close();r(pid);});}));await new Promise(r=>setTimeout(r,150));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  const s=await f.request('/session',f.credential),bytes=Buffer.alloc(2*1024*1024,123);assert.equal((await http(f,'/file?path=upload.bin',s.token,'PUT',bytes)).status,201);assert.deepEqual((await http(f,'/file?path=upload.bin',s.token)).body,bytes);assert.equal((await http(f,'/file?path=upload.bin',s.token,'PUT',bytes)).status,400);assert.equal((await http(f,'/file?path=../outside',s.token)).status,400);
  assert.equal((await http(f,'/files',s.token,'GET',undefined,{Origin:'https://evil.invalid'})).status,403);
  await assert.rejects(f.request('/pair',{code:f.code}),/ERR_AUTH/);await assert.rejects(relayRequest(f.base,'/health'),/TLS/);
  const wrong=new RelayConnection({...f.credential,credential:'x'.repeat(43)},f.ca);await assert.rejects(wrong.connect(),/ERR_AUTH/);
  f.store.revoke(f.credential.deviceId);await assert.rejects(f.request('/session',f.credential),/ERR_AUTH/);
 }finally{echo?.close();await f.close();}
});
test('expired session and revoked live device cannot keep executing',async()=>{
 const f=await fixture({sessionTtlMs:100,heartbeatMs:30});try{await new Promise(r=>setTimeout(r,200));await assert.rejects(exec(f.conn,'printf forbidden'),/CLOSED|closed/);}finally{await f.close();}
});
test('Codex JSON RPC, models and account usage stream over the same TLS transport',async()=>{
 const {AppServerRpc}=require('../dist-main/app-server-rpc'),f=await fixture();let rpc;try{
  const file=f.root+'/codex-fixture.cjs';await fs.writeFile(file,`const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const data={initialize:{platformOs:'darwin'},'account/read':{account:{type:'chatgpt',planType:'plus'}},'model/list':{data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture Model'}]},'account/rateLimits/read':{rateLimits:{primary:{usedPercent:40,windowDurationMins:300,resetsAt:1800000000}}},'thread/start':{thread:{id:'fixture-thread'}},'turn/start':{turn:{id:'fixture-turn'}},'turn/interrupt':{}};out({id:m.id,result:data[m.method]||{}});if(m.method==='turn/start'){out({method:'item/agentMessage/delta',params:{threadId:'fixture-thread',turnId:'fixture-turn',delta:'TLS streamed response'}});out({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed'}}});}});`);
  const channel=await new Promise((r,j)=>f.conn.exec(`${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`,{},(e,c)=>e?j(e):r(c)));rpc=new AppServerRpc(channel);const events=[];rpc.on('notification',value=>events.push(value));assert.equal((await rpc.request('initialize',{})).platformOs,'darwin');assert.equal((await rpc.request('model/list',{})).data[0].id,'fixture-model');assert.equal((await rpc.request('account/rateLimits/read',{})).rateLimits.primary.usedPercent,40);await rpc.request('thread/start',{});await rpc.request('turn/start',{});await new Promise(r=>setTimeout(r,50));assert.ok(events.some(e=>e.method==='turn/completed'));assert.ok(events.some(e=>e.params?.delta==='TLS streamed response'));await rpc.request('turn/interrupt',{});
 }finally{rpc?.close();await f.close();}
});
