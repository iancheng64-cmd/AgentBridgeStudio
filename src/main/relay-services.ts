import {StringDecoder} from 'node:string_decoder';
import {app,dialog,ipcMain,powerMonitor} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {RelayStore} from './relay-store';
import {relayRequest} from './relay-connection';
export function registerRelayServices(store:RelayStore,emit:(channel:string,payload:any)=>void){
 const transfers=new Map<string,AbortController>(),terminals=new Map<string,any>();
 ipcMain.handle('network:pair',(_e,input:any)=>store.pair(input.profileId,input.url,input.code));
 ipcMain.handle('network:diagnose',async(_e,input:any)=>{const started=Date.now();const conn=await store.connect({profile:{id:input.profileId,relayUrl:input.url}});conn.end();return{stage:'HTTPS、設備驗證與 WSS',status:'ok',durationMs:Date.now()-started};});
 ipcMain.handle('network:files',async(_e,input:any)=>{const c=store.credential(input.profileId,input.url),s=await relayRequest(c.baseUrl,'/session',{...c});return relayRequest(c.baseUrl,'/files?path='+encodeURIComponent(input.path||''),undefined,s.token);});
 ipcMain.handle('network:cancelTransfer',(_e,id:string)=>{transfers.get(id)?.abort();return{cancelled:true};});
 ipcMain.handle('network:transfer',async(_e,input:any)=>{
  if(!['upload','download'].includes(input.direction))throw Error('傳輸方向無效。');
  const c=store.credential(input.profileId,input.url),s=await relayRequest(c.baseUrl,'/session',{...c});
  const chosen=input.direction==='upload'?await dialog.showOpenDialog({properties:['openFile']}):await dialog.showSaveDialog({defaultPath:path.basename(input.path)});
  if(chosen.canceled)return{cancelled:true};const file=input.direction==='upload'?(chosen as any).filePaths[0]:(chosen as any).filePath;
  const size=input.direction==='upload'?fs.statSync(file).size:undefined;if(size!==undefined&&size>64*1024*1024)throw Error('單檔上限為 64 MiB。');
  const id=typeof input.id==='string'?input.id:randomUUID(),controller=new AbortController();if(transfers.has(id))throw Error('傳輸已在進行。');transfers.set(id,controller);
  const relative=input.direction==='upload'?[input.path||'',path.basename(file)].filter(Boolean).join('/'):input.path;
  const temporary=file+'.agentbridge-'+randomUUID();let bytes=0;
  const meter=new Transform({transform(chunk,_enc,done){bytes+=chunk.length;if(bytes>64*1024*1024){done(Error('檔案超過上限'));return;}emit('network:event',{type:'transfer',id,bytes,total:size});done(null,chunk);}});
  try{
   await new Promise<void>((resolve,reject)=>{
    const req=https.request(new URL('/file?path='+encodeURIComponent(relative),c.baseUrl),{method:input.direction==='upload'?'PUT':'GET',signal:controller.signal,headers:{Authorization:'Bearer '+s.token,...(size!==undefined?{'Content-Length':size}:{})}},res=>{
     if(res.statusCode!==(input.direction==='upload'?201:200)){res.resume();reject(Error('檔案傳輸未成功；請確認路徑、設備授權與檔案上限。'));return;}
     if(input.direction==='download'){const length=Number(res.headers['content-length']);if(!Number.isInteger(length)||length<0||length>64*1024*1024){res.destroy();reject(Error('檔案大小無效。'));return;}void pipeline(res,meter,fs.createWriteStream(temporary,{flags:'wx',mode:0o600}),{signal:controller.signal}).then(()=>{if(bytes!==length)throw Error('檔案未完整傳輸');fs.renameSync(temporary,file);resolve();}).catch(reject);}else{res.resume();res.on('end',resolve);res.on('error',reject);}
    });req.setTimeout(30000,()=>req.destroy(Error('傳輸逾時')));req.on('error',reject);
    if(input.direction==='upload')void pipeline(fs.createReadStream(file),meter,req,{signal:controller.signal}).catch(reject);else req.end();
   });return{saved:true,bytes};
  }finally{transfers.delete(id);if(input.direction==='download')fs.rmSync(temporary,{force:true});}
 });
 ipcMain.handle('network:terminal',async(_e,input:any)=>{
  const id=randomUUID(),conn=await store.connect({profile:{id:input.profileId,relayUrl:input.url}});
  try{const channel:any=await new Promise((resolve,reject)=>conn.exec((conn as any).platform==='win32'?'powershell.exe -NoLogo -NoProfile':'/bin/bash -i',{},(error,stream)=>error?reject(error):resolve(stream)));terminals.set(id,{conn,channel});const stdout=new StringDecoder('utf8'),stderr=new StringDecoder('utf8');channel.on('data',(data:Buffer)=>emit('network:event',{type:'terminal',id,text:stdout.write(data)}));channel.stderr.on('data',(data:Buffer)=>emit('network:event',{type:'terminal',id,text:stderr.write(data)}));channel.on('close',()=>{const text=stdout.end()+stderr.end();if(text)emit('network:event',{type:'terminal',id,text});terminals.delete(id);conn.end();emit('network:event',{type:'terminalClosed',id});});return{id};}catch(e){conn.end();throw e;}
 });
 ipcMain.handle('network:terminalWrite',(_e,id:string,text:string)=>{if(typeof text!=='string'||text.length>65536)throw Error('輸入過長');terminals.get(id)?.channel.write(text);});
 ipcMain.handle('network:terminalClose',(_e,id:string)=>{const t=terminals.get(id);terminals.delete(id);t?.conn.end();});
 app.whenReady().then(()=>{powerMonitor.on('resume',()=>emit('network:event',{type:'resume'}));});
 app.on('before-quit',()=>{for(const c of transfers.values())c.abort();for(const t of terminals.values())t.conn.end();});
}
