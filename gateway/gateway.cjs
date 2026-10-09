#!/usr/bin/env node
'use strict';
// The Gateway runs as the Runtime owner. No SSH service, remote login password,
// or AI credential is transported to the Mac. Deploy behind a TLS reverse proxy.
const http=require('node:http'),https=require('node:https'),net=require('node:net');
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {pipeline}=require('node:stream/promises');
const {WebSocketServer,WebSocket}=require('ws');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const secret=()=>crypto.randomBytes(32).toString('base64url');
const MAX_FILE=64*1024*1024;
class GatewayStore{
 constructor(file){this.file=file;this.load();}
 load(){try{this.value=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Gateway state cannot be read');this.value={runtimeId:crypto.randomUUID(),devices:[]};this.save();}return this.value;}
 save(){fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.value),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 pairCode(){this.load();const code=secret();this.value.pair={hash:hash(code),expires:Date.now()+10*60*1000};this.save();return code;}
 pair(code){this.load();if(typeof code!=='string'||!this.value.pair||this.value.pair.expires<Date.now()||hash(code)!==this.value.pair.hash)return null;const credential=secret(),deviceId=crypto.randomUUID();this.value.devices.push({deviceId,hash:hash(credential),permissions:['runtime','files']});delete this.value.pair;this.save();return{runtimeId:this.value.runtimeId,deviceId,credential};}
 device(id,credential){return this.load().devices.find(x=>x.deviceId===id&&typeof credential==='string'&&x.hash===hash(credential));}
 revoke(id){this.load();this.value.devices=this.value.devices.filter(x=>x.deviceId!==id);this.save();}
}
async function readJson(req){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384)throw Error('body too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
function createGateway(options={}){
 const store=options.store||new GatewayStore(options.stateFile||path.join(os.homedir(),'.agentbridge-gateway/state.json'));
 const root=fs.realpathSync(options.root||os.homedir()),sessions=new Map(),attempts=new Map();
 const inherited=options.commandEnv||process.env,commandEnv={...inherited},oldPath=Object.entries(inherited).find(([key])=>key.toLowerCase()==='path')?.[1]||'';
 for(const key of Object.keys(commandEnv))if(key.toLowerCase()==='path')delete commandEnv[key];
 const nativePaths=process.platform==='win32'?[path.join(os.homedir(),'.local/bin'),path.join(process.env.APPDATA||os.homedir(),'npm')]:[path.join(os.homedir(),'.local/bin'),'/opt/homebrew/bin','/usr/local/bin'];
 commandEnv[process.platform==='win32'?'Path':'PATH']=[path.dirname(process.execPath),...nativePaths,oldPath].join(path.delimiter);
 const ttl=options.sessionTtlMs||300000,children=new Set(),listeners=new Set(),websockets=new Set();
 const sendJson=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 const authorization=req=>{const token=/^Bearer ([A-Za-z0-9_-]{40,})$/.exec(req.headers.authorization||'')?.[1];const s=token&&sessions.get(hash(token));if(!s||s.expires<=Date.now()||!store.load().devices.some(d=>d.deviceId===s.deviceId))return null;return s;};
 async function filePath(relative,write=false){if(typeof relative!=='string'||relative.includes('\0')||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('invalid path');const requested=path.resolve(root,relative||'.'),real=write?path.join(await fsp.realpath(path.dirname(requested)),path.basename(requested)):await fsp.realpath(requested);if(real!==root&&!real.startsWith(root+path.sep))throw Error('outside root');if(write){try{await fsp.lstat(real);throw Error('already exists');}catch(e){if(e.code!=='ENOENT')throw e;}}return real;}
 const handler=async(req,res)=>{try{
  const u=new URL(req.url,'http://localhost');
  if(req.headers.origin){sendJson(res,403,{code:'ERR_AUTH'});return;}
  if(req.method==='GET'&&u.pathname==='/health'){sendJson(res,200,{protocol:1,status:'ready'});return;}
  if(req.method==='POST'&&u.pathname==='/pair'){
   const key='pair';const now=Date.now(),previous=attempts.get(key);const count=previous&&now-previous.at<60000?previous.count:0;
   if(count>=10){sendJson(res,429,{code:'ERR_PAIR_RATE_LIMIT'});return;}attempts.set(key,{at:previous&&now-previous.at<60000?previous.at:now,count:count+1});
   const payload=await readJson(req),result=store.pair(payload.code);sendJson(res,result?200:403,result||{code:'ERR_PAIR_CODE'});return;
  }
  if(req.method==='POST'&&u.pathname==='/session'){
   const p=await readJson(req),d=store.device(p.deviceId,p.credential);
   if(!d||p.runtimeId!==store.value.runtimeId){sendJson(res,403,{code:'ERR_AUTH'});return;}
   if(sessions.size>=4096){sendJson(res,429,{code:'ERR_SESSION_RATE_LIMIT'});return;}const token=secret(),session={deviceId:d.deviceId,runtimeId:store.value.runtimeId,permissions:d.permissions,expires:Date.now()+ttl,wsUsed:false};
   sessions.set(hash(token),session);sendJson(res,200,{token,expires:session.expires,runtimeId:session.runtimeId,permissions:session.permissions});return;
  }
  const session=authorization(req);if(!session){sendJson(res,403,{code:'ERR_AUTH'});return;}
  if(!session.permissions.includes('files')){sendJson(res,403,{code:'ERR_AUTH'});return;}
  if(req.method==='GET'&&u.pathname==='/files'){
   const directory=await filePath(u.searchParams.get('path')||'');const entries=await fsp.readdir(directory,{withFileTypes:true});
   const items=[];for(const entry of entries.slice(0,2000)){if(entry.isSymbolicLink())continue;const stat=await fsp.stat(path.join(directory,entry.name));items.push({name:entry.name,path:path.relative(root,path.join(directory,entry.name)).split(path.sep).join('/'),isDirectory:stat.isDirectory(),size:stat.size,modified:stat.mtimeMs});}
   sendJson(res,200,{path:path.relative(root,directory).split(path.sep).join('/'),items,maxFileBytes:MAX_FILE});return;
  }
  if(req.method==='GET'&&u.pathname==='/file'){
   const file=await filePath(u.searchParams.get('path')),stat=await fsp.stat(file);if(!stat.isFile()||stat.size>MAX_FILE)throw Error('file size');
   res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-store'});await pipeline(fs.createReadStream(file),res);return;
  }
  if(req.method==='PUT'&&u.pathname==='/file'){
   const size=Number(req.headers['content-length']);if(!Number.isInteger(size)||size<0||size>MAX_FILE)throw Error('file size');
   const file=await filePath(u.searchParams.get('path'),true),temp=file+'.agentbridge-'+crypto.randomUUID();let received=0;
   req.on('data',chunk=>{received+=chunk.length;if(received>size)req.destroy();});
   try{await pipeline(req,fs.createWriteStream(temp,{flags:'wx',mode:0o600}));if(received!==size)throw Error('incomplete upload');await fsp.link(temp,file);sendJson(res,201,{saved:true,bytes:received});}finally{await fsp.rm(temp,{force:true});}return;
  }
  sendJson(res,404,{code:'ERR_NOT_FOUND'});
 }catch{if(!res.headersSent)sendJson(res,400,{code:'ERR_REQUEST'});else res.destroy();}};
 const server=options.tls?https.createServer(options.tls,handler):http.createServer(handler);
 server.requestTimeout=120000;server.headersTimeout=15000;
 const wss=new WebSocketServer({noServer:true,maxPayload:256*1024,perMessageDeflate:false});
 server.on('upgrade',(req,socket,head)=>{
  const session=authorization(req);
  if(req.url!=='/runtime'||req.headers.origin||!session||session.wsUsed||!session.permissions.includes('runtime')){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  session.wsUsed=true;wss.handleUpgrade(req,socket,head,ws=>serveSocket(ws,session));
 });
 function serveSocket(ws,session){
  websockets.add(ws);const channels=new Map(),owned=new Set(),forwards=new Map();let alive=true;
  const send=value=>{if(ws.readyState!==WebSocket.OPEN)return;if(ws.bufferedAmount>8*1024*1024){ws.close(1009,'backpressure');return;}ws.send(JSON.stringify(value));};
  const data=(id,kind,chunk)=>{for(let i=0;i<chunk.length;i+=65536)send({op:kind,id,data:chunk.subarray(i,i+65536).toString('base64')});};
  const reply=(id,value={})=>send({op:'reply',id,...value});
  const kill=child=>{if(!child.pid)return;try{if(process.platform==='win32')spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});else process.kill(-child.pid,'SIGKILL');}catch{}};
  const attach=(id,stream,err)=>{channels.set(id,stream);stream.on('data',chunk=>data(id,'data',chunk));if(err)err.on('data',chunk=>data(id,'stderr',chunk));stream.on('error',()=>send({op:'channel.error',id,code:'ERR_CHANNEL'}));};
  send({op:'hello',runtimeId:session.runtimeId,platform:process.platform,protocol:1});
  ws.on('pong',()=>{alive=true;});
  const heartbeat=setInterval(()=>{try{if(!alive||session.expires<=Date.now()||!store.load().devices.some(d=>d.deviceId===session.deviceId)){ws.close(session.expires<=Date.now()?4401:4408,'connection expired');return;}alive=false;ws.ping();}catch{ws.close(4401,'authorization unavailable');}},options.heartbeatMs||20000);
  ws.on('message',raw=>{void (async()=>{let m;try{
   m=JSON.parse(raw.toString());if(typeof m.id!=='string'||m.id.length>100)throw Error('id');
   if(m.op==='renew'){const updated=sessions.get(hash(m.token||''));if(!updated||updated.expires<=Date.now()||updated.wsUsed||updated.deviceId!==session.deviceId||updated.runtimeId!==session.runtimeId)throw Error('renew');updated.wsUsed=true;session.expires=updated.expires;reply(m.id);return;}
   if(m.op==='ping'){reply(m.id,{at:Date.now()});return;}
   if(m.op==='exec'){
    if(typeof m.command!=='string'||m.command.length>65536||m.command.includes('\0')||channels.has(m.id)||owned.size>=16)throw Error('exec');
    const child=process.platform==='win32'?spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c',m.command],{cwd:root,env:commandEnv,stdio:'pipe',windowsHide:true}):spawn('/bin/bash',['-c',m.command],{cwd:root,env:commandEnv,stdio:'pipe',detached:true});
    owned.add(child);children.add(child);attach(m.id,child.stdout,child.stderr);channels.set(m.id,{write:x=>child.stdin.write(x),end:()=>child.stdin.end(),destroy:()=>kill(child)});
    child.once('spawn',()=>reply(m.id));child.on('error',()=>reply(m.id,{error:'ERR_EXEC'}));child.on('close',code=>{owned.delete(child);children.delete(child);channels.delete(m.id);send({op:'channel.close',id:m.id,code});});return;
   }
   if(m.op==='forward'){
    if(m.host!=='127.0.0.1'||m.port!==0||forwards.size>=8)throw Error('forward');
    const listener=net.createServer(socket=>{if(channels.size>=64){socket.destroy();return;}const id=crypto.randomUUID();socket.pause();attach(id,socket);send({op:'incoming',id,port:listener.address().port});socket.on('close',()=>{channels.delete(id);send({op:'channel.close',id,code:0});});});
    await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});if(ws.readyState!==WebSocket.OPEN){listener.close();return;}const port=listener.address().port;forwards.set(port,listener);listeners.add(listener);reply(m.id,{port});return;
   }
   if(m.op==='unforward'){const l=forwards.get(m.port);l?.close();if(l)listeners.delete(l);forwards.delete(m.port);reply(m.id);return;}
   const channel=channels.get(m.id);if(!channel)throw Error('channel');
   if(m.op==='accept'){channel.resume();return;}
   if(m.op==='data'){if(typeof m.data!=='string'||m.data.length>90000||!/^[A-Za-z0-9+/]*={0,2}$/.test(m.data))throw Error('data');channel.write(Buffer.from(m.data,'base64'));return;}
   if(m.op==='end'){channel.end();return;}
   if(m.op==='close'){channel.destroy();return;}
   throw Error('operation');
  }catch{if(m&&typeof m.id==='string')reply(m.id,{error:'ERR_RELAY_PROTOCOL'});else ws.close(1008,'invalid protocol');}})();});
  ws.on('error',()=>{});ws.on('close',()=>{clearInterval(heartbeat);websockets.delete(ws);for(const c of channels.values())c.destroy();for(const c of owned)kill(c);for(const l of forwards.values()){l.close();listeners.delete(l);}});
 }
 const sweeper=setInterval(()=>{const now=Date.now();for(const [key,s]of sessions)if(s.expires<=now)sessions.delete(key);},60000);sweeper.unref();
 return{server,store,root,async listen(port=8787){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return server.address().port;},async close(){clearInterval(sweeper);for(const ws of websockets)ws.terminate();for(const l of listeners)l.close();await new Promise(resolve=>server.close(resolve));}};
}
module.exports={createGateway,GatewayStore};
if(require.main===module){
 const stateFile=process.env.AGENTBRIDGE_GATEWAY_STATE||path.join(os.homedir(),'.agentbridge-gateway/state.json');
 const store=new GatewayStore(stateFile);
 if(process.argv.includes('--pair')){
  // An explicitly requested, one-time setup display, never a persistent log.
  process.stdout.write('一次性配對碼（10 分鐘內有效；請只貼入自己的 AgentBridge App）：\n'+store.pairCode()+'\n');
 }else if(process.argv.includes('--revoke')){store.revoke(process.argv[process.argv.indexOf('--revoke')+1]);process.stdout.write('設備授權已撤銷。\n');}
 else{
  let config={};try{config=JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Gateway config cannot be read');}
  const gateway=createGateway({store,root:process.env.AGENTBRIDGE_GATEWAY_ROOT||config.root||os.homedir()});
  gateway.listen(Number(process.env.AGENTBRIDGE_GATEWAY_PORT||config.port||8787)).then(()=>process.stdout.write('AgentBridge Gateway 已啟動，只監聽本機。請設定 HTTPS Tunnel。\n')).catch(()=>{process.stderr.write('Gateway 無法啟動。\n');process.exitCode=1;});
  for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>void gateway.close().then(()=>process.exit(0)));
 }
}
